import { useEffect, useState } from "react";
import { Link } from "wouter";
import { fetchNodes, type Node } from "../api";
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

/** 判断节点是否在线：last_seen 距现在不超过 2 分钟 */
function isOnline(lastSeen: string): boolean {
  const diff = Date.now() - new Date(lastSeen).getTime();
  return diff < 2 * 60 * 1000;
}

export default function Dashboard() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchNodes()
        .then((data) => {
          if (!cancelled) setNodes(data);
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
          <Link href="/admin">
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
                共 {nodes.length} 个节点，每 15 秒自动刷新
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
                      <TableHead>IP</TableHead>
                      <TableHead>系统</TableHead>
                      <TableHead>架构</TableHead>
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
                            <Link
                              href={`/nodes/${n.id}`}
                              className="font-medium text-[var(--color-primary)] hover:underline"
                            >
                              {n.hostname}
                            </Link>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {n.ip}
                          </TableCell>
                          <TableCell className="text-sm">{n.os}</TableCell>
                          <TableCell>
                            <Badge variant="secondary">{n.arch}</Badge>
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
