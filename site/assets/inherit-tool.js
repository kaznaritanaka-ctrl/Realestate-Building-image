// 相続ガイドの「あなたの土地の手続き」ツール。
// 入力はこの端末の中だけで処理し、どこにも送信しない。法務局データは /assets/houmukyoku.json（全国）。
(function () {
"use strict";

// ---------- 純粋な計算・生成（テスト可能な部分） ----------
function addMonths(d, n) {
var y = d.getFullYear(), m = d.getMonth() + n, day = d.getDate();
var ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
var last = new Date(ty, tm + 1, 0).getDate();
return new Date(ty, tm, Math.min(day, last));
}
function fmtDate(d) {
var w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日（" + w + "）";
}
function fmtDateShort(d) {
return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
// 相続を知った日から期限を計算する。known は Date か null。
function deadlines(known) {
if (!known) return null;
var cutoff = new Date(2024, 3, 1); // 2024年4月1日
return {
houki: { label: "相続放棄をするかの判断", date: addMonths(known, 3), place: "家庭裁判所", rule: "知った時から3か月以内"},
tax: { label: "相続税の申告（必要な場合）", date: addMonths(known, 10), place: "税務署", rule: "知った日の翌日から10か月以内"},
touki: {
label: "相続登記の申請", place: "管轄の法務局",
date: known < cutoff? new Date(2027, 2, 31): addMonths(known, 36),
rule: known < cutoff? "2024年4月より前の相続は2027年3月31日まで": "知った日から3年以内"
}
};
}
function placeText(st) {
var s = "";
if (st.pref) s += st.pref;
if (st.city) s += st.city;
if (st.chiban) s += (s? " ": "") + st.chiban;
return s;
}
function scheduleRows(st) {
var dl = deadlines(st.known);
var office = st.houmu? st.houmu.office: "管轄の法務局";
var rows = [
{ label: "名義の確認", limit: "早めに", place: "法務局の登記記録"},
{ label: "相続人の確定（戸籍を集める）", limit: "早めに", place: "本籍地の市区町村役場"},
{ label: "分け方の話し合い（遺産分割）", limit: "登記の前まで", place: "相続人全員で"}
];
if (dl) {
rows.push({ label: dl.houki.label, limit: fmtDateShort(dl.houki.date) + "まで", place: dl.houki.place});
rows.push({ label: dl.tax.label, limit: fmtDateShort(dl.tax.date) + "まで", place: dl.tax.place});
rows.push({ label: dl.touki.label, limit: fmtDateShort(dl.touki.date) + "まで", place: office});
} else {
rows.push({ label: "相続放棄をするかの判断", limit: "知った時から3か月以内", place: "家庭裁判所"});
rows.push({ label: "相続税の申告（必要な場合）", limit: "知った日の翌日から10か月以内", place: "税務署"});
rows.push({ label: "相続登記の申請", limit: "知った日から3年以内（2024年4月より前の相続は2027年3月31日まで）", place: office});
}
rows.push({ label: "土地をどうするか決める", limit: "期限なし", place: "住む・活用する・手放す"});
return rows;
}
function headerLines(st) {
var lines = [];
var place = placeText(st);
if (place) lines.push("土地：" + place);
if (st.houmu) lines.push("管轄の法務局：" + st.houmu.office);
if (st.known) lines.push("相続を知った日：" + fmtDate(st.known));
return lines;
}
function buildMarkdown(st) {
var out = ["# 相続手続きチェックリスト", ""];
out = out.concat(headerLines(st));
if (headerLines(st).length) out.push("");
out.push("## 工程表", "", "| 手続き | 期限 | 窓口 |", "|---|---|---|");
scheduleRows(st).forEach(function (r) { out.push("| " + r.label + " | " + r.limit + " | " + r.place + " |");});
out.push("", "## チェックリスト", "");
var office = st.houmu? st.houmu.office: "管轄の法務局";
var dl = deadlines(st.known);
var items = [
"名義を確認する（登記簿で現在の名義を確認）",
"相続人を確定する（戸籍を集める）",
"分け方を話し合い、遺産分割協議書にまとめる",
"相続登記を申請する（" + office + (dl? "・" + fmtDateShort(dl.touki.date) + "まで": "") + "）",
"相続税の申告が要るか確認する" + (dl? "（必要な場合は" + fmtDateShort(dl.tax.date) + "まで・税務署）": "（税務署）"),
"土地をどうするか決める（住む・活用する・手放す）",
"必要なら専門家や相談先に相談する"
];
items.forEach(function (t) { out.push("- [" + " ] " + t); });
out.push("", "作成：土地の未来図 https://realestate.ai-investment-research.net/guide/inherit", "※一般的な流れの目安です。個別の判断は専門家にご相談ください。");
return out.join("\n");
}
function buildPlainText(st) {
var out = ["相続手続きチェックリスト", ""];
out = out.concat(headerLines(st));
if (headerLines(st).length) out.push("");
out.push("");
scheduleRows(st).forEach(function (r) { out.push("・" + r.label + "：" + r.limit + "（" + r.place + "）");});
out.push("", "");
var office = st.houmu? st.houmu.office: "管轄の法務局";
var dl = deadlines(st.known);
var items = [
"名義を確認する（登記簿で現在の名義を確認）",
"相続人を確定する（戸籍を集める）",
"分け方を話し合い、遺産分割協議書にまとめる",
"相続登記を申請する（" + office + (dl? "・" + fmtDateShort(dl.touki.date) + "まで": "") + "）",
"相続税の申告が要るか確認する" + (dl? "（必要な場合は" + fmtDateShort(dl.tax.date) + "まで・税務署）": "（税務署）"),
"土地をどうするか決める（住む・活用する・手放す）",
"必要なら専門家や相談先に相談する"
];
items.forEach(function (t) { out.push("□ " + t);});
out.push("", "作成：土地の未来図", "※一般的な流れの目安です。個別の判断は専門家にご相談ください。");
return out.join("\n");
}
function icsDate(d) {
function p(n) { return String(n).padStart(2, "0");}
return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}
function buildIcs(st) {
var dl = deadlines(st.known);
if (!dl) return null;
var stamp = new Date();
function p(n) { return String(n).padStart(2, "0");}
var dtstamp = stamp.getUTCFullYear() + p(stamp.getUTCMonth() + 1) + p(stamp.getUTCDate()) + "T" + p(stamp.getUTCHours()) + p(stamp.getUTCMinutes()) + p(stamp.getUTCSeconds()) + "Z";
var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Land Future//inherit-checklist//JA", "CALSCALE:GREGORIAN"];
[dl.houki, dl.tax, dl.touki].forEach(function (e, i) {
var end = new Date(e.date.getFullYear(), e.date.getMonth(), e.date.getDate() + 1);
lines.push("BEGIN:VEVENT");
lines.push("UID:inherit-" + icsDate(e.date) + "-" + i + "@realestate.ai-investment-research.net");
lines.push("DTSTAMP:" + dtstamp);
lines.push("DTSTART;VALUE=DATE:" + icsDate(e.date));
lines.push("DTEND;VALUE=DATE:" + icsDate(end));
lines.push("SUMMARY:" + e.label + "の期限");
lines.push("DESCRIPTION:窓口：" + (e === dl.touki && st.houmu? st.houmu.office: e.place) + "（土地の未来図の相続チェックリストより）");
lines.push("BEGIN:VALARM", "TRIGGER:-P30D", "ACTION:DISPLAY", "DESCRIPTION:" + e.label + "の期限まで1か月です", "END:VALARM");
lines.push("BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY", "DESCRIPTION:" + e.label + "の期限まで1週間です", "END:VALARM");
lines.push("END:VEVENT");
});
lines.push("END:VCALENDAR");
return lines.join("\r\n");
}

if (typeof module!== "undefined" && module.exports) {
module.exports = { addMonths, deadlines, buildMarkdown, buildPlainText, buildIcs, scheduleRows};
return;
}

// ---------- ブラウザ側の配線 ----------
var $ = function (id) { return document.getElementById(id);};
var state = { pref: "", city: "", chiban: "", known: null, houmu: null};
var data = null;

function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];});}

function render() {
var officeBox = $("tool-office");
if (state.houmu) {
officeBox.innerHTML = "管轄の法務局は <b>" + esc(state.houmu.office) + "</b> です。<br><small>管轄は変わることがあるため、申請前に<a href=\"" + esc(state.houmu.url) + "\" target=\"_blank\" rel=\"noopener\">公式案内</a>でご確認ください。</small>";
} else if (state.pref) {
officeBox.textContent = "市区町村を選ぶと、管轄の法務局が表示されます。";
} else {
officeBox.textContent = "";
}
var rows = scheduleRows(state);
$("tool-schedule").innerHTML = rows.map(function (r) {
return "<tr><td>" + esc(r.label) + "</td><td>" + esc(r.limit) + "</td><td>" + esc(r.place) + "</td></tr>";
}).join("");
$("tool-ics").disabled =!state.known;
$("tool-ics-note").textContent = state.known? "": "カレンダー登録には「相続を知った日」の入力が必要です。";
}

function download(name, text, type) {
var blob = new Blob([text], { type: type});
var a = document.createElement("a");
a.href = URL.createObjectURL(blob);
a.download = name;
document.body.appendChild(a);
a.click();
setTimeout(function () { URL.revokeObjectURL(a.href); a.remove();}, 500);
}
function copyText(text, btn) {
function done() {
var old = btn.textContent;
btn.textContent = "コピーしました";
setTimeout(function () { btn.textContent = old;}, 2000);
}
if (navigator.clipboard && navigator.clipboard.writeText) {
navigator.clipboard.writeText(text).then(done, function () { fallback();});
} else fallback();
function fallback() {
var ta = document.createElement("textarea");
ta.value = text;
document.body.appendChild(ta);
ta.select();
try { document.execCommand("copy"); done();} catch (e) { /* noop */}
ta.remove();
}
}

document.addEventListener("DOMContentLoaded", function () {
if (!$("tool-pref")) return;
fetch("/assets/houmukyoku.json").then(function (r) { return r.json();}).then(function (j) {
data = j;
var prefSel = $("tool-pref");
Object.keys(data).forEach(function (p) {
var o = document.createElement("option");
o.value = p; o.textContent = p;
prefSel.appendChild(o);
});
var toolEl = document.querySelector(".tool");
var preset = toolEl? toolEl.getAttribute("data-pref"): null;
if (preset && data[preset]) {
prefSel.value = preset;
prefSel.dispatchEvent(new Event("change"));
}
}).catch(function () {
$("tool-office").textContent = "法務局のデータを読み込めませんでした。法務省の公式案内でご確認ください。";
});

$("tool-pref").addEventListener("change", function () {
state.pref = this.value;
state.city = ""; state.houmu = null;
var citySel = $("tool-city");
citySel.innerHTML = "<option value=\"\">市区町村を選んでください</option>";
if (data && data[state.pref]) {
Object.keys(data[state.pref]).forEach(function (c) {
var o = document.createElement("option");
o.value = c; o.textContent = c;
citySel.appendChild(o);
});
}
render();
});
$("tool-city").addEventListener("change", function () {
state.city = this.value;
state.houmu = data && state.pref && state.city? data[state.pref][state.city] || null: null;
render();
});
$("tool-chiban").addEventListener("input", function () { state.chiban = this.value.trim();});
$("tool-date").addEventListener("change", function () {
if (this.value) {
var p = this.value.split("-");
state.known = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
} else state.known = null;
render();
});
$("tool-md-copy").addEventListener("click", function () { copyText(buildMarkdown(state), this);});
$("tool-txt-copy").addEventListener("click", function () { copyText(buildPlainText(state), this);});
$("tool-md-dl").addEventListener("click", function () { download("相続手続きチェックリスト.md", buildMarkdown(state), "text/markdown");});
$("tool-ics").addEventListener("click", function () {
var ics = buildIcs(state);
if (ics) download("相続手続きの期限.ics", ics, "text/calendar");
});
render();
});
})();
