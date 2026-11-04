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
  /** 指定建蔽率・容積率（%）。分かる場合だけ上書き */
  bcr?: number;
  far?: number;
  /** 用途を1つに絞った場合、その用途の規模違い3案にする */
  focusUse?: UseKey | null;
}

export type Certainty = "confirmed" | "reference" | "unknown" | "user";

export interface Box extends Rect { floors: number; floorHeight: number; roof: "gable" | "flat"; kind: "house" | "apartment" | "store" }

export interface Plan {
  id: "A" | "B" | "C";
  use: UseKey;
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
  };
  certainty: Record<"shape" | "zone" | "bcrFar" | "road", Certainty>;
  plans: Plan[];
  warnings: string[];
}

const CELL = 0.25;
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

  // グリッド化
  const us = P.map(p => p[0]), vs = P.map(p => p[1]);
  const umin = Math.min(...us), umax = Math.max(...us), vmin = Math.min(...vs), vmax = Math.max(...vs);
  const cols = Math.max(1, Math.ceil((umax - umin) / CELL)), rows = Math.max(1, Math.ceil((vmax - vmin) / CELL));
  if (cols * rows > 4_000_000) throw new Error("敷地が大きすぎます（MVPは約1ha以下に対応）");
  const inside: Uint8Array[] = [], buildable: Uint8Array[] = [];
  const setbacks = P.map((_, i) => setbackOf(i));
  for (let r = 0; r < rows; r++) {
    const ins = new Uint8Array(cols), bld = new Uint8Array(cols);
    const v = vmin + (r + 0.5) * CELL;
    for (let c = 0; c < cols; c++) {
      const u = umin + (c + 0.5) * CELL;
      if (!pointInPolygon([u, v], P)) continue;
      ins[c] = 1;
      let ok = true;
      for (let i = 0; i < P.length && ok; i++) if (distToSegment([u, v], P[i], P[(i + 1) % P.length]) < setbacks[i]) ok = false;
      bld[c] = ok ? 1 : 0;
    }
    inside.push(ins); buildable.push(bld);
  }
  const mr = maxRectInMask(buildable, cols);
  const toRect = (m: { c0: number; r0: number; c1: number; r1: number }): Rect =>
    ({ u0: umin + m.c0 * CELL, v0: vmin + m.r0 * CELL, u1: umin + m.c1 * CELL, v1: vmin + m.r1 * CELL });
  const buildableRect = mr ? toRect(mr) : null;
  if (!buildableRect || rectArea(buildableRect) < 12) {
    warnings.push("後退距離を確保すると建物を置ける範囲がほとんどありません。敷地の形・大きさを確認してください。");
  }

  // 階数の上限：低層系は3階（絶対高さ10m前提）、それ以外は道路斜線の簡易計算（最大5階）
  const maxFootprint = (siteArea * bcr) / 100;
  const maxGFA = (siteArea * farEffective) / 100;
  const slope = zone.residential ? 1.25 : 1.5;
  const roadForSlope = roadWidth ?? 4;
  const frontGap = buildableRect ? buildableRect.v0 : ROAD_SETBACK;
  const slantH = slope * (Math.min(roadForSlope, 12) + 2 * frontGap);
  let floorsCap = zone.lowRise ? 3 : Math.max(1, Math.min(5, Math.floor(slantH / 3.0)));
  if (!zone.lowRise && floorsCap < 5) warnings.push(`道路斜線を簡易計算し、正面の高さを約${slantH.toFixed(1)}m（${floorsCap}階）までとしています。`);
  if (zone.lowRise) floorsCap = Math.min(floorsCap, 3);
  warnings.push("北側斜線・日影規制・高度地区・地区計画は考慮していません。");

  const ctx: Ctx = { siteArea, bcr, far, farEffective, maxFootprint, maxGFA, floorsCap, zone, buildableRect, inside, cols, rows, umin, vmin, P, hasRoad: roadEdges.length > 0 };

  const uses: { id: "A" | "B" | "C"; use: UseKey; scale: number }[] = input.focusUse
    ? (["A", "B", "C"] as const).map((id, k) => ({ id, use: input.focusUse!, scale: [0.75, 1, 1.3][k] }))
    : [{ id: "A", use: "house", scale: 1 }, { id: "B", use: "rental", scale: 1 }, { id: "C", use: "other", scale: 1 }];

  const plans = uses.map(({ id, use, scale }) => {
    if (!zone.housingAllowed && use !== "other") {
      const p = planOther(ctx, scale); p.id = id;
      p.notes.unshift("工業専用地域では住宅を建てられないため、住宅以外の活用案を表示しています。");
      return p;
    }
    const p = use === "house" ? planHouse(ctx, scale) : use === "rental" ? planRental(ctx, scale) : planOther(ctx, scale);
    p.id = id;
    if (input.focusUse) p.subtitle = `${["コンパクト", "標準", "ゆったり"][["A", "B", "C"].indexOf(id)]}・${p.subtitle}`;
    return p;
  });

  return {
    version: ENGINE_VERSION,
    site: { area: round1(siteArea), zone, bcr, far, farEffective: round1(farEffective), roadWidth, floorsCap, buildableRect, polygonUV: P, roadsUV },
    certainty: {
      shape: "user",
      zone: input.zone === "unknown" ? "unknown" : "user",
      bcrFar: input.bcr != null || input.far != null ? "user" : input.zone === "unknown" ? "unknown" : "reference",
      road: roadEdges.length ? "user" : "unknown",
    },
    plans,
    warnings,
  };
}

interface Ctx {
  siteArea: number; bcr: number; far: number; farEffective: number;
  maxFootprint: number; maxGFA: number; floorsCap: number; zone: ZoneInfo;
  buildableRect: Rect | null; inside: Uint8Array[]; cols: number; rows: number; umin: number; vmin: number; P: Vec2[];
  hasRoad: boolean;
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
    const c = Math.floor((u - ctx.umin) / CELL), r = Math.floor((v - ctx.vmin) / CELL);
    if (r < 0 || r >= ctx.rows || c < 0 || c >= ctx.cols || !ctx.inside[r][c]) return false;
    return !avoid.some(b => u > b.u0 - 0.3 && u < b.u1 + 0.3 && v > b.v0 - 0.3 && v < b.v1 + 0.3);
  };
  const fits = (s: Rect) => {
    for (let u = s.u0 + 0.1; u <= s.u1 - 0.1 + 1e-6; u += 0.3) for (let v = s.v0 + 0.1; v <= s.v1 - 0.1 + 1e-6; v += 0.3) if (!free(u, v)) return false;
    return true;
  };
  const vmaxAll = Math.max(...ctx.P.map(p => p[1]));
  const bands: number[] = [0];
  for (let pos = 5; pos + 5 <= vmaxAll; pos += 16) { bands.push(pos); if (pos + 16 <= vmaxAll) bands.push(pos + 11); }
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
  const footprint = buildings.reduce((s, b) => s + rectArea(b), 0);
  const gfa = buildings.reduce((s, b) => s + rectArea(b) * b.floors, 0);
  const floors = buildings.reduce((m, b) => Math.max(m, b.floors), 0);
  const height = buildings.reduce((m, b) => Math.max(m, b.floors * b.floorHeight + (b.roof === "gable" ? 1.5 : 0.5)), 0);
  return {
    footprint: round1(footprint), gfa: round1(gfa), floors, height: round1(height),
    bcrUsed: round1((footprint / ctx.siteArea) * 100), farUsed: round1((gfa / ctx.siteArea) * 100),
    units, parking: stalls.length, costMin: cost[0], costMax: cost[1],
  };
}

function planHouse(ctx: Ctx, scale: number): Plan {
  const notes: string[] = [];
  const rect = ctx.buildableRect;
  const targetGFA = Math.min(115 * scale, ctx.maxGFA);
  let floors = 2;
  let fp = Math.min(targetGFA / 2, ctx.maxFootprint, rect ? rectArea(rect) : 0);
  if (fp * 2 < targetGFA * 0.9 && ctx.floorsCap >= 3) { floors = 3; fp = Math.min(targetGFA / 3, ctx.maxFootprint, rect ? rectArea(rect) : 0); notes.push("敷地が小さいため3階建てにしています。"); }
  const buildings: Box[] = [];
  if (rect && fp >= 15) {
    const r = placeRect(rect, fp, "back");
    buildings.push({ ...r, floors, floorHeight: 2.9, roof: "gable", kind: "house" });
  } else notes.push("住宅を置ける広さが確保できません。");
  const stalls = placeStalls(ctx, buildings, 2);
  const gfa = buildings.reduce((s, b) => s + rectArea(b) * b.floors, 0);
  if (gfa < 70 && buildings.length) notes.push("延床面積が70㎡未満です。間取りはかなり限られます。");
  return {
    id: "A", use: "house", title: "A案：自宅（戸建）", subtitle: `${floors}階建て・切妻屋根`,
    buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, null, costRange(gfa, COST.house)), notes,
  };
}

function planRental(ctx: Ctx, scale: number): Plan {
  const notes: string[] = [];
  const rect = ctx.buildableRect;
  const buildings: Box[] = [];
  let units = 0, owner = false;
  if (rect && rectArea(rect) >= 30) {
    const fpMax = Math.min(rectArea(rect), ctx.maxFootprint) * Math.min(1, scale);
    const floorsByFar = Math.floor(ctx.maxGFA / fpMax);
    let floors = Math.max(1, Math.min(ctx.floorsCap, floorsByFar));
    if (scale > 1) floors = Math.max(1, Math.min(ctx.floorsCap, floors + 1));
    let fp = fpMax;
    if (fp * floors > ctx.maxGFA) fp = ctx.maxGFA / floors;
    const r = placeRect(rect, fp, "back");
    buildings.push({ ...r, floors, floorHeight: 3.0, roof: "flat", kind: "apartment" });
    const gfa = rectArea(r) * floors;
    owner = gfa >= 200;
    const rentable = gfa * 0.8 - (owner ? 75 : 0);
    units = Math.max(0, Math.floor(rentable / 25));
    if (units < 2) notes.push("賃貸住戸が2戸未満で、賃貸経営としては成り立ちにくい規模です。");
  } else notes.push("賃貸住宅を置ける広さが確保できません。");
  const stalls = placeStalls(ctx, buildings, 8);
  const b = buildings[0];
  const gfa = b ? rectArea(b) * b.floors : 0;
  const cost = costRange(gfa, b && b.floors >= 4 ? COST.rentalMid : COST.rentalLow);
  return {
    id: "B", use: "rental", title: owner ? "B案：賃貸併用住宅" : "B案：アパート",
    subtitle: b ? `${b.floors}階建て・${owner ? "オーナー住居＋" : ""}賃貸${units}戸（1K想定）` : "建築困難",
    buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, units, cost), notes,
  };
}

function planOther(ctx: Ctx, scale: number): Plan {
  const notes: string[] = [];
  const rect = ctx.buildableRect;
  const limit = ctx.zone.storeLimit;
  const buildings: Box[] = [];
  if (limit !== 0 && rect && rectArea(rect) >= 25) {
    let fp = Math.min(rectArea(rect), ctx.maxFootprint, Math.max(30, ctx.siteArea * 0.35 * scale));
    if (limit != null) fp = Math.min(fp, limit);
    const r = placeRect(rect, fp, "back");
    buildings.push({ ...r, floors: 1, floorHeight: 4.0, roof: "flat", kind: "store" });
  }
  const stalls = placeStalls(ctx, buildings, 200);
  const paved = stalls.length * 12.5 * 1.6;
  if (buildings.length) {
    const fa = rectArea(buildings[0]);
    const c1 = costRange(fa, COST.store);
    const p = [Math.round(paved * COST.parkingPerSqm[0]), Math.round(paved * COST.parkingPerSqm[1])];
    if (limit != null) notes.push(`この用途地域では、店舗の床面積はおおむね${limit}㎡までに制限されます。`);
    notes.push("業種によっては建てられない店舗があります。");
    return {
      id: "C", use: "other", title: "C案：店舗＋駐車場", subtitle: `平屋店舗 約${Math.round(fa)}㎡・駐車${stalls.length}台`,
      buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, null, [c1[0] + p[0], c1[1] + p[1]]), notes,
    };
  }
  if (limit === 0) notes.push("この用途地域では店舗の建築が大きく制限されるため、月極駐車場の案にしています。");
  if (!stalls.length) notes.push("駐車区画を確保できる形状ではありません。");
  const p: [number, number] = [Math.round(paved * COST.parkingPerSqm[0]), Math.round(paved * COST.parkingPerSqm[1])];
  return {
    id: "C", use: "other", title: "C案：月極駐車場", subtitle: `駐車${stalls.length}台（建物なし）`,
    buildings, stalls, metrics: finishMetrics(ctx, buildings, stalls, null, p), notes,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
