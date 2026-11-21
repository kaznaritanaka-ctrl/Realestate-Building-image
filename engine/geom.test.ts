import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyRing, pointInRing, ringForPoint, area, lngLatToLocal, type Vec2 } from "./geom.ts";

const areaM2 = (ring: Vec2[]) => area(lngLatToLocal(ring).local);

function circleWithCorners(n: number): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    ring.push([135.5 + Math.cos(t) * 0.0002, 34.75 + Math.sin(t) * 0.0002]);
  }
  return ring;
}

test("頂点の多いリングは上限以下に減り、面積は±5%以内", () => {
  const ring = circleWithCorners(200);
  const out = simplifyRing(ring);
  assert.ok(out.length <= 24, `vertices=${out.length}`);
  assert.ok(out.length >= 3);
  const ratio = areaM2(out) / areaM2(ring);
  assert.ok(Math.abs(ratio - 1) <= 0.05, `ratio=${ratio}`);
});

test("鋭い角は残り、まっすぐな辺の途中点は落ちる", () => {
  // 矩形の上辺に細かい刻み（途中点）を入れ、下辺中央に鋭い突起（スパイク）を付けた形
  const ring: Vec2[] = [[135.5, 34.75], [135.5004, 34.75], [135.5004, 34.7503]];
  for (let i = 1; i <= 9; i++) ring.push([135.5004 - i * 0.00004, 34.7503]); // 上辺の途中点9個
  ring.push([135.5, 34.7503], [135.5, 34.75]);
  const spike: Vec2 = [135.5002, 34.74985]; // 下辺から外へ突き出す鋭い角
  const withSpike: Vec2[] = [ring[0], ring[1], spike, ...ring.slice(2)];
  const out = simplifyRing(withSpike, 8);
  assert.ok(out.some(p => p[0] === spike[0] && p[1] === spike[1]), "スパイクの先端が残ること");
  assert.ok(out.length <= 8);
});

test("pointInRing は内側と外側を判定する", () => {
  const sq: Vec2[] = [[135.5, 34.75], [135.501, 34.75], [135.501, 34.751], [135.5, 34.751]];
  assert.equal(pointInRing([135.5005, 34.7505], sq), true);
  assert.equal(pointInRing([135.502, 34.7505], sq), false);
  // L字の凹部は外側
  const lShape: Vec2[] = [[135.5, 34.75], [135.501, 34.75], [135.501, 34.7505], [135.5005, 34.7505], [135.5005, 34.751], [135.5, 34.751]];
  assert.equal(pointInRing([135.5007, 34.7507], lShape), false);
  assert.equal(pointInRing([135.5002, 34.7507], lShape), true);
});

test("ringForPoint は点を含む部分を返し、なければ最大の部分を返す", () => {
  const small: Vec2[][] = [[[135.5, 34.75], [135.5002, 34.75], [135.5002, 34.7502], [135.5, 34.7502], [135.5, 34.75]]];
  const big: Vec2[][] = [[[135.501, 34.75], [135.5016, 34.75], [135.5016, 34.7506], [135.501, 34.7506], [135.501, 34.75]]];
  const mp: Vec2[][][] = [small, big];
  assert.equal(ringForPoint(mp, [135.5001, 34.7501]), small[0]);
  assert.equal(ringForPoint(mp, [135.5013, 34.7503]), big[0]);
  assert.equal(ringForPoint(mp, [135.6, 34.8]), big[0]);
});

test("4点の矩形はそのまま返る", () => {
  const rect: Vec2[] = [[135.5, 34.75], [135.5004, 34.75], [135.5004, 34.7503], [135.5, 34.7503]];
  assert.deepEqual(simplifyRing(rect), rect);
});

test("結果は常に3点以上", () => {
  const thin: Vec2[] = [];
  for (let i = 0; i < 100; i++) thin.push([135.5 + i * 1e-7, 34.75]);
  for (let i = 0; i < 100; i++) thin.push([135.5 + (100 - i) * 1e-7, 34.75 + 1e-8]);
  assert.ok(simplifyRing(thin, 4).length >= 3);
  assert.ok(simplifyRing(circleWithCorners(500), 3).length >= 3);
});
