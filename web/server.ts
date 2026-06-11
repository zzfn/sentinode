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

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  async fetch(req) {
    const path = new URL(req.url).pathname;

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
