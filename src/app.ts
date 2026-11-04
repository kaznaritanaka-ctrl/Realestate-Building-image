import maplibregl from "maplibre-gl";
import { computePlans, type EngineResult, type RoadWidthClass, type UseKey, type Plan } from "../engine/engine.ts";
import { lngLatToLocal, area, type Vec2 } from "../engine/geom.ts";
import { ZONES, ZONE_ORDER, type ZoneKey } from "../engine/zoning.ts";
import { Viewer } from "./viewer.ts";
import { track, areaBucket, SID } from "./track.ts";

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
}
interface ZoneApi { available: boolean; found?: boolean; zoneName?: string | null; bcr?: number | null; far?: number | null; city?: string; source?: string; note?: string }

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll(s)) as T[];
const KEY = "tochi-mirai:v1";

const state: State = load() ?? { step: 1, points: [], edges: [], zone: "unknown", bcr: "", far: "", focus: "house", stage: "curious", sample: false, zoneSource: "none", zoneFetchedFor: "", zoneApi: null };
state.zoneSource ??= "none"; state.zoneFetchedFor ??= ""; state.zoneApi ??= null;

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
  hash: true,
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

map.on("click", (e) => {
  if (state.step !== 2) return;
  if (map.getZoom() < MIN_DRAW_ZOOM) { zoomWarn(); return; }
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
      edgeFeats.push({ type: "Feature", properties: { color: EDGE_COLORS[choice], road: choice !== "none" }, geometry: { type: "LineString", coordinates: [p, q] } });
      const el = document.createElement("div"); el.className = "edge-label" + (choice !== "none" ? " road" : ""); el.textContent = String(i + 1);
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
  if (from === 2 && step === 3 && state.points.length >= 3) track("shape_done", { areaBucket: areaBucket(area(localPolygon())), edges: state.points.length });
  if (from === 3 && step === 4) track("road_set", { roads: state.edges.filter(e => e !== "none").length });
  state.step = step; save();
  $$("section.wstep").forEach(s => (s.hidden = Number(s.dataset.step) !== step));
  paintStepper();
  const show3d = step === 6;
  $("#viewer").hidden = !show3d;
  $("#map").style.visibility = show3d ? "hidden" : "visible";
  $("#map-tools").hidden = show3d;
  if (step === 2) { updateArea(); zoomWarn(); }
  if (step === 3) renderEdgeList();
  if (step === 4) renderZone();
  if (show3d) renderResult(); else map.resize();
  redrawMap();
  if (step === 3 && state.points.length >= 3) {
    const b = new maplibregl.LngLatBounds(); state.points.forEach(p => b.extend(p));
    map.fitBounds(b, { padding: 80, maxZoom: 20, duration: 400 });
  }
  $("#panel").scrollTop = 0;
  if (window.matchMedia("(max-width: 760px)").matches) window.scrollTo({ top: 0 });
}

/** 各ステップが入力済みか */
function isDone(n: number): boolean {
  switch (n) {
    case 1: return !!state.located || state.points.length > 0;
    case 2: return state.points.length >= 3;
    case 3: return state.edges.some(e => e !== "none");
    case 4: return state.zoneSource !== "none";
    case 5: return !!state.purposeSet;
    case 6: return !!result;
    default: return false;
  }
}
function paintStepper() {
  $$<HTMLButtonElement>("#stepper button").forEach(b => {
    const n = Number(b.dataset.step);
    const active = n === state.step, done = isDone(n);
    b.classList.toggle("active", active);
    b.classList.toggle("done", !active && done);
    b.classList.toggle("todo", !active && !done);
    b.title = done ? "入力済み" : "未入力";
    if (active) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
  });
}

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-next]") as HTMLElement | null;
  if (t) { e.preventDefault(); if (t.id === "run-btn") { state.purposeSet = true; } go(Number(t.dataset.next)); return; }
  const s = (e.target as HTMLElement).closest("#stepper button") as HTMLElement | null;
  if (s) { e.preventDefault(); go(Number(s.dataset.step)); }
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
  save(); track("sample_used"); go(6);
});

$("#undo-btn").addEventListener("click", () => { state.points.pop(); state.edges = []; save(); redrawMap(); updateArea(); paintStepper(); });
$("#clear-btn").addEventListener("click", () => { state.points = []; state.edges = []; state.sample = false; save(); redrawMap(); updateArea(); paintStepper(); });
$("#restart-btn").addEventListener("click", () => {
  Object.assign(state, { points: [], edges: [], sample: false, located: false, purposeSet: false, zoneSource: "none", zoneFetchedFor: "", zoneApi: null });
  result = null; save(); track("restart"); go(1);
});

let photo = true;
$("#layer-btn").addEventListener("click", () => {
  photo = !photo;
  map.setLayoutProperty("photo", "visibility", photo ? "visible" : "none");
  map.setLayoutProperty("std", "visibility", photo ? "none" : "visible");
  $("#layer-btn").textContent = photo ? "地図に切替" : "航空写真に切替";
});

// Step3：道路辺
function renderEdgeList() {
  const ul = $("#edge-list"); ul.innerHTML = "";
  const n = state.points.length;
  if (n < 3) { ul.innerHTML = "<li class='muted'>先に敷地の形を描いてください。</li>"; return; }
  if (state.edges.length !== n) state.edges = Array.from({ length: n }, (_, i) => state.edges[i] ?? "none");
  const opts: [EdgeChoice, string][] = [["none", "道路に接していない"], ["lt4", "道路（幅4m未満）"], ["4to6", "道路（幅4〜6m）"], ["6to12", "道路（幅6〜12m）"], ["gte12", "道路（幅12m以上）"]];
  state.edges.forEach((choice, i) => {
    const li = document.createElement("li");
    const sel = document.createElement("select");
    for (const [v, label] of opts) { const o = document.createElement("option"); o.value = v; o.textContent = label; o.selected = v === choice; sel.appendChild(o); }
    sel.addEventListener("change", () => { state.edges[i] = sel.value as EdgeChoice; save(); redrawMap(); renderEdgeList(); paintStepper(); });
    const lab = document.createElement("span"); lab.className = "edge-no"; lab.textContent = `辺${i + 1}`;
    const len = document.createElement("span"); len.className = "muted"; len.textContent = `${edgeLen(i).toFixed(1)}m`;
    li.append(lab, len, sel); ul.appendChild(li);
  });
  if (!state.edges.some(e => e !== "none")) {
    const li = document.createElement("li"); li.className = "muted"; li.textContent = "少なくとも1つの辺を道路にしてください（道路に接していない土地には原則建築できません）。";
    ul.appendChild(li);
  }
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
    auto.classList.remove("muted-card");
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
    syncDetail();
  }
  paint();
  if (state.points.length >= 3) { await fetchZoning(); if (state.step === 4) paint(); }
}

// Step5
$$<HTMLInputElement>("input[name=focus]").forEach(r => r.addEventListener("change", () => { state.focus = r.value as State["focus"]; state.purposeSet = true; save(); paintStepper(); }));
$$<HTMLInputElement>("input[name=stage]").forEach(r => r.addEventListener("change", () => { state.stage = r.value; state.purposeSet = true; save(); paintStepper(); }));
function syncRadios() {
  $$<HTMLInputElement>("input[name=focus]").forEach(r => (r.checked = r.value === state.focus));
  $$<HTMLInputElement>("input[name=stage]").forEach(r => (r.checked = r.value === state.stage));
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
    });
  } catch (err) { alertBox((err as Error).message); return false; }
  activePlan = 0;
  track("run", { focus: state.focus || "compare", stage: state.stage, zone: state.zone, source: state.zoneSource, areaBucket: areaBucket(result.site.area), roads: roadEdges.length });
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
  if (!viewer) viewer = new Viewer($("#viewer"));
  viewer.setSite(result);
  renderContext(result);
  const tabs = $("#plan-tabs"); tabs.innerHTML = "";
  result.plans.forEach((p, i) => {
    const b = document.createElement("button"); b.type = "button"; b.role = "tab"; b.className = "tab" + (i === activePlan ? " active" : "");
    const label = p.size ? p.title.replace(/^[ABC]案：/, "") : p.title.replace(/^[ABC]案：/, "");
    b.innerHTML = `<b>${p.id}案</b><span>${esc(label)}</span>`;
    b.addEventListener("click", () => { activePlan = i; renderResult(); track("plan_tab", { plan: p.id, size: p.size, use: p.use }); });
    tabs.appendChild(b);
  });
  const p = result.plans[activePlan];
  viewer.setPlan(p);
  $("#plan-detail").innerHTML = planHtml(p);
  renderAd(p.use);
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
// 周辺建物（PLATEAU）：対応都市なら3Dに重ねて表示
interface PlateauInfo { available: boolean; tilesetUrl?: string; credit?: string; reason?: string }
const plateauCache = new Map<string, PlateauInfo>();
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
    box.innerHTML = `<label><input type="checkbox" id="ctx-toggle" ${show ? "checked" : ""}> 周りの建物を表示（3D都市モデル）</label>
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
    viewer?.setContext(null);
    paint(info.reason === "not_covered" ? "この地域は、3D都市モデル（PLATEAU）がまだ整備されていません。" : "周りの建物のデータを取得できませんでした。");
    return;
  }
  const credit = info.credit ?? "";
  paint("周りの建物を読み込んでいます…", credit);
  viewer?.setContext({ tilesetUrl: info.tilesetUrl, origin, frame: res.site.frame, sitePolygonUV: res.site.polygonUV }, (st) => {
    if (token !== contextToken) return;
    const p = box.querySelector(".status");
    if (p) p.textContent = st === "loading" ? "周りの建物を読み込んでいます…" : st === "ready" ? "周りの既存の建物をグレーで表示しています（敷地内の建物は非表示）。" : "一部の建物を読み込めませんでした。";
  });
}

// 広告枠：ASP承認後に worker/affiliates.ts に URL を入れると表示される
interface AdSlotPub { slot: string; use: UseKey; advertiser: string; text: string }
let adSlots: AdSlotPub[] | null = null;
const adShown = new Set<string>();
async function renderAd(use: UseKey) {
  const box = $("#ad-box");
  if (adSlots === null) {
    try { adSlots = (await (await fetch("/api/ads")).json()).slots ?? []; } catch { adSlots = []; }
  }
  const ad = adSlots!.find(a => a.use === use);
  if (!ad) { box.innerHTML = ""; return; }
  box.innerHTML = `<a class="ad" href="/go/${encodeURIComponent(ad.slot)}?sid=${SID}" target="_blank" rel="sponsored noopener">
    <span class="pr">PR</span><b>${esc(ad.text)}</b>${ad.advertiser ? `<small>${esc(ad.advertiser)}（外部サイト）へ移動します。画像・3Dの表示は申込みの有無にかかわらず無料です。</small>` : ""}</a>`;
  if (!adShown.has(ad.slot)) { adShown.add(ad.slot); track("ad_impression", { use }); }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// 初期表示
track("wizard_view", { mobile: matchMedia("(max-width: 760px)").matches });
syncRadios();
const params = new URLSearchParams(location.search);
if (params.has("sample")) $("#sample-btn").click();
else go(state.step === 6 && state.points.length >= 3 ? 6 : Math.min(state.step, state.points.length >= 3 ? 5 : 2) || 1);
