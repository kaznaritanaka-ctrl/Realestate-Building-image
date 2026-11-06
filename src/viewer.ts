// 3Dビューア：エンジンの結果（u,v座標）を three.js で白模型として表示
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EngineResult, Plan, Box } from "../engine/engine.ts";
import { PlateauContext, FootprintContext, type ContextOptions, type FootprintBuilding } from "./context.ts";
import { linearDepthMaterial, normalMaterial } from "./passes.ts";

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private planGroup = new THREE.Group();
  private siteGroup = new THREE.Group();
  private ro: ResizeObserver;
  private raf = 0;
  private context: PlateauContext | null = null;
  private footprints: FootprintContext | null = null;
  private contextKey = "";
  private sitePoly: [number, number][] = [];

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0xf3f5f6);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc2ccd0, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-40, 60, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.far = 300;
    this.scene.add(sun, this.siteGroup, this.planGroup);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    const loop = () => { this.controls.update(); this.context?.update(this.renderer); this.renderer.render(this.scene, this.camera); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  private resize() {
    const w = this.el.clientWidth || 600, h = this.el.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 周辺建物（PLATEAU）を表示。同じ条件なら作り直さない */
  setContext(opts: ContextOptions | null, onStatus?: (s: "loading" | "ready" | "error") => void) {
    const key = opts ? JSON.stringify([opts.tilesetUrl, opts.origin, opts.frame, opts.sitePolygonUV]) : "";
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.context?.dispose(this.scene); this.context = null;
    this.footprints?.dispose(this.scene); this.footprints = null;
    if (!opts) return;
    this.context = new PlateauContext(opts, this.camera, this.renderer, this.scene);
    if (onStatus) this.context.onStatus = onStatus;
  }

  /** PLATEAUがない地域：国土地理院の建物外形を押し出して表示 */
  setFootprints(buildings: FootprintBuilding[], origin: [number, number], frame: { a: [number, number]; ux: [number, number]; vx: [number, number] }, site: [number, number][]) {
    const key = JSON.stringify(["fp", buildings.length, origin, frame, site]);
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.context?.dispose(this.scene); this.context = null;
    this.footprints?.dispose(this.scene); this.footprints = null;
    this.footprints = new FootprintContext(buildings, origin, frame, site, this.scene);
  }

  /** 視点を決めて、白模型・深度・法線・マスクを描画する（ControlNet用の制御画像の素材） */
  renderPasses(view: "front" | "aerial", w = 1024, h = 768): { base: HTMLCanvasElement; depth: HTMLCanvasElement; normal: HTMLCanvasElement; mask: HTMLCanvasElement; camera: { position: number[]; target: number[]; fov: number; near: number; far: number; width: number; height: number } } {
    const r = this.renderer, cam = this.camera;
    const saved = { pos: cam.position.clone(), aspect: cam.aspect, near: cam.near, far: cam.far, target: this.controls.target.clone(), size: r.getSize(new THREE.Vector2()), pr: r.getPixelRatio(), bg: this.scene.background };
    // 計画建物の範囲から視点を決める
    const box = new THREE.Box3().setFromObject(this.planGroup);
    if (box.isEmpty()) box.setFromObject(this.siteGroup.children[2] ?? this.siteGroup);
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const span = Math.max(sz.x, sz.z, 8), ht = Math.max(sz.y, 3);
    const d = span * 1.45 + ht;
    if (view === "front") cam.position.set(c.x + d * 0.45, Math.max(1.6, ht * 0.55), c.z + d * 0.95);   // 道路側から人の目線に近い高さ
    else cam.position.set(c.x + d * 0.6, d * 0.85, c.z + d * 0.75);                                   // 斜め上から
    const target = new THREE.Vector3(c.x, ht * 0.4, c.z);
    cam.lookAt(target);
    cam.aspect = w / h; cam.near = 0.5; cam.far = d * 4; cam.updateProjectionMatrix();
    r.setPixelRatio(1); r.setSize(w, h, false);
    const grab = () => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d")!.drawImage(r.domElement, 0, 0, w, h); return cv; };

    // 1) 白模型（影・周辺建物つき）
    this.context?.update(r);
    r.render(this.scene, cam);
    const base = grab();
    // 2) 深度（近いほど白）・3) 法線：シーン全体に上書きマテリアル
    const dist = cam.position.distanceTo(target);
    const near = Math.max(0.5, dist - span * 1.2), far = dist + span * 2.5;
    const P = this.sitePoly;
    const mats = { depth: [linearDepthMaterial(P, near, far, false), linearDepthMaterial(P, near, far, true)], normal: [normalMaterial(P, false), normalMaterial(P, true)] };
    const ctxGroups = [this.context?.tiles.group, this.footprints?.group].filter(Boolean) as THREE.Object3D[];
    const isCtx = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (ctxGroups.includes(p)) return true; return false; };
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const hideLines: THREE.Object3D[] = [];
    this.scene.traverse(o => {
      if ((o as THREE.Line).isLine && o.visible) { hideLines.push(o); o.visible = false; }
      if ((o as THREE.Mesh).isMesh) swapped.push([o as THREE.Mesh, (o as THREE.Mesh).material]);
    });
    const apply = (kind: "depth" | "normal") => swapped.forEach(([m]) => { m.material = mats[kind][isCtx(m) ? 1 : 0]; });
    this.scene.background = new THREE.Color(0x000000);
    apply("depth"); r.render(this.scene, cam); const depth = grab();
    this.scene.background = new THREE.Color(0x8080ff);
    apply("normal"); r.render(this.scene, cam); const normal = grab();
    swapped.forEach(([m, mat]) => { m.material = mat; });
    [...mats.depth, ...mats.normal].forEach(m => m.dispose());
    // 4) マスク：計画建物だけ白、それ以外は黒
    this.scene.overrideMaterial = null;
    const hidden: THREE.Object3D[] = [];
    for (const ch of this.scene.children) if (ch !== this.planGroup && !(ch as THREE.Light).isLight && ch.visible) { hidden.push(ch); ch.visible = false; }
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.scene.background = new THREE.Color(0x000000);
    this.scene.overrideMaterial = white; r.render(this.scene, cam); const mask = grab();
    // 元に戻す
    this.scene.overrideMaterial = null;
    hidden.forEach(o => (o.visible = true)); hideLines.forEach(o => (o.visible = true));
    white.dispose();
    this.scene.background = saved.bg;
    const camera = { position: cam.position.toArray(), target: target.toArray(), fov: cam.fov, near: cam.near, far: cam.far, width: w, height: h };
    cam.position.copy(saved.pos); cam.aspect = saved.aspect; cam.near = saved.near; cam.far = saved.far; cam.updateProjectionMatrix();
    this.controls.target.copy(saved.target);
    r.setPixelRatio(saved.pr); r.setSize(saved.size.x, saved.size.y, false);
    this.renderer.domElement.style.width = "100%"; this.renderer.domElement.style.height = "100%";
    return { base, depth, normal, mask, camera };
  }

  /** 計画建物と敷地を glTF（バイナリ）で書き出す */
  async exportGlb(): Promise<ArrayBuffer> {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const root = new THREE.Group();
    root.add(this.planGroup.clone(true));
    const site = this.siteGroup.children.find(o => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type === "ShapeGeometry");
    if (site) root.add(site.clone());
    return new Promise((resolve, reject) => new GLTFExporter().parse(root, (out) => resolve(out as ArrayBuffer), reject, { binary: true }));
  }

  contextDebug() { return this.context?.debug ?? null; }

  dispose() { this.context?.dispose(this.scene); cancelAnimationFrame(this.raf); this.ro.disconnect(); this.renderer.dispose(); this.el.innerHTML = ""; }

  setSite(res: EngineResult) {
    clear(this.siteGroup);
    const P = res.site.polygonUV;
    this.sitePoly = P as [number, number][];
    const us = P.map(p => p[0]), vs = P.map(p => p[1]);
    const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
    const span = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs), 10);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.MeshLambertMaterial({ color: 0xe9edee }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cu, -0.02, -cv); ground.receiveShadow = true;
    this.siteGroup.add(ground);

    for (const road of res.site.roadsUV) {
      const m = new THREE.Mesh(shapeGeom(road), new THREE.MeshLambertMaterial({ color: 0xc3c6c0 }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.0; m.receiveShadow = true;
      this.siteGroup.add(m);
    }
    const site = new THREE.Mesh(shapeGeom(P), new THREE.MeshLambertMaterial({ color: 0xdcebe3 }));
    site.rotation.x = -Math.PI / 2; site.position.y = 0.01; site.receiveShadow = true;
    this.siteGroup.add(site);
    const pts = P.map(([u, v]) => new THREE.Vector3(u, 0.03, -v));
    pts.push(pts[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x2f6f5e, dashSize: 0.8, gapSize: 0.5 }));
    line.computeLineDistances();
    this.siteGroup.add(line);

    const d = span * 1.6 + 12;
    this.camera.position.set(cu + d * 0.75, d * 0.75, -cv + d * 1.0);
    this.controls.target.set(cu, 2, -cv);
    this.controls.update();
  }

  private style: ExteriorStyle = "white";
  private lastPlan: { plan: Plan; rotation: number } | null = null;
  /** 外観のスタイル（和風・ホワイト・ブラック）を切り替える */
  setStyle(style: ExteriorStyle) {
    this.style = style;
    if (this.lastPlan) this.setPlan(this.lastPlan.plan, this.lastPlan.rotation);
  }

  setPlan(plan: Plan, rotation = 0) {
    this.lastPlan = { plan, rotation };
    clear(this.planGroup);
    this.planGroup.rotation.y = rotation; // (s,t) 系を (u,v) 系へ
    const pal = PALETTES[this.style];
    for (const b of plan.buildings) this.planGroup.add(building(b, pal));
    plan.stalls.forEach((s, i) => {
      this.planGroup.add(stallLines(s));
      // 月極駐車場は半分ほど、ほかは全区画に車を置く
      if (plan.use !== "other" || i % 2 === 0) this.planGroup.add(car(s, CAR_COLORS[i % CAR_COLORS.length]));
    });
  }

  snapshot(type = "image/png", quality?: number): string {
    this.controls.update(); this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL(type, quality);
  }
}

function clear(g: THREE.Group) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); });
  }
}

function shapeGeom(P: [number, number][]) {
  const s = new THREE.Shape(P.map(([u, v]) => new THREE.Vector2(u, v)));
  return new THREE.ShapeGeometry(s);
}

export type ExteriorStyle = "wa" | "white" | "black";
interface Palette { wall: number; apartment: number; store: number; edge: number; roof: number; parapet: number; win: number; frame: number; accent: number; band: boolean; hip: boolean }
// 外観の色と形。和風＝寄棟のいぶし瓦・塗り壁・腰板と庇、ホワイト＝白い壁とグレーの切妻、ブラック＝黒い外壁と木の差し色
const PALETTES: Record<ExteriorStyle, Palette> = {
  wa:    { wall: 0xe9dfc9, apartment: 0xe6dcc6, store: 0xe4d8c0, edge: 0x6b5a48, roof: 0x4b5157, parapet: 0x585e63, win: 0x5f7280, frame: 0x4a3426, accent: 0x5a3f2b, band: true, hip: true },
  white: { wall: 0xf8f7f3, apartment: 0xf3f3ef, store: 0xeef3f5, edge: 0x9aa3a0, roof: 0x5f6468, parapet: 0xe3e5e0, win: 0x9fbcd0, frame: 0x8d9497, accent: 0xa77c55, band: false, hip: false },
  black: { wall: 0x2f3336, apartment: 0x34383b, store: 0x303437, edge: 0x5b6266, roof: 0x222528, parapet: 0x3a3f43, win: 0x8fa9ba, frame: 0x1c1f21, accent: 0xb3875a, band: false, hip: false },
};
const CAR_COLORS = [0xf4f4f2, 0x9ea6ab, 0x2f3a4a, 0x7a2e2e, 0x1f2326];

// 駐車区画：白線（幅12cm）で奥と両側を引く
function stallLines(s: { u0: number; v0: number; u1: number; v1: number }): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const W = 0.12, y = 0.03;
  const strip = (cx: number, cz: number, lx: number, lz: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(lx, lz), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(cx, y, cz); g.add(m);
  };
  const len = s.v1 - s.v0, wid = s.u1 - s.u0;
  strip(s.u0 + W / 2, -(s.v0 + len / 2), W, len);
  strip(s.u1 - W / 2, -(s.v0 + len / 2), W, len);
  strip(s.u0 + wid / 2, -(s.v1 - W / 2), wid, W);
  return g;
}

// 普通自動車（全長4.4m・全幅1.7m）：車体・客室・窓・タイヤ
function car(s: { u0: number; v0: number; u1: number; v1: number }, color: number): THREE.Group {
  const g = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color });
  const glass = new THREE.MeshLambertMaterial({ color: 0x334048 });
  const tire = new THREE.MeshLambertMaterial({ color: 0x1b1b1b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.65, 4.4), paint);
  body.position.y = 0.6; body.castShadow = true; g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 2.3), glass);
  cabin.position.set(0, 1.2, 0.15); cabin.castShadow = true; g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.06, 1.9), paint);
  roof.position.set(0, 1.5, 0.15); g.add(roof);
  const wheel = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16);
  for (const [x, z] of [[-0.78, 1.4], [0.78, 1.4], [-0.78, -1.4], [0.78, -1.4]]) {
    const t = new THREE.Mesh(wheel, tire); t.rotation.z = Math.PI / 2; t.position.set(x, 0.32, z); g.add(t);
  }
  g.position.set((s.u0 + s.u1) / 2, 0, -(s.v0 + s.v1) / 2 - 0.15); // 区画の中央、少し奥寄り
  return g;
}

// 寄棟屋根：底面 L×S（軒の出を含む）、棟の長さ L−S
function hipRoof(L: number, S: number, rise: number): THREE.BufferGeometry {
  const hl = L / 2, hs = S / 2, r = Math.max(0, hl - hs);
  const v = [
    [-hl, 0, -hs], [hl, 0, -hs], [hl, 0, hs], [-hl, 0, hs], // 0-3 底面
    [-r, rise, 0], [r, rise, 0],                             // 4-5 棟
  ];
  const idx = [0, 4, 5, 0, 5, 1, 2, 5, 4, 2, 4, 3, 1, 5, 2, 3, 4, 0];
  const pos: number[] = []; for (const i of idx) pos.push(...v[i]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function building(b: Box, pal: Palette): THREE.Group {
  const g = new THREE.Group();
  const w = b.u1 - b.u0, d = b.v1 - b.v0, h = b.floors * b.floorHeight;
  const y0 = (b.baseFloor ?? 0) * b.floorHeight;
  const cx = (b.u0 + b.u1) / 2, cz = -(b.v0 + b.v1) / 2;
  const wallColor = b.kind === "house" ? pal.wall : b.kind === "apartment" ? pal.apartment : pal.store;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: wallColor }));
  body.position.set(cx, y0 + h / 2, cz); body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: pal.edge }));
  edges.position.copy(body.position); g.add(edges);
  const accent = new THREE.MeshLambertMaterial({ color: pal.accent });
  // 和風：1階の腰板と、各階の上の庇
  if (pal.band && y0 === 0 && b.kind !== "store") {
    const koshi = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.9, d + 0.04), accent);
    koshi.position.set(cx, 0.45, cz); g.add(koshi);
  }
  if (pal.band) {
    for (let f = 1; f < b.floors; f++) {
      const hisashi = new THREE.Mesh(new THREE.BoxGeometry(w + 1.0, 0.12, d + 1.0), new THREE.MeshLambertMaterial({ color: pal.roof }));
      hisashi.position.set(cx, y0 + f * b.floorHeight, cz); hisashi.castShadow = true; g.add(hisashi);
    }
  } else {
    const lineMat = new THREE.LineBasicMaterial({ color: pal.edge });
    for (let f = 1; f < b.floors; f++) {
      const y = y0 + f * b.floorHeight;
      const pts = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1], [b.u0, b.v0]].map(([u, v]) => new THREE.Vector3(u, y, -v));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
  }
  // 窓（正面と側面）：枠の色を付ける
  const winMat = new THREE.MeshLambertMaterial({ color: pal.win });
  const frameMat = new THREE.MeshLambertMaterial({ color: pal.frame });
  const addWin = (x: number, y: number, z: number, ww: number, wh: number, side: boolean) => {
    const fr = new THREE.Mesh(new THREE.PlaneGeometry(ww + 0.16, wh + 0.16), frameMat);
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), winMat);
    for (const [m, off] of [[fr, 0.02], [gl, 0.03]] as const) {
      if (side) { m.rotation.y = Math.PI / 2; m.position.set(x + off, y, z); } else m.position.set(x, y, z + off);
      g.add(m);
    }
  };
  for (let f = 0; f < b.floors; f++) {
    const fy = y0 + f * b.floorHeight;
    const wh = b.kind === "store" ? b.floorHeight * 0.7 : b.floorHeight * 0.42;
    const yc = fy + (b.kind === "store" ? wh / 2 + 0.2 : b.floorHeight * 0.58);
    const nU = Math.max(1, Math.floor(w / (b.kind === "store" ? 3 : 2.4)));
    for (let i = 0; i < nU; i++) {
      // 戸建ての1階の左端は玄関ドアにする
      if (b.kind === "house" && f === 0 && (b.baseFloor ?? 0) === 0 && i === 0 && nU > 1) continue;
      const ww = (w / nU) * (b.kind === "store" ? 0.8 : 0.45);
      addWin(b.u0 + (i + 0.5) * (w / nU), yc, -b.v0, ww, wh, false);
    }
    const nV = Math.max(1, Math.floor(d / 3));
    for (let i = 0; i < nV; i++) addWin(b.u1, yc, -(b.v0 + (i + 0.5) * (d / nV)), (d / nV) * 0.4, wh, true);
  }
  if (b.kind === "house" && (b.baseFloor ?? 0) === 0) {
    const nU = Math.max(1, Math.floor(w / 2.4));
    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 2.05), accent);
    door.position.set(nU > 1 ? b.u0 + 0.5 * (w / nU) : b.u0 + 0.9, 1.03, -b.v0 + 0.04); g.add(door);
  }
  if (b.roof === "gable") {
    const along = w >= d; // 棟は長辺方向
    const L = along ? w : d, S = along ? d : w;
    const eave = pal.hip ? 0.7 : 0.35;
    let geo: THREE.BufferGeometry;
    if (pal.hip) {
      geo = hipRoof(L + eave * 2, S + eave * 2, S * 0.3);
    } else {
      const rise = S * 0.28;
      const shape = new THREE.Shape([new THREE.Vector2(-S / 2 - eave, 0), new THREE.Vector2(S / 2 + eave, 0), new THREE.Vector2(0, rise)]);
      geo = new THREE.ExtrudeGeometry(shape, { depth: L + eave * 2, bevelEnabled: false });
      geo.translate(0, 0, -(L + eave * 2) / 2);
      geo.rotateY(Math.PI / 2); // 棟をX方向に
    }
    const roof = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: pal.roof, side: THREE.DoubleSide }));
    roof.position.set(cx, y0 + h, cz);
    if (!along) roof.rotation.y = Math.PI / 2;
    roof.castShadow = true;
    g.add(roof);
  } else {
    const para = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), new THREE.MeshLambertMaterial({ color: pal.parapet }));
    para.position.set(cx, y0 + h + 0.25, cz); para.castShadow = true;
    g.add(para);
    if (pal.band) { // 和風の陸屋根は笠木を濃く
      const kasagi = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.08, d + 0.2), new THREE.MeshLambertMaterial({ color: pal.roof }));
      kasagi.position.set(cx, y0 + h + 0.54, cz); g.add(kasagi);
    }
  }
  return g;
}
