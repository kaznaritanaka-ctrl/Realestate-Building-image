// 相続手続きパックのウィザード（ブラウザ側）。回答はこの端末の中だけで使い、どこにも送信・保存しない。
// 見返し用に回答を URL の # 以降に入れる（# 以降はサーバーに送られない）。計測は「どの画面まで進んだか」だけを送る。
import { fmtDateShort } from "./dates.ts";
import { CHECKED_JA, CATEGORY_ORDER, LAND_TYPE_LABEL, PROCEDURES, type Answers, type LandType, type YNU } from "./master.ts";
import {
  BUCKET_LABEL, buildCsv, buildIcs, buildMarkdown, buildPack, buildPlainText, consultFor, decodeAnswers, dueLabel, encodeAnswers,
  groupByBucket, taxLines, type Contact, type Contacts, type Houmu, type Pack, type PackItem,
} from "./pack.ts";
import { buildPdfHtml } from "./pdf.ts";

/** site/assets/offices.json（scripts/offices/build.py が作る） */
interface OfficeData {
  tax: [string, string, string][];
  court: [string, string, string][];
  city?: [string, string, string][];
  map: Record<string, Record<string, [number[], number[], number, number?]>>;
}

type HoumuData = Record<string, Record<string, Houmu>>;

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- 計測（内容は送らない） ----------
function sid(): string {
  try {
    let s = sessionStorage.getItem("tm-sid");
    if (!s) {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      s = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem("tm-sid", s);
    }
    return s;
  } catch { return "0000000000000000"; }
}
function track(name: string, props: Record<string, string | number | boolean> = {}) {
  const body = JSON.stringify({ sid: sid(), name, props: { ...props, page: location.pathname.replace(/^\//, "").replace(/\.html$/, "") } });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }));
    else fetch("/api/event", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  } catch { /* 計測の失敗は無視 */ }
}

// ---------- 画面の部品 ----------
function radios(name: string, opts: [string, string][], val: string | undefined): string {
  return `<div class="ip-choices" role="radiogroup">${opts.map(([v, l]) =>
    `<label class="ip-opt"><input type="radio" name="${name}" value="${esc(v)}"${val === v ? " checked" : ""}><span>${esc(l)}</span></label>`).join("")}</div>`;
}
const YNU_OPTS: [string, string][] = [["y", "はい"], ["n", "いいえ"], ["u", "分からない"]];
function q(label: string, inner: string, note = ""): string {
  return `<fieldset class="ip-q"><legend>${label}</legend>${inner}${note ? `<p class="ip-note">${note}</p>` : ""}</fieldset>`;
}
function countSelect(name: string, val: number | undefined, zeroLabel: string, max = 8): string {
  const opts = [`<option value="">選んでください</option>`, `<option value="0"${val === 0 ? " selected" : ""}>${zeroLabel}</option>`];
  for (let i = 1; i <= max; i++) opts.push(`<option value="${i}"${val === i ? " selected" : ""}>${i}人${i === max ? "以上" : ""}</option>`);
  opts.push(`<option value="-1"${val === -1 ? " selected" : ""}>分からない</option>`);
  return `<select name="${name}" class="ip-select">${opts.join("")}</select>`;
}

/** 「まだ／済んだ」の切り替え（2択のラジオ） */
function doneToggle(id: string, title: string, done: boolean): string {
  return `<div class="ip-toggle" role="radiogroup" aria-label="${esc(title)}は済みましたか"><label><input type="radio" name="t_${id}" value="0" data-done="${id}"${done ? "" : " checked"}><span>まだ</span></label><label><input type="radio" name="t_${id}" value="1" data-done="${id}"${done ? " checked" : ""}><span>済んだ</span></label></div>`;
}

const STEPS = ["いつ", "家族", "遺言と借金", "不動産", "亡くなった方の住所", "そのほかの財産", "済ませた手続き"] as const;

export function mount(root: HTMLElement) {
  let data: HoumuData | null = null;
  let a: Answers = {};
  let step = 0;
  let started = false;
  const preset = root.dataset.pref || "";
  const today = () => new Date();

  let offices: OfficeData | null = null;
  const officesReady = fetch("/assets/offices.json").then((r) => r.json()).then((j: OfficeData) => { offices = j; }).catch(() => { offices = null; });
  function contacts(): Contacts {
    const o = offices;
    if (!o) return {};
    const toC = (t: [string, string, string], part: boolean): Contact => ({ name: t[0], tel: t[1] || undefined, url: t[2] || undefined, part });
    const out: Contacts = {};
    const d = a.dpref && a.dcity ? o.map[a.dpref]?.[a.dcity] : undefined;
    if (d) {
      out.tax = d[0].map((i) => toC(o.tax[i], !!(d[2] & 1)));
      out.court = d[1].map((i) => toC(o.court[i], !!(d[2] & 2)));
      if (o.city && d[3] !== undefined) out.city = toC(o.city[d[3]], false);
    }
    const l = a.lpref && a.lcity ? o.map[a.lpref]?.[a.lcity] : undefined;
    if (l && o.city && l[3] !== undefined) out.landCity = toC(o.city[l[3]], false);
    return out;
  }
  const dataReady = fetch("/assets/houmukyoku.json").then((r) => r.json()).then((j: HoumuData) => { data = j; }).catch(() => { data = null; });

  const prefOptions = (sel?: string) => [`<option value="">都道府県を選んでください</option>`, ...Object.keys(data ?? {}).map((p) => `<option${p === sel ? " selected" : ""}>${esc(p)}</option>`)].join("");
  const cityOptions = (pref?: string, sel?: string) => [`<option value="">市区町村を選んでください</option>`, ...Object.keys((pref && data?.[pref]) || {}).map((c) => `<option${c === sel ? " selected" : ""}>${esc(c)}</option>`)].join("");

  function houmu(): Houmu | null {
    return (a.lpref && a.lcity && data?.[a.lpref]?.[a.lcity]) || null;
  }

  function screen(i: number): string {
    switch (i) {
      case 0: return q("亡くなった日", `<input type="date" name="death" class="ip-input" value="${esc(a.death ?? "")}">`, "分からなければ空欄のままで進めます（期限の日付は出ません）。") +
        q("亡くなったことを知った日が、亡くなった日と違いますか", radios("knownDiff", [["n", "同じ"], ["y", "後から知った"]], a.known ? "y" : "n") +
          `<div class="ip-sub" data-show="knownDiff=y"><input type="date" name="known" class="ip-input" value="${esc(a.known ?? "")}"></div>`,
          "相続放棄や相続税などの期限は「相続を知った日」から数えます。");
      case 1: return q("亡くなった方に配偶者はいますか", radios("spouse", [["y", "いる"], ["n", "いない"]], a.spouse)) +
        q("亡くなった方の子は何人ですか", countSelect("kids", a.kids, "子はいない"), "先に亡くなった子がいて、その子に子（孫）がいる場合は、孫の人数を足して数えてください。養子も含めます。") +
        `<div class="ip-sub" data-show="kids>0">${q("子の中に未成年（18歳未満）の人はいますか", radios("minor", YNU_OPTS, a.minor))}</div>` +
        `<div class="ip-sub" data-show="kids=0">${q("亡くなった方の親は存命ですか", `<select name="parents" class="ip-select"><option value="">選んでください</option>${[[2, "両親とも存命"], [1, "片方が存命"], [0, "どちらも亡くなっている"], [-1, "分からない"]].map(([v, l]) => `<option value="${v}"${a.parents === v ? " selected" : ""}>${l}</option>`).join("")}</select>`)}` +
        `<div class="ip-sub" data-show="parents=0">${q("亡くなった方の兄弟姉妹は何人ですか", countSelect("sibs", a.sibs, "いない"), "先に亡くなった兄弟姉妹に子（甥・姪）がいる場合は、その人数を足して数えてください。")}</div></div>`;
      case 2: return q("遺言書はありますか", radios("will", YNU_OPTS, a.will)) +
        `<div class="ip-sub" data-show="will=y">${q("どんな遺言書ですか", radios("willType", [["home", "自筆で、自宅などにあった"], ["notary", "公証役場で作った（公正証書）"], ["moj", "法務局に預けてあった"], ["u", "分からない"]], a.willType))}</div>` +
        q("亡くなった方に借金などの負債はありそうですか", radios("debt", YNU_OPTS, a.debt), "ローン・保証人・未払いの税金なども含みます。分からなければ「分からない」を選んでください。");
      case 3: return q("相続する不動産はどこにありますか", `<select name="lpref" class="ip-select">${prefOptions(a.lpref)}</select><select name="lcity" class="ip-select">${cityOptions(a.lpref, a.lcity)}</select>`, "管轄の法務局を調べるために使います。番地は要りません。複数の場所にあるときは、1か所ずつ作ってください。") +
        q("どんな不動産ですか（いくつでも）", `<div class="ip-choices">${(Object.keys(LAND_TYPE_LABEL) as LandType[]).map((t) => `<label class="ip-opt"><input type="checkbox" name="ltypes" value="${t}"${a.ltypes?.includes(t) ? " checked" : ""}><span>${esc(LAND_TYPE_LABEL[t])}</span></label>`).join("")}</div>`) +
        `<div class="ip-sub" data-show="ltypes~home">${q("誰も住まなくなる家はありますか", radios("vacant", YNU_OPTS, a.vacant))}</div>` +
        q("不動産の登記の名義は、亡くなった方ですか", radios("title", [["y", "はい"], ["n", "いいえ（祖父母など前の代のまま）"], ["u", "分からない"]], a.title), "固定資産税の通知書や登記簿で確認できます。");
      case 4: {
        const same = !a.dpref || (a.dpref === a.lpref && a.dcity === a.lcity);
        return `<p class="ip-why">相続放棄や遺言の検認は家庭裁判所、相続税の申告は税務署に出します。<br>どちらも、亡くなった方の最後の住所地で窓口が決まります（不動産の所在地とは別です）。</p>` +
          q("亡くなった方の最後の住所はどこですか", radios("dsame", [["y", "不動産と同じ市区町村"], ["n", "別の市区町村"]], same ? "y" : "n") +
            `<div class="ip-sub" data-show="dsame=n"><select name="dpref" class="ip-select">${prefOptions(a.dpref)}</select><select name="dcity" class="ip-select">${cityOptions(a.dpref, a.dcity)}</select></div>`, "市区町村までで十分です。");
      }
      case 5: return q("預貯金や証券口座はありますか", radios("bank", YNU_OPTS, a.bank)) +
        q("亡くなった方は年金を受け取っていましたか", radios("pension", YNU_OPTS, a.pension)) +
        q("死亡保険金を受け取れそうな保険はありますか", radios("insurance", YNU_OPTS, a.insurance));
      default: {
        const done = new Set(a.done ?? []);
        const list = PROCEDURES.filter((p) => p.when(a));
        const groups = CATEGORY_ORDER.map((c) => {
          const ps = list.filter((p) => p.cat === c);
          return ps.length ? `<p class="ip-cat">${esc(c)}</p><div class="ip-done-list">${ps.map((p) => `<div class="ip-done-opt${done.has(p.id) ? " is-done" : ""}"><span class="ip-done-title">${esc(p.title)}</span>${doneToggle(p.id, p.title, done.has(p.id))}</div>`).join("")}</div>` : "";
        }).join("");
        return q("もう済ませた手続きはありますか", groups, "済ませた手続きは「済んだ」に切り替えてください。結果では「済んだこと」に分けて表示します。結果の画面でもあとから切り替えられます。迷うものは「まだ」のまま進んでください。");
      }
    }
  }

  function readForm(form: HTMLFormElement) {
    const f = new FormData(form);
    const s = (k: string) => (f.get(k) as string | null) || undefined;
    const n = (k: string) => { const v = s(k); return v === undefined ? undefined : Number(v); };
    switch (step) {
      case 0: a.death = s("death"); a.known = s("knownDiff") === "y" ? s("known") : undefined; break;
      case 1:
        a.spouse = s("spouse") as Answers["spouse"]; a.kids = n("kids");
        a.minor = a.kids !== undefined && a.kids > 0 ? s("minor") as YNU : undefined;
        a.parents = a.kids === 0 ? n("parents") : undefined;
        a.sibs = a.kids === 0 && a.parents === 0 ? n("sibs") : undefined;
        break;
      case 2: a.will = s("will") as YNU; a.willType = a.will === "y" ? s("willType") as Answers["willType"] : undefined; a.debt = s("debt") as YNU; break;
      case 3:
        a.lpref = s("lpref"); a.lcity = a.lpref ? s("lcity") : undefined;
        a.ltypes = f.getAll("ltypes") as LandType[];
        a.vacant = a.ltypes.includes("home") ? s("vacant") as YNU : undefined;
        a.title = s("title") as YNU;
        break;
      case 4:
        if (s("dsame") === "n") { a.dpref = s("dpref"); a.dcity = a.dpref ? s("dcity") : undefined; }
        else { a.dpref = a.lpref; a.dcity = a.lcity; }
        break;
      case 5: a.bank = s("bank") as YNU; a.pension = s("pension") as YNU; a.insurance = s("insurance") as YNU; break;
      default: { const d = PROCEDURES.map((p) => p.id).filter((id) => f.get("t_" + id) === "1"); a.done = d.length ? d : undefined; }
    }
  }

  // data-show="名前=値" / "名前>0" / "名前~値"（チェックボックスに含む）で、関係する問いだけを見せる
  function applyShow(form: HTMLFormElement) {
    const f = new FormData(form);
    form.querySelectorAll<HTMLElement>("[data-show]").forEach((el) => {
      const m = el.dataset.show!.match(/^(\w+)([=>~])(.+)$/)!;
      const v = f.get(m[1]) as string | null;
      const ok = m[2] === "=" ? v === m[3] : m[2] === ">" ? v !== null && v !== "" && Number(v) > Number(m[3]) : f.getAll(m[1]).includes(m[3]);
      el.hidden = !ok;
    });
  }

  function renderStep() {
    root.innerHTML = `<form class="ip-step" novalidate>
<p class="ip-progress">質問 ${step + 1} / ${STEPS.length}：${STEPS[step]}</p>
<div class="ip-bar"><span style="width:${Math.round(((step + 1) / STEPS.length) * 100)}%"></span></div>
${screen(step)}
<div class="ip-nav">${step > 0 ? `<button type="button" class="ip-back">戻る</button>` : ""}<button type="submit" class="ip-next">${step === STEPS.length - 1 ? "手続きパックを作る" : "次へ"}</button></div>
<p class="ip-privacy">入力した内容はこの端末の中だけで処理され、どこにも送信・保存されません。</p>
</form>`;
    const form = root.querySelector("form")!;
    applyShow(form);
    form.addEventListener("change", (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.name === "lpref" || t.name === "dpref") {
        const city = form.querySelector<HTMLSelectElement>(`select[name="${t.name === "lpref" ? "lcity" : "dcity"}"]`)!;
        city.innerHTML = cityOptions(t.value);
      }
      applyShow(form);
    });
    form.querySelector(".ip-back")?.addEventListener("click", () => { readForm(form); step--; renderStep(); scrollTop(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      readForm(form);
      if (!started) { started = true; track("wizard_start"); }
      track("wizard_step", { step: step + 1 });
      if (step < STEPS.length - 1) { step++; renderStep(); scrollTop(); }
      else finish();
    });
  }

  function scrollTop() {
    const y = root.getBoundingClientRect().top + window.scrollY - 12;
    if (window.scrollY > y) window.scrollTo({ top: y, behavior: "smooth" });
  }

  function finish() {
    history.replaceState(null, "", "#" + encodeAnswers(a));
    track("wizard_complete");
    renderResult();
    scrollTop();
  }

  function itemHtml(i: PackItem, bucket: string): string {
    if (i.done) return `<li class="ip-item done"><div class="ip-item-head"><span class="ip-printbox">☑</span><span class="ip-title">${esc(i.p.title)}</span>${doneToggle(i.p.id, i.p.title, true)}</div></li>`;
    const days = i.daysLeft === null ? "" : bucket === "check" ? `<span class="ip-days check">済んでいなければ早めに窓口へ</span>` : i.daysLeft < 0 ? `<span class="ip-days past">${-i.daysLeft}日過ぎています</span>` : `<span class="ip-days">あと${i.daysLeft}日</span>`;
    const office = i.officeUrl ? `<a href="${esc(i.officeUrl)}" target="_blank" rel="noopener">${esc(i.office)}</a>` : esc(i.office);
    const consult = bucket === "past" ? `<p class="ip-consult"><b>相談先：</b>${consultFor(i).map((c) => (c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)) + (c.tel ? `（<a href="tel:${esc(c.tel)}">${esc(c.tel)}</a>）` : "")).join("／")}<br><small>期限を過ぎた後に取れる方法は事情によって変わります。早めに相談してください。</small></p>` : "";
    const more = [
      ...(i.p.notes ?? []).map((n) => `<li>${esc(n)}</li>`),
      i.p.docs?.length ? `<li>主に要るもの：${esc(i.p.docs.join("、"))}</li>` : "",
    ].join("");
    const src = i.p.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join("<br>");
    return `<li class="ip-item${i.strong ? " strong" : ""}">
<div class="ip-item-head"><span class="ip-printbox">□</span><span class="ip-title">${esc(i.p.title)}</span>${doneToggle(i.p.id, i.p.title, false)}</div>
<p class="ip-due">${esc(dueLabel(i))} ${days}</p>
<p class="ip-meta">窓口：${office}</p>
<p class="ip-action">${esc(i.p.action)}</p>
${consult}
<details class="ip-more"><summary>くわしく</summary><ul>${more}</ul><p class="ip-due-rule">期限の決まり方：${esc(i.due.text)}</p>${src ? `<p class="ip-src">出典：<br>${src}</p>` : ""}<p><a href="/guide/inherit/tetsuzuki/${i.p.id}">この手続きのページ</a></p></details>
</li>`;
  }

  function resultHtml(pk: Pack): string {
    const tl = taxLines(pk.tax);
    const todo = pk.items.filter((i) => !i.done), finished = pk.items.filter((i) => i.done);
    const groups = `<p class="ip-progress-line">全${pk.items.length}件のうち、済んだもの <b>${finished.length}件</b>／まだのもの <b>${todo.length}件</b><br><small>済ませた手続きは「済んだ」に切り替えると、下の「済んだこと」に移ります。</small></p>` +
      `<h4 class="ip-split">まだやっていないこと（${todo.length}件）</h4>` +
      (todo.length ? groupByBucket(todo).map(([b, list]) => `<h4 class="ip-bucket ${b}">${esc(BUCKET_LABEL[b])}</h4><ul class="ip-list">${list.map((i) => itemHtml(i, b)).join("")}</ul>`).join("") : `<p>すべて済んでいます。</p>`) +
      (finished.length ? `<h4 class="ip-split done">済んだこと（${finished.length}件）</h4><ul class="ip-list">${finished.map((i) => itemHtml(i, "done")).join("")}</ul>` : "");
    const choice = (g: "仕方" | "土地") => pk.choices.filter((c) => c.group === g).map((c) => `<div class="ip-card"><h5>${esc(c.title)}</h5><p><b>向いているとき：</b>${esc(c.fit)}</p><p><b>次の一手：</b>${esc(c.next)}</p><p><b>注意：</b>${esc(c.care)}</p>${c.link ? `<p><a href="${esc(c.link.href)}"${c.link.href.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>${esc(c.link.label)}</a></p>` : ""}</div>`).join("");
    const head = [pk.death ? `亡くなった日：${fmtDateShort(pk.death)}` : "", pk.houmu ? `管轄の法務局：${esc(pk.houmu.office)}` : ""].filter(Boolean).join("<br>");
    return `<div class="ip-result">
<div class="ip-toolbar no-print"><button type="button" class="ip-edit">回答を直す</button><button type="button" class="ip-reset">最初からやり直す</button></div>
<h3>あなたの相続の手続きパック</h3>
${head ? `<p class="ip-head">${head}</p>` : ""}
${pk.death ? "" : `<p class="ip-warn">亡くなった日が未入力のため、期限の日付は出していません。</p>`}
<section class="no-print ip-exports ip-exports-top"><h4>保存・印刷する</h4>
<div class="exports"><button type="button" data-x="pdf">PDF（3枚・横）</button><button type="button" data-x="csv">表で保存（Excel）</button><button type="button" data-x="ics">カレンダーに追加</button><button type="button" data-x="md">Markdownで保存</button><button type="button" data-x="mdcopy">Markdownコピー</button><button type="button" data-x="txt">メモ用にコピー</button></div>
<p class="small ip-ics-note"></p>
<details class="small ip-exports-help"><summary>それぞれの使い方</summary><p>表（シート）は、済んだもの・まだのものを1行ずつ並べたCSVファイルです。ExcelやGoogleスプレッドシートで開くと、済んだ日やメモを書き込んで管理できます。<br>カレンダーには、まだ済んでいない手続きのうち今日より後の期限を、1か月前と1週間前の通知つきで書き出します。<br>このページのURLをブックマークすると、同じパックをあとから開き直せます。<br>回答はURLの「#」より後ろに入っていて、サーバーには送られません。共有するときは回答の内容が見える点にご注意ください。</p></details>
</section>
<section class="ip-block"><h3>1. あなたがしなければならないこと</h3>${groups}
<div class="ip-tax"><h4>相続税の申告が要るかの目安</h4>${tl.head.map((l) => `<p>${esc(l)}</p>`).join("")}<p class="small">遺産の合計を出すときの注意</p><ul class="small">${tl.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul><p class="small">${esc(tl.tail).replace("相続税の申告要否判定コーナー", '<a href="https://www.keisan.nta.go.jp/sozoku/yohihantei/top" target="_blank" rel="noopener">相続税の申告要否判定コーナー</a>')}</p></div>
</section>
<section class="ip-block ip-choices-block"><h3>2. あなたに選べること</h3><h4>相続の仕方</h4><div class="ip-cards">${choice("仕方")}</div><h4>土地・家をどうするか</h4><div class="ip-cards">${choice("土地")}</div><p class="small">売却・解体・管理・活用は、1社で決めず複数社の見積りと説明を比べてから決めるのが安全です。</p></section>
<section class="ip-block"><h3>3. 大きな失敗をしないために</h3><ul class="ip-cautions">${pk.cautions.map((k) => `<li class="${k.isStrong ? "strong" : ""}"><b>${esc(k.title)}</b><br>${esc(k.why)}</li>`).join("")}</ul></section>
<p class="small">手続きの内容は${CHECKED_JA}に公式の案内で確認しました。<br>一般的な手続きの目安で、個別の事情への助言ではありません。期限が土日祝日にあたる場合の扱いは、手続きごとに窓口へご確認ください。</p>
</div>`;
  }

  function download(name: string, text: string, type: string) {
    const blob = new Blob([text], { type });
    const el = document.createElement("a");
    el.href = URL.createObjectURL(blob);
    el.download = name;
    document.body.appendChild(el);
    el.click();
    setTimeout(() => { URL.revokeObjectURL(el.href); el.remove(); }, 500);
  }
  function copy(text: string, btn: HTMLButtonElement) {
    const done = () => { const old = btn.textContent; btn.textContent = "コピーしました"; setTimeout(() => { btn.textContent = old; }, 2000); };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch { /* noop */ }
      ta.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  /** A4横で印刷する（「PDFに保存」を選ぶとPDFになる）。用紙の向きはこの印刷のときだけ変える */
  function printPdf() {
    const st = document.createElement("style");
    st.textContent = "@page { size: A4 landscape; margin: 10mm; }";
    document.head.appendChild(st);
    document.body.classList.add("print-pdf");
    const done = () => { st.remove(); document.body.classList.remove("print-pdf"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(() => { if (!matchMedia("print").matches) done(); }, 1000);
  }

  function renderResult(first = true) {
    const pk = buildPack(a, today(), houmu(), contacts());
    root.innerHTML = resultHtml(pk) + buildPdfHtml(pk);
    root.querySelector(".ip-edit")!.addEventListener("click", () => { step = 0; renderStep(); scrollTop(); });
    root.querySelector(".ip-reset")!.addEventListener("click", () => { a = preset ? { lpref: preset } : {}; step = 0; history.replaceState(null, "", location.pathname); renderStep(); scrollTop(); });
    const ics = buildIcs(pk);
    const icsBtn = root.querySelector<HTMLButtonElement>('[data-x="ics"]')!;
    if (!ics) { icsBtn.disabled = true; root.querySelector(".ip-ics-note")!.textContent = "カレンダーに入れられる今後の期限がありません（亡くなった日を入れると計算します）。"; }
    root.querySelector(".ip-exports")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-x]");
      if (!b) return;
      const x = b.dataset.x!;
      track("pack_export", { via: x });
      if (x === "pdf") printPdf();
      else if (x === "ics" && ics) download("相続の手続きの期限.ics", ics, "text/calendar");
      else if (x === "csv") download("相続の手続き一覧.csv", buildCsv(pk), "text/csv");
      else if (x === "md") download("相続の手続きパック.md", buildMarkdown(pk), "text/markdown");
      else if (x === "mdcopy") copy(buildMarkdown(pk), b);
      else if (x === "txt") copy(buildPlainText(pk), b);
    });
    root.querySelector(".ip-block")!.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      const id = t.dataset.done;
      if (!id) return;
      const set = new Set(a.done ?? []);
      if (t.value === "1") set.add(id); else set.delete(id);
      a.done = set.size ? PROCEDURES.map((p) => p.id).filter((x) => set.has(x)) : undefined;
      history.replaceState(null, "", "#" + encodeAnswers(a));
      const y = window.scrollY;
      renderResult(false);
      window.scrollTo(0, y);
    });
    const cb = root.querySelector(".ip-choices-block");
    if (first && cb && "IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { track("decision_view"); io.disconnect(); } });
      io.observe(cb);
    }
  }

  void Promise.all([dataReady, officesReady]).then(() => {
    const hash = location.hash.slice(1);
    if (hash && /(^|&)(death|spouse|kids|will|debt|lpref|done)=/.test(hash)) {
      a = decodeAnswers(hash);
      track("restored", { source: "inherit" });
      renderResult();
    } else {
      if (preset) a.lpref = preset;
      renderStep();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("inherit-pack");
  if (root) mount(root);
});
