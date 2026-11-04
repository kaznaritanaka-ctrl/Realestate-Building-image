// フロントエンドのビルド：src/app.ts → site/assets/app.js（依存ライブラリを同梱）
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

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

// 3D Tiles のデコーダー（Draco・Basis）を自前配信する（CSPで外部スクリプトを許可しないため）
mkdirSync("site/assets/draco", { recursive: true });
for (const f of ["draco_wasm_wrapper.js", "draco_decoder.wasm", "draco_decoder.js"]) copyFileSync(`node_modules/three/examples/jsm/libs/draco/${f}`, `site/assets/draco/${f}`);
mkdirSync("site/assets/basis", { recursive: true });
for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) copyFileSync(`node_modules/three/examples/jsm/libs/basis/${f}`, `site/assets/basis/${f}`);
