import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  countryFlagUrl, fmtBandwidth, fmtBytes, fmtUptime, sendBeacon,
  subscribeNodes,
  type BeaconInfo, type Node,
} from "../api";
import Globe, { type GlobeMarker, type GlobeArc } from "../components/Globe";

// 背景渐变（右上浓绿 → 白）
const BG = "radial-gradient(1100px 620px at 82% -8%, #cbe8fb 0%, rgba(238,245,250,0.6) 42%, #ffffff 78%)";
// 扁平卡片基础样式
const CARD = "bg-white/85 backdrop-blur-sm rounded-2xl border border-sky-200/60 shadow-[0_2px_10px_rgba(14,165,233,0.07)]";
const MINT = "#0ea5e9";
const VISITOR_RGB: [number, number, number] = [0.96, 0.09, 0.42]; // 访客高亮（玫红）

// 国家/地区 → 经纬度（首页 3D 地球定位）
const GEO: Record<string, [number, number]> = {
  CN: [31.23, 121.47], HK: [22.32, 114.17], TW: [25.03, 121.56], JP: [35.68, 139.69],
  US: [37.77, -122.42], SG: [1.35, 103.82], KR: [37.56, 126.98], NL: [52.37, 4.90],
  DE: [52.52, 13.40], GB: [51.51, -0.13], FR: [48.85, 2.35], MO: [22.16, 113.55],
  RU: [55.75, 37.62], CA: [43.65, -79.38], AU: [-33.87, 151.21], IN: [19.08, 72.88],
  BR: [-23.55, -46.63], ID: [-6.21, 106.85], VN: [21.03, 105.85], TH: [13.76, 100.50],
  MY: [3.14, 101.69], PH: [14.60, 120.98], TR: [41.01, 28.98], AE: [25.20, 55.27],
};

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

function usageColor(pct: number): string {
  if (pct >= 90) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return MINT;
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, (used / total) * 100) : 0;
}

// 操作系统 → 品牌图标（simpleicons CDN，未知则不显示）
function osIcon(os: string | null | undefined): string | null {
  if (!os) return null;
  const s = os.toLowerCase();
  const map: [string, string, string][] = [
    ["debian", "debian", "A81D33"],
    ["ubuntu", "ubuntu", "E95420"],
    ["alpine", "alpinelinux", "0D597F"],
    ["arch", "archlinux", "1793D1"],
    ["fedora", "fedora", "51A2DA"],
    ["red hat", "redhat", "EE0000"],
    ["rocky", "rockylinux", "10B981"],
    ["centos", "centos", "262577"],
    ["macos", "apple", "555555"],
    ["darwin", "apple", "555555"],
    ["windows", "windows11", "0078D4"],
  ];
  for (const [kw, slug, color] of map) {
    if (s.includes(kw)) return `https://cdn.simpleicons.org/${slug}/${color}`;
  }
  return null;
}

// ── 三网延迟历史格子 ──────────────────────────────────────────────────────────

function latColor(ms: number | null | undefined): string {
  if (ms == null) return "#e2e8f0";       // 无数据 灰
  if (ms < 0) return "#ef4444";            // 超时 红
  if (ms < 50) return "#10b981";           // 绿
  if (ms < 100) return "#34d399";          // 浅绿
  if (ms < 200) return "#f59e0b";          // 黄
  return "#fb923c";                         // 橙
}

function LatencyBars({ label, color, current, history }: {
  label: string; color: string; current: number | null | undefined;
  history: (number | null)[];
}) {
  // 取最近 20 格，不足左侧留空灰格
  const cells = history.slice(-20);
  const pad = Array.from({ length: Math.max(0, 20 - cells.length) }, () => null);
  const all = [...pad, ...cells];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color }}>{label}</span>
        <span className="font-semibold tabular-nums text-slate-600">
          {current == null ? "—" : current < 0 ? "超时" : `${current.toFixed(0)} ms`}
        </span>
      </div>
      <div className="flex gap-[2px]">
        {all.map((v, i) => (
          <span key={i} className="flex-1 h-3 rounded-[2px]" style={{ background: latColor(v) }} />
        ))}
      </div>
    </div>
  );
}

// ── 资源进度条 ────────────────────────────────────────────────────────────────

function UsageBar({ label, percent, detail }: { label: string; percent: number | null; detail?: string }) {
  const has = percent != null;
  const color = has ? usageColor(percent!) : "#cbd5e1";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold tabular-nums" style={{ color: has ? color : "#94a3b8" }}>
          {has ? `${percent!.toFixed(1)}%` : "—"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${has ? percent : 0}%`, background: color }} />
      </div>
      {detail && <p className="text-[10px] text-slate-400 tabular-nums">{detail}</p>}
    </div>
  );
}

// ── 节点卡片（网格视图）──────────────────────────────────────────────────────

function NodeCard({ node }: { node: Node }) {
  const online = isOnline(node.last_seen);
  const hasLatency = node.latency_cu_ms != null || node.latency_cm_ms != null || node.latency_ct_ms != null;
  const memPct = node.mem_used != null && node.mem_total != null ? pct(node.mem_used, node.mem_total) : null;
  const diskPct = node.disk_used != null && node.disk_total != null && node.disk_total > 0 ? pct(node.disk_used, node.disk_total) : null;

  return (
    <div
      className={`relative rounded-2xl border p-4 flex flex-col gap-3 transition-all duration-200 ease-out cursor-pointer ${
        online
          ? "bg-white/90 backdrop-blur-sm border-sky-200/60 shadow-[0_2px_10px_rgba(14,165,233,0.07)] hover:shadow-[0_6px_22px_rgba(14,165,233,0.14)] hover:-translate-y-0.5"
          : "bg-slate-50/80 border-red-200 shadow-[0_2px_10px_rgba(239,68,68,0.08)] opacity-75 hover:opacity-100"
      }`}
    >
      <Link href={`/nodes/${node.id}`} className="absolute inset-0 rounded-2xl" aria-label={node.hostname} />

      {/* 顶部：状态点 + 名称（左）；系统图标 + 国旗 + 外链（右，对齐参考图） */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {online ? (
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: MINT, animation: "ping-slow 1.4s cubic-bezier(0,0,0.2,1) infinite" }} />
              <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: MINT }} />
            </span>
          ) : (
            <span className="h-2 w-2 rounded-full bg-red-400 inline-block flex-shrink-0" />
          )}
          <h2 className="text-[15px] font-bold leading-tight text-slate-800 truncate" style={{ fontFamily: "var(--font-display)" }}>
            {node.name ?? <span className="opacity-40 tracking-widest">••••••</span>}
          </h2>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {osIcon(node.os) && (
            <img src={osIcon(node.os)!} alt="" title={node.os} className="w-4 h-4" />
          )}
          {node.country_code && <img src={countryFlagUrl(node.country_code)!} alt={node.country_code} className="w-5 h-[15px] rounded-sm" />}
          {node.website_url && (
            <a
              href={node.website_url}
              target="_blank"
              rel="noopener noreferrer"
              className="relative z-10 flex items-center justify-center w-6 h-6 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 transition-colors"
              title="官网"
              onClick={(e) => e.stopPropagation()}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {/* 系统信息 */}
      <p className="text-xs text-slate-400 leading-snug -mt-1 truncate">
        {node.location && <span className="mr-1.5">{node.location}</span>}
        {node.os}
        <span className="mx-1 opacity-40">·</span>
        <span className="font-mono opacity-70">{node.arch}</span>
      </p>

      {/* 资源进度条：CPU / 内存 / 硬盘 / 负载（2 列网格，对齐参考图） */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <UsageBar label="CPU" percent={node.cpu_percent} />
        <UsageBar label="内存" percent={memPct} detail={node.mem_used != null && node.mem_total != null ? `${fmtBytes(node.mem_used)} / ${fmtBytes(node.mem_total)}` : undefined} />
        {diskPct != null && (
          <UsageBar label="硬盘" percent={diskPct} detail={`${fmtBytes(node.disk_used ?? 0)} / ${fmtBytes(node.disk_total ?? 0)}`} />
        )}
        {node.load1 != null && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">负载</span>
              {node.uptime_secs != null && node.uptime_secs > 0 && <span className="text-[10px] text-slate-400">{fmtUptime(node.uptime_secs)}</span>}
            </div>
            <p className="font-mono tabular-nums text-xs text-slate-600 pt-0.5">{node.load1.toFixed(2)} · {(node.load5 ?? 0).toFixed(2)} · {(node.load15 ?? 0).toFixed(2)}</p>
          </div>
        )}
      </div>

      {/* 小框组：实时带宽 / 累计流量 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-1.5 text-[11px] font-mono leading-relaxed">
          <div className="text-sky-600">↑ {fmtBandwidth(node.net_tx_rate)}</div>
          <div className="text-violet-500">↓ {fmtBandwidth(node.net_rx_rate)}</div>
        </div>
        {(node.net_rx_total != null || node.net_tx_total != null) && (
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-1.5 text-[11px] font-mono leading-relaxed text-slate-500">
            <div>↑ {fmtBytes(node.net_tx_total ?? 0)}</div>
            <div>↓ {fmtBytes(node.net_rx_total ?? 0)}</div>
          </div>
        )}
      </div>

      {/* 三网延迟历史格子 */}
      {hasLatency && (
        <div className="space-y-1.5 mt-auto pt-1">
          <LatencyBars label="联通" color="#8b5cf6" current={node.latency_cu_ms} history={node.latency_history.map(p => p.cu)} />
          <LatencyBars label="移动" color="#ec4899" current={node.latency_cm_ms} history={node.latency_history.map(p => p.cm)} />
          <LatencyBars label="电信" color="#f59e0b" current={node.latency_ct_ms} history={node.latency_history.map(p => p.ct)} />
        </div>
      )}
    </div>
  );
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function useSecondTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

function fmtUpdatedAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  return `${Math.floor(secs / 60)} 分钟前`;
}

export default function Dashboard() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [connected, setConnected] = useState(false);
  const [visitorInfo, setVisitorInfo] = useState<BeaconInfo | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [regionFilter, setRegionFilter] = useState<string>("全部");
  const [search, setSearch] = useState("");
  useSecondTick();

  useEffect(() => { document.title = "Sentinode"; }, []);

  useEffect(() => {
    sendBeacon("/").then((info) => { if (info) setVisitorInfo(info); });
    const interval = setInterval(() => sendBeacon("/"), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsub = subscribeNodes((updated) => {
      if (cancelled) return;
      setLastUpdatedAt(Date.now());
      setNodes((prev) => {
        const idx = prev.findIndex((n) => n.id === updated.id);
        if (idx === -1) {
          // 仅完整节点对象才作为新节点插入；部分更新（如 latency_history）忽略
          if (!("hostname" in updated)) return prev;
          setConnected(true);
          return [...prev, updated as Node];
        }
        setConnected(true);
        const next = [...prev];
        next[idx] = { ...next[idx], ...updated };
        return next;
      });
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const regions = useMemo(() => {
    const set = new Set<string>();
    nodes.forEach((n) => { if (n.location) set.add(n.location); });
    return ["全部", ...Array.from(set).sort()];
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes
      .filter((n) => {
        if (regionFilter !== "全部" && n.location !== regionFilter) return false;
        if (!q) return true;
        return [n.name, n.hostname, n.location, n.os].some((v) => v?.toLowerCase().includes(q));
      })
      // 稳定排序：按管理后台设置的 sort_order 升序（未设置排后面），再按 id 兜底。
      // 不用在线状态/CPU 等会变动的指标当排序键，避免节点上下线、负载波动时顺序跳动。
      .sort((a, b) => {
        const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
        const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return a.id.localeCompare(b.id);
      });
  }, [nodes, regionFilter, search]);

  const onlineCount = nodes.filter((n) => isOnline(n.last_seen)).length;
  const offlineCount = nodes.length - onlineCount;

  // 节点标记（在线点更大）
  const nodeMarkers = useMemo<GlobeMarker[]>(() => {
    return nodes
      .map((n) => {
        const geo = n.country_code ? GEO[n.country_code.toUpperCase()] : undefined;
        if (!geo) return null;
        return { location: geo, size: isOnline(n.last_seen) ? 0.06 : 0.03 } as GlobeMarker;
      })
      .filter((m): m is GlobeMarker => m !== null);
  }, [nodes]);

  // 访客自身位置（来自 beacon 的国家码）
  const visitorGeo = useMemo<[number, number] | null>(() => {
    const vc = visitorInfo?.country_code?.toUpperCase();
    return vc && GEO[vc] ? GEO[vc] : null;
  }, [visitorInfo]);

  // 地球标记：节点 + 访客高亮（紫色大点）
  const markers = useMemo<GlobeMarker[]>(() => {
    const list = [...nodeMarkers];
    if (visitorGeo) list.push({ location: visitorGeo, size: 0.14, color: VISITOR_RGB });
    return list;
  }, [nodeMarkers, visitorGeo]);

  // 流量弧线：有访客位置则从访客连向各节点，否则以首个节点为枢纽
  const arcs = useMemo<GlobeArc[]>(() => {
    if (visitorGeo) {
      return nodeMarkers.slice(0, 10).map((m, i) => ({ from: visitorGeo, to: m.location, id: `v-${i}` }));
    }
    if (nodeMarkers.length < 2) return [];
    const hub = nodeMarkers[0].location;
    return nodeMarkers.slice(1, 9).map((m, i) => ({ from: hub, to: m.location, id: `arc-${i}` }));
  }, [nodeMarkers, visitorGeo]);

  // 实时总带宽（地球角落展示）
  const summary = useMemo(() => {
    let rx = 0, tx = 0;
    for (const n of nodes) {
      if (!isOnline(n.last_seen)) continue;
      rx += n.net_rx_rate ?? 0;
      tx += n.net_tx_rate ?? 0;
    }
    return { rx, tx };
  }, [nodes]);

  return (
    <div className="min-h-screen relative overflow-hidden" style={{ background: BG }}>
      {/* 地球：全屏淡背景（始终渲染球体；有节点/访客时叠加发光点与弧线） */}
      <div className="pointer-events-none fixed inset-0 z-0 flex items-center justify-center overflow-hidden">
        <div className="aspect-square" style={{ width: "min(900px, 92vw)", opacity: 0.3 }}>
          <Globe markers={markers} arcs={arcs} />
        </div>
      </div>
      {/* ── Header ── */}
      <header className="relative border-b border-sky-200/50 bg-white/70 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-5 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl shadow-sm" style={{ background: MINT }}>
              <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4" xmlns="http://www.w3.org/2000/svg">
                <circle cx="10" cy="10" r="3" fill="white" />
                <circle cx="10" cy="10" r="7" stroke="white" strokeWidth="2" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold leading-none text-slate-800" style={{ fontFamily: "var(--font-display)" }}>
                Senti<span style={{ color: MINT }}>node</span>
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-slate-400">服务器监控</span>
                {connected && nodes.length > 0 && (
                  <>
                    <span className="text-slate-300">·</span>
                    <span className="text-xs font-semibold text-sky-600">{onlineCount} 在线</span>
                    {offlineCount > 0 && (<><span className="text-slate-300">·</span><span className="text-xs font-semibold text-red-400">{offlineCount} 离线</span></>)}
                    {lastUpdatedAt && (<><span className="text-slate-300">·</span><span className="text-xs text-slate-400" title={new Date(lastUpdatedAt).toLocaleTimeString()}>{fmtUpdatedAgo(lastUpdatedAt)}</span></>)}
                  </>
                )}
              </div>
            </div>
          </div>

          {visitorInfo && (
            <div className="flex items-center gap-1.5 text-xs text-slate-400 flex-shrink-0">
              {visitorInfo.country_code && <img src={countryFlagUrl(visitorInfo.country_code)!} alt={visitorInfo.country_code} className="w-4 h-3 rounded-sm" />}
              {visitorInfo.location && <span className="hidden sm:inline">{visitorInfo.location}</span>}
              <code className="hidden md:inline font-mono text-[10px] bg-sky-50 border border-sky-100 px-1 py-0.5 rounded text-slate-500">{visitorInfo.ip}</code>
              {visitorInfo.isp && <span className="hidden lg:inline text-[10px] px-1.5 py-0.5 rounded bg-sky-50 border border-sky-100">{visitorInfo.isp}</span>}
              <span className="text-slate-300">·</span>
              <span>今日第 <span className="font-semibold text-slate-700">{visitorInfo.today_rank}</span> 位</span>
            </div>
          )}
        </div>
      </header>

      {/* ── Main ── */}
      <main className="relative z-10 max-w-[1400px] mx-auto px-5 py-6">
        {!connected ? (
          <div className="py-24 text-center text-sm text-slate-400">加载中…</div>
        ) : nodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center shadow-lg" style={{ background: MINT }}>
              <svg viewBox="0 0 24 24" fill="none" className="w-10 h-10" stroke="white" strokeWidth={2}>
                <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
              </svg>
            </div>
            <p className="text-xl font-bold text-slate-800" style={{ fontFamily: "var(--font-display)" }}>暂无节点</p>
            <p className="text-sm text-slate-400">暂无节点接入</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* 概览条：节点数 / 你的位置 / 实时总带宽（地球见全屏背景） */}
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold">
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/70 backdrop-blur border border-sky-100 text-sky-700">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: MINT }} />
{nodes.length} 节点
              </span>
              {visitorInfo?.country_code && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/70 backdrop-blur border border-rose-200 text-rose-600">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#f5176b" }} />
                  你的位置 {visitorInfo.location ?? visitorInfo.country_code}
                </span>
              )}
              <span className="ml-auto flex items-center gap-3 font-mono">
                <span className="text-sky-600">↓ {fmtBandwidth(summary.rx)}</span>
                <span className="text-violet-500">↑ {fmtBandwidth(summary.tx)}</span>
              </span>
            </div>

            {/* 工具栏 */}
            <div className="flex items-center gap-3 flex-wrap">
              {regions.length > 2 && (
                <div className="flex flex-wrap gap-2 flex-1 min-w-0">
                  {regions.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRegionFilter(r)}
                      className="px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-150"
                      style={regionFilter === r ? { background: MINT, color: "#fff", borderColor: MINT } : { background: "rgba(255,255,255,0.7)", color: "#475569", borderColor: "#e0f2fe" }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <div className="relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="M21 21l-4-4" />
                  </svg>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索节点…"
                    className="w-32 sm:w-44 pl-8 pr-3 py-1.5 rounded-full text-xs border border-sky-200 bg-white/80 focus:outline-none focus:border-sky-400 focus:w-48 sm:focus:w-56 transition-all"
                  />
                </div>
              </div>
            </div>

            {/* 节点列表 */}
            {filteredNodes.length === 0 ? (
              <div className={`${CARD} p-12 text-center text-sm text-slate-400`}>没有匹配的节点</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredNodes.map((n) => <NodeCard key={n.id} node={n} />)}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
