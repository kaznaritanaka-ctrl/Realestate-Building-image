// 屋根の共通仕様。単位はm。数値表示・3D・制御パッケージで同じ定義を使う。
import type { Box } from "./engine.ts";

export type ExteriorStyle = "wa" | "white" | "black";

export interface RoofSpec {
  kind: "gable" | "hip" | "flat";
  /** 棟は長辺方向。正方形はu方向とする */
  alongU: boolean;
  length: number;
  span: number;
  eave: number;
  /** 壁の上端（地面から）。baseFloorを含む */
  baseY: number;
  /** 壁の上端から屋根／笠木の最高点まで */
  rise: number;
  parapetHeight: number;
  copingThickness: number;
}

export function roofSpec(b: Box, style: ExteriorStyle = "white"): RoofSpec {
  const w = b.u1 - b.u0, d = b.v1 - b.v0;
  const kind = b.roof === "flat" ? "flat" : style === "wa" ? "hip" : "gable";
  const span = Math.min(w, d);
  const parapetHeight = kind === "flat" ? 0.5 : 0;
  const copingThickness = kind === "flat" ? 0.08 : 0;
  return {
    kind, alongU: w >= d, length: Math.max(w, d), span,
    eave: kind === "flat" ? 0 : kind === "hip" ? 0.75 : 0.5,
    baseY: ((b.baseFloor ?? 0) + b.floors) * b.floorHeight,
    rise: kind === "flat" ? parapetHeight + copingThickness : span * (kind === "hip" ? 0.3 : 0.28),
    parapetHeight, copingThickness,
  };
}

/** 最高点。表示上の「約」は最後に0.1m単位へ丸める。建築法規の高さ判定ではない。 */
export function buildingHeight(b: Box, style: ExteriorStyle = "white"): number {
  const roof = roofSpec(b, style);
  return roof.baseY + roof.rise;
}

export function planHeight(buildings: readonly Box[], style: ExteriorStyle = "white"): number {
  return Math.round(buildings.reduce((max, b) => Math.max(max, buildingHeight(b, style)), 0) * 10) / 10;
}
