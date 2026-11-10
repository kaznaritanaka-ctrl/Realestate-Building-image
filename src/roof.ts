// 3D屋根の生成。寸法・最高点はengine/roof.tsだけで決める。
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Box } from "../engine/engine.ts";
import type { RoofSpec } from "../engine/roof.ts";

interface RoofMaterials { surface: THREE.Material; trim: THREE.Material; gutter: THREE.Material; coping: THREE.Material; membrane?: THREE.Material; wall?: THREE.Material; ridge?: THREE.Material }
/** 陸屋根のパラペットを置く辺の判定。face：0=正面(v0側) 1=右(u1側) 2=裏(v1側) 3=左(u0側)、t はその辺を外から見て左端からの距離。
 *  隣の棟が同じ高さ以上で接している辺は false にすると、屋上を横切る二重の立ち上がりができない */
export type ParapetKeep = (face: number, t: number) => boolean;

export function createRoof(b: Box, spec: RoofSpec, materials: RoofMaterials, keep?: ParapetKeep): THREE.Group {
  const g = new THREE.Group();
  g.position.set((b.u0 + b.u1) / 2, spec.baseY, -(b.v0 + b.v1) / 2);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; m.receiveShadow = spec.kind === "flat"; g.add(m);
    return m;
  };
  if (spec.kind === "flat") {
    // パラペットは屋上の縁の立ち上がり（厚さ0.15m）。中は防水面。以前の「屋根全体を覆う箱」だと分厚い板に見えていた
    const w = b.u1 - b.u0, d = b.v1 - b.v0, T = 0.15, O = 0.1, ph = spec.parapetHeight, ct = spec.copingThickness;
    const rim: THREE.BufferGeometry[] = [], cap: THREE.BufferGeometry[] = [];
    for (let face = 0; face < 4; face++) {
      const len = face % 2 === 0 ? w : d;
      // keep が true の区間ごとにまとめる（0.25m 刻みで判定）
      const step = 0.25, n = Math.max(1, Math.ceil(len / step));
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const t = Math.min(len, (i + 0.5) * (len / n));
        const on = i < n && (!keep || keep(face, t));
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          const t0 = (start / n) * len, t1 = (i / n) * len, L = t1 - t0, tm = (t0 + t1) / 2;
          // 辺の内側に立ち上がり、その上に外へ0.1m張り出した笠木
          const at = (geo: THREE.BufferGeometry, inset: number) => {
            if (face === 0) geo.translate(-w / 2 + tm, 0, d / 2 - inset);
            else if (face === 1) geo.rotateY(Math.PI / 2).translate(w / 2 - inset, 0, d / 2 - tm);
            else if (face === 2) geo.translate(w / 2 - tm, 0, -d / 2 + inset);
            else geo.rotateY(Math.PI / 2).translate(-w / 2 + inset, 0, -d / 2 + tm);
            return geo;
          };
          // 角は隣の辺の立ち上がりと重ねる（すき間を作らない）
          const ext = 2 * O;
          rim.push(at(box(L, ph, T).translate(0, ph / 2, 0), T / 2));
          cap.push(at(box(L + ext, ct, T + O).translate(0, ph + ct / 2, 0), (T - O) / 2));
          start = -1;
        }
      }
    }
    if (rim.length) put(mergeGeometries(rim), materials.trim);
    if (cap.length) put(mergeGeometries(cap), materials.coping);
    const mem = new THREE.PlaneGeometry(w, d), uv = mem.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d); // 模様の大きさを実寸に
    put(mem.rotateX(-Math.PI / 2), materials.membrane ?? materials.trim, 0.015); // 防水面
    return g;
  }
  const { length: L, span: S, eave, rise } = spec;
  if (!spec.alongU) g.rotation.y = Math.PI / 2;
  if (spec.kind === "hip") {
    put(hipRoof(L + eave * 2, S + eave * 2, rise), materials.surface);
    put(box(L + eave * 2, 0.16, S + eave * 2), materials.gutter, -0.08); // 軒裏（寄棟は四周に軒がある）
    // 棟瓦：大棟（てっぺん）と四隅へ下りる隅棟に、丸い瓦の列を載せる
    const hl = L / 2 + eave, hs = S / 2 + eave, r = Math.max(0, hl - hs);
    const seg = (a: number[], b2: number[], rad: number) => {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b2), d = B.clone().sub(A), len = d.length();
      const geo = new THREE.CylinderGeometry(rad, rad, len, 8);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
      return geo.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    };
    // 最高点は共通仕様（rise）を超えない：大棟は上面を rise に合わせた平たい帯、隅棟は少し下から始める
    const caps: THREE.BufferGeometry[] = [];
    if (r > 0.05) caps.push(box(2 * r + 0.3, 0.1, 0.42).translate(0, rise - 0.05, 0));
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const t = 0.1, x0 = sx * (r + (hl - r) * t), z0 = sz * hs * t, yy = rise * (1 - t);
      caps.push(seg([x0, yy - 0.03, z0], [sx * hl, -0.03, sz * hs], 0.1));
    }
    put(mergeGeometries(caps), materials.ridge ?? materials.gutter);
  } else {
    // 切妻：厚み0.2mの「へ」の字の屋根板。端面は破風板の色、上面は屋根の質感
    const Se = S / 2 + eave, T = 0.2;
    const band = new THREE.Shape([
      new THREE.Vector2(-Se, 0), new THREE.Vector2(0, rise), new THREE.Vector2(Se, 0),
      new THREE.Vector2(Se, -T), new THREE.Vector2(0, rise - T), new THREE.Vector2(-Se, -T),
    ]);
    const geo = new THREE.ExtrudeGeometry(band, { depth: L + eave * 2, bevelEnabled: false });
    geo.translate(0, 0, -(L + eave * 2) / 2);
    // 上面の UV を寄棟とそろえる：u＝棟の方向（m）、v＝斜面に沿った長さ（m）。
    // 既定の UV だと瓦の列が軒と直角に走り、斜面方向にも約15%伸びていた
    const k = Math.hypot(rise, Se) / Se, pos = geo.attributes.position, uv = geo.attributes.uv as THREE.BufferAttribute;
    const side = geo.groups.find(gr => gr.materialIndex === 1);
    if (side) for (let i = side.start; i < side.start + side.count; i++) {
      const vi = geo.index ? geo.index.getX(i) : i;
      uv.setXY(vi, pos.getZ(vi), Math.abs(pos.getX(vi)) * k);
    }
    uv.needsUpdate = true;
    geo.rotateY(Math.PI / 2); // 棟をX方向に
    // ExtrudeGeometry の材質グループ：0=端面（破風）、1=側面（屋根の上面と軒裏）
    const roofMesh = new THREE.Mesh(geo, [materials.gutter, materials.surface]);
    roofMesh.castShadow = true; g.add(roofMesh);
    // 妻壁：壁の位置に、屋根板の下面まで（以前は屋根の模様の三角が軒先の位置に立っていた）
    const yw = Math.max(0, (rise * eave) / Se - T) + 0.01, apex = rise - T + 0.01;
    for (const sx of [-1, 1]) {
      const tri = new THREE.ShapeGeometry(new THREE.Shape([
        new THREE.Vector2(-S / 2, 0), new THREE.Vector2(S / 2, 0), new THREE.Vector2(S / 2, yw), new THREE.Vector2(0, apex), new THREE.Vector2(-S / 2, yw),
      ]));
      tri.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2).translate(sx * L / 2, 0, 0); // 外向き
      const m = new THREE.Mesh(tri, materials.wall ?? materials.trim); m.castShadow = true; m.receiveShadow = true; g.add(m);
    }
    put(box(L + eave * 2 + 0.04, 0.07, 0.36), materials.ridge ?? materials.gutter, rise - 0.035); // 棟包み（上面が最高点）（てっぺんの押さえ）
    // 軒裏：長い辺に沿った帯だけ
    for (const sz of [-1, 1]) put(box(L + eave * 2, 0.06, eave), materials.gutter, -0.03).position.z = sz * (S / 2 + eave / 2);
  }
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
