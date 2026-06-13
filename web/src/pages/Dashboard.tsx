import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { countryFlagUrl, fmtBandwidth, sendBeacon, subscribeNodes, type BeaconInfo, type Node } from "../api";

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

function LatencyPill({
  label,
  ms,
  bg,
  dark,
}: {
  label: string;
  ms: number | null | undefined;
  bg: string;
  dark?: boolean;
}) {
  if (ms == null) return null;
  const text = ms < 0 ? "超时" : `${ms.toFixed(0)} ms`;
  const isTimeout = ms < 0;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border-2 border-[var(--color-ink)] select-none"
      style={{
        background: isTimeout ? "#f87171" : bg,
        color: dark ? "#1E293B" : "#fff",
      }}
    >
      <span className="opacity-70">{label}</span>
      {text}
    </span>
  );
}

function NodeCard({ node }: { node: Node }) {
  const online = isOnline(node.last_seen);
  const hasLatency =
    node.latency_cu_ms != null ||
    node.latency_cm_ms != null ||
    node.latency_ct_ms != null;

  return (
    <div
      className="relative bg-white rounded-2xl border-2 border-[var(--color-ink)] p-5 flex flex-col gap-3
        shadow-[4px_4px_0_0_#1E293B]
        hover:shadow-[6px_6px_0_0_#1E293B] hover:-translate-x-0.5 hover:-translate-y-0.5
        transition-all duration-200 ease-out cursor-pointer group"
    >
      {/* 整张卡片可点击 */}
      <Link
        href={`/nodes/${node.id}`}
        className="absolute inset-0 rounded-2xl"
        aria-label={node.hostname}
      />

      {/* 顶部：状态 + 外部链接 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {online ? (
            <span className="relative flex h-2.5 w-2.5">
              <span
                className="absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{
                  background: "var(--color-emerald)",
                  animation: "ping-slow 1.4s cubic-bezier(0,0,0.2,1) infinite",
                }}
              />
              <span
                className="relative inline-flex rounded-full h-2.5 w-2.5"
                style={{ background: "var(--color-emerald)" }}
              />
            </span>
          ) : (
            <span className="h-2.5 w-2.5 rounded-full bg-red-400 inline-block" />
          )}
          <span
            className="text-[11px] font-semibold uppercase tracking-widest"
            style={{ color: online ? "var(--color-emerald)" : "#f87171" }}
          >
            {online ? "在线" : "离线"}
          </span>
        </div>

        {node.website_url && (
          <a
            href={node.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="relative z-10 flex items-center justify-center w-7 h-7 rounded-full
              border-2 border-[var(--color-ink)] bg-[var(--color-cream)]
              hover:bg-[var(--color-amber)] transition-colors"
            title="官网"
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </a>
        )}
      </div>

      {/* 主机名 / Agent 名称 */}
      <div>
        {/* 国旗 + 地区 */}
        {(node.country_code || node.location) && (
          <div className="flex items-center gap-1.5 mb-1">
            {node.country_code && (
              <img src={countryFlagUrl(node.country_code)!} alt={node.country_code} className="w-5 h-auto rounded-sm" />
            )}
            {node.location && (
              <span className="text-xs text-[var(--color-muted-foreground)]">{node.location}</span>
            )}
          </div>
        )}
        <h2
          className="text-lg font-bold leading-tight text-[var(--color-ink)] break-all"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {node.name || node.hostname}
        </h2>
        {node.name && (
          <p className="text-xs font-mono text-[var(--color-muted-foreground)] opacity-60 mt-0.5">
            {node.hostname}
          </p>
        )}
        <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5 leading-snug">
          {node.os}
          <span className="mx-1.5 opacity-40">·</span>
          <span className="text-xs font-mono opacity-70">{node.arch}</span>
        </p>
        {node.cpu_model && (
          <p className="text-xs text-[var(--color-muted-foreground)] truncate mt-0.5 opacity-75">
            {node.cpu_model}
          </p>
        )}
      </div>

      {/* 三网延迟 */}
      {hasLatency && (
        <div className="flex flex-wrap gap-1.5">
          <LatencyPill
            label="联通"
            ms={node.latency_cu_ms}
            bg="var(--color-violet)"
          />
          <LatencyPill
            label="移动"
            ms={node.latency_cm_ms}
            bg="var(--color-pink)"
          />
          <LatencyPill
            label="电信"
            ms={node.latency_ct_ms}
            bg="var(--color-amber)"
            dark
          />
        </div>
      )}

      {/* 实时带宽 */}
      {(node.net_rx_rate != null || node.net_tx_rate != null) && (
        <div className="flex gap-3 text-xs font-mono">
          <span className="text-[var(--color-emerald)]">↓ {fmtBandwidth(node.net_rx_rate)}</span>
          <span style={{ color: "var(--color-violet)" }}>↑ {fmtBandwidth(node.net_tx_rate)}</span>
        </div>
      )}

    </div>
  );
}

function useSecondTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

function fmtUpdatedAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  return `${Math.floor(secs / 60)} 分钟前`;
}

export default function Dashboard() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [connected, setConnected] = useState(false);
  const [visitorInfo, setVisitorInfo] = useState<BeaconInfo | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  useSecondTick();

  useEffect(() => {
    sendBeacon("/").then((info) => { if (info) setVisitorInfo(info); });
    const interval = setInterval(() => sendBeacon("/"), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsub = subscribeNodes((updated) => {
      if (cancelled) return;
      setConnected(true);
      lastUpdatedRef.current = Date.now();
      setLastUpdatedAt(Date.now());
      setNodes((prev) => {
        const idx = prev.findIndex((n) => n.id === updated.id);
        if (idx === -1) return [...prev, updated];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const { onlineCount, offlineCount } = useMemo(() => {
    const online = nodes.filter((n) => isOnline(n.last_seen)).length;
    return { onlineCount: online, offlineCount: nodes.length - online };
  }, [nodes]);

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--color-cream)" }}
    >
      {/* ── Header ── */}
      <header className="relative overflow-hidden border-b-2 border-[var(--color-ink)] bg-white">
        {/* 装饰几何图形 */}
        <div
          className="absolute -top-8 -right-8 w-40 h-40 rounded-full opacity-15 pointer-events-none"
          style={{ background: "var(--color-violet)" }}
        />
        <div
          className="absolute top-4 right-28 w-6 h-6 rounded-full opacity-40 pointer-events-none"
          style={{ background: "var(--color-pink)" }}
        />
        <div
          className="absolute -bottom-4 left-1/3 w-20 h-20 rounded-full opacity-10 pointer-events-none"
          style={{ background: "var(--color-amber)" }}
        />

        <div className="relative max-w-6xl mx-auto px-5 py-4 flex items-center justify-between gap-4">
          {/* 品牌区 */}
          <div className="flex items-center gap-3">
            {/* Logo 标志 */}
            <div
              className="flex items-center justify-center w-9 h-9 rounded-xl border-2 border-[var(--color-ink)]"
              style={{ background: "var(--color-violet)" }}
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                className="w-4 h-4"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="10" cy="10" r="3" fill="white" />
                <circle cx="10" cy="10" r="7" stroke="white" strokeWidth="2" />
              </svg>
            </div>

            <div>
              <h1
                className="text-xl font-bold leading-none text-[var(--color-ink)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Senti
                <span style={{ color: "var(--color-violet)" }}>node</span>
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  服务器监控
                </span>
                {connected && nodes.length > 0 && (
                  <>
                    <span className="text-[var(--color-border)]">·</span>
                    <span
                      className="text-xs font-semibold"
                      style={{ color: "var(--color-emerald)" }}
                    >
                      {onlineCount} 在线
                    </span>
                    {offlineCount > 0 && (
                      <>
                        <span className="text-[var(--color-border)]">·</span>
                        <span className="text-xs font-semibold text-red-400">
                          {offlineCount} 离线
                        </span>
                      </>
                    )}
                    {lastUpdatedAt && (
                      <>
                        <span className="text-[var(--color-border)]">·</span>
                        <span
                          className="text-xs text-[var(--color-muted-foreground)] cursor-default"
                          title={new Date(lastUpdatedAt).toLocaleTimeString()}
                        >
                          {fmtUpdatedAgo(lastUpdatedAt)}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 访客信息 */}
          {visitorInfo && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)] flex-shrink-0">
              {visitorInfo.country_code && (
                <img
                  src={countryFlagUrl(visitorInfo.country_code)!}
                  alt={visitorInfo.country_code}
                  className="w-4 h-auto rounded-sm"
                />
              )}
              {visitorInfo.location && (
                <span className="hidden sm:inline">{visitorInfo.location}</span>
              )}
              <code className="hidden md:inline font-mono text-[10px] bg-[var(--color-cream)] border border-[var(--color-border)] px-1 py-0.5 rounded">
                {visitorInfo.ip}
              </code>
              {visitorInfo.isp && (
                <span className="hidden lg:inline text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-cream)] border border-[var(--color-border)]">
                  {visitorInfo.isp}
                </span>
              )}
              <span className="text-[var(--color-border)]">·</span>
              <span>
                今日第 <span className="font-semibold text-[var(--color-ink)]">{visitorInfo.today_rank}</span> 位
              </span>
              <span className="text-[var(--color-border)]">·</span>
              <span>
                历史第 <span className="font-semibold text-[var(--color-ink)]">{visitorInfo.total_rank}</span> 位
              </span>
            </div>
          )}

        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-6xl mx-auto px-5 py-8">
        {!connected ? (
          /* 加载中：骨架占位 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-2xl border-2 border-[var(--color-border)] bg-white p-5 h-44 animate-pulse"
                style={{ opacity: 1 - i * 0.2 }}
              />
            ))}
          </div>
        ) : nodes.length === 0 ? (
          /* 空状态 */
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div
              className="w-20 h-20 rounded-2xl border-2 border-[var(--color-ink)] flex items-center justify-center
                shadow-[4px_4px_0_0_#1E293B]"
              style={{ background: "var(--color-violet)" }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="w-10 h-10"
                stroke="white"
                strokeWidth={2}
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </div>
            <p
              className="text-xl font-bold text-[var(--color-ink)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              暂无节点
            </p>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              暂无节点接入
            </p>
          </div>
        ) : (
          /* 节点卡片网格 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {nodes.map((n) => (
              <NodeCard key={n.id} node={n} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
