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
    this.scene.background = new THREE.Color(0xeef1ec);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2b5, 1.6));
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

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.MeshLambertMaterial({ color: 0xe4e8df }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cu, -0.02, -cv); ground.receiveShadow = true;
    this.siteGroup.add(ground);

    for (const road of res.site.roadsUV) {
      const m = new THREE.Mesh(shapeGeom(road), new THREE.MeshLambertMaterial({ color: 0xc3c6c0 }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.0; m.receiveShadow = true;
      this.siteGroup.add(m);
    }
    const site = new THREE.Mesh(shapeGeom(P), new THREE.MeshLambertMaterial({ color: 0xdbe6d3 }));
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

  setPlan(plan: Plan, rotation = 0) {
    clear(this.planGroup);
    this.planGroup.rotation.y = rotation; // (s,t) 系を (u,v) 系へ
    for (const b of plan.buildings) this.planGroup.add(building(b));
    const stallMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    for (const s of plan.stalls) {
      const pts = [[s.u0, s.v0], [s.u1, s.v0], [s.u1, s.v1], [s.u0, s.v1], [s.u0, s.v0]].map(([u, v]) => new THREE.Vector3(u, 0.04, -v));
      this.planGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), stallMat));
      const car = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.4, 4.2), new THREE.MeshLambertMaterial({ color: 0x9aa7ad }));
      car.position.set((s.u0 + s.u1) / 2, 0.7, -(s.v0 + s.v1) / 2);
      car.castShadow = true;
      if (plan.use !== "other" || plan.stalls.indexOf(s) % 2 === 0) this.planGroup.add(car);
    }
  }

  snapshot(): string { return this.renderer.domElement.toDataURL("image/png"); }
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

const WALL = { house: 0xf7f5ef, apartment: 0xf2f2ee, store: 0xd6e6ec } as const;

function building(b: Box): THREE.Group {
  const g = new THREE.Group();
  const w = b.u1 - b.u0, d = b.v1 - b.v0, h = b.floors * b.floorHeight;
  const y0 = (b.baseFloor ?? 0) * b.floorHeight;
  const cx = (b.u0 + b.u1) / 2, cz = -(b.v0 + b.v1) / 2;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: WALL[b.kind] }));
  body.position.set(cx, y0 + h / 2, cz); body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0x7c8a86 }));
  edges.position.copy(body.position); g.add(edges);
  // 階の区切り線
  const lineMat = new THREE.LineBasicMaterial({ color: 0xb4bcb8 });
  for (let f = 1; f < b.floors; f++) {
    const y = y0 + f * b.floorHeight;
    const pts = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1], [b.u0, b.v0]].map(([u, v]) => new THREE.Vector3(u, y, -v));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  }
  // 窓（正面と側面）
  const winMat = new THREE.MeshLambertMaterial({ color: b.kind === "store" ? 0x9fc3d6 : 0xa9c4d6 });
  for (let f = 0; f < b.floors; f++) {
    const fy = y0 + f * b.floorHeight;
    const wh = b.kind === "store" ? b.floorHeight * 0.7 : b.floorHeight * 0.42;
    const yc = fy + (b.kind === "store" ? wh / 2 + 0.2 : b.floorHeight * 0.55);
    const nU = Math.max(1, Math.floor(w / (b.kind === "store" ? 3 : 2.4)));
    for (let i = 0; i < nU; i++) {
      const ww = (w / nU) * (b.kind === "store" ? 0.8 : 0.45);
      const u = b.u0 + (i + 0.5) * (w / nU);
      const win = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), winMat);
      win.position.set(u, yc, -b.v0 + 0.02); // 正面（道路側）
      g.add(win);
    }
    const nV = Math.max(1, Math.floor(d / 3));
    for (let i = 0; i < nV; i++) {
      const v = b.v0 + (i + 0.5) * (d / nV);
      const win = new THREE.Mesh(new THREE.PlaneGeometry((d / nV) * 0.4, wh), winMat);
      win.rotation.y = Math.PI / 2; win.position.set(b.u1 + 0.02, yc, -v);
      g.add(win);
    }
  }
  if (b.roof === "gable") {
    const rise = Math.min(w, d) * 0.28;
    const along = w >= d; // 棟は長辺方向
    const L = along ? w : d, S = along ? d : w;
    const shape = new THREE.Shape([new THREE.Vector2(-S / 2 - 0.3, 0), new THREE.Vector2(S / 2 + 0.3, 0), new THREE.Vector2(0, rise)]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: L + 0.6, bevelEnabled: false });
    geo.translate(0, 0, -(L + 0.6) / 2);
    const roof = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x8b6f5c }));
    roof.position.set(cx, y0 + h, cz);
    if (along) roof.rotation.y = Math.PI / 2;
    roof.castShadow = true;
    g.add(roof);
  } else {
    const para = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), new THREE.MeshLambertMaterial({ color: 0xe3e5e0 }));
    para.position.set(cx, y0 + h + 0.25, cz); para.castShadow = true;
    g.add(para);
  }
  return g;
}
