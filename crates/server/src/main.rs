use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post, put},
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
use std::time::Duration;
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
    http_client: reqwest::Client,
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

        // 先尝试认领 pending token 槽位（admin 创建 token 时预插的 hostname IS NULL 行）
        let claimed_id: Option<i64> = if let Some(ref tok) = token_val {
            sqlx::query_scalar(
                "UPDATE nodes SET hostname=$1, ip=$2, os=$3, arch=$4, last_seen=NOW(),
                 cpu_model=COALESCE(NULLIF($5,''), cpu_model),
                 agent_version=NULLIF($7,'')
                 WHERE token=$6 AND hostname IS NULL
                 RETURNING id",
            )
            .bind(&node.hostname)
            .bind(&node.ip)
            .bind(&node.os)
            .bind(&node.arch)
            .bind(if node.cpu_model.is_empty() {
                None::<&str>
            } else {
                Some(node.cpu_model.as_str())
            })
            .bind(tok)
            .bind(&node.agent_version)
            .fetch_optional(&self.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?
        } else {
            None
        };

        let node_id: i64 = if let Some(id) = claimed_id {
            id
        } else {
            // 已连接节点续报 / 全局 token 节点：按 hostname UPSERT
            sqlx::query(
                "INSERT INTO nodes (id, hostname, ip, os, arch, last_seen, token, cpu_model, agent_version)
                 VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
                 ON CONFLICT (hostname) DO UPDATE
                 SET ip = EXCLUDED.ip, os = EXCLUDED.os, arch = EXCLUDED.arch,
                     last_seen = NOW(),
                     token = COALESCE(nodes.token, EXCLUDED.token),
                     cpu_model = COALESCE(NULLIF(EXCLUDED.cpu_model, ''), nodes.cpu_model),
                     agent_version = NULLIF(EXCLUDED.agent_version, '')
                 RETURNING id",
            )
            .bind(self.next_id())
            .bind(&node.hostname)
            .bind(&node.ip)
            .bind(&node.os)
            .bind(&node.arch)
            .bind(token_val.as_deref())
            .bind(if node.cpu_model.is_empty() {
                None
            } else {
                Some(&node.cpu_model)
            })
            .bind(if node.agent_version.is_empty() {
                None
            } else {
                Some(&node.agent_version)
            })
            .fetch_one(&self.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .get("id")
        };

        // 提取延迟数据（同时写入 metrics 和 nodes）
        let (lat_cu, lat_cm, lat_ct) = if !req.latencies.is_empty() {
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
            (cu, cm, ct)
        } else {
            (None, None, None)
        };

        sqlx::query(
            "INSERT INTO metrics
             (id, node_id, cpu_percent, mem_total, mem_used, swap_total, swap_used,
              load1, load5, load15, uptime_secs, reported_at,
              latency_cu_ms, latency_cm_ms, latency_ct_ms,
              net_rx_rate, net_tx_rate, tcp_connections)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),$13,$14,$15,$16,$17,$18)",
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
        .bind(lat_cu)
        .bind(lat_cm)
        .bind(lat_ct)
        .bind(m.net_rx_rate as i64)
        .bind(m.net_tx_rate as i64)
        .bind(m.tcp_connections as i32)
        .execute(&self.db)
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        // 更新 nodes 表的实时带宽
        sqlx::query("UPDATE nodes SET net_rx_rate=$1, net_tx_rate=$2 WHERE id=$3")
            .bind(m.net_rx_rate as i64)
            .bind(m.net_tx_rate as i64)
            .bind(node_id)
            .execute(&self.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        // 若有延迟数据，同时更新 nodes 表当前值
        if lat_cu.is_some() || lat_cm.is_some() || lat_ct.is_some() {
            sqlx::query(
                "UPDATE nodes SET latency_cu_ms = $1, latency_cm_ms = $2, latency_ct_ms = $3,
                 latency_updated_at = NOW() WHERE id = $4",
            )
            .bind(lat_cu)
            .bind(lat_cm)
            .bind(lat_ct)
            .bind(node_id)
            .execute(&self.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        }

        // 查询完整节点信息（用于广播和返回开关状态）
        let row = sqlx::query_as::<_, NodeRow>(
            "SELECT id, hostname, ip, os, arch, last_seen, expires_at, price, price_currency, website_url, latency_test_enabled, latency_cu_ms, latency_cm_ms, latency_ct_ms, latency_updated_at, name, token AS token_value, cpu_model, net_rx_rate, net_tx_rate, country_code, location, agent_version FROM nodes WHERE id = $1",
        )
        .bind(node_id)
        .fetch_one(&self.db)
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        let enabled = row.latency_test_enabled.unwrap_or(false);

        // 若节点无地理信息且 IP 非私有，后台自动查询 GeoIP
        if row.country_code.is_none() {
            let ip = node.ip.clone();
            let db2 = self.db.clone();
            let nid = node_id;
            let http = self.http_client.clone();
            tokio::spawn(async move {
                if is_private_ip(&ip) {
                    return;
                }
                if let Ok(resp) = http
                    .get(format!(
                        "http://ip-api.com/json/{}?fields=status,countryCode,country,city&lang=zh-CN",
                        ip
                    ))
                    .send()
                    .await
                {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        if data["status"] == "success" {
                            let cc = data["countryCode"].as_str().unwrap_or("").to_string();
                            let city = data["city"].as_str().unwrap_or("").to_string();
                            let country = data["country"].as_str().unwrap_or("").to_string();
                            let loc = if city.is_empty() { country } else { format!("{} {}", country, city) };
                            let _ = sqlx::query(
                                "UPDATE nodes SET country_code=$1, location=$2 WHERE id=$3 AND country_code IS NULL",
                            )
                            .bind(&cc)
                            .bind(&loc)
                            .bind(nid)
                            .execute(&db2)
                            .await;
                        }
                    }
                }
            });
        }

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
                "latency_cu_ms": lat_cu,
                "latency_cm_ms": lat_cm,
                "latency_ct_ms": lat_ct,
                "net_rx_rate": m.net_rx_rate as i64,
                "net_tx_rate": m.net_tx_rate as i64,
                "tcp_connections": m.tcp_connections,
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
    http_client: reqwest::Client,
}

#[derive(FromRow)]
struct NodeRow {
    id: i64,
    hostname: Option<String>,
    ip: Option<String>,
    os: Option<String>,
    arch: Option<String>,
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
    name: Option<String>,
    token_value: Option<String>,
    cpu_model: Option<String>,
    net_rx_rate: Option<i64>,
    net_tx_rate: Option<i64>,
    country_code: Option<String>,
    location: Option<String>,
    agent_version: Option<String>,
}

#[derive(Serialize)]
struct NodeResponse {
    id: String,
    name: Option<String>,
    hostname: String,
    os: String,
    arch: String,
    cpu_model: Option<String>,
    last_seen: DateTime<Utc>,
    website_url: Option<String>,
    latency_cu_ms: Option<f32>,
    latency_cm_ms: Option<f32>,
    latency_ct_ms: Option<f32>,
    latency_updated_at: Option<DateTime<Utc>>,
    net_rx_rate: Option<i64>,
    net_tx_rate: Option<i64>,
    country_code: Option<String>,
    location: Option<String>,
}

impl From<NodeRow> for NodeResponse {
    fn from(r: NodeRow) -> Self {
        Self {
            id: r.id.to_string(),
            name: r.name.clone(),
            hostname: r.hostname.unwrap_or_default(),
            os: r.os.unwrap_or_default(),
            arch: r.arch.unwrap_or_default(),
            cpu_model: r.cpu_model.clone(),
            last_seen: r.last_seen,
            website_url: r.website_url,
            latency_cu_ms: r.latency_cu_ms,
            latency_cm_ms: r.latency_cm_ms,
            latency_ct_ms: r.latency_ct_ms,
            latency_updated_at: r.latency_updated_at,
            net_rx_rate: r.net_rx_rate,
            net_tx_rate: r.net_tx_rate,
            country_code: r.country_code.clone(),
            location: r.location.clone(),
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
    latency_cu_ms: Option<f32>,
    latency_cm_ms: Option<f32>,
    latency_ct_ms: Option<f32>,
    net_rx_rate: Option<i64>,
    net_tx_rate: Option<i64>,
    tcp_connections: Option<i32>,
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
    latency_cu_ms: Option<f32>,
    latency_cm_ms: Option<f32>,
    latency_ct_ms: Option<f32>,
    net_rx_rate: Option<i64>,
    net_tx_rate: Option<i64>,
    tcp_connections: Option<i32>,
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
            latency_cu_ms: r.latency_cu_ms,
            latency_cm_ms: r.latency_cm_ms,
            latency_ct_ms: r.latency_ct_ms,
            net_rx_rate: r.net_rx_rate,
            net_tx_rate: r.net_tx_rate,
            tcp_connections: r.tcp_connections,
        }
    }
}

#[derive(Deserialize)]
struct MetricsQuery {
    #[serde(default = "default_hours")]
    hours: i64,
}

fn default_hours() -> i64 {
    1
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

// ── 访客追踪相关类型 ──────────────────────────────────────────────────────────

#[derive(FromRow)]
struct VisitorRow {
    #[allow(dead_code)]
    id: i64,
    ip: String,
    country_code: Option<String>,
    location: Option<String>,
    asn: Option<String>,
    isp: Option<String>,
    page: String,
    first_seen: DateTime<Utc>,
    last_seen: DateTime<Utc>,
}

#[derive(Serialize)]
struct VisitorEntry {
    ip: String,
    country_code: Option<String>,
    location: Option<String>,
    asn: Option<String>,
    isp: Option<String>,
    page: String,
    first_seen: DateTime<Utc>,
    last_seen: DateTime<Utc>,
}

#[derive(Serialize)]
struct VisitorStatsResp {
    total: i64,
    today: i64,
    active_now: i64,
    recent: Vec<VisitorEntry>,
}

#[derive(Deserialize)]
struct BeaconReq {
    page: String,
}

#[derive(FromRow)]
struct VisitorUpsertRow {
    id: i64,
    country_code: Option<String>,
    location: Option<String>,
    asn: Option<String>,
    isp: Option<String>,
}

#[derive(Serialize)]
struct BeaconResp {
    ip: String,
    country_code: Option<String>,
    location: Option<String>,
    asn: Option<String>,
    isp: Option<String>,
    today_rank: i64,
    total_rank: i64,
}

fn extract_client_ip(headers: &HeaderMap) -> String {
    headers
        .get("cf-connecting-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or(s).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn is_private_ip(ip: &str) -> bool {
    if ip == "unknown" || ip == "::1" {
        return true;
    }
    if let Ok(addr) = ip.parse::<std::net::IpAddr>() {
        return match addr {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                o[0] == 127
                    || o[0] == 10
                    || (o[0] == 172 && (16..=31).contains(&o[1]))
                    || (o[0] == 192 && o[1] == 168)
            }
            std::net::IpAddr::V6(v6) => v6.is_loopback(),
        };
    }
    false
}

// ── REST 处理函数 ─────────────────────────────────────────────────────────────

async fn get_node(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<NodeResponse>, StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let row = sqlx::query_as::<_, NodeRow>(
        "SELECT id, hostname, ip, os, arch, last_seen, expires_at, price, price_currency, website_url, latency_test_enabled, latency_cu_ms, latency_cm_ms, latency_ct_ms, latency_updated_at, name, token AS token_value, cpu_model, net_rx_rate, net_tx_rate, country_code, location, agent_version FROM nodes WHERE id = $1",
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
                n.name, n.token AS token_value,
                n.cpu_model, n.net_rx_rate, n.net_tx_rate, n.country_code, n.location,
                n.agent_version
         FROM nodes n WHERE n.hostname IS NOT NULL ORDER BY n.last_seen DESC",
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

async fn record_beacon(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BeaconReq>,
) -> Result<Json<BeaconResp>, StatusCode> {
    let ip = extract_client_ip(&headers);
    let page = req.page.chars().take(200).collect::<String>();

    // UPSERT：同一 IP 只保留一条记录，每次访问更新 last_seen
    let new_id = s.id_gen.lock().unwrap().next();
    let row: Option<VisitorUpsertRow> = sqlx::query_as(
        "INSERT INTO visitors (id, ip, page, first_seen, last_seen)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (ip) DO UPDATE
           SET last_seen = NOW(), page = EXCLUDED.page
         RETURNING id, country_code, location, asn, isp",
    )
    .bind(new_id)
    .bind(&ip)
    .bind(&page)
    .fetch_optional(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let row = row.unwrap_or(VisitorUpsertRow {
        id: new_id,
        country_code: None,
        location: None,
        asn: None,
        isp: None,
    });

    // GeoIP（异步，首次无 country_code 时触发）
    if row.country_code.is_none() && !is_private_ip(&ip) {
        let pool = s.db.clone();
        let ip_clone = ip.clone();
        let vid = row.id;
        let http = s.http_client.clone();
        tokio::spawn(async move {
            if let Ok(resp) = http
                .get(format!(
                    "http://ip-api.com/json/{}?fields=status,countryCode,country,regionName,city,isp,org,as&lang=zh-CN",
                    ip_clone
                ))
                .send()
                .await
            {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if data["status"] == "success" {
                        let cc = data["countryCode"].as_str().unwrap_or("").to_string();
                        let region = data["regionName"].as_str().unwrap_or("").to_string();
                        let city = data["city"].as_str().unwrap_or("").to_string();
                        let country = data["country"].as_str().unwrap_or("").to_string();
                        let loc = match (country.is_empty(), region.is_empty(), city.is_empty()) {
                            (false, false, false) => format!("{} {} {}", country, region, city),
                            (false, false, true)  => format!("{} {}", country, region),
                            (false, true, false)  => format!("{} {}", country, city),
                            _                     => country,
                        };
                        let asn_val = data["as"].as_str().unwrap_or("").to_string();
                        let isp_val = data["isp"].as_str().unwrap_or("").to_string();
                        let _ = sqlx::query(
                            "UPDATE visitors SET country_code=$1, location=$2, asn=$3, isp=$4
                             WHERE id=$5 AND country_code IS NULL",
                        )
                        .bind(&cc)
                        .bind(&loc)
                        .bind(if asn_val.is_empty() { None } else { Some(asn_val) })
                        .bind(if isp_val.is_empty() { None } else { Some(isp_val) })
                        .bind(vid)
                        .execute(&pool)
                        .await;
                    }
                }
            }
        });
    }

    // 访客排名
    let total_rank: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM visitors")
        .fetch_one(&s.db)
        .await
        .unwrap_or(1);

    let today_rank: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM visitors WHERE last_seen::date = CURRENT_DATE")
            .fetch_one(&s.db)
            .await
            .unwrap_or(1);

    Ok(Json(BeaconResp {
        ip,
        country_code: row.country_code,
        location: row.location,
        asn: row.asn,
        isp: row.isp,
        today_rank,
        total_rank,
    }))
}

async fn admin_visitors(State(s): State<AppState>) -> Result<Json<VisitorStatsResp>, StatusCode> {
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM visitors")
        .fetch_one(&s.db)
        .await
        .unwrap_or(0);

    let today: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM visitors WHERE last_seen::date = CURRENT_DATE")
            .fetch_one(&s.db)
            .await
            .unwrap_or(0);

    let active_now: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM visitors WHERE last_seen > NOW() - INTERVAL '2 minutes'",
    )
    .fetch_one(&s.db)
    .await
    .unwrap_or(0);

    let rows = sqlx::query_as::<_, VisitorRow>(
        "SELECT id, ip, country_code, location, asn, isp, page, first_seen, last_seen
         FROM visitors ORDER BY last_seen DESC LIMIT 100",
    )
    .fetch_all(&s.db)
    .await
    .unwrap_or_default();

    let recent = rows
        .into_iter()
        .map(|r| VisitorEntry {
            ip: r.ip,
            country_code: r.country_code,
            location: r.location,
            asn: r.asn,
            isp: r.isp,
            page: r.page,
            first_seen: r.first_seen,
            last_seen: r.last_seen,
        })
        .collect();

    Ok(Json(VisitorStatsResp {
        total,
        today,
        active_now,
        recent,
    }))
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
    let hours = q.hours.clamp(1, 168);
    let cutoff = chrono::Utc::now() - chrono::Duration::hours(hours);
    // 最多返回 300 个点；超出时按均匀间隔采样
    let rows = sqlx::query_as::<_, MetricRow>(
        "SELECT id, cpu_percent, mem_total, mem_used, swap_total, swap_used,
                load1, load5, load15, uptime_secs, reported_at,
                latency_cu_ms, latency_cm_ms, latency_ct_ms,
                net_rx_rate, net_tx_rate, tcp_connections
         FROM (
           SELECT *, ROW_NUMBER() OVER (ORDER BY reported_at) AS rn,
                  COUNT(*) OVER () AS cnt
           FROM metrics
           WHERE node_id=$1 AND reported_at > $2
         ) t
         WHERE t.cnt <= 300 OR t.rn % (t.cnt / 300 + 1) = 0
         ORDER BY reported_at ASC",
    )
    .bind(node_id)
    .bind(cutoff)
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

async fn list_tokens(State(s): State<AppState>) -> Result<Json<Vec<TokenResponse>>, StatusCode> {
    let rows = sqlx::query_as::<_, TokenRow>(
        "SELECT id, name, token, token_created_at AS created_at
         FROM nodes WHERE token IS NOT NULL ORDER BY token_created_at DESC",
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
    sqlx::query(
        "INSERT INTO nodes (id, name, token, token_created_at, last_seen)
         VALUES ($1, $2, $3, NOW(), NOW())",
    )
    .bind(id)
    .bind(&req.name)
    .bind(&token)
    .execute(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    s.token_set.write().unwrap().insert(token.clone());

    let row = sqlx::query_as::<_, TokenRow>(
        "SELECT id, name, token, token_created_at AS created_at
         FROM nodes WHERE id = $1",
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
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT token, hostname FROM nodes WHERE id=$1 AND token IS NOT NULL")
            .bind(id)
            .fetch_optional(&s.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Some((token, hostname)) = row {
        if hostname.is_none() {
            // pending token，agent 尚未连接 → 删除整行
            sqlx::query("DELETE FROM nodes WHERE id=$1")
                .bind(id)
                .execute(&s.db)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        } else {
            // 已连接的节点 → 只清除 token 字段，保留节点数据
            sqlx::query(
                "UPDATE nodes SET token=NULL, name=NULL, token_created_at=NULL WHERE id=$1",
            )
            .bind(id)
            .execute(&s.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        s.token_set.write().unwrap().remove(&token);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 管理员专用：返回含 IP、价格、到期时间、延迟开关的完整节点列表
#[derive(Serialize)]
struct AdminNodeResponse {
    id: String,
    connected: bool,
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
    name: Option<String>,
    token: Option<String>,
    cpu_model: Option<String>,
    net_rx_rate: Option<i64>,
    net_tx_rate: Option<i64>,
    country_code: Option<String>,
    location: Option<String>,
    agent_version: Option<String>,
}

impl From<NodeRow> for AdminNodeResponse {
    fn from(r: NodeRow) -> Self {
        Self {
            id: r.id.to_string(),
            connected: r.hostname.is_some(),
            hostname: r.hostname.unwrap_or_default(),
            ip: r.ip.unwrap_or_default(),
            os: r.os.unwrap_or_default(),
            arch: r.arch.unwrap_or_default(),
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
            name: r.name,
            token: r.token_value,
            cpu_model: r.cpu_model,
            net_rx_rate: r.net_rx_rate,
            net_tx_rate: r.net_tx_rate,
            country_code: r.country_code.clone(),
            location: r.location.clone(),
            agent_version: r.agent_version,
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
                n.name, n.token AS token_value,
                n.cpu_model, n.net_rx_rate, n.net_tx_rate, n.country_code, n.location,
                n.agent_version
         FROM nodes n
         ORDER BY n.hostname IS NULL, n.last_seen DESC",
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
    let mut tx =
        s.db.begin()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("DELETE FROM metrics WHERE node_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit()
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
    country_code: Option<String>,
    location: Option<String>,
}

async fn update_node_meta(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateNodeMetaReq>,
) -> Result<StatusCode, StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    sqlx::query(
        "UPDATE nodes SET expires_at=$1, price=$2, price_currency=$3, website_url=$4,
         latency_test_enabled=COALESCE($5,latency_test_enabled),
         country_code=COALESCE($6,country_code), location=COALESCE($7,location)
         WHERE id=$8",
    )
    .bind(req.expires_at)
    .bind(req.price)
    .bind(req.price_currency)
    .bind(req.website_url)
    .bind(req.latency_test_enabled)
    .bind(req.country_code)
    .bind(req.location)
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

    let tokens_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM nodes WHERE token IS NOT NULL")
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

// ── 公开状态页 ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct StatusDay {
    date: String,
    up: bool,
}

#[derive(Serialize)]
struct StatusNodeSummary {
    id: String,
    hostname: String,
    country_code: Option<String>,
    location: Option<String>,
    online: bool,
    uptime_30d: f64,
    uptime_90d: f64,
    days: Vec<StatusDay>,
}

#[derive(Serialize)]
struct PublicStatusResponse {
    nodes: Vec<StatusNodeSummary>,
}

async fn public_status(
    State(s): State<AppState>,
) -> Result<Json<PublicStatusResponse>, StatusCode> {
    #[derive(sqlx::FromRow)]
    struct SNodeRow {
        id: i64,
        hostname: String,
        country_code: Option<String>,
        location: Option<String>,
        last_seen: DateTime<Utc>,
    }
    #[derive(sqlx::FromRow)]
    struct DayRow {
        node_id: i64,
        day: chrono::NaiveDate,
    }

    let snodes = sqlx::query_as::<_, SNodeRow>(
        "SELECT id, hostname, country_code, location, last_seen FROM nodes WHERE hostname IS NOT NULL ORDER BY last_seen DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let day_rows = sqlx::query_as::<_, DayRow>(
        "SELECT node_id, DATE(reported_at AT TIME ZONE 'UTC') AS day
         FROM metrics
         WHERE reported_at >= NOW() - INTERVAL '90 days'
         GROUP BY node_id, DATE(reported_at AT TIME ZONE 'UTC')",
    )
    .fetch_all(&s.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut days_map: std::collections::HashMap<i64, std::collections::HashSet<chrono::NaiveDate>> =
        std::collections::HashMap::new();
    for dr in day_rows {
        days_map.entry(dr.node_id).or_default().insert(dr.day);
    }

    let today = chrono::Utc::now().date_naive();

    let nodes = snodes
        .into_iter()
        .map(|n| {
            let data = days_map.get(&n.id).cloned().unwrap_or_default();
            let days: Vec<StatusDay> = (0i64..90)
                .rev()
                .map(|i| {
                    let date = today - chrono::Duration::days(i);
                    StatusDay {
                        date: date.format("%Y-%m-%d").to_string(),
                        up: data.contains(&date),
                    }
                })
                .collect();
            let up30 = (0i64..30)
                .filter(|&i| data.contains(&(today - chrono::Duration::days(i))))
                .count() as f64
                / 30.0
                * 100.0;
            let up90 = (0i64..90)
                .filter(|&i| data.contains(&(today - chrono::Duration::days(i))))
                .count() as f64
                / 90.0
                * 100.0;
            let online = (chrono::Utc::now() - n.last_seen).num_seconds() < 120;
            StatusNodeSummary {
                id: n.id.to_string(),
                hostname: n.hostname,
                country_code: n.country_code,
                location: n.location,
                online,
                uptime_30d: (up30 * 100.0).round() / 100.0,
                uptime_90d: (up90 * 100.0).round() / 100.0,
                days,
            }
        })
        .collect();

    Ok(Json(PublicStatusResponse { nodes }))
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
            hostname  TEXT   UNIQUE,
            ip        TEXT,
            os        TEXT,
            arch      TEXT,
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

    // 补 reported_at 单列索引，让 retention DELETE 不走全表扫描
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_metrics_reported_at ON metrics(reported_at)")
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

    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS cpu_model TEXT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE metrics ADD COLUMN IF NOT EXISTS latency_cu_ms REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE metrics ADD COLUMN IF NOT EXISTS latency_cm_ms REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE metrics ADD COLUMN IF NOT EXISTS latency_ct_ms REAL")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE metrics ADD COLUMN IF NOT EXISTS net_rx_rate BIGINT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE metrics ADD COLUMN IF NOT EXISTS net_tx_rate BIGINT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE metrics ADD COLUMN IF NOT EXISTS tcp_connections INT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS net_rx_rate BIGINT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS net_tx_rate BIGINT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS country_code TEXT")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS location TEXT")
        .execute(pool)
        .await?;

    // === tokens → nodes 合并迁移（幂等，可重复执行）===

    // 给 nodes 加 token 相关列（name = agent 显示名称）
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS token TEXT")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS name TEXT")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS token_created_at TIMESTAMPTZ")
        .execute(pool)
        .await
        .ok();

    // 兼容迁移：token_name → name（若旧列存在则迁移数据后删除）
    sqlx::query(
        "DO $$ BEGIN
         IF EXISTS (SELECT FROM information_schema.columns WHERE table_name='nodes' AND column_name='token_name') THEN
           UPDATE nodes SET name=token_name WHERE name IS NULL;
           ALTER TABLE nodes DROP COLUMN token_name;
         END IF;
         END $$",
    )
    .execute(pool)
    .await.ok();

    // hostname/ip/os/arch 改为可空（pending token 行 hostname IS NULL）
    sqlx::query("ALTER TABLE nodes ALTER COLUMN hostname DROP NOT NULL")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE nodes ALTER COLUMN ip DROP NOT NULL")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE nodes ALTER COLUMN os DROP NOT NULL")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE nodes ALTER COLUMN arch DROP NOT NULL")
        .execute(pool)
        .await
        .ok();

    // 若 tokens 表还存在，迁移数据后删掉
    sqlx::query(
        "DO $$ BEGIN
         IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='tokens') THEN
           UPDATE nodes n
             SET token=t.token, name=t.name, token_created_at=t.created_at
           FROM tokens t
           WHERE n.token_id=t.id AND n.token IS NULL;
           INSERT INTO nodes (id, token, name, token_created_at, last_seen)
           SELECT t.id, t.token, t.name, t.created_at, t.created_at
           FROM tokens t
           WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.token_id=t.id)
           ON CONFLICT DO NOTHING;
         END IF;
         END $$",
    )
    .execute(pool)
    .await
    .ok();

    // token 列唯一索引（部分索引，只对非 NULL）
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_token ON nodes(token) WHERE token IS NOT NULL",
    )
    .execute(pool)
    .await
    .ok();

    // 删除旧 token_id 外键列
    sqlx::query("ALTER TABLE nodes DROP COLUMN IF EXISTS token_id")
        .execute(pool)
        .await
        .ok();

    // 删除 tokens 表
    sqlx::query("DROP TABLE IF EXISTS tokens")
        .execute(pool)
        .await
        .ok();

    // 访客追踪表（按 IP 去重）
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS visitors (
            id         BIGINT PRIMARY KEY,
            ip         TEXT NOT NULL UNIQUE,
            country_code TEXT,
            location   TEXT,
            asn        TEXT,
            isp        TEXT,
            page       TEXT NOT NULL DEFAULT '/',
            first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
    )
    .execute(pool)
    .await
    .ok();
    sqlx::query("ALTER TABLE visitors ADD COLUMN IF NOT EXISTS asn TEXT")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE visitors ADD COLUMN IF NOT EXISTS isp TEXT")
        .execute(pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen DESC)")
        .execute(pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS agent_version TEXT")
        .execute(pool)
        .await
        .ok();

    Ok(())
}

/// 从数据库加载所有 token 到内存 HashSet，启动时调用
async fn load_token_set(pool: &PgPool) -> Result<HashSet<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT token FROM nodes WHERE token IS NOT NULL")
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
                         WHERE reported_at < NOW() - $1 * INTERVAL '1 day'
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
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build HTTP client");

    // gRPC 拦截器：同时接受 global_token 和 DB token
    let global_token = cli.token.clone();
    let token_set_for_grpc = token_set.clone();
    let svc = MonitorService {
        db: pool.clone(),
        id_gen: id_gen.clone(),
        event_tx: event_tx.clone(),
        upgrade_set: upgrade_set.clone(),
        http_client: http_client.clone(),
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
        .route("/api/admin/visitors", get(admin_visitors))
        .route("/api/beacon", post(record_beacon))
        .route("/api/status", get(public_status))
        .with_state(AppState {
            db: pool,
            id_gen,
            token_set,
            event_tx,
            upgrade_set,
            http_client,
        })
        .layer(CorsLayer::permissive())
        .fallback_service(grpc_router);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", cli.port)).await?;
    info!("listening on :{} (gRPC + HTTP)", cli.port);
    axum::serve(listener, app).await?;

    Ok(())
}
