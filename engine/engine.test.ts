import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlans } from "./engine.ts";
import { maxRectInMask, lngLatToLocal, area } from "./geom.ts";

const rect = (w: number, d: number): [number, number][] => [[0, 0], [w, 0], [w, d], [0, d]];

test("10m×20m・第一種低層・前面4〜6m：容積率と3案の基本値", () => {
  const r = computePlans({ polygon: rect(10, 20), roadEdges: [{ index: 0, width: "4to6" }], zone: "r1low" });
  assert.equal(r.site.area, 200);
  assert.equal(r.site.farEffective, 100); // min(100, 4×0.4×100)
  const [A, B, C] = r.plans;
  assert.equal(A.metrics.floors, 2);
  assert.ok(A.metrics.gfa > 90 && A.metrics.gfa < 200, `A gfa ${A.metrics.gfa}`); // 比較モードの自宅は「中間」
  assert.ok(B.metrics.farUsed <= 100 + 0.1, `B far ${B.metrics.farUsed}`);
  assert.ok(B.metrics.bcrUsed <= 50 + 0.1, `B bcr ${B.metrics.bcrUsed}`);
  assert.equal(C.title, "C案：月極駐車場");
  assert.equal(B.metrics.bcrUsed, 50); // 賃貸は建ぺい率いっぱい // 一低は店舗不可
  assert.ok(C.metrics.parking >= 3);
  assert.ok(A.metrics.parking >= 1, "戸建の手前に駐車1台以上");
});

test("商業地域・前面4m：道路幅員で容積率が下がる", () => {
  const r = computePlans({ polygon: rect(15, 25), roadEdges: [{ index: 0, width: "4to6" }], zone: "com" });
  assert.equal(r.site.farEffective, 240); // min(400, 4×0.6×100)
  for (const p of r.plans) {
    assert.ok(p.metrics.farUsed <= 240 + 0.1, `${p.id} far ${p.metrics.farUsed}`);
    assert.ok(p.metrics.bcrUsed <= 80 + 0.1, `${p.id} bcr ${p.metrics.bcrUsed}`);
  }
  assert.equal(r.plans[2].title, "C案：店舗＋駐車場");
});

test("向きが逆（時計回り）でも同じ結果", () => {
  const ccw = computePlans({ polygon: rect(12, 18), roadEdges: [{ index: 0, width: "6to12" }], zone: "r1" });
  const cw = computePlans({ polygon: rect(12, 18).slice().reverse(), roadEdges: [{ index: 2, width: "6to12" }], zone: "r1" });
  assert.deepEqual(cw.plans.map(p => p.metrics), ccw.plans.map(p => p.metrics));
});

test("L字型の敷地でも建物が敷地内・後退距離内に収まる", () => {
  const L: [number, number][] = [[0, 0], [20, 0], [20, 10], [8, 10], [8, 25], [0, 25]];
  const r = computePlans({ polygon: L, roadEdges: [{ index: 0, width: "6to12" }], zone: "r1mid" });
  const br = r.site.buildableRect!;
  assert.ok(br.u0 >= 0.5 - 1e-6 && br.v0 >= 1.0 - 1e-6);
  for (const p of r.plans) for (const b of p.buildings) {
    for (const [u, v] of [[b.u0, b.v0], [b.u1, b.v0], [b.u0, b.v1], [b.u1, b.v1]]) {
      const inA = u >= 0 && u <= 20 && v >= 0 && v <= 10;
      const inB = u >= 0 && u <= 8 && v >= 0 && v <= 25;
      assert.ok(inA || inB, `${p.id} corner (${u},${v}) outside`);
    }
  }
});

test("接道なしは警告を出す", () => {
  const r = computePlans({ polygon: rect(10, 10), roadEdges: [], zone: "r1" });
  assert.ok(r.warnings.some(w => w.includes("接道")));
  assert.equal(r.certainty.road, "unknown");
  assert.equal(r.plans[0].metrics.parking, 0);
});

for (const use of ["house", "rental"] as const) {
  test(`${use}：小さめ＜中間＜建ぺい率いっぱい、最大案は建ぺい率の上限に達する`, () => {
    const r = computePlans({ polygon: rect(14, 22), roadEdges: [{ index: 0, width: "6to12" }], zone: "r1", focusUse: use });
    assert.deepEqual(r.plans.map(p => p.use), [use, use, use]);
    assert.deepEqual(r.plans.map(p => p.size), ["small", "mid", "max"]);
    const g = r.plans.map(p => p.metrics.gfa);
    assert.ok(g[0] < g[1] && g[1] < g[2], `gfa ${g}`);
    const max = r.plans[2].metrics;
    assert.ok(Math.abs(max.bcrUsed - 60) < 0.5, `bcr ${max.bcrUsed}`);
    assert.ok(max.farUsed <= r.site.farEffective + 0.1, `far ${max.farUsed}`);
    assert.ok(max.floors <= r.site.floorsCap, `floors ${max.floors}`);
  });
}

test("容積率が建ぺい率の整数倍でないとき、最大案は上階を一部だけ載せる", () => {
  // 一低 50/80 → 1階 100㎡、上に約60㎡
  const r = computePlans({ polygon: rect(10, 20), roadEdges: [{ index: 0, width: "6to12" }], zone: "r1low", far: 80, focusUse: "house" });
  const m = r.plans[2];
  assert.equal(m.buildings.length, 2);
  assert.ok(Math.abs(m.metrics.farUsed - 80) < 0.5, `far ${m.metrics.farUsed}`);
  assert.ok(Math.abs(m.metrics.bcrUsed - 50) < 0.5, `bcr ${m.metrics.bcrUsed}`);
});

test("工業専用地域では住宅案を出さない", () => {
  const r = computePlans({ polygon: rect(20, 30), roadEdges: [{ index: 0, width: "gte12" }], zone: "indOnly" });
  assert.ok(r.plans.every(p => p.use === "other"));
});

test("最大長方形（ヒストグラム法）", () => {
  const m = [[0, 1, 1, 0], [1, 1, 1, 1], [1, 1, 1, 0]].map(r => Uint8Array.from(r));
  const best = maxRectInMask(m, 4)!;
  assert.equal(best.cells, 6);
});

test("経緯度→局所座標：約10m×20mの敷地", () => {
  const lat = 34.76, lng = 135.5;
  const dLat = 20 / 111320, dLng = 10 / (111320 * Math.cos((lat * Math.PI) / 180));
  const { local } = lngLatToLocal([[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat]]);
  assert.ok(Math.abs(area(local) - 200) < 2, `area ${area(local)}`);
});
