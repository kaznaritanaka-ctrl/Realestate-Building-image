import type { EngineResult, Plan } from "../engine/engine.ts";
import type { SiteInfo } from "./siteinfo.ts";

// A4横・3ページ固定の相談準備レポート。入力・描画はブラウザ内で完結し、PDFをサーバーへ送らない。
// 本レポートは敷地中心点の公開データを利用する参考資料であり、建築確認・重要事項説明には使えない。
export interface ReportInput {
  result: EngineResult;
  info: SiteInfo | null;
  images: string[];
  isSample: boolean;
  preparedAt: Date;
  styleName: string;
  center?: [number, number]; // 経度・緯度（ユーザーが明示的にPDFを保存するときだけ印刷）
  mapImage?: string | null;   // 位置図（地理院タイルを端末内でつないだ画像）
  sitePlan?: { poly: [number, number][]; edges: string[] } | null; // 敷地図用：東・北方向のメートル座標と各辺の道路幅
}
type Hit = { props: Record<string, unknown>; d?: number };
type Layer = { found?: number; hits?: Hit[]; error?: string };
const html = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const text = (v: unknown): string => v == null || v === "" ? "未確認" : String(v);
const row = (k: string, v: string, tag = ""): string => '<tr><th>' + html(k) + '</th><td>' + v + (tag ? '<span class="rp-tag">' + html(tag) + '</span>' : "") + '</td></tr>';
const money = (v: number) => v >= 10000 ? (v / 10000).toFixed(1) + "億円" : v.toLocaleString("ja-JP") + "万円";
const isData = (l: Layer | undefined): boolean => !!l && !l.error && typeof l.found === "number";
const getHits = (l: Layer | undefined): Hit[] => isData(l) ? l!.hits ?? [] : [];
const status = (l: Layer | undefined): string => !isData(l) ? "未取得・要確認" : l!.found ? "区域内（参考）" : "地点の該当データなし";
const value = (v: unknown): string => html(text(v));
const list = (items: string[]) => '<ul class="rp-checks">' + items.map(x => "<li>" + html(x) + "</li>").join("") + "</ul>";
function reportPage(index: number, title: string, body: string, footer: string): string {
  return '<article class="rp-page rp-page-' + index + '">' +
    '<header class="rp-head"><div><small>土地の未来図 / 土地調査・建築イメージレポート</small><h2>' + html(title) + '</h2></div><b>0' + index + ' / 03</b></header>' +
    '<div class="rp-body">' + body + '</div><footer class="rp-footer"><span>' + footer + '</span><span>参考資料・設計／法令適合の保証なし</span></footer></article>';
}
function renderPlan(p: Plan, image: string | undefined): string {
  const m = p.metrics;
  const summary = m.gfa > 0
    ? m.floors + "階 / 延床約" + m.gfa + "㎡"
    : "駐車" + m.parking + "台";
  return '<section class="rp-card rp-plan"><div class="rp-card-title"><strong>' + html(p.title) + '</strong><span>' + html(summary) + '</span></div>' +
    (image ? '<img src="' + html(image) + '" alt="' + html(p.title) + 'の参考3Dイメージ">' : '<p class="rp-missing">画像未取得</p>') +
    '<div class="rp-card-meta"><span>' + html(p.subtitle) + '</span><span>概算工事費 ' + html(money(m.costMin)) + '〜' + html(money(m.costMax)) + '</span></div></section>';
}

export function buildSiteReport({ result, info, images, isSample, preparedAt, styleName, center, mapImage, sitePlan }: ReportInput): string {
  const s = result.site;
  const layers = info?.info ?? {};
  const layer = (id: string): Layer | undefined => layers[id];
  const hit = (id: string): Record<string, unknown> => getHits(layer(id))[0]?.props ?? {};
  const a = info?.address;
  // 所在は町字までの目安。地番は利用者がプレビュー画面で書き込める（data-lot。端末の外には出さない）
  const sourceInfo = isSample ? "サンプル敷地（架空）"
    : (a ? html(a.pref + a.city + a.town) + " 付近" : "利用者指定の敷地（所在地は未取得）") +
      '<br><small class="rp-lot">地番：<span data-lot>（未記入）</span></small>';
  const centerText = isSample || !center ? "非表示" : center[1].toFixed(5) + ", " + center[0].toFixed(5) + "（参照点）";
  const dateText = preparedAt.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const zoneStatus = ({ confirmed: "確認済み", public: "公的資料・参考", reference: "代表値", guess: "推定", user: "利用者入力", unknown: "未確認" } as Record<string, string>);
  const landTable = [
    row("所在", sourceInfo, isSample ? "" : "座標から求めた目安"), row("敷地面積", '約' + s.area + '㎡（約' + (s.area / 3.30579).toFixed(1) + '坪）', "利用者指定"),
    row("参照地点（緯度・経度）", html(centerText), "敷地中心目安"),
    row("用途地域", html(s.zone.label), zoneStatus[result.certainty.zone] ?? "参考"),
    row("指定建ぺい率 / 容積率", s.bcr + "% / " + s.far + "%", zoneStatus[result.certainty.bcrFar] ?? "参考"),
    row("前面道路幅員", s.roadWidth == null ? "未確認" : "約" + s.roadWidth + "mとして計算", zoneStatus[result.certainty.road] ?? "参考"),
    row("建物外観", html(styleName), "選択した表示スタイル"),
  ].join("");
  // 相談メモ：プレビュー画面で選んだ内容を data-memo に差し込む（端末の外には出さない）
  const memo = MEMO_GROUPS.map(g => row(g.label, '<span data-memo="' + g.key + '">（未選択）</span>')).join("");
  const page1 = '<div class="rp-p1">' +
    '<section class="rp-card rp-overview"><h3>対象土地の概要</h3><table class="rp-table">' + landTable + '</table>' +
    (isSample ? "" : '<h3 class="rp-sub">相談メモ</h3><table class="rp-table rp-memo">' + memo + '</table>') +
    '<p class="rp-fine">敷地形状は利用者の概略入力です。土地境界・測量結果や実際の建築可能性を確定するものではありません。</p></section>' +
    '<section class="rp-card rp-map"><h3>位置図</h3>' + (mapImage ? '<img src="' + html(mapImage) + '" alt="位置図">' : '<p class="rp-missing">' + (isSample ? "サンプルのため位置図はありません" : "位置図を取得できませんでした") + '</p>') +
    '<p class="rp-fine">赤枠が入力した敷地の目安です。出典：国土地理院 地理院タイル</p></section>' +
    '<section class="rp-card rp-siteplan"><h3>敷地図（概略）</h3>' + (sitePlan && sitePlan.poly.length >= 3 ? sitePlanSvg(sitePlan.poly, sitePlan.edges) : '<p class="rp-missing">敷地図を作れませんでした</p>') + '</section>' +
    result.plans.map((p,i) => renderPlan(p, images[i])).join("") + '</div>';

  const fire = hit("XKT014");
  const urf = hit("XKT003");
  const road = layer("XKT030");
  const legalRows = [
    row("区域区分", value(hit("XKT001").area_classification_ja ?? status(layer("XKT001"))), "地点の公開情報"),
    row("用途地域", html(s.zone.label), zoneStatus[result.certainty.zone] ?? "参考"),
    row("指定建ぺい率", s.bcr + "%", zoneStatus[result.certainty.bcrFar] ?? "参考"),
    row("指定容積率 / 計算上の上限", s.far + "% / " + s.farEffective + "%", "後者は当サイトの試算"),
    row("防火・準防火地域", value(fire.fire_prevention_ja ?? status(layer("XKT014"))), "地点判定"),
    row("地区計画", getHits(layer("XKT023")).length ? "区域内：個別規則の確認が必要" : status(layer("XKT023"))),
    row("高度利用地区", status(layer("XKT024")), "高度地区とは別制度"),
    row("立地適正化計画", value(urf.kubun_name_ja ?? status(layer("XKT003"))), "区域の参考"),
    row("都市計画道路", isData(road) && road!.found ? "参照点から約" + (road!.hits?.[0]?.d ?? "?") + "m" : status(road), "敷地との交差は未判定"),
    row("建築基準法上の道路種別", "未確認：自治体の指定道路図・現地で確認"),
    row("接道要件・セットバック", "未確認：利用者指定幅員だけでは確定できません"),
    row("高度地区・北側斜線・日影規制", "未判定：自治体・設計者に確認"),
  ];
  const legalChecks = [
    "建築基準法上の道路種別・実際の幅員・接道長さ・セットバック",
    "高度地区、北側斜線、日影規制、地区計画、その他の自治体独自規制",
    "敷地境界・地積測量図、現況と公的情報の相違",
  ];
  if (status(layer("XKT001")).includes("未取得")) legalChecks.unshift("市街化区域・市街化調整区域などの区域区分");
  const page2 = '<div class="rp-columns"><section><h3>都市計画・建築条件</h3><table class="rp-table">' + legalRows.join("") + '</table></section>' +
    '<aside class="rp-side"><h3>専門家に確認したい事項</h3>' + list(legalChecks) +
    '<p class="rp-note"><b>データの扱い</b><br>公的GISデータの地点照会・利用者入力・当サービスの簡易計算を区別しています。「該当データなし」は法的な規制の不存在を保証しません。</p>' +
    '<p class="rp-source">出典：国土交通省 不動産情報ライブラリ（都市計画決定GISデータほか）／利用者入力／土地の未来図による参考計算。資料の整備時期は各原典によります。</p></aside></div>';

  const flood = getHits(layer("XKT026"));
  const floodRanks = flood.map(h=>Number(h.props.A31a_205)).filter(v=>Number.isFinite(v)&&v>0);
  const floodLabels: Record<number,string> = {1:"0.5m未満",2:"0.5〜3m未満",3:"3〜5m未満",4:"5〜10m未満",5:"10〜20m未満",6:"20m以上"};
  const floodText = flood.length ? "想定区域内：" + (floodRanks.length ? floodLabels[Math.max(...floodRanks)] ?? "深さ区分要確認" : "浸水深未取得") : status(layer("XKT026"));
  const tide = hit("XKT027");
  const liq = hit("XKT025");
  const disaster = getHits(layer("XST001")).slice(0, 2).map(h => String(h.props.disaster_name_ja ?? "災害") + (h.props.disaster_date ? "（記録日：" + String(h.props.disaster_date) + "）" : "")).join(" / ");
  const elev = info?.elevation;
  const landRows = [
    row("洪水浸水想定（想定最大規模）", html(floodText), "地点の参考情報"),
    row("高潮浸水想定", value(tide.A49_003 ?? status(layer("XKT027"))), "地点の参考情報"),
    row("土砂災害警戒区域", status(layer("XKT029")), "データの商用利用条件を要確認"),
    row("大規模盛土造成地", status(layer("XKT020"))),
    row("液状化の発生傾向", value(liq.note ?? status(layer("XKT025"))), "地形区分に基づく傾向"),
    row("調査で収録された過去の災害", disaster ? html(disaster) : status(layer("XST001")), "網羅的な災害履歴ではありません"),
    row("参照地点の標高（地形）", elev && typeof elev.value === "number" ? elev.value.toFixed(1) + "m（" + html(elev.hsrc ?? "標高モデル") + "）" : "未取得", "敷地の高低差は未判定"),
    row("津波浸水想定", "未取得（利用条件の確認中）"),
    row("地盤強度・擁壁・造成の必要性", "未判定：現地・専門家の調査が必要"),
  ];
  const hazardChecks = [
    "自治体の最新の洪水・高潮・土砂災害・津波ハザードマップ",
    "敷地の標高差・擁壁・過去の造成履歴・必要な地盤調査",
    "災害区域データは敷地中心付近を照会。敷地の一部だけにかかる規制を見落とす可能性",
  ];
  const page3 = '<div class="rp-columns"><section><h3>災害・地形の参考情報</h3><table class="rp-table">' + landRows.join("") + '</table></section>' +
    '<aside class="rp-side"><h3>次に確認すること</h3>' + list(hazardChecks) +
    '<p class="rp-note"><b>重要</b><br>この資料は自治体の最新ハザードマップや法定の重要事項説明、建築確認、地盤調査の代替ではありません。対象地点と敷地全域の判定は異なります。</p>' +
    '<p class="rp-source">出典：国土交通省 不動産情報ライブラリ（国土数値情報等）、国土地理院標高データ（取得時のみ）。各データの基準年・配信範囲・原典に留意してください。</p></aside></div>';

  const foot = "作成 " + html(dateText) + " / 参照時点の情報";
  return '<div class="rp-document">' +
    reportPage(1, "土地概要と建築イメージ A・B・C", page1, foot) +
    reportPage(2, "都市計画・建築関連の参考情報", page2, foot) +
    reportPage(3, "災害・地形情報と確認事項", page3, foot) +
    '</div>';
}

/** 相談メモの選択肢（すべて選ぶだけ。自由記入はしない） */
export const MEMO_GROUPS: { key: string; label: string; multi: boolean; options: string[] }[] = [
  { key: "purpose", label: "相談したいこと", multi: true, options: ["売却", "賃貸・土地活用", "自宅の建築", "相続・名義", "相場を知りたい"] },
  { key: "state", label: "土地の今の状態", multi: false, options: ["更地", "古家あり", "駐車場", "農地", "その他"] },
  { key: "owner", label: "名義", multi: false, options: ["本人", "家族", "共有", "相続手続き中"] },
  { key: "when", label: "希望の時期", multi: false, options: ["3か月以内", "半年以内", "1年以内", "未定"] },
];

const WIDTH_LABEL: Record<string, string> = { lt4: "4m未満", "4to6": "4〜6m", "6to12": "6〜12m", gte12: "12m以上" };
const WIDTH_DRAW: Record<string, number> = { lt4: 3.5, "4to6": 5, "6to12": 8, gte12: 10 };
/** 敷地図（北が上）。辺の長さ・道路の位置と幅・方位・縮尺 */
export function sitePlanSvg(poly: [number, number][], edges: string[]): string {
  const n = poly.length;
  let area2 = 0; for (let i = 0; i < n; i++) { const [a, b] = poly[i], [c, d] = poly[(i + 1) % n]; area2 += a * d - c * b; }
  const out = area2 > 0 ? 1 : -1; // 左回りなら辺の右側が外側
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const roadMax = Math.max(0, ...edges.map(e => WIDTH_DRAW[e] ?? 0));
  const pad = Math.max(roadMax + 2.5, 0.14 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), 4);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const W = maxX - minX, H = maxY - minY, f = (v: number) => v.toFixed(2);
  const X = (x: number) => x - minX, Y = (y: number) => maxY - y; // SVG は下向きが正
  const fs = Math.max(W, H) / 26;
  let roads = "", labels = "";
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
    const L = Math.hypot(x2 - x1, y2 - y1); if (L < 0.01) continue;
    const tx = (x2 - x1) / L, ty = (y2 - y1) / L, nx = ty * out, ny = -tx * out; // 外向き
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const w = edges[i] && edges[i] !== "none" ? edges[i] : "";
    let ang = Math.atan2(-(y2 - y1), x2 - x1) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    if (w) {
      const d = WIDTH_DRAW[w] ?? 5;
      const q = [[x1 - tx * 4, y1 - ty * 4], [x2 + tx * 4, y2 + ty * 4], [x2 + tx * 4 + nx * d, y2 + ty * 4 + ny * d], [x1 - tx * 4 + nx * d, y1 - ty * 4 + ny * d]];
      roads += '<polygon points="' + q.map(([x, y]) => f(X(x)) + "," + f(Y(y))).join(" ") + '" fill="#d9dee0" stroke="#b9c2c5" stroke-width="' + f(fs * 0.06) + '"/>';
      const lx = mx + nx * d / 2, ly = my + ny * d / 2;
      labels += '<text x="' + f(X(lx)) + '" y="' + f(Y(ly)) + '" font-size="' + f(fs * 0.85) + '" fill="#40545a" text-anchor="middle" dominant-baseline="middle" transform="rotate(' + f(ang) + ' ' + f(X(lx)) + ' ' + f(Y(ly)) + ')">道路 幅' + (WIDTH_LABEL[w] ?? "") + '</text>';
    }
    // 辺の長さ（敷地の内側に書く）
    const ix = mx - nx * fs * 0.9, iy = my - ny * fs * 0.9;
    labels += '<text x="' + f(X(ix)) + '" y="' + f(Y(iy)) + '" font-size="' + f(fs) + '" fill="#1f3339" font-weight="700" text-anchor="middle" dominant-baseline="middle" transform="rotate(' + f(ang) + ' ' + f(X(ix)) + ' ' + f(Y(iy)) + ')">' + L.toFixed(1) + 'm</text>';
  }
  const pts = poly.map(([x, y]) => f(X(x)) + "," + f(Y(y))).join(" ");
  // 縮尺（5m か 10m）と方位
  const bar = Math.max(W, H) > 60 ? 20 : Math.max(W, H) > 30 ? 10 : 5;
  const bx = fs, by = fs * 2; // 縮尺は左上（道路の帯と重ならないように）
  const scale = '<g stroke="#1f3339" stroke-width="' + f(fs * 0.12) + '"><line x1="' + f(bx) + '" y1="' + f(by) + '" x2="' + f(bx + bar) + '" y2="' + f(by) + '"/><line x1="' + f(bx) + '" y1="' + f(by - fs * 0.4) + '" x2="' + f(bx) + '" y2="' + f(by + fs * 0.1) + '"/><line x1="' + f(bx + bar) + '" y1="' + f(by - fs * 0.4) + '" x2="' + f(bx + bar) + '" y2="' + f(by + fs * 0.1) + '"/></g>' +
    '<text x="' + f(bx + bar / 2) + '" y="' + f(by - fs * 0.6) + '" font-size="' + f(fs * 0.8) + '" fill="#1f3339" text-anchor="middle">' + bar + 'm</text>';
  const ax = W - fs * 1.6, ay = fs * 1.2;
  const north = '<g fill="#1f3339"><polygon points="' + f(ax) + ',' + f(ay) + ' ' + f(ax - fs * 0.5) + ',' + f(ay + fs * 1.6) + ' ' + f(ax) + ',' + f(ay + fs * 1.2) + ' ' + f(ax + fs * 0.5) + ',' + f(ay + fs * 1.6) + '"/><text x="' + f(ax) + '" y="' + f(ay + fs * 2.7) + '" font-size="' + f(fs * 0.9) + '" text-anchor="middle" font-weight="700">N</text></g>';
  return '<svg class="rp-plan-svg" viewBox="0 0 ' + f(W) + ' ' + f(H) + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="敷地図">' + roads +
    '<polygon points="' + pts + '" fill="#eaf4f0" stroke="#2d756c" stroke-width="' + f(fs * 0.14) + '" stroke-linejoin="round"/>' + labels + scale + north + '</svg>';
}
