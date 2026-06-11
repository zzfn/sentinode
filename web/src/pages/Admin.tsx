import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AdminNode, AdminStats, AgentToken, SERVER_URL,
  createToken, deleteToken, fetchAdminNodes, fetchAdminStats, fetchNodes, fetchTokens,
  toCNY, toggleLatencyTest, updateNodeMeta,
} from "../api";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "../components/ui/chart";

const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/zzfn/sentinode/main/scripts/install.sh";

function buildScript(serverUrl: string, token: string): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- \\
  --server ${serverUrl} \\
  --token ${token}`;
}

const CURRENCIES = ["CNY", "USD", "EUR", "HKD"];

type NavItem = "nodes" | "tokens" | "db";

// ── 节点信息编辑弹窗 ──────────────────────────────────────────────────────────

function EditNodeDialog({
  node, onClose, onSaved,
}: {
  node: AdminNode | null;
  onClose: () => void;
  onSaved: (updated: Partial<AdminNode>) => void;
}) {
  const [expiresAt, setExpiresAt] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cnyPreview, setCnyPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!node) return;
    setExpiresAt(node.expires_at ? node.expires_at.slice(0, 10) : "");
    setPrice(node.price != null ? String(node.price) : "");
    setCurrency(node.price_currency ?? "CNY");
    setWebsiteUrl(node.website_url ?? "");
    setError(null);
    setCnyPreview(null);
  }, [node]);

  useEffect(() => {
    const val = parseFloat(price);
    if (!price || isNaN(val)) { setCnyPreview(null); return; }
    if (currency === "CNY") { setCnyPreview(null); return; }
    let cancelled = false;
    toCNY(val, currency).then((cny) => {
      if (!cancelled && cny != null) setCnyPreview(`≈ ¥${cny.toFixed(2)}`);
    });
    return () => { cancelled = true; };
  }, [price, currency]);

  async function handleSave() {
    if (!node) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        price: price ? parseFloat(price) : null,
        price_currency: price ? currency : null,
        website_url: websiteUrl.trim() || null,
      };
      await updateNodeMeta(node.id, payload);
      onSaved({ ...payload, expires_at: payload.expires_at });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!node) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <Card className="relative z-10 w-full max-w-sm shadow-xl">
        <CardHeader>
          <CardTitle>编辑节点</CardTitle>
          <CardDescription>{node.hostname}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="space-y-1.5">
            <Label>官网地址</Label>
            <Input type="url" placeholder="https://example.com" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>到期时间</Label>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>月费</Label>
            <div className="flex gap-2">
              <Input type="number" step="0.01" min="0" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} className="flex-1" />
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {cnyPreview && <p className="text-xs text-[var(--color-muted-foreground)]">{cnyPreview} / 月</p>}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── 添加 Agent 弹窗 ───────────────────────────────────────────────────────────

type DialogStep = "name" | "script" | "success";

function AddAgentDialog({
  open, onClose, serverUrl, onTokenCreated,
}: {
  open: boolean;
  onClose: () => void;
  serverUrl: string;
  onTokenCreated: (tok: AgentToken) => void;
}) {
  const [step, setStep] = useState<DialogStep>("name");
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [connectedHostname, setConnectedHostname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const existingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    setStep("name"); setName(""); setScript(""); setConnectedHostname("");
    setError(null); setCreating(false); setCopied(false);
    fetchNodes().then((nodes) => { existingIdsRef.current = new Set(nodes.map((n) => n.id)); }).catch(() => {});
  }, [open]);

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null); setCreating(true);
    try {
      const tok = await createToken(trimmed);
      onTokenCreated(tok);
      setScript(buildScript(serverUrl, tok.token));
      setStep("script");
      pollRef.current = setInterval(async () => {
        try {
          const nodes = await fetchNodes();
          const newNode = nodes.find((n) => !existingIdsRef.current.has(n.id));
          if (newNode) {
            clearInterval(pollRef.current!); pollRef.current = null;
            setConnectedHostname(newNode.hostname); setStep("success");
          }
        } catch {}
      }, 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { setError("复制失败，请手动选中复制"); }
  }

  function handleClose() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <Card className="relative z-10 w-full max-w-lg shadow-xl">
        {step === "name" && (
          <>
            <CardHeader>
              <CardTitle>添加 Agent</CardTitle>
              <CardDescription>为新节点创建认证 Token</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
              <Input autoFocus placeholder="Agent 名称（如：my-server-01）" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={handleClose}>取消</Button>
                <Button onClick={handleCreate} disabled={creating || !name.trim()}>{creating ? "生成中…" : "下一步"}</Button>
              </div>
            </CardContent>
          </>
        )}
        {step === "script" && (
          <>
            <CardHeader>
              <CardTitle>安装 Agent</CardTitle>
              <CardDescription>在目标服务器上运行以下命令</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
              <div className="relative">
                <pre className="bg-[#1e1e1e] text-[#d4d4d4] rounded-lg p-4 pr-20 overflow-x-auto text-xs leading-relaxed whitespace-pre font-mono">{script}</pre>
                <Button variant={copied ? "secondary" : "outline"} size="sm" className="absolute top-2 right-2" onClick={handleCopy}>{copied ? "已复制" : "复制"}</Button>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin flex-shrink-0" />
                等待 Agent 连接中…
              </div>
              <div className="flex justify-end"><Button variant="outline" size="sm" onClick={handleClose}>关闭</Button></div>
            </CardContent>
          </>
        )}
        {step === "success" && (
          <>
            <CardHeader><CardTitle>连接成功</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col items-center py-6 gap-3">
                <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <svg className="w-7 h-7 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  节点 <span className="font-semibold text-foreground">{connectedHostname}</span> 已成功连接
                </p>
              </div>
              <div className="flex justify-end"><Button onClick={handleClose}>完成</Button></div>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

// ── 数据库统计视图 ─────────────────────────────────────────────────────────────

function DbStatsView() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminStats()
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-[var(--color-muted-foreground)] py-8 text-center">加载中…</p>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!stats) return null;

  const avg7 = stats.daily_metrics.length >= 7
    ? Math.round(stats.daily_metrics.slice(-7).reduce((s, d) => s + d.count, 0) / 7)
    : null;

  // 预估：1GB = 约多少条 metrics（metrics 行约 100 字节）
  const rowsPerGB = 1024 * 1024 * 1024 / 100;
  const daysTo1GB = avg7 && avg7 > 0
    ? Math.round(rowsPerGB / avg7)
    : null;

  return (
    <div className="space-y-6">
      {/* 总览卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription>数据库总大小</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold">{stats.db_size_pretty}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>节点数</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold">{stats.nodes_count.toLocaleString()}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>metrics 行数</CardDescription></CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{stats.metrics_count.toLocaleString()}</p>
            <p className="text-xs text-[var(--color-muted-foreground)] mt-1">近似值</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Token 数</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold">{stats.tokens_count.toLocaleString()}</p></CardContent>
        </Card>
      </div>

      {/* 每日增长图 */}
      <Card>
        <CardHeader>
          <CardTitle>每日 metrics 增长</CardTitle>
          <CardDescription>最近 14 天</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.daily_metrics.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)] py-8 text-center">暂无数据</p>
          ) : (
            <ChartContainer
              config={{ count: { label: "新增条数", color: "hsl(var(--chart-1))" } }}
              height={220} className="w-full"
            >
              <BarChart data={stats.daily_metrics} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.5} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={50} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                <ChartTooltip content={<ChartTooltipContent formatter={(v: number) => [v.toLocaleString()]} />} />
                <Bar dataKey="count" fill="url(#barGrad)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* 增长预估 */}
      {avg7 != null && (
        <Card>
          <CardHeader>
            <CardTitle>增长速率与预估</CardTitle>
            <CardDescription>基于最近 7 天均值</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-[var(--color-muted-foreground)]">日均新增</p>
                <p className="text-xl font-semibold mt-1">{avg7.toLocaleString()} 条</p>
              </div>
              <div>
                <p className="text-sm text-[var(--color-muted-foreground)]">日均数据量</p>
                <p className="text-xl font-semibold mt-1">≈ {(avg7 * 100 / 1024 / 1024).toFixed(1)} MB</p>
              </div>
              {daysTo1GB != null && (
                <div>
                  <p className="text-sm text-[var(--color-muted-foreground)]">再增 1 GB 约需</p>
                  <p className="text-xl font-semibold mt-1">{daysTo1GB} 天</p>
                </div>
              )}
              <div>
                <p className="text-sm text-[var(--color-muted-foreground)]">30 天预计增量</p>
                <p className="text-xl font-semibold mt-1">≈ {(avg7 * 30 * 100 / 1024 / 1024).toFixed(0)} MB</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export default function Admin() {
  const serverUrl = SERVER_URL;
  const [nav, setNav] = useState<NavItem>("nodes");
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editNode, setEditNode] = useState<AdminNode | null>(null);
  const [nodeCnyPrices, setNodeCnyPrices] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchTokens().catch(() => [] as AgentToken[]),
      fetchAdminNodes().catch(() => [] as AdminNode[]),
    ]).then(([toks, ns]) => {
      setTokens(toks);
      setNodes(ns);
      ns.forEach((n) => {
        if (n.price == null || !n.price_currency) return;
        toCNY(n.price, n.price_currency).then((cny) =>
          setNodeCnyPrices((prev) => ({ ...prev, [n.id]: cny }))
        );
      });
    });
  }, []);

  function handleTokenCreated(tok: AgentToken) {
    setTokens((prev) => [tok, ...prev]);
  }

  function handleNodeSaved(id: string, updated: Partial<AdminNode>) {
    setNodes((prev) => prev.map((n) => n.id === id ? { ...n, ...updated } : n));
    const node = nodes.find((n) => n.id === id);
    const price = updated.price ?? node?.price;
    const currency = updated.price_currency ?? node?.price_currency;
    if (price != null && currency) {
      toCNY(price, currency).then((cny) =>
        setNodeCnyPrices((prev) => ({ ...prev, [id]: cny }))
      );
    } else {
      setNodeCnyPrices((prev) => ({ ...prev, [id]: null }));
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const NAV_ITEMS: { key: NavItem; label: string; icon: React.ReactNode }[] = [
    {
      key: "nodes",
      label: "节点管理",
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      ),
    },
    {
      key: "tokens",
      label: "Token 管理",
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
      ),
    },
    {
      key: "db",
      label: "数据库统计",
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7c0-1.657 3.582-3 8-3s8 1.343 8 3M4 7v10c0 1.657 3.582 3 8 3s8-1.343 8-3V7M4 12c0 1.657 3.582 3 8 3s8-1.343 8-3" />
        </svg>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-[var(--color-background)] flex flex-col">
      {/* 顶部 Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-card)] flex-shrink-0">
        <div className="px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors">
              ← 返回首页
            </Link>
            <span className="text-[var(--color-border)]">|</span>
            <h1 className="text-base font-semibold">管理后台</h1>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)}>+ 添加 Agent</Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧导航 */}
        <nav className="w-48 flex-shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)] py-4">
          <ul className="space-y-0.5 px-2">
            {NAV_ITEMS.map((item) => (
              <li key={item.key}>
                <button
                  onClick={() => setNav(item.key)}
                  className={[
                    "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors text-left",
                    nav === item.key
                      ? "bg-[var(--color-primary)] text-white font-medium"
                      : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-border)]/30 hover:text-[var(--color-foreground)]",
                  ].join(" ")}
                >
                  {item.icon}
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* 内容区 */}
        <main className="flex-1 overflow-auto p-6">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* 节点管理 */}
          {nav === "nodes" && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>节点详情</CardTitle>
                  <CardDescription>共 {nodes.length} 个节点</CardDescription>
                </CardHeader>
                <CardContent>
                  {nodes.length === 0 ? (
                    <p className="text-sm text-[var(--color-muted-foreground)] py-8 text-center">暂无节点</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>主机名</TableHead>
                          <TableHead>IP</TableHead>
                          <TableHead>到期时间</TableHead>
                          <TableHead>月费</TableHead>
                          <TableHead className="w-20">三网测速</TableHead>
                          <TableHead className="w-16">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {nodes.map((n) => {
                          const cny = nodeCnyPrices[n.id];
                          const daysLeft = n.expires_at
                            ? Math.ceil((new Date(n.expires_at).getTime() - Date.now()) / 86_400_000)
                            : null;
                          return (
                            <TableRow key={n.id}>
                              <TableCell className="font-medium">{n.hostname}</TableCell>
                              <TableCell>
                                <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{n.ip}</code>
                              </TableCell>
                              <TableCell className="text-sm">
                                {n.expires_at ? (
                                  <span className={daysLeft != null && daysLeft <= 7 ? "text-destructive font-medium" : daysLeft != null && daysLeft <= 30 ? "text-[var(--color-warning)] font-medium" : ""}>
                                    {new Date(n.expires_at).toLocaleDateString("zh-CN")}
                                    {daysLeft != null && <span className="ml-1 text-xs text-muted-foreground">({daysLeft < 0 ? "已过期" : `${daysLeft}天`})</span>}
                                  </span>
                                ) : <span className="text-muted-foreground">—</span>}
                              </TableCell>
                              <TableCell className="text-sm">
                                {n.price != null ? (
                                  <span>
                                    {n.price} {n.price_currency}
                                    {cny != null && n.price_currency !== "CNY" && (
                                      <span className="ml-1 text-xs text-muted-foreground">≈ ¥{cny.toFixed(0)}</span>
                                    )}
                                  </span>
                                ) : <span className="text-muted-foreground">—</span>}
                              </TableCell>
                              <TableCell>
                                <Switch
                                  checked={n.latency_test_enabled}
                                  onCheckedChange={(checked) => {
                                    setNodes((prev) => prev.map((x) => x.id === n.id ? { ...x, latency_test_enabled: checked } : x));
                                    toggleLatencyTest(n.id, checked).catch(() =>
                                      setNodes((prev) => prev.map((x) => x.id === n.id ? { ...x, latency_test_enabled: !checked } : x))
                                    );
                                  }}
                                />
                              </TableCell>
                              <TableCell>
                                <Button variant="outline" size="sm" onClick={() => setEditNode(n)}>编辑</Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Token 管理 */}
          {nav === "tokens" && (
            <Card>
              <CardHeader>
                <CardTitle>已注册 Agent</CardTitle>
                <CardDescription>共 {tokens.length} 个 Agent Token</CardDescription>
              </CardHeader>
              <CardContent>
                {tokens.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">暂无已注册的 Agent，点击右上角添加</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>Token</TableHead>
                        <TableHead>注册时间</TableHead>
                        <TableHead className="w-20">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tokens.map((tok) => (
                        <TableRow key={tok.id}>
                          <TableCell className="font-medium">{tok.name}</TableCell>
                          <TableCell>
                            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded break-all">{tok.token}</code>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                            {new Date(tok.created_at).toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell>
                            <Button variant="destructive" size="sm" onClick={() => handleDelete(tok.id)}>删除</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {/* 数据库统计 */}
          {nav === "db" && <DbStatsView />}
        </main>
      </div>

      <AddAgentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        serverUrl={serverUrl}
        onTokenCreated={handleTokenCreated}
      />

      <EditNodeDialog
        node={editNode}
        onClose={() => setEditNode(null)}
        onSaved={(updated) => editNode && handleNodeSaved(editNode.id, updated)}
      />
    </div>
  );
}
