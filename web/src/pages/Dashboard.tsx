import { useEffect, useState } from "react";
import { Link } from "wouter";
import { fetchNodes, type Node } from "../api";

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
  }, []);

  if (loading) return <main><p>加载中…</p></main>;
  if (error) return <main><p style={{ color: "red" }}>错误：{error}</p></main>;

  return (
    <main style={{ padding: "1rem", fontFamily: "monospace" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Sentinode</h1>
        <Link href="/admin" style={{ fontSize: "0.85rem" }}>管理后台</Link>
      </div>
      {nodes.length === 0 ? (
        <p>暂无节点，请先运行 agent。</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["主机名", "IP", "OS", "架构", "最后上报"].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td style={tdStyle}>
                  <Link href={`/nodes/${n.id}`}>{n.hostname}</Link>
                </td>
                <td style={tdStyle}>{n.ip}</td>
                <td style={tdStyle}>{n.os}</td>
                <td style={tdStyle}>{n.arch}</td>
                <td style={tdStyle}>{new Date(n.last_seen).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
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
