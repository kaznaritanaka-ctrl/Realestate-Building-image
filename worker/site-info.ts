// 不動産情報ライブラリの各APIから、地点の法規制・ハザード・周辺情報を集める
type Kind = "poly" | "point" | "line";
interface Layer { api: string; label: string; kind: Kind; z: number[]; extra?: Record<string, string>; radius?: number }

export const LAYERS: Layer[] = [
  { api: "XKT001", label: "区域区分", kind: "poly", z: [15, 14, 13] },
  { api: "XKT002", label: "用途地域", kind: "poly", z: [15, 14] },
  { api: "XKT014", label: "防火・準防火地域", kind: "poly", z: [15, 14] },
  { api: "XKT023", label: "地区計画", kind: "poly", z: [15, 14] },
  { api: "XKT024", label: "高度利用地区", kind: "poly", z: [15, 14] },
  { api: "XKT030", label: "都市計画道路", kind: "line", z: [15, 14], radius: 25 },
  { api: "XKT026", label: "洪水浸水想定区域（想定最大規模）", kind: "poly", z: [15, 14, 13] },
  { api: "XKT029", label: "土砂災害警戒区域", kind: "poly", z: [15, 14, 13] },
  { api: "XKT020", label: "大規模盛土造成地", kind: "poly", z: [15, 14, 13] },
  { api: "XKT025", label: "液状化の発生傾向", kind: "poly", z: [15, 14, 13] },
  { api: "XPT002", label: "地価公示・地価調査（近い地点）", kind: "point", z: [14, 13], radius: 1500 },
  { api: "XKT015", label: "駅別乗降客数（近い駅）", kind: "point", z: [13, 12, 11], radius: 3000 },
];

type Pos = [number, number];
interface Feature { geometry?: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }

const tileOf = (lng: number, lat: number, z: number) => {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
};
function inRing(ring: Pos[], [x, y]: Pos) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function containsPoint(g: Feature["geometry"], p: Pos): boolean {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates as Pos[][]] : g.type === "MultiPolygon" ? (g.coordinates as Pos[][][]) : [];
  return polys.some(rings => rings.length > 0 && inRing(rings[0], p) && !rings.slice(1).some(h => inRing(h, p)));
}
function metersBetween([lng1, lat1]: Pos, [lng2, lat2]: Pos) {
  const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 111320);
}
function distToGeom(g: Feature["geometry"], p: Pos): number {
  if (!g) return Infinity;
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 111320;
  const seg = (a: Pos, b: Pos) => {
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  };
  const lines: Pos[][] = g.type === "LineString" ? [g.coordinates as Pos[]] : g.type === "MultiLineString" ? (g.coordinates as Pos[][])
    : g.type === "Polygon" ? (g.coordinates as Pos[][]) : g.type === "MultiPolygon" ? (g.coordinates as Pos[][][]).flat() : [];
  if (g.type === "Point") return metersBetween(p, g.coordinates as Pos);
  let d = Infinity;
  for (const l of lines) for (let i = 1; i < l.length; i++) d = Math.min(d, seg(l[i - 1], l[i]));
  return d;
}
const trim = (props: Record<string, unknown> = {}) => {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (v !== null && v !== "" && Object.keys(o).length < 40) o[k] = v;
  return o;
};

export async function siteInfo(lat: number, lng: number, fetchJson: (url: string) => Promise<{ status: number; body: unknown }>, only?: string[]) {
  const p: Pos = [lng, lat];
  const year = String(new Date().getUTCFullYear() - 1);
  const out: Record<string, unknown> = {};
  await Promise.all(LAYERS.filter(l => !only || only.includes(l.api)).map(async (layer) => {
    let lastStatus = 0;
    for (const z of layer.z) {
      const [tx, ty] = tileOf(lng, lat, z);
      const tiles = layer.kind === "point" ? [-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => [tx + dx, ty + dy])) : [[tx, ty]];
      const feats: Feature[] = [];
      let ok = false;
      for (const [x, y] of tiles) {
        const extra = layer.api === "XPT002" ? `&year=${year}` : "";
        const r = await fetchJson(`https://www.reinfolib.mlit.go.jp/ex-api/external/${layer.api}?response_format=geojson&z=${z}&x=${x}&y=${y}${extra}`);
        lastStatus = r.status;
        if (r.status !== 200) continue;
        ok = true;
        feats.push(...(((r.body as { features?: Feature[] })?.features) ?? []));
      }
      if (!ok) continue;
      let hits: { d?: number; props: Record<string, unknown> }[];
      if (layer.kind === "poly") hits = feats.filter(f => containsPoint(f.geometry, p)).map(f => ({ props: trim(f.properties) }));
      else hits = feats.map(f => ({ d: Math.round(distToGeom(f.geometry, p)), props: trim(f.properties) }))
        .filter(h => h.d! <= (layer.radius ?? 50)).sort((a, b) => a.d! - b.d!).slice(0, 3);
      out[layer.api] = { label: layer.label, z, found: hits.length, hits };
      return;
    }
    out[layer.api] = { label: layer.label, error: `status ${lastStatus}` };
  }));
  return out;
}
