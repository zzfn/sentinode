use anyhow::Result;
use axum::{routing::get, Router};
use clap::Parser;
use common::{
    monitor_server::{Monitor, MonitorServer},
    ReportRequest, ReportResponse,
};
use sqlx::PgPool;
use tonic::{async_trait, Request, Response, Status};
use tracing::info;

#[derive(Parser)]
#[command(name = "sentinode-server")]
struct Cli {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,

    #[arg(long, env = "SENTINODE_TOKEN")]
    token: String,

    #[arg(long, env = "GRPC_PORT", default_value_t = 50051)]
    grpc_port: u16,

    #[arg(long, env = "HTTP_PORT", default_value_t = 8080)]
    http_port: u16,

    /// 指标保留天数，超出后自动删除
    #[arg(long, env = "METRICS_RETENTION_DAYS", default_value_t = 30)]
    retention_days: i64,
}

#[derive(Clone)]
struct MonitorService {
    db: PgPool,
}

#[async_trait]
impl Monitor for MonitorService {
    async fn report(
        &self,
        request: Request<ReportRequest>,
    ) -> Result<Response<ReportResponse>, Status> {
        let req = request.into_inner();
        let node = req
            .node
            .ok_or_else(|| Status::invalid_argument("missing node"))?;
        let m = req
            .metrics
            .ok_or_else(|| Status::invalid_argument("missing metrics"))?;

        sqlx::query(
            "INSERT INTO nodes (hostname, ip, os, arch, last_seen)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (hostname) DO UPDATE
             SET ip = EXCLUDED.ip, os = EXCLUDED.os, arch = EXCLUDED.arch, last_seen = NOW()",
        )
        .bind(&node.hostname)
        .bind(&node.ip)
        .bind(&node.os)
        .bind(&node.arch)
        .execute(&self.db)
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        sqlx::query(
            "INSERT INTO metrics
             (node_hostname, cpu_percent, mem_total, mem_used, swap_total, swap_used,
              load1, load5, load15, uptime_secs, reported_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11))",
        )
        .bind(&node.hostname)
        .bind(m.cpu_percent)
        .bind(m.mem_total as i64)
        .bind(m.mem_used as i64)
        .bind(m.swap_total as i64)
        .bind(m.swap_used as i64)
        .bind(m.load1)
        .bind(m.load5)
        .bind(m.load15)
        .bind(node.uptime_secs as i64)
        .bind(req.timestamp)
        .execute(&self.db)
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        info!("recorded metrics for {}", node.hostname);
        Ok(Response::new(ReportResponse { ok: true }))
    }
}

async fn init_schema(pool: &PgPool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS nodes (
            hostname  TEXT PRIMARY KEY,
            ip        TEXT NOT NULL,
            os        TEXT NOT NULL,
            arch      TEXT NOT NULL,
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS metrics (
            id            BIGSERIAL PRIMARY KEY,
            node_hostname TEXT    NOT NULL REFERENCES nodes(hostname),
            cpu_percent   REAL    NOT NULL,
            mem_total     BIGINT  NOT NULL,
            mem_used      BIGINT  NOT NULL,
            swap_total    BIGINT  NOT NULL,
            swap_used     BIGINT  NOT NULL,
            load1         REAL    NOT NULL,
            load5         REAL    NOT NULL,
            load15        REAL    NOT NULL,
            uptime_secs   BIGINT  NOT NULL,
            reported_at   TIMESTAMPTZ NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(node_hostname, reported_at DESC)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();

    let pool = PgPool::connect(&cli.database_url).await?;
    init_schema(&pool).await?;
    info!("database schema ready");

    let grpc_addr = format!("0.0.0.0:{}", cli.grpc_port).parse()?;
    let expected = format!("Bearer {}", cli.token);

    // 每小时清理一次超出保留期的数据
    let retention_pool = pool.clone();
    let retention_days = cli.retention_days;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            match sqlx::query(
                "DELETE FROM metrics WHERE reported_at < NOW() - ($1 || ' days')::INTERVAL",
            )
            .bind(retention_days)
            .execute(&retention_pool)
            .await
            {
                Ok(r) => {
                    if r.rows_affected() > 0 {
                        info!("retention: deleted {} rows", r.rows_affected());
                    }
                }
                Err(e) => tracing::warn!("retention cleanup failed: {e}"),
            }
        }
    });

    let svc = MonitorService { db: pool };
    let monitor = MonitorServer::with_interceptor(svc, move |req: Request<()>| {
        match req.metadata().get("authorization") {
            Some(v) if v.to_str().map(|s| s == expected).unwrap_or(false) => Ok(req),
            _ => Err(Status::unauthenticated("invalid token")),
        }
    });

    let http_port = cli.http_port;
    tokio::spawn(async move {
        let app = Router::new().route("/healthz", get(|| async { "ok" }));
        let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", http_port))
            .await
            .expect("bind http");
        info!("http on :{}", http_port);
        axum::serve(listener, app).await.expect("http serve");
    });

    info!("grpc on {}", grpc_addr);
    tonic::transport::Server::builder()
        .add_service(monitor)
        .serve(grpc_addr)
        .await?;

    Ok(())
}
