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

export function buildSiteReport({ result, info, images, isSample, preparedAt, styleName, center }: ReportInput): string {
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
  const page1 = '<div class="rp-four">' +
    '<section class="rp-card rp-overview"><h3>対象土地の概要</h3><table class="rp-table">' + landTable + '</table>' +
    '<p class="rp-fine">敷地形状は利用者の概略入力です。土地境界・測量結果や実際の建築可能性を確定するものではありません。</p></section>' +
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
