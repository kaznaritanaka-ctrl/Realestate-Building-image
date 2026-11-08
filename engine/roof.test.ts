import { test } from "node:test";
import assert from "node:assert/strict";
import { applyExteriorStyle, computePlans, type Box, type Plan } from "./engine.ts";
import { buildingHeight, planHeight, roofSpec } from "./roof.ts";

const box: Box = { u0: 1, u1: 11, v0: 2, v1: 8, floorHeight: 3, floors: 2, roof: "gable", kind: "house" };
const rect = (w: number, d: number): [number, number][] => [[0, 0], [w, 0], [w, d], [0, d]];

test("切妻/寄棟は短辺から算出し、幅と奥行を交換しても高さは同じ", () => {
  for (const style of ["white", "black", "wa"] as const) {
    const s = roofSpec(box, style);
    assert.equal(s.kind, style === "wa" ? "hip" : "gable");
    assert.equal(s.rise, 6 * (style === "wa" ? 0.3 : 0.28));
    assert.equal(s.eave, style === "wa" ? 0.75 : 0.5);
    assert.equal(s.baseY, 6);
    assert.equal(s.alongU, true);
    const swapped = { ...box, u1: 7, v1: 12 };
    assert.equal(roofSpec(swapped, style).alongU, false);
    assert.equal(buildingHeight(swapped, style), buildingHeight(box, style));
  }
});

test("陸屋根は全スタイルでパラペット0.5mと笠木0.08mを含む", () => {
  for (const style of ["white", "black", "wa"] as const) {
    const s = roofSpec({ ...box, roof: "flat", baseFloor: 2 }, style);
    assert.equal(s.kind, "flat");
    assert.equal(s.baseY, 12);
    assert.ok(Math.abs(s.rise - 0.58) < 1e-12);
    assert.equal(planHeight([{ ...box, roof: "flat", baseFloor: 2 }], style), 12.6);
  }
});

test("段状・複数棟はbaseFloorを含めた最高点、駐車場だけなら0m", () => {
  assert.equal(planHeight([], "wa"), 0);
  const bs: Box[] = [{ ...box, roof: "flat" }, { ...box, floors: 1, baseFloor: 2, u1: 5 }];
  assert.equal(planHeight(bs), 10.1);
  assert.equal(planHeight(bs, "wa"), 10.2);
  assert.equal(planHeight(bs.slice().reverse(), "wa"), 10.2);
});

test("外観の反復切替は全案の高さだけを更新し、入力のPlanを変更しない", () => {
  const res = computePlans({ polygon: rect(14, 22), roadEdges: [{ index: 0, width: "6to12" }], zone: "r1", focusUse: "house" });
  for (const p of res.plans) {
    const saved = structuredClone(p);
    let current: Plan = p;
    for (const style of ["wa", "black", "white", "wa", "white"] as const) {
      current = applyExteriorStyle(current, style);
      assert.equal(current.exteriorStyle, style);
      assert.equal(current.metrics.height, planHeight(p.buildings, style));
      assert.deepEqual({ ...current.metrics, height: 0 }, { ...p.metrics, height: 0 });
      assert.deepEqual(current.buildings, p.buildings);
    }
    assert.deepEqual(p, saved);
    assert.deepEqual(current, p);
  }
});

test("computePlansは選択された外観の高さを返す（住宅・賃貸・店舗・空き地、L/U/段状）", () => {
  let sawStepped = false, sawMultiple = false, sawFlat = false, sawPitched = false;
  for (const exteriorStyle of ["white", "black", "wa"] as const) {
    for (const focusUse of ["house", "rental", "other"] as const) {
      for (const shape of ["rect", "L", "U"] as const) {
        const r = computePlans({ polygon: rect(20, 25), roadEdges: [{ index: 0, width: "6to12" }], zone: "r2mid", focusUse, shape, exteriorStyle });
        for (const p of r.plans) {
          assert.equal(p.exteriorStyle, exteriorStyle);
          assert.equal(p.metrics.height, planHeight(p.buildings, exteriorStyle));
          sawMultiple ||= p.buildings.length > 1;
          for (const b of p.buildings) { sawStepped ||= !!b.baseFloor; sawFlat ||= b.roof === "flat"; sawPitched ||= b.roof === "gable"; }
        }
      }
    }
  }
  assert.ok(sawStepped && sawMultiple && sawFlat && sawPitched);
  const parking = computePlans({ polygon: rect(10, 20), roadEdges: [], zone: "r1low", focusUse: "other", exteriorStyle: "wa" }).plans[0];
  assert.equal(parking.buildings.length, 0);
  assert.equal(parking.metrics.height, 0);
});
