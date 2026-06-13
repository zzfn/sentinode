import { useEffect, useState } from "react";
import { Link } from "wouter";
import { countryFlagUrl, fetchStatus, sendBeacon, type StatusNode } from "../api";

function UptimeBar({ days }: { days: { date: string; up: boolean }[] }) {
  return (
    <div className="flex gap-px items-end h-8 flex-1 min-w-0">
      {days.map((d, i) => (
        <div
          key={i}
          className="flex-1 min-w-0 rounded-sm"
          title={d.date}
          style={{
            height: d.up ? "100%" : "40%",
            background: d.up ? "var(--color-emerald)" : "#E2E8F0",
          }}
        />
      ))}
    </div>
  );
}

function NodeRow({ node }: { node: StatusNode }) {
  const flag = countryFlagUrl(node.country_code);
  return (
    <div
      className="bg-white rounded-2xl border-2 border-[var(--color-ink)] p-5
        shadow-[3px_3px_0_0_#1E293B] space-y-3"
    >
      {/* 顶部：状态 + 名称 + 地区 */}
      <div className="flex items-center gap-2 flex-wrap">
        {node.online ? (
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
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
          <span className="h-2.5 w-2.5 rounded-full bg-red-400 flex-shrink-0" />
        )}
        {flag && (
          <img src={flag} alt={node.country_code ?? ""} title={node.location ?? undefined} className="w-5 h-auto rounded-sm" />
        )}
        <span
          className="font-bold text-[var(--color-ink)] text-base"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {node.hostname}
        </span>
        {node.location && (
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {node.location}
          </span>
        )}
        <div className="ml-auto flex gap-3 text-xs font-semibold tabular-nums">
          <span title="近 30 天可用率">
            <span className="text-[var(--color-muted-foreground)] font-normal mr-1">30d</span>
            <span style={{ color: node.uptime_30d >= 99 ? "var(--color-emerald)" : node.uptime_30d >= 95 ? "var(--color-amber)" : "#f87171" }}>
              {node.uptime_30d.toFixed(1)}%
            </span>
          </span>
          <span title="近 90 天可用率">
            <span className="text-[var(--color-muted-foreground)] font-normal mr-1">90d</span>
            <span style={{ color: node.uptime_90d >= 99 ? "var(--color-emerald)" : node.uptime_90d >= 95 ? "var(--color-amber)" : "#f87171" }}>
              {node.uptime_90d.toFixed(1)}%
            </span>
          </span>
        </div>
      </div>

      {/* 日历条 */}
      <UptimeBar days={node.days} />

      {/* 标注 */}
      <div className="flex justify-between text-[10px] text-[var(--color-muted-foreground)]">
        <span>90 天前</span>
        <span>今天</span>
      </div>
    </div>
  );
}

export default function Status() {
  const [nodes, setNodes] = useState<StatusNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = "状态页 · Sentinode"; }, []);

  useEffect(() => {
    sendBeacon("/status");
    const interval = setInterval(() => sendBeacon("/status"), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchStatus()
      .then(setNodes)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const onlineCount = nodes.filter((n) => n.online).length;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-cream)" }}>
      {/* Header */}
      <header className="relative overflow-hidden border-b-2 border-[var(--color-ink)] bg-white">
        <div
          className="absolute -top-8 -right-8 w-40 h-40 rounded-full opacity-10 pointer-events-none"
          style={{ background: "var(--color-emerald)" }}
        />
        <div className="relative max-w-4xl mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-xl border-2 border-[var(--color-ink)]"
              style={{ background: "var(--color-emerald)" }}
            >
              <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4">
                <circle cx="10" cy="10" r="3" fill="white" />
                <circle cx="10" cy="10" r="7" stroke="white" strokeWidth="2" />
              </svg>
            </div>
            <div>
              <h1
                className="text-xl font-bold leading-none text-[var(--color-ink)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                服务<span style={{ color: "var(--color-emerald)" }}>状态</span>
              </h1>
              {!loading && (
                <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
                  {onlineCount} / {nodes.length} 节点在线
                </p>
              )}
            </div>
          </div>
          <Link
            href="/"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold
              border-2 border-[var(--color-ink)] bg-white text-[var(--color-ink)]
              shadow-[2px_2px_0_0_#1E293B]
              hover:bg-[var(--color-amber)] hover:shadow-[3px_3px_0_0_#1E293B]
              transition-all duration-150"
          >
            ← 首页
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-7">
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-28 rounded-2xl border-2 border-[var(--color-border)] bg-white animate-pulse"
                style={{ opacity: 1 - i * 0.2 }}
              />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-2xl border-2 border-red-400 bg-red-50 p-5 text-sm text-red-600">
            错误：{error}
          </div>
        ) : nodes.length === 0 ? (
          <div className="text-center py-20 text-[var(--color-muted-foreground)]">暂无节点</div>
        ) : (
          <div className="space-y-4">
            {nodes.map((n) => (
              <NodeRow key={n.id} node={n} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
