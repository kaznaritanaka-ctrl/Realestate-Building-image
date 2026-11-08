import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlans, applyExteriorStyle } from "../engine/engine.ts";
import { planHeight, roofSpec } from "../engine/roof.ts";
import { controlPlanSpec } from "./export.ts";

for (const style of ["white", "black", "wa"] as const) {
  test(`${style}: 制御仕様の屋根形状・寸法・高さは描画と同じ`, () => {
    const res = computePlans({ polygon: [[0, 0], [10, 0], [10, 20], [0, 20]], roadEdges: [{ index: 0, width: "4to6" }], zone: "r1low" });
    for (const original of res.plans) {
      const p = applyExteriorStyle(original, style);
      const out = controlPlanSpec(p);
      assert.equal(out.exteriorStyle, style);
      assert.equal(out.metrics.height, planHeight(p.buildings, style));
      out.buildings.forEach((b, i) => {
        assert.deepEqual(b.roofSpec, roofSpec(p.buildings[i], style));
        assert.equal(b.roof, b.roofSpec.kind);
      });
      if (p.buildings[0]?.roof === "gable") assert.ok(out.prompt.includes(style === "wa" ? "hip roof" : "gable roof"));
    }
  });
}
