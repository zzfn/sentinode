import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
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

const RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
] as const;
type RangeHours = 1 | 6 | 24 | 168;

// 循环使用的强调色
const ACCENTS = [
  { bg: "#8B5CF6", fg: "#fff" },  // violet
  { bg: "#F472B6", fg: "#fff" },  // pink
  { bg: "#FBBF24", fg: "#1E293B" }, // amber
  { bg: "#34D399", fg: "#1E293B" }, // emerald
  { bg: "#8B5CF6", fg: "#fff" },
  { bg: "#F472B6", fg: "#fff" },
];

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: { bg: string; fg: string };
}) {
  return (
    <div
      className="bg-white rounded-2xl border-2 border-[var(--color-ink)] p-4
        shadow-[3px_3px_0_0_#1E293B] flex flex-col gap-1"
    >
      <div className="flex items-center gap-1.5">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: accent.bg }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted-foreground)]">
          {label}
        </span>
      </div>
      <p
        className="text-2xl font-bold text-[var(--color-ink)] leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs text-[var(--color-muted-foreground)] leading-snug truncate">
          {sub}
        </p>
      )}
    </div>
  );
}

function ChartCard({
  title,
  sub,
  accent,
  action,
  children,
}: {
  title: string;
  sub?: string;
  accent: { bg: string; fg: string };
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border-2 border-[var(--color-ink)] overflow-hidden shadow-[4px_4px_0_0_#1E293B]">
      <div
        className="px-5 py-3 border-b-2 border-[var(--color-ink)] flex items-center gap-2"
        style={{ background: accent.bg }}
      >
        <h3
          className="font-bold text-sm leading-none"
          style={{ color: accent.fg, fontFamily: "var(--font-display)" }}
        >
          {title}
        </h3>
        {sub && (
          <span className="text-xs opacity-70" style={{ color: accent.fg }}>
            {sub}
          </span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

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

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
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
        rxMbps: m.net_rx_rate != null && m.net_rx_rate > 0 ? parseFloat((m.net_rx_rate / 1024 / 1024).toFixed(2)) : null,
        txMbps: m.net_tx_rate != null && m.net_tx_rate > 0 ? parseFloat((m.net_tx_rate / 1024 / 1024).toFixed(2)) : null,
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

  const hasBandwidthHistory = useMemo(
    () => chartData.some((d) => d.rxMbps != null || d.txMbps != null),
    [chartData],
  );

  const online = node ? isOnline(node.last_seen) : false;
  const hasCurrentLatency =
    node &&
    (node.latency_cu_ms != null ||
      node.latency_cm_ms != null ||
      node.latency_ct_ms != null);

  return (
    <div className="min-h-screen" style={{ background: "var(--color-cream)" }}>
      {/* ── Header ── */}
      <header className="relative overflow-hidden border-b-2 border-[var(--color-ink)] bg-white">
        {/* 装饰 */}
        <div
          className="absolute -top-6 -right-6 w-32 h-32 rounded-full opacity-10 pointer-events-none"
          style={{ background: "var(--color-violet)" }}
        />
        <div
          className="absolute top-2 right-24 w-5 h-5 rounded-full opacity-30 pointer-events-none"
          style={{ background: "var(--color-emerald)" }}
        />

        <div className="relative max-w-5xl mx-auto px-5 py-4 flex items-center gap-3">
          {/* 返回按钮 */}
          <Link
            href="/"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold
              border-2 border-[var(--color-ink)] bg-white text-[var(--color-ink)]
              shadow-[2px_2px_0_0_#1E293B]
              hover:bg-[var(--color-amber)] hover:shadow-[3px_3px_0_0_#1E293B] hover:-translate-x-px hover:-translate-y-px
              transition-all duration-150 flex-shrink-0"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="w-3 h-3"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10 3L5 8l5 5"
              />
            </svg>
            返回
          </Link>

          <span
            className="w-px h-5 flex-shrink-0"
            style={{ background: "var(--color-border)" }}
          />

          {/* 主机名 + 状态 */}
          <div className="flex items-center gap-2 min-w-0">
            {node && (
              <>
                {online ? (
                  <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                    <span
                      className="absolute inline-flex h-full w-full rounded-full opacity-75"
                      style={{
                        background: "var(--color-emerald)",
                        animation:
                          "ping-slow 1.4s cubic-bezier(0,0,0.2,1) infinite",
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
              </>
            )}
            {node?.country_code && (
              <img src={countryFlagUrl(node.country_code)!} alt={node.country_code} className="w-5 h-[15px] rounded-sm flex-shrink-0" />
            )}
            <h1
              className="text-base font-bold text-[var(--color-ink)] truncate"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {node?.name || node?.hostname || id}
            </h1>
            {node && (
              <span className="hidden sm:block text-xs text-[var(--color-muted-foreground)] truncate">
                {node.os}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 py-7 space-y-6">
        {loading ? (
          /* 骨架 */
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="h-24 rounded-2xl border-2 border-[var(--color-border)] bg-white animate-pulse"
                  style={{ opacity: 1 - i * 0.12 }}
                />
              ))}
            </div>
            <div className="h-56 rounded-2xl border-2 border-[var(--color-border)] bg-white animate-pulse" />
          </div>
        ) : error ? (
          <div
            className="rounded-2xl border-2 border-red-400 bg-red-50 p-5 text-sm text-red-600"
          >
            错误：{error}
          </div>
        ) : (
          <>
            {/* 三网当前延迟 */}
            {hasCurrentLatency && (
              <div className="grid grid-cols-3 gap-4">
                {[
                  {
                    label: "上海联通",
                    ms: node!.latency_cu_ms,
                    jitter: node!.latency_cu_jitter,
                    loss: node!.latency_cu_loss,
                    accent: ACCENTS[0],
                  },
                  {
                    label: "上海移动",
                    ms: node!.latency_cm_ms,
                    jitter: node!.latency_cm_jitter,
                    loss: node!.latency_cm_loss,
                    accent: ACCENTS[1],
                  },
                  {
                    label: "上海电信",
                    ms: node!.latency_ct_ms,
                    jitter: node!.latency_ct_jitter,
                    loss: node!.latency_ct_loss,
                    accent: ACCENTS[2],
                  },
                ].map(({ label, ms, jitter, loss, accent }) => {
                  const parts: string[] = [];
                  if (jitter != null && jitter > 0) parts.push(`±${jitter.toFixed(0)}ms 抖动`);
                  if (loss != null && loss > 0) parts.push(`${loss.toFixed(0)}% 丢包`);
                  if (label === "上海联通" && node!.latency_updated_at)
                    parts.push(`更新 ${new Date(node!.latency_updated_at).toLocaleTimeString("zh-CN")}`);
                  return (
                    <StatCard
                      key={label}
                      label={label}
                      value={fmtLatency(ms)}
                      sub={parts.length > 0 ? parts.join(" · ") : undefined}
                      accent={accent}
                    />
                  );
                })}
              </div>
            )}

            {/* 系统统计 */}
            {latest && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {[
                  {
                    label: "CPU 使用率",
                    value: `${latest.cpu_percent.toFixed(1)}%`,
                    sub: node?.cpu_model ?? undefined,
                  },
                  {
                    label: "内存",
                    value: fmtBytes(latest.mem_used),
                    sub: `共 ${fmtBytes(latest.mem_total)}`,
                  },
                  {
                    label: "交换分区",
                    value: fmtBytes(latest.swap_used),
                    sub: `共 ${fmtBytes(latest.swap_total)}`,
                  },
                  {
                    label: "下行带宽",
                    value: fmtBandwidth(latest.net_rx_rate),
                  },
                  {
                    label: "上行带宽",
                    value: fmtBandwidth(latest.net_tx_rate),
                  },
                  {
                    label: "TCP 连接数",
                    value: latest.tcp_connections != null ? String(latest.tcp_connections) : "—",
                  },
                  {
                    label: "负载 1m",
                    value: latest.load1.toFixed(2),
                  },
                  {
                    label: "负载 5m / 15m",
                    value: `${latest.load5.toFixed(2)} / ${latest.load15.toFixed(2)}`,
                  },
                  {
                    label: "运行时长",
                    value: fmtUptime(latest.uptime_secs),
                  },
                ].map(({ label, value, sub }, i) => (
                  <StatCard
                    key={label}
                    label={label}
                    value={value}
                    sub={sub}
                    accent={ACCENTS[i % ACCENTS.length]}
                  />
                ))}
              </div>
            )}

            {/* 图表 */}
            {metrics.length === 0 ? (
              <div className="rounded-2xl border-2 border-[var(--color-border)] bg-white p-12 text-center text-sm text-[var(--color-muted-foreground)]">
                暂无数据
              </div>
            ) : (
              <div className="space-y-5">
                {/* 时间范围选择器 */}
                <div className="flex items-center gap-2">
                  {RANGES.map(({ label, hours }) => (
                    <button
                      key={label}
                      onClick={() => setRange(hours as RangeHours)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold border-2 border-[var(--color-ink)] transition-all duration-150
                        ${range === hours
                          ? "bg-[var(--color-ink)] text-white shadow-[2px_2px_0_0_#8B5CF6]"
                          : "bg-white text-[var(--color-ink)] shadow-[2px_2px_0_0_#1E293B] hover:bg-[var(--color-cream)]"
                        }`}
                    >
                      {label}
                    </button>
                  ))}
                  {chartLoading && (
                    <span className="text-xs text-[var(--color-muted-foreground)] animate-pulse ml-2">加载中…</span>
                  )}
                  {range === 1 && (
                    <span className="text-xs text-[var(--color-emerald)] ml-auto font-semibold">● 实时</span>
                  )}
                </div>

                {/* CPU */}
                <ChartCard
                  title="CPU 使用率"
                  sub={`${metrics.length} 个数据点`}
                  accent={ACCENTS[0]}
                >
                  <ChartContainer
                    config={{ cpu: { label: "CPU", color: "hsl(var(--chart-1))" } }}
                    className="w-full"
                  >
                    <AreaChart
                      data={chartData}
                      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                    >
                      <defs>
                        <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="5%"
                            stopColor="var(--color-cpu)"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--color-cpu)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="rgba(128,128,128,0.12)"
                      />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 10 }}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        domain={[0, 100]}
                        tickFormatter={(v) => `${v}%`}
                        tick={{ fontSize: 10 }}
                        width={38}
                      />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            formatter={(v) => [typeof v === "number" ? `${v}%` : String(v)]}
                          />
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="cpu"
                        stroke="var(--color-cpu)"
                        fill="url(#cpuGrad)"
                        dot={false}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                </ChartCard>

                {/* 内存 */}
                <ChartCard title="内存使用率" accent={ACCENTS[1]}>
                  <ChartContainer
                    config={{
                      memPct: { label: "内存", color: "hsl(var(--chart-2))" },
                      swapPct: { label: "交换", color: "hsl(var(--chart-3))" },
                    } satisfies ChartConfig}
                    className="w-full"
                  >
                    <AreaChart
                      data={chartData}
                      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="memGrad"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="var(--color-memPct)"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--color-memPct)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                        <linearGradient
                          id="swapGrad"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="var(--color-swapPct)"
                            stopOpacity={0.2}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--color-swapPct)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="rgba(128,128,128,0.12)"
                      />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 10 }}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        domain={[0, 100]}
                        tickFormatter={(v) => `${v}%`}
                        tick={{ fontSize: 10 }}
                        width={38}
                      />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            formatter={(v) => [typeof v === "number" ? `${v}%` : String(v)]}
                          />
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="memPct"
                        stroke="var(--color-memPct)"
                        fill="url(#memGrad)"
                        dot={false}
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        dataKey="swapPct"
                        stroke="var(--color-swapPct)"
                        fill="url(#swapGrad)"
                        dot={false}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                </ChartCard>

                {/* 系统负载 */}
                <ChartCard title="系统负载" accent={ACCENTS[2]}>
                  <ChartContainer
                    config={{
                      load1: { label: "1m", color: "hsl(var(--chart-4))" },
                      load5: { label: "5m", color: "hsl(var(--chart-5))" },
                      load15: { label: "15m", color: "hsl(262 83% 58%)" },
                    } satisfies ChartConfig}
                    className="w-full"
                  >
                    <LineChart
                      data={chartData}
                      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="rgba(128,128,128,0.12)"
                      />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 10 }}
                        interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fontSize: 10 }} width={38} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Line
                        type="monotone"
                        dataKey="load1"
                        stroke="var(--color-load1)"
                        dot={false}
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="load5"
                        stroke="var(--color-load5)"
                        dot={false}
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="load15"
                        stroke="var(--color-load15)"
                        dot={false}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ChartContainer>
                </ChartCard>

                {/* 三网延迟趋势 */}
                {hasLatencyHistory && (
                  <ChartCard
                    title="三网延迟趋势"
                    sub="联通 / 移动 / 电信"
                    accent={ACCENTS[3]}
                    action={
                      <button
                        onClick={() => setSmoothLatency((v) => !v)}
                        className="text-xs px-2 py-0.5 rounded-full border font-medium transition-colors"
                        style={{
                          borderColor: ACCENTS[3].fg,
                          color: smoothLatency ? ACCENTS[3].bg : ACCENTS[3].fg,
                          background: smoothLatency ? ACCENTS[3].fg : "transparent",
                          opacity: 0.9,
                        }}
                      >
                        平滑
                      </button>
                    }
                  >
                    <ChartContainer
                      config={{
                        cu: { label: "联通", color: "hsl(var(--chart-1))" },
                        cm: { label: "移动", color: "hsl(var(--chart-2))" },
                        ct: { label: "电信", color: "hsl(var(--chart-3))" },
                      } satisfies ChartConfig}
                      className="w-full"
                    >
                      <LineChart
                        data={latencyChartData}
                        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="rgba(128,128,128,0.12)"
                        />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 10 }}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          width={42}
                          unit=" ms"
                          domain={[0, "auto"]}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              formatter={(v) => [typeof v === "number" ? `${v} ms` : String(v)]}
                            />
                          }
                        />
                        <Line
                          type="monotone"
                          dataKey="cu"
                          stroke="var(--color-cu)"
                          dot={false}
                          strokeWidth={2}
                          connectNulls={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="cm"
                          stroke="var(--color-cm)"
                          dot={false}
                          strokeWidth={2}
                          connectNulls={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="ct"
                          stroke="var(--color-ct)"
                          dot={false}
                          strokeWidth={2}
                          connectNulls={false}
                        />
                      </LineChart>
                    </ChartContainer>
                  </ChartCard>
                )}

                {/* 网络带宽趋势 */}
                {hasBandwidthHistory && (
                  <ChartCard title="网络带宽" sub="MB/s" accent={ACCENTS[0]}>
                    <ChartContainer
                      config={{
                        rxMbps: { label: "下行", color: "hsl(var(--chart-5))" },
                        txMbps: { label: "上行", color: "hsl(var(--chart-1))" },
                      } satisfies ChartConfig}
                      className="w-full"
                    >
                      <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                        <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10 }} width={46} unit=" MB/s" />
                        <ChartTooltip content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? `${v} MB/s` : String(v)]} />} />
                        <Line type="monotone" dataKey="rxMbps" stroke="var(--color-rxMbps)" dot={false} strokeWidth={2} connectNulls={false} />
                        <Line type="monotone" dataKey="txMbps" stroke="var(--color-txMbps)" dot={false} strokeWidth={2} connectNulls={false} />
                      </LineChart>
                    </ChartContainer>
                  </ChartCard>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
