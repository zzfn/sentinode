use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use clap::Parser;
use common::{
    monitor_server::{Monitor, MonitorServer},
    ReportRequest, ReportResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool, Row};
use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
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
    event_tx: broadcast::Sender<String>,
    upgrade_set: Arc<Mutex<HashSet<i64>>>,
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
        // 取 token 值用于关联节点
        let token_val: Option<String> = request
            .metadata()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|s| s.to_owned());

        let req = request.into_inner();
        let node = req
            .node
            .ok_or_else(|| Status::invalid_argument("missing node"))?;
        let m = req
            .metrics
            .ok_or_else(|| Status::invalid_argument("missing metrics"))?;

        // 查 token_id（global token 直接连的不会有 token_id）
        let token_id: Option<i64> = if let Some(ref tok) = token_val {
            sqlx::query_scalar("SELECT id FROM tokens WHERE token = $1")
                .bind(tok)
                .fetch_optional(&self.db)
                .await
                .unwrap_or(None)
        } else {
            None
        };

        let node_id: i64 = sqlx::query(
            "INSERT INTO nodes (id, hostname, ip, os, arch, last_seen, token_id)
             VALUES ($1, $2, $3, $4, $5, NOW(), $6)
             ON CONFLICT (hostname) DO UPDATE
             SET ip = EXCLUDED.ip, os = EXCLUDED.os, arch = EXCLUDED.arch,
                 last_seen = NOW(),
                 token_id = COALESCE(EXCLUDED.token_id, nodes.token_id)
             RETURNING id",
        )
        .bind(self.next_id())
        .bind(&node.hostname)
        .bind(&node.ip)
        .bind(&node.os)
        .bind(&node.arch)
        .bind(token_id)
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

        // 若 agent 上报了延迟数据，更新节点延迟字段
        if !req.latencies.is_empty() {
            let mut cu = None::<f32>;
            let mut cm = None::<f32>;
            let mut ct = None::<f32>;
            for l in &req.latencies {
                let v = if l.latency_ms < 0.0 {
                    None
                } else {
                    Some(l.latency_ms)
                };
                match l.isp.as_str() {
                    "cu" => cu = v,
                    "cm" => cm = v,
                    "ct" => ct = v,
                    _ => {}
                }
            }
            sqlx::query(
                "UPDATE nodes SET latency_cu_ms = $1, latency_cm_ms = $2, latency_ct_ms = $3,
                 latency_updated_at = NOW() WHERE id = $4",
            )
            .bind(cu)
            .bind(cm)
            .bind(ct)
            .bind(node_id)
            .execute(&self.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        }

        // 查询完整节点信息（用于广播和返回开关状态）
        let row = sqlx::query_as::<_, NodeRow>(
            "SELECT id, hostname, ip, os, arch, last_seen, expires_at, price, price_currency, website_url, latency_test_enabled, latency_cu_ms, latency_cm_ms, latency_ct_ms, latency_updated_at, NULL::BIGINT AS token_id, NULL::TEXT AS token_name, NULL::TEXT AS token_value FROM nodes WHERE id = $1",
        )
        .bind(node_id)
        .fetch_one(&self.db)
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        let enabled = row.latency_test_enabled.unwrap_or(false);

        // 广播 node_updated 事件给所有 SSE 客户端
        let node_resp: NodeResponse = row.into();
        if let Ok(payload) = serde_json::to_string(&json!({
            "type": "node_updated",
            "data": node_resp,
        })) {
            let _ = self.event_tx.send(payload);
        }

        // 广播 metric_added 事件，供节点详情页实时追加趋势数据
        if let Ok(payload) = serde_json::to_string(&json!({
            "type": "metric_added",
            "node_id": node_id.to_string(),
            "data": {
                "cpu_percent": m.cpu_percent,
                "mem_total": m.mem_total as i64,
                "mem_used": m.mem_used as i64,
                "swap_total": m.swap_total as i64,
                "swap_used": m.swap_used as i64,
                "load1": m.load1,
                "load5": m.load5,
                "load15": m.load15,
                "uptime_secs": node.uptime_secs as i64,
            },
        })) {
            let _ = self.event_tx.send(payload);
        }

        info!(
            "recorded metrics for {} (node_id={}) latency_test_enabled={}",
            node.hostname, node_id, enabled
        );
        let should_upgrade = self.upgrade_set.lock().unwrap().remove(&node_id);

        Ok(Response::new(ReportResponse {
            ok: true,
            latency_test_enabled: enabled,
            should_upgrade,
        }))
    }
}

// ── REST API ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    db: PgPool,
    id_gen: Arc<Mutex<SnowflakeGen>>,
    token_set: Arc<std::sync::RwLock<HashSet<String>>>,
    event_tx: broadcast::Sender<String>,
    upgrade_set: Arc<Mutex<HashSet<i64>>>,
}

#[derive(FromRow)]
struct NodeRow {
    id: i64,
    hostname: String,
    ip: String,
    os: String,
    arch: String,
    last_seen: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    price: Option<f32>,
    price_currency: Option<String>,
    website_url: Option<String>,
    latency_test_enabled: Option<bool>,
    latency_cu_ms: Option<f32>,
    latency_cm_ms: Option<f32>,
    latency_ct_ms: Option<f32>,
    latency_updated_at: Option<DateTime<Utc>>,
    token_id: Option<i64>,
    token_name: Option<String>,
    token_value: Option<String>,
}

#[derive(Serialize)]
struct NodeResponse {
    id: String,
    hostname: String,
    os: String,
    arch: String,
    last_seen: DateTime<Utc>,
    website_url: Option<String>,
    latency_cu_ms: Option<f32>,
    latency_cm_ms: Option<f32>,
    latency_ct_ms: Option<f32>,
    latency_updated_at: Option<DateTime<Utc>>,
}

impl From<NodeRow> for NodeResponse {
    fn from(r: NodeRow) -> Self {
        Self {
            id: r.id.to_string(),
            hostname: r.hostname,
            os: r.os,
            arch: r.arch,
            last_seen: r.last_seen,
            website_url: r.website_url,
            latency_cu_ms: r.latency_cu_ms,
            latency_cm_ms: r.latency_cm_ms,
            latency_ct_ms: r.latency_ct_ms,
            latency_updated_at: r.latency_updated_at,
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

async fn get_node(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<NodeResponse>, StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let row = sqlx::query_as::<_, NodeRow>(
        "SELECT id, hostname, ip, os, arch, last_seen, expires_at, price, price_currency, website_url, latency_test_enabled, latency_cu_ms, latency_cm_ms, latency_ct_ms, latency_updated_at, NULL::BIGINT AS token_id, NULL::TEXT AS token_name, NULL::TEXT AS token_value FROM nodes WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(row.into()))
}

async fn sse_events(
    State(s): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = s.event_tx.subscribe();

    // 建立连接时先推送当前所有节点快照
    let snapshot: Vec<String> = sqlx::query_as::<_, NodeRow>(
        "SELECT n.id, n.hostname, n.ip, n.os, n.arch, n.last_seen, n.expires_at,
                n.price, n.price_currency, n.website_url, n.latency_test_enabled,
                n.latency_cu_ms, n.latency_cm_ms, n.latency_ct_ms, n.latency_updated_at,
                n.token_id, NULL::TEXT AS token_name, NULL::TEXT AS token_value
         FROM nodes n ORDER BY n.last_seen DESC",
    )
    .fetch_all(&s.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .filter_map(|row| {
        let resp: NodeResponse = row.into();
        serde_json::to_string(&json!({ "type": "node_updated", "data": resp })).ok()
    })
    .collect();

    let snapshot_stream = tokio_stream::iter(
        snapshot
            .into_iter()
            .map(|data| Ok(Event::default().data(data))),
    );
    let live_stream = BroadcastStream::new(rx)
        .filter_map(|msg| msg.ok().map(|data| Ok(Event::default().data(data))));

    Sse::new(snapshot_stream.chain(live_stream)).keep_alive(KeepAlive::default())
}

async fn healthz() -> &'static str {
    "ok"
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

async fn list_tokens(State(s): State<AppState>) -> Result<Json<Vec<TokenResponse>>, StatusCode> {
    let rows = sqlx::query_as::<_, TokenRow>(
        "SELECT id, name, token, created_at FROM tokens ORDER BY created_at DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

async fn create_token(
    State(s): State<AppState>,
    Json(req): Json<CreateTokenReq>,
) -> Result<Json<TokenResponse>, StatusCode> {
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

async fn delete_token(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
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

/// 管理员专用：返回含 IP、价格、到期时间、延迟开关的完整节点列表
#[derive(Serialize)]
struct AdminNodeResponse {
    id: String,
    hostname: String,
    ip: String,
    os: String,
    arch: String,
    last_seen: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    price: Option<f32>,
    price_currency: Option<String>,
    website_url: Option<String>,
    latency_test_enabled: bool,
    latency_cu_ms: Option<f32>,
    latency_cm_ms: Option<f32>,
    latency_ct_ms: Option<f32>,
    latency_updated_at: Option<DateTime<Utc>>,
    token_id: Option<String>,
    token_name: Option<String>,
    token: Option<String>,
}

impl From<NodeRow> for AdminNodeResponse {
    fn from(r: NodeRow) -> Self {
        Self {
            id: r.id.to_string(),
            hostname: r.hostname,
            ip: r.ip,
            os: r.os,
            arch: r.arch,
            last_seen: r.last_seen,
            expires_at: r.expires_at,
            price: r.price,
            price_currency: r.price_currency,
            website_url: r.website_url,
            latency_test_enabled: r.latency_test_enabled.unwrap_or(false),
            latency_cu_ms: r.latency_cu_ms,
            latency_cm_ms: r.latency_cm_ms,
            latency_ct_ms: r.latency_ct_ms,
            latency_updated_at: r.latency_updated_at,
            token_id: r.token_id.map(|id| id.to_string()),
            token_name: r.token_name,
            token: r.token_value,
        }
    }
}

async fn admin_list_nodes(
    State(s): State<AppState>,
) -> Result<Json<Vec<AdminNodeResponse>>, StatusCode> {
    let rows = sqlx::query_as::<_, NodeRow>(
        "SELECT n.id, n.hostname, n.ip, n.os, n.arch, n.last_seen, n.expires_at,
                n.price, n.price_currency, n.website_url, n.latency_test_enabled,
                n.latency_cu_ms, n.latency_cm_ms, n.latency_ct_ms, n.latency_updated_at,
                n.token_id, t.name AS token_name, t.token AS token_value
         FROM nodes n
         LEFT JOIN tokens t ON t.id = n.token_id
         ORDER BY n.last_seen DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

async fn delete_node(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    sqlx::query("DELETE FROM metrics WHERE node_id = $1")
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateNodeMetaReq {
    expires_at: Option<DateTime<Utc>>,
    price: Option<f32>,
    price_currency: Option<String>,
    website_url: Option<String>,
    latency_test_enabled: Option<bool>,
}

async fn update_node_meta(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateNodeMetaReq>,
) -> Result<StatusCode, StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    sqlx::query(
        "UPDATE nodes SET expires_at = $1, price = $2, price_currency = $3, website_url = $4, latency_test_enabled = COALESCE($5, latency_test_enabled) WHERE id = $6",
    )
    .bind(req.expires_at)
    .bind(req.price)
    .bind(req.price_currency)
    .bind(req.website_url)
    .bind(req.latency_test_enabled)
    .bind(id)
    .execute(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── 管理统计 ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct AdminStats {
    db_size_bytes: i64,
    db_size_pretty: String,
    nodes_count: i64,
    metrics_count: i64,
    tokens_count: i64,
    daily_metrics: Vec<DailyCount>,
}

#[derive(Serialize)]
struct DailyCount {
    day: String,
    count: i64,
}

async fn admin_stats(State(s): State<AppState>) -> Result<Json<AdminStats>, StatusCode> {
    let db_size_bytes: i64 = sqlx::query_scalar("SELECT pg_database_size(current_database())")
        .fetch_one(&s.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let db_size_pretty: String =
        sqlx::query_scalar("SELECT pg_size_pretty(pg_database_size(current_database()))")
            .fetch_one(&s.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 近似行数，避免全表 COUNT 阻塞
    let nodes_count: i64 = sqlx::query_scalar(
        "SELECT GREATEST(reltuples::bigint, 0) FROM pg_class WHERE relname = 'nodes'",
    )
    .fetch_one(&s.db)
    .await
    .unwrap_or(0);

    let metrics_count: i64 = sqlx::query_scalar(
        "SELECT GREATEST(reltuples::bigint, 0) FROM pg_class WHERE relname = 'metrics'",
    )
    .fetch_one(&s.db)
    .await
    .unwrap_or(0);

    let tokens_count: i64 = sqlx::query_scalar("SELECT count(*) FROM tokens")
        .fetch_one(&s.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    #[derive(sqlx::FromRow)]
    struct DailyRow {
        day: chrono::NaiveDate,
        count: i64,
    }

    let rows = sqlx::query_as::<_, DailyRow>(
        "SELECT (reported_at AT TIME ZONE 'UTC')::date AS day, count(*)::bigint AS count
         FROM metrics
         WHERE reported_at >= NOW() - INTERVAL '14 days'
         GROUP BY 1 ORDER BY 1",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let daily_metrics = rows
        .into_iter()
        .map(|r| DailyCount {
            day: r.day.format("%m-%d").to_string(),
            count: r.count,
        })
        .collect();

    Ok(Json(AdminStats {
        db_size_bytes,
        db_size_pretty,
        nodes_count,
        metrics_count,
        tokens_count,
        daily_metrics,
    }))
}

async fn trigger_upgrade(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    s.upgrade_set.lock().unwrap().insert(id);
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

    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS price REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS price_currency TEXT DEFAULT 'CNY'")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS website_url TEXT")
        .execute(pool)
        .await?;
    sqlx::query(
        "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS latency_test_enabled BOOLEAN DEFAULT FALSE",
    )
    .execute(pool)
    .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS latency_cu_ms REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS latency_cm_ms REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS latency_ct_ms REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS latency_updated_at TIMESTAMPTZ")
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

    // tokens 表创建后才能添加外键引用
    sqlx::query(
        "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS token_id BIGINT REFERENCES tokens(id) ON DELETE SET NULL",
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
            // 分批删除：每批至多 1 万行，避免一次性删除导致长时间锁表、阻塞上报写入
            let mut total: u64 = 0;
            loop {
                let res = sqlx::query(
                    "DELETE FROM metrics WHERE id IN (
                         SELECT id FROM metrics
                         WHERE reported_at < NOW() - ($1 || ' days')::INTERVAL
                         LIMIT 10000
                     )",
                )
                .bind(retention_days)
                .execute(&retention_pool)
                .await;
                match res {
                    Ok(r) => {
                        let n = r.rows_affected();
                        total += n;
                        if n < 10000 {
                            break; // 已无更多过期数据
                        }
                        // 批间短暂让出，避免持续占用写锁
                        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                    }
                    Err(e) => {
                        tracing::warn!("retention cleanup failed: {e}");
                        break;
                    }
                }
            }
            if total > 0 {
                info!("retention: deleted {} rows", total);
            }
        }
    });

    let id_gen = Arc::new(Mutex::new(SnowflakeGen::new(1)));
    let token_set = {
        let set = load_token_set(&pool).await?;
        Arc::new(std::sync::RwLock::new(set))
    };
    let (event_tx, _) = broadcast::channel::<String>(64);
    let upgrade_set: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));

    // gRPC 拦截器：同时接受 global_token 和 DB token
    let global_token = cli.token.clone();
    let token_set_for_grpc = token_set.clone();
    let svc = MonitorService {
        db: pool.clone(),
        id_gen: id_gen.clone(),
        event_tx: event_tx.clone(),
        upgrade_set: upgrade_set.clone(),
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
        .route("/api/events", get(sse_events))
        .route("/api/nodes/{id}", get(get_node))
        .route("/api/nodes/{id}/metrics", get(node_metrics))
        .route("/api/admin/tokens", get(list_tokens).post(create_token))
        .route(
            "/api/admin/tokens/{id}",
            axum::routing::delete(delete_token),
        )
        .route("/api/admin/nodes", get(admin_list_nodes))
        .route(
            "/api/admin/nodes/{id}",
            put(update_node_meta).delete(delete_node),
        )
        .route(
            "/api/admin/nodes/{id}/upgrade",
            axum::routing::post(trigger_upgrade),
        )
        .route("/api/admin/stats", get(admin_stats))
        .with_state(AppState {
            db: pool,
            id_gen,
            token_set,
            event_tx,
            upgrade_set,
        })
        .layer(CorsLayer::permissive())
        .fallback_service(grpc_router);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", cli.port)).await?;
    info!("listening on :{} (gRPC + HTTP)", cli.port);
    axum::serve(listener, app).await?;

    Ok(())
}
