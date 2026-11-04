// Worker：静的アセット配信＋API（/api/*）
// /api/zoning?lat=&lng= … 不動産情報ライブラリ（国土交通省）XKT002 で、その地点の用途地域・建蔽率・容積率を返す
interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  REINFOLIB_KEY?: string;
}

const Z = 15;

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/zoning") return zoning(url, env, ctx);
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
