// Bun build 通过 --define 将 process.env.API_BASE 替换为字符串常量
declare const process: { env: { API_BASE?: string } };

export const SERVER_URL = process.env.API_BASE ?? "";
const BASE = SERVER_URL + "/api";

export interface Node {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  last_seen: string;
  website_url: string | null;
  latency_cu_ms: number | null;
  latency_cm_ms: number | null;
  latency_ct_ms: number | null;
  latency_updated_at: string | null;
}

export interface AdminNode extends Node {
  ip: string;
  price: number | null;
  price_currency: string | null;
  latency_test_enabled: boolean;
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

export async function fetchNodes(): Promise<Node[]> {
  const r = await fetch(`${BASE}/nodes`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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

export async function fetchMetrics(id: string, limit = 60): Promise<Metric[]> {
  const r = await fetch(`${BASE}/nodes/${id}/metrics?limit=${limit}`);
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
  data: { expires_at?: string | null; price?: number | null; price_currency?: string | null; website_url?: string | null },
): Promise<void> {
  const r = await fetch(`${BASE}/admin/nodes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
