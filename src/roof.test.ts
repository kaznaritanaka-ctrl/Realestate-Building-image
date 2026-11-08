import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { type Box, computePlans } from "../engine/engine.ts";
import { buildingHeight, roofSpec } from "../engine/roof.ts";
import { createRoof } from "./roof.ts";

const mat = new THREE.MeshBasicMaterial();
const materials = { surface: mat, trim: mat, gutter: mat, coping: mat };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

for (const style of ["white", "black", "wa"] as const) {
  test(`${style}: 実際の屋根メッシュの最高点が共通仕様に一致（長辺向き/正方形/寸法/段状）`, () => {
    for (const [w, d] of [[10, 6], [6, 10], [6, 6], [3.5, 20], [18, 24]]) {
      for (const roof of ["gable", "flat"] as const) {
        for (const baseFloor of [0, 2]) {
          const b: Box = { u0: 2, u1: 2 + w, v0: 3, v1: 3 + d, floors: 2, floorHeight: 3, roof, kind: "house", baseFloor };
          const spec = roofSpec(b, style);
          const mesh = createRoof(b, spec, materials);
          if (roof === "flat") assert.ok(mesh.children.every(o => (o as THREE.Mesh).receiveShadow));
          const bounds = new THREE.Box3().setFromObject(mesh);
          near(bounds.max.y, buildingHeight(b, style));
          // u/vの交換や回転でも高さは変わらない。
          const parent = new THREE.Group(); parent.rotation.y = Math.PI / 7; parent.add(mesh);
          near(new THREE.Box3().setFromObject(parent).max.y, buildingHeight(b, style));
          // 表面の平面範囲は、実際の建物寸法＋両側の軒（陸屋根は笠木の張り出し）。
          const top = mesh.children[spec.kind === "flat" ? 1 : 0];
          parent.rotation.y = 0; parent.updateMatrixWorld(true);
          const surface = new THREE.Box3().setFromObject(top);
          near(surface.max.x - surface.min.x, w + (spec.kind === "flat" ? 0.2 : spec.eave * 2));
          near(surface.max.z - surface.min.z, d + (spec.kind === "flat" ? 0.2 : spec.eave * 2));
        }
      }
    }
  });
  test(`${style}: L/U/段状の実メッシュ最高点を丸めるとエンジンの表示値になる`, () => {
    for (const shape of ["rect", "L", "U"] as const) {
      for (const focusUse of ["house", "rental", "other"] as const) {
        const result = computePlans({ polygon: [[0, 0], [20, 0], [20, 25], [0, 25]], roadEdges: [{ index: 0, width: "6to12" }], zone: "r2mid", focusUse, shape, exteriorStyle: style });
        for (const p of result.plans) {
          const group = new THREE.Group(); group.rotation.y = result.site.rotation;
          for (const b of p.buildings) group.add(createRoof(b, roofSpec(b, style), materials));
          const actual = p.buildings.length ? new THREE.Box3().setFromObject(group).max.y : 0;
          assert.equal(Math.round(actual * 10) / 10, p.metrics.height);
        }
      }
    }
  });
}
