import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { subscribeNodes, type Node } from "../api";

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
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

      {/* 主机名 */}
      <div>
        <h2
          className="text-lg font-bold leading-tight text-[var(--color-ink)] break-all"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {node.hostname}
        </h2>
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

      {/* 最后上报 */}
      <p className="text-[11px] text-[var(--color-muted-foreground)] mt-auto pt-1 border-t border-[var(--color-border)]">
        {relativeTime(node.last_seen)}
      </p>
    </div>
  );
}

export default function Dashboard() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [connected, setConnected] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    let cancelled = false;
    const unsub = subscribeNodes((updated) => {
      if (cancelled) return;
      setConnected(true);
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
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 管理后台按钮 */}
          <button
            onClick={() => navigate("/app")}
            className="relative flex items-center gap-1.5 px-4 py-2 rounded-full font-semibold text-sm
              border-2 border-[var(--color-ink)] bg-white text-[var(--color-ink)]
              shadow-[3px_3px_0_0_#1E293B]
              hover:bg-[var(--color-amber)] hover:shadow-[5px_5px_0_0_#1E293B] hover:-translate-x-0.5 hover:-translate-y-0.5
              active:shadow-[1px_1px_0_0_#1E293B] active:translate-x-0.5 active:translate-y-0.5
              transition-all duration-150 cursor-pointer"
          >
            管理后台
          </button>
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
              前往管理后台创建 Token，然后运行 Agent
            </p>
            <button
              onClick={() => navigate("/app")}
              className="px-5 py-2.5 rounded-full font-semibold text-sm text-white
                border-2 border-[var(--color-ink)]
                shadow-[3px_3px_0_0_#1E293B]
                hover:shadow-[5px_5px_0_0_#1E293B] hover:-translate-x-0.5 hover:-translate-y-0.5
                active:shadow-[1px_1px_0_0_#1E293B] active:translate-x-0.5 active:translate-y-0.5
                transition-all duration-150 cursor-pointer"
              style={{ background: "var(--color-violet)" }}
            >
              去管理后台
            </button>
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
