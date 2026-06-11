import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  AgentToken, SERVER_URL,
  createToken, deleteToken, fetchTokens,
} from "../api";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/zzfn/sentinode/main/scripts/install.sh";

function buildScript(serverUrl: string, token: string): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- \\
  --server ${serverUrl} \\
  --token ${token}`;
}

export default function Admin() {
  const serverUrl = SERVER_URL;
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [newName, setNewName] = useState("");
  const [script, setScript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchTokens()
      .then(setTokens)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    setCreating(true);
    try {
      const tok = await createToken(name);
      setTokens((prev) => [tok, ...prev]);
      setNewName("");
      setScript(buildScript(serverUrl, tok.token));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, tokenVal: string) {
    setError(null);
    try {
      await deleteToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (script?.includes(tokenVal)) setScript(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← 返回首页
          </Link>
          <span className="text-border">|</span>
          <h1 className="text-base font-semibold">管理后台</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>已注册 Agent</CardTitle>
            <CardDescription>共 {tokens.length} 个 Agent Token</CardDescription>
          </CardHeader>
          <CardContent>
            {tokens.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">暂无已注册的 Agent</p>
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
                        <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded break-all">
                          {tok.token}
                        </code>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(tok.created_at).toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell>
                        <Button variant="destructive" size="sm" onClick={() => handleDelete(tok.id, tok.token)}>
                          删除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>添加 Agent</CardTitle>
            <CardDescription>输入名称生成新 Token 并获取安装命令</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Agent 名称（如：my-server-01）"
                className="max-w-xs"
              />
              <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
                {creating ? "生成中…" : "生成 Token"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {script && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>安装命令</CardTitle>
                  <CardDescription className="mt-1">在目标服务器上运行</CardDescription>
                </div>
                <Button variant={copied ? "secondary" : "outline"} size="sm" onClick={handleCopy}>
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="bg-[#1e1e1e] text-[#d4d4d4] rounded-lg p-4 overflow-x-auto text-xs leading-relaxed whitespace-pre font-mono">
                {script}
              </pre>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
