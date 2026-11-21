import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyRing, area, lngLatToLocal, type Vec2 } from "./geom.ts";

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
  assert.ok(out.length <= 40, `vertices=${out.length}`);
  assert.ok(out.length >= 3);
  const ratio = areaM2(out) / areaM2(ring);
  assert.ok(Math.abs(ratio - 1) <= 0.05, `ratio=${ratio}`);
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
