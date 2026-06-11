import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AgentToken, SERVER_URL, createToken, deleteToken, fetchTokens } from "../api";

const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/zzfn/sentinode/main/scripts/install.sh";

// 生成一行 curl 安装命令
function buildScript(serverUrl: string, token: string): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- \\
  --server ${serverUrl} \\
  --token ${token}`;
}

export default function Admin() {
  const serverUrl = SERVER_URL;

  // 已注册的 token 列表
  const [tokens, setTokens] = useState<AgentToken[]>([]);

  // 新建 token 时输入的 name
  const [newName, setNewName] = useState("");

  // 提交后展示的安装脚本（null 表示还未生成）
  const [script, setScript] = useState<string | null>(null);

  // 错误信息
  const [error, setError] = useState<string | null>(null);

  // 复制成功提示
  const [copied, setCopied] = useState(false);

  // 加载 token 列表
  useEffect(() => {
    fetchTokens()
      .then(setTokens)
      .catch((e: Error) => setError(e.message));
  }, []);

  // 提交添加 Agent
  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const tok = await createToken(name);
      setTokens((prev) => [tok, ...prev]);
      setNewName("");
      // 生成安装脚本
      setScript(buildScript(serverUrl, tok.token));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // 删除 Agent token
  async function handleDelete(id: string, tokenVal: string) {
    setError(null);
    try {
      await deleteToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      // 如果当前展示的脚本正是该 token，清除脚本
      if (script?.includes(tokenVal)) {
        setScript(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // 复制脚本到剪贴板
  async function handleCopy() {
    if (!script) return;
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选中复制");
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif" }}>
      {/* 顶部导航 */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <Link href="/" style={{ color: "#3b82f6", textDecoration: "none", fontSize: 14 }}>
          ← 返回
        </Link>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>管理后台</h1>
      </div>

      {/* 错误提示 */}
      {error && (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #fca5a5",
            color: "#dc2626",
            borderRadius: 6,
            padding: "10px 14px",
            marginBottom: 20,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {/* 已注册 Agent 列表 */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>已注册 Agent</h2>
        {tokens.length === 0 ? (
          <p style={{ color: "#9ca3af", fontSize: 14 }}>暂无已注册的 Agent</p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 14,
            }}
          >
            <thead>
              <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>Token</th>
                <th style={thStyle}>注册时间</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((tok) => (
                <tr key={tok.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                  <td style={tdStyle}>{tok.name}</td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                    {tok.token}
                  </td>
                  <td style={tdStyle}>{new Date(tok.created_at).toLocaleString("zh-CN")}</td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => handleDelete(tok.id, tok.token)}
                      style={{
                        background: "#ef4444",
                        color: "#fff",
                        border: "none",
                        borderRadius: 4,
                        padding: "4px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 添加 Agent */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>添加 Agent</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Agent 名称（如：my-server-01）"
            style={{
              flex: 1,
              maxWidth: 320,
              padding: "8px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: 14,
              boxSizing: "border-box",
            }}
          />
          <button
            onClick={handleCreate}
            style={{
              background: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "8px 18px",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            提交
          </button>
        </div>
      </section>

      {/* 安装脚本展示区 */}
      {script && (
        <section>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>安装命令</h2>
            <button
              onClick={handleCopy}
              style={{
                background: copied ? "#22c55e" : "#6b7280",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                padding: "4px 12px",
                cursor: "pointer",
                fontSize: 12,
                transition: "background 0.2s",
              }}
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <pre
            style={{
              background: "#1e1e1e",
              color: "#d4d4d4",
              borderRadius: 8,
              padding: "16px 20px",
              overflowX: "auto",
              fontSize: 12,
              lineHeight: 1.6,
              margin: 0,
              whiteSpace: "pre",
            }}
          >
            {script}
          </pre>
        </section>
      )}
    </div>
  );
}

// 表格样式复用
const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontWeight: 600,
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "middle",
};
