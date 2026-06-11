import { $ } from "bun";

const API_BASE = process.env.API_BASE ?? "";
const OUTDIR = "dist";

// Tailwind CSS
await $`bunx @tailwindcss/cli -i ./src/globals.css -o ${OUTDIR}/globals.css --minify`;

// JS bundle
const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: OUTDIR,
  target: "browser",
  minify: true,
  define: { "process.env.API_BASE": JSON.stringify(API_BASE) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// 静态文件
await $`cp index.html favicon.svg _redirects ${OUTDIR}/`;

console.log("Build complete");
