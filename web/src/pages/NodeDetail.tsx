import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import {
  countryFlagUrl,
  fetchMetrics,
  fetchNode,
  fmtBandwidth,
  fmtBytes,
  fmtUptime,
  subscribeNodeDetail,
  type Metric,
  type Node,
} from "../api";

// ── 设计 token（对齐首页 Dashboard 的扁平浅绿风）────────────────────────────────
const BG = "radial-gradient(1100px 620px at 82% -8%, #cbe8fb 0%, rgba(238,245,250,0.6) 42%, #ffffff 78%)";
const CARD = "bg-white/85 backdrop-blur-sm rounded-2xl border border-sky-200/60 shadow-[0_2px_10px_rgba(14,165,233,0.07)]";
const MINT = "#0ea5e9";

const RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
] as const;
type RangeHours = 1 | 6 | 24 | 168;

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 0) return "超时";
  return `${ms.toFixed(0)} ms`;
}

function fmtTime(iso: string, hours: number): string {
  const d = new Date(iso);
  if (hours <= 1) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  if (hours <= 24) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

// ── 展示型小组件 ────────────────────────────────────────────────────────────────

/** 信息卡：标题 + 若干浅灰子块 */
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`${CARD} p-4 flex flex-col gap-3`}>
      <h3
        className="text-xs font-semibold uppercase tracking-wider text-slate-400"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

/** 信息行：label 灰 / value 深色，包在浅灰子块里 */
function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-slate-50 rounded-lg px-3 py-2">
      <span className="text-xs text-slate-500 flex-shrink-0">{label}</span>
      <span className="text-xs font-semibold text-slate-800 tabular-nums text-right truncate">
        {value ?? "—"}
      </span>
    </div>
  );
}

/** 当前指标小卡：左侧色点 + label + 大数值 */
function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className={`${CARD} p-4 flex flex-col gap-1`}>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </span>
      </div>
      <p
        className="text-2xl font-bold text-slate-800 leading-tight tabular-nums"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-slate-400 leading-snug truncate">{sub}</p>}
    </div>
  );
}

/** 图表卡：白底 CARD，标题在卡片内顶部，右侧次要信息 / 操作 */
function ChartCard({
  title,
  sub,
  dotColor,
  axisLabel,
  action,
  children,
}: {
  title: string;
  sub?: string;
  dotColor: string;
  axisLabel?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`${CARD} p-4 flex flex-col gap-2`}>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
        <h3
          className="text-sm font-semibold text-slate-800 leading-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {title}
        </h3>
        {sub && <span className="text-xs text-slate-400">{sub}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {axisLabel && <p className="text-[10px] text-slate-400 -mt-0.5 ml-4">{axisLabel}</p>}
      {children}
    </div>
  );
}

// ── 图表共用：坐标轴 / 网格的精致预设 ────────────────────────────────────────────
const GRID_STROKE = "rgba(148,163,184,0.15)";
const AXIS_TICK = { fontSize: 10, fill: "#94a3b8" } as const;

/** 一段从顶部到底部渐隐的填充渐变（每序列唯一 id） */
function AreaGradient({ id, color }: { id: string; color: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={color} stopOpacity={0.35} />
      <stop offset="95%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

export default function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const [node, setNode] = useState<Node | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeHours>(1);
  const [chartLoading, setChartLoading] = useState(false);
  const [smoothLatency, setSmoothLatency] = useState(false);

  useEffect(() => {
    const name = node?.name || node?.hostname || id;
    document.title = name ? `${name} · Sentinode` : "Sentinode";
  }, [node, id]);

  // 初始加载节点信息 + 1h 数据
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    Promise.all([fetchNode(id), fetchMetrics(id, 1)])
      .then(([n, data]) => {
        if (!cancelled) { setNode(n); setMetrics(data); }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [id]);

  // 切换时间范围时重新拉取历史数据
  useEffect(() => {
    if (!id || loading) return;
    let cancelled = false;
    setChartLoading(true);
    fetchMetrics(id, range)
      .then((data) => { if (!cancelled) setMetrics(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setChartLoading(false); });
    return () => { cancelled = true; };
  }, [id, range]);

  // 仅 1h 模式下订阅 SSE 实时追加，同时更新节点状态保持在线判断准确
  useEffect(() => {
    if (!id || range !== 1) return;
    const unsub = subscribeNodeDetail(
      id,
      (m) => {
        setMetrics((prev) => {
          const next = [...prev, m];
          return next.length > 300 ? next.slice(-300) : next;
        });
      },
      (n) => setNode(n),
    );
    return unsub;
  }, [id, range]);

  const latest = metrics[metrics.length - 1];

  const chartData = useMemo(
    () =>
      metrics.map((m) => ({
        time: fmtTime(m.reported_at, range),
        cpu: parseFloat(m.cpu_percent.toFixed(1)),
        memPct:
          m.mem_total > 0
            ? parseFloat(((m.mem_used / m.mem_total) * 100).toFixed(1))
            : 0,
        swapPct:
          m.swap_total > 0
            ? parseFloat(((m.swap_used / m.swap_total) * 100).toFixed(1))
            : 0,
        load1: parseFloat(m.load1.toFixed(2)),
        load5: parseFloat(m.load5.toFixed(2)),
        load15: parseFloat(m.load15.toFixed(2)),
        cu:
          m.latency_cu_ms != null && m.latency_cu_ms >= 0
            ? parseFloat(m.latency_cu_ms.toFixed(1))
            : null,
        cm:
          m.latency_cm_ms != null && m.latency_cm_ms >= 0
            ? parseFloat(m.latency_cm_ms.toFixed(1))
            : null,
        ct:
          m.latency_ct_ms != null && m.latency_ct_ms >= 0
            ? parseFloat(m.latency_ct_ms.toFixed(1))
            : null,
        cuJitter: m.latency_cu_jitter != null ? parseFloat(m.latency_cu_jitter.toFixed(1)) : null,
        cmJitter: m.latency_cm_jitter != null ? parseFloat(m.latency_cm_jitter.toFixed(1)) : null,
        ctJitter: m.latency_ct_jitter != null ? parseFloat(m.latency_ct_jitter.toFixed(1)) : null,
        cuLoss: m.latency_cu_loss != null ? parseFloat(m.latency_cu_loss.toFixed(1)) : null,
        cmLoss: m.latency_cm_loss != null ? parseFloat(m.latency_cm_loss.toFixed(1)) : null,
        ctLoss: m.latency_ct_loss != null ? parseFloat(m.latency_ct_loss.toFixed(1)) : null,
        rxMbps: m.net_rx_rate != null && m.net_rx_rate > 0 ? parseFloat((m.net_rx_rate / 1024 / 1024).toFixed(2)) : null,
        txMbps: m.net_tx_rate != null && m.net_tx_rate > 0 ? parseFloat((m.net_tx_rate / 1024 / 1024).toFixed(2)) : null,
        tcp: m.tcp_connections != null ? m.tcp_connections : null,
      })),
    [metrics],
  );

  const latencyChartData = useMemo(() => {
    if (!smoothLatency) return chartData;
    const W = 5;
    return chartData.map((d, i) => {
      const avg = (key: "cu" | "cm" | "ct") => {
        const vals: number[] = [];
        for (let j = Math.max(0, i - W + 1); j <= i; j++) {
          const v = chartData[j][key];
          if (v != null) vals.push(v);
        }
        if (vals.length === 0) return null;
        return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
      };
      return { ...d, cu: avg("cu"), cm: avg("cm"), ct: avg("ct") };
    });
  }, [chartData, smoothLatency]);

  const hasLatencyHistory = useMemo(
    () => chartData.some((d) => d.cu != null || d.cm != null || d.ct != null),
    [chartData],
  );

  const hasLossHistory = useMemo(
    () => chartData.some((d) => d.cuLoss != null || d.cmLoss != null || d.ctLoss != null),
    [chartData],
  );

  const hasJitterHistory = useMemo(
    () => chartData.some((d) => d.cuJitter != null || d.cmJitter != null || d.ctJitter != null),
    [chartData],
  );

  const hasBandwidthHistory = useMemo(
    () => chartData.some((d) => d.rxMbps != null || d.txMbps != null),
    [chartData],
  );

  const hasTcpHistory = useMemo(
    () => chartData.some((d) => d.tcp != null),
    [chartData],
  );

  const online = node ? isOnline(node.last_seen) : false;

  // 内存 / 交换 / 硬盘 当前值（优先 latest metric，回退 node 快照）
  const memUsed = latest?.mem_used ?? node?.mem_used ?? null;
  const memTotal = latest?.mem_total ?? node?.mem_total ?? null;
  const swapUsed = latest?.swap_used ?? node?.swap_used ?? null;
  const swapTotal = latest?.swap_total ?? node?.swap_total ?? null;
  const uptimeSecs = latest?.uptime_secs ?? node?.uptime_secs ?? null;

  return (
    <div className="min-h-screen" style={{ background: BG }}>
      {/* ── Header（扁平，sticky 半透明白底）── */}
      <header className="border-b border-sky-200/50 bg-white/70 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center gap-3">
          {/* 返回首页 */}
          <Link
            href="/"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold
              border border-sky-200 bg-white/80 text-sky-700
              hover:bg-sky-50 hover:border-sky-300 transition-all duration-150 flex-shrink-0"
          >
            <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 3L5 8l5 5" />
            </svg>
            返回
          </Link>

          <span className="w-px h-5 bg-sky-200/60 flex-shrink-0" />

          <div className="flex items-center gap-2 min-w-0">
            {node && (
              online ? (
                <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                  <span
                    className="absolute inline-flex h-full w-full rounded-full opacity-75"
                    style={{ background: MINT, animation: "ping-slow 1.4s cubic-bezier(0,0,0.2,1) infinite" }}
                  />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: MINT }} />
                </span>
              ) : (
                <span className="h-2.5 w-2.5 rounded-full bg-red-400 flex-shrink-0" />
              )
            )}
            {node?.country_code && (
              <img src={countryFlagUrl(node.country_code)!} alt={node.country_code} className="w-5 h-[15px] rounded-sm flex-shrink-0" />
            )}
            <h1
              className="text-base font-bold text-slate-800 truncate"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {node?.name || node?.hostname || id}
            </h1>
            {node && (
              <span className="hidden sm:block text-xs text-slate-400 truncate">{node.os}</span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-7 space-y-6">
        {loading ? (
          /* 骨架 */
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className={`h-28 ${CARD} animate-pulse`} style={{ opacity: 1 - i * 0.12 }} />
              ))}
            </div>
            <div className={`h-56 ${CARD} animate-pulse`} />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-600">
            错误：{error}
          </div>
        ) : (
          <>
            {/* ── 信息卡区：硬件 / 系统 / 存储 / 网络 ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <InfoCard title="硬件信息">
                <InfoItem label="CPU 型号" value={node?.cpu_model ?? "—"} />
                <InfoItem label="架构" value={node?.arch ?? "—"} />
              </InfoCard>

              <InfoCard title="系统信息">
                <InfoItem label="操作系统" value={node?.os ?? "—"} />
                <InfoItem label="运行时间" value={uptimeSecs != null ? fmtUptime(uptimeSecs) : "—"} />
                <InfoItem label="最后上报" value={fmtDateTime(node?.last_seen)} />
              </InfoCard>

              <InfoCard title="存储信息">
                <InfoItem
                  label="内存"
                  value={memUsed != null && memTotal != null ? `${fmtBytes(memUsed)} / ${fmtBytes(memTotal)}` : "—"}
                />
                <InfoItem
                  label="交换"
                  value={swapTotal != null && swapTotal > 0 && swapUsed != null ? `${fmtBytes(swapUsed)} / ${fmtBytes(swapTotal)}` : "—"}
                />
                <InfoItem
                  label="硬盘"
                  value={node?.disk_used != null && node?.disk_total != null && node.disk_total > 0 ? `${fmtBytes(node.disk_used)} / ${fmtBytes(node.disk_total)}` : "—"}
                />
              </InfoCard>

              <InfoCard title="网络信息">
                <InfoItem
                  label="总流量 ↑"
                  value={node?.net_tx_total != null ? fmtBytes(node.net_tx_total) : "—"}
                />
                <InfoItem
                  label="总流量 ↓"
                  value={node?.net_rx_total != null ? fmtBytes(node.net_rx_total) : "—"}
                />
                <InfoItem
                  label="实时速率"
                  value={
                    <span className="font-mono">
                      <span className="text-sky-600">↑{fmtBandwidth(node?.net_tx_rate)}</span>
                      <span className="mx-1 text-slate-300">·</span>
                      <span className="text-violet-500">↓{fmtBandwidth(node?.net_rx_rate)}</span>
                    </span>
                  }
                />
              </InfoCard>
            </div>

            {/* ── 当前指标小卡排 ── */}
            {latest && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard
                  label="CPU 使用率"
                  value={`${latest.cpu_percent.toFixed(1)}%`}
                  color={MINT}
                />
                <StatCard
                  label="内存使用率"
                  value={latest.mem_total > 0 ? `${((latest.mem_used / latest.mem_total) * 100).toFixed(1)}%` : "—"}
                  sub={`${fmtBytes(latest.mem_used)} / ${fmtBytes(latest.mem_total)}`}
                  color="#8b5cf6"
                />
                <StatCard
                  label="负载 1/5/15"
                  value={`${latest.load1.toFixed(2)}`}
                  sub={`${latest.load5.toFixed(2)} · ${latest.load15.toFixed(2)}`}
                  color="#ec4899"
                />
                <StatCard
                  label="TCP 连接"
                  value={latest.tcp_connections != null ? String(latest.tcp_connections) : "—"}
                  color="#f59e0b"
                />
              </div>
            )}

            {/* ── 三网当前延迟 ── */}
            {node && (node.latency_cu_ms != null || node.latency_cm_ms != null || node.latency_ct_ms != null) && (
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: "上海联通", ms: node.latency_cu_ms, jitter: node.latency_cu_jitter, loss: node.latency_cu_loss, color: "#8b5cf6" },
                  { label: "上海移动", ms: node.latency_cm_ms, jitter: node.latency_cm_jitter, loss: node.latency_cm_loss, color: "#ec4899" },
                  { label: "上海电信", ms: node.latency_ct_ms, jitter: node.latency_ct_jitter, loss: node.latency_ct_loss, color: "#f59e0b" },
                ].map(({ label, ms, jitter, loss, color }) => {
                  const parts: string[] = [];
                  if (jitter != null && jitter > 0) parts.push(`±${jitter.toFixed(0)}ms 抖动`);
                  if (loss != null && loss > 0) parts.push(`${loss.toFixed(0)}% 丢包`);
                  return (
                    <StatCard
                      key={label}
                      label={label}
                      value={fmtLatency(ms)}
                      sub={parts.length > 0 ? parts.join(" · ") : undefined}
                      color={color}
                    />
                  );
                })}
              </div>
            )}

            {/* ── 图表区 ── */}
            {metrics.length === 0 ? (
              <div className={`${CARD} p-12 text-center text-sm text-slate-400`}>暂无数据</div>
            ) : (
              <div className="space-y-5">
                {/* 时间范围选择器（扁平浅绿） */}
                <div className="flex items-center gap-2">
                  {RANGES.map(({ label, hours }) => (
                    <button
                      key={label}
                      onClick={() => setRange(hours as RangeHours)}
                      className="px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-150"
                      style={
                        range === hours
                          ? { background: MINT, color: "#fff", borderColor: MINT }
                          : { background: "rgba(255,255,255,0.7)", color: "#475569", borderColor: "#d1fae5" }
                      }
                    >
                      {label}
                    </button>
                  ))}
                  {chartLoading && (
                    <span className="text-xs text-slate-400 animate-pulse ml-2">加载中…</span>
                  )}
                  {range === 1 && (
                    <span className="text-xs text-sky-600 ml-auto font-semibold">● 实时</span>
                  )}
                </div>

                {/* 图表网格 */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* CPU 使用率 —— 橙(CPU%, 左轴) + 负载(红, 右轴)双 Y 轴 */}
                  <ChartCard
                    title="CPU 使用率"
                    sub={`${metrics.length} 个数据点`}
                    dotColor="#f59e0b"
                    axisLabel="左 CPU %　·　右 负载"
                  >
                    <ChartContainer
                      config={{ cpu: { label: "CPU" }, load1: { label: "负载" } } satisfies ChartConfig}
                      className="w-full"
                    >
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <AreaGradient id="gradCpu" color="#f59e0b" />
                        </defs>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                        <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                        <YAxis
                          yAxisId="left"
                          domain={[0, 100]}
                          tickFormatter={(v) => `${v}%`}
                          tick={AXIS_TICK}
                          axisLine={false}
                          tickLine={false}
                          width={44}
                        />
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          domain={[0, "auto"]}
                          tick={AXIS_TICK}
                          axisLine={false}
                          tickLine={false}
                          width={36}
                        />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Area
                          yAxisId="left"
                          type="monotone"
                          dataKey="cpu"
                          stroke="#f59e0b"
                          fill="url(#gradCpu)"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="load1"
                          stroke="#ef4444"
                          dot={false}
                          strokeWidth={1.5}
                        />
                      </AreaChart>
                    </ChartContainer>
                  </ChartCard>

                  {/* 内存使用率 —— 粉红(内存) / 紫(交换) */}
                  <ChartCard title="内存使用率" sub="内存 / 交换" dotColor="#ec4899" axisLabel="内存 %">
                    <ChartContainer
                      config={{ memPct: { label: "内存" }, swapPct: { label: "交换" } } satisfies ChartConfig}
                      className="w-full"
                    >
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <AreaGradient id="gradMem" color="#ec4899" />
                          <AreaGradient id="gradSwap" color="#8b5cf6" />
                        </defs>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                        <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
                        <ChartTooltip
                          content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? `${v}%` : String(v)]} />}
                        />
                        <Area type="monotone" dataKey="memPct" stroke="#ec4899" fill="url(#gradMem)" dot={false} strokeWidth={2} />
                        <Area type="monotone" dataKey="swapPct" stroke="#8b5cf6" fill="url(#gradSwap)" dot={false} strokeWidth={2} />
                      </AreaChart>
                    </ChartContainer>
                  </ChartCard>

                  {/* 系统负载 —— 紫色系 */}
                  <ChartCard title="系统负载" sub="1m / 5m / 15m" dotColor="#8b5cf6" axisLabel="负载">
                    <ChartContainer
                      config={{ load1: { label: "1m" }, load5: { label: "5m" }, load15: { label: "15m" } } satisfies ChartConfig}
                      className="w-full"
                    >
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <AreaGradient id="gradLoad1" color="#8b5cf6" />
                          <AreaGradient id="gradLoad5" color="#a855f7" />
                          <AreaGradient id="gradLoad15" color="#c084fc" />
                        </defs>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                        <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Area type="monotone" dataKey="load1" stroke="#8b5cf6" fill="url(#gradLoad1)" dot={false} strokeWidth={2} />
                        <Area type="monotone" dataKey="load5" stroke="#a855f7" fill="url(#gradLoad5)" dot={false} strokeWidth={2} />
                        <Area type="monotone" dataKey="load15" stroke="#c084fc" fill="url(#gradLoad15)" dot={false} strokeWidth={2} />
                      </AreaChart>
                    </ChartContainer>
                  </ChartCard>

                  {/* 三网延迟趋势 —— 联通紫 / 移动粉 / 电信橙 */}
                  {hasLatencyHistory && (
                    <ChartCard
                      title="三网延迟趋势"
                      sub="联通 / 移动 / 电信"
                      dotColor="#8b5cf6"
                      axisLabel="延迟 ms"
                      action={
                        <button
                          onClick={() => setSmoothLatency((v) => !v)}
                          className="text-xs px-2.5 py-0.5 rounded-full border font-medium transition-colors"
                          style={
                            smoothLatency
                              ? { background: MINT, color: "#fff", borderColor: MINT }
                              : { background: "transparent", color: "#0ea5e9", borderColor: "#bae6fd" }
                          }
                        >
                          平滑
                        </button>
                      }
                    >
                      <ChartContainer
                        config={{ cu: { label: "联通" }, cm: { label: "移动" }, ct: { label: "电信" } } satisfies ChartConfig}
                        className="w-full"
                      >
                        <AreaChart data={latencyChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                          <defs>
                            <AreaGradient id="gradCu" color="#8b5cf6" />
                            <AreaGradient id="gradCm" color="#ec4899" />
                            <AreaGradient id="gradCt" color="#f59e0b" />
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                          <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => `${v}ms`} domain={["auto", "auto"]} />
                          <ChartTooltip
                            content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? `${v} ms` : String(v)]} />}
                          />
                          <Area type="monotone" dataKey="cu" stroke="#8b5cf6" fill="url(#gradCu)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="cm" stroke="#ec4899" fill="url(#gradCm)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="ct" stroke="#f59e0b" fill="url(#gradCt)" dot={false} strokeWidth={2} connectNulls={false} />
                        </AreaChart>
                      </ChartContainer>
                    </ChartCard>
                  )}

                  {/* 三网丢包趋势 —— 联通紫 / 移动粉 / 电信橙 */}
                  {hasLossHistory && (
                    <ChartCard
                      title="三网丢包趋势"
                      sub="联通 / 移动 / 电信"
                      dotColor="#8b5cf6"
                      axisLabel="丢包 %"
                    >
                      <ChartContainer
                        config={{ cuLoss: { label: "联通" }, cmLoss: { label: "移动" }, ctLoss: { label: "电信" } } satisfies ChartConfig}
                        className="w-full"
                      >
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                          <defs>
                            <AreaGradient id="gradCuLoss" color="#8b5cf6" />
                            <AreaGradient id="gradCmLoss" color="#ec4899" />
                            <AreaGradient id="gradCtLoss" color="#f59e0b" />
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                          <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => `${v}%`} domain={[0, "auto"]} />
                          <ChartTooltip
                            content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? `${v}%` : String(v)]} />}
                          />
                          <Area type="monotone" dataKey="cuLoss" stroke="#8b5cf6" fill="url(#gradCuLoss)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="cmLoss" stroke="#ec4899" fill="url(#gradCmLoss)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="ctLoss" stroke="#f59e0b" fill="url(#gradCtLoss)" dot={false} strokeWidth={2} connectNulls={false} />
                        </AreaChart>
                      </ChartContainer>
                    </ChartCard>
                  )}

                  {/* 三网抖动趋势 —— 联通紫 / 移动粉 / 电信橙 */}
                  {hasJitterHistory && (
                    <ChartCard
                      title="三网抖动趋势"
                      sub="联通 / 移动 / 电信"
                      dotColor="#8b5cf6"
                      axisLabel="抖动 ms"
                    >
                      <ChartContainer
                        config={{ cuJitter: { label: "联通" }, cmJitter: { label: "移动" }, ctJitter: { label: "电信" } } satisfies ChartConfig}
                        className="w-full"
                      >
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                          <defs>
                            <AreaGradient id="gradCuJitter" color="#8b5cf6" />
                            <AreaGradient id="gradCmJitter" color="#ec4899" />
                            <AreaGradient id="gradCtJitter" color="#f59e0b" />
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                          <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => `${v}ms`} domain={[0, "auto"]} />
                          <ChartTooltip
                            content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? `${v} ms` : String(v)]} />}
                          />
                          <Area type="monotone" dataKey="cuJitter" stroke="#8b5cf6" fill="url(#gradCuJitter)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="cmJitter" stroke="#ec4899" fill="url(#gradCmJitter)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="ctJitter" stroke="#f59e0b" fill="url(#gradCtJitter)" dot={false} strokeWidth={2} connectNulls={false} />
                        </AreaChart>
                      </ChartContainer>
                    </ChartCard>
                  )}

                  {/* 网络带宽趋势 —— 下行青绿 / 上行靛蓝 */}
                  {hasBandwidthHistory && (
                    <ChartCard title="网络带宽" sub="MB/s" dotColor="#0ea5e9" axisLabel="速度 MB/s">
                      <ChartContainer
                        config={{ rxMbps: { label: "下行" }, txMbps: { label: "上行" } } satisfies ChartConfig}
                        className="w-full"
                      >
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                          <defs>
                            <AreaGradient id="gradRx" color="#0ea5e9" />
                            <AreaGradient id="gradTx" color="#6366f1" />
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                          <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => `${v} MB/s`} domain={["auto", "auto"]} />
                          <ChartTooltip content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? `${v} MB/s` : String(v)]} />} />
                          <Area type="monotone" dataKey="rxMbps" stroke="#0ea5e9" fill="url(#gradRx)" dot={false} strokeWidth={2} connectNulls={false} />
                          <Area type="monotone" dataKey="txMbps" stroke="#6366f1" fill="url(#gradTx)" dot={false} strokeWidth={2} connectNulls={false} />
                        </AreaChart>
                      </ChartContainer>
                    </ChartCard>
                  )}

                  {/* TCP 连接数 —— 青色 */}
                  {hasTcpHistory && (
                    <ChartCard title="TCP 连接数" sub="活动连接" dotColor="#06b6d4" axisLabel="连接数">
                      <ChartContainer config={{ tcp: { label: "连接" } } satisfies ChartConfig} className="w-full">
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                          <defs>
                            <AreaGradient id="gradTcp" color="#06b6d4" />
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
                          <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} domain={["auto", "auto"]} allowDecimals={false} />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Area type="monotone" dataKey="tcp" stroke="#06b6d4" fill="url(#gradTcp)" dot={false} strokeWidth={2} connectNulls={false} />
                        </AreaChart>
                      </ChartContainer>
                    </ChartCard>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
