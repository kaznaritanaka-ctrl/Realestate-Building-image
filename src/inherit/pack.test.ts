import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, parseYmd, ymd } from "./dates.ts";
import { PROCEDURES, CAUTIONS } from "./master.ts";
import { buildCsv, buildIcs, buildMarkdown, buildPack, buildPlainText, decodeAnswers, encodeAnswers, heirCount, taxInfo, taxLines, fmtMan } from "./pack.ts";

const D = (s: string) => parseYmd(s)!;

test("月末は翌月末にそろえる", () => {
  assert.equal(ymd(addMonths(D("2026-01-31"), 1)), "2026-02-28");
  assert.equal(ymd(addMonths(D("2028-01-31"), 1)), "2028-02-29");
  assert.equal(ymd(addMonths(D("2026-11-30"), 3)), "2027-02-28");
});

test("不正な日付は受け付けない", () => {
  assert.equal(parseYmd("2026-02-30"), null);
  assert.equal(parseYmd("abc"), null);
});

test("法定相続人の数：配偶者と子", () => {
  assert.equal(heirCount({ spouse: "y", kids: 2 }), 3);
  assert.equal(heirCount({ spouse: "n", kids: 1 }), 1);
});

test("法定相続人の数：子がいなければ親、親もいなければ兄弟姉妹", () => {
  assert.equal(heirCount({ spouse: "y", kids: 0, parents: 2 }), 3);
  assert.equal(heirCount({ spouse: "y", kids: 0, parents: 0, sibs: 3 }), 4);
  assert.equal(heirCount({ spouse: "n", kids: 0, parents: 0, sibs: 2 }), 2);
});

test("分からない回答があれば数えない（金額を出さない）", () => {
  assert.equal(heirCount({ spouse: "y", kids: -1 }), null);
  assert.equal(heirCount({ spouse: "y", kids: 0, parents: -1 }), null);
  assert.equal(heirCount({ kids: 2 }), null);
  const t = taxInfo({ spouse: "y", kids: -1 });
  assert.equal(t.deductionMan, null);
  assert.match(taxLines(t).head.join(""), /金額は計算していません/);
});

test("基礎控除の金額と文面", () => {
  const t = taxInfo({ spouse: "y", kids: 2 });
  assert.equal(t.deductionMan, 4800);
  const l = taxLines(t);
  assert.match(l.head.join(""), /法定相続人は3人なので、基礎控除は4,800万円です/);
  assert.match(l.notes.join(""), /小規模宅地等の特例/);
  assert.match(l.notes.join(""), /相続放棄をした人も含めて/);
  assert.equal(fmtMan(10200), "1億200万円");
  assert.equal(fmtMan(10000), "1億円");
});

test("期限：放棄3か月・準確定4か月・相続税10か月・登記3年", () => {
  const pk = buildPack({ death: "2026-10-01" }, D("2026-10-05"));
  const by = (id: string) => pk.items.find((i) => i.p.id === id)!;
  assert.equal(ymd(by("houki").due.date!), "2027-01-01");
  assert.equal(ymd(by("junkakutei").due.date!), "2027-02-01");
  assert.equal(ymd(by("souzokuzei").due.date!), "2027-08-01");
  assert.equal(ymd(by("souzokutouki").due.date!), "2029-10-01");
  assert.equal(ymd(by("shiboutodoke").due.date!), "2026-10-07");
});

test("知った日が亡くなった日と違えば、知った日から数える", () => {
  const pk = buildPack({ death: "2026-06-01", known: "2026-09-10" }, D("2026-09-11"));
  assert.equal(ymd(pk.items.find((i) => i.p.id === "houki")!.due.date!), "2026-12-10");
  // 森林の届出は亡くなった日から（所有者となった日）
  const pk2 = buildPack({ death: "2026-06-01", known: "2026-09-10", ltypes: ["forest"] }, D("2026-06-02"));
  assert.equal(ymd(pk2.items.find((i) => i.p.id === "shinrin")!.due.date!), "2026-08-29");
});

test("2024年4月より前に知った相続の登記期限は2027年3月31日", () => {
  const pk = buildPack({ death: "2023-05-10" }, D("2026-11-23"));
  assert.equal(ymd(pk.items.find((i) => i.p.id === "souzokutouki")!.due.date!), "2027-03-31");
});

test("期限切れは「過ぎています」に、直後の届出は「確認」に分ける", () => {
  const pk = buildPack({ death: "2026-01-10" }, D("2026-11-23"));
  const b = (id: string) => pk.items.find((i) => i.p.id === id)!.bucket;
  assert.equal(b("houki"), "past");
  assert.equal(b("junkakutei"), "past");
  assert.equal(b("shiboutodoke"), "check");
  assert.equal(b("souzokuzei"), "past");
  assert.equal(b("souzokutouki"), "later");
});

test("回答で手続きを出し分ける", () => {
  const ids = (a: object) => buildPack(a, D("2026-11-23")).items.map((i) => i.p.id);
  assert.ok(!ids({}).includes("nouchi"));
  assert.ok(ids({ ltypes: ["farm"] }).includes("nouchi"));
  assert.ok(ids({ minor: "y" }).includes("tokubetsudairinin"));
  assert.ok(!ids({ minor: "n" }).includes("tokubetsudairinin"));
  assert.ok(!ids({ bank: "n" }).includes("yokin"));
  assert.ok(ids({ bank: "u" }).includes("yokin"));
});

test("借金が分からなければ放棄を強調し、手を付けない注意を出す", () => {
  const pk = buildPack({ debt: "u" }, D("2026-11-23"));
  assert.ok(pk.items.find((i) => i.p.id === "houki")!.strong);
  assert.equal(pk.cautions[0].isStrong, true);
  assert.ok(pk.cautions.some((c) => c.id === "tetsukezu"));
  assert.ok(!buildPack({ debt: "n" }, D("2026-11-23")).cautions.some((c) => c.id === "tetsukezu"));
});

test("注意は「お勧めします」の形にそろえる", () => {
  for (const c of CAUTIONS) assert.match(c.title, /お勧めします$/, c.id);
});

test("全手続きに根拠か補足があり、idは重複しない", () => {
  const seen = new Set<string>();
  for (const p of PROCEDURES) {
    assert.ok(!seen.has(p.id), p.id);
    seen.add(p.id);
    assert.match(p.id, /^[a-z]+$/);
    assert.ok(p.summary.length > 30, p.id);
  }
});

test("回答のURL符号化は往復でき、不正な値は捨てる", () => {
  const a = { death: "2026-10-01", spouse: "y" as const, kids: 2, ltypes: ["home" as const, "farm" as const], lpref: "兵庫県", lcity: "明石市", debt: "u" as const };
  assert.deepEqual(decodeAnswers(encodeAnswers(a)), a);
  const bad = decodeAnswers("#death=2026-13-01&kids=999&debt=maybe&ltypes=home.xxx&spouse=y");
  assert.deepEqual(bad, { ltypes: ["home"], spouse: "y" });
});

test("Markdown・テキスト・ICSを書き出せる", () => {
  const pk = buildPack({ death: "2026-11-01", spouse: "y", kids: 1, lpref: "兵庫県", lcity: "明石市", ltypes: ["home"], vacant: "y" }, D("2026-11-23"), { office: "神戸地方法務局 明石支局", url: "https://example.jp" });
  const md = buildMarkdown(pk);
  assert.match(md, /## 1\. あなたがしなければならないこと/);
  assert.match(md, /神戸地方法務局 明石支局/);
  assert.match(md, /基礎控除は4,200万円/);
  assert.match(md, /## 3\. 大きな失敗をしないために/);
  assert.match(md, /誰も住まない家/);
  assert.match(buildPlainText(pk), /□ 相続登記/);
  const ics = buildIcs(pk, new Date(Date.UTC(2026, 10, 23)))!;
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270201/); // 放棄の期限
  assert.ok(!/20261107/.test(ics.replace(/UID:[^\r]+/g, "")), "過ぎた期限は入れない");
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test("期限の日付がひとつもなければICSは作らない", () => {
  assert.equal(buildIcs(buildPack({}, D("2026-11-23"))), null);
});

test("済ませた手続きは「済んだこと」に分け、カレンダーには入れない", () => {
  const a = { death: "2026-11-01", done: ["houki", "shiboutodoke"] };
  const pk = buildPack(a, D("2026-11-23"));
  const houki = pk.items.find((i) => i.p.id === "houki")!;
  assert.equal(houki.done, true);
  assert.equal(houki.bucket, "done");
  assert.match(buildMarkdown(pk), /- \[x\] 相続放棄/);
  const ics = buildIcs(pk, new Date(Date.UTC(2026, 10, 23)))!;
  assert.ok(!ics.includes("inherit-houki-"));
  assert.deepEqual(decodeAnswers(encodeAnswers(a)).done, ["houki", "shiboutodoke"]);
  assert.deepEqual(decodeAnswers("done=houki.bogus").done, ["houki"]);
});

test("表（CSV）は済・未を1行ずつ書き出し、BOMつき・式に化ける値を無害化する", () => {
  const pk = buildPack({ death: "2026-11-01", done: ["houki"] }, D("2026-11-23"));
  const csv = buildCsv(pk);
  assert.ok(csv.startsWith("﻿状態,区分,手続き,期限"));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, pk.items.length + 1);
  assert.ok(lines.some((l) => l.startsWith("済,済んだこと,相続放棄")));
  assert.ok(lines.some((l) => l.startsWith("未,")));
  assert.ok(!/,=/.test(csv));
});

test("PDF用HTML：頭書きに窓口と電話、やる事リストは期限順で済みは後ろ", async () => {
  const { buildPdfHtml, contactRows } = await import("./pdf.ts");
  const pk = buildPack({ death: "2026-08-01", dpref: "大阪府", dcity: "大阪市北区", lpref: "兵庫県", lcity: "明石市", done: ["shiboutodoke"] }, D("2026-11-23"),
    { office: "神戸地方法務局 明石支局", url: "https://example.jp" },
    { tax: [{ name: "大淀税務署", tel: "06-6372-7221", part: true }, { name: "北税務署", tel: "06-6313-3371", part: true }], court: [{ name: "大阪家庭裁判所", tel: "06-6943-5745" }] });
  const rows = contactRows(pk);
  assert.equal(rows[0].kind, "法務局");
  assert.ok(rows.some((r) => r.name === "大淀税務署" && r.note));
  assert.ok(rows.some((r) => r.tel === "06-6943-5745"));
  const html = buildPdfHtml(pk);
  assert.equal((html.match(/class="pdf-page"/g) || []).length, 3);
  const todo = html.slice(html.indexOf("pdf-todo"));
  assert.ok(todo.indexOf("死亡届") > todo.indexOf("相続登記"), "済みは後ろ");
  assert.match(html, /4,800万円|基礎控除/);
  assert.match(todo, /大淀税務署 ほか/, "担当が分かれる窓口は1つだけ出して1枚目に任せる");
});

test("PDF用HTML：法務局・役場の電話が入る", async () => {
  const { contactRows } = await import("./pdf.ts");
  const pk = buildPack({ dpref: "沖縄県", dcity: "石垣市", lpref: "沖縄県", lcity: "石垣市" }, D("2026-11-23"),
    { office: "那覇地方法務局 石垣支局", url: "https://example.jp", tel: "0980-82-2004" },
    { city: { name: "石垣市役所", tel: "0980-82-9911", url: "https://example.jp" } });
  const rows = contactRows(pk);
  assert.equal(rows[0].tel, "0980-82-2004");
  assert.ok(rows.some((r) => r.kind === "市区町村役場" && r.tel === "0980-82-9911"));
  assert.equal(rows.filter((r) => r.name === "石垣市役所").length, 1, "同じ市なら1行");
});

test("日付の入力：年は西暦の下2桁", async () => {
  const { fromParts } = await import("./dates.ts");
  const t = D("2026-11-23");
  assert.deepEqual(fromParts("26", "10", "1", t), { ok: true, value: "2026-10-01" });
  assert.deepEqual(fromParts("5", "3", "31", t), { ok: true, value: "2005-03-31" });
  assert.deepEqual(fromParts("98", "1", "2", t), { ok: true, value: "1998-01-02" }, "今年より後の下2桁は1900年代");
  assert.deepEqual(fromParts("", "", "", t), { ok: true, value: "" });
  assert.equal(fromParts("123", "1", "1", t).ok, false, "3桁以上は不可");
  assert.equal(fromParts("26", "2", "30", t).ok, false, "ない日付");
  assert.equal(fromParts("26", "12", "1", t).ok, false, "未来の日付");
  assert.equal(fromParts("26", "", "1", t).ok, false, "月がない");
});
