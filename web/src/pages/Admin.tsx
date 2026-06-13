import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  AdminNode, AdminStats, AgentToken, SERVER_URL, VisitorEntry, VisitorStats,
  adminLogout, countryFlagUrl, createToken, deleteNode, deleteToken,
  fetchAdminNodes, fetchAdminStats, fetchTokens, fetchVisitors,
  reorderNodes, resetNodeGeo, subscribeNodes, toCNY, toggleLatencyTest, triggerUpgrade, updateNodeMeta,
} from "../api";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { relativeTime } from "../utils";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import {
  Bar, BarChart, CartesianGrid, XAxis, YAxis,
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
  --server '${serverUrl}' \\
  --token '${token}'`;
}

const CURRENCIES = ["CNY", "USD", "EUR", "HKD"];
type NavItem = "nodes" | "cost" | "visitors" | "db";

// ── 公共样式常量 ──────────────────────────────────────────────────────────────

const CARD = "bg-white rounded-2xl border-2 border-[var(--color-ink)] shadow-[4px_4px_0_0_#1E293B]";
const DIALOG_CARD = "bg-white rounded-2xl border-2 border-[var(--color-ink)] shadow-[8px_8px_0_0_#1E293B]";

function Btn({
  onClick, disabled, children, variant = "default", className = "",
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "default" | "outline" | "danger" | "ghost";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold border-2 border-[var(--color-ink)] transition-all duration-150 select-none cursor-pointer disabled:opacity-50 disabled:pointer-events-none";
  const variants: Record<string, string> = {
    default:
      "bg-[var(--color-violet)] text-white shadow-[2px_2px_0_0_#1E293B] hover:shadow-[3px_3px_0_0_#1E293B] hover:-translate-x-px hover:-translate-y-px active:shadow-none active:translate-x-0.5 active:translate-y-0.5",
    outline:
      "bg-white text-[var(--color-ink)] shadow-[2px_2px_0_0_#1E293B] hover:bg-[var(--color-cream)] hover:shadow-[3px_3px_0_0_#1E293B] hover:-translate-x-px hover:-translate-y-px active:shadow-none",
    danger:
      "bg-white text-red-500 shadow-[2px_2px_0_0_#1E293B] hover:bg-red-50 hover:shadow-[3px_3px_0_0_#1E293B] hover:-translate-x-px hover:-translate-y-px active:shadow-none",
    ghost:
      "border-transparent bg-transparent text-[var(--color-muted-foreground)] shadow-none hover:bg-[var(--color-cream)] hover:text-[var(--color-ink)]",
  };
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// ── 节点信息编辑弹窗 ──────────────────────────────────────────────────────────

function EditNodeDialog({
  node, onClose, onSaved,
}: {
  node: AdminNode | null;
  onClose: () => void;
  onSaved: (updated: Partial<AdminNode>) => void;
}) {
  const [nodeName, setNodeName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [pricePeriod, setPricePeriod] = useState(1);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [countryCode, setCountryCode] = useState("");
  const [location, setLocation] = useState("");
  const [resettingGeo, setResettingGeo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cnyPreview, setCnyPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!node) return;
    setNodeName(node.name ?? "");
    setExpiresAt(node.expires_at ? node.expires_at.slice(0, 10) : "");
    setPrice(node.price != null ? String(node.price) : "");
    setCurrency(node.price_currency ?? "CNY");
    setPricePeriod(node.price_period_months ?? 1);
    setWebsiteUrl(node.website_url ?? "");
    setCountryCode(node.country_code ?? "");
    setLocation(node.location ?? "");
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
        name: nodeName.trim() || null,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        price: price ? parseFloat(price) : null,
        price_currency: price ? currency : null,
        price_period_months: price ? pricePeriod : null,
        website_url: websiteUrl.trim() || null,
        country_code: countryCode.trim() || null,
        location: location.trim() || null,
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
      <div className="absolute inset-0 bg-[var(--color-ink)]/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative z-10 w-full max-w-sm ${DIALOG_CARD} p-6 space-y-4`}>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[var(--color-amber)] border-2 border-[var(--color-ink)]" />
          <h2 className="text-base font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
            编辑节点
          </h2>
          <span className="ml-auto text-xs text-[var(--color-muted-foreground)] font-mono">{node.name || node.hostname}</span>
        </div>

        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wider">显示名称</Label>
            <Input placeholder={node.hostname} value={nodeName} onChange={(e) => setNodeName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wider">官网地址</Label>
            <Input type="url" placeholder="https://example.com" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wider">地理位置</Label>
              <button
                type="button"
                className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-ink)] underline disabled:opacity-50"
                disabled={resettingGeo}
                onClick={async () => {
                  if (!node) return;
                  setResettingGeo(true);
                  try {
                    await resetNodeGeo(node.id);
                    setCountryCode("");
                    setLocation("");
                  } finally {
                    setResettingGeo(false);
                  }
                }}
              >
                {resettingGeo ? "重置中…" : "重新查询 IP 归属"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="HK / JP / US" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} maxLength={2} className="uppercase" />
              <Input placeholder="香港 / 东京" value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wider">到期时间</Label>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wider">费用</Label>
            <div className="flex gap-2">
              <Input type="number" step="0.01" min="0" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} className="flex-1" />
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={String(pricePeriod)} onValueChange={(v) => setPricePeriod(Number(v))}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 月</SelectItem>
                  <SelectItem value="3">3 月</SelectItem>
                  <SelectItem value="6">6 月</SelectItem>
                  <SelectItem value="12">12 月（年付）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {cnyPreview && <p className="text-xs text-[var(--color-muted-foreground)]">{cnyPreview} {pricePeriod === 1 ? "/ 月" : `/ ${pricePeriod}月`}</p>}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="outline" onClick={onClose}>取消</Btn>
          <Btn onClick={handleSave} disabled={saving}>{saving ? "保存中…" : "保存"}</Btn>
        </div>
      </div>
    </div>
  );
}

// ── 重装 Agent 弹窗 ───────────────────────────────────────────────────────────

function ReinstallDialog({
  node, serverUrl, onClose,
}: {
  node: AdminNode | null;
  serverUrl: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!node) return null;

  const script = node.token ? buildScript(serverUrl, node.token) : "";

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--color-ink)]/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative z-10 w-full max-w-lg ${DIALOG_CARD} p-6 space-y-4`}>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[var(--color-violet)] border-2 border-[var(--color-ink)]" />
          <h2 className="text-base font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
            重装 Agent
          </h2>
          <span className="ml-auto text-xs font-mono text-[var(--color-muted-foreground)]">{node.hostname}</span>
        </div>

        {!node.token ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">该节点未绑定 Token，请通过"添加 Agent"重新安装。</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-muted-foreground)]">Agent：<span className="font-semibold text-[var(--color-ink)]">{node.name || node.hostname}</span></p>
            <Label className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wider">在目标节点执行</Label>
            <div className="relative">
              <pre className="bg-[#1a1a2e] text-[#e2e8f0] rounded-xl border-2 border-[var(--color-ink)] p-4 pr-20 overflow-x-auto text-xs leading-relaxed whitespace-pre font-mono">
                {script}
              </pre>
              <Btn
                variant={copied ? "default" : "outline"}
                className="absolute top-2 right-2 text-[10px]"
                onClick={handleCopy}
              >
                {copied ? "已复制 ✓" : "复制"}
              </Btn>
            </div>
          </div>
        )}
        <div className="flex justify-end">
          <Btn variant="outline" onClick={onClose}>关闭</Btn>
        </div>
      </div>
    </div>
  );
}

// ── 添加 Agent 弹窗 ───────────────────────────────────────────────────────────

type DialogStep = "name" | "script" | "success";

function AddAgentDialog({
  open, onClose, serverUrl, onTokenCreated, onNodeConnected,
}: {
  open: boolean;
  onClose: () => void;
  serverUrl: string;
  onTokenCreated: (tok: AgentToken) => void;
  onNodeConnected: () => void;
}) {
  const [step, setStep] = useState<DialogStep>("name");
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [connectedHostname, setConnectedHostname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!open) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    openedAtRef.current = Date.now();
    setStep("name"); setName(""); setScript(""); setConnectedHostname("");
    setError(null); setCreating(false); setCopied(false);
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
      const startedAt = openedAtRef.current;
      pollRef.current = setInterval(async () => {
        try {
          const nodes = await fetchAdminNodes();
          const connectedNode = nodes.find((n) => n.token === tok.token && n.hostname && n.connected);
          if (connectedNode) {
            clearInterval(pollRef.current!); pollRef.current = null;
            onNodeConnected();
            setConnectedHostname(connectedNode.name || connectedNode.hostname); setStep("success");
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

  const ACCENT_COLORS: Record<DialogStep, string> = {
    name: "var(--color-violet)",
    script: "var(--color-amber)",
    success: "var(--color-emerald)",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--color-ink)]/40 backdrop-blur-sm" onClick={handleClose} />
      <div className={`relative z-10 w-full max-w-lg ${DIALOG_CARD} overflow-hidden`}>
        {/* 顶部色条 */}
        <div
          className="h-1.5 w-full"
          style={{ background: ACCENT_COLORS[step] }}
        />
        <div className="p-6 space-y-4">
          {step === "name" && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full border-2 border-[var(--color-ink)]" style={{ background: "var(--color-violet)" }} />
                <h2 className="text-base font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>添加 Agent</h2>
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">为新节点创建认证 Token</p>
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
              <Input
                autoFocus
                placeholder="Agent 名称（如：my-server-01）"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <div className="flex justify-end gap-2">
                <Btn variant="outline" onClick={handleClose}>取消</Btn>
                <Btn onClick={handleCreate} disabled={creating || !name.trim()}>{creating ? "生成中…" : "下一步 →"}</Btn>
              </div>
            </>
          )}

          {step === "script" && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full border-2 border-[var(--color-ink)]" style={{ background: "var(--color-amber)" }} />
                <h2 className="text-base font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>安装 Agent</h2>
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">在目标服务器上运行以下命令</p>
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
              <div className="relative">
                <pre className="bg-[#1a1a2e] text-[#e2e8f0] rounded-xl border-2 border-[var(--color-ink)] p-4 pr-20 overflow-x-auto text-xs leading-relaxed whitespace-pre font-mono">
                  {script}
                </pre>
                <Btn
                  variant={copied ? "default" : "outline"}
                  className="absolute top-2 right-2 text-[10px]"
                  onClick={handleCopy}
                >
                  {copied ? "已复制 ✓" : "复制"}
                </Btn>
              </div>
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--color-cream)] border-2 border-[var(--color-border)] text-sm text-[var(--color-muted-foreground)]">
                <div className="w-4 h-4 rounded-full border-2 border-[var(--color-violet)] border-t-transparent animate-spin flex-shrink-0" />
                等待 Agent 连接中…
              </div>
              <div className="flex justify-end">
                <Btn variant="ghost" onClick={handleClose}>关闭</Btn>
              </div>
            </>
          )}

          {step === "success" && (
            <>
              <div className="flex flex-col items-center py-4 gap-4">
                <div
                  className="w-16 h-16 rounded-2xl border-2 border-[var(--color-ink)] flex items-center justify-center shadow-[3px_3px_0_0_#1E293B]"
                  style={{ background: "var(--color-emerald)" }}
                >
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>连接成功</p>
                  <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
                    节点 <span className="font-semibold text-[var(--color-ink)]">{connectedHostname}</span> 已上线
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Btn onClick={handleClose}>完成</Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 数据库统计视图 ─────────────────────────────────────────────────────────────

const DB_ACCENTS = [
  { bg: "var(--color-violet)", label: "数据库大小" },
  { bg: "var(--color-emerald)", label: "节点数" },
  { bg: "var(--color-pink)", label: "Metrics 行数" },
  { bg: "var(--color-amber)", label: "Token 数" },
];

// ── 访客记录面板 ──────────────────────────────────────────────────────────────

function VisitorsView() {
  const [stats, setStats] = useState<VisitorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetchVisitors()
        .then(setStats)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`${CARD} h-20 animate-pulse`} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border-2 border-red-400 bg-red-50 p-5 text-sm text-red-600">
        错误：{error}
      </div>
    );
  }

  if (!stats) return null;

  const statCards = [
    { label: "总计访客", value: stats.total, dot: "var(--color-violet)" },
    { label: "今日访问", value: stats.today, dot: "var(--color-emerald)" },
    { label: "当前在线", value: stats.active_now, dot: "var(--color-amber)" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
          访客记录
        </h2>
        <span className="text-xs text-[var(--color-muted-foreground)]">每 15 秒刷新</span>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-3">
        {statCards.map((c) => (
          <div key={c.label} className={`${CARD} p-4 flex flex-col gap-1`}>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c.dot }} />
              <span className="text-xs text-[var(--color-muted-foreground)]">{c.label}</span>
            </div>
            <span className="text-3xl font-bold text-[var(--color-ink)] tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
              {c.value}
            </span>
          </div>
        ))}
      </div>

      {/* 访客列表 */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="px-4 py-3 border-b-2 border-[var(--color-ink)] flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--color-ink)]">近期访客</span>
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold border-2 border-[var(--color-ink)] bg-white">
            {stats.recent.length}
          </span>
        </div>

        {stats.recent.length === 0 ? (
          <div className="p-10 text-center text-sm text-[var(--color-muted-foreground)]">
            暂无访客记录
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {stats.recent.map((v: VisitorEntry, i: number) => {
              const flag = countryFlagUrl(v.country_code);
              const isActive = Date.now() - new Date(v.last_seen).getTime() < 120_000;
              return (
                <div key={i} className="px-4 py-3 flex items-center gap-3 hover:bg-[var(--color-cream)] transition-colors">
                  {/* 在线状态 */}
                  {isActive ? (
                    <span className="relative flex h-2 w-2 flex-shrink-0">
                      <span className="absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: "var(--color-emerald)", animation: "ping-slow 1.4s cubic-bezier(0,0,0.2,1) infinite" }} />
                      <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "var(--color-emerald)" }} />
                    </span>
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-[var(--color-border)] flex-shrink-0" />
                  )}

                  {/* 国旗 */}
                  {flag ? (
                    <img src={flag} alt={v.country_code ?? ""} className="w-5 h-auto rounded-sm flex-shrink-0" />
                  ) : (
                    <span className="w-5 h-4 rounded-sm bg-[var(--color-border)] flex-shrink-0" />
                  )}

                  {/* IP + 归属地 + ASN */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono text-[var(--color-ink)]">{v.ip}</code>
                      {v.location && (
                        <span className="text-xs text-[var(--color-muted-foreground)]">{v.location}</span>
                      )}
                      {v.isp && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-cream)] border border-[var(--color-border)] text-[var(--color-muted-foreground)]">
                          {v.isp}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--color-muted-foreground)] mt-0.5 flex gap-2 flex-wrap">
                      {v.asn && <span className="font-mono">{v.asn}</span>}
                      <span>{v.page}</span>
                      <span>首次 {relativeTime(v.first_seen)}</span>
                    </div>
                  </div>

                  {/* 最后活跃 */}
                  <span className="text-xs text-[var(--color-muted-foreground)] flex-shrink-0 tabular-nums">
                    {relativeTime(v.last_seen)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CostView({ nodes }: { nodes: AdminNode[] }) {
  const [cnyMap, setCnyMap] = useState<Record<string, number | null>>({});

  const priced = nodes.filter((n) => n.price != null && n.price > 0);

  useEffect(() => {
    priced.forEach((n) => {
      if (!n.price_currency || n.price_currency === "CNY") return;
      toCNY(n.price!, n.price_currency).then((v) =>
        setCnyMap((prev) => ({ ...prev, [n.id]: v }))
      );
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  // 月均费用（原币）按货币归组
  const byCurrency: Record<string, number> = {};
  let totalCnyPerMonth = 0;
  let totalCnyPerYear = 0;

  for (const n of priced) {
    const months = n.price_period_months ?? 1;
    const monthly = n.price! / months;
    const cur = n.price_currency ?? "CNY";
    byCurrency[cur] = (byCurrency[cur] ?? 0) + monthly;

    const cny = cur === "CNY" ? monthly : (cnyMap[n.id] != null ? cnyMap[n.id]! / months : null);
    if (cny != null) {
      totalCnyPerMonth += cny;
      totalCnyPerYear += cny * 12;
    }
  }

  const expiringSoon = nodes
    .filter((n) => n.expires_at)
    .map((n) => ({ ...n, daysLeft: Math.ceil((new Date(n.expires_at!).getTime() - Date.now()) / 86_400_000) }))
    .filter((n) => n.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  return (
    <div className="space-y-6">
      {/* 汇总卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "月均总开销", value: totalCnyPerMonth > 0 ? `¥${totalCnyPerMonth.toFixed(0)}` : "—", dot: "var(--color-pink)" },
          { label: "年度预估", value: totalCnyPerYear > 0 ? `¥${totalCnyPerYear.toFixed(0)}` : "—", dot: "var(--color-violet)" },
          { label: "计费节点", value: String(priced.length), dot: "var(--color-emerald)" },
          { label: "30天内到期", value: String(expiringSoon.length), dot: expiringSoon.length > 0 ? "var(--color-amber)" : "var(--color-border)" },
        ].map(({ label, value, dot }) => (
          <div key={label} className={`${CARD} p-4 flex flex-col gap-1`}>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dot }} />
              <span className="text-xs text-[var(--color-muted-foreground)] font-medium">{label}</span>
            </div>
            <p className="text-2xl font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>{value}</p>
          </div>
        ))}
      </div>

      {/* 按货币分组 */}
      {Object.keys(byCurrency).length > 0 && (
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-[var(--color-ink)] mb-3">按货币月均</h3>
          <div className="flex flex-wrap gap-3">
            {Object.entries(byCurrency).map(([cur, amt]) => (
              <div key={cur} className="flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-[var(--color-border)] bg-[var(--color-cream)]">
                <span className="text-xs font-mono text-[var(--color-muted-foreground)]">{cur}</span>
                <span className="font-bold text-[var(--color-ink)]">{amt.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 节点费用明细 */}
      {priced.length > 0 && (
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-[var(--color-ink)] mb-3">节点明细</h3>
          <div className="space-y-2">
            {priced.map((n) => {
              const months = n.price_period_months ?? 1;
              const monthly = n.price! / months;
              const cur = n.price_currency ?? "CNY";
              const cnyMonthly = cur === "CNY" ? monthly : (cnyMap[n.id] != null ? cnyMap[n.id]! / months : null);
              return (
                <div key={n.id} className="flex items-center justify-between py-2 border-b border-[var(--color-border)] last:border-0">
                  <div className="flex items-center gap-2">
                    {n.country_code && <img src={countryFlagUrl(n.country_code)!} alt="" className="w-4 h-auto rounded-sm" />}
                    <span className="font-medium text-sm text-[var(--color-ink)]">{n.name || n.hostname}</span>
                    {n.location && <span className="text-xs text-[var(--color-muted-foreground)]">{n.location}</span>}
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-sm font-semibold text-[var(--color-ink)]">
                      {monthly.toFixed(2)} {cur}/月
                    </span>
                    {months > 1 && (
                      <span className="text-xs text-[var(--color-muted-foreground)] ml-1">（{n.price} {cur}/{months}月）</span>
                    )}
                    {cnyMonthly != null && cur !== "CNY" && (
                      <div className="text-xs text-[var(--color-muted-foreground)]">≈ ¥{cnyMonthly.toFixed(0)}/月</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 即将到期 */}
      {expiringSoon.length > 0 && (
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-[var(--color-ink)] mb-3">即将到期</h3>
          <div className="space-y-2">
            {expiringSoon.map((n) => (
              <div key={n.id} className="flex items-center justify-between py-2 border-b border-[var(--color-border)] last:border-0">
                <div className="flex items-center gap-2">
                  {n.country_code && <img src={countryFlagUrl(n.country_code)!} alt="" className="w-4 h-auto rounded-sm" />}
                  <span className="font-medium text-sm text-[var(--color-ink)]">{n.name || n.hostname}</span>
                </div>
                <span className={`text-sm font-semibold font-mono ${n.daysLeft <= 0 ? "text-red-500" : n.daysLeft <= 7 ? "text-red-400" : "text-[var(--color-amber)]"}`}>
                  {n.daysLeft <= 0 ? "已过期" : `${n.daysLeft} 天后`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {priced.length === 0 && (
        <div className={`${CARD} p-12 text-center text-sm text-[var(--color-muted-foreground)]`}>
          暂无费用数据，请在节点编辑中填写价格信息
        </div>
      )}
    </div>
  );
}

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

  if (loading) return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className={`h-24 ${CARD} animate-pulse`} style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!stats) return null;

  const statValues = [
    stats.db_size_pretty,
    stats.nodes_count.toLocaleString(),
    stats.metrics_count.toLocaleString(),
    stats.tokens_count.toLocaleString(),
  ];

  const avg7 = stats.daily_metrics.length >= 7
    ? Math.round(stats.daily_metrics.slice(-7).reduce((s, d) => s + d.count, 0) / 7)
    : null;
  const rowsPerGB = 1024 * 1024 * 1024 / 100;
  const daysTo1GB = avg7 && avg7 > 0 ? Math.round(rowsPerGB / avg7) : null;

  return (
    <div className="space-y-6">
      {/* 总览卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {DB_ACCENTS.map((a, i) => (
          <div key={a.label} className={`${CARD} p-4 flex flex-col gap-1.5`}>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full border border-[var(--color-ink)]" style={{ background: a.bg }} />
              <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted-foreground)]">
                {a.label}
              </span>
            </div>
            <p className="text-2xl font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
              {statValues[i]}
            </p>
          </div>
        ))}
      </div>

      {/* 每日增长图 */}
      <div className={`${CARD} overflow-hidden`}>
        <div
          className="px-5 py-3 border-b-2 border-[var(--color-ink)] flex items-center gap-2"
          style={{ background: "var(--color-violet)" }}
        >
          <h3 className="font-bold text-sm text-white" style={{ fontFamily: "var(--font-display)" }}>
            每日 Metrics 增长
          </h3>
          <span className="ml-auto text-[11px] text-white/70">最近 14 天</span>
        </div>
        <div className="p-5">
          {stats.daily_metrics.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)] py-8 text-center">暂无数据</p>
          ) : (
            <ChartContainer
              config={{ count: { label: "新增条数", color: "hsl(var(--chart-2))" } }}
              height={220} className="w-full"
            >
              <BarChart data={stats.daily_metrics} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.4} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }} width={50}
                  tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                />
                <ChartTooltip content={<ChartTooltipContent formatter={(v) => [typeof v === "number" ? v.toLocaleString() : String(v)]} />} />
                <Bar dataKey="count" fill="url(#barGrad)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </div>
      </div>

      {/* 增长预估 */}
      {avg7 != null && (
        <div className={`${CARD} p-5`}>
          <div className="flex items-center gap-2 mb-4">
            <span className="w-3 h-3 rounded-full bg-[var(--color-emerald)] border-2 border-[var(--color-ink)]" />
            <h3 className="font-bold text-sm text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
              增长速率与预估
            </h3>
            <span className="text-xs text-[var(--color-muted-foreground)] ml-1">基于近 7 天均值</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "日均新增", value: `${avg7.toLocaleString()} 条` },
              { label: "日均数据量", value: `≈ ${(avg7 * 100 / 1024 / 1024).toFixed(1)} MB` },
              ...(daysTo1GB != null ? [{ label: "再增 1 GB 约需", value: `${daysTo1GB} 天` }] : []),
              { label: "30 天预计增量", value: `≈ ${(avg7 * 30 * 100 / 1024 / 1024).toFixed(0)} MB` },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl bg-[var(--color-cream)] border-2 border-[var(--color-border)] p-3">
                <p className="text-[11px] text-[var(--color-muted-foreground)] font-semibold uppercase tracking-wider">{label}</p>
                <p className="text-xl font-bold text-[var(--color-ink)] mt-1" style={{ fontFamily: "var(--font-display)" }}>{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

function SortableNodeRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="relative group"
    >
      <div
        {...attributes}
        {...listeners}
        className="absolute left-0 top-0 bottom-0 w-7 flex items-center justify-center cursor-grab active:cursor-grabbing text-[var(--color-border)] hover:text-[var(--color-muted-foreground)] opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title="拖拽排序"
      >
        <svg width="12" height="20" viewBox="0 0 12 20" fill="currentColor">
          <circle cx="4" cy="4" r="1.5"/><circle cx="8" cy="4" r="1.5"/>
          <circle cx="4" cy="10" r="1.5"/><circle cx="8" cy="10" r="1.5"/>
          <circle cx="4" cy="16" r="1.5"/><circle cx="8" cy="16" r="1.5"/>
        </svg>
      </div>
      {children}
    </div>
  );
}

export default function Admin() {
  const serverUrl = SERVER_URL;
  const [location, navigate] = useLocation();
  const nav: NavItem =
    location.startsWith("/app/visitors") ? "visitors" :
    location.startsWith("/app/db") ? "db" :
    location.startsWith("/app/cost") ? "cost" : "nodes";
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editNode, setEditNode] = useState<AdminNode | null>(null);
  const [reinstallNode, setReinstallNode] = useState<AdminNode | null>(null);
  const [nodeCnyPrices, setNodeCnyPrices] = useState<Record<string, number | null>>({});
  const [upgradingIds, setUpgradingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setNodes((prev) => {
      const oldIdx = prev.findIndex((n) => n.id === active.id);
      const newIdx = prev.findIndex((n) => n.id === over.id);
      const next = arrayMove(prev, oldIdx, newIdx);
      reorderNodes(next.map((n) => n.id)).catch(() => {});
      return next;
    });
  }

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

  // SSE 实时更新 last_seen 等字段，保持在线状态准确
  useEffect(() => {
    const unsub = subscribeNodes((updated) => {
      setNodes((prev) => {
        const idx = prev.findIndex((n) => n.id === updated.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], ...updated };
        return next;
      });
    });
    return unsub;
  }, []);

  function handleTokenCreated(tok: AgentToken) {
    setTokens((prev) => [tok, ...prev]);
  }

  function handleNodeConnected() {
    fetchAdminNodes().then(setNodes).catch(() => {});
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

  async function handleUpgrade(id: string) {
    setUpgradingIds((prev) => new Set(prev).add(id));
    try {
      await triggerUpgrade(id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setUpgradingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
    setTimeout(() => setUpgradingIds((prev) => { const s = new Set(prev); s.delete(id); return s; }), 30_000);
  }

  async function handleDeleteToken(id: string) {
    setError(null);
    try {
      await deleteToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDeleteNode(id: string) {
    setError(null);
    try {
      await deleteNode(id);
      setNodes((prev) => prev.filter((n) => n.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const onlineCount = nodes.filter((n) => (Date.now() - new Date(n.last_seen).getTime()) < 120_000).length;

  const NAV_ITEMS: { key: NavItem; label: string; dot: string }[] = [
    { key: "nodes", label: "节点管理", dot: "var(--color-emerald)" },
    { key: "cost", label: "费用统计", dot: "var(--color-pink)" },
    { key: "visitors", label: "访客记录", dot: "var(--color-amber)" },
    { key: "db", label: "数据统计", dot: "var(--color-violet)" },
  ];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--color-cream)" }}>
      {/* ── Header ── */}
      <header className="relative overflow-hidden border-b-2 border-[var(--color-ink)] bg-white flex-shrink-0">
        <div className="absolute -top-6 -right-6 w-32 h-32 rounded-full opacity-10 pointer-events-none" style={{ background: "var(--color-pink)" }} />
        <div className="absolute top-3 right-24 w-4 h-4 rounded-full opacity-30 pointer-events-none" style={{ background: "var(--color-amber)" }} />

        <div className="relative max-w-7xl mx-auto px-5 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-xl border-2 border-[var(--color-ink)]"
              style={{ background: "var(--color-ink)" }}
            >
              <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4">
                <rect x="3" y="5" width="14" height="10" rx="2" stroke="white" strokeWidth="1.8" />
                <path d="M7 9h6M7 12h4" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold leading-none text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
                管理<span style={{ color: "var(--color-pink)" }}>后台</span>
              </h1>
              <p className="text-[10px] text-[var(--color-muted-foreground)] mt-0.5">
                {onlineCount} / {nodes.length} 在线
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold
                border-2 border-[var(--color-ink)] bg-white text-[var(--color-ink)]
                shadow-[2px_2px_0_0_#1E293B]
                hover:bg-[var(--color-cream)] hover:shadow-[3px_3px_0_0_#1E293B]
                transition-all duration-150"
            >
              ← 首页
            </Link>
            <button
              onClick={() => adminLogout()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold
                border-2 border-[var(--color-ink)] bg-white text-[var(--color-ink)]
                shadow-[2px_2px_0_0_#1E293B]
                hover:bg-[var(--color-cream)] hover:shadow-[3px_3px_0_0_#1E293B]
                transition-all duration-150 cursor-pointer"
            >
              退出
            </button>
            <button
              onClick={() => setDialogOpen(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold
                border-2 border-[var(--color-ink)] text-white
                shadow-[3px_3px_0_0_#1E293B]
                hover:shadow-[4px_4px_0_0_#1E293B] hover:-translate-x-px hover:-translate-y-px
                active:shadow-none active:translate-x-0.5 active:translate-y-0.5
                transition-all duration-150 cursor-pointer"
              style={{ background: "var(--color-violet)" }}
            >
              + 添加 Agent
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden max-w-7xl w-full mx-auto">
        {/* ── 侧边导航 ── */}
        <nav className="w-44 flex-shrink-0 border-r-2 border-[var(--color-ink)] bg-white py-5 px-3">
          <ul className="space-y-1.5">
            {NAV_ITEMS.map((item) => (
              <li key={item.key}>
                <button
                  onClick={() => navigate(item.key === "nodes" ? "/app" : `/app/${item.key}`)}
                  className={[
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 cursor-pointer text-left border-2",
                    nav === item.key
                      ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white shadow-[2px_2px_0_0_rgba(0,0,0,0.3)]"
                      : "border-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-cream)] hover:text-[var(--color-ink)] hover:border-[var(--color-border)]",
                  ].join(" ")}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 border border-white/30"
                    style={{ background: nav === item.key ? "white" : item.dot }}
                  />
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* ── 内容区 ── */}
        <main className="flex-1 overflow-auto p-6">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* 节点管理 */}
          {nav === "nodes" && (
            <div className="space-y-4">
              {/* 标题 */}
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
                  节点详情
                </h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold border-2 border-[var(--color-ink)] bg-white">
                  {nodes.length}
                </span>
              </div>

              {/* 节点卡片列表（移动端友好） */}
              {nodes.length === 0 ? (
                <div className={`${CARD} p-12 text-center text-sm text-[var(--color-muted-foreground)]`}>
                  暂无节点，点击右上角"添加 Agent"开始
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={nodes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-3">
                  {nodes.map((n) => {
                    const cny = nodeCnyPrices[n.id];
                    const daysLeft = n.expires_at
                      ? Math.ceil((new Date(n.expires_at).getTime() - Date.now()) / 86_400_000)
                      : null;
                    const online = (Date.now() - new Date(n.last_seen).getTime()) < 120_000;
                    return (
                      <SortableNodeRow key={n.id} id={n.id}>
                        <div className={`${CARD} p-4 pl-8`}>
                        <div className="flex items-start gap-4 flex-wrap">
                          {/* 主机信息 */}
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              {online ? (
                                <span className="relative flex h-2 w-2 flex-shrink-0">
                                  <span className="absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: "var(--color-emerald)", animation: "ping-slow 1.4s cubic-bezier(0,0,0.2,1) infinite" }} />
                                  <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "var(--color-emerald)" }} />
                                </span>
                              ) : (
                                <span className="h-2 w-2 rounded-full bg-red-400 flex-shrink-0" />
                              )}
                              {n.country_code && (
                                <img src={countryFlagUrl(n.country_code)!} alt={n.country_code} className="w-5 h-auto rounded-sm" />
                              )}
                              <span className="font-bold text-[var(--color-ink)]" style={{ fontFamily: "var(--font-display)" }}>
                                {n.name || n.hostname}
                              </span>
                              {n.name && (
                                <span className="text-[10px] font-mono text-[var(--color-muted-foreground)] opacity-60">{n.hostname}</span>
                              )}
                              {n.location && (
                                <span className="text-xs text-[var(--color-muted-foreground)]">{n.location}</span>
                              )}
                              <code className="text-[10px] font-mono bg-[var(--color-cream)] border border-[var(--color-border)] px-1.5 py-0.5 rounded-lg">
                                {n.ip}
                              </code>
                              {n.agent_version && (
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-lg bg-[var(--color-violet)]/10 border border-[var(--color-violet)]/30 text-[var(--color-violet)]">
                                  v{n.agent_version}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--color-muted-foreground)]">
                              {n.os && <span>{n.os}</span>}
                              {n.cpu_model && <span className="truncate max-w-[200px]">{n.cpu_model}</span>}
                              {n.expires_at && (
                                <span className={daysLeft != null && daysLeft <= 7 ? "text-red-500 font-semibold" : daysLeft != null && daysLeft <= 30 ? "text-[var(--color-amber)] font-semibold" : ""}>
                                  到期 {new Date(n.expires_at).toLocaleDateString("zh-CN")}
                                  {daysLeft != null && ` (${daysLeft < 0 ? "已过期" : `${daysLeft}天`})`}
                                </span>
                              )}
                              {n.price != null && (
                                <span>
                                  {n.price} {n.price_currency}{n.price_period_months && n.price_period_months > 1 ? ` / ${n.price_period_months}月` : " / 月"}
                                  {cny != null && n.price_currency !== "CNY" && ` ≈ ¥${cny.toFixed(0)}`}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* 三网测速开关 + 操作按钮 */}
                          <div className="flex items-center gap-3 flex-wrap">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-[var(--color-muted-foreground)]">三网测速</span>
                              <Switch
                                checked={n.latency_test_enabled}
                                onCheckedChange={(checked) => {
                                  setNodes((prev) => prev.map((x) => x.id === n.id ? { ...x, latency_test_enabled: checked } : x));
                                  toggleLatencyTest(n.id, checked).catch(() =>
                                    setNodes((prev) => prev.map((x) => x.id === n.id ? { ...x, latency_test_enabled: !checked } : x))
                                  );
                                }}
                              />
                            </div>
                            <div className="flex gap-1.5">
                              <Btn variant="outline" onClick={() => setEditNode(n)}>编辑</Btn>
                              <Btn variant="outline" onClick={() => setReinstallNode(n)}>重装</Btn>
                              <Btn
                                variant="outline"
                                disabled={upgradingIds.has(n.id)}
                                onClick={() => handleUpgrade(n.id)}
                              >
                                {upgradingIds.has(n.id) ? "升级中…" : "升级"}
                              </Btn>
                              <Btn
                                variant="danger"
                                onClick={() => { if (confirm(`确定删除节点 ${n.hostname}？`)) handleDeleteNode(n.id); }}
                              >
                                删除
                              </Btn>
                            </div>
                          </div>
                        </div>
                        </div>
                      </SortableNodeRow>
                    );
                  })}
                  </div>
                  </SortableContext>
                </DndContext>
              )}

            </div>
          )}

          {/* 费用统计 */}
          {nav === "cost" && <CostView nodes={nodes} />}

          {/* 访客记录 */}
          {nav === "visitors" && <VisitorsView />}

          {/* 数据库统计 */}
          {nav === "db" && <DbStatsView />}
        </main>
      </div>

      <AddAgentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        serverUrl={serverUrl}
        onTokenCreated={handleTokenCreated}
        onNodeConnected={handleNodeConnected}
      />

      <EditNodeDialog
        node={editNode}
        onClose={() => setEditNode(null)}
        onSaved={(updated) => editNode && handleNodeSaved(editNode.id, updated)}
      />

      <ReinstallDialog
        node={reinstallNode}
        serverUrl={serverUrl}
        onClose={() => setReinstallNode(null)}
      />
    </div>
  );
}
