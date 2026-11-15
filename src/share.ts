import type { Vec2 } from "../engine/geom.ts";
import type { BuildingShape, RoadWidthClass, UseKey } from "../engine/engine.ts";
import { ZONES, type ZoneKey } from "../engine/zoning.ts";
import type { ExteriorStyle } from "../engine/roof.ts";

type EdgeChoice = RoadWidthClass | "none";
type Situation = "house" | "land" | "akiya" | "sell" | "inherit";
type ZoneSource = "api" | "user" | "guess" | "none";

export interface ShareData {
  v: 1; p: Vec2[]; e: EdgeChoice[]; z: ZoneKey; b?: string; f?: string;
  u: "" | UseKey; s?: Situation; st?: ExteriorStyle; r?: number;
  zs?: ZoneSource; sh?: BuildingShape;
}

const decimal = /^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/;
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === "string" && choices.includes(value as T);
const percent = (value: unknown, min: number, max: number): value is string | undefined =>
  value === undefined || (typeof value === "string" &&
    (value === "" || (decimal.test(value) && Number(value) >= min && Number(value) <= max)));

export function validateShareData(raw: unknown): ShareData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 1 || !Array.isArray(d.p) || d.p.length < 3 || d.p.length > 60) return null;
  if (!d.p.every(q => Array.isArray(q) && q.length === 2 &&
    q.every(Number.isFinite) && q[0] >= -180 && q[0] <= 180 && q[1] >= -90 && q[1] <= 90)) return null;
  if (typeof d.z !== "string" || !Object.hasOwn(ZONES, d.z)) return null;
  if (d.e !== undefined && (!Array.isArray(d.e) || !d.e.every(e => oneOf(e, ["none", "lt4", "4to6", "6to12", "gte12"] as const)))) return null;
  if (!percent(d.b, 10, 100) || !percent(d.f, 50, 1300)) return null;
  if (d.u !== undefined && !oneOf(d.u, ["", "house", "rental", "other"] as const)) return null;
  if (d.s !== undefined && !oneOf(d.s, ["house", "land", "akiya", "sell", "inherit"] as const)) return null;
  if (d.st !== undefined && !oneOf(d.st, ["wa", "white", "black"] as const)) return null;
  if (d.r !== undefined && (typeof d.r !== "number" || !Number.isFinite(d.r) || d.r <= -90 || d.r > 90)) return null;
  if (d.zs !== undefined && !oneOf(d.zs, ["api", "user", "guess", "none"] as const)) return null;
  if (d.sh !== undefined && !oneOf(d.sh, ["auto", "rect", "L", "U"] as const)) return null;
  return d as unknown as ShareData;
}
