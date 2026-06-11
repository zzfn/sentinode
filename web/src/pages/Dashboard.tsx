import { useEffect, useState } from "react";
import { Link } from "wouter";
import { subscribeNodes, type Node } from "../api";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
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

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}


export default function Dashboard() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // SSE 连接后 server 先推送全量快照，再推送增量更新
    const unsub = subscribeNodes((updated) => {
      if (cancelled) return;
      setNodes((prev) => {
        const idx = prev.findIndex((n) => n.id === updated.id);
        if (idx === -1) return [...prev, updated];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[var(--color-background)]">
      {/* 顶部 Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-card)]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div>
            <span className="text-base font-bold">Sentinode</span>
            <span className="ml-2 text-sm text-[var(--color-muted-foreground)]">
              服务器监控
            </span>
          </div>
          <Link href="/app">
            <Button variant="outline" size="sm">
              管理后台
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-[var(--color-muted-foreground)]">加载中…</p>
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>错误：{error}</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>节点列表</CardTitle>
              <CardDescription>
                共 {nodes.length} 个节点，实时更新
              </CardDescription>
            </CardHeader>
            <CardContent>
              {nodes.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)] py-8 text-center">
                  暂无节点，请先运行 Agent
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">状态</TableHead>
                      <TableHead>主机名</TableHead>
                      <TableHead className="text-center">上海联通</TableHead>
                      <TableHead className="text-center">上海移动</TableHead>
                      <TableHead className="text-center">上海电信</TableHead>
                      <TableHead>系统</TableHead>
                      <TableHead>最后上报</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nodes.map((n) => {
                      const online = isOnline(n.last_seen);
                      return (
                        <TableRow key={n.id}>
                          <TableCell>
                            <Badge variant={online ? "success" : "destructive"}>
                              {online ? "在线" : "离线"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <Link
                                href={`/nodes/${n.id}`}
                                className="font-medium text-[var(--color-primary)] hover:underline"
                              >
                                {n.hostname}
                              </Link>
                              {n.website_url && (
                                <a
                                  href={n.website_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
                                  title="官网"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                  </svg>
                                </a>
                              )}
                            </div>
                          </TableCell>
                          {[n.latency_cu_ms, n.latency_cm_ms, n.latency_ct_ms].map((ms, i) => (
                            <TableCell key={i} className="text-center tabular-nums text-sm">
                              {ms == null ? (
                                <span className="text-[var(--color-muted-foreground)]">—</span>
                              ) : ms < 0 ? (
                                <span className="text-[var(--color-destructive)]">超时</span>
                              ) : (
                                <span className={ms < 80 ? "text-[var(--color-success)]" : ms < 150 ? "text-[var(--color-warning)]" : "text-[var(--color-destructive)]"}>
                                  {ms.toFixed(0)}ms
                                </span>
                              )}
                            </TableCell>
                          ))}
                          <TableCell className="text-sm">
                            <div>{n.os}</div>
                            {n.cpu_model && <div className="text-xs text-[var(--color-muted-foreground)] truncate max-w-[180px]">{n.cpu_model}</div>}
                          </TableCell>
                          <TableCell className="text-xs text-[var(--color-muted-foreground)] whitespace-nowrap">
                            {new Date(n.last_seen).toLocaleString("zh-CN")}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
