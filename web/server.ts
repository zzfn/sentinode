// Bun 原生开发服务器：watch + serve，无需 Vite
import { watch } from "fs";

const OUTDIR = "dist";

async function bundle() {
  const result = await Bun.build({
    entrypoints: ["src/index.tsx"],
    outdir: OUTDIR,
    target: "browser",
    sourcemap: "inline",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
  }
}

await bundle();
console.log("Initial build done");

watch("src", { recursive: true }, async () => {
  await bundle();
  console.log(`[${new Date().toLocaleTimeString()}] rebuilt`);
});

const API_BASE = process.env.API_BASE ?? "http://localhost:8080";

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

    // 静态资源：JS / CSS / 图片等
    if (path !== "/" && path.includes(".")) {
      const file = Bun.file(`${OUTDIR}${path}`);
      if (await file.exists()) return new Response(file);
    }

    // SPA fallback
    return new Response(Bun.file("index.html"));
  },
});

console.log(`Dev: http://localhost:${server.port}`);
