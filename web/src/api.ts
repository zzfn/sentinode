// Bun build 通过 --define 将 process.env.API_BASE 替换为字符串常量
declare const process: { env: { API_BASE?: string } };

export const SERVER_URL = process.env.API_BASE ?? "";
const BASE = SERVER_URL + "/api";

export interface Node {
  id: string;
  hostname: string;
  ip: string;
  os: string;
  arch: string;
  last_seen: string;
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

export async function fetchMetrics(id: string, limit = 60): Promise<Metric[]> {
  const r = await fetch(`${BASE}/nodes/${id}/metrics?limit=${limit}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchTokens(): Promise<AgentToken[]> {
  const r = await fetch(`${BASE}/tokens`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function createToken(name: string): Promise<AgentToken> {
  const r = await fetch(`${BASE}/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function deleteToken(id: string): Promise<void> {
  const r = await fetch(`${BASE}/tokens/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
