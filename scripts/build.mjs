// フロントエンドのビルド：src/app.ts → site/assets/app/（依存ライブラリを同梱）
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

// 入力画面のプログラムは2つに分ける：地図と入力（app.js）を先に読み、3D（three.js など）は別のファイルにして入力中に読み込む
rmSync("site/assets/app", { recursive: true, force: true });
await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  splitting: true,
  target: ["es2020"],
  outdir: "site/assets/app",
  entryNames: "app",
  chunkNames: "c-[hash]",
  legalComments: "linked",
  // 依存ライブラリ内の new URL(..., import.meta.url)（Workerの場所指定）はページの場所を基準にする（分割前と同じ動き）
  define: { "import.meta.url": "document.baseURI" },
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
