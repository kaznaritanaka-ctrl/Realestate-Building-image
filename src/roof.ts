// 3D屋根の生成。寸法・最高点はengine/roof.tsだけで決める。
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Box } from "../engine/engine.ts";
import type { RoofSpec } from "../engine/roof.ts";

interface RoofMaterials { surface: THREE.Material; trim: THREE.Material; gutter: THREE.Material; coping: THREE.Material }

export function createRoof(b: Box, spec: RoofSpec, materials: RoofMaterials): THREE.Group {
  const g = new THREE.Group();
  g.position.set((b.u0 + b.u1) / 2, spec.baseY, -(b.v0 + b.v1) / 2);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; m.receiveShadow = spec.kind === "flat"; g.add(m);
  };
  if (spec.kind === "flat") {
    const w = b.u1 - b.u0, d = b.v1 - b.v0;
    put(box(w, spec.parapetHeight, d), materials.trim, spec.parapetHeight / 2);
    put(box(w + 0.2, spec.copingThickness, d + 0.2), materials.coping, spec.parapetHeight + spec.copingThickness / 2);
    return g;
  }
  const { length: L, span: S, eave, rise } = spec;
  if (!spec.alongU) g.rotation.y = Math.PI / 2;
  let geo: THREE.BufferGeometry;
  if (spec.kind === "hip") {
    geo = hipRoof(L + eave * 2, S + eave * 2, rise);
  } else {
    const shape = new THREE.Shape([new THREE.Vector2(-S / 2 - eave, 0), new THREE.Vector2(S / 2 + eave, 0), new THREE.Vector2(0, rise)]);
    geo = new THREE.ExtrudeGeometry(shape, { depth: L + eave * 2, bevelEnabled: false });
    geo.translate(0, 0, -(L + eave * 2) / 2);
    geo.rotateY(Math.PI / 2);
  }
  put(geo, materials.surface);
  put(box(L + eave * 2, 0.16, S + eave * 2), materials.gutter, -0.08);
  const gutters: THREE.BufferGeometry[] = [];
  for (const sz of [-1, 1]) gutters.push(new THREE.CylinderGeometry(0.07, 0.07, L + eave * 2, 8).rotateZ(Math.PI / 2).translate(0, -0.1, sz * (S / 2 + eave + 0.05)));
  if (spec.kind === "hip") for (const sx of [-1, 1]) gutters.push(new THREE.CylinderGeometry(0.07, 0.07, S + eave * 2, 8).rotateX(Math.PI / 2).translate(sx * (L / 2 + eave + 0.05), -0.1, 0));
  const dh = spec.baseY - 0.15;
  for (const [sx, sz] of [[-1, 1], [1, -1]]) {
    gutters.push(new THREE.CylinderGeometry(0.045, 0.045, dh, 8).translate(sx * (L / 2 - 0.15), -dh / 2 - 0.1, sz * (S / 2 + 0.08)));
    gutters.push(box(0.09, 0.09, eave).translate(sx * (L / 2 - 0.15), -0.12, sz * (S / 2 + eave / 2 + 0.05)));
  }
  put(mergeGeometries(gutters), materials.gutter);
  return g;
}

// 寄棟屋根：底面 L×S（軒の出を含む）、棟の長さ L−S
function hipRoof(L: number, S: number, rise: number): THREE.BufferGeometry {
  const hl = L / 2, hs = S / 2, r = Math.max(0, hl - hs);
  const v = [[-hl, 0, -hs], [hl, 0, -hs], [hl, 0, hs], [-hl, 0, hs], [-r, rise, 0], [r, rise, 0]];
  const idx = [0, 4, 5, 0, 5, 1, 2, 5, 4, 2, 4, 3, 1, 5, 2, 3, 4, 0];
  const pos: number[] = []; for (const i of idx) pos.push(...v[i]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const k = Math.hypot(rise, hs) / Math.max(hs, 1e-6);
  const uvs: number[] = []; for (let i = 0; i < pos.length; i += 3) uvs.push(pos[i], pos[i + 2] * k);
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}
