import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { fetchMetrics, fmtBytes, fmtUptime, type Metric } from "../api";

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
          if (!cancelled) setError(String(e));
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

  if (loading) return <main><p>加载中…</p></main>;
  if (error) return <main><p style={{ color: "red" }}>错误：{error}</p></main>;

  const latest = metrics[0];

  return (
    <main style={{ padding: "1rem", fontFamily: "monospace" }}>
      <p><Link href="/">← 返回列表</Link></p>
      <h1>节点 {id}</h1>

      {latest && (
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
          <StatCard label="CPU" value={`${latest.cpu_percent.toFixed(1)}%`} />
          <StatCard
            label="内存"
            value={`${fmtBytes(latest.mem_used)} / ${fmtBytes(latest.mem_total)}`}
          />
          <StatCard
            label="交换"
            value={`${fmtBytes(latest.swap_used)} / ${fmtBytes(latest.swap_total)}`}
          />
          <StatCard
            label="负载"
            value={`${latest.load1.toFixed(2)} / ${latest.load5.toFixed(2)} / ${latest.load15.toFixed(2)}`}
          />
          <StatCard label="运行时长" value={fmtUptime(latest.uptime_secs)} />
        </div>
      )}

      <h2>历史记录（最近 {metrics.length} 条）</h2>
      {metrics.length === 0 ? (
        <p>暂无数据。</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["时间", "CPU%", "内存使用", "负载1m", "运行时长"].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.id}>
                <td style={tdStyle}>{new Date(m.reported_at).toLocaleString()}</td>
                <td style={tdStyle}>{m.cpu_percent.toFixed(1)}%</td>
                <td style={tdStyle}>
                  {fmtBytes(m.mem_used)} / {fmtBytes(m.mem_total)}
                </td>
                <td style={tdStyle}>{m.load1.toFixed(2)}</td>
                <td style={tdStyle}>{fmtUptime(m.uptime_secs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid #ccc",
        borderRadius: "6px",
        padding: "0.75rem 1rem",
        minWidth: "140px",
      }}
    >
      <div style={{ fontSize: "0.75rem", color: "#888" }}>{label}</div>
      <div style={{ fontSize: "1.1rem", fontWeight: "bold" }}>{value}</div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 12px",
  borderBottom: "2px solid #ccc",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderBottom: "1px solid #eee",
};
