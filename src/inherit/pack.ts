// 相続手続きパックの組み立て（純粋関数）。回答から、その人に必要な手続き・注意・選択肢を並べ、書き出し用の文書を作る。
// ここでは何も保存・送信しない。
import { addDays, daysBetween, fmtDate, fmtDateShort, parseYmd, ymd } from "./dates.ts";
import {
  CATEGORY_ORDER, CAUTIONS, CHECKED_JA, CHOICES, CONSULT, LAND_TYPE_LABEL, OFFICE_LABEL, PROCEDURES,
  type Answers, type Caution, type Choice, type Ctx, type Due, type LandType, type Procedure, type YNU,
} from "./master.ts";

export const SITE = "https://realestate.ai-investment-research.net";
export const PACK_PATH = "/guide/inherit";

export interface Houmu { office: string; url: string; tel?: string }

/** 窓口の連絡先（名称・電話・公式ページ）。part は町名などで管轄が分かれることを示す */
export interface Contact { name: string; tel?: string; url?: string; part?: boolean }
export interface Contacts {
  tax?: Contact[]; // 亡くなった方の住所地の税務署
  court?: Contact[]; // 亡くなった方の住所地の家庭裁判所
  city?: Contact; // 亡くなった方の住所地の市区町村役場
  landCity?: Contact; // 不動産のある市区町村役場
}

export type Bucket = "past" | "check" | "week" | "month" | "later" | "done";
export const BUCKET_LABEL: Record<Bucket, string> = {
  past: "期限を過ぎています（相談先へ）",
  check: "済んでいるか確認するもの",
  week: "まず今週",
  month: "今月中",
  later: "その後",
  done: "済んだこと",
};
const BUCKET_ORDER: Bucket[] = ["past", "week", "month", "later", "check", "done"];

export interface PackItem {
  p: Procedure;
  due: Due;
  bucket: Bucket;
  daysLeft: number | null;
  office: string; // 窓口の表示（実名が分かれば実名）
  officeUrl?: string;
  tel?: string;
  strong: boolean;
  done: boolean;
}

export interface TaxInfo {
  heirs: number | null; // 数えられないときは null
  deductionMan: number | null; // 基礎控除（万円）
  adoptedNote: boolean;
}

export interface Pack {
  a: Answers;
  today: Date;
  death: Date | null;
  known: Date | null;
  items: PackItem[];
  cautions: (Caution & { isStrong: boolean })[];
  choices: Choice[];
  tax: TaxInfo;
  houmu: Houmu | null;
  contacts: Contacts;
}

// ---------- 回答の受け渡し（URLの # 以降。# 以降はサーバーに送られない） ----------
const KEYS: (keyof Answers)[] = ["death", "known", "spouse", "kids", "minor", "parents", "sibs", "will", "willType", "debt", "lpref", "lcity", "ltypes", "vacant", "title", "dpref", "dcity", "bank", "pension", "insurance", "done"];
const PROC_IDS = new Set(PROCEDURES.map((p) => p.id));
const NUM_KEYS = new Set<keyof Answers>(["kids", "parents", "sibs"]);
const ENUMS: Partial<Record<keyof Answers, string[]>> = {
  spouse: ["y", "n"], minor: ["y", "n", "u"], will: ["y", "n", "u"], willType: ["home", "notary", "moj", "u"], debt: ["y", "n", "u"],
  vacant: ["y", "n", "u"], title: ["y", "n", "u"], bank: ["y", "n", "u"], pension: ["y", "n", "u"], insurance: ["y", "n", "u"],
};
const LAND_TYPES: LandType[] = ["home", "land", "farm", "forest"];

export function encodeAnswers(a: Answers): string {
  const q = new URLSearchParams();
  for (const k of KEYS) {
    const v = a[k];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { if (v.length) q.set(k, v.join(".")); continue; }
    q.set(k, String(v));
  }
  return q.toString();
}

/** 不正な値は捨てる（URLを手で書き換えられても壊れないように） */
export function decodeAnswers(s: string): Answers {
  const q = new URLSearchParams(s.replace(/^#/, ""));
  const a: Answers = {};
  const put = a as Record<string, unknown>;
  for (const k of KEYS) {
    const v = q.get(k);
    if (v === null || v === "") continue;
    if (k === "death" || k === "known") { if (parseYmd(v)) put[k] = v; continue; }
    if (NUM_KEYS.has(k)) { const n = Number(v); if (Number.isInteger(n) && n >= -1 && n <= 20) put[k] = n; continue; }
    if (k === "done") { const d = v.split(".").filter((x) => PROC_IDS.has(x)); if (d.length) a.done = [...new Set(d)]; continue; }
    if (k === "ltypes") { const t = v.split(".").filter((x): x is LandType => (LAND_TYPES as string[]).includes(x)); if (t.length) a.ltypes = [...new Set(t)]; continue; }
    if (ENUMS[k]) { if (ENUMS[k]!.includes(v)) put[k] = v; continue; }
    put[k] = v.slice(0, 40); // 都道府県・市区町村の名前
  }
  return a;
}

// ---------- 法定相続人の数と基礎控除 ----------
/** 法定相続人の数。分からない回答が含まれるときは null（金額を出さず式だけを示す） */
export function heirCount(a: Answers): number | null {
  if (a.spouse === undefined || a.kids === undefined || a.kids < 0) return null;
  const sp = a.spouse === "y" ? 1 : 0;
  if (a.kids > 0) return sp + a.kids;
  if (a.parents === undefined || a.parents < 0) return null;
  if (a.parents > 0) return sp + a.parents;
  if (a.sibs === undefined || a.sibs < 0) return null;
  const n = sp + a.sibs;
  return n > 0 ? n : null;
}

export function taxInfo(a: Answers): TaxInfo {
  const heirs = heirCount(a);
  return { heirs, deductionMan: heirs === null ? null : 3000 + 600 * heirs, adoptedNote: true };
}

export function fmtMan(man: number): string {
  if (man >= 10000) {
    const oku = Math.floor(man / 10000), rest = man % 10000;
    return `${oku}億${rest ? rest.toLocaleString("ja-JP") + "万" : ""}円`;
  }
  return `${man.toLocaleString("ja-JP")}万円`;
}

/** 相続税の目安の文面（2026-11-23 確定、国税庁タックスアンサー No.4205・No.4152） */
export function taxLines(t: TaxInfo): { head: string[]; notes: string[]; tail: string } {
  const head = ["相続税の基礎控除は「3,000万円＋600万円×法定相続人の数」です。"];
  if (t.heirs !== null && t.deductionMan !== null) {
    head.push(`お答えの内容では法定相続人は${t.heirs}人なので、基礎控除は${fmtMan(t.deductionMan)}です。`);
  } else {
    head.push("お答えの内容からは法定相続人の数を確定できないため、金額は計算していません。相続人の数が分かったら、上の式で計算してください。");
  }
  head.push("亡くなった方の遺産の合計がこの額以下であれば、相続税の申告も納税も要りません。");
  const notes = [
    "土地・建物・預貯金・株などに、死亡保険金のうち非課税枠（500万円×法定相続人の数）を超える部分と、亡くなる前3年以内に受けた贈与（2027年以降に亡くなった場合は順次長くなります）を足し、借金と葬式費用を引いた額で比べます。",
    "土地は売れる値段ではなく、路線価などで評価した額を使います。",
    "小規模宅地等の特例（自宅の土地などの評価を下げる制度）を使う前の額で比べてください。特例を使ってはじめて基礎控除以下になる場合も、申告が必要です。特例は申告して初めて使えるためです。",
    "法定相続人の数は、相続放棄をした人も含めて数えます。養子がいる場合は数え方が変わります。",
  ];
  const tail = "正確な判定は、国税庁の「相続税の申告要否判定コーナー」か、税務署・税理士にご確認ください。";
  return { head, notes, tail };
}

// ---------- パックの組み立て ----------
const CHECK_IF_PAST = new Set(["shiboutodoke", "setainushi", "kenkouhoken", "nenkin"]);

const joinNames = (l: Contact[]) => l.map((c) => c.name).join("または") + (l.length > 1 || l.some((c) => c.part) ? "（町名などで分かれます）" : "");
const joinTels = (l: Contact[]) => l.map((c) => c.tel).filter(Boolean).join("／") || undefined;

function officeText(p: Procedure, a: Answers, houmu: Houmu | null, ct: Contacts): { text: string; url?: string; tel?: string } {
  const land = (a.lpref ?? "") + (a.lcity ?? "");
  const dead = (a.dpref ?? "") + (a.dcity ?? "");
  switch (p.office) {
    case "moj": return houmu ? { text: houmu.office, url: houmu.url, tel: houmu.tel } : { text: land ? `${land}を管轄する法務局` : OFFICE_LABEL.moj };
    case "court":
      if (ct.court?.length) return { text: joinNames(ct.court), url: ct.court[0].url, tel: joinTels(ct.court) };
      return { text: dead ? `${dead}を管轄する家庭裁判所` : OFFICE_LABEL.court, url: "https://www.courts.go.jp/saiban/tetuzuki/kasai/index.html" };
    case "court-child": return { text: OFFICE_LABEL["court-child"], url: "https://www.courts.go.jp/saiban/tetuzuki/kasai/index.html" };
    case "tax":
      if (ct.tax?.length) return { text: joinNames(ct.tax), url: ct.tax[0].url, tel: joinTels(ct.tax) };
      return { text: dead ? `${dead}を管轄する税務署` : OFFICE_LABEL.tax, url: "https://www.nta.go.jp/about/organization/access/map.htm" };
    case "farm": return { text: a.lcity ? `${a.lcity}の農業委員会` : OFFICE_LABEL.farm, tel: ct.landCity?.tel };
    case "forest": return { text: a.lcity ? `${a.lcity}の林務担当` : OFFICE_LABEL.forest, tel: ct.landCity?.tel };
    case "city":
      if (p.id === "koteishisanzei" && land) return { text: `${ct.landCity?.name ?? land + "の役場"}（固定資産税の担当）`, url: ct.landCity?.url, tel: ct.landCity?.tel };
      if (ct.city) return { text: ct.city.name, url: ct.city.url, tel: ct.city.tel };
      return { text: dead ? `${dead}の役場` : OFFICE_LABEL.city };
    default: return { text: OFFICE_LABEL[p.office] };
  }
}

function bucketOf(p: Procedure, due: Due, daysLeft: number | null, strong: boolean): Bucket {
  if (daysLeft !== null) {
    if (daysLeft < 0) return CHECK_IF_PAST.has(p.id) ? "check" : "past";
    if (daysLeft <= 7) return "week";
    if (daysLeft <= 31) return "month";
    return "later";
  }
  if (strong) return "week";
  return due.urgency === "soon" ? "month" : "later";
}

export function ctxOf(a: Answers): Ctx {
  const death = parseYmd(a.death);
  const known = parseYmd(a.known) ?? death;
  return { a, death, known };
}

export function buildPack(a: Answers, today: Date, houmu: Houmu | null = null, contacts: Contacts = {}): Pack {
  const c = ctxOf(a);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const doneSet = new Set(a.done ?? []);
  const items: PackItem[] = PROCEDURES.filter((p) => p.when(a)).map((p) => {
    const due = p.due(c);
    const daysLeft = due.date ? daysBetween(t0, due.date) : null;
    const strong = !!p.strong?.(a);
    const o = officeText(p, a, houmu, contacts);
    const done = doneSet.has(p.id);
    return { p, due, daysLeft, strong, done, bucket: done ? "done" : bucketOf(p, due, daysLeft, strong), office: o.text, officeUrl: o.url, tel: o.tel };
  });
  items.sort((x, y) => {
    const b = BUCKET_ORDER.indexOf(x.bucket) - BUCKET_ORDER.indexOf(y.bucket);
    if (b) return b;
    const dx = x.due.date ? x.due.date.getTime() : Infinity, dy = y.due.date ? y.due.date.getTime() : Infinity;
    if (dx !== dy) return dx - dy;
    return CATEGORY_ORDER.indexOf(x.p.cat) - CATEGORY_ORDER.indexOf(y.p.cat);
  });
  const cautions = CAUTIONS.filter((k) => k.when(a)).map((k) => ({ ...k, isStrong: !!k.strong?.(a) }))
    .sort((x, y) => Number(y.isStrong) - Number(x.isStrong));
  return { a, today: t0, death: c.death, known: c.known, items, cautions, choices: CHOICES, tax: taxInfo(a), houmu, contacts };
}

export function groupByBucket(items: PackItem[]): [Bucket, PackItem[]][] {
  return BUCKET_ORDER.map((b) => [b, items.filter((i) => i.bucket === b)] as [Bucket, PackItem[]]).filter(([, l]) => l.length);
}

export function dueLabel(i: PackItem): string {
  if (!i.due.date) return i.due.text;
  return `${fmtDateShort(i.due.date)}まで${i.due.approx ? "（目安）" : ""}`;
}

export function consultFor(i: PackItem) { return CONSULT[i.p.office]; }

// ---------- 書き出し ----------
function headerLines(pk: Pack): string[] {
  const a = pk.a, out: string[] = [];
  if (pk.death) out.push(`亡くなった日：${fmtDate(pk.death)}`);
  if (a.known && pk.known) out.push(`相続を知った日：${fmtDate(pk.known)}`);
  const land = (a.lpref ?? "") + (a.lcity ?? "");
  if (land) out.push(`不動産の場所：${land}${a.ltypes?.length ? "（" + a.ltypes.map((t) => LAND_TYPE_LABEL[t]).join("・") + "）" : ""}`);
  if (pk.houmu) out.push(`管轄の法務局：${pk.houmu.office}`);
  const dead = (a.dpref ?? "") + (a.dcity ?? "");
  if (dead) out.push(`亡くなった方の最後の住所：${dead}`);
  out.push(`作成日：${fmtDateShort(pk.today)}`);
  return out;
}

export function revisitUrl(a: Answers): string {
  return `${SITE}${PACK_PATH}#${encodeAnswers(a)}`;
}

const FOOT = [
  "※一般的な手続きの目安です。期限が土日祝日にあたる場合の扱いは手続きごとに異なります。個別の判断は窓口や専門家にご確認ください。",
  `※手続きの内容は${CHECKED_JA}に公式の案内で確認しました。`,
];

export function buildMarkdown(pk: Pack): string {
  const o: string[] = ["# 相続の手続きパック", "", ...headerLines(pk).map((l) => `- ${l}`), ""];
  o.push("## 1. あなたがしなければならないこと", "");
  for (const [b, list] of groupByBucket(pk.items)) {
    o.push(`### ${BUCKET_LABEL[b]}`, "");
    for (const i of list) {
      o.push(`- [${i.done ? "x" : " "}] ${i.strong && !i.done ? "**" + i.p.title + "**" : i.p.title}（${dueLabel(i)}／${i.office}）`);
      if (!i.done) o.push(`  - ${i.p.action}`);
      if (b === "past") o.push(`  - 相談先：${consultFor(i).map((c) => c.name + (c.tel ? " " + c.tel : "")).join("、")}`);
    }
    o.push("");
  }
  const tl = taxLines(pk.tax);
  o.push("### 相続税の申告が要るかの目安", "", ...tl.head, "", ...tl.notes.map((n) => `- ${n}`), "", tl.tail, "");
  o.push("## 2. あなたに選べること", "");
  for (const g of ["仕方", "土地"] as const) {
    o.push(g === "仕方" ? "### 相続の仕方" : "### 土地・家をどうするか", "");
    for (const ch of pk.choices.filter((x) => x.group === g)) o.push(`- **${ch.title}**：${ch.fit}。${ch.next}${ch.care}`);
    o.push("");
  }
  o.push("## 3. 大きな失敗をしないために", "");
  for (const k of pk.cautions) o.push(`- ${k.isStrong ? "**" + k.title + "**" : k.title}`, `  - ${k.why}`);
  o.push("", "---", "", `このパックを開き直す：${revisitUrl(pk.a)}`, "", `作成：土地の未来図 ${SITE}${PACK_PATH}`, ...FOOT);
  return o.join("\n");
}

export function buildPlainText(pk: Pack): string {
  const o: string[] = ["相続の手続きパック", "", ...headerLines(pk), "", "【1. しなければならないこと】"];
  for (const [b, list] of groupByBucket(pk.items)) {
    o.push("", `■ ${BUCKET_LABEL[b]}`);
    for (const i of list) {
      o.push(`${i.done ? "☑" : "□"} ${i.p.title}（${dueLabel(i)}／${i.office}）`);
      if (b === "past") o.push(`　相談先：${consultFor(i).map((c) => c.name + (c.tel ? " " + c.tel : "")).join("、")}`);
    }
  }
  const tl = taxLines(pk.tax);
  o.push("", "■ 相続税の申告が要るかの目安", ...tl.head, ...tl.notes.map((n) => "・" + n), tl.tail);
  o.push("", "【2. 選べること】", ...pk.choices.map((c) => `・${c.title}：${c.fit}`));
  o.push("", "【3. 大きな失敗をしないために】", ...pk.cautions.map((k) => "・" + k.title));
  o.push("", "開き直す：" + revisitUrl(pk.a), "作成：土地の未来図", ...FOOT);
  return o.join("\n");
}

function icsDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
/** 75オクテットを超える行を折り返す（RFC 5545） */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "", len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** 期限が今日以降の手続きを、30日前・7日前の通知つきで書き出す。対象がなければ null */
export function buildIcs(pk: Pack, now: Date = new Date()): string | null {
  const ev = pk.items.filter((i) => !i.done && i.due.date && i.daysLeft !== null && i.daysLeft >= 0);
  if (!ev.length) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Land Future//inherit-pack//JA", "CALSCALE:GREGORIAN", "X-WR-CALNAME:相続の手続き"];
  for (const i of ev) {
    const d = i.due.date!;
    L.push("BEGIN:VEVENT", `UID:inherit-${i.p.id}-${icsDate(d)}@realestate.ai-investment-research.net`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(d)}`, `DTEND;VALUE=DATE:${icsDate(addDays(d, 1))}`,
      `SUMMARY:${icsEscape(i.p.title + "の期限" + (i.due.approx ? "（目安）" : ""))}`,
      `DESCRIPTION:${icsEscape(`${i.due.text}\n窓口：${i.office}\n${i.p.action}\n（土地の未来図の相続手続きパックより）`)}`);
    if (i.daysLeft! > 30) L.push("BEGIN:VALARM", "TRIGGER:-P30D", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(i.p.title + "の期限まで1か月です")}`, "END:VALARM");
    if (i.daysLeft! > 7) L.push("BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(i.p.title + "の期限まで1週間です")}`, "END:VALARM");
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

/** 表計算ソフト（Excel・Googleスプレッドシート・Numbers）で開ける一覧。先頭にBOMを付けてExcelの文字化けを防ぐ */
export function buildCsv(pk: Pack): string {
  const cell = (v: unknown) => {
    if (typeof v === "number") return String(v);
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s;
  };
  const rows: unknown[][] = [["状態", "区分", "手続き", "期限", "期限の決まり方", "残り日数", "窓口", "まずすること", "段階", "済んだ日・メモ"]];
  for (const [b, list] of groupByBucket(pk.items)) {
    for (const i of list) {
      rows.push([i.done ? "済" : "未", BUCKET_LABEL[b], i.p.title, i.due.date ? ymd(i.due.date) : "", i.due.text,
        i.done || i.daysLeft === null ? "" : i.daysLeft, i.office, i.p.action, i.p.cat, ""]);
    }
  }
  return "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export type { Answers, YNU };
