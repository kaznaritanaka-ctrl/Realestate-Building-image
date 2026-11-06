// Worker：静的アセット配信＋API（/api/*）
// /api/zoning?lat=&lng= … 不動産情報ライブラリ（国土交通省）XKT002 で、その地点の用途地域・建ぺい率・容積率を返す
import { AD_SLOTS } from "./affiliates.ts";
import { gsiBuildings } from "./gsi-buildings.ts";
import { siteInfo } from "./site-info.ts";

interface D1 {
  prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
}
interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  REINFOLIB_KEY?: string;
  DB?: D1;
}

// 記録してよいイベント名とプロパティ（個人を特定する情報・位置は受け付けない）
const EVENT_NAMES = new Set([
  "lp_view", "wizard_view", "step_enter", "located", "shape_done", "road_set", "zone_resolved",
  "run", "plan_tab", "sample_used", "ad_impression", "restart", "context", "rotate", "site_info", "style", "situation", "edge_width", "step_jump", "save_result", "restored",
]);
const PROP_KEYS = new Set(["area", "deg", "step", "via", "areaBucket", "edges", "roads", "source", "zone", "focus", "stage", "plan", "size", "use", "ref", "mobile", "style", "situation", "w"]);

const Z = 15;

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/zoning") return zoning(url, env, ctx);
    if (url.pathname === "/api/event" && req.method === "POST") return event(req, env, ctx);
    if (url.pathname === "/api/plateau") return plateau(url, ctx);
    if (url.pathname === "/api/buildings") return buildings(url, ctx);
    if (url.pathname === "/api/site-info") return siteInfoRoute(url, env, ctx);
    if (url.pathname === "/api/ads") return json({ slots: AD_SLOTS.filter(s => s.url).map(({ slot, use, advertiser, text }) => ({ slot, use, advertiser, text })) });
    if (url.pathname.startsWith("/go/")) return go(url, env, ctx);
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(req);
  },
};

async function zoning(url: URL, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 20 || lat > 46 || lng < 122 || lng > 154) {
    return json({ error: "bad_request" }, 400);
  }
  if (!env.REINFOLIB_KEY) return json({ available: false, reason: "not_configured" }, 200);

  const n = 2 ** Z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  const api = `https://www.reinfolib.mlit.go.jp/ex-api/external/XKT002?response_format=geojson&z=${Z}&x=${x}&y=${y}`;

  // タイル単位で1日キャッシュ（APIへの負荷とレート制限対策）
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const cacheKey = new Request(`https://cache.internal/xkt002/${Z}/${x}/${y}`);
  let res = await cache.match(cacheKey);
  console.log(JSON.stringify({ evt: "zoning", tile: `${Z}/${x}/${y}`, cached: !!res }));
  if (!res) {
    const upstream = await fetch(api, { headers: { "Ocp-Apim-Subscription-Key": env.REINFOLIB_KEY } });
    if (!upstream.ok) return json({ available: false, reason: `upstream_${upstream.status}` }, 200);
    const body = await upstream.text();
    res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  let gj: { features?: Feature[] };
  try { gj = await res.json(); } catch { return json({ available: false, reason: "parse_error" }, 200); }

  const hit = (gj.features ?? []).find(f => containsPoint(f.geometry, [lng, lat]));
  if (!hit) {
    return json({ available: true, found: false, note: "用途地域の指定がない区域（市街化調整区域・都市計画区域外など）の可能性があります" });
  }
  const p = hit.properties ?? {};
  return json({
    available: true, found: true,
    zoneName: p.use_area_ja ?? null,
    bcr: pct(p.u_building_coverage_ratio_ja), far: pct(p.u_floor_area_ratio_ja),
    city: [p.prefecture, p.city_name].filter(Boolean).join(""),
    decisionDate: p.decision_date ?? null,
    source: "国土交通省 不動産情報ライブラリ（都市計画決定GISデータ）",
    sourceUrl: "https://www.reinfolib.mlit.go.jp/",
  });
}

type Pos = [number, number];
interface Feature { type: string; properties?: Record<string, string | undefined>; geometry: { type: string; coordinates: unknown } }

function containsPoint(g: Feature["geometry"], pt: Pos): boolean {
  if (!g) return false;
  if (g.type === "Polygon") return inPolygon(g.coordinates as Pos[][], pt);
  if (g.type === "MultiPolygon") return (g.coordinates as Pos[][][]).some(poly => inPolygon(poly, pt));
  return false;
}
function inPolygon(rings: Pos[][], pt: Pos): boolean {
  if (!rings.length || !inRing(rings[0], pt)) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(rings[i], pt)) return false; // 穴
  return true;
}
function inRing(ring: Pos[], [x, y]: Pos): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pct = (s?: string) => { const n = s ? parseFloat(String(s).replace(/[^0-9.]/g, "")) : NaN; return Number.isFinite(n) ? n : null; };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

const SID_RE = /^[a-f0-9]{16,32}$/;

async function event(req: Request, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const text = await req.text();
  if (text.length > 2000) return new Response(null, { status: 413 });
  let body: { sid?: string; name?: string; props?: Record<string, unknown> };
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  if (!body.sid || !SID_RE.test(body.sid) || !body.name || !EVENT_NAMES.has(body.name)) return new Response(null, { status: 400 });
  const props: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(body.props ?? {})) {
    if (!PROP_KEYS.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") props[k] = v;
    else if (typeof v === "string") props[k] = v.slice(0, 40);
  }
  if (env.DB) {
    ctx.waitUntil(env.DB.prepare("INSERT INTO events (sid, name, props) VALUES (?, ?, ?)").bind(body.sid, body.name, JSON.stringify(props)).run().catch(() => {}));
  }
  return new Response(null, { status: 204 });
}

async function go(url: URL, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const slot = url.pathname.slice(4);
  const found = AD_SLOTS.find(s => s.slot === slot);
  // 承認前はアフィリエイトURLがないので、公式サイトへそのまま案内する（クリックは記録しない）
  if (found && !found.url && found.official) return new Response(null, { status: 302, headers: { location: found.official, "cache-control": "no-store" } });
  const ad = found?.url ? found : undefined;
  if (!ad) return Response.redirect(`${url.origin}/new.html`, 302);
  const sid = url.searchParams.get("sid");
  if (env.DB) {
    ctx.waitUntil(env.DB.prepare("INSERT INTO affiliate_clicks (sid, slot, use_key) VALUES (?, ?, ?)")
      .bind(sid && SID_RE.test(sid) ? sid : null, ad.slot, ad.use).run().catch(() => {}));
  }
  return new Response(null, { status: 302, headers: { location: ad.url, "cache-control": "no-store", "referrer-policy": "no-referrer-when-downgrade" } });
}

// PLATEAU（3D都市モデル）：地点の市区町村に建物の3D Tilesがあるかを調べ、あればURLを返す
const PLATEAU_API = "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles";
// 政令指定都市の市コード（区コードはこの値＋1〜29）
const DESIGNATED_CITIES = [1100, 4100, 11100, 12100, 14100, 14130, 14150, 15100, 22100, 22130, 23100, 26100, 27100, 27140, 28100, 33100, 34100, 40100, 40130, 43100];
async function cachedJson(key: string, url: string, ctx: { waitUntil: (p: Promise<unknown>) => void }, ttl = 86400): Promise<unknown> {
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const k = new Request(`https://cache.internal/${key}`);
  let r = await cache.match(k);
  if (!r) {
    const up = await fetch(url);
    if (!up.ok) throw new Error(`upstream ${up.status}`);
    r = new Response(await up.text(), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
    ctx.waitUntil(cache.put(k, r.clone()));
  }
  return r.json();
}

async function plateau(url: URL, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 20 || lat > 46 || lng < 122 || lng > 154) return json({ error: "bad_request" }, 400);
  try {
    const rg = await cachedJson(`gsi-rg/${lat.toFixed(4)},${lng.toFixed(4)}`,
      `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`, ctx) as { results?: { muniCd?: string; lv01Nm?: string } };
    const muni = rg.results?.muniCd?.padStart(5, "0");
    if (!muni) return json({ available: false, reason: "no_municipality" });
    // 政令市の区は、区コード → 市コードの順に試す（例：27127 → 27100）。それ以外の市町村はそのコードだけ
    const n = Number(muni);
    const city = DESIGNATED_CITIES.filter(c => n > c && n - c < 30).sort((x, y) => y - x)[0];
    const candidates = [n, ...(city ? [city] : [])].map(c => String(c).padStart(5, "0"));
    for (const code of candidates) {
      const spec = `${code}-bldg-maxlod2-latest`;
      const ts = await cachedJson(`plateau/${spec}`, `${PLATEAU_API}/${spec}/tileset.json`, ctx) as { root?: { children?: unknown[] } };
      if (ts.root?.children?.length) {
        console.log(JSON.stringify({ evt: "plateau", muni, code, available: true }));
        return json({
          available: true, code, muni, tilesetUrl: `${PLATEAU_API}/${spec}/tileset.json`,
          credit: "3D都市モデル（Project PLATEAU）（国土交通省）を加工して作成",
        });
      }
    }
    console.log(JSON.stringify({ evt: "plateau", muni, available: false }));
    return json({ available: false, reason: "not_covered", muni });
  } catch (e) {
    return json({ available: false, reason: "error" });
  }
}

// 国土地理院ベクトルタイルの建物（全国）：PLATEAUがない地域の周辺建物に使う
async function buildings(url: URL, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
  const radius = Math.min(250, Math.max(50, Number(url.searchParams.get("r")) || 150));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 20 || lat > 46 || lng < 122 || lng > 154) return json({ error: "bad_request" }, 400);
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const fetchTile = async (tileUrl: string): Promise<ArrayBuffer | null> => {
    const k = new Request(`https://cache.internal/gsi-vt/${tileUrl.split("/xyz/")[1]}`);
    let r = await cache.match(k);
    if (!r) {
      const up = await fetch(tileUrl);
      if (!up.ok) return null;
      r = new Response(await up.arrayBuffer(), { headers: { "cache-control": "public, max-age=604800" } });
      ctx.waitUntil(cache.put(k, r.clone()));
    }
    return r.arrayBuffer();
  };
  try {
    const res = await gsiBuildings(lat, lng, radius, fetchTile, url.searchParams.has("debug"));
    return new Response(JSON.stringify({ ...res, credit: "国土地理院最適化ベクトルタイル（建物の高さは種類からの推定）" }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400" },
    });
  } catch (e) {
    return json({ buildings: [], error: String(e).slice(0, 200) });
  }
}

// 地点の法規制・ハザード・周辺情報（不動産情報ライブラリ。タイル単位で1日キャッシュ）
async function siteInfoRoute(url: URL, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 20 || lat > 46 || lng < 122 || lng > 154) return json({ error: "bad_request" }, 400);
  if (!env.REINFOLIB_KEY) return json({ available: false, reason: "not_configured" });
  const only = url.searchParams.get("only")?.split(",").filter(Boolean);
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const fetchJson = async (api: string) => {
    const k = new Request(`https://cache.internal/reinfolib/${encodeURIComponent(api.split("/external/")[1])}`);
    let r = await cache.match(k);
    if (!r) {
      const up = await fetch(api, { headers: { "Ocp-Apim-Subscription-Key": env.REINFOLIB_KEY! } });
      if (up.status !== 200) return { status: up.status, body: null };
      r = new Response(await up.text(), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } });
      ctx.waitUntil(cache.put(k, r.clone()));
    }
    try { return { status: 200, body: await r.json() }; } catch { return { status: 599, body: null }; }
  };
  const info = await siteInfo(lat, lng, fetchJson, only);
  console.log(JSON.stringify({ evt: "site-info", apis: Object.keys(info).length }));
  return json({ available: true, info, source: "国土交通省 不動産情報ライブラリ", sourceUrl: "https://www.reinfolib.mlit.go.jp/" });
}
