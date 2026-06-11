// Bun build 通过 --define 将 process.env.API_BASE 替换为字符串常量
declare const process: { env: { API_BASE?: string } };

export const SERVER_URL = process.env.API_BASE ?? "";
const BASE = SERVER_URL + "/api";

export interface Node {
  id: string;
  name: string | null;
  hostname: string;
  os: string;
  arch: string;
  cpu_model: string | null;
  last_seen: string;
  website_url: string | null;
  latency_cu_ms: number | null;
  latency_cm_ms: number | null;
  latency_ct_ms: number | null;
  latency_updated_at: string | null;
  net_rx_rate: number | null;
  net_tx_rate: number | null;
  country_code: string | null;
  location: string | null;
}

export interface AdminNode extends Node {
  connected: boolean;
  ip: string;
  price: number | null;
  price_currency: string | null;
  latency_test_enabled: boolean;
  name: string | null;
  token: string | null;
}

// ── 汇率换算 ──────────────────────────────────────────────────────────────────

let _ratesCache: { rates: Record<string, number>; ts: number } | null = null;

async function getUsdRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (_ratesCache && now - _ratesCache.ts < 3_600_000) return _ratesCache.rates;
  const r = await fetch("https://open.er-api.com/v6/latest/USD");
  const data = await r.json();
  _ratesCache = { rates: data.rates as Record<string, number>, ts: now };
  return _ratesCache.rates;
}

/** 将任意货币价格换算为人民币，失败时返回 null */
export async function toCNY(price: number, currency: string): Promise<number | null> {
  if (currency === "CNY") return price;
  try {
    const rates = await getUsdRates();
    const cnyPerUsd = rates["CNY"] ?? null;
    const srcPerUsd = rates[currency] ?? null;
    if (!cnyPerUsd || !srcPerUsd) return null;
    return price * (cnyPerUsd / srcPerUsd);
  } catch {
    return null;
  }
}

export interface Metric {
  id: string;
  cpu_percent: number;
  mem_total: number;
  mem_used: number;
  swap_total: number;
  swap_used: number;
  load1: number;
  load5: number;
  load15: number;
  uptime_secs: number;
  reported_at: string;
  latency_cu_ms: number | null;
  latency_cm_ms: number | null;
  latency_ct_ms: number | null;
  net_rx_rate: number | null;
  net_tx_rate: number | null;
  tcp_connections: number | null;
}

export interface AgentToken {
  id: string;
  name: string;
  token: string;
  created_at: string;
}

export function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function deleteNode(id: string): Promise<void> {
  const r = await fetch(`${BASE}/admin/nodes/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function fetchNode(id: string): Promise<Node> {
  const r = await fetch(`${BASE}/nodes/${id}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 订阅 SSE 节点更新，返回 unsubscribe 函数 */
export function subscribeNodes(onUpdate: (node: Node) => void): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "node_updated") onUpdate(msg.data as Node);
    } catch {}
  };
  return () => es.close();
}

/** 订阅特定节点的实时 metric_added 事件，返回 unsubscribe 函数 */
export function subscribeNodeDetail(
  nodeId: string,
  onMetric: (m: Metric) => void,
): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "metric_added" && msg.node_id === nodeId) {
        onMetric({
          id: `sse-${Date.now()}`,
          reported_at: new Date().toISOString(),
          ...(msg.data as Omit<Metric, "id" | "reported_at">),
        });
      }
    } catch {}
  };
  return () => es.close();
}

export async function fetchAdminNodes(): Promise<AdminNode[]> {
  const r = await fetch(`${BASE}/admin/nodes`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchMetrics(id: string, hours = 1): Promise<Metric[]> {
  const r = await fetch(`${BASE}/nodes/${id}/metrics?hours=${hours}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchTokens(): Promise<AgentToken[]> {
  const r = await fetch(`${BASE}/admin/tokens`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function createToken(name: string): Promise<AgentToken> {
  const r = await fetch(`${BASE}/admin/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function deleteToken(id: string): Promise<void> {
  const r = await fetch(`${BASE}/admin/tokens/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function triggerUpgrade(id: string): Promise<void> {
  const r = await fetch(`${BASE}/admin/nodes/${id}/upgrade`, { method: "POST" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function toggleLatencyTest(id: string, enabled: boolean): Promise<void> {
  const r = await fetch(`${BASE}/admin/nodes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latency_test_enabled: enabled }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export interface AdminStats {
  db_size_bytes: number;
  db_size_pretty: string;
  nodes_count: number;
  metrics_count: number;
  tokens_count: number;
  daily_metrics: { day: string; count: number }[];
}

export async function fetchAdminStats(): Promise<AdminStats> {
  const r = await fetch(`${BASE}/admin/stats`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function updateNodeMeta(
  id: string,
  data: { expires_at?: string | null; price?: number | null; price_currency?: string | null; website_url?: string | null; country_code?: string | null; location?: string | null },
): Promise<void> {
  const r = await fetch(`${BASE}/admin/nodes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export function fmtBandwidth(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || bytesPerSec <= 0) return "—";
  const mb = bytesPerSec / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSec / 1024;
  return `${kb.toFixed(0)} KB/s`;
}

export interface VisitorEntry {
  ip: string;
  country_code: string | null;
  location: string | null;
  asn: string | null;
  isp: string | null;
  page: string;
  first_seen: string;
  last_seen: string;
}

export interface VisitorStats {
  total: number;
  today: number;
  active_now: number;
  recent: VisitorEntry[];
}

export interface BeaconInfo {
  ip: string;
  country_code: string | null;
  location: string | null;
  asn: string | null;
  isp: string | null;
  today_rank: number;
  total_rank: number;
}

export async function sendBeacon(page: string): Promise<BeaconInfo | null> {
  try {
    const r = await fetch(`${BASE}/beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page }),
    });
    if (r.ok) return r.json();
  } catch {}
  return null;
}

export async function fetchVisitors(): Promise<VisitorStats> {
  const r = await fetch(`${BASE}/admin/visitors`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function countryFlagUrl(code: string | null | undefined): string | null {
  if (!code || code.length !== 2) return null;
  return `https://flagcdn.com/20x15/${code.toLowerCase()}.png`;
}

export interface StatusNode {
  id: string;
  hostname: string;
  country_code: string | null;
  location: string | null;
  online: boolean;
  uptime_30d: number;
  uptime_90d: number;
  days: { date: string; up: boolean }[];
}

export async function fetchStatus(): Promise<StatusNode[]> {
  const r = await fetch(`${BASE}/status`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.nodes as StatusNode[];
}
