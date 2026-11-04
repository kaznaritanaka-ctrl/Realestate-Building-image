// フロントエンドのビルド：src/app.ts → site/assets/app.js（依存ライブラリを同梱）
import { build } from "esbuild";
import { copyFileSync } from "node:fs";

await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  outfile: "site/assets/app.js",
  legalComments: "linked",
  logLevel: "info",
});
await build({
  entryPoints: ["src/lp.ts"], bundle: true, minify: true, format: "iife", target: ["es2020"],
  outfile: "site/assets/lp.js", logLevel: "info",
});
copyFileSync("node_modules/maplibre-gl/dist/maplibre-gl.css", "site/assets/maplibre-gl.css");
