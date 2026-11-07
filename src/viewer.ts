// 3Dビューア：エンジンの結果（u,v座標）を three.js で白模型として表示
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EngineResult, Plan, Box } from "../engine/engine.ts";
import { PlateauContext, FootprintContext, type ContextOptions, type FootprintBuilding } from "./context.ts";
import { linearDepthMaterial, normalMaterial } from "./passes.ts";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// 自作の車モデル（前＝-Z、上＝+Y、原点＝地面の中央）。結果画面に入ったときに一度だけ読み込む
const CAR_FILES = ["car_liftback_v2", "car_minivan_v1", "car_kei_v1"];
let carModels: THREE.Object3D[] | null = null;
let carLoading: Promise<void> | null = null;
function loadCars(): Promise<void> {
  if (carLoading) return carLoading;
  const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/assets/draco/"));
  carLoading = Promise.all(CAR_FILES.map(f => loader.loadAsync(`/assets/models/${f}.glb`).then(g => {
    g.scene.traverse(o => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      m.castShadow = true; m.receiveShadow = true;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) mat.userData.env = true;
      applyEnv(m.material);
    });
    return g.scene;
  }))).then(list => { carModels = list; }).catch(() => { carModels = []; /* 読み込めなければ箱の車のまま */ });
  return carLoading;
}

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private planGroup = new THREE.Group();
  private extGroup = new THREE.Group(); // 外構（塀・植栽）。敷地の座標のまま置く
  private siteGroup = new THREE.Group();
  private ro: ResizeObserver;
  private raf = 0;
  private context: PlateauContext | null = null;
  private footprints: FootprintContext | null = null;
  private contextKey = "";
  private sitePoly: [number, number][] = [];
  private roadsUV: [number, number][][] = [];
  // 描くのは変化があったときだけ（止まっている間は描き直さない）。影も形が変わったときだけ計算する
  private dirty = true;
  private busyUntil = 0;
  private aoPending = false;
  /** 次のフレームで描き直す。ms を渡すとその間は描き続ける（読み込み中・慣性の回転など） */
  requestRender(ms = 0, shadows = false) {
    this.dirty = true;
    if (ms) this.busyUntil = Math.max(this.busyUntil, performance.now() + ms);
    if (shadows) this.renderer.shadowMap.needsUpdate = true;
  }

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    const coarse = matchMedia("(pointer: coarse)").matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    texListeners.add(() => this.requestRender(0, true)); // 質感の画像が届いたら描き直す
    // 影の縁をやわらかく。色は映画と同じ ACES で整える（明るいところが白く飛びにくい）
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    el.appendChild(this.renderer.domElement);
    this.scene.background = skyGradient();
    // 空の写真（Poly Haven の CC0 HDRI）を環境光と映り込みに使う。届くまでは今の明かりだけで描く
    new HDRLoader().setDataType(THREE.FloatType).load("/assets/tex/sky_suburban_garden.hdr", (hdr) => {
      // 環境光：空の明るさの分布を最初に1回だけ9個の数（球面調和関数）にまとめる。毎フレームの計算がほぼ要らない
      this.scene.add(new THREE.LightProbe(skySH(hdr), ENV_INTENSITY));
      // 空の映り込みは、窓ガラスと車だけ（全部の材質に掛けると描くのが重い）
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      skyEnv = pmrem.fromEquirectangular(hdr).texture; pmrem.dispose();
      this.scene.traverse(o => applyEnv((o as THREE.Mesh).material));
      this.requestRender(0, true);
    });
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false; // 手を止めたらすぐ止まる（慣性なし）
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc2ccd0, HEMI));
    const sun = new THREE.DirectionalLight(0xfff4e6, SUN); // 少し暖かい日差し
    sun.position.set(-40, 60, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.far = 300;
    sun.shadow.radius = 3; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    this.scene.add(sun, this.siteGroup, this.planGroup, this.extGroup);
    // パソコン（マウス操作）だけ、隅や接地面に柔らかい陰（GTAO）を足す。スマホは重いので使わない
    if (!coarse && !/[?&]noao\b/.test(location.search)) {
      const c = new EffectComposer(this.renderer);
      c.addPass(new RenderPass(this.scene, this.camera));
      const ao = new GTAOPass(this.scene, this.camera, 600, 400);
      ao.updateGtaoMaterial({ radius: 2, distanceExponent: 1, thickness: 2, scale: 1, samples: 16 });
      ao.blendIntensity = 0.85;
      c.addPass(ao);
      c.addPass(new OutputPass());
      this.composer = c;
    }
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    this.controls.addEventListener("start", () => { this.anim = null; this.requestRender(60000); });
    // 指を離したあとも、慣性の間とPLATEAUの読み込みのために少しだけ描き続ける
    this.controls.addEventListener("end", () => { this.busyUntil = performance.now() + (this.context ? 2000 : 300); });
    const lastPos = new THREE.Vector3(), lastTarget = new THREE.Vector3();
    let lastMove = 0, lastFull = 0;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.anim) {
        const t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.ms);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ゆっくり動き出して、ゆっくり止まる
        this.camera.position.lerpVectors(this.anim.fromPos, this.anim.toPos, k);
        this.controls.target.lerpVectors(this.anim.fromTarget, this.anim.toTarget, k);
        if (t >= 1) this.anim = null;
        this.dirty = true;
      }
      this.controls.update();
      // 慣性の動きが目に見えないほど小さくなったら「止まった」とみなす
      const dist = this.camera.position.distanceTo(this.controls.target) || 1;
      const moved = this.camera.position.distanceTo(lastPos) + this.controls.target.distanceTo(lastTarget) > dist * 2e-4;
      const now = performance.now();
      if (moved) { lastPos.copy(this.camera.position); lastTarget.copy(this.controls.target); lastMove = now; }
      const busy = now < this.busyUntil;
      if (!(moved || this.dirty || busy || this.aoPending)) return;
      this.dirty = false;
      this.context?.update(this.renderer);
      // 動かしている間は隅の陰影（GTAO）を省いて軽く描き、止まったら陰影つきで描き直す。
      // 周辺建物の読み込み中など、止まったまま描き続けるときは陰影つきを0.4秒おきにする
      const moving = moved || !!this.anim || now - lastMove < 120;
      const full = !this.composer || (!moving && (!busy || now - lastFull > 400));
      if (full) { this.draw(); lastFull = now; this.aoPending = false; }
      else { this.renderer.render(this.scene, this.camera); this.aoPending = true; }
      this.onBearing(this.bearing());
    };
    loop();
  }

  private composer: EffectComposer | null = null;
  private draw() { if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera); }

  private resize() {
    const w = this.el.clientWidth || 600, h = this.el.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender?.(0, true);
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
    this.requestRender(20000, true); // 読み込みが終わるまで描き続ける
    this.context.onStatus = (st) => {
      if (st === "ready" || st === "error") { this.busyUntil = performance.now() + 800; this.requestRender(0, true); }
      else this.requestRender(20000, true);
      onStatus?.(st);
    };
  }

  /** PLATEAUがない地域：国土地理院の建物外形を押し出して表示 */
  setFootprints(buildings: FootprintBuilding[], origin: [number, number], frame: { a: [number, number]; ux: [number, number]; vx: [number, number] }, site: [number, number][]) {
    const key = JSON.stringify(["fp", buildings.length, origin, frame, site]);
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.context?.dispose(this.scene); this.context = null;
    this.footprints?.dispose(this.scene); this.footprints = null;
    this.footprints = new FootprintContext(buildings, origin, frame, site, this.scene);
    this.requestRender(0, true);
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
    r.shadowMap.needsUpdate = true;
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
    const fog = this.scene.fog; this.scene.fog = null;
    const tm = r.toneMapping; r.toneMapping = THREE.NoToneMapping; // 深度・法線・マスクは値そのものを書き出す
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
    r.toneMapping = tm; this.scene.fog = fog;
    this.scene.background = saved.bg;
    const camera = { position: cam.position.toArray(), target: target.toArray(), fov: cam.fov, near: cam.near, far: cam.far, width: w, height: h };
    cam.position.copy(saved.pos); cam.aspect = saved.aspect; cam.near = saved.near; cam.far = saved.far; cam.updateProjectionMatrix();
    this.controls.target.copy(saved.target);
    r.setPixelRatio(saved.pr); r.setSize(saved.size.x, saved.size.y, false);
    this.requestRender(0, true);
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
    this.requestRender(0, true);
    void loadCars(); // 駐車場の車を先に読み込んでおく
    clear(this.siteGroup);
    const P = res.site.polygonUV;
    this.sitePoly = P as [number, number][];
    const us = P.map(p => p[0]), vs = P.map(p => p[1]);
    const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
    const span = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs), 10);

    // 遠くを空気でかすませる（地面の端や遠くの建物が空になじむ）
    this.scene.fog = new THREE.Fog(0xe9eff2, span * 4 + 40, span * 16 + 260);
    this.roadsUV = res.site.roadsUV as [number, number][][];
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(span * 8, 1200), Math.max(span * 8, 1200)), new THREE.MeshStandardMaterial({ color: 0xe9edee }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cu, -0.02, -cv); ground.receiveShadow = true;
    this.siteGroup.add(ground);

    for (const road of res.site.roadsUV) {
      const m = new THREE.Mesh(shapeGeom(road), texMat("ground_asphalt", 0xffffff, 0.5, THREE.FrontSide, 5));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.0; m.receiveShadow = true;
      this.siteGroup.add(m);
    }
    const site = new THREE.Mesh(shapeGeom(P), texMat("ground_grass", 0xc8e6a8, 0.6, THREE.FrontSide, 1.1));
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
    // 視点ボタン用：敷地の中心、方位（北・東）、道路のある向き（敷地の中心→道路の中心）
    this.viewBase.center.set(cu, 0, -cv); this.viewBase.span = span;
    const { ux, vx } = res.site.frame; // 局所平面（x＝東, y＝北）→ (u,v)。画面の座標は (u, 0, -v)
    this.viewBase.north.set(ux[1], 0, -vx[1]).normalize();
    this.viewBase.east.set(ux[0], 0, -vx[0]).normalize();
    const roads = res.site.roadsUV.flat();
    if (roads.length) {
      const ru = roads.reduce((a, p) => a + p[0], 0) / roads.length, rv = roads.reduce((a, p) => a + p[1], 0) / roads.length;
      this.viewBase.road.set(ru, 0, -rv);
      this.viewBase.front.set(ru - cu, 0, -rv + cv).normalize();
    } else { this.viewBase.road.set(cu, 0, -cv + span * 0.6); this.viewBase.front.set(0, 0, 1); }
  }

  private anim: { t0: number; ms: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  private viewBase = { center: new THREE.Vector3(), road: new THREE.Vector3(), front: new THREE.Vector3(0, 0, 1), north: new THREE.Vector3(0, 0, -1), east: new THREE.Vector3(1, 0, 0), span: 10 };
  /** 描くたびに、カメラが向いている方位（北から時計回りのラジアン）を知らせる */
  onBearing: (rad: number) => void = () => {};
  /** 道路のある方位（北から時計回りのラジアン）。道路がなければ null */
  roadBearing(): number | null {
    const { front: f, north: n, east: e } = this.viewBase;
    return Math.atan2(f.dot(e), f.dot(n));
  }
  private bearing(): number {
    const look = this.controls.target.clone().sub(this.camera.position).setY(0);
    const { north: n, east: e } = this.viewBase;
    return Math.atan2(look.dot(e), look.dot(n));
  }
  /**
   * 決まった視点へ動かす。side：その方角に立って建物を見る（n/e/s/w）、road＝道路側から
   * height：bird＝鳥瞰、eye＝人の目線（地面から1.6m）
   */
  setView(side: ViewSide, height: "bird" | "eye") {
    const { road, front: f, north, east, span } = this.viewBase;
    const box = new THREE.Box3().setFromObject(this.planGroup);
    const ht = box.isEmpty() ? 3 : Math.max(box.max.y, 3);
    const bc = box.isEmpty() ? this.viewBase.center.clone() : box.getCenter(new THREE.Vector3()).setY(0);
    const d = span * 1.15 + ht * 1.6 + 8;
    const deg = SIDE_DEG[side as Exclude<ViewSide, "road">];
    const v = side === "road" ? f.clone()
      : north.clone().multiplyScalar(Math.cos((deg * Math.PI) / 180)).addScaledVector(east, Math.sin((deg * Math.PI) / 180)).normalize();
    // 道路側から見るときは、道路の先まで下がって全体を入れる
    const back = side === "road" ? Math.max(bc.distanceTo(road) + 4, d * 0.8) : d * 0.85;
    const pos = height === "eye" ? bc.clone().addScaledVector(v, back).setY(1.6) : bc.clone().addScaledVector(v, back * 0.82).setY(d * 0.8);
    const target = bc.clone().setY(height === "eye" ? ht * 0.45 : 1.5);
    this.anim = { t0: performance.now(), ms: 450, fromPos: this.camera.position.clone(), toPos: pos, fromTarget: this.controls.target.clone(), toTarget: target };
    this.requestRender(600);
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
    this.requestRender(0, true);
    clear(this.planGroup);
    this.planGroup.rotation.y = rotation; // (s,t) 系を (u,v) 系へ
    const pal = PALETTES[this.style];
    for (const b of plan.buildings) this.planGroup.add(building(b, pal));
    plan.stalls.forEach((s, i) => {
      this.planGroup.add(stallLines(s));
      // 月極駐車場は半分ほど、ほかは全区画に車を置く
      if (plan.use !== "other" || i % 2 === 0) this.planGroup.add(carModels?.length ? modelCar(s, carModels[i % carModels.length]) : car(s, CAR_COLORS[i % CAR_COLORS.length]));
    });
    clear(this.extGroup);
    this.extGroup.add(exterior(this.sitePoly, this.roadsUV, this.planGroup));
    // 車のモデルがまだなら読み込んで、届いたら置き直す
    if (plan.stalls.length && !carModels) loadCars().then(() => { if (this.lastPlan?.plan === plan && carModels?.length) this.setPlan(plan, rotation); });
  }

  /**
   * 保存用の静止画を描く。
   * pers：建築パース風（目の高さ1.6mから水平に見る2点透視。縦の線がまっすぐ立つ）。
   *       カメラを傾けずに画面をずらして（レンズシフト）、地平線を下から3割の高さに置く
   * view：今の画面と同じ視点
   */
  renderStill(kind: "pers" | "view", w = 1800, h = 1200): HTMLCanvasElement {
    const r = this.renderer, cam = this.camera;
    const saved = { pos: cam.position.clone(), aspect: cam.aspect, fov: cam.fov, target: this.controls.target.clone(), size: r.getSize(new THREE.Vector2()), pr: r.getPixelRatio() };
    r.setPixelRatio(1); r.setSize(w, h, false);
    this.composer?.setPixelRatio(1); this.composer?.setSize(w, h);
    if (kind === "pers") {
      const box = new THREE.Box3().setFromObject(this.planGroup);
      if (box.isEmpty()) box.setFromObject(this.siteGroup);
      const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
      const ht = Math.max(box.max.y, 3), EYE = 1.6, HORIZON = 0.3;
      // 今見ている方角のまま、水平に見る
      const dir = this.controls.target.clone().sub(cam.position).setY(0);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      const S = 2 * Math.tan(THREE.MathUtils.degToRad(20)); // 画面の縦の広さ（画角40°相当）
      const halfW = (w / 2) * S / h;
      const rh = Math.hypot(sz.x, sz.z) / 2;
      const up = 1 - HORIZON;
      const dist = Math.max(rh / (halfW * 0.72) + rh * 0.5, (ht * 1.1 - EYE) / (up * S * 0.92), 10);
      cam.position.copy(c).setY(EYE).addScaledVector(dir, -dist);
      cam.lookAt(c.clone().setY(EYE));
      // 地平線を中心にした仮の大きな画面の、上側だけを切り取る
      const virtH = h * (2 * up); // 仮の画面の高さ（地平線から上が up×S、下も同じだけある）
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(up * S));
      cam.aspect = w / virtH;
      cam.setViewOffset(w, virtH, 0, 0, w, h);
    } else {
      cam.aspect = w / h; cam.updateProjectionMatrix();
    }
    this.context?.update(r);
    r.shadowMap.needsUpdate = true; this.draw();
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d")!.drawImage(r.domElement, 0, 0, w, h);
    // 元に戻す
    cam.clearViewOffset(); cam.fov = saved.fov; cam.aspect = saved.aspect;
    cam.position.copy(saved.pos); cam.lookAt(saved.target); cam.updateProjectionMatrix();
    this.controls.target.copy(saved.target);
    r.setPixelRatio(saved.pr); r.setSize(saved.size.x, saved.size.y, false);
    this.composer?.setPixelRatio(saved.pr); this.composer?.setSize(saved.size.x, saved.size.y);
    r.domElement.style.width = "100%"; r.domElement.style.height = "100%";
    this.requestRender(0, true);
    return out;
  }

  snapshot(type = "image/png", quality?: number): string {
    this.controls.update(); this.renderer.shadowMap.needsUpdate = true; this.draw();
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

// ---- 質感（Poly Haven の CC0 素材を 512px に縮小したもの。site/assets/tex/）----
type TexKey = "wall_siding_v" | "wall_plaster" | "wall_metal" | "wall_wood" | "roof_kawara" | "ground_asphalt" | "ground_grass" | "ground_concrete";
const TILE_M: Record<TexKey, number> = { wall_siding_v: 2.2, wall_plaster: 2.5, wall_metal: 2.0, wall_wood: 1.6, roof_kawara: 2.4, ground_asphalt: 4, ground_grass: 3, ground_concrete: 3 };
const texCache = new Map<string, THREE.Texture>();
const texListeners = new Set<() => void>();
const texLoader = new THREE.TextureLoader();
/** UV はメートル単位で作るので、テクスチャは「1/タイルの大きさ」で繰り返す */
function tex(key: TexKey, kind: "diff" | "nor"): THREE.Texture {
  const id = `${key}_${kind}`;
  let t = texCache.get(id);
  if (!t) {
    t = texLoader.load(`/assets/tex/${id}.jpg`, () => texListeners.forEach(f => f()));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / TILE_M[key], 1 / TILE_M[key]);
    t.anisotropy = 4;
    if (kind === "diff") t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(id, t);
  }
  return t;
}
const matCache = new Map<string, THREE.MeshStandardMaterial>();
/** 質感つきの材質（色は質感に掛け合わせる色味）。光の当たり方を物理に近く計算する（PBR）。外壁や地面はつやを抑える */
function texMat(key: TexKey, color: number, normalScale = 0.8, side: THREE.Side = THREE.FrontSide, gain = 1): THREE.MeshStandardMaterial {
  const id = `${key}|${color}|${side}|${gain}`;
  let m = matCache.get(id);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: tex(key, "diff"), normalMap: tex(key, "nor"), normalScale: new THREE.Vector2(normalScale, normalScale), side, roughness: key === "wall_metal" ? 0.55 : 0.92, metalness: 0 });
    // 質感の画像は暗めなので、色味に明るさの倍率を掛けて持ち上げる（1を超えてよい）
    m.color.setHex(color).multiplyScalar(gain);
    matCache.set(id, m);
  }
  return m;
}
/** BoxGeometry の UV を、各面の実寸（m）にする */
function meterUVBox(w: number, h: number, d: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x,-x,+y,-y,+z,-z
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0], uv.getY(k) * dims[f][1]);
  }
  uv.needsUpdate = true;
  return g;
}

export type ExteriorStyle = "wa" | "white" | "black";
export type ViewSide = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw" | "road";
// 背景の空：上が淡い青、地平線に向かって白っぽく（画面に固定した縦グラデーション）
function skyGradient(): THREE.Texture {
  const c = document.createElement("canvas"); c.width = 2; c.height = 256;
  const g = c.getContext("2d")!, gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#b9d3e6"); gr.addColorStop(0.55, "#e4eef4"); gr.addColorStop(1, "#f4f6f6");
  g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// 空の映り込み（窓ガラス・車だけに使う）
let skyEnv: THREE.Texture | null = null;
function applyEnv(mat: THREE.Material | THREE.Material[] | undefined) {
  for (const m of (Array.isArray(mat) ? mat : mat ? [mat] : []) as THREE.MeshStandardMaterial[]) {
    if (m.userData?.env && skyEnv && m.envMap !== skyEnv) { m.envMap = skyEnv; m.needsUpdate = true; }
  }
}
function reflective<T extends THREE.MeshStandardMaterial>(m: T): T { m.userData.env = true; applyEnv(m); return m; }
/** 正距円筒の HDR 画像から、放射輝度の球面調和関数（3次）を求める */
function skySH(hdr: THREE.DataTexture): THREE.SphericalHarmonics3 {
  const { data, width: W, height: H } = hdr.image as { data: Float32Array; width: number; height: number };
  const sh = new THREE.SphericalHarmonics3(), basis = new Array<number>(9).fill(0);
  const dir = new THREE.Vector3(), c = new THREE.Color();
  let total = 0;
  for (let y = 0; y < H; y += 2) {
    const th = ((y + 0.5) / H) * Math.PI, st = Math.sin(th);
    for (let x = 0; x < W; x += 2) {
      const ph = ((x + 0.5) / W) * Math.PI * 2;
      dir.set(-st * Math.cos(ph), Math.cos(th), st * Math.sin(ph));
      THREE.SphericalHarmonics3.getBasisAt(dir, basis);
      const i = (y * W + x) * 4;
      c.setRGB(data[i], data[i + 1], data[i + 2]);
      for (let k = 0; k < 9; k++) sh.coefficients[k].x += c.r * basis[k] * st, sh.coefficients[k].y += c.g * basis[k] * st, sh.coefficients[k].z += c.b * basis[k] * st;
      total += st;
    }
  }
  const norm = (4 * Math.PI) / total;
  for (const v of sh.coefficients) v.multiplyScalar(norm);
  return sh;
}
// 明るさの調整値（ACES と空の環境光を前提にした値）
const EXPOSURE = 1.05, ENV_INTENSITY = 0.8, HEMI = 0.45, SUN = 3.4;
/** 北から時計回りの角度 */
const SIDE_DEG = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 } as const;
interface Palette { gain: number; roofGain: number; wall: number; apartment: number; store: number; edge: number; roof: number; parapet: number; win: number; frame: number; accent: number; band: boolean; hip: boolean;
  wallTex: TexKey; aptTex: TexKey; storeTex: TexKey; roofTex: TexKey; tint: number; roofTint: number; accentTex: TexKey; accentTint: number }
// 外観の色と形。和風＝寄棟のいぶし瓦・塗り壁・腰板と庇、ホワイト＝白い壁とグレーの切妻、ブラック＝黒い外壁と木の差し色
const PALETTES: Record<ExteriorStyle, Palette> = {
  // 和風：塗り壁＋いぶし色の瓦＋檜の腰板
  wa:    { gain: 1.5, roofGain: 1.15, wall: 0xe9dfc9, apartment: 0xe6dcc6, store: 0xe4d8c0, edge: 0x6b5a48, roof: 0x4b5157, parapet: 0x585e63, win: 0x5f7280, frame: 0x4a3426, accent: 0x5a3f2b, band: true, hip: true,
    wallTex: "wall_plaster", aptTex: "wall_plaster", storeTex: "wall_plaster", roofTex: "roof_kawara", tint: 0xfff3dc, roofTint: 0x8e959c, accentTex: "wall_wood", accentTint: 0x8a6448 },
  // ホワイト：明るいサイディング＋グレーの屋根
  white: { gain: 1.85, roofGain: 1.4, wall: 0xf8f7f3, apartment: 0xf3f3ef, store: 0xeef3f5, edge: 0x9aa3a0, roof: 0x5f6468, parapet: 0xe3e5e0, win: 0x9fbcd0, frame: 0x8d9497, accent: 0xa77c55, band: false, hip: false,
    wallTex: "wall_siding_v", aptTex: "wall_siding_v", storeTex: "wall_plaster", roofTex: "roof_kawara", tint: 0xffffff, roofTint: 0xc8ccd0, accentTex: "wall_wood", accentTint: 0xd9b48c },
  // ブラック：金属の縦波板（ガルバ風）＋黒い屋根＋木の差し色
  black: { gain: 1.0, roofGain: 1.0, wall: 0x2f3336, apartment: 0x34383b, store: 0x303437, edge: 0x5b6266, roof: 0x222528, parapet: 0x3a3f43, win: 0x8fa9ba, frame: 0x1c1f21, accent: 0xb3875a, band: false, hip: false,
    wallTex: "wall_metal", aptTex: "wall_metal", storeTex: "wall_metal", roofTex: "roof_kawara", tint: 0x8a9096, roofTint: 0x5a5f64, accentTex: "wall_wood", accentTint: 0xe0b98e },
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
  // 区画の下はコンクリート舗装
  const padGeo = new THREE.PlaneGeometry(wid, len);
  const uv = padGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * wid, uv.getY(i) * len);
  const pad = new THREE.Mesh(padGeo, texMat("ground_concrete", 0xffffff, 0.5, THREE.FrontSide, 1.25));
  pad.rotation.x = -Math.PI / 2; pad.position.set(s.u0 + wid / 2, 0.02, -(s.v0 + len / 2)); pad.receiveShadow = true; g.add(pad);
  strip(s.u0 + W / 2, -(s.v0 + len / 2), W, len);
  strip(s.u1 - W / 2, -(s.v0 + len / 2), W, len);
  strip(s.u0 + wid / 2, -(s.v1 - W / 2), wid, W);
  return g;
}

// 車のモデルを区画の中央に置く（前を区画の奥に向けて頭から駐車）
function modelCar(s: { u0: number; v0: number; u1: number; v1: number }, model: THREE.Object3D): THREE.Object3D {
  const c = model.clone(true);
  c.position.set((s.u0 + s.u1) / 2, 0, -(s.v0 + s.v1) / 2);
  return c;
}

// 普通自動車（全長4.4m・全幅1.7m）：車体・客室・窓・タイヤ。車のモデルが読み込めないときの代わり
function car(s: { u0: number; v0: number; u1: number; v1: number }, color: number): THREE.Group {
  const g = new THREE.Group();
  const paint = reflective(new THREE.MeshStandardMaterial({ color, roughness: 0.35 }));
  const glass = reflective(new THREE.MeshStandardMaterial({ color: 0x334048, roughness: 0.1 }));
  const tire = new THREE.MeshStandardMaterial({ color: 0x1b1b1b });
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

// ---- 外構：道路以外の境界にブロック塀、空いているところに木と低木 ----
function inPoly(P: [number, number][], u: number, v: number): boolean {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ui, vi] = P[i], [uj, vj] = P[j];
    if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) c = !c;
  }
  return c;
}
function exterior(P: [number, number][], roads: [number, number][][], plan: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  if (P.length < 3) return g;
  // 建物・駐車区画・車のある場所（真上から見た範囲）。ここには何も置かない
  plan.updateMatrixWorld(true);
  const taken = plan.children.map(c => new THREE.Box3().setFromObject(c)).filter(b => !b.isEmpty());
  const free = (u: number, v: number, r: number) => inPoly(P, u, v) && !taken.some(b => u > b.min.x - r && u < b.max.x + r && -v > b.min.z - r && -v < b.max.z + r);
  let area2 = 0; for (let i = 0; i < P.length; i++) { const [a, b2] = P[i], [c, d] = P[(i + 1) % P.length]; area2 += a * d - c * b2; }
  const inward = area2 > 0 ? 1 : -1; // 左回りなら辺の左側が内側
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const wallGeo: THREE.BufferGeometry[] = [], spots: [number, number][] = [], corners: [number, number][] = [];
  for (let i = 0; i < P.length; i++) {
    const [u0, v0] = P[i], [u1, v1] = P[(i + 1) % P.length];
    const L = Math.hypot(u1 - u0, v1 - v0); if (L < 0.5) continue;
    const tu = (u1 - u0) / L, tv = (v1 - v0) / L, nu = -tv * inward, nv = tu * inward; // nu,nv：内向き
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    const isRoad = roads.some(R => inPoly(R, mu - nu * 1, mv - nv * 1));
    if (!isRoad) {
      // ブロック塀（高さ0.8m・厚さ12cm）を境界の少し内側に
      const geo = meterUVBox(L, 0.8, 0.12);
      geo.rotateY(Math.atan2(tv, tu)).translate(mu + nu * 0.08, 0.4, -(mv + nv * 0.08));
      wallGeo.push(geo);
    }
    // 低木の候補：塀ぎわに2.5mおき（道路ぎわには置かない）
    if (!isRoad) for (let t = 1.2; t < L - 1; t += 2.5) spots.push([u0 + tu * t + nu * 0.7, v0 + tv * t + nv * 0.7]);
    // 木の候補：道路に面していない角（建物を隠さないよう、木は角だけ・少なめ）
    const prevRoad = roads.some(R => { const [pu, pv] = P[(i + P.length - 1) % P.length]; const q = [(pu + u0) / 2, (pv + v0) / 2]; const a = Math.hypot(u0 - pu, v0 - pv) || 1; return inPoly(R, q[0] - (-(v0 - pv) / a * inward), q[1] - ((u0 - pu) / a * inward)); });
    if (!isRoad && !prevRoad) {
      const [pu, pv] = P[(i + P.length - 1) % P.length], a = Math.hypot(u0 - pu, v0 - pv) || 1;
      const qu = (pu - u0) / a, qv = (pv - v0) / a; // 角から前の辺の向き
      corners.push([u0 + (tu + qu) * 1.4, v0 + (tv + qv) * 1.4]);
    }
  }
  if (wallGeo.length) {
    const wall = new THREE.Mesh(mergeGeometries(wallGeo.map(x => x.toNonIndexed())), texMat("ground_concrete", 0xdad8d2, 0.6, THREE.FrontSide, 1.45));
    wall.castShadow = true; wall.receiveShadow = true; g.add(wall);
  }
  // 木：幹と、色の違う葉の固まり2〜3個（低いポリゴンで軽く）
  const trunk: THREE.BufferGeometry[] = [], leaves: THREE.BufferGeometry[] = [], shrubs: THREE.BufferGeometry[] = [];
  const greens = [0x5f8f4a, 0x6f9c52, 0x4f7f43, 0x7aa35a].map(c => new THREE.Color(c));
  const tint = (geo: THREE.BufferGeometry, c: THREE.Color) => {
    const n = geo.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const k = 0.9 + rnd() * 0.2; a[i * 3] = c.r * k; a[i * 3 + 1] = c.g * k; a[i * 3 + 2] = c.b * k; }
    geo.setAttribute("color", new THREE.BufferAttribute(a, 3)); return geo;
  };
  let trees = 0, bushes = 0;
  for (const [u, v] of corners) {
    if (trees >= 3 || !free(u, v, 1.0)) continue;
    const H = 2.6 + rnd() * 1.2, x = u, z = -v;
    trunk.push(new THREE.CylinderGeometry(0.07, 0.11, H * 0.55, 6).translate(x, H * 0.275, z).toNonIndexed());
    const k = 2 + Math.floor(rnd() * 2);
    for (let j = 0; j < k; j++) {
      const r = 0.55 + rnd() * 0.4;
      leaves.push(tint(new THREE.IcosahedronGeometry(r, 1).translate(x + (rnd() - 0.5) * 0.7, H * 0.62 + j * 0.45 + rnd() * 0.2, z + (rnd() - 0.5) * 0.7), greens[Math.floor(rnd() * 4)]));
    }
    trees++;
  }
  for (const [u, v] of spots) {
    if (bushes >= 28 || !free(u, v, 0.4)) continue;
    const r = 0.3 + rnd() * 0.2;
    shrubs.push(tint(new THREE.IcosahedronGeometry(r, 1).scale(1.4, 0.8, 1.4).translate(u, r * 0.7, -v), greens[Math.floor(rnd() * 4)]));
    bushes++;
  }
  const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  if (trunk.length) { const m = new THREE.Mesh(mergeGeometries(trunk), new THREE.MeshStandardMaterial({ color: 0x6b5442, roughness: 0.9 })); m.castShadow = true; g.add(m); }
  for (const list of [leaves, shrubs]) if (list.length) { const m = new THREE.Mesh(mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x)), leafMat); m.castShadow = true; m.receiveShadow = true; g.add(m); }
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
  // UV：屋根面の傾きを考えて、上から見た座標を斜面の長さに伸ばす（m単位）
  const k = Math.hypot(rise, hs) / Math.max(hs, 1e-6);
  const uvs: number[] = []; for (let i = 0; i < pos.length; i += 3) uvs.push(pos[i], pos[i + 2] * k);
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function building(b: Box, pal: Palette): THREE.Group {
  const g = new THREE.Group();
  const w = b.u1 - b.u0, d = b.v1 - b.v0, h = b.floors * b.floorHeight, fh = b.floorHeight;
  const y0 = (b.baseFloor ?? 0) * fh;
  const cx = (b.u0 + b.u1) / 2, cz = -(b.v0 + b.v1) / 2;
  const onGround = y0 === 0;
  const wallTex = b.kind === "house" ? pal.wallTex : b.kind === "apartment" ? pal.aptTex : pal.storeTex;
  const body = new THREE.Mesh(meterUVBox(w, h, d), texMat(wallTex, pal.tint, 0.8, THREE.FrontSide, pal.gain));
  body.position.set(cx, y0 + h / 2, cz); body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: pal.edge }));
  edges.position.copy(body.position); g.add(edges);
  const accent = texMat(pal.accentTex, pal.accentTint, 0.6, THREE.FrontSide, 1.1);
  const trimMat = new THREE.MeshStandardMaterial({ color: pal.parapet, roughness: 0.7 });
  const frameMat = new THREE.MeshStandardMaterial({ color: pal.frame, roughness: 0.5, metalness: 0.2 });
  const winMat = reflective(new THREE.MeshStandardMaterial({ color: pal.win, roughness: 0.08, metalness: 0.1, envMapIntensity: 1.4 })); // ガラスは空を映す
  // 細かい部品は材質ごとに1つの形にまとめて描く（部品が多くても重くならないように）
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const put = (mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0) => {
    if (rotY) geo.rotateY(rotY);
    geo.translate(x, y, z);
    (parts.get(mat) ?? parts.set(mat, []).get(mat)!).push(geo);
  };
  const box = (lx: number, ly: number, lz: number) => new THREE.BoxGeometry(lx, ly, lz);

  // 基礎：地面から0.45mのコンクリート（外壁より少し外へ出す）
  const baseH = onGround && b.kind !== "store" ? 0.45 : 0;
  if (baseH) put(texMat("ground_concrete", 0xd9d7d2, 0.4, THREE.FrontSide, 1.15), meterUVBox(w + 0.06, baseH, d + 0.06), cx, baseH / 2, cz);
  // 和風：1階の腰板と、各階の上の庇
  if (pal.band && onGround && b.kind !== "store") put(accent, meterUVBox(w + 0.04, 0.55, d + 0.04), cx, baseH + 0.275, cz);
  for (let f = 1; f < b.floors; f++) {
    const y = y0 + f * fh;
    if (pal.band) put(new THREE.MeshStandardMaterial({ color: pal.roof }), box(w + 1.0, 0.12, d + 1.0), cx, y, cz);
    else put(trimMat, box(w + 0.06, 0.14, d + 0.06), cx, y, cz); // 幕板（階の境目の帯）
  }

  // 窓：枠（少し出っ張る）・ガラス（壁より奥）・水切り。face は外向きの向き（0=正面 +z, 1=右 +x, 2=裏 -z, 3=左 -x）
  const faceRot = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const faceAt = (face: number, t: number): [number, number] => // t：その面の左端からの距離
    face === 0 ? [b.u0 + t, -b.v0] : face === 1 ? [b.u1, -(b.v0 + t)] : face === 2 ? [b.u1 - t, -b.v1] : [b.u0, -(b.v1 - t)];
  const addWin = (face: number, t: number, y: number, ww: number, wh: number) => {
    const [x, z] = faceAt(face, t), r = faceRot[face], F = 0.06, D = 0.07;
    const at = (lx: number, ly: number, lz: number, mat: THREE.Material, geo: THREE.BufferGeometry) => {
      const c = Math.cos(r), sn = Math.sin(r); // 面の向きに回して、外へ lz だけ出す
      put(mat, geo, x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c, r);
    };
    at(0, 0, 0.012, winMat, new THREE.PlaneGeometry(ww, wh));
    at(0, wh / 2 + F / 2, D / 2, frameMat, box(ww + 2 * F, F, D));
    at(0, -wh / 2 - F / 2, D / 2, frameMat, box(ww + 2 * F, F, D));
    at(-ww / 2 - F / 2, 0, D / 2, frameMat, box(F, wh, D));
    at(ww / 2 + F / 2, 0, D / 2, frameMat, box(F, wh, D));
    at(0, -wh / 2 - F - 0.025, 0.06, frameMat, box(ww + 0.24, 0.04, 0.12)); // 水切り
  };
  const store = b.kind === "store";
  for (let f = 0; f < b.floors; f++) {
    const fy = y0 + f * fh;
    const wh = store ? fh * 0.7 : fh * 0.42;
    const yc = fy + (store ? wh / 2 + 0.2 : fh * 0.58);
    for (let face = 0; face < 4; face++) {
      const len = face % 2 === 0 ? w : d;
      const pitch = store && face === 0 ? 3 : face === 0 ? 2.4 : face === 2 ? 3.2 : 3.4; // 正面は多め、裏と横は少なめ
      const n = Math.max(1, Math.floor(len / pitch));
      for (let i = 0; i < n; i++) {
        // 戸建ての1階の正面左端は玄関ドアにする
        if (b.kind === "house" && f === 0 && onGround && face === 0 && i === 0 && n > 1) continue;
        // 集合住宅の裏は共用廊下なので、窓は小さめ
        const ww = (len / n) * (store && face === 0 ? 0.8 : face === 0 ? 0.45 : 0.36);
        const hh = b.kind === "apartment" && face === 2 && f > 0 ? wh * 0.55 : wh;
        addWin(face, (i + 0.5) * (len / n), b.kind === "apartment" && face === 2 && f > 0 ? fy + fh * 0.72 : yc, ww, hh);
      }
    }
  }
  if (b.kind === "house" && onGround) {
    const nU = Math.max(1, Math.floor(w / 2.4));
    const dx = nU > 1 ? b.u0 + 0.5 * (w / nU) : b.u0 + 0.9;
    put(accent, new THREE.PlaneGeometry(0.95, 2.05), dx, baseH + 1.03, -b.v0 + 0.04);
    put(frameMat, box(1.4, 0.1, 0.9), dx, baseH + 2.35, -b.v0 + 0.45); // 玄関の小さな庇
    put(texMat("ground_concrete", 0xcfcdc8, 0.4, THREE.FrontSide, 1.1), box(1.6, baseH, 1.0), dx, baseH / 2, -b.v0 + 0.5); // 玄関ポーチ
  }
  // バルコニー：戸建ては2階正面の一部、集合住宅は2階以上の正面いっぱい。裏は共用廊下の手すり
  // 手すりは半透明のパネル＋細い笠木（重たい箱に見えないように）
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.55 });
  const balcony = (y: number, x0: number, x1: number, depth: number) => {
    const bw = x1 - x0, mx = (x0 + x1) / 2, z = -b.v0 + depth / 2, zf = -b.v0 + depth - 0.03;
    put(trimMat, box(bw, 0.18, depth), mx, y + 0.09, z);
    put(panelMat, box(bw - 0.1, 0.8, 0.02), mx, y + 0.6, zf);
    put(panelMat, box(0.02, 0.8, depth - 0.1), x0 + 0.03, y + 0.6, z);
    put(panelMat, box(0.02, 0.8, depth - 0.1), x1 - 0.03, y + 0.6, z);
    put(frameMat, box(bw, 0.05, 0.06), mx, y + 1.03, zf);
    put(frameMat, box(0.06, 0.05, depth), x0 + 0.03, y + 1.03, z);
    put(frameMat, box(0.06, 0.05, depth), x1 - 0.03, y + 1.03, z);
    for (const px of [x0 + 0.03, x1 - 0.03]) put(frameMat, box(0.05, 0.85, 0.05), px, y + 0.6, zf);
  };
  if (b.kind === "house" && b.floors >= 2 && w >= 4) {
    const bw = Math.min(w * 0.55, 4.5);
    balcony(y0 + fh, b.u1 - bw - 0.3, b.u1 - 0.3, 0.9);
  }
  if (b.kind === "apartment") {
    for (let f = onGround ? 1 : 0; f < b.floors; f++) {
      const y = y0 + f * fh;
      balcony(y, b.u0 + 0.2, b.u1 - 0.2, 1.0);
      put(new THREE.MeshStandardMaterial({ color: 0x3a4044, roughness: 0.9 }), new THREE.PlaneGeometry(w - 0.4, fh - 1.25), cx, y + 1.1 + (fh - 1.25) / 2, -b.v1 - 0.012, Math.PI); // 廊下の奥の影
      put(trimMat, box(w - 0.2, 1.1, 0.12), cx, y + 0.55, -b.v1 - 0.06);
    }
  }

  // 屋根：軒の出・雨どい（軒先の横どいと、角の縦どい）
  const gutterMat = new THREE.MeshStandardMaterial({ color: pal.hip ? 0x4a4f52 : pal.frame === 0x1c1f21 ? 0x2a2d2f : 0xe8e8e4, roughness: 0.5 });
  if (b.roof === "gable") {
    const along = w >= d; // 棟は長辺方向
    const L = along ? w : d, S = along ? d : w;
    const eave = pal.hip ? 0.75 : 0.5;
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
    const rg = new THREE.Group();
    rg.position.set(cx, y0 + h, cz);
    if (!along) rg.rotation.y = Math.PI / 2;
    const roof = new THREE.Mesh(geo, texMat(pal.roofTex, pal.roofTint, 1.0, THREE.DoubleSide, pal.roofGain));
    roof.castShadow = true; rg.add(roof);
    // 屋根の厚み（鼻隠し）
    const fascia = new THREE.Mesh(box(L + eave * 2, 0.16, S + eave * 2), gutterMat); fascia.position.y = -0.08; rg.add(fascia);
    const gutters: THREE.BufferGeometry[] = [];
    for (const sz of [-1, 1]) gutters.push(new THREE.CylinderGeometry(0.07, 0.07, L + eave * 2, 8).rotateZ(Math.PI / 2).translate(0, -0.1, sz * (S / 2 + eave + 0.05)));
    if (pal.hip) for (const sx of [-1, 1]) gutters.push(new THREE.CylinderGeometry(0.07, 0.07, S + eave * 2, 8).rotateX(Math.PI / 2).translate(sx * (L / 2 + eave + 0.05), -0.1, 0));
    // 縦どい：軒先から壁の角へおりる
    const dh = y0 + h - 0.15;
    for (const [sx, sz] of [[-1, 1], [1, -1]]) {
      gutters.push(new THREE.CylinderGeometry(0.045, 0.045, dh, 8).translate(sx * (L / 2 - 0.15), -dh / 2 - 0.1, sz * (S / 2 + 0.08)));
      gutters.push(box(0.09, 0.09, eave).translate(sx * (L / 2 - 0.15), -0.12, sz * (S / 2 + eave / 2 + 0.05)));
    }
    const gm = new THREE.Mesh(mergeGeometries(gutters), gutterMat); gm.castShadow = true; rg.add(gm);
    g.add(rg);
  } else {
    put(trimMat, box(w, 0.5, d), cx, y0 + h + 0.25, cz); // パラペット
    put(pal.band ? new THREE.MeshStandardMaterial({ color: pal.roof }) : frameMat, box(w + 0.2, 0.08, d + 0.2), cx, y0 + h + 0.54, cz); // 笠木
  }
  for (const [mat, list] of parts) {
    const m = new THREE.Mesh(mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x)), mat);
    m.castShadow = true; m.receiveShadow = true; g.add(m);
  }
  return g;
}
