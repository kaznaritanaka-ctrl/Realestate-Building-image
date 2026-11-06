import maplibregl from "maplibre-gl";
import { type BuildingShape, computePlans, type EngineResult, type RoadWidthClass, type UseKey, type Plan } from "../engine/engine.ts";
import { lngLatToLocal, area, type Vec2 } from "../engine/geom.ts";
import { ZONES, ZONE_ORDER, type ZoneKey } from "../engine/zoning.ts";
import { Viewer, type ExteriorStyle, type ViewSide } from "./viewer.ts";
import { track, areaBucket, SID } from "./track.ts";
import { exportControlPackage } from "./export.ts";
import { fetchSiteInfo, areaClass, siteInfoHtml, CONTROL_WARNING, type SiteInfo } from "./siteinfo.ts";

type EdgeChoice = RoadWidthClass | "none";
interface State {
  step: number;
  points: Vec2[];          // [lng, lat]
  edges: EdgeChoice[];
  zone: ZoneKey;
  bcr: string; far: string;
  focus: "" | UseKey;
  stage: string;
  sample: boolean;
  zoneSource: "api" | "user" | "guess" | "none";
  zoneFetchedFor: string;
  zoneApi: ZoneApi | null;
  located?: boolean;
  purposeSet?: boolean;
  showContext?: boolean;
  rotOffset?: number;
  situation?: Situation;
  style?: ExteriorStyle;
  shape?: BuildingShape;
}
type Situation = "house" | "land" | "akiya" | "sell" | "inherit";
const SITUATIONS: Situation[] = ["house", "land", "akiya", "sell", "inherit"];
const STEP_TITLES = ["状況", "土地の場所", "敷地の形", "前面道路", "土地のルール", "使い道", "結果"];
interface ZoneApi { available: boolean; found?: boolean; zoneName?: string | null; bcr?: number | null; far?: number | null; city?: string; source?: string; note?: string }

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll(s)) as T[];
const KEY = "tochi-mirai:v1";

const state: State = load() ?? { step: 0, points: [], edges: [], zone: "unknown", bcr: "", far: "", focus: "house", stage: "curious", sample: false, zoneSource: "none", zoneFetchedFor: "", zoneApi: null };
applyFocusParam(state);
const restored = applyShareHash(state);
state.zoneSource ??= "none"; state.zoneFetchedFor ??= ""; state.zoneApi ??= null;

// ガイドページなどから ?focus=house|rental|other で来たら、使い道の初期値にする（入力の途中なら上書きしない）
function applyFocusParam(st: State) {
  const q = new URLSearchParams(location.search);
  const f = q.get("focus");
  if ((f === "house" || f === "rental" || f === "other") && !st.purposeSet) st.focus = f;
  // トップページの入口から ?s=house|land|akiya|sell|inherit で来たら、状況を選んだ状態で始める
  const sit = q.get("s") as Situation | null;
  if (sit && SITUATIONS.includes(sit)) setSituation(st, sit);
  else if (f === "house" && !st.situation) st.situation = "house";
  else if ((f === "rental" || f === "other") && !st.situation) st.situation = "land";
}
// 結果を開き直すリンク：入力の内容だけを URL の # 以降に入れる（# 以降はサーバーに送られない）
interface ShareData { v: 1; p: Vec2[]; e: EdgeChoice[]; z: ZoneKey; b?: string; f?: string; u: "" | UseKey; s?: Situation; st?: ExteriorStyle; r?: number; zs?: State["zoneSource"]; sh?: BuildingShape }
function encodeShare(): string {
  const d: ShareData = { v: 1, p: state.points.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]), e: state.edges, z: state.zone, u: state.focus, s: state.situation, st: state.style, r: state.rotOffset || undefined, zs: state.zoneSource, sh: state.shape && state.shape !== "auto" ? state.shape : undefined };
  if (state.bcr) d.b = state.bcr; if (state.far) d.f = state.far;
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = ""; bytes.forEach(c => (bin += String.fromCharCode(c)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function shareUrl(): string {
  const c = state.points.length ? centroid() : [135.5, 34.75];
  return `${location.origin}/new.html#r=${encodeShare()}&map=19/${c[1].toFixed(6)}/${c[0].toFixed(6)}`;
}
function applyShareHash(st: State): boolean {
  const m = location.hash.match(/(?:^#|&)r=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))) as ShareData;
    if (d.v !== 1 || !Array.isArray(d.p) || d.p.length < 3 || d.p.length > 60) return false;
    if (!d.p.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) return false;
    if (!(d.z in ZONES)) return false;
    Object.assign(st, {
      points: d.p, edges: (d.e ?? []).slice(0, d.p.length), zone: d.z, bcr: d.b ?? "", far: d.f ?? "",
      focus: d.u ?? "house", situation: d.s, style: d.st ?? st.style, rotOffset: d.r ?? 0, shape: d.sh ?? "auto",
      zoneSource: d.zs ?? "user", sample: false, located: true, purposeSet: true, step: 6, zoneFetchedFor: "", zoneApi: null,
    });
    history.replaceState(null, "", location.pathname + location.search + location.hash.replace(/(^#|&)r=[A-Za-z0-9_-]+/, "$1").replace(/^#&/, "#"));
    return true;
  } catch { return false; }
}
function setSituation(st: State, sit: Situation) {
  st.situation = sit;
  if (!st.purposeSet) { if (sit === "house") st.focus = "house"; else if (sit === "land") st.focus = "rental"; }
}
function load(): State | null { try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 保存できない環境では無視 */ } }

// ---------- 地図 ----------
const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      photo: { type: "raster", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18, attribution: ATTR },
      std: { type: "raster", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 18, attribution: ATTR },
    },
    layers: [
      { id: "std", type: "raster", source: "std", layout: { visibility: "none" } },
      { id: "photo", type: "raster", source: "photo" },
    ],
  },
  center: state.points[0] ?? [135.5, 34.75],
  zoom: state.points.length ? 18.5 : 10,
  maxZoom: 21,
  attributionControl: { compact: true },
  doubleClickZoom: false,
  hash: "map", // #map=ズーム/緯度/経度（#r= の共有データと並べて使う）
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

const EDGE_COLORS: Record<EdgeChoice, string> = { none: "#ffffff", lt4: "#f2b134", "4to6": "#f08a24", "6to12": "#e2572c", gte12: "#b8302a" };
let edgeMarkers: maplibregl.Marker[] = [];
let vertexMarkers: maplibregl.Marker[] = [];

map.on("load", () => {
  map.addSource("draw", { type: "geojson", data: fc([]) });
  map.addSource("edges", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "draw-fill", type: "fill", source: "draw", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#2f6f5e", "fill-opacity": 0.25 } });
  map.addLayer({ id: "draw-line", type: "line", source: "draw", filter: ["!=", "$type", "Point"], paint: { "line-color": "#ffffff", "line-width": 2.5 } });
  map.addLayer({ id: "edges", type: "line", source: "edges", paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "road"], 7, 3] } });
  redrawMap();
});

const MIN_DRAW_ZOOM = 16;
const zoomWarn = () => { $("#zoom-warn").hidden = !(state.step === 2 && map.getZoom() < MIN_DRAW_ZOOM); };
map.on("zoomend", zoomWarn);
map.on("moveend", (e) => { if ((e as { originalEvent?: unknown }).originalEvent && state.step === 1 && !state.located) { state.located = true; save(); paintStepper(); track("located", { via: "move" }); } });

// 画面上の点が地図の上に重ねたボタンの範囲内か
function overlayHit(x: number, y: number): boolean {
  return $$("#map-tools button, .maplibregl-ctrl-group, .maplibregl-ctrl-attrib").some(el => {
    const r = el.getBoundingClientRect(); return r.width > 0 && x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
  });
}
// 地図の上のボタンの操作は地図に伝えない
for (const ev of ["pointerdown", "mousedown", "touchstart", "click", "dblclick"]) $("#map-tools").addEventListener(ev, (e) => e.stopPropagation());
// 頂点の近くを触ったときは追加しない（ドラッグのつもりで少しずれた場合）。指ではさらに広めに取る
const COARSE = matchMedia("(pointer: coarse)").matches;
const NEAR_PX = COARSE ? 36 : 16;
map.on("click", (e) => {
  if (state.step !== 2) return;
  if (map.getZoom() < MIN_DRAW_ZOOM) { zoomWarn(); return; }
  const near = state.points.some(p => { const q = map.project(p as [number, number]); return Math.hypot(q.x - e.point.x, q.y - e.point.y) < NEAR_PX; });
  if (near) return;
  // 地図の上のボタン（地図/航空写真の切り替え・拡大縮小など）を押したときは追加しない
  const t = (e.originalEvent as MouseEvent | undefined)?.target as HTMLElement | null;
  if (t && t.closest("button, a, .maplibregl-ctrl, .map-tools, .style-pick, .orient")) return;
  const ev = e.originalEvent as MouseEvent | undefined;
  if (ev && overlayHit(ev.clientX, ev.clientY)) return;
  state.points.push([e.lngLat.lng, e.lngLat.lat]);
  state.edges = [];
  save(); redrawMap(); updateArea(); paintStepper();
});

function fc(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection { return { type: "FeatureCollection", features }; }

function drawShape() {
  const pts = state.points;
  const feats: GeoJSON.Feature[] = [];
  if (pts.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
  else if (pts.length === 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
  (map.getSource("draw") as maplibregl.GeoJSONSource | undefined)?.setData(fc(feats));
}

function redrawMap() {
  const pts = state.points;
  drawShape();

  vertexMarkers.forEach(m => m.remove());
  vertexMarkers = state.step === 2 ? pts.map((p, i) => {
    const el = document.createElement("div"); el.className = "vtx"; el.title = `頂点${i + 1}（ドラッグで移動）`;
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
    // ドラッグ中は形だけ描き直し、離したときに保存と面積更新
    m.on("drag", () => { const ll = m.getLngLat(); state.points[i] = [ll.lng, ll.lat]; drawShape(); updateArea(); });
    m.on("dragend", () => { save(); });
    el.addEventListener("click", (ev) => ev.stopPropagation());
    return m;
  }) : [];

  const edgeFeats: GeoJSON.Feature[] = [];
  edgeMarkers.forEach(m => m.remove()); edgeMarkers = [];
  if (state.step >= 3 && pts.length >= 3) {
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const choice = state.edges[i] ?? "none";
      edgeFeats.push({ type: "Feature", properties: { color: state.step === 3 && i === selEdge ? "#2f6f5e" : EDGE_COLORS[choice], road: choice !== "none" || (state.step === 3 && i === selEdge) }, geometry: { type: "LineString", coordinates: [p, q] } });
      const el = document.createElement("button"); el.type = "button";
      el.className = "edge-label" + (choice !== "none" ? " road" : "") + (state.step === 3 && i === selEdge ? " sel" : "");
      el.textContent = String(i + 1); el.setAttribute("aria-label", `辺${i + 1}を選ぶ`);
      el.addEventListener("click", (ev) => { ev.stopPropagation(); if (state.step === 3) { selEdge = i; redrawMap(); renderEdgeList(); } });
      edgeMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]).addTo(map));
    });
  }
  (map.getSource("edges") as maplibregl.GeoJSONSource | undefined)?.setData(fc(edgeFeats));
}

function localPolygon(): Vec2[] { return lngLatToLocal(state.points).local; }
function edgeLen(i: number) {
  const L = localPolygon(); const a = L[i], b = L[(i + 1) % L.length];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function updateArea() {
  const ok = state.points.length >= 3;
  $("#area-val").textContent = ok ? `約${area(localPolygon()).toFixed(1)}㎡（約${(area(localPolygon()) / 3.30579).toFixed(1)}坪）` : `${state.points.length}点（3点以上必要）`;
  ($("#shape-done") as HTMLButtonElement).disabled = !ok;
}

// ---------- ステップ遷移 ----------
let viewer: Viewer | null = null;
let result: EngineResult | null = null;
let activePlan = 0;

function go(step: number) {
  const from = state.step;
  if (step === 6 && !compute()) return;
  track("step_enter", { step });
  if (from === 2 && step === 3) state.rotOffset = 0;
  if (from === 2 && step === 3 && state.points.length >= 3) track("shape_done", { areaBucket: areaBucket(area(localPolygon())), edges: state.points.length });
  if (from === 3 && step === 4) track("road_set", { roads: state.edges.filter(e => e !== "none").length });
  state.step = step; save();
  $$("section.wstep").forEach(s => (s.hidden = Number(s.dataset.step) !== step));
  paintStepper();
  const show3d = step === 6;
  // 画面の種類：q＝質問だけ（スマホでは地図を隠す）、map＝地図の操作、result＝3D
  document.body.dataset.mode = show3d ? "result" : (step === 0 || step === 4 || step === 5) ? "q" : "map";
  $("#viewer").hidden = !show3d;
  $("#map").style.visibility = show3d ? "hidden" : "visible";
  $("#map-tools").hidden = show3d;
  $("#crosshair").hidden = step !== 2;
  $("#orient").hidden = !show3d;
  $("#style-pick").hidden = !show3d;
  $("#views").hidden = !show3d;
  fitMobileStage();
  if (show3d) ($(".app") as HTMLElement).scrollTop = 0;
  if (step === 2) { updateArea(); zoomWarn(); }
  if (step === 3) renderEdgeList();
  if (step === 4) renderZone();
  if (show3d) renderResult(); else requestAnimationFrame(() => map.resize());
  redrawMap();
  if (step === 3 && state.points.length >= 3) {
    const b = new maplibregl.LngLatBounds(); state.points.forEach(p => b.extend(p));
    map.fitBounds(b, { padding: 80, maxZoom: 20, duration: 400 });
  }
  $("#panel").scrollTop = 0;
}

/** 各ステップが入力済みか */
function isDone(n: number): boolean {
  switch (n) {
    case 0: return !!state.situation;
    case 1: return !!state.located || state.points.length > 0;
    case 2: return state.points.length >= 3;
    case 3: return state.edges.some(e => e !== "none");
    case 4: return state.zoneSource !== "none";
    case 5: return !!state.purposeSet;
    case 6: return !!result;
    default: return false;
  }
}
const STEP_SHORT = ["状況", "場所", "敷地", "道路", "ルール", "使い道", "結果"];
function paintStepper() {
  const st = state.step;
  $("#prog-title").textContent = STEP_TITLES[st];
  $("#prog-count").textContent = st < 6 ? `${st + 1} / 6` : "";
  $("#back-label").textContent = st === 0 ? "トップへ" : `戻る`;
  const nav = $("#steps-nav");
  if (!nav.children.length) {
    STEP_SHORT.forEach((label, n) => {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" data-goto="${n}"><i>${n < 6 ? n + 1 : "✓"}</i><span>${label}</span></button>`;
      nav.appendChild(li);
    });
  }
  $$<HTMLButtonElement>("#steps-nav button").forEach(b => {
    const n = Number(b.dataset.goto);
    const active = n === st, done = isDone(n);
    b.classList.toggle("active", active);
    b.classList.toggle("done", !active && done);
    b.classList.toggle("todo", !active && !done);
    b.setAttribute("aria-label", `${n < 6 ? `手順${n + 1}` : ""}${STEP_TITLES[n]}（${active ? "表示中" : done ? "入力済み" : "未入力"}）`);
    if (active) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
  });
}

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-next]") as HTMLElement | null;
  if (t) { e.preventDefault(); if (t.id === "run-btn") { state.purposeSet = true; } go(Number(t.dataset.next)); return; }
  const g = (e.target as HTMLElement).closest("[data-goto]") as HTMLElement | null;
  if (g) { e.preventDefault(); const n = Number(g.dataset.goto); if (n !== state.step) { track("step_jump", { step: n }); go(n); } return; }
  const c = (e.target as HTMLElement).closest("[data-situation]") as HTMLElement | null;
  if (c) {
    setSituation(state, c.dataset.situation as Situation); save(); syncRadios(); paintSituation();
    track("situation", { situation: state.situation });
    go(1);
  }
});
$("#back-btn").addEventListener("click", () => { if (state.step <= 0) location.href = "/"; else go(state.step - 1); });
function paintSituation() { $$("[data-situation]").forEach(b => b.classList.toggle("selected", b.dataset.situation === state.situation)); }

// 結果を残す：PDF（端末の印刷機能）と、自分宛のメール（端末のメールアプリ）。どちらもサーバーには送らない
function planLine(p: Plan): string {
  const m = p.metrics;
  const parts = [p.title.replace(/^[ABC]案：/, `${p.id}案 `)];
  if (m.gfa > 0) parts.push(`${m.floors}階・延床 約${m.gfa}㎡（約${(m.gfa / 3.30579).toFixed(1)}坪）`);
  if (m.units != null) parts.push(`${m.units}戸`);
  if (m.parking) parts.push(`駐車${m.parking}台`);
  parts.push(`概算 約${yen(m.costMin)}〜${yen(m.costMax)}円`);
  return parts.join("・");
}
function siteLine(): string {
  const s = result!.site;
  return `敷地 約${s.area}㎡（約${(s.area / 3.30579).toFixed(1)}坪）・${s.zone.label}・建ぺい率${s.bcr}％／容積率${s.far}％`;
}
$("#mail-btn").addEventListener("click", () => {
  if (!result) return;
  const subject = `土地の未来図：この土地の3案（約${result.site.area}㎡・${result.site.zone.label}）`;
  const body = [
    "土地の未来図（β版）で作った3案のメモです。", "",
    siteLine(), "",
    ...result.plans.map(planLine), "",
    "この結果をもう一度開く：", shareUrl(), "",
    "※表示は参考イメージと概算です。建築できることを保証するものではありません。",
  ].join("\n");
  track("save_result", { via: "mail" });
  location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});
$("#copy-btn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(shareUrl()); alertBox("この結果を開くリンクをコピーしました。"); }
  catch { prompt("このリンクをコピーしてください", shareUrl()); }
  track("save_result", { via: "link" });
});
$("#pdf-btn").addEventListener("click", async () => {
  if (!result || !viewer) return;
  const btn = $("#pdf-btn") as HTMLButtonElement; btn.disabled = true;
  const keep = activePlan;
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const shots: string[] = [];
  try {
    for (let i = 0; i < result.plans.length; i++) {
      viewer.setPlan(result.plans[i], result.site.rotation); await frames();
      shots.push(viewer.snapshot("image/jpeg", 0.85));
    }
  } finally { viewer.setPlan(result.plans[keep], result.site.rotation); btn.disabled = false; }
  const info = $("#site-info-box details")?.innerHTML.replace(/<summary>[\s\S]*?<\/summary>/, "") ?? "";
  const s = result.site;
  $("#print-sheet").innerHTML = `
    <h1>土地の未来図（β版）：この土地の3案</h1>
    <p class="meta">${new Date().toLocaleDateString("ja-JP")} 作成・外観：${({ wa: "和風", white: "ホワイト", black: "ブラック" } as const)[state.style ?? "white"]}</p>
    <table class="kv">
      <tr><th>敷地面積</th><td>約${s.area}㎡（約${(s.area / 3.30579).toFixed(1)}坪）</td></tr>
      <tr><th>用途地域</th><td>${esc(s.zone.label)}</td></tr>
      <tr><th>建ぺい率／容積率</th><td>${s.bcr}％／${s.far}％（計算上の容積率 ${s.farEffective}％）</td></tr>
      <tr><th>前面道路</th><td>${s.roadWidth == null ? "なし" : s.roadWidth >= 12 ? "12m以上" : `約${s.roadWidth}m として計算`}</td></tr>
    </table>
    ${result.plans.map((p, i) => `<section class="pplan"><img src="${shots[i]}" alt="${esc(p.title)}の3D"><div>${planHtml(p)}</div></section>`).join("")}
    ${info && !state.sample ? `<section class="pinfo"><h2>この土地の参考情報</h2>${info}</section>` : ""}
    <p class="small">表示は参考イメージと概算です。設計図・見積もりではなく、建築できること・法令に適合することを保証するものではありません。概算工事費は当サービスの暫定の目安です。</p>
    <p class="small">この結果をもう一度開く：${esc(shareUrl())}</p>`;
  track("save_result", { via: "pdf" });
  $("#print-view").hidden = false; $("#print-view").scrollTop = 0;
  ($("#pv-print") as HTMLButtonElement).focus();
});
// 印刷はボタンを押した直後に呼ぶ（iPhoneのSafariは、間に処理を挟むと止める）
$("#pv-print").addEventListener("click", () => { track("save_result", { via: "print" }); window.print(); });
$("#pv-close").addEventListener("click", () => { $("#print-view").hidden = true; ($("#pdf-btn") as HTMLButtonElement).focus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#print-view").hidden) $("#print-view").hidden = true; });

// 視点の操作盤：東西南北と道路側からの内向き矢印 × 鳥瞰／目線（合計10通り）。手で回す操作もそのまま使える
let viewH: "bird" | "eye" = "bird";
let viewSide: ViewSide | "" = "";
function paintViews() {
  $$<HTMLButtonElement>("#views [data-h]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.h === viewH)));
  $$<HTMLButtonElement>("#views [data-side]").forEach(b => b.classList.toggle("on", b.dataset.side === viewSide));
}
function placeRoadButton() {
  // 8方向のボタンを輪の上に等間隔で並べ、矢印を中心に向ける
  const ring = $(".gz-ring"); const half = ring.offsetWidth / 2;
  $$<HTMLButtonElement>(".gz-dir").forEach(btn => {
    const deg = Number(btn.dataset.deg), rad = (deg * Math.PI) / 180, r = half - btn.offsetWidth / 2 - 3;
    btn.style.left = `${(half + Math.sin(rad) * r).toFixed(1)}px`;
    btn.style.top = `${(half - Math.cos(rad) * r).toFixed(1)}px`;
    btn.style.setProperty("--rot", `${deg}deg`);
  });
  const rb = viewer?.roadBearing();
  const b = $("#gz-road");
  if (rb == null || !result?.site.roadsUV.length) { b.hidden = true; return; }
  b.hidden = false;
  // 輪の外側、道路のある方位に置く。ボタンの矢印は建物（中心）を向く
  const R = $(".gz-ring").offsetWidth / 2 + 4;
  b.style.left = `calc(50% + ${(Math.sin(rb) * R).toFixed(1)}px)`;
  b.style.top = `calc(50% - ${(Math.cos(rb) * R).toFixed(1)}px)`;
  b.style.setProperty("--rot", `${(rb * 180) / Math.PI + 180}deg`);
}
// スマホでは視点と向きの操作を3Dの外（下のシートの上部）に置く。パソコンでは3Dの上に重ねる
const MOBILE = matchMedia("(max-width: 760px)");
function placeControls() {
  const slot = $("#ctrl-slot"), stage = $(".stage");
  const g = $("#views"), o = $("#orient"), sp = $("#style-pick"), pm = $("#plan-mini");
  const target = MOBILE.matches ? slot : stage;
  if (g.parentElement !== target) {
    const w = $("#area-warn"), sec = $('section[data-step="6"]');
    if (MOBILE.matches) { slot.append(w, pm, sp, g, o); } else { stage.append(sp, g, o); slot.prepend(pm); sec.insertBefore(w, slot); }
  }
  slot.hidden = !MOBILE.matches;
  fitMobileStage();
  if (state.step === 6) placeRoadButton();
}
// スマホの結果画面：3Dと操作パネルでちょうど1画面になるよう、3Dの高さを合わせる
function fitMobileStage() {
  const stage = $(".stage") as HTMLElement;
  if (!MOBILE.matches || state.step !== 6) { stage.style.height = ""; return; }
  const hdr = ($("header.site") as HTMLElement).offsetHeight;
  const ctrl = ($("#ctrl-slot") as HTMLElement).offsetHeight;
  stage.style.height = `${Math.max(220, innerHeight - hdr - ctrl)}px`;
}
addEventListener("resize", fitMobileStage);
MOBILE.addEventListener("change", placeControls);
placeControls();
addEventListener("resize", () => { if (state.step === 6) placeRoadButton(); });
$$<HTMLButtonElement>("#views [data-side]").forEach(b => b.addEventListener("click", () => {
  viewSide = b.dataset.side as typeof viewSide; paintViews(); viewer?.setView(viewSide as ViewSide, viewH);
  track("view", { h: viewH, dir: viewSide });
}));
$$<HTMLButtonElement>("#views [data-h]").forEach(b => b.addEventListener("click", () => {
  viewH = b.dataset.h as "bird" | "eye"; if (!viewSide) viewSide = "road"; paintViews();
  viewer?.setView(viewSide as ViewSide, viewH);
  track("view", { h: viewH, dir: viewSide });
}));

// 上限案の建物の形（おまかせ・長方形・L字・コの字）
function paintShape() {
  $$<HTMLButtonElement>("#shape-pick [data-shape]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.shape === (state.shape ?? "auto"))));
}
$$<HTMLButtonElement>("#shape-pick [data-shape]").forEach(b => b.addEventListener("click", () => {
  const v = b.dataset.shape as BuildingShape;
  if ((state.shape ?? "auto") === v) return;
  state.shape = v; save(); paintShape();
  const keep = activePlan;
  if (compute()) {
    // 形が効くのは上限案なので、上限案を表示する
    const maxIdx = result!.plans.findIndex(p => p.size === "max");
    activePlan = maxIdx >= 0 ? maxIdx : Math.min(keep, result!.plans.length - 1);
    renderResult();
  }
  track("shape", { shape: v });
}));

// 外観のスタイル（和風・ホワイト・ブラック）
function paintStyle() {
  $$<HTMLButtonElement>("#style-pick button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.style === (state.style ?? "white"))));
}
$$<HTMLButtonElement>("#style-pick button").forEach(b => b.addEventListener("click", () => {
  state.style = b.dataset.style as ExteriorStyle; save(); paintStyle();
  viewer?.setStyle(state.style); track("style", { style: state.style });
}));

// Step2：中央の＋の位置に角を追加（地図を直接タップするより狙いやすい）
$("#add-btn").addEventListener("click", () => {
  if (map.getZoom() < MIN_DRAW_ZOOM) { zoomWarn(); return; }
  const c = map.getCenter(); state.points.push([c.lng, c.lat]); state.edges = [];
  save(); redrawMap(); updateArea(); paintStepper();
});

// Step1：住所検索（国土地理院 住所検索API）
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = ($("#search-q") as HTMLInputElement).value.trim();
  const ul = $("#search-results");
  if (!q) return;
  ul.innerHTML = "<li class='muted'>検索中…</li>";
  try {
    const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
    const data: { geometry: { coordinates: [number, number] }; properties: { title: string } }[] = await res.json();
    ul.innerHTML = "";
    if (!data.length) { ul.innerHTML = "<li class='muted'>見つかりませんでした。表記を変えて試すか、地図を直接動かしてください。</li>"; return; }
    for (const d of data.slice(0, 8)) {
      const li = document.createElement("li");
      const b = document.createElement("button"); b.type = "button"; b.className = "linklike"; b.textContent = d.properties.title;
      b.addEventListener("click", () => { map.jumpTo({ center: d.geometry.coordinates, zoom: 18.5 }); ul.innerHTML = ""; state.located = true; save(); paintStepper(); track("located", { via: "search" }); });
      li.appendChild(b); ul.appendChild(li);
    }
  } catch {
    ul.innerHTML = "<li class='muted'>検索できませんでした。地図を直接動かして場所を合わせてください。</li>";
  }
});

$("#sample-btn").addEventListener("click", () => {
  // 架空の敷地（約12m×20mのやや変形した土地）。実在の土地を表すものではない
  const c: Vec2 = map.getCenter().toArray() as Vec2;
  const dLat = 1 / 111320, dLng = 1 / (111320 * Math.cos((c[1] * Math.PI) / 180));
  const local: Vec2[] = [[0, 0], [12.5, 0], [13.5, 19], [-0.5, 20.5]];
  state.points = local.map(([x, y]) => [c[0] + x * dLng, c[1] + y * dLat]);
  state.edges = ["4to6", "none", "none", "none"];
  state.zone = "r1mid"; state.bcr = ""; state.far = ""; state.sample = true; state.zoneSource = "guess"; state.located = true; state.purposeSet = true;
  state.situation ??= "house";
  save(); track("sample_used"); go(6);
});

$("#undo-btn").addEventListener("click", () => { state.points.pop(); state.edges = []; save(); redrawMap(); updateArea(); paintStepper(); });
$("#clear-btn").addEventListener("click", () => { state.points = []; state.edges = []; state.sample = false; save(); redrawMap(); updateArea(); paintStepper(); });
$("#restart-btn").addEventListener("click", () => {
  Object.assign(state, { points: [], edges: [], sample: false, located: false, purposeSet: false, zoneSource: "none", zoneFetchedFor: "", zoneApi: null, rotOffset: 0, situation: undefined });
  result = null; save(); track("restart"); paintSituation(); go(0);
});

let photo = true;
$("#layer-btn").addEventListener("click", () => {
  photo = !photo;
  map.setLayoutProperty("photo", "visibility", photo ? "visible" : "none");
  map.setLayoutProperty("std", "visibility", photo ? "none" : "visible");
  $("#layer-btn").textContent = photo ? "地図に切替" : "航空写真に切替";
});

// Step3：道路辺。地図の番号をタップして辺を選び、道路の幅を大きなボタンで選ぶ
let selEdge = 0;
const WIDTH_OPTS: [EdgeChoice, string, string][] = [
  ["lt4", "車1台がやっと通れる", "4m未満"], ["4to6", "車がすれ違える", "4〜6m"],
  ["6to12", "歩道のある道路", "6〜12m"], ["gte12", "大きな通り", "12m以上"], ["none", "道路に面していない", ""],
];
const WIDTH_SHORT: Record<EdgeChoice, string> = { none: "道路なし", lt4: "4m未満", "4to6": "4〜6m", "6to12": "6〜12m", gte12: "12m以上" };
function renderEdgeList() {
  const chips = $("#edge-chips"), q = $("#edge-q");
  const n = state.points.length;
  if (n < 3) { chips.innerHTML = ""; q.innerHTML = "<p class='muted'>先に敷地の形を描いてください。</p>"; return; }
  if (state.edges.length !== n) state.edges = Array.from({ length: n }, (_, i) => state.edges[i] ?? "none");
  if (selEdge >= n) selEdge = 0;
  chips.innerHTML = "";
  state.edges.forEach((w, i) => {
    const b = document.createElement("button"); b.type = "button";
    b.className = "edge-chip" + (i === selEdge ? " sel" : "") + (w !== "none" ? " road" : "");
    b.innerHTML = `<b>辺${i + 1}</b><span>${edgeLen(i).toFixed(1)}m</span><span class="w">${WIDTH_SHORT[w]}</span>`;
    b.addEventListener("click", () => { selEdge = i; redrawMap(); renderEdgeList(); });
    chips.appendChild(b);
  });
  const cur = state.edges[selEdge];
  q.innerHTML = `<p class="edge-q-title"><b>辺${selEdge + 1}</b>（約${edgeLen(selEdge).toFixed(1)}m）の前の道路は、どれくらいの幅ですか</p>`;
  const grid = document.createElement("div"); grid.className = "width-opts";
  for (const [v, label, sub] of WIDTH_OPTS) {
    const b = document.createElement("button"); b.type = "button";
    b.className = "width-opt" + (cur === v ? " sel" : "") + (v === "none" ? " none" : "");
    b.setAttribute("aria-pressed", String(cur === v));
    b.innerHTML = `<span>${label}</span>${sub ? `<small>${sub}</small>` : ""}`;
    b.addEventListener("click", () => setWidth(v));
    grid.appendChild(b);
  }
  q.appendChild(grid);
  const unk = document.createElement("button"); unk.type = "button"; unk.className = "linklike unknown";
  unk.textContent = "わからない（4〜6mとして計算する）"; unk.addEventListener("click", () => setWidth("4to6"));
  q.appendChild(unk);
  $("#edge-need").hidden = state.edges.some(e => e !== "none");
}
function setWidth(v: EdgeChoice) {
  state.edges[selEdge] = v; save(); redrawMap(); renderEdgeList(); paintStepper();
  track("edge_width", { w: v });
}

// Step4：用途地域（公的データから半自動取得 → だめなら街の様子から推定 → 詳細は手入力）
const ZONE_BY_NAME = new Map(ZONE_ORDER.filter(k => k !== "unknown").map(k => [ZONES[k].label, k] as const));

function centroid(): Vec2 {
  const p = state.points; return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
}

async function fetchZoning() {
  const c = centroid();
  const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  if (state.zoneFetchedFor === key && state.zoneApi) return;
  state.zoneFetchedFor = key; state.zoneApi = null;
  try {
    const r = await fetch(`/api/zoning?lat=${c[1]}&lng=${c[0]}`);
    state.zoneApi = r.ok ? await r.json() : { available: false };
  } catch { state.zoneApi = { available: false }; }
  const z = state.zoneApi!;
  track("zone_resolved", { source: !z.available ? "unavailable" : z.found ? "api" : "notfound" });
  if (z.available && z.found && state.zoneSource !== "user") {
    state.zone = (z.zoneName && ZONE_BY_NAME.get(z.zoneName)) || "unknown";
    state.bcr = z.bcr != null ? String(z.bcr) : ""; state.far = z.far != null ? String(z.far) : "";
    state.zoneSource = "api";
  }
  save();
}

async function renderZone() {
  const auto = $("#zone-auto"), guess = $("#zone-guess");
  const sel = $("#zone") as HTMLSelectElement;
  if (!sel.options.length) for (const k of ZONE_ORDER) { const o = document.createElement("option"); o.value = k; o.textContent = ZONES[k].label; sel.appendChild(o); }
  const bcr = $("#bcr") as HTMLInputElement, far = $("#far") as HTMLInputElement;
  const syncDetail = () => {
    sel.value = state.zone; bcr.value = state.bcr; far.value = state.far;
    bcr.placeholder = `代表値 ${ZONES[state.zone].bcr}`; far.placeholder = `代表値 ${ZONES[state.zone].far}`;
    $$<HTMLInputElement>("input[name=townfeel]").forEach(r => (r.checked = state.zoneSource === "guess" && r.value === state.zone));
  };
  const toUser = () => { state.zoneSource = "user"; save(); paint(); };
  sel.onchange = () => { state.zone = sel.value as ZoneKey; toUser(); };
  bcr.oninput = () => { state.bcr = bcr.value; state.zoneSource = "user"; save(); };
  far.oninput = () => { state.far = far.value; state.zoneSource = "user"; save(); };
  bcr.onchange = far.onchange = () => paint();
  $$<HTMLInputElement>("input[name=townfeel]").forEach(r => (r.onchange = () => {
    state.zone = r.value as ZoneKey; state.bcr = ""; state.far = ""; state.zoneSource = "guess"; save(); paint();
    track("zone_resolved", { source: "guess", zone: state.zone });
  }));

  function paint() {
    paintStepper();
    const z = state.zoneApi;
    auto.classList.remove("muted-card", "control-card");
    if (state.zoneSource === "user") {
      auto.innerHTML = `<b class="big">${esc(ZONES[state.zone].label)}</b>建ぺい率 ${state.bcr || ZONES[state.zone].bcr}％・容積率 ${state.far || ZONES[state.zone].far}％<small>あなたが指定した値で計算します。</small>`;
      guess.hidden = true;
    } else if (z?.available && z.found && state.zoneSource === "api") {
      auto.innerHTML = `<b class="big">${esc(z.zoneName ?? "")}</b>建ぺい率 ${z.bcr ?? "—"}％・容積率 ${z.far ?? "—"}％（${esc(z.city ?? "")}）<small>${CREDIT}</small><small>境界付近や最新の変更は自治体でご確認ください。角地緩和・防火地域による緩和は考慮していません。</small>`;
      guess.hidden = true;
    } else {
      auto.classList.add("muted-card");
      auto.innerHTML = z === null ? "調べています…"
        : z.available && !z.found ? `この地点では用途地域が見つかりませんでした。<small>${esc(z.note ?? "")}。市街化調整区域では原則として建築が制限されます。</small>`
        : "この地点の用途地域を自動で調べられませんでした。";
      guess.hidden = z === null;
    }
    if (areaClass(siteInfo) === "control") {
      auto.classList.remove("muted-card"); auto.classList.add("control-card");
      auto.insertAdjacentHTML("afterbegin", `<p class="control-note">${CONTROL_WARNING}</p>`);
    }
    syncDetail();
  }
  paint();
  if (state.points.length >= 3) {
    loadSiteInfo().then(() => { if (state.step === 4) paint(); });
    await fetchZoning(); if (state.step === 4) paint();
  }
}

// 地点の参考情報（区域区分・防火・ハザード・地価・駅）。座標だけで照会する
let siteInfo: SiteInfo | null = null;
let siteInfoKey = "";
async function loadSiteInfo(): Promise<SiteInfo> {
  const c = centroid();
  const key = `${c[0].toFixed(4)},${c[1].toFixed(4)}`;
  if (key !== siteInfoKey) { siteInfoKey = key; siteInfo = null; }
  const si = await fetchSiteInfo(c[0], c[1]);
  if (key === siteInfoKey && siteInfo !== si) {
    siteInfo = si;
    track("site_info", { area: areaClass(si) });
  }
  return si;
}

function paintSiteInfo() {
  if (!result) return;
  const ctrl = areaClass(siteInfo) === "control";
  const box = $("#site-info-box");
  const open = !!box.querySelector("details")?.open;
  const html = siteInfoHtml(siteInfo, result.site.area).replace(/^<b>この土地の参考情報<\/b>/, "");
  const n = (html.match(/class="attn"/g) || []).length;
  // 市街化調整区域のときは、上部に「！注意事項がN件」の1行だけ出し、押すと本文を開く
  const warn = $("#area-warn");
  warn.hidden = !ctrl;
  const wasOpen = !!warn.querySelector("details")?.open;
  warn.innerHTML = ctrl ? `<details${wasOpen ? " open" : ""}><summary><span class="warn-mark" aria-hidden="true">！</span><span>注意事項が${Math.max(n, 1)}件あります</span><small>市街化調整区域ほか</small></summary><p>${CONTROL_WARNING}</p><p class="muted">ほかの注意事項は「この土地の参考情報」に載せています。</p></details>` : "";
  box.innerHTML = `<details${open ? " open" : ""}><summary><span>この土地の参考情報</span>${n ? `<span class="badge">確認したい点 ${n}</span>` : ""}</summary>${html}</details>`;
}

// Step5
$$<HTMLInputElement>("input[name=focus]").forEach(r => r.addEventListener("change", () => { state.focus = r.value as State["focus"]; state.purposeSet = true; save(); paintStepper(); }));
function syncRadios() {
  $$<HTMLInputElement>("input[name=focus]").forEach(r => (r.checked = r.value === state.focus));
}

// Step6：計算と表示
function compute(): boolean {
  if (state.points.length < 3) { alertBox("敷地の形を3点以上で描いてください。"); go(2); return false; }
  const n = state.points.length;
  const roadEdges = state.edges.map((w, index) => ({ index, width: w })).filter((e): e is { index: number; width: RoadWidthClass } => e.index < n && e.width !== "none");
  try {
    result = computePlans({
      polygon: localPolygon(), roadEdges, zone: state.zone,
      bcr: state.bcr ? Number(state.bcr) : undefined, far: state.far ? Number(state.far) : undefined,
      focusUse: state.focus || null,
      zoneSource: state.zoneSource === "none" ? undefined : state.zoneSource,
      rotationOffsetDeg: state.rotOffset ?? 0,
      shape: state.shape ?? "auto",
    });
  } catch (err) { alertBox((err as Error).message); return false; }
  activePlan = 0;
  track("run", { focus: state.focus || "compare", situation: state.situation ?? "none", zone: state.zone, source: state.zoneSource, areaBucket: areaBucket(result.site.area), roads: roadEdges.length });
  return true;
}

function alertBox(msg: string) {
  const d = document.createElement("div"); d.className = "toast"; d.textContent = msg;
  document.body.appendChild(d); setTimeout(() => d.remove(), 4000);
}

const yen = (man: number) => man >= 10000 ? `${(man / 10000).toFixed(man >= 100000 ? 0 : 1)}億` : `${man.toLocaleString("ja-JP")}万`;
const CERT: Record<string, string> = { confirmed: "確認済み", public: "公的データ（参考）", reference: "参考（代表値）", guess: "推定", unknown: "不明", user: "入力値" };

function renderResult() {
  if (!result) return;
  paintShape();
  if (!viewer) {
    viewer = new Viewer($("#viewer")); viewer.setStyle(state.style ?? "white");
    const needle = $("#gz-needle");
    viewer.onBearing = (rad) => { needle.style.transform = `translate(-50%, -50%) rotate(${((rad * 180) / Math.PI).toFixed(1)}deg)`; };
  }
  paintStyle();
  viewer.setSite(result);
  placeRoadButton();
  renderContext(result);
  const tabs = $("#plan-tabs"); tabs.innerHTML = "";
  result.plans.forEach((p, i) => {
    const m = p.metrics;
    const b = document.createElement("button"); b.type = "button"; b.role = "tab"; b.className = "plan-card" + (i === activePlan ? " active" : "");
    b.setAttribute("aria-selected", String(i === activePlan));
    const label = p.title.replace(/^[ABC]案：/, "");
    const nums = m.gfa > 0
      ? `<span><small>延床</small>約${m.gfa}㎡</span><span><small>階数</small>${m.floors}階</span><span><small>概算</small>${yen(m.costMin)}〜</span>`
      : `<span><small>駐車</small>${m.parking}台</span><span><small>概算</small>${yen(m.costMin)}〜</span>`;
    b.innerHTML = `<b>${p.id} ${esc(label)}</b><span class="nums">${nums}</span><span class="pos">${i + 1} / ${result!.plans.length}</span>`;
    b.addEventListener("click", () => { if (activePlan === i) return; activePlan = i; renderResult(); track("plan_tab", { plan: p.id, size: p.size, use: p.use }); });
    tabs.appendChild(b);
  });
  requestAnimationFrame(() => (tabs.children[activePlan] as HTMLElement | undefined)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }));
  // スマホの操作パネル用：案の切り替え（小さめ・中間・上限）
  const mini = $("#plan-mini"); mini.innerHTML = "";
  result.plans.forEach((p, i) => {
    const b = document.createElement("button"); b.type = "button"; b.role = "radio";
    b.setAttribute("aria-checked", String(i === activePlan));
    b.textContent = `${p.id} ${p.title.replace(/^[ABC]案：/, "")}`;
    b.addEventListener("click", () => { if (activePlan === i) return; activePlan = i; renderResult(); track("plan_tab", { plan: p.id, size: p.size, use: p.use }); });
    mini.appendChild(b);
  });
  requestAnimationFrame(fitMobileStage);
  const p = result.plans[activePlan];
  viewer.setPlan(p, result.site.rotation);
  paintOrient();
  $("#plan-detail").innerHTML = planHtml(p);
  renderAd(p.use);
  if (state.sample) { $("#site-info-box").hidden = true; $("#area-warn").hidden = true; }
  else { $("#site-info-box").hidden = false; const pr = loadSiteInfo(); paintSiteInfo(); pr.then(() => paintSiteInfo()); }
  const s = result.site;
  $("#site-summary").innerHTML = `
    <details class="card"><summary>敷地と前提条件</summary>
      <table class="kv">
        <tr><th>敷地面積</th><td>約${s.area}㎡（約${(s.area / 3.30579).toFixed(1)}坪）<small>${CERT[result.certainty.shape]}</small></td></tr>
        <tr><th>用途地域</th><td>${esc(s.zone.label)}<small>${CERT[result.certainty.zone]}</small></td></tr>
        <tr><th>建ぺい率／容積率</th><td>${s.bcr}％／${s.far}％<small>${CERT[result.certainty.bcrFar]}</small></td></tr>
        <tr><th>前面道路</th><td>${s.roadWidth == null ? "なし" : s.roadWidth >= 12 ? "12m以上" : `約${s.roadWidth}m として計算`}<small>${CERT[result.certainty.road]}</small></td></tr>
        <tr><th>計算上の容積率</th><td>${s.farEffective}％${s.farEffective < s.far ? "（道路幅員による制限）" : ""}</td></tr>
        <tr><th>階数の上限（目安）</th><td>${s.floorsCap}階</td></tr>
      </table>
      ${result.warnings.length ? `<ul class="warn">${result.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${state.sample ? `<p class="muted">※サンプルの架空の敷地です。</p>` : ""}
      ${result.certainty.zone === "public" ? `<p class="muted credit">${CREDIT}</p>` : ""}
    </details>`;
}

function planHtml(p: Plan) {
  const m = p.metrics;
  const rows: [string, string][] = [];
  if (m.gfa > 0) {
    rows.push(["延床面積", `約${m.gfa}㎡（約${(m.gfa / 3.30579).toFixed(1)}坪）`]);
    rows.push(["建築面積", `約${m.footprint}㎡`]);
    rows.push(["階数・高さ", `${m.floors}階・約${m.height}m`]);
    rows.push(["建ぺい率／容積率の使用", `${m.bcrUsed}％／${m.farUsed}％`]);
  }
  if (m.units != null) rows.push(["賃貸住戸", `${m.units}戸（1K・約25㎡想定）`]);
  rows.push(["駐車", `${m.parking}台`]);
  rows.push(["概算工事費", `約${yen(m.costMin)}〜${yen(m.costMax)}円`]);
  return `<div class="card plan">
    <h3>${esc(p.title)}</h3><p class="sub">${esc(p.subtitle)}</p>
    <table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
    ${p.notes.length ? `<ul class="notes">${p.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

const CREDIT = `出典：国土交通省 不動産情報ライブラリ（<a href="https://www.reinfolib.mlit.go.jp/" target="_blank" rel="noopener">https://www.reinfolib.mlit.go.jp/</a>）。「都市計画決定GISデータ（用途地域）」（国土交通省）をもとに土地の未来図が規模を試算。提供情報の最新性、正確性、完全性等が保証されたものではありません。地域の範囲は概ねの位置を示すもので、実際の都市計画の決定範囲と異なる場合があります。`;
// 建物の向き：自動で決めた向きから15°ずつ回せる
function paintOrient() {
  if (!result) return;
  const off = state.rotOffset ?? 0;
  const auto = Math.round((result.site.autoRotation * 180) / Math.PI);
  $("#rot-val").textContent = off ? `向き 自動${off > 0 ? "+" : ""}${off}°` : auto ? `向き自動（敷地に合わせ${auto > 0 ? "+" : ""}${auto}°）` : "向き自動（道路に合わせる）";
  $("#rot-reset").classList.toggle("off", !off); // 非表示でも場所は確保して、ボタンの位置を動かさない
}
function rotateBy(delta: number) {
  let off = (state.rotOffset ?? 0) + delta;
  if (off > 90) off -= 180;
  if (off <= -90) off += 180;
  state.rotOffset = off; save();
  const keep = activePlan;
  if (compute()) { activePlan = keep; renderResult(); }
  track("rotate", { deg: off });
}
$("#rot-l").addEventListener("click", () => rotateBy(15));
$("#rot-r").addEventListener("click", () => rotateBy(-15));
$("#rot-reset").addEventListener("click", () => rotateBy(-(state.rotOffset ?? 0)));

// 周辺建物（PLATEAU）：対応都市なら3Dに重ねて表示
interface PlateauInfo { available: boolean; tilesetUrl?: string; credit?: string; reason?: string }
const plateauCache = new Map<string, PlateauInfo>();
interface FootprintInfo { buildings: { h: number; ring: [number, number][] }[]; credit?: string }
const footprintCache = new Map<string, FootprintInfo>();
let contextToken = 0;
async function renderContext(res: EngineResult) {
  const box = $("#context-box");
  if (state.sample) { box.hidden = true; viewer?.setContext(null); return; }
  box.hidden = false;
  const show = state.showContext !== false;
  const origin = lngLatToLocal(state.points).origin;
  const key = `${origin[0].toFixed(4)},${origin[1].toFixed(4)}`;
  const token = ++contextToken;
  const paint = (status: string, credit = "") => {
    box.innerHTML = `<label><input type="checkbox" id="ctx-toggle" ${show ? "checked" : ""}> 周りの建物を表示</label>
      <p class="status">${status}</p>${credit ? `<p class="muted credit">${esc(credit)}。測量時点のデータのため、現在の建物と異なる場合があります。</p>` : ""}`;
    ($("#ctx-toggle") as HTMLInputElement).onchange = (e) => {
      state.showContext = (e.target as HTMLInputElement).checked; save();
      if (result) renderContext(result);
    };
  };
  if (!show) { viewer?.setContext(null); paint("表示していません。"); return; }
  paint("この地域のデータを確認しています…");
  let info = plateauCache.get(key);
  if (!info) {
    try { info = await (await fetch(`/api/plateau?lat=${origin[1]}&lng=${origin[0]}`)).json() as PlateauInfo; }
    catch { info = { available: false, reason: "error" }; }
    plateauCache.set(key, info);
    track("context", { source: info.available ? "plateau" : info.reason ?? "unavailable" });
  }
  if (token !== contextToken) return;
  if (!info.available || !info.tilesetUrl) {
    await showFootprints(res, origin, key, token, paint);
    return;
  }
  const credit = info.credit ?? "";
  paint("周りの建物を読み込んでいます…", credit);
  viewer?.setContext({ tilesetUrl: info.tilesetUrl, origin, frame: res.site.frame, sitePolygonUV: res.site.polygonUV }, (st) => {
    if (token !== contextToken) return;
    const p = box.querySelector(".status");
    const d = viewer?.contextDebug();
    const dbg = d ? `（タイル${d.models}・地面${d.ground ?? "推定中"}${d.errors ? `・エラー${d.errors}：${d.lastError ?? ""}` : ""}）` : "";
    if (p) p.textContent = (st === "loading" ? "周りの建物を読み込んでいます…" : st === "ready" ? "周りの既存の建物をグレーで表示しています（敷地内の建物は非表示）。" : "一部の建物を読み込めませんでした。") + dbg;
  });
  // 15秒たっても近くの建物が届かなければ、国土地理院のデータに切り替える
  setTimeout(() => {
    if (token !== contextToken) return;
    const d = viewer?.contextDebug();
    if (d && d.ground === null) showFootprints(res, origin, key, token, paint);
  }, 15000);
}

async function showFootprints(res: EngineResult, origin: [number, number], key: string, token: number, paint: (status: string, credit?: string) => void) {
  {
    // PLATEAUがない地域：国土地理院の建物外形（全国）を、種類から推定した高さで表示
    viewer?.setContext(null);
    paint("周りの建物を読み込んでいます…（国土地理院の地図データ）");
    let fp = footprintCache.get(key);
    if (!fp) {
      try { fp = await (await fetch(`/api/buildings?lat=${origin[1]}&lng=${origin[0]}&r=150`)).json() as FootprintInfo; }
      catch { fp = { buildings: [] }; }
      footprintCache.set(key, fp);
      track("context", { source: fp.buildings.length ? "gsi" : "none" });
    }
    if (token !== contextToken) return;
    if (!fp.buildings.length) { paint("この地域の周りの建物のデータを取得できませんでした。"); return; }
    viewer?.setFootprints(fp.buildings, origin, res.site.frame, res.site.polygonUV);
    paint(`周りの建物${fp.buildings.length}棟をグレーで表示しています。高さは建物の種類からの推定です（3D都市モデルの対象外の地域）。`, fp.credit ?? "国土地理院最適化ベクトルタイル");
  }
}

// 広告枠：ASP承認後に worker/affiliates.ts に URL を入れると表示される
interface AdSlotPub { slot: string; use: UseKey; advertiser: string; text: string }
let adSlots: AdSlotPub[] | null = null;
const adShown = new Set<string>();
// 一度クリックした広告枠は、同じ端末では目立たせない（端末内だけの記録）
const AD_CLICK_KEY = "tochi-mirai:adclick";
function adClicked(): string[] { try { return JSON.parse(localStorage.getItem(AD_CLICK_KEY) || "[]"); } catch { return []; } }

async function renderAd(use: UseKey) {
  const box = $("#ad-box");
  if (adSlots === null) {
    try { adSlots = (await (await fetch("/api/ads")).json()).slots ?? []; } catch { adSlots = []; }
  }
  const ad = adSlots!.find(a => a.use === use);
  $("#pr-top").hidden = !ad; // 広告があるときだけ、ページ上部にも【PR】を出す（タウンライフの指定：ファーストビュー＋任意の場所）
  if (!ad) { box.innerHTML = ""; return; }
  const clicked = adClicked().includes(ad.slot);
  box.innerHTML = `<div class="next-step${clicked ? " quiet" : ""}"><h3>次のステップ【PR】</h3>
    <a class="ad" href="/go/${encodeURIComponent(ad.slot)}?sid=${SID}&amp;src=result" target="_blank" rel="sponsored noopener">
    <b>${esc(ad.text)}</b>${ad.advertiser ? `<small>${esc(ad.advertiser)}（外部サイト）へ移動します。複数社を選ぶと、プランを並べて比べやすくなります。3D・規模・参考情報は、申込みの有無にかかわらず無料で見られます。</small>` : ""}</a></div>`;
  box.querySelector("a.ad")!.addEventListener("click", () => {
    const list = adClicked(); if (!list.includes(ad.slot)) { list.push(ad.slot); try { localStorage.setItem(AD_CLICK_KEY, JSON.stringify(list)); } catch { /* 保存できなくても続ける */ } }
  });
  if (!adShown.has(ad.slot)) { adShown.add(ad.slot); track("ad_impression", { use }); }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// 開発用：制御データの書き出し（URLに ?dev=1 を付けたときだけ表示）
const DEV = new URLSearchParams(location.search).has("dev");
$("#export-box").hidden = !DEV;
$("#export-btn").addEventListener("click", async () => {
  if (!result || !viewer) return;
  const btn = $("#export-btn") as HTMLButtonElement, st = $("#export-status");
  btn.disabled = true; st.textContent = "書き出しています…（数十秒かかります）";
  const keep = activePlan;
  try {
    const plans = result.plans;
    const blob = await exportControlPackage(viewer, result, plans, (i) => viewer!.setPlan(plans[i], result!.site.rotation), {
      context: viewer.contextDebug() ? "plateau" : "footprints-or-none",
      focus: state.focus || "compare", stage: state.situation ?? "", sample: !!state.sample,
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tochi-mirai-control-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    st.textContent = `書き出しました（${(blob.size / 1024 / 1024).toFixed(1)}MB）`;
  } catch (e) {
    st.textContent = "書き出しに失敗しました：" + String(e).slice(0, 80);
  } finally {
    activePlan = keep; renderResult(); btn.disabled = false;
  }
});

// 初期表示
track("wizard_view", { mobile: matchMedia("(max-width: 760px)").matches });
syncRadios();
const params = new URLSearchParams(location.search);
if (restored) { save(); track("restored"); go(6); }
else if (params.has("sample")) $("#sample-btn").click();
else if (!state.situation) go(0);
else if (state.step === 0 && params.has("s")) go(1);
else go(state.step === 6 && state.points.length >= 3 ? 6 : Math.min(state.step, state.points.length >= 3 ? 5 : 2));
paintSituation();
