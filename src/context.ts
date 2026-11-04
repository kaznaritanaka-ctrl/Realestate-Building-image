// 周辺建物（PLATEAU 3D Tiles）を、エンジンの (u,v) 座標系に重ねて表示する
import * as THREE from "three";
import { TilesRenderer, WGS84_ELLIPSOID } from "3d-tiles-renderer";
import type { Vec2 } from "../engine/geom.ts";

export interface ContextOptions {
  tilesetUrl: string;
  origin: Vec2;                 // 局所平面の原点（経度, 緯度）
  frame: { a: Vec2; ux: Vec2; vx: Vec2 };
  sitePolygonUV: Vec2[];        // 敷地（この内側の既存建物は表示しない）
}

const MAX_POLY = 32;

export class PlateauContext {
  readonly tiles: TilesRenderer;
  private ground = 0;
  private groundFixed = false;
  private base = new THREE.Matrix4();
  private material: THREE.MeshLambertMaterial;
  private center: THREE.Vector2;
  onStatus: (s: "loading" | "ready" | "error") => void = () => {};

  constructor(private opts: ContextOptions, private camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, parent: THREE.Object3D) {
    this.tiles = new TilesRenderer(opts.tilesetUrl);
    this.tiles.errorTarget = 12;
    this.tiles.setCamera(camera);
    this.tiles.setResolutionFromRenderer(camera, renderer);

    // ECEF → ENU（原点）→ (u, 高さ, -v)
    const [lng, lat] = opts.origin;
    const enu = new THREE.Matrix4();
    WGS84_ELLIPSOID.getEastNorthUpFrame(lat * THREE.MathUtils.DEG2RAD, lng * THREE.MathUtils.DEG2RAD, 0, enu);
    const { a, ux, vx } = opts.frame;
    const toView = new THREE.Matrix4().set(
      ux[0], ux[1], 0, -(a[0] * ux[0] + a[1] * ux[1]),
      0, 0, 1, 0,
      -vx[0], -vx[1], 0, a[0] * vx[0] + a[1] * vx[1],
      0, 0, 0, 1,
    );
    this.base.multiplyMatrices(toView, enu.invert());
    this.tiles.group.matrixAutoUpdate = false;
    this.applyMatrix();

    // 敷地の重心（地面の高さ推定に使う）
    const P = opts.sitePolygonUV;
    this.center = new THREE.Vector2(P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length);

    // 既存建物は白模型（グレー）。敷地の内側にかかる部分はシェーダーで描かない
    const poly = Array.from({ length: MAX_POLY }, (_, i) => new THREE.Vector2(...(P[i] ?? [0, 0])));
    this.material = new THREE.MeshLambertMaterial({ color: 0xd9dcd6 });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uPoly = { value: poly };
      shader.uniforms.uN = { value: Math.min(P.length, MAX_POLY) };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
varying vec3 vWorldPos;
uniform vec2 uPoly[${MAX_POLY}];
uniform int uN;
bool insideSite(vec2 p) {
  bool c = false;
  for (int i = 0; i < ${MAX_POLY}; i++) {
    if (i >= uN) break;
    int jj = (i == 0) ? uN - 1 : i - 1;
    vec2 a = uPoly[i]; vec2 b = uPoly[jj];
    if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) c = !c;
  }
  return c;
}`)
        .replace("void main() {", "void main() {\n  if (insideSite(vec2(vWorldPos.x, -vWorldPos.z))) discard;");
    };

    this.tiles.addEventListener("load-model", ((e: { scene: THREE.Object3D }) => {
      e.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.material = this.material; m.castShadow = true; m.receiveShadow = true; }
      });
      if (!this.groundFixed) this.estimateGround(e.scene);
    }) as never);
    this.tiles.addEventListener("tiles-load-start", () => this.onStatus("loading"));
    this.tiles.addEventListener("tiles-load-end", () => this.onStatus("ready"));
    this.tiles.addEventListener("load-error", () => this.onStatus("error"));
    parent.add(this.tiles.group);
  }

  private applyMatrix() {
    const m = new THREE.Matrix4().makeTranslation(0, -this.ground, 0).multiply(this.base);
    this.tiles.group.matrix.copy(m);
    this.tiles.group.matrixWorldNeedsUpdate = true;
  }

  /** 敷地から半径60m以内の頂点の高さの下位10%を地面とみなし、敷地の地面を高さ0にそろえる */
  private estimateGround(scene: THREE.Object3D) {
    this.tiles.group.updateMatrixWorld(true);
    const ys: number[] = [];
    const v = new THREE.Vector3();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = (m.geometry as THREE.BufferGeometry).getAttribute("position");
      if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        if (Math.hypot(v.x - this.center.x, -v.z - this.center.y) < 60) ys.push(v.y + this.ground);
      }
    });
    if (ys.length < 30) return; // まだ近くのタイルが来ていない
    ys.sort((a, b) => a - b);
    this.ground = ys[Math.floor(ys.length * 0.1)];
    this.groundFixed = true;
    this.applyMatrix();
  }

  update(renderer: THREE.WebGLRenderer) {
    this.camera.updateMatrixWorld();
    this.tiles.setResolutionFromRenderer(this.camera, renderer);
    this.tiles.update();
  }

  dispose(parent: THREE.Object3D) {
    parent.remove(this.tiles.group);
    this.tiles.dispose();
    this.material.dispose();
  }
}
