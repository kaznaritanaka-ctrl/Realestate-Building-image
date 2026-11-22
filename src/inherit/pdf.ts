// 相続の手続きパックを「PDF（A4横・3枚程度）」で書き出すための印刷用HTML（純粋関数）。
// 1枚目：頭書き（窓口の名称・電話・公式ページ）、2枚目：やる事リスト（期限順）、3枚目：注意と選択肢。
import { fmtDate, fmtDateShort } from "./dates.ts";
import { CHECKED_JA, LAND_TYPE_LABEL } from "./master.ts";
import { dueLabel, fmtMan, type Contact, type Pack, type PackItem } from "./pack.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Row { kind: string; name: string; tel?: string; url?: string; what: string; note?: string }

/** 頭書きに載せる窓口の一覧 */
export function contactRows(pk: Pack): Row[] {
  const a = pk.a, ct = pk.contacts;
  const dead = (a.dpref ?? "") + (a.dcity ?? "");
  const land = (a.lpref ?? "") + (a.lcity ?? "");
  const rows: Row[] = [];
  const many = (kind: string, l: Contact[] | undefined, what: string, fallback: string, fallbackUrl: string) => {
    if (l?.length) {
      const split = l.length > 1 || l.some((c) => c.part);
      l.forEach((c, i) => rows.push({ kind: i ? "" : kind, name: c.name, tel: c.tel, url: c.url, what: i ? "" : what, note: split && !i ? "町名などで担当が分かれます。公式ページで確認してください。" : undefined }));
    } else rows.push({ kind, name: fallback, url: fallbackUrl, what });
  };
  rows.push(pk.houmu
    ? { kind: "法務局", name: pk.houmu.office, tel: pk.houmu.tel, url: pk.houmu.url, what: "相続登記・相続人申告登記・法定相続情報（不動産の所在地）" }
    : { kind: "法務局", name: land ? `${land}を管轄する法務局` : "不動産の所在地を管轄する法務局", url: "https://realestate.ai-investment-research.net/guide/inherit", what: "相続登記・相続人申告登記・法定相続情報（不動産の所在地）" });
  many("税務署", ct.tax, "相続税の申告・準確定申告（亡くなった方の住所地）", dead ? `${dead}を管轄する税務署` : "亡くなった方の住所地を管轄する税務署", "https://www.nta.go.jp/about/organization/access/map.htm");
  many("家庭裁判所", ct.court, "相続放棄・遺言書の検認・特別代理人（亡くなった方の住所地）", dead ? `${dead}を管轄する家庭裁判所` : "亡くなった方の住所地を管轄する家庭裁判所", "https://www.courts.go.jp/saiban/tetuzuki/kasai/index.html");
  rows.push({ kind: "市区町村役場", name: ct.city?.name ?? (dead ? `${dead}の役場` : "亡くなった方の住所地の役場"), tel: ct.city?.tel, url: ct.city?.url, what: "死亡届・世帯主変更・健康保険・戸籍" });
  if (land && land !== dead) rows.push({ kind: "", name: ct.landCity?.name ?? `${land}の役場`, tel: ct.landCity?.tel, url: ct.landCity?.url, what: "固定資産税" + ((a.ltypes ?? []).some((t) => t === "farm" || t === "forest") ? "・農地や森林の届出" : "") });
  rows.push({ kind: "相談", name: "相続登記相談センター（司法書士会）", tel: "0120-13-7832", url: "https://www.shiho-shoshi.or.jp/inheritance_lp", what: "相続登記の相談（予約受付）" });
  rows.push({ kind: "", name: "消費者ホットライン", tel: "188", what: "訪問買取・解体・不用品回収などのトラブル" });
  return rows;
}

function byDeadline(items: PackItem[]): PackItem[] {
  const t = (i: PackItem) => (i.due.date ? i.due.date.getTime() : Infinity);
  return [...items.filter((i) => !i.done).sort((x, y) => t(x) - t(y)), ...items.filter((i) => i.done).sort((x, y) => t(x) - t(y))];
}

export function buildPdfHtml(pk: Pack): string {
  const a = pk.a;
  const land = (a.lpref ?? "") + (a.lcity ?? "");
  const dead = (a.dpref ?? "") + (a.dcity ?? "");
  const head = [
    pk.death ? `亡くなった日：${fmtDate(pk.death)}` : "",
    a.known && pk.known ? `相続を知った日：${fmtDate(pk.known)}` : "",
    land ? `不動産：${land}${a.ltypes?.length ? "（" + a.ltypes.map((t) => LAND_TYPE_LABEL[t]).join("・") + "）" : ""}` : "",
    dead ? `亡くなった方の最後の住所：${dead}` : "",
  ].filter(Boolean);
  const done = pk.items.filter((i) => i.done).length;
  const past = pk.items.filter((i) => i.bucket === "past").length;
  const tel = (t?: string) => (t ? esc(t) : '<span class="pdf-muted">公式ページで確認</span>');
  const link = (u?: string) => (u ? `<a href="${esc(u)}">公式ページ</a>` : "");
  const contacts = contactRows(pk).map((r) => `<tr><th>${esc(r.kind)}</th><td>${esc(r.name)}${r.note ? `<br><small>${esc(r.note)}</small>` : ""}</td><td class="pdf-tel">${tel(r.tel)}</td><td>${esc(r.what)}</td><td>${link(r.url)}</td></tr>`).join("");
  const tx = pk.tax;
  const taxLine = tx.deductionMan !== null
    ? `相続税の基礎控除は「3,000万円＋600万円×法定相続人の数」で、お答えの内容では法定相続人${tx.heirs}人、<b>${fmtMan(tx.deductionMan)}</b>です。遺産の合計がこの額以下なら、相続税の申告も納税も要りません（小規模宅地等の特例を使う前の額で比べます）。`
    : "相続税の基礎控除は「3,000万円＋600万円×法定相続人の数」です。遺産の合計がこの額以下なら、相続税の申告も納税も要りません（小規模宅地等の特例を使う前の額で比べます）。";

  const rows = byDeadline(pk.items).map((i) => {
    const left = i.done || i.daysLeft === null ? "" : i.daysLeft < 0 ? `<span class="pdf-past">${-i.daysLeft}日超過</span>` : `あと${i.daysLeft}日`;
    return `<tr class="${i.done ? "pdf-done" : i.bucket === "past" ? "pdf-row-past" : ""}"><td class="pdf-box">${i.done ? "☑" : "□"}</td><td class="pdf-date">${i.due.date ? esc(dueLabel(i)) : `<small>${esc(i.due.text.replace(/（[^）]*）/g, "").slice(0, 28))}</small>`}</td><td class="pdf-left">${left}</td><td><b>${esc(i.p.title)}</b></td><td>${esc(i.office.replace("（町名などで分かれます）", "※"))}${i.tel ? `<br><b>${esc(i.tel)}</b>` : ""}</td><td>${esc(i.done ? "済" : i.p.action)}</td></tr>`;
  }).join("");

  const cautions = pk.cautions.map((k) => `<li class="${k.isStrong ? "pdf-strong" : ""}"><b>${esc(k.title)}</b><br>${esc(k.why)}</li>`).join("");
  const choices = (g: "仕方" | "土地") => pk.choices.filter((c) => c.group === g).map((c) => `<li><b>${esc(c.title)}</b>：${esc(c.fit)}。${esc(c.next)}<br><small>${esc(c.care)}</small></li>`).join("");
  const foot = `<p class="pdf-foot">作成：土地の未来図（${fmtDateShort(pk.today)}）　一般的な手続きの目安です。期限が土日祝日にあたる場合の扱いや個別の判断は、各窓口・専門家にご確認ください。手続きと窓口の情報は${CHECKED_JA}に公式の案内で確認しました。</p>`;

  return `<div class="ip-pdf" aria-hidden="true">
<section class="pdf-page">
<h1>相続の手続き　連絡先と進め方</h1>
<p class="pdf-head">${head.map(esc).join("　／　")}</p>
<p class="pdf-sum">手続き ${pk.items.length}件（済み ${done}件・まだ ${pk.items.length - done}件${past ? `・期限を過ぎたもの ${past}件` : ""}）。やる事リストは2枚目です。</p>
<h2>窓口と連絡先</h2>
<table class="pdf-contacts"><thead><tr><th>窓口</th><th>名称</th><th>電話</th><th>主な手続き</th><th>公式</th></tr></thead><tbody>${contacts}</tbody></table>
<h2>相続税の目安</h2>
<p class="pdf-tax">${taxLine}　正確な判定は国税庁の「相続税の申告要否判定コーナー」か、税務署・税理士にご確認ください。</p>
${foot}
</section>
<section class="pdf-page">
<h2>やる事リスト（期限の近い順）</h2>
<table class="pdf-todo"><colgroup><col style="width:6mm"><col style="width:34mm"><col style="width:17mm"><col style="width:56mm"><col style="width:62mm"><col></colgroup><thead><tr><th></th><th>期限</th><th>残り</th><th>手続き</th><th>窓口・電話</th><th>まずすること</th></tr></thead><tbody>${rows}</tbody></table>
${foot}
</section>
<section class="pdf-page">
<div class="pdf-cols pdf-p3">
<div><h2>大きな失敗をしないために</h2><ul class="pdf-list">${cautions}</ul></div>
<div><h2>選べること</h2><h3>相続の仕方</h3><ul class="pdf-list">${choices("仕方")}</ul><h3>土地・家をどうするか</h3><ul class="pdf-list">${choices("土地")}</ul></div>
</div>
${foot}
</section>
</div>`;
}
