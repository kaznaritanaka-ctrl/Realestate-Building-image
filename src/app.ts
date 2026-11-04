import maplibregl from "maplibre-gl";
import { computePlans, type EngineResult, type RoadWidthClass, type UseKey, type Plan } from "../engine/engine.ts";
import { lngLatToLocal, area, type Vec2 } from "../engine/geom.ts";
import { ZONES, ZONE_ORDER, type ZoneKey } from "../engine/zoning.ts";
import { Viewer } from "./viewer.ts";

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
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll(s)) as T[];
const KEY = "tochi-mirai:v1";

const state: State = load() ?? { step: 1, points: [], edges: [], zone: "unknown", bcr: "", far: "", focus: "", stage: "curious", sample: false };

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

map.on("click", (e) => {
  if (state.step !== 2) return;
  if (map.getZoom() < MIN_DRAW_ZOOM) { zoomWarn(); return; }
  state.points.push([e.lngLat.lng, e.lngLat.lat]);
  state.edges = [];
  save(); redrawMap(); updateArea();
});

function fc(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection { return { type: "FeatureCollection", features }; }

function redrawMap() {
  const pts = state.points;
  const feats: GeoJSON.Feature[] = [];
  if (pts.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
  else if (pts.length === 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
  (map.getSource("draw") as maplibregl.GeoJSONSource | undefined)?.setData(fc(feats));

  vertexMarkers.forEach(m => m.remove());
  vertexMarkers = state.step === 2 ? pts.map((p, i) => {
    const el = document.createElement("div"); el.className = "vtx"; el.title = `頂点${i + 1}`;
    return new maplibregl.Marker({ element: el }).setLngLat(p).addTo(map);
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
  if (step === 6 && !compute()) return;
  state.step = step; save();
  $$("section.wstep").forEach(s => (s.hidden = Number(s.dataset.step) !== step));
  $$("#stepper li").forEach(li => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === step); li.classList.toggle("done", n < step);
  });
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

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-next]") as HTMLElement | null;
  if (t) { e.preventDefault(); go(Number(t.dataset.next)); }
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
      b.addEventListener("click", () => { map.jumpTo({ center: d.geometry.coordinates, zoom: 18.5 }); ul.innerHTML = ""; });
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
  state.zone = "r1mid"; state.bcr = ""; state.far = ""; state.sample = true;
  save(); go(6);
});

$("#undo-btn").addEventListener("click", () => { state.points.pop(); state.edges = []; save(); redrawMap(); updateArea(); });
$("#clear-btn").addEventListener("click", () => { state.points = []; state.edges = []; state.sample = false; save(); redrawMap(); updateArea(); });
$("#restart-btn").addEventListener("click", () => { state.points = []; state.edges = []; state.sample = false; save(); go(1); });

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
    sel.addEventListener("change", () => { state.edges[i] = sel.value as EdgeChoice; save(); redrawMap(); renderEdgeList(); });
    const lab = document.createElement("span"); lab.className = "edge-no"; lab.textContent = `辺${i + 1}`;
    const len = document.createElement("span"); len.className = "muted"; len.textContent = `${edgeLen(i).toFixed(1)}m`;
    li.append(lab, len, sel); ul.appendChild(li);
  });
  if (!state.edges.some(e => e !== "none")) {
    const li = document.createElement("li"); li.className = "muted"; li.textContent = "少なくとも1つの辺を道路にしてください（道路に接していない土地には原則建築できません）。";
    ul.appendChild(li);
  }
}

// Step4：用途地域
function renderZone() {
  const sel = $("#zone") as HTMLSelectElement;
  if (!sel.options.length) for (const k of ZONE_ORDER) { const o = document.createElement("option"); o.value = k; o.textContent = ZONES[k].label; sel.appendChild(o); }
  sel.value = state.zone;
  const bcr = $("#bcr") as HTMLInputElement, far = $("#far") as HTMLInputElement;
  bcr.value = state.bcr; far.value = state.far;
  const ph = () => { bcr.placeholder = `代表値 ${ZONES[sel.value as ZoneKey].bcr}`; far.placeholder = `代表値 ${ZONES[sel.value as ZoneKey].far}`; };
  ph();
  sel.onchange = () => { state.zone = sel.value as ZoneKey; ph(); save(); };
  bcr.oninput = () => { state.bcr = bcr.value; save(); };
  far.oninput = () => { state.far = far.value; save(); };
}

// Step5
$$<HTMLInputElement>("input[name=focus]").forEach(r => r.addEventListener("change", () => { state.focus = r.value as State["focus"]; save(); }));
$$<HTMLInputElement>("input[name=stage]").forEach(r => r.addEventListener("change", () => { state.stage = r.value; save(); }));
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
    });
  } catch (err) { alertBox((err as Error).message); return false; }
  activePlan = 0;
  return true;
}

function alertBox(msg: string) {
  const d = document.createElement("div"); d.className = "toast"; d.textContent = msg;
  document.body.appendChild(d); setTimeout(() => d.remove(), 4000);
}

const yen = (man: number) => man >= 10000 ? `${(man / 10000).toFixed(man >= 100000 ? 0 : 1)}億` : `${man.toLocaleString("ja-JP")}万`;
const CERT: Record<string, string> = { confirmed: "確認済み", reference: "参考（代表値）", unknown: "不明", user: "入力値" };

function renderResult() {
  if (!result) return;
  if (!viewer) viewer = new Viewer($("#viewer"));
  viewer.setSite(result);
  const tabs = $("#plan-tabs"); tabs.innerHTML = "";
  result.plans.forEach((p, i) => {
    const b = document.createElement("button"); b.type = "button"; b.role = "tab"; b.className = "tab" + (i === activePlan ? " active" : "");
    b.innerHTML = `<b>${p.id}案</b><span>${esc(p.title.replace(/^[ABC]案：/, ""))}</span>`;
    b.addEventListener("click", () => { activePlan = i; renderResult(); });
    tabs.appendChild(b);
  });
  const p = result.plans[activePlan];
  viewer.setPlan(p);
  $("#plan-detail").innerHTML = planHtml(p);
  const s = result.site;
  $("#site-summary").innerHTML = `
    <details class="card"><summary>敷地と前提条件</summary>
      <table class="kv">
        <tr><th>敷地面積</th><td>約${s.area}㎡（約${(s.area / 3.30579).toFixed(1)}坪）<small>${CERT[result.certainty.shape]}</small></td></tr>
        <tr><th>用途地域</th><td>${esc(s.zone.label)}<small>${CERT[result.certainty.zone]}</small></td></tr>
        <tr><th>建蔽率／容積率</th><td>${s.bcr}％／${s.far}％<small>${CERT[result.certainty.bcrFar]}</small></td></tr>
        <tr><th>前面道路</th><td>${s.roadWidth == null ? "なし" : s.roadWidth >= 12 ? "12m以上" : `約${s.roadWidth}m として計算`}<small>${CERT[result.certainty.road]}</small></td></tr>
        <tr><th>計算上の容積率</th><td>${s.farEffective}％${s.farEffective < s.far ? "（道路幅員による制限）" : ""}</td></tr>
        <tr><th>階数の上限（目安）</th><td>${s.floorsCap}階</td></tr>
      </table>
      ${result.warnings.length ? `<ul class="warn">${result.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${state.sample ? `<p class="muted">※サンプルの架空の敷地です。</p>` : ""}
    </details>`;
}

function planHtml(p: Plan) {
  const m = p.metrics;
  const rows: [string, string][] = [];
  if (m.gfa > 0) {
    rows.push(["延床面積", `約${m.gfa}㎡（約${(m.gfa / 3.30579).toFixed(1)}坪）`]);
    rows.push(["建築面積", `約${m.footprint}㎡`]);
    rows.push(["階数・高さ", `${m.floors}階・約${m.height}m`]);
    rows.push(["建蔽率／容積率の使用", `${m.bcrUsed}％／${m.farUsed}％`]);
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

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// 初期表示
syncRadios();
const params = new URLSearchParams(location.search);
if (params.has("sample")) $("#sample-btn").click();
else go(state.step === 6 && state.points.length >= 3 ? 6 : Math.min(state.step, state.points.length >= 3 ? 5 : 2) || 1);
