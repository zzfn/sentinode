use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use clap::Parser;
use common::{
    monitor_server::{Monitor, MonitorServer},
    ReportRequest, ReportResponse,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Row};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tonic::service::Routes as GrpcRoutes;
use tonic::{async_trait, Request, Response, Status};
use tower_http::cors::CorsLayer;
use tracing::info;
use uuid::Uuid;

// ── Snowflake ID 生成器 ──────────────────────────────────────────────────────
const EPOCH: u64 = 1_700_000_000_000;
const MACHINE_BITS: u64 = 10;
const SEQ_BITS: u64 = 12;
const MAX_SEQ: u64 = (1 << SEQ_BITS) - 1;

struct SnowflakeGen {
    machine_id: u64,
    sequence: u64,
    last_ms: u64,
}

impl SnowflakeGen {
    fn new(machine_id: u64) -> Self {
        Self {
            machine_id: machine_id & ((1 << MACHINE_BITS) - 1),
            sequence: 0,
            last_ms: 0,
        }
    }

    fn next(&mut self) -> i64 {
        let mut ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            - EPOCH;

        if ms == self.last_ms {
            self.sequence = (self.sequence + 1) & MAX_SEQ;
            if self.sequence == 0 {
                while ms <= self.last_ms {
                    ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64
                        - EPOCH;
                }
            }
        } else {
            self.sequence = 0;
        }

        self.last_ms = ms;
        ((ms << (MACHINE_BITS + SEQ_BITS)) | (self.machine_id << SEQ_BITS) | self.sequence) as i64
    }
}
// ────────────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "sentinode-server")]
struct Cli {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,

    #[arg(long, env = "SENTINODE_TOKEN")]
    token: String,

    #[arg(long, env = "PORT", default_value_t = 8080)]
    port: u16,

    #[arg(long, env = "METRICS_RETENTION_DAYS", default_value_t = 30)]
    retention_days: i64,
}

// ── gRPC 服务 ────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct MonitorService {
    db: PgPool,
    id_gen: Arc<Mutex<SnowflakeGen>>,
}

impl MonitorService {
    fn next_id(&self) -> i64 {
        self.id_gen.lock().unwrap().next()
    }
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

        let node_id: i64 = sqlx::query(
            "INSERT INTO nodes (id, hostname, ip, os, arch, last_seen)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (hostname) DO UPDATE
             SET ip = EXCLUDED.ip, os = EXCLUDED.os, arch = EXCLUDED.arch, last_seen = NOW()
             RETURNING id",
        )
        .bind(self.next_id())
        .bind(&node.hostname)
        .bind(&node.ip)
        .bind(&node.os)
        .bind(&node.arch)
        .fetch_one(&self.db)
        .await
        .map_err(|e| Status::internal(e.to_string()))?
        .get("id");

        sqlx::query(
            "INSERT INTO metrics
             (id, node_id, cpu_percent, mem_total, mem_used, swap_total, swap_used,
              load1, load5, load15, uptime_secs, reported_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12))",
        )
        .bind(self.next_id())
        .bind(node_id)
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

        info!(
            "recorded metrics for {} (node_id={})",
            node.hostname, node_id
        );
        Ok(Response::new(ReportResponse { ok: true }))
    }
}

// ── REST API ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    db: PgPool,
    id_gen: Arc<Mutex<SnowflakeGen>>,
    token_set: Arc<std::sync::RwLock<HashSet<String>>>,
    admin_token: String,
}

#[derive(FromRow)]
struct NodeRow {
    id: i64,
    hostname: String,
    ip: String,
    os: String,
    arch: String,
    last_seen: DateTime<Utc>,
}

#[derive(Serialize)]
struct NodeResponse {
    id: String, // i64 → string，避免 JS 精度丢失
    hostname: String,
    ip: String,
    os: String,
    arch: String,
    last_seen: DateTime<Utc>,
}

impl From<NodeRow> for NodeResponse {
    fn from(r: NodeRow) -> Self {
        Self {
            id: r.id.to_string(),
            hostname: r.hostname,
            ip: r.ip,
            os: r.os,
            arch: r.arch,
            last_seen: r.last_seen,
        }
    }
}

#[derive(FromRow)]
struct MetricRow {
    id: i64,
    cpu_percent: f32,
    mem_total: i64,
    mem_used: i64,
    swap_total: i64,
    swap_used: i64,
    load1: f32,
    load5: f32,
    load15: f32,
    uptime_secs: i64,
    reported_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct MetricResponse {
    id: String,
    cpu_percent: f32,
    mem_total: i64,
    mem_used: i64,
    swap_total: i64,
    swap_used: i64,
    load1: f32,
    load5: f32,
    load15: f32,
    uptime_secs: i64,
    reported_at: DateTime<Utc>,
}

impl From<MetricRow> for MetricResponse {
    fn from(r: MetricRow) -> Self {
        Self {
            id: r.id.to_string(),
            cpu_percent: r.cpu_percent,
            mem_total: r.mem_total,
            mem_used: r.mem_used,
            swap_total: r.swap_total,
            swap_used: r.swap_used,
            load1: r.load1,
            load5: r.load5,
            load15: r.load15,
            uptime_secs: r.uptime_secs,
            reported_at: r.reported_at,
        }
    }
}

#[derive(Deserialize)]
struct MetricsQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}

fn default_limit() -> i64 {
    60
}

// ── Token 相关类型 ────────────────────────────────────────────────────────────

#[derive(FromRow)]
struct TokenRow {
    id: i64,
    name: String,
    token: String,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct TokenResponse {
    id: String,
    name: String,
    token: String,
    created_at: DateTime<Utc>,
}

impl From<TokenRow> for TokenResponse {
    fn from(r: TokenRow) -> Self {
        Self {
            id: r.id.to_string(),
            name: r.name,
            token: r.token,
            created_at: r.created_at,
        }
    }
}

#[derive(Deserialize)]
struct CreateTokenReq {
    name: String,
}

// ── REST 处理函数 ─────────────────────────────────────────────────────────────

const SESSION_COOKIE: &str = "sn_session";

fn check_session(headers: &HeaderMap, admin_token: &str) -> Result<(), StatusCode> {
    let cookies = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let valid = cookies.split(';').any(|c| {
        let c = c.trim();
        c == format!("{SESSION_COOKIE}={admin_token}")
    });
    if valid {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[derive(serde::Deserialize)]
struct LoginReq {
    password: String,
}

async fn admin_login(
    State(s): State<AppState>,
    Json(req): Json<LoginReq>,
) -> Result<axum::response::Response, StatusCode> {
    if req.password != s.admin_token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let cookie = format!(
        "{SESSION_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
        s.admin_token
    );
    Ok(axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(
            axum::http::header::SET_COOKIE,
            HeaderValue::from_str(&cookie).unwrap(),
        )
        .body(axum::body::Body::from("{}"))
        .unwrap())
}

async fn admin_logout() -> axum::response::Response {
    let clear = format!("{SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0");
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(
            axum::http::header::SET_COOKIE,
            HeaderValue::from_str(&clear).unwrap(),
        )
        .body(axum::body::Body::from("{}"))
        .unwrap()
}

async fn healthz() -> &'static str {
    "ok"
}

async fn list_nodes(State(s): State<AppState>) -> Result<Json<Vec<NodeResponse>>, StatusCode> {
    let rows = sqlx::query_as::<_, NodeRow>(
        "SELECT id, hostname, ip, os, arch, last_seen FROM nodes ORDER BY last_seen DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

async fn node_metrics(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> Result<Json<Vec<MetricResponse>>, StatusCode> {
    let node_id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let rows = sqlx::query_as::<_, MetricRow>(
        "SELECT id, cpu_percent, mem_total, mem_used, swap_total, swap_used,
                load1, load5, load15, uptime_secs, reported_at
         FROM metrics
         WHERE node_id = $1
         ORDER BY reported_at DESC
         LIMIT $2",
    )
    .bind(node_id)
    .bind(q.limit)
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// 列出所有已注册的 token（需要 session）
async fn list_tokens(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TokenResponse>>, StatusCode> {
    check_session(&headers, &s.admin_token)?;
    let rows = sqlx::query_as::<_, TokenRow>(
        "SELECT id, name, token, created_at FROM tokens ORDER BY created_at DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// 创建新 token，使用 UUID v4 生成随机串
async fn create_token(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateTokenReq>,
) -> Result<Json<TokenResponse>, StatusCode> {
    check_session(&headers, &s.admin_token)?;
    let id = s.id_gen.lock().unwrap().next();
    let token = Uuid::new_v4().to_string().replace('-', "");
    sqlx::query("INSERT INTO tokens (id, name, token) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&req.name)
        .bind(&token)
        .execute(&s.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 同步更新内存中的 token set
    s.token_set.write().unwrap().insert(token.clone());

    let row = sqlx::query_as::<_, TokenRow>(
        "SELECT id, name, token, created_at FROM tokens WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(row.into()))
}

/// 删除指定 id 的 token，同时从内存 set 中移除
async fn delete_token(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    check_session(&headers, &s.admin_token)?;
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    // 先取出 token 值以便从内存 set 中删除
    let row: Option<(String,)> = sqlx::query_as("SELECT token FROM tokens WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Some((token,)) = row {
        sqlx::query("DELETE FROM tokens WHERE id = $1")
            .bind(id)
            .execute(&s.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        s.token_set.write().unwrap().remove(&token);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ── Schema ───────────────────────────────────────────────────────────────────

async fn init_schema(pool: &PgPool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS nodes (
            id        BIGINT PRIMARY KEY,
            hostname  TEXT   NOT NULL UNIQUE,
            ip        TEXT   NOT NULL,
            os        TEXT   NOT NULL,
            arch      TEXT   NOT NULL,
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS metrics (
            id          BIGINT PRIMARY KEY,
            node_id     BIGINT NOT NULL REFERENCES nodes(id),
            cpu_percent REAL   NOT NULL,
            mem_total   BIGINT NOT NULL,
            mem_used    BIGINT NOT NULL,
            swap_total  BIGINT NOT NULL,
            swap_used   BIGINT NOT NULL,
            load1       REAL   NOT NULL,
            load5       REAL   NOT NULL,
            load15      REAL   NOT NULL,
            uptime_secs BIGINT NOT NULL,
            reported_at TIMESTAMPTZ NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(node_id, reported_at DESC)",
    )
    .execute(pool)
    .await?;

    // 创建 tokens 表，用于存储 agent 注册 token
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tokens (
            id         BIGINT PRIMARY KEY,
            name       TEXT   NOT NULL,
            token      TEXT   NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// 从数据库加载所有 token 到内存 HashSet，启动时调用
async fn load_token_set(pool: &PgPool) -> Result<HashSet<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT token FROM tokens")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(t,)| t).collect())
}

// ── main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();

    let pool = PgPool::connect(&cli.database_url).await?;
    init_schema(&pool).await?;
    info!("database schema ready");

    // 保留任务
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
                Ok(r) if r.rows_affected() > 0 => {
                    info!("retention: deleted {} rows", r.rows_affected());
                }
                Err(e) => tracing::warn!("retention cleanup failed: {e}"),
                _ => {}
            }
        }
    });

    let id_gen = Arc::new(Mutex::new(SnowflakeGen::new(1)));
    let token_set = {
        let set = load_token_set(&pool).await?;
        Arc::new(std::sync::RwLock::new(set))
    };

    // gRPC 拦截器：同时接受 global_token 和 DB token
    let global_token = cli.token.clone();
    let token_set_for_grpc = token_set.clone();
    let svc = MonitorService {
        db: pool.clone(),
        id_gen: id_gen.clone(),
    };
    let monitor = MonitorServer::with_interceptor(svc, move |req: Request<()>| {
        match req.metadata().get("authorization") {
            Some(v) => {
                let bearer = v.to_str().unwrap_or("");
                let tok = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
                let valid = tok == global_token || token_set_for_grpc.read().unwrap().contains(tok);
                if valid {
                    Ok(req)
                } else {
                    Err(Status::unauthenticated("invalid token"))
                }
            }
            None => Err(Status::unauthenticated("missing token")),
        }
    });

    // gRPC 路由作为 axum fallback，REST 路由优先匹配
    let grpc_router = GrpcRoutes::new(monitor).into_axum_router();

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/nodes", get(list_nodes))
        .route("/api/nodes/{id}/metrics", get(node_metrics))
        .route("/api/tokens", get(list_tokens).post(create_token))
        .route("/api/tokens/{id}", axum::routing::delete(delete_token))
        .route("/api/admin/login", post(admin_login))
        .route("/api/admin/logout", post(admin_logout))
        .with_state(AppState {
            db: pool,
            id_gen,
            token_set,
            admin_token: cli.token.clone(),
        })
        .layer(CorsLayer::permissive())
        .fallback_service(grpc_router);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", cli.port)).await?;
    info!("listening on :{} (gRPC + HTTP)", cli.port);
    axum::serve(listener, app).await?;

    Ok(())
}
