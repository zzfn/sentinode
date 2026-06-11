import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { fetchMetrics, fmtBytes, fmtUptime, type Metric } from "../api";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

/** 单个统计卡片 */
function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
        {sub && (
          <p className="text-xs text-[var(--color-muted-foreground)] mt-1">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = () =>
      fetchMetrics(id)
        .then((data) => {
          if (!cancelled) setMetrics(data);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  const latest = metrics[0];

  return (
    <div className="min-h-screen bg-[var(--color-background)]">
      {/* 顶部 Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-card)]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            href="/"
            className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
          >
            ← 返回
          </Link>
          <span className="text-[var(--color-border)]">|</span>
          <h1 className="text-base font-semibold">
            {latest ? "节点详情" : id}
          </h1>
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
            {/* 统计卡片区 */}
            {latest && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <StatCard
                  label="CPU 使用率"
                  value={`${latest.cpu_percent.toFixed(1)}%`}
                />
                <StatCard
                  label="内存"
                  value={fmtBytes(latest.mem_used)}
                  sub={`共 ${fmtBytes(latest.mem_total)}`}
                />
                <StatCard
                  label="交换分区"
                  value={fmtBytes(latest.swap_used)}
                  sub={`共 ${fmtBytes(latest.swap_total)}`}
                />
                <StatCard
                  label="负载 1m"
                  value={latest.load1.toFixed(2)}
                />
                <StatCard
                  label="负载 5m / 15m"
                  value={`${latest.load5.toFixed(2)} / ${latest.load15.toFixed(2)}`}
                />
                <StatCard
                  label="运行时长"
                  value={fmtUptime(latest.uptime_secs)}
                />
              </div>
            )}

            {/* 历史记录 */}
            <Card>
              <CardHeader>
                <CardTitle>历史记录</CardTitle>
                <CardDescription>
                  最近 {metrics.length} 条上报数据，每 15 秒自动刷新
                </CardDescription>
              </CardHeader>
              <CardContent>
                {metrics.length === 0 ? (
                  <p className="text-sm text-[var(--color-muted-foreground)] py-8 text-center">
                    暂无数据
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>时间</TableHead>
                        <TableHead>CPU%</TableHead>
                        <TableHead>内存使用</TableHead>
                        <TableHead>负载 1m</TableHead>
                        <TableHead>运行时长</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="text-xs text-[var(--color-muted-foreground)] whitespace-nowrap">
                            {new Date(m.reported_at).toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell>{m.cpu_percent.toFixed(1)}%</TableCell>
                          <TableCell className="text-sm">
                            {fmtBytes(m.mem_used)}{" "}
                            <span className="text-[var(--color-muted-foreground)]">
                              / {fmtBytes(m.mem_total)}
                            </span>
                          </TableCell>
                          <TableCell>{m.load1.toFixed(2)}</TableCell>
                          <TableCell>{fmtUptime(m.uptime_secs)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
