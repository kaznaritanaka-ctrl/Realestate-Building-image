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
await build({
  entryPoints: ["src/inherit/wizard.ts"], bundle: true, minify: true, format: "iife", target: ["es2020"],
  outfile: "site/assets/inherit-pack.js", logLevel: "info",
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
  // 市区町村は読みの50音順に並べる（読みは総務省「全国地方公共団体コード」による。郡名つきは町村名の読み）
  const KANA = JSON.parse(readFileSync("src/city-kana.json", "utf8"));
  const missing = [];
  for (const pref of Object.keys(grouped)) {
    const yomi = (c) => KANA[pref]?.[c] ?? (missing.push(pref + c), c);
    grouped[pref] = Object.fromEntries(Object.entries(grouped[pref]).sort(([a], [b]) => yomi(a).localeCompare(yomi(b), "ja") || a.localeCompare(b, "ja")));
  }
  if (missing.length) throw new Error(`市区町村の読みがありません（src/city-kana.json に追加してください）: ${[...new Set(missing)].join("、")}`);
  writeFileSync("site/assets/houmukyoku.json", JSON.stringify(grouped));
  console.log("houmukyoku.json:", Object.values(grouped).reduce((n, g) => n + Object.keys(g).length, 0), "件");
}

// 都道府県別ページ（相続ガイド配下）：対応表（src/houmukyoku.ts）から47ページを静的生成する。単一の正は対応表。
{
  const srcText = readFileSync("src/houmukyoku.ts", "utf8");
  const PREFS = [
    ["北海道", "hokkaido"], ["青森県", "aomori"], ["岩手県", "iwate"], ["宮城県", "miyagi"], ["秋田県", "akita"], ["山形県", "yamagata"], ["福島県", "fukushima"],
    ["茨城県", "ibaraki"], ["栃木県", "tochigi"], ["群馬県", "gunma"], ["埼玉県", "saitama"], ["千葉県", "chiba"], ["東京都", "tokyo"], ["神奈川県", "kanagawa"],
    ["新潟県", "niigata"], ["富山県", "toyama"], ["石川県", "ishikawa"], ["福井県", "fukui"], ["山梨県", "yamanashi"], ["長野県", "nagano"], ["岐阜県", "gifu"], ["静岡県", "shizuoka"], ["愛知県", "aichi"], ["三重県", "mie"],
    ["滋賀県", "shiga"], ["京都府", "kyoto"], ["大阪府", "osaka"], ["兵庫県", "hyogo"], ["奈良県", "nara"], ["和歌山県", "wakayama"],
    ["鳥取県", "tottori"], ["島根県", "shimane"], ["岡山県", "okayama"], ["広島県", "hiroshima"], ["山口県", "yamaguchi"],
    ["徳島県", "tokushima"], ["香川県", "kagawa"], ["愛媛県", "ehime"], ["高知県", "kochi"],
    ["福岡県", "fukuoka"], ["佐賀県", "saga"], ["長崎県", "nagasaki"], ["熊本県", "kumamoto"], ["大分県", "oita"], ["宮崎県", "miyazaki"], ["鹿児島県", "kagoshima"], ["沖縄県", "okinawa"],
  ];
  // 市区町村の中で管轄が分かれる地域の注意（2026-11-20に各法務局の公式一覧で確認した範囲）
  const NOTES = {
    "千葉県": ["成田市は、市の大部分が成田出張所の管轄ですが、旧香取郡大栄町・下総町の地域は香取支局の管轄です。上の表では成田出張所を表示しています。"],
    "新潟県": ["新潟市北区は、旧豊栄市の地域が新発田支局、それ以外が本局の管轄です。上の表では本局を表示しています。"],
    "岐阜県": ["下呂市は、金山町の地域だけ管轄が分かれます。上の表では高山支局を表示しています。金山町の土地は、申請前に公式案内でご確認ください。"],
    "福井県": ["若狭町は、小浜支局の管轄に属する地域があります。上の表では敦賀支局を表示しています。"],
    "愛媛県": ["松山市は、市内の一部の町が砥部出張所の管轄です。上の表では松山（本局）を表示しています。"],
  };
  const byPref = new Map(PREFS.map(([p]) => [p, []]));
  for (const m of srcText.matchAll(/"([^"]+?(?:都|道|府|県)[^"]*)":\s*\{\s*office:\s*"([^"]+)",\s*url:\s*"([^"]+)"\s*\}/g)) {
    const pref = m[1].match(/^(?:北海道|東京都|.+?県|.+?府)/)[0];
    if (byPref.has(pref)) byPref.get(pref).push({ city: m[1].slice(pref.length), office: m[2], url: m[3] });
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  mkdirSync("site/guide/inherit", { recursive: true });
  let made = 0;
  for (const [pref, slug] of PREFS) {
    const rows = byPref.get(pref);
    if (!rows.length) throw new Error(`都道府県ページ: ${pref} のデータがありません`);
    const url = `https://realestate.ai-investment-research.net/guide/inherit/${slug}`;
    const title = `${pref}で土地を相続したら：市区町村ごとの管轄法務局と手続きの期限｜土地の未来図`;
    const desc = `${pref}で土地や実家を相続したときの管轄法務局を、${pref}の全${rows.length}市区町村について一覧にしました。質問に答えると、相続登記などの期限と必要な手続きを一覧にでき、チェックリストやカレンダーに書き出せます。`;
    const bureauLinks = [...new Map(rows.map((r) => [r.url, r.office.split(" ")[0].replace(/（本局）|\(本局\)/g, "")])).entries()]
      .map(([u, name]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(name)}の管轄区域一覧（公式）</a></li>`).join("\n");
    const tableRows = rows.map((r) => `<tr><td>${esc(r.city)}</td><td><a href="${r.url}" target="_blank" rel="noopener">${esc(r.office)}</a></td></tr>`).join("\n");
    const notes = NOTES[pref]
      ? `\n<h2>管轄が分かれる地域について</h2>\n<ul>\n${NOTES[pref].map((n) => `<li>${esc(n)}</li>`).join("\n")}\n</ul>\n`
      : "";
    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://realestate.ai-investment-research.net/assets/ogp-v2.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="https://realestate.ai-investment-research.net/assets/ogp-v2.png">
<link rel="stylesheet" href="/assets/style.css">
<script type="application/ld+json">
{
"@context": "https://schema.org",
"@type": "Article",
"headline": "${pref}で土地を相続したら：市区町村ごとの管轄法務局と手続きの期限",
"description": "${desc}",
"datePublished": "2026-11-20",
"dateModified": "2026-11-23",
"inLanguage": "ja",
"author": { "@type": "Person", "name": "田中 一成" },
"publisher": { "@type": "Person", "name": "田中 一成" },
"mainEntityOfPage": "${url}",
"image": "https://realestate.ai-investment-research.net/assets/ogp-v2.png"
}
</script>
</head>
<body>
<header class="site">
<div class="wrap"><a class="brand" href="/">土地の未来図<small>不動産3Dイメージサービス</small></a></div>
</header>
<main class="wrap doc guide">
<p class="small"><a href="/guide/inherit">相続した土地・実家の進め方</a> ＞ ${pref}</p>
<h1>${pref}で相続した土地の管轄法務局</h1>
<p>相続登記（名義変更）の申請先は、土地の所在地を管轄する法務局です。<br>${pref}の${rows.length}市区町村について、管轄の法務局をまとめました。<br>2024年4月から相続登記は義務化され、期限は相続を知った日から3年以内です（それより前に始まった相続は2027年3月31日まで）。<br>手続き全体の流れは<a href="/guide/inherit">相続ガイド</a>にまとめています。</p>

<h2 id="tool">あなたの相続の手続きを確認する</h2>
<p>7つの画面で質問に答えると、${pref}の管轄法務局を含めて、あなたに必要な手続きが期限の近い順に並びます。<br>済ませた手続きにチェックを付けると、まだの手続きと分けて一覧にでき、表（シート）やカレンダーに書き出せます。<br>入力した内容はこの端末の中だけで処理され、どこにも送信されません。</p>
<div id="inherit-pack" class="pack-root" data-pref="${pref}"><p class="small">読み込み中です。表示されない場合は、ブラウザのJavaScriptを有効にしてください。</p></div>

<h2>${pref}の市区町村と管轄法務局</h2>
<p>法務局の名前を押すと、公式の管轄区域一覧が開きます。</p>
<table class="jurisdiction"><thead><tr><th>市区町村</th><th>管轄の法務局</th></tr></thead><tbody>
${tableRows}
</tbody></table>
${notes}
<h2>公式の案内</h2>
<ul>
${bureauLinks}
<li><a href="https://www.moj.go.jp/MINJI/minji05_00599.html" target="_blank" rel="noopener">法務省「相続登記の義務化について」</a></li>
</ul>

<h2>相続した土地の条件を確認する</h2>
<p>管轄が分かったら、相続した土地に何が建つかも確認できます。<br>土地の形と用途を入れると、建物の案を3Dで表示します。</p>
<p class="cta-row"><a class="cta" href="/new?s=inherit">相続した土地で3案を見る</a></p>

<h2 id="notes">ご利用にあたって</h2>
<ul class="small">
<li>管轄法務局の一覧は、各地方法務局の公式「不動産登記／商業・法人登記の管轄区域一覧」をもとに作成し、2026年11月20日に確認しました。<br>管轄は統廃合で変わることがあるため、申請前に公式案内でご確認ください。</li>
<li>本ページの手続きの説明は一般的な流れの紹介で、個別の事情への助言ではありません。<br>具体的な判断は専門家にご相談ください。</li>
<li>「土地の未来図」の3Dと規模は参考のイメージと概算で、建築できることや売却価格を保証するものではありません。</li>
</ul>
<p class="updated">掲載日：2026年11月20日／更新日：2026年11月23日</p>
</main>
<footer class="site">
<div class="wrap">
<nav><a href="/guide/house">土地に自宅を建てる前に、間取りプランを無料で比べる</a><a href="/guide/land-use">土地を収益化する前に、複数社の活用プランを無料で比べる</a><a href="/guide/sell">土地を手放す前に、複数社の売却査定を無料で比べる</a><a href="/guide/akiya">空き家・古い家のこれからを、選択肢ごとに整理する</a><a href="/guide/inherit">相続した土地・実家の進め方を、手続きと選択肢から整理する</a><a href="/terms">利用規約・注意事項</a><a href="/privacy">プライバシーポリシー</a><a href="/ad-policy">広告掲載方針</a><a href="/about">運営者情報</a></nav>
<p>© 2026 土地の未来図</p>
</div>
</footer>
<script src="/assets/guide.js" defer></script>
<script src="/assets/inherit-pack.js" defer></script>
</body>
</html>
`;
    writeFileSync(`site/guide/inherit/${slug}.html`, html);
    made++;
  }
  console.log("pref pages:", made, "ページ");
}

// 手続きごとの静的ページ（/guide/inherit/tetsuzuki/<id>）：手続きマスタ（src/inherit/master.ts）から生成する。単一の正はマスタ。
{
  mkdirSync("node_modules/.cache", { recursive: true });
  await build({ entryPoints: ["src/inherit/master.ts"], bundle: true, format: "esm", platform: "node", outfile: "node_modules/.cache/inherit-master.mjs", logLevel: "warning" });
  const { PROCEDURES, CONSULT, OFFICE_LABEL, CHECKED, CHECKED_JA, CATEGORY_ORDER } = await import(`../node_modules/.cache/inherit-master.mjs?${Date.now()}`);
  const SITE = "https://realestate.ai-investment-research.net";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const FOOTER = `<footer class="site">
<div class="wrap">
<nav><a href="/guide/house">土地に自宅を建てる前に、間取りプランを無料で比べる</a><a href="/guide/land-use">土地を収益化する前に、複数社の活用プランを無料で比べる</a><a href="/guide/sell">土地を手放す前に、複数社の売却査定を無料で比べる</a><a href="/guide/akiya">空き家・古い家のこれからを、選択肢ごとに整理する</a><a href="/guide/inherit">相続した土地・実家の進め方を、手続きと選択肢から整理する</a><a href="/terms">利用規約・注意事項</a><a href="/privacy">プライバシーポリシー</a><a href="/ad-policy">広告掲載方針</a><a href="/about">運営者情報</a></nav>
<p>© 2026 土地の未来図</p>
</div>
</footer>`;
  const head = (title, desc, url, jsonld) => `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/assets/ogp-v2.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/assets/style.css">
<script type="application/ld+json">
${JSON.stringify(jsonld)}
</script>
</head>
<body>
<header class="site">
<div class="wrap"><a class="brand" href="/">土地の未来図<small>不動産3Dイメージサービス</small></a></div>
</header>`;
  const blank = { a: {}, death: null, known: null };
  mkdirSync("site/guide/inherit/tetsuzuki", { recursive: true });
  const urls = [];
  for (const p of PROCEDURES) {
    const url = `${SITE}/guide/inherit/tetsuzuki/${p.id}`;
    const title = `${p.title}：期限と窓口、進め方｜相続の手続き｜土地の未来図`;
    const due = p.due(blank).text;
    const consult = CONSULT[p.office].map((c) => `<li>${c.url ? `<a href="${c.url}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}${c.tel ? `（${esc(c.tel)}）` : ""}</li>`).join("\n");
    const others = PROCEDURES.filter((x) => x.cat === p.cat && x.id !== p.id).map((x) => `<li><a href="/guide/inherit/tetsuzuki/${x.id}">${esc(x.title)}</a></li>`).join("\n");
    const html = `${head(title, p.summary, url, { "@context": "https://schema.org", "@type": "Article", headline: p.title, description: p.summary, datePublished: CHECKED, dateModified: CHECKED, inLanguage: "ja", author: { "@type": "Person", name: "田中 一成" }, publisher: { "@type": "Person", name: "田中 一成" }, mainEntityOfPage: url, image: `${SITE}/assets/ogp-v2.png` })}
<main class="wrap doc guide">
<p class="small"><a href="/guide/inherit">相続した土地・実家の進め方</a> ＞ <a href="/guide/inherit/tetsuzuki">相続の手続き一覧</a> ＞ ${esc(p.cat)}</p>
<h1>${esc(p.title)}</h1>
<p class="lead">${esc(p.summary)}</p>
<table class="jurisdiction"><tbody>
<tr><th>期限</th><td>${esc(due)}</td></tr>
<tr><th>窓口</th><td>${esc(OFFICE_LABEL[p.office])}</td></tr>
<tr><th>まずすること</th><td>${esc(p.action)}</td></tr>
</tbody></table>
${p.docs?.length ? `<h2>主に要るもの</h2>\n<ul>\n${p.docs.map((d) => `<li>${esc(d)}</li>`).join("\n")}\n</ul>` : ""}
${p.notes?.length ? `<h2>知っておきたいこと</h2>\n<ul>\n${p.notes.map((d) => `<li>${esc(d)}</li>`).join("\n")}\n</ul>` : ""}
<h2>期限を過ぎたとき・迷ったときの相談先</h2>
<ul>
${consult}
</ul>
<h2>あなたの場合の期限を確認する</h2>
<p>相続の手続きは、家族構成や財産の内容で必要なものが変わります。<br>いくつかの質問に答えると、この手続きを含めて、あなたに必要な手続きが期限の近い順に並びます。<br>入力した内容はこの端末の中だけで処理され、どこにも送信されません。</p>
<p class="cta-row"><a class="cta" href="/guide/inherit#tool">手続きパックを作る</a></p>
${others ? `<h2>同じ段階の手続き</h2>\n<ul>\n${others}\n</ul>` : ""}
<h2 id="notes">出典とご利用にあたって</h2>
<ul class="small">
${p.sources.map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join("\n")}
<li>内容は${CHECKED_JA}に公式の案内で確認しました。制度は変わることがあるため、手続きの前に窓口や公式の案内でご確認ください。</li>
<li>一般的な手続きの紹介で、個別の事情への助言ではありません。具体的な判断は専門家にご相談ください。</li>
</ul>
<p class="updated">掲載日：${CHECKED_JA}</p>
</main>
${FOOTER}
<script src="/assets/guide.js" defer></script>
</body>
</html>
`;
    writeFileSync(`site/guide/inherit/tetsuzuki/${p.id}.html`, html);
    urls.push(url);
  }
  // 一覧ページ
  const listUrl = `${SITE}/guide/inherit/tetsuzuki`;
  const listDesc = "相続が起きたあとの手続きを、死亡直後・年金と保険・相続人と財産の確認・相続の仕方の判断・分け方・税金・名義変更・土地の届出の段階ごとに、期限と窓口つきで一覧にしました。";
  const sections = CATEGORY_ORDER.map((c) => {
    const ps = PROCEDURES.filter((p) => p.cat === c);
    if (!ps.length) return "";
    return `<h2>${esc(c)}</h2>\n<ul class="tetsuzuki-list">\n${ps.map((p) => `<li><a href="/guide/inherit/tetsuzuki/${p.id}">${esc(p.title)}</a><br><span class="small">${esc(p.due(blank).text)}</span></li>`).join("\n")}\n</ul>`;
  }).join("\n");
  writeFileSync("site/guide/inherit/tetsuzuki.html", `${head("相続の手続き一覧：期限と窓口を段階ごとに｜土地の未来図", listDesc, listUrl, { "@context": "https://schema.org", "@type": "Article", headline: "相続の手続き一覧", description: listDesc, datePublished: CHECKED, dateModified: CHECKED, inLanguage: "ja", author: { "@type": "Person", name: "田中 一成" }, publisher: { "@type": "Person", name: "田中 一成" }, mainEntityOfPage: listUrl, image: `${SITE}/assets/ogp-v2.png` })}
<main class="wrap doc guide">
<p class="small"><a href="/guide/inherit">相続した土地・実家の進め方</a> ＞ 相続の手続き一覧</p>
<h1>相続の手続き一覧</h1>
<p class="lead">${esc(listDesc)}</p>
<p>あなたに必要なものだけを期限の近い順に並べるには、<a href="/guide/inherit#tool">手続きパック</a>を使ってください。</p>
${sections}
<p class="small">内容は${CHECKED_JA}に公式の案内で確認しました。一般的な手続きの紹介で、個別の事情への助言ではありません。</p>
<p class="updated">掲載日：${CHECKED_JA}</p>
</main>
${FOOTER}
<script src="/assets/guide.js" defer></script>
</body>
</html>
`);
  urls.unshift(listUrl);
  // sitemap に未登録のURLを足す（既存の行は触らない）
  let sm = readFileSync("site/sitemap.xml", "utf8");
  const add = urls.filter((u) => !sm.includes(`<loc>${u}</loc>`)).map((u) => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${CHECKED}</lastmod>\n  </url>\n`).join("");
  if (add) { sm = sm.replace("</urlset>", add + "</urlset>"); writeFileSync("site/sitemap.xml", sm); }
  console.log("tetsuzuki pages:", PROCEDURES.length, "ページ＋一覧");
}
