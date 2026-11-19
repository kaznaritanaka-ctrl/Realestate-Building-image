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

// ガイドページ用：管轄法務局テーブル（src/houmukyoku.ts）を JSON 化して静的配信する（単一の正は TS 側）
import { readFileSync, writeFileSync } from "node:fs";
{
  const srcText = readFileSync("src/houmukyoku.ts", "utf8");
  const grouped = {};
  for (const m of srcText.matchAll(/"([^"]+?(?:都|道|府|県)[^"]*)":\s*\{\s*office:\s*"([^"]+)",\s*url:\s*"([^"]+)"\s*\}/g)) {
    const pref = m[1].match(/^(?:北海道|東京都|.+?県|.+?府)/)[0];
    const city = m[1].slice(pref.length);
    (grouped[pref] ??= {})[city] = { office: m[2], url: m[3] };
  }
  for (const pref of Object.keys(grouped)) {
    grouped[pref] = Object.fromEntries(Object.entries(grouped[pref]).sort(([a], [b]) => a.localeCompare(b, "ja")));
  }
  writeFileSync("site/assets/houmukyoku.json", JSON.stringify(grouped));
  console.log("houmukyoku.json:", Object.values(grouped).reduce((n, g) => n + Object.keys(g).length, 0), "件");
}
