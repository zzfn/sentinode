import { useState } from "react";
import { SERVER_URL } from "../api";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`${SERVER_URL}/api/admin/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        window.location.replace("/app");
      } else {
        setError("密码错误");
      }
    } catch {
      setError("连接失败，请检查网络");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "var(--color-cream)" }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-xl border-2 border-[var(--color-ink)]"
            style={{ background: "var(--color-ink)" }}
          >
            <svg viewBox="0 0 20 20" fill="none" className="w-5 h-5">
              <rect x="3" y="5" width="14" height="10" rx="2" stroke="white" strokeWidth="1.8" />
              <path d="M7 9h6M7 12h4" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h1
              className="text-lg font-bold leading-none text-[var(--color-ink)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Senti<span style={{ color: "var(--color-pink)" }}>node</span>
            </h1>
            <p className="text-[10px] text-[var(--color-muted-foreground)] mt-0.5">管理后台</p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border-2 border-[var(--color-ink)] shadow-[6px_6px_0_0_#1E293B] p-6">
          <h2
            className="text-base font-bold text-[var(--color-ink)] mb-5"
            style={{ fontFamily: "var(--font-display)" }}
          >
            登录
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-[var(--color-ink)] mb-1.5">
                管理密码
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入 SENTINODE_TOKEN"
                autoFocus
                className="w-full px-3 py-2 rounded-xl border-2 border-[var(--color-ink)] bg-[var(--color-cream)]
                  text-sm text-[var(--color-ink)] placeholder:text-[var(--color-muted-foreground)]
                  focus:outline-none focus:ring-2 focus:ring-[var(--color-violet)]/40
                  transition-all"
              />
            </div>

            {error && (
              <p className="text-xs text-red-500 font-medium">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2 rounded-xl text-sm font-bold text-white border-2 border-[var(--color-ink)]
                shadow-[3px_3px_0_0_#1E293B]
                hover:shadow-[4px_4px_0_0_#1E293B] hover:-translate-x-px hover:-translate-y-px
                active:shadow-none active:translate-x-0.5 active:translate-y-0.5
                disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-[3px_3px_0_0_#1E293B] disabled:hover:translate-x-0 disabled:hover:translate-y-0
                transition-all duration-150 cursor-pointer"
              style={{ background: "var(--color-violet)" }}
            >
              {loading ? "登录中…" : "登录"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
