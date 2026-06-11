import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchMetrics,
  fetchNode,
  fmtBytes,
  fmtUptime,
  subscribeNodeDetail,
  type Metric,
  type Node,
} from "../api";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

const MAX_POINTS = 60;

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
        {sub && <p className="text-xs text-[var(--color-muted-foreground)] mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 0) return "超时";
  return `${ms.toFixed(0)} ms`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const [node, setNode] = useState<Node | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    Promise.all([fetchNode(id), fetchMetrics(id)])
      .then(([n, data]) => {
        if (!cancelled) { setNode(n); setMetrics(data); }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // SSE 实时追加，新数据插到数组头部，保持最多 MAX_POINTS 条
    const unsub = subscribeNodeDetail(id, (m) => {
      if (cancelled) return;
      setMetrics((prev) => [m, ...prev].slice(0, MAX_POINTS));
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [id]);

  const latest = metrics[0];

  // 图表数据从旧到新排列（x 轴时间递增）
  const chartData = useMemo(
    () =>
      [...metrics].reverse().map((m) => ({
        time: fmtTime(m.reported_at),
        cpu: parseFloat(m.cpu_percent.toFixed(1)),
        memPct: m.mem_total > 0 ? parseFloat(((m.mem_used / m.mem_total) * 100).toFixed(1)) : 0,
        swapPct: m.swap_total > 0 ? parseFloat(((m.swap_used / m.swap_total) * 100).toFixed(1)) : 0,
        load1: parseFloat(m.load1.toFixed(2)),
        load5: parseFloat(m.load5.toFixed(2)),
        load15: parseFloat(m.load15.toFixed(2)),
      })),
    [metrics],
  );

  return (
    <div className="min-h-screen bg-[var(--color-background)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-card)]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            href="/"
            className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
          >
            ← 返回
          </Link>
          <span className="text-[var(--color-border)]">|</span>
          <h1 className="text-base font-semibold">{node?.hostname ?? id}</h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-[var(--color-muted-foreground)]">加载中…</p>
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>错误：{error}</AlertDescription>
          </Alert>
        ) : (
          <>
            {/* 三网延迟 */}
            {node && (node.latency_cu_ms != null || node.latency_cm_ms != null || node.latency_ct_ms != null) && (
              <div className="grid grid-cols-3 gap-4">
                <StatCard
                  label="上海联通"
                  value={fmtLatency(node.latency_cu_ms)}
                  sub={node.latency_updated_at ? `更新于 ${new Date(node.latency_updated_at).toLocaleTimeString("zh-CN")}` : undefined}
                />
                <StatCard label="上海移动" value={fmtLatency(node.latency_cm_ms)} />
                <StatCard label="上海电信" value={fmtLatency(node.latency_ct_ms)} />
              </div>
            )}

            {/* 统计卡片 */}
            {latest && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <StatCard label="CPU 使用率" value={`${latest.cpu_percent.toFixed(1)}%`} />
                <StatCard label="内存" value={fmtBytes(latest.mem_used)} sub={`共 ${fmtBytes(latest.mem_total)}`} />
                <StatCard label="交换分区" value={fmtBytes(latest.swap_used)} sub={`共 ${fmtBytes(latest.swap_total)}`} />
                <StatCard label="负载 1m" value={latest.load1.toFixed(2)} />
                <StatCard label="负载 5m / 15m" value={`${latest.load5.toFixed(2)} / ${latest.load15.toFixed(2)}`} />
                <StatCard label="运行时长" value={fmtUptime(latest.uptime_secs)} />
              </div>
            )}

            {/* 图表区 */}
            {metrics.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
                  暂无数据
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {/* CPU */}
                <Card>
                  <CardHeader>
                    <CardTitle>CPU 使用率</CardTitle>
                    <CardDescription>最近 {metrics.length} 条，实时更新</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                        <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} width={38} />
                        <Tooltip formatter={(v) => [`${v}%`, "CPU"]} />
                        <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fill="url(#cpuGrad)" dot={false} strokeWidth={1.5} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* 内存 & 交换 */}
                <Card>
                  <CardHeader>
                    <CardTitle>内存使用率</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="swapGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.2} />
                            <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                        <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} width={38} />
                        <Tooltip formatter={(v, name) => [`${v}%`, name === "memPct" ? "内存" : "交换"]} />
                        <Area type="monotone" dataKey="memPct" name="memPct" stroke="#8b5cf6" fill="url(#memGrad)" dot={false} strokeWidth={1.5} />
                        <Area type="monotone" dataKey="swapPct" name="swapPct" stroke="#06b6d4" fill="url(#swapGrad)" dot={false} strokeWidth={1.5} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* 系统负载 */}
                <Card>
                  <CardHeader>
                    <CardTitle>系统负载</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                        <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10 }} width={38} />
                        <Tooltip />
                        <Line type="monotone" dataKey="load1" name="1m" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
                        <Line type="monotone" dataKey="load5" name="5m" stroke="#10b981" dot={false} strokeWidth={1.5} />
                        <Line type="monotone" dataKey="load15" name="15m" stroke="#6366f1" dot={false} strokeWidth={1.5} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
