// ボリュームエンジン：敷地＋前面道路＋用途地域 → 3案の建物形状と規模（決定的・外部依存なし）
import { type Vec2, type Rect, signedArea, area, pointInPolygon, distToSegment, edgeLength, maxRectInMask, rectArea } from "./geom.ts";
import { ZONES, type ZoneKey, type ZoneInfo } from "./zoning.ts";

export const ENGINE_VERSION = "0.1.0";

export type RoadWidthClass = "lt4" | "4to6" | "6to12" | "gte12";
export type UseKey = "house" | "rental" | "other";

export interface SiteInput {
  /** 局所平面座標（m）。向きは問わない */
  polygon: Vec2[];
  /** 道路に接する辺（i番目の頂点→i+1番目の頂点）と幅員区分 */
  roadEdges: { index: number; width: RoadWidthClass }[];
  zone: ZoneKey;
  /** 指定建ぺい率・容積率（%）。分かる場合だけ上書き */
  bcr?: number;
  far?: number;
  /** 用途を1つに絞った場合、その用途の規模違い3案にする */
  focusUse?: UseKey | null;
  /** 自動で決めた向きからの追加回転（度） */
  rotationOffsetDeg?: number;
  /** 用途地域等の出所：api=公的データから自動取得、user=利用者が指定、guess=街の様子から推定 */
  zoneSource?: "api" | "user" | "guess";
}

export type Certainty = "confirmed" | "public" | "reference" | "guess" | "unknown" | "user";

export interface Box extends Rect { floors: number; floorHeight: number; roof: "gable" | "flat"; kind: "house" | "apartment" | "store"; baseFloor?: number }
export type Size = "small" | "mid" | "max";

export interface Plan {
  id: "A" | "B" | "C";
  use: UseKey;
  size?: Size;
  title: string;
  subtitle: string;
  buildings: Box[];
  stalls: Rect[];
  metrics: {
    footprint: number; gfa: number; floors: number; height: number;
    bcrUsed: number; farUsed: number; units: number | null; parking: number;
    costMin: number; costMax: number; // 万円
  };
  notes: string[];
}

export interface EngineResult {
  version: string;
  site: {
    area: number; zone: ZoneInfo; bcr: number; far: number; farEffective: number;
    roadWidth: number | null; floorsCap: number;
    buildableRect: Rect | null; polygonUV: Vec2[]; roadsUV: Vec2[][];
    /** 局所平面(m)→(u,v)：u=(p-a)·ux, v=(p-a)·vx */
    frame: { a: Vec2; ux: Vec2; vx: Vec2 };
    /** 建物の向き（ラジアン、(u,v)平面で反時計回り）。建物・駐車区画の座標はこの角度だけ回した (s,t) 系 */
    rotation: number;
    autoRotation: number;
  };
  certainty: Record<"shape" | "zone" | "bcrFar" | "road", Certainty>;
  plans: Plan[];
  warnings: string[];
}

const BASE_CELL = 0.25;      // 計算グリッドの細かさ（m）。大きな敷地では自動で粗くする
const MAX_CELLS = 1_000_000; // グリッドのセル数の上限（計算時間の目安）
const MAX_BBOX_SQM = 250_000; // 敷地を囲む長方形の上限（約25ha）
const ROAD_SETBACK = 1.0;  // 道路側の後退（アプローチ・駐車の余地を含む目安）
const SIDE_SETBACK = 0.5;  // 隣地側（民法234条の目安）
const WIDTH_M: Record<RoadWidthClass, number> = { lt4: 4, "4to6": 4, "6to12": 6, gte12: 12 };

// 概算工事費の目安（万円/坪）。当サービスの暫定設定値（出典の整備は今後）
const COST = {
  house: [80, 110],
  rentalLow: [70, 100],   // 3階以下（木造・軽量鉄骨想定）
  rentalMid: [100, 140],  // 4階以上（RC・重量鉄骨想定）
  store: [60, 90],
  parkingPerSqm: [0.5, 1.0], // 万円/㎡（舗装・区画線）
} as const;
const TSUBO = 3.30579;

export function computePlans(input: SiteInput): EngineResult {
  const warnings: string[] = [];
  let poly = input.polygon.map(p => [p[0], p[1]] as Vec2);
  if (poly.length < 3) throw new Error("敷地は3点以上で指定してください");
  // 反時計回りにそろえ、道路辺のインデックスも付け替える
  let roadEdges = input.roadEdges.filter(r => r.index >= 0 && r.index < poly.length);
  if (signedArea(poly) < 0) {
    const n = poly.length;
    poly = poly.slice().reverse();
    // 元の辺 i (p_i→p_{i+1}) は、反転後は辺 n-2-i（mod n）
    roadEdges = roadEdges.map(r => ({ ...r, index: (((n - 2 - r.index) % n) + n) % n }));
  }
  const siteArea = area(poly);
  const zone = ZONES[input.zone] ?? ZONES.unknown;
  const bcr = clamp(input.bcr ?? zone.bcr, 10, 100);
  const far = clamp(input.far ?? zone.far, 50, 1300);

  // 前面道路：最も長い道路辺。なければ最長辺を仮の正面にする
  let front = -1, best = -1;
  for (const r of roadEdges) { const L = edgeLength(poly, r.index); if (L > best) { best = L; front = r.index; } }
  if (front < 0) {
    warnings.push("道路に接する辺が指定されていません。建築基準法の接道義務を満たさない土地には原則建築できません。最も長い辺を正面として仮に計算しています。");
    for (let i = 0; i < poly.length; i++) { const L = edgeLength(poly, i); if (L > best) { best = L; front = i; } }
  }

  // 道路幅員による容積率の制限（前面道路12m未満）
  let roadWidth: number | null = null;
  if (roadEdges.length) roadWidth = Math.max(...roadEdges.map(r => WIDTH_M[r.width]));
  let farEffective = far;
  if (roadWidth !== null && roadWidth < 12) {
    farEffective = Math.min(far, roadWidth * (zone.residential ? 0.4 : 0.6) * 100);
  }
  if (roadEdges.some(r => r.width === "lt4")) warnings.push("幅員4m未満の道路は、道路中心から2mまでのセットバックが必要な場合があります（0.5m後退として計算）。");

  // 正面辺を基準にした座標系 (u: 道路に沿う方向, v: 敷地の奥行方向)
  const a = poly[front], b = poly[(front + 1) % poly.length];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const vx: Vec2 = [-ux[1], ux[0]]; // 左法線＝敷地の内側
  const toUV = (p: Vec2): Vec2 => [(p[0] - a[0]) * ux[0] + (p[1] - a[1]) * ux[1], (p[0] - a[0]) * vx[0] + (p[1] - a[1]) * vx[1]];
  const P = poly.map(toUV);

  const setbackOf = (i: number) => {
    const r = roadEdges.find(e => e.index === i);
    if (!r) return SIDE_SETBACK;
    return ROAD_SETBACK + (r.width === "lt4" ? 0.5 : 0);
  };

  // 道路の帯（表示用）
  const roadsUV: Vec2[][] = roadEdges.map(r => {
    const p1 = P[r.index], p2 = P[(r.index + 1) % P.length];
    const w = WIDTH_M[r.width] === 12 ? 12 : r.width === "lt4" ? 3.5 : WIDTH_M[r.width] + (r.width === "4to6" ? 1 : 2);
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1], l = Math.hypot(dx, dy);
    const nx = dy / l, ny = -dx / l; // 外側（右法線）
    const ext = 6;
    const e1: Vec2 = [p1[0] - dx / l * ext, p1[1] - dy / l * ext], e2: Vec2 = [p2[0] + dx / l * ext, p2[1] + dy / l * ext];
    return [e1, e2, [e2[0] + nx * w, e2[1] + ny * w], [e1[0] + nx * w, e1[1] + ny * w]];
  });

  // グリッド化：建物の向き φ（道路の辺に対する回転）ごとに、敷地を回した座標 (s,t) で置ける範囲を調べる
  const setbacks = P.map((_, i) => setbackOf(i));
  const rotate = (p: Vec2, ang: number): Vec2 => [p[0] * Math.cos(ang) - p[1] * Math.sin(ang), p[0] * Math.sin(ang) + p[1] * Math.cos(ang)];
  function buildGrid(phi: number) {
    const Q = P.map(p => rotate(p, -phi));
    const us = Q.map(p => p[0]), vs = Q.map(p => p[1]);
    const umin = Math.min(...us), umax = Math.max(...us), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const bbox = (umax - umin) * (vmax - vmin);
    if (bbox > MAX_BBOX_SQM) throw new Error("敷地が大きすぎます（敷地を囲む長方形で約25haまで対応）");
    const CELL = Math.max(BASE_CELL, Math.sqrt(bbox / MAX_CELLS));
    const cols = Math.max(1, Math.ceil((umax - umin) / CELL)), rows = Math.max(1, Math.ceil((vmax - vmin) / CELL));
    const inside: Uint8Array[] = [], buildable: Uint8Array[] = [];
    for (let r = 0; r < rows; r++) {
      const ins = new Uint8Array(cols), bld = new Uint8Array(cols);
      const v = vmin + (r + 0.5) * CELL;
      for (let c = 0; c < cols; c++) {
        const u = umin + (c + 0.5) * CELL;
        if (!pointInPolygon([u, v], Q)) continue;
        ins[c] = 1;
        let ok = true;
        for (let i = 0; i < Q.length && ok; i++) if (distToSegment([u, v], Q[i], Q[(i + 1) % Q.length]) < setbacks[i]) ok = false;
        bld[c] = ok ? 1 : 0;
      }
      inside.push(ins); buildable.push(bld);
    }
    const mr = maxRectInMask(buildable, cols);
    const rect: Rect | null = mr ? { u0: umin + mr.c0 * CELL, v0: vmin + mr.r0 * CELL, u1: umin + mr.c1 * CELL, v1: vmin + mr.r1 * CELL } : null;
    return { phi, Q, CELL, cols, rows, umin, vmin, inside, rect, area: rect ? rectArea(rect) : 0, cells: cols * rows };
  }
  // 候補：道路に合わせた向き（0°）と、敷地の各辺に合わせた向き（±45°の範囲に正規化）
  const norm = (a: number) => { let x = ((a + Math.PI / 4) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4; if (Math.abs(x) < 1e-6) x = 0; return x; };
  const g0 = buildGrid(0);
  let bestG = g0;
  if (g0.cells <= 300_000) {
    const cands: number[] = [];
    for (let i = 0; i < P.length; i++) {
      const p1 = P[i], p2 = P[(i + 1) % P.length];
      const ang = norm(Math.atan2(p2[1] - p1[1], p2[0] - p1[0]));
      if (Math.abs(ang) > 0.5 * Math.PI / 180 && !cands.some(c => Math.abs(c - ang) < Math.PI / 180)) cands.push(ang);
    }
    for (const c of cands) { const g = buildGrid(c); if (g.area > bestG.area) bestG = g; }
    if (bestG.area < g0.area * 1.1) bestG = g0; // 差が小さければ道路向きを優先
  }
  const autoRotation = bestG.phi;
  const offset = ((input.rotationOffsetDeg ?? 0) * Math.PI) / 180;
  const G = offset ? buildGrid(autoRotation + offset) : bestG;
  const { Q, CELL, cols, rows, umin, vmin, inside } = G;
  const buildableRect = G.rect;
  if (!buildableRect || rectArea(buildableRect) < 12) {
    warnings.push("後退距離を確保すると建物を置ける範囲がほとんどありません。敷地の形・大きさを確認してください。");
  }
  if (Math.abs(autoRotation) > 1e-6 && !offset) warnings.push(`敷地の形に合わせて、建物の向きを道路から約${Math.round(Math.abs(autoRotation) * 180 / Math.PI)}°回しています。`);

  // 階数の上限：低層系は3階（絶対高さ10m前提）、それ以外は道路斜線の簡易計算（最大5階）
  const maxFootprint = (siteArea * bcr) / 100;
  const maxGFA = (siteArea * farEffective) / 100;
  const slope = zone.residential ? 1.25 : 1.5;
  const roadForSlope = roadWidth ?? 4;
  // 道路からの後退距離（建物の角のうち道路にいちばん近いもの）
  const frontGap = buildableRect
    ? Math.max(ROAD_SETBACK, Math.min(...[[buildableRect.u0, buildableRect.v0], [buildableRect.u1, buildableRect.v0], [buildableRect.u0, buildableRect.v1], [buildableRect.u1, buildableRect.v1]].map(c => rotate(c as Vec2, G.phi)[1])))
    : ROAD_SETBACK;
  const slantH = slope * (Math.min(roadForSlope, 12) + 2 * frontGap);
  const zoneMax = zone.lowRise ? 3 : 5;
  const floorsCap = Math.max(1, Math.min(zoneMax, Math.floor(slantH / 3.0)));
  if (roadEdges.length) warnings.push("道路斜線は簡易計算です（後退緩和を含む）。上限の案は、上の階を道路から段状に下げて計算しています。");
  warnings.push("北側斜線・日影規制・高度地区・地区計画は考慮していません。");

  // 道路斜線の適用距離（前面道路の反対側の境界から、この距離までが斜線の対象）
  const applyDist = zone.residential ? (far <= 200 ? 20 : far <= 300 ? 25 : far <= 400 ? 30 : 35) : (far <= 400 ? 20 : far <= 600 ? 25 : far <= 800 ? 30 : 35);
  const ctx: Ctx = { cell: CELL, siteArea, bcr, far, farEffective, maxFootprint, maxGFA, floorsCap, zone, buildableRect, inside, cols, rows, umin, vmin, P: Q, hasRoad: roadEdges.length > 0,
    phi: G.phi, slope, roadW: Math.min(roadForSlope, 12), applyDist };

  const ids = ["A", "B", "C"] as const;
  const SIZE_LABEL: Record<Size, string> = { small: "小さめ", mid: "中間", max: "上限" };
  let plans: Plan[];
  if (input.focusUse === "other" && zone.storeLimit === 0) {
    // 店舗がほぼ建てられない地域：規模違いではなく、活用方法違いの3案にする
    const alt: Plan[] = [planOther(ctx, "max"), planHouse(ctx, "small"), planRental(ctx, "max")];
    alt[1].title = "戸建賃貸"; alt[1].use = "other";
    alt[2].use = "other";
    plans = alt.map((p, k) => ({ ...p, id: ids[k], title: `${ids[k]}案：${p.title}` }));
    warnings.push("この用途地域では店舗の建築が大きく制限されるため、駐車場・戸建賃貸・アパートの3つの活用案を表示しています。");
  } else if (input.focusUse) {
    const sizes: Size[] = ["small", "mid", "max"];
    plans = sizes.map((size, k) => {
      const p = build(ctx, input.focusUse!, size, zone);
      p.id = ids[k];
      p.size = size;
      p.subtitle = `${p.title}・${p.subtitle}`;
      p.title = `${ids[k]}案：${SIZE_LABEL[size]}`;
      return p;
    });
    // 同じ形の案が並ぶ場合（敷地が小さい等）は注記する
    if (plans[0].metrics.gfa === plans[2].metrics.gfa && plans[0].metrics.parking === plans[2].metrics.parking) {
      warnings.push("敷地の条件から、規模を変えた案がほとんど同じになっています。");
    }
  } else {
    plans = (["house", "rental", "other"] as UseKey[]).map((use, k) => {
      const p = build(ctx, use, use === "house" ? "mid" : "max", zone);
      p.id = ids[k];
      p.title = `${ids[k]}案：${p.title}`;
      return p;
    });
  }

  return {
    version: ENGINE_VERSION,
    site: { area: round1(siteArea), zone, bcr, far, farEffective: round1(farEffective), roadWidth, floorsCap, buildableRect, polygonUV: P, roadsUV, frame: { a: [a[0], a[1]], ux, vx }, rotation: G.phi, autoRotation },
    certainty: {
      shape: "user",
      zone: input.zone === "unknown" ? "unknown" : input.zoneSource === "api" ? "public" : input.zoneSource === "guess" ? "guess" : "user",
      bcrFar: input.zone === "unknown" && input.bcr == null && input.far == null ? "unknown"
        : input.zoneSource === "api" ? "public"
        : input.bcr != null || input.far != null ? "user"
        : input.zoneSource === "guess" ? "guess" : "reference",
      road: roadEdges.length ? "user" : "unknown",
    },
    plans,
    warnings,
  };
}

interface Ctx {
  cell: number;
  siteArea: number; bcr: number; far: number; farEffective: number;
  maxFootprint: number; maxGFA: number; floorsCap: number; zone: ZoneInfo;
  buildableRect: Rect | null; inside: Uint8Array[]; cols: number; rows: number; umin: number; vmin: number; P: Vec2[];
  hasRoad: boolean;
  /** 道路斜線の段状計算用：建物の向き、勾配、前面道路の幅、適用距離 */
  phi: number; slope: number; roadW: number; applyDist: number;
}

/** 置ける範囲 rect の中に、面積 target の長方形を置く。anchor=back は奥寄せ（手前を駐車に使う） */
function placeRect(rect: Rect, target: number, anchor: "back" | "front" | "fill"): Rect {
  const W = rect.u1 - rect.u0, D = rect.v1 - rect.v0;
  if (anchor === "fill" || target >= W * D * 0.98) {
    // 面積が足りなければ奥行を詰めて合わせる
    const d = Math.min(D, target / W);
    return { u0: rect.u0, u1: rect.u1, v0: rect.v1 - d, v1: rect.v1 };
  }
  let w = Math.min(W, Math.max(Math.sqrt(target * 1.4), target / D));
  let d = Math.min(D, target / w);
  w = Math.min(W, target / d);
  const uc = (rect.u0 + rect.u1) / 2;
  const v0 = anchor === "back" ? rect.v1 - d : rect.v0;
  return { u0: uc - w / 2, u1: uc + w / 2, v0, v1: v0 + d };
}

/** 建物と重ならない場所に駐車区画（2.5m×5m）を並べる。1列目は道路から直接出入り、それ以降は通路6mをはさむ */
function placeStalls(ctx: Ctx, avoid: Rect[], maxCount: number): Rect[] {
  if (!ctx.hasRoad || maxCount <= 0) return [];
  const free = (u: number, v: number) => {
    const c = Math.floor((u - ctx.umin) / ctx.cell), r = Math.floor((v - ctx.vmin) / ctx.cell);
    if (r < 0 || r >= ctx.rows || c < 0 || c >= ctx.cols || !ctx.inside[r][c]) return false;
    return !avoid.some(b => u > b.u0 - 0.3 && u < b.u1 + 0.3 && v > b.v0 - 0.3 && v < b.v1 + 0.3);
  };
  const fits = (s: Rect) => {
    for (let u = s.u0 + 0.1; u <= s.u1 - 0.1 + 1e-6; u += 0.3) for (let v = s.v0 + 0.1; v <= s.v1 - 0.1 + 1e-6; v += 0.3) if (!free(u, v)) return false;
    return true;
  };
  const vmaxAll = Math.max(...ctx.P.map(p => p[1]));
  const t0 = ctx.vmin;
  const bands: number[] = [t0];
  for (let pos = t0 + 5; pos + 5 <= vmaxAll; pos += 16) { bands.push(pos); if (pos + 16 <= vmaxAll) bands.push(pos + 11); }
  const umaxAll = Math.max(...ctx.P.map(p => p[0]));
  const out: Rect[] = [];
  for (const v0 of bands) {
    for (let u0 = ctx.umin + 0.3; u0 + 2.5 <= umaxAll; ) {
      const s = { u0, v0, u1: u0 + 2.5, v1: v0 + 5 };
      if (fits(s)) { out.push(s); u0 += 2.5; if (out.length >= maxCount) return out; } else u0 += 0.5;
    }
  }
  return out;
}

function costRange(gfaOrArea: number, perTsubo: readonly [number, number]): [number, number] {
  const t = gfaOrArea / TSUBO;
  return [Math.round((t * perTsubo[0]) / 10) * 10, Math.round((t * perTsubo[1]) / 10) * 10];
}

function finishMetrics(ctx: Ctx, buildings: Box[], stalls: Rect[], units: number | null, cost: [number, number]): Plan["metrics"] {
  const footprint = buildings.filter(b => !b.baseFloor).reduce((s, b) => s + rectArea(b), 0);
  const gfa = buildings.reduce((s, b) => s + rectArea(b) * b.floors, 0);
  const floors = buildings.reduce((m, b) => Math.max(m, (b.baseFloor ?? 0) + b.floors), 0);
  const height = buildings.reduce((m, b) => Math.max(m, ((b.baseFloor ?? 0) + b.floors) * b.floorHeight + (b.roof === "gable" ? 1.5 : 0.5)), 0);
  return {
    footprint: round1(footprint), gfa: round1(gfa), floors, height: round1(height),
    bcrUsed: round1((footprint / ctx.siteArea) * 100), farUsed: round1((gfa / ctx.siteArea) * 100),
    units, parking: stalls.length, costMin: cost[0], costMax: cost[1],
  };
}

function build(ctx: Ctx, use: UseKey, size: Size, zone: ZoneInfo): Plan {
  if (!zone.housingAllowed && use !== "other") {
    const p = planOther(ctx, size);
    p.notes.unshift("工業専用地域では住宅を建てられないため、住宅以外の活用案を表示しています。");
    return p;
  }
  return use === "house" ? planHouse(ctx, size) : use === "rental" ? planRental(ctx, size) : planOther(ctx, size);
}

/**
 * 「建ぺい率いっぱい」の建物：1階は置ける最大の床（建ぺい率と敷地形状の小さい方）、
 * 上の階は容積率の残りで、階数の上限まで積む。最上階が一部だけになる場合は奥寄せの小さい階を載せる
 */
function maxMass(ctx: Ctx, rect: Rect, floorCap: number, kind: Box["kind"], fh: number, roof: Box["roof"]): Box[] {
  const fp = Math.min(rectArea(rect), ctx.maxFootprint);
  const base = placeRect(rect, fp, "back");
  const area0 = rectArea(base);
  const full = Math.max(1, Math.min(floorCap, Math.floor(ctx.maxGFA / area0 + 1e-6)));
  const out: Box[] = [{ ...base, floors: full, floorHeight: fh, roof, kind }];
  const rest = ctx.maxGFA - area0 * full;
  if (full < floorCap && rest >= 20) {
    const top = placeRect(base, Math.min(rest, area0), "back");
    out[0].roof = "flat";
    out.push({ ...top, floors: 1, floorHeight: fh, roof, kind, baseFloor: full });
  }
  return out;
}

const rot = (p: Vec2, ang: number): Vec2 => [p[0] * Math.cos(ang) - p[1] * Math.sin(ang), p[0] * Math.sin(ang) + p[1] * Math.cos(ang)];
/** 長方形の、道路境界線からのいちばん近い距離 */
function frontDist(ctx: Ctx, r: Rect): number {
  return Math.min(...([[r.u0, r.v0], [r.u1, r.v0], [r.u0, r.v1], [r.u1, r.v1]] as Vec2[]).map(c => rot(c, ctx.phi)[1]));
}
/** 道路側の辺を奥へ下げて、道路境界線からの距離を d 以上にする */
function cutFront(ctx: Ctx, r: Rect, d: number): Rect {
  let out = { ...r };
  for (let i = 0; i < 4 && frontDist(ctx, out) < d - 1e-3; i++) {
    out = { ...out, v0: Math.min(out.v1, out.v0 + (d - frontDist(ctx, out)) / Math.max(0.3, Math.cos(ctx.phi))) };
  }
  return out;
}

export type LimitReason = "far" | "cap" | "slant" | "area";
/**
 * 上限の建物：1階は建ぺい率いっぱい。上の階は、階ごとに道路斜線（後退緩和つきの簡易計算）を満たすよう
 * 道路側を下げ（段状）、容積率に届くまで、または階数の上限まで積む。最後の階は残りの面積だけ（奥寄せ）
 */
function steppedMass(ctx: Ctx, rect: Rect, cap: number, kind: Box["kind"], fh: number, roof: Box["roof"]): { boxes: Box[]; reason: LimitReason } {
  const base = placeRect(rect, Math.min(rectArea(rect), ctx.maxFootprint), "back");
  const s0 = frontDist(ctx, base); // 後退距離（建物のいちばん道路寄りの部分）
  const floors: Rect[] = [];
  let gfa = 0, reason: LimitReason = "cap";
  for (let k = 1; k <= cap; k++) {
    if (gfa >= ctx.maxGFA - 1) { reason = "far"; break; }
    let r = { ...base };
    if (ctx.hasRoad) {
      // 高さ H の部分は、道路境界線から H/勾配 − 道路幅 − 後退距離 以上離す（適用距離より先は制限なし）
      const need = Math.min((k * fh) / ctx.slope - ctx.roadW - s0, ctx.applyDist);
      if (need > frontDist(ctx, r)) r = cutFront(ctx, r, need);
    }
    const rem = ctx.maxGFA - gfa;
    if (rectArea(r) > rem) r = placeRect(r, rem, "back");
    if (rectArea(r) < 15 || r.u1 - r.u0 < 3 || r.v1 - r.v0 < 3) {
      reason = ctx.maxGFA - gfa < 15 ? "far" : k === 1 ? "area" : "slant";
      break;
    }
    floors.push(r); gfa += rectArea(r);
    if (k === cap) reason = gfa >= ctx.maxGFA - 1 ? "far" : "cap";
  }
  // 同じ形の階をまとめて箱にする
  const boxes: Box[] = [];
  floors.forEach((r, i) => {
    const last = boxes[boxes.length - 1];
    if (last && Math.abs(last.u0 - r.u0) < 1e-6 && Math.abs(last.u1 - r.u1) < 1e-6 && Math.abs(last.v0 - r.v0) < 1e-6 && Math.abs(last.v1 - r.v1) < 1e-6) last.floors++;
    else boxes.push({ ...r, floors: 1, floorHeight: fh, roof: "flat", kind, ...(i ? { baseFloor: i } : {}) });
  });
  if (boxes.length) boxes[boxes.length - 1].roof = roof;
  return { boxes, reason };
}

function limitNote(ctx: Ctx, boxes: Box[], reason: LimitReason, kind: "house" | "apartment"): string | null {
  const gfa = gfaOf(boxes), fp = boxes.filter(b => !b.baseFloor).reduce((s, b) => s + rectArea(b), 0);
  const farUsed = Math.round((gfa / ctx.siteArea) * 100), farMax = Math.round(ctx.farEffective);
  const parts: string[] = [];
  if (fp < ctx.maxFootprint - 1) parts.push(`建ぺい率は${ctx.bcr}％のうち約${Math.round((fp / ctx.siteArea) * 100)}％（敷地の形と後退距離のため、長方形の建物として計算）`);
  if (farUsed < farMax - 1) {
    const why = reason === "cap" ? (kind === "house" ? "戸建ては3階までとしているため" : "低層住居の地域（高さ10m前後）で3階までのため")
      : reason === "slant" ? "道路斜線（簡易計算）で、上の階を道路から下げても床を確保できないため"
      : reason === "area" ? "建てられる範囲が狭いため" : "";
    parts.push(`容積率は${farMax}％のうち約${farUsed}％${why ? `（${why}）` : ""}`);
  }
  return parts.length ? `上限まで使い切れていない点：${parts.join("。")}。` : null;
}

/** small と max の間をとる：延床を中間にして、建築面積も中間にする */
function midMass(ctx: Ctx, rect: Rect, small: Box[], max: Box[], kind: Box["kind"], fh: number, roof: Box["roof"]): Box[] {
  const g = (bs: Box[]) => bs.reduce((s, b) => s + rectArea(b) * b.floors, 0);
  const f = (bs: Box[]) => bs.filter(b => !b.baseFloor).reduce((s, b) => s + rectArea(b), 0);
  const gfa = (g(small) + g(max)) / 2;
  const fp = Math.min((f(small) + f(max)) / 2, ctx.maxFootprint, rectArea(rect));
  if (fp <= 0) return [];
  const maxFloors = max.reduce((m, b) => Math.max(m, (b.baseFloor ?? 0) + b.floors), 0);
  const floors = Math.max(1, Math.min(Math.max(ctx.floorsCap, Math.ceil(maxFloors / 2)), Math.round(gfa / fp)));
  const r = placeRect(rect, Math.min(fp, gfa / floors), "back");
  return [{ ...r, floors, floorHeight: fh, roof, kind }];
}

const gfaOf = (bs: Box[]) => bs.reduce((s, b) => s + rectArea(b) * b.floors, 0);

function planHouse(ctx: Ctx, size: Size): Plan {
  const notes: string[] = [];
  const rect = ctx.buildableRect;
  const buildings: Box[] = [];
  const cap = Math.min(ctx.floorsCap, 3);
  if (rect && rectArea(rect) >= 15) {
    // 小さめ：延床90㎡前後の2階建て（敷地が小さければ3階）
    const smallGFA = Math.min(90, ctx.maxGFA);
    let floors = 2, fp = Math.min(smallGFA / 2, ctx.maxFootprint, rectArea(rect));
    if (fp * 2 < smallGFA * 0.9 && cap >= 3) { floors = 3; fp = Math.min(smallGFA / 3, ctx.maxFootprint, rectArea(rect)); }
    floors = Math.min(floors, cap);
    const small: Box[] = [{ ...placeRect(rect, fp, "back"), floors, floorHeight: 2.9, roof: "gable", kind: "house" }];
    const st = steppedMass(ctx, rect, 3, "house", 2.9, "gable"); // 戸建ては3階まで
    const max = st.boxes.length ? st.boxes : maxMass(ctx, rect, cap, "house", 2.9, "gable");
    buildings.push(...(size === "small" ? small : size === "max" ? max : midMass(ctx, rect, small, max, "house", 2.9, "gable")));
    if (size === "max") { const n = limitNote(ctx, max, st.reason, "house"); if (n) notes.push(n); }
    if (buildings.some(b => (b.baseFloor ?? 0) + b.floors >= 3)) notes.push("3階建ての住宅です。");
  } else notes.push("住宅を置ける広さが確保できません。");
  const stalls = placeStalls(ctx, buildings, size === "max" ? 1 : 2);
  const gfa = gfaOf(buildings);
  if (gfa < 70 && buildings.length) notes.push("延床面積が70㎡未満です。間取りはかなり限られます。");
  if (size === "max" && gfa > 250) notes.push("建ぺい率・容積率いっぱいの規模です。二世帯住宅や店舗・事務所併用などの使い方が考えられます。");
  const floors = buildings.reduce((m, b) => Math.max(m, (b.baseFloor ?? 0) + b.floors), 0);
  return {
    id: "A", use: "house", title: "自宅（戸建）", subtitle: `${floors}階建て・延床約${Math.round(gfa)}㎡`,
    buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, null, costRange(gfa, COST.house)), notes,
  };
}

function planRental(ctx: Ctx, size: Size): Plan {
  const notes: string[] = [];
  const rect = ctx.buildableRect;
  const buildings: Box[] = [];
  if (rect && rectArea(rect) >= 30) {
    // 集合住宅は階数を固定しない（低層住居の地域だけ3階まで）。上限は容積率と段状の道路斜線で決まる
    const st = steppedMass(ctx, rect, ctx.zone.lowRise ? 3 : 30, "apartment", 3.0, "flat");
    const max = st.boxes.length ? st.boxes : maxMass(ctx, rect, ctx.floorsCap, "apartment", 3.0, "flat");
    if (size === "max") { const n = limitNote(ctx, max, st.reason, "apartment"); if (n) notes.push(n); }
    const fpMax = Math.min(rectArea(rect), ctx.maxFootprint);
    const sFloors = Math.max(1, Math.min(2, ctx.floorsCap));
    const sFp = Math.min(fpMax * 0.55, ctx.maxGFA / sFloors);
    const small: Box[] = [{ ...placeRect(rect, sFp, "back"), floors: sFloors, floorHeight: 3.0, roof: "flat", kind: "apartment" }];
    buildings.push(...(size === "small" ? small : size === "max" ? max : midMass(ctx, rect, small, max, "apartment", 3.0, "flat")));
  } else notes.push("賃貸住宅を置ける広さが確保できません。");
  const gfa = gfaOf(buildings);
  const units = buildings.length ? Math.max(0, Math.floor((gfa * 0.8) / 25)) : 0;
  if (units >= 4) notes.push("オーナー住居を含める場合は、住戸2〜3戸分を自宅スペースに置き換えます（賃貸併用住宅）。");
  if (buildings.length && units < 2) notes.push("賃貸住戸が2戸未満で、賃貸経営としては成り立ちにくい規模です。");
  const stalls = placeStalls(ctx, buildings, 8);
  const floors = buildings.reduce((m, b) => Math.max(m, (b.baseFloor ?? 0) + b.floors), 0);
  const cost = costRange(gfa, floors >= 4 ? COST.rentalMid : COST.rentalLow);
  return {
    id: "B", use: "rental", title: "アパート・賃貸併用",
    subtitle: buildings.length ? `${floors}階建て・賃貸${units}戸（1K想定）` : "建築困難",
    buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, units, cost), notes,
  };
}

function planOther(ctx: Ctx, size: Size): Plan {
  const notes: string[] = [];
  const rect = ctx.buildableRect;
  const limit = ctx.zone.storeLimit;
  const buildings: Box[] = [];
  if (limit !== 0 && rect && rectArea(rect) >= 25) {
    const ratio = size === "small" ? 0.2 : size === "mid" ? 0.35 : 1;
    let fp = Math.min(rectArea(rect), ctx.maxFootprint, Math.max(30, ctx.siteArea * ratio));
    if (limit != null) fp = Math.min(fp, limit);
    buildings.push({ ...placeRect(rect, fp, "back"), floors: 1, floorHeight: 4.0, roof: "flat", kind: "store" });
  }
  const stalls = placeStalls(ctx, buildings, 200);
  const paved = stalls.length * 12.5 * 1.6;
  const pc: [number, number] = [Math.round(paved * COST.parkingPerSqm[0]), Math.round(paved * COST.parkingPerSqm[1])];
  if (buildings.length) {
    const fa = rectArea(buildings[0]);
    const c1 = costRange(fa, COST.store);
    if (limit != null) notes.push(`この用途地域では、店舗の床面積はおおむね${limit}㎡までに制限されます。`);
    notes.push("業種によっては建てられない店舗があります。");
    return {
      id: "C", use: "other", title: "店舗＋駐車場", subtitle: `平屋店舗 約${Math.round(fa)}㎡・駐車${stalls.length}台`,
      buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, null, [c1[0] + pc[0], c1[1] + pc[1]]), notes,
    };
  }
  if (limit === 0) notes.push("この用途地域では店舗の建築が大きく制限されるため、月極駐車場の案にしています。");
  if (!stalls.length) notes.push("駐車区画を確保できる形状ではありません。");
  return {
    id: "C", use: "other", title: "月極駐車場", subtitle: `駐車${stalls.length}台（建物なし）`,
    buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, null, pc), notes,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
