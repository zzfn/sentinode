// Bun 原生开发服务器：watch + serve + Tailwind CSS watch
import { watch } from "fs";

const OUTDIR = "dist";
const API_BASE = process.env.API_BASE ?? "http://localhost:8080";

/** 构建 JS bundle */
async function bundle() {
  const result = await Bun.build({
    entrypoints: ["src/index.tsx"],
    outdir: OUTDIR,
    target: "browser",
    sourcemap: "inline",
    define: { "process.env.API_BASE": JSON.stringify(API_BASE) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
  }
}

// 初始构建
await bundle();
console.log("Initial JS build done");

// 启动 Tailwind CSS watch 进程（并发运行）
const twProc = Bun.spawn(
  ["bunx", "@tailwindcss/cli", "-i", "./src/globals.css", "-o", "./dist/globals.css", "--watch"],
  {
    stdout: "inherit",
    stderr: "inherit",
  }
);
console.log(`Tailwind CSS watch started (pid: ${twProc.pid})`);

// 监听 src 目录变化重新构建 JS
watch("src", { recursive: true }, async (_, filename) => {
  // globals.css 由 Tailwind 负责，不触发 JS 构建
  if (filename?.endsWith(".css")) return;
  await bundle();
  console.log(`[${new Date().toLocaleTimeString()}] JS rebuilt`);
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // 代理 /api/* 和 /healthz 到后端
    if (path.startsWith("/api/") || path === "/healthz") {
      try {
        return await fetch(`${API_BASE}${path}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
      } catch {
        return Response.json(
          { error: `后端不可用 (${API_BASE})，请确认 sentinode-server 已启动` },
          { status: 503 },
        );
      }
    }

    // 静态资源：先查构建产物目录，再回退到项目根目录（favicon 等源文件）
    if (path !== "/" && path.includes(".")) {
      const distFile = Bun.file(`${OUTDIR}${path}`);
      if (await distFile.exists()) return new Response(distFile);
      const rootFile = Bun.file(`.${path}`);
      if (await rootFile.exists()) return new Response(rootFile);
    }

    // SPA fallback
    return new Response(Bun.file("index.html"));
  },
});

console.log(`Dev: http://localhost:${server.port}`);

// 进程退出时清理 Tailwind 子进程
process.on("exit", () => twProc.kill());
process.on("SIGINT", () => {
  twProc.kill();
  process.exit(0);
});
