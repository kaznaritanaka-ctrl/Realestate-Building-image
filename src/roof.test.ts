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

test("陸屋根：パラペットは縁の立ち上がりで、隣の棟に接する辺は作らない", () => {
  const b: Box = { u0: 0, u1: 10, v0: 0, v1: 8, floors: 3, floorHeight: 3, roof: "flat", kind: "apartment" };
  const spec = roofSpec(b, "white");
  const full = createRoof(b, spec, materials);
  const rimFull = (full.children[0] as THREE.Mesh).geometry.attributes.position.count;
  const open = createRoof(b, spec, materials, (face) => face !== 1); // 右の辺は隣の棟
  const rimOpen = (open.children[0] as THREE.Mesh).geometry.attributes.position.count;
  assert.ok(rimOpen < rimFull, "接している辺の立ち上がりが減る");
  // 屋根全体を覆う箱ではない：立ち上がりの中央（屋上の真ん中）に形がない
  const rim = new THREE.Box3().setFromObject(full.children[0]);
  assert.ok(rim.max.x - rim.min.x >= 10 - 1e-6);
  const pos = (full.children[0] as THREE.Mesh).geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) assert.ok(Math.abs(pos.getX(i)) > 5 - 0.16 - 1e-6 || Math.abs(pos.getZ(i)) > 4 - 0.16 - 1e-6, "立ち上がりは縁だけ");
});

test("切妻：妻壁は壁の位置に壁の材料で立ち、瓦の列は棟の方向（u）にそろう", () => {
  const wall = new THREE.MeshBasicMaterial();
  const b: Box = { u0: 0, u1: 10, v0: 0, v1: 6, floors: 2, floorHeight: 3, roof: "gable", kind: "house" };
  const spec = roofSpec(b, "white");
  const g = createRoof(b, spec, { ...materials, wall });
  const walls = g.children.filter(o => (o as THREE.Mesh).material === wall);
  assert.equal(walls.length, 2);
  for (const w of walls) { const bb = new THREE.Box3().setFromObject(w); near(Math.abs(bb.max.x), 5); near(bb.max.z - bb.min.z, 6); }
  const roof = g.children[0] as THREE.Mesh, geo = roof.geometry, uv = geo.attributes.uv, pos = geo.attributes.position;
  const side = geo.groups.find(gr => gr.materialIndex === 1)!;
  // 棟の方向（回転後の x）に沿って u が実寸で増える
  let checked = 0;
  for (let i = side.start; i < side.start + side.count; i++) { near(uv.getX(i), pos.getX(i)); checked++; }
  assert.ok(checked > 0);
});
