// Bun 原生开发服务器：watch + serve + Tailwind CSS（由 fs.watch 驱动重编）
import { watch } from "fs";
import { $ } from "bun";

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

/** 一次性编译 Tailwind CSS（不依赖存活不了的 --watch，由 fs.watch 驱动重编） */
async function buildCss() {
  await $`bunx @tailwindcss/cli -i ./src/globals.css -o ./dist/globals.css`.quiet();
}

// 初始构建（JS + CSS）
await bundle();
await buildCss();
console.log("Initial build done (JS + CSS)");

// 监听 src 变化，debounce 后一起重编 JS + CSS。
// Tailwind 需扫描 .tsx 里的类名，所以任何源文件变化都要重编 CSS。
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
watch("src", { recursive: true }, () => {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    await bundle();
    await buildCss();
    console.log(`[${new Date().toLocaleTimeString()}] rebuilt (JS + CSS)`);
  }, 120);
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

    // 开发模式禁用缓存，避免浏览器用旧 bundle（刷新出现旧 UI）
    const headers = { "Cache-Control": "no-store" };

    // 静态资源：先查构建产物目录，再回退到项目根目录（favicon 等源文件）
    if (path !== "/" && path.includes(".")) {
      const distFile = Bun.file(`${OUTDIR}${path}`);
      if (await distFile.exists()) return new Response(distFile, { headers });
      const rootFile = Bun.file(`.${path}`);
      if (await rootFile.exists()) return new Response(rootFile, { headers });
    }

    // SPA fallback
    return new Response(Bun.file("index.html"), { headers });
  },
});

console.log(`Dev: http://localhost:${server.port}`);

// 进程退出时清理 Tailwind 子进程
process.on("SIGINT", () => process.exit(0));
