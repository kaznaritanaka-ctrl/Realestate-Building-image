// 国土地理院 最適化ベクトルタイル（試験公開）から、地点の周りの建物の外形を取り出す。
// 高さはデータにないため、建物の種類（普通建物・堅ろう建物・高層建物 等）から推定する。
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

const TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1";
const Z = 16;

// 種類 → 推定の高さ（m）。ftCode と種類名の両方に対応する
const HEIGHT_BY_CODE: Record<string, number> = {
  "3101": 6.5,  // 普通建物（2階程度）
  "3102": 13,   // 堅ろう建物（4階程度）
  "3103": 30,   // 高層建物（10階程度）
  "3111": 3,    // 普通無壁舎
  "3112": 4,    // 堅ろう無壁舎
};
const HEIGHT_BY_NAME: [RegExp, number][] = [[/高層/, 30], [/堅ろう無壁/, 4], [/無壁/, 3], [/堅ろう/, 13], [/普通/, 6.5]];

export interface GsiBuilding { h: number; kind: string; ring: [number, number][] }

function tileXY(lng: number, lat: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

export async function gsiBuildings(lat: number, lng: number, radius: number, fetchTile: (url: string) => Promise<ArrayBuffer | null>, debug = false) {
  // 半径ぶんの範囲にかかるタイル（z16 は1辺約500m）
  const dLat = radius / 111320, dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const a = tileXY(lng - dLng, lat + dLat, Z), b = tileXY(lng + dLng, lat - dLat, Z);
  const tiles: [number, number][] = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) tiles.push([x, y]);

  const out: GsiBuilding[] = [];
  const layerNames = new Set<string>();
  const samples: Record<string, unknown>[] = [];
  for (const [x, y] of tiles.slice(0, 9)) {
    const buf = await fetchTile(`${TILE_URL}/${Z}/${x}/${y}.pbf`);
    if (!buf) continue;
    const vt = new VectorTile(new Pbf(new Uint8Array(buf)));
    for (const name of Object.keys(vt.layers)) {
      layerNames.add(name);
      if (!/bld|building/i.test(name)) continue;
      const layer = vt.layers[name];
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.type !== 3) continue; // ポリゴンのみ
        const props = f.properties as Record<string, string | number>;
        if (debug && samples.length < 5) samples.push({ layer: name, ...props });
        const code = String(props.ftCode ?? props.ftcode ?? "");
        const kindName = String(props.type ?? props.name ?? props.vt_name ?? "");
        let h = HEIGHT_BY_CODE[code];
        if (h === undefined) h = HEIGHT_BY_NAME.find(([re]) => re.test(kindName))?.[1] ?? 6.5;
        const gj = f.toGeoJSON(x, y, Z);
        const polys = gj.geometry.type === "Polygon" ? [gj.geometry.coordinates] : gj.geometry.type === "MultiPolygon" ? gj.geometry.coordinates : [];
        for (const poly of polys as [number, number][][][]) {
          const ring = poly[0];
          if (!ring || ring.length < 4) continue;
          // 中心が範囲内の建物だけ
          const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          if (Math.abs(cx - lng) > dLng || Math.abs(cy - lat) > dLat) continue;
          out.push({ h, kind: code || kindName, ring: ring.map(([px, py]) => [Math.round(px * 1e7) / 1e7, Math.round(py * 1e7) / 1e7]) });
        }
      }
    }
  }
  return { buildings: out.slice(0, 3000), tiles: tiles.length, ...(debug ? { layers: [...layerNames], samples } : {}) };
}
