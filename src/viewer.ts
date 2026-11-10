// 3Dビューア：エンジンの結果（u,v座標）を three.js で白模型として表示
import * as THREE from "three";
import { roofSpec, type ExteriorStyle } from "../engine/roof.ts";
import { createRoof } from "./roof.ts";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { applyExteriorStyle, type EngineResult, type Plan, type Box } from "../engine/engine.ts";
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
    const sun = this.sun = new THREE.DirectionalLight(0xfff4e6, SUN); // 少し暖かい日差し
    sun.position.set(-40, 60, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.far = 300;
    sun.shadow.radius = 3; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target, this.siteGroup, this.planGroup, this.extGroup);
    // パソコン（マウス操作）だけ、隅や接地面に柔らかい陰（GTAO）を足す。スマホは重いので使わない
    if (!coarse && !/[?&]noao\b/.test(location.search)) {
      // 陰影の合成を通すと縁のギザギザ消し（MSAA）が効かなくなるので、合成用の画面にも4倍の MSAA を付ける
      const c = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
      c.addPass(new RenderPass(this.scene, this.camera));
      const ao = new GTAOPass(this.scene, this.camera, 600, 400);
      ao.updateGtaoMaterial({ radius: 2, distanceExponent: 1, thickness: 2, scale: 1, samples: 16 });
      ao.blendIntensity = 0.85;
      c.addPass(ao);
      c.addPass(new OutputPass());
      this.composer = c;
    }
    // 比較・計測用（?debug3d のときだけ）：三角形数・描画回数を読めるようにする
    if (/[?&]debug3d\b/.test(location.search)) (window as unknown as { __viewer: Viewer }).__viewer = this;
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

  private sun!: THREE.DirectionalLight;
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
    const site = new THREE.Mesh(shapeGeom(P), texMat("ground_gravel", 0xe6e9ec, 1.0, THREE.FrontSide, 1.5)); // 敷地は砂利敷き（芝一面は安っぽく見えるため）
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
    // 日差しの向き：実際の方位に合わせる（太陽は東〜南〜西からしか差さない）。
    // その中で、道路側の正面に斜め約40°から当たる向きを選ぶ（真正面からだと立体感がなく、真横だと正面が暗い）
    const { north, east, front } = this.viewBase;
    let best = new THREE.Vector3(), score = -Infinity;
    for (const az of [90, 135, 180, 225, 270]) {
      const r = THREE.MathUtils.degToRad(az), dir = north.clone().multiplyScalar(Math.cos(r)).addScaledVector(east, Math.sin(r));
      const sc2 = -Math.abs(dir.dot(front) - 0.75);
      if (sc2 > score) { score = sc2; best = dir; }
    }
    const R = span * 1.5 + 40;
    this.sun.target.position.set(cu, 0, -cv);
    this.sun.position.set(cu, 0, -cv).addScaledVector(best, R * 0.72).setY(R * 0.78);
    // 影の地図を敷地のまわりだけに絞る（同じ解像度でも影の縁がはっきりする）
    const cam2 = this.sun.shadow.camera as THREE.OrthographicCamera, e = span * 1.1 + 14;
    cam2.left = cam2.bottom = -e; cam2.right = cam2.top = e; cam2.near = 1; cam2.far = R * 3; cam2.updateProjectionMatrix();
    this.sun.shadow.radius = 2.5;
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
    if (this.lastPlan) this.setPlan(applyExteriorStyle(this.lastPlan.plan, style), this.lastPlan.rotation);
  }

  getStyle(): ExteriorStyle { return this.style; }
  /** 計測用：直前の描画の三角形数・描画回数と、建物部分の三角形数 */
  stats() {
    let planTris = 0;
    this.planGroup.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) { const g = m.geometry; planTris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    const r = this.renderer.info.render;
    return { triangles: r.triangles, calls: r.calls, planTris: Math.round(planTris) };
  }

  setPlan(plan: Plan, rotation = 0) {
    plan = applyExteriorStyle(plan, plan.exteriorStyle ?? this.style);
    this.style = plan.exteriorStyle!;
    this.lastPlan = { plan, rotation };
    this.requestRender(0, true);
    clear(this.planGroup);
    this.planGroup.rotation.y = rotation; // (s,t) 系を (u,v) 系へ
    const pal = PALETTES[this.style];
    for (const b of plan.buildings) { const bg = building(b, pal, this.style, plan.buildings); bg.userData.bld = true; this.planGroup.add(bg); }
    // 玄関から道路までのコンクリートの通路（道路に出られる向きのときだけ）
    for (const b of plan.buildings) {
      if ((b.baseFloor ?? 0) !== 0 || b.kind === "store") continue;
      const w = b.u1 - b.u0, nU = Math.max(1, Math.floor(w / 2.4));
      const dx = b.kind === "house" ? (nU > 1 ? b.u0 + 0.5 * (w / nU) : b.u0 + 0.9) : (b.u0 + b.u1) / 2;
      const z0 = -b.v0 + (b.kind === "house" ? 1.0 : 0.2);
      const c = Math.cos(rotation), sn = Math.sin(rotation);
      const wx = (lx: number, lz: number) => [lx * c + lz * sn, -lx * sn + lz * c] as const; // 家の座標 → 世界の座標
      let len = 0, toRoad = false;
      for (let d = 0.25; d < 40; d += 0.25) {
        const [x, z] = wx(dx, z0 + d);
        if (!inPoly(this.sitePoly, x, -z)) { const [x2, z2] = wx(dx, z0 + d + 1); toRoad = this.roadsUV.some(R => inPoly(R, x2, -z2)); len = d; break; }
      }
      if (!toRoad || len < 0.5) continue;
      const path = new THREE.Mesh(meterUVBox(1.2, 0.04, len), texMat("ground_concrete", 0xffffff, 0.5, THREE.FrontSide, 1.25));
      path.position.set(dx, 0.03, z0 + len / 2); path.receiveShadow = true;
      this.planGroup.add(path);
    }
    plan.stalls.forEach((s, i) => {
      this.planGroup.add(stallLines(s));
      // 月極駐車場は半分ほど、ほかは全区画に車を置く
      if (plan.use !== "other" || i % 2 === 0) this.planGroup.add(carModels?.length ? modelCar(s, carModels[i % carModels.length]) : car(s, CAR_COLORS[i % CAR_COLORS.length]));
    });
    clear(this.extGroup);
    this.extGroup.add(exterior(this.sitePoly, this.roadsUV));
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
    const hidden: THREE.Object3D[] = [];
    if (kind === "pers") {
      // 建物を画面の主役にする：建物だけの範囲で距離を決める（駐車場や通路まで入れると建物が小さくなる）
      const box = new THREE.Box3();
      this.planGroup.updateMatrixWorld(true);
      for (const ch of this.planGroup.children) if (ch.userData.bld) box.union(new THREE.Box3().setFromObject(ch));
      if (box.isEmpty()) box.setFromObject(this.planGroup);
      if (box.isEmpty()) box.setFromObject(this.siteGroup);
      const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
      const ht = Math.max(box.max.y, 3), EYE = 1.6, HORIZON = 0.24;
      // 今見ている方角のまま、水平に見る
      const dir = this.controls.target.clone().sub(cam.position).setY(0);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      const S = 2 * Math.tan(THREE.MathUtils.degToRad(20)); // 画面の縦の広さ（画角40°相当）
      const halfW = (w / 2) * S / h;
      const rh = Math.hypot(sz.x, sz.z) / 2;
      const up = 1 - HORIZON;
      // カメラと建物の間に入る塀は、この画像では外す（建物の足元が隠れるため）
      for (const o of this.extGroup.children[0]?.children ?? []) {
        const f = o.userData.fence as { x: number; z: number; ox: number; oz: number } | undefined;
        if (f && f.ox * -dir.x + f.oz * -dir.z > 0.2) { o.visible = false; hidden.push(o); }
      }
      const dist = Math.max(rh / (halfW * 0.6) + rh * 0.6, (ht * 1.12 - EYE) / (up * S * 0.9), 9);
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
    for (const o of hidden) o.visible = true;
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
type TexKey = "wall_siding_v" | "wall_plaster" | "wall_metal" | "wall_wood" | "roof_kawara" | "ground_asphalt" | "ground_grass" | "ground_concrete" | "ground_gravel";
const TILE_M: Record<TexKey, number> = { wall_siding_v: 2.2, wall_plaster: 2.5, wall_metal: 2.0, wall_wood: 1.6, roof_kawara: 2.4, ground_asphalt: 4, ground_grass: 3, ground_concrete: 3, ground_gravel: 1.6 };
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
    // 質感の画像は暗めなので、色味に明るさの倍率を掛けて持ち上げる（1を超えてよい）。
    // コンクリートの画像は平均が約0.45（sRGB）と特に暗く、縦の面では倍率2.4〜3が要る（塀や基礎が黒く見えていた）
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

export type { ExteriorStyle } from "../engine/roof.ts";
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
  // 空の青みをそのまま使うと、日陰の白い壁や塀が青緑に寄る。色味を6割ほど抜いて中立に近づける
  for (const v of sh.coefficients) { v.multiplyScalar(norm); const l = (v.x + v.y + v.z) / 3; v.set(l + (v.x - l) * 0.4, l + (v.y - l) * 0.4, l + (v.z - l) * 0.4); }
  return sh;
}
// 明るさの調整値（ACES と空の環境光を前提にした値）
const EXPOSURE = 1.05, ENV_INTENSITY = 0.8, HEMI = 0.45, SUN = 3.4;
/** 北から時計回りの角度 */
const SIDE_DEG = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 } as const;
interface Palette { gain: number; roofGain: number; wall: number; apartment: number; store: number; edge: number; roof: number; parapet: number; win: number; frame: number; accent: number; band: boolean;
  wallTex: TexKey; aptTex: TexKey; storeTex: TexKey; roofTex: TexKey; tint: number; roofTint: number; accentTex: TexKey; accentTint: number }
// 外観の色と形。和風＝寄棟のいぶし瓦・塗り壁・腰板と庇、ホワイト＝白い壁とグレーの切妻、ブラック＝黒い外壁と木の差し色
const PALETTES: Record<ExteriorStyle, Palette> = {
  // 和風：塗り壁＋いぶし色の瓦＋檜の腰板
  wa:    { gain: 1.5, roofGain: 1.15, wall: 0xe9dfc9, apartment: 0xe6dcc6, store: 0xe4d8c0, edge: 0x6b5a48, roof: 0x4b5157, parapet: 0x585e63, win: 0x3e4c55, frame: 0x4a3426, accent: 0x5a3f2b, band: true,
    wallTex: "wall_plaster", aptTex: "wall_plaster", storeTex: "wall_plaster", roofTex: "roof_kawara", tint: 0xfff3dc, roofTint: 0x8e959c, accentTex: "wall_wood", accentTint: 0x8a6448 },
  // ホワイト：明るいサイディング＋グレーの屋根
  white: { gain: 1.85, roofGain: 1.5, wall: 0xf8f7f3, apartment: 0xf3f3ef, store: 0xeef3f5, edge: 0x9aa3a0, roof: 0x5f6468, parapet: 0xe3e5e0, win: 0x5a7686, frame: 0x8d9497, accent: 0xa77c55, band: false,
    wallTex: "wall_siding_v", aptTex: "wall_siding_v", storeTex: "wall_plaster", roofTex: "wall_metal", tint: 0xf4f7ff, roofTint: 0xb4bcc4, accentTex: "wall_wood", accentTint: 0xd9b48c },
  // ブラック：金属の縦波板（ガルバ風）＋黒い屋根＋木の差し色
  black: { gain: 1.7, roofGain: 1.15, wall: 0x2f3336, apartment: 0x34383b, store: 0x303437, edge: 0x5b6266, roof: 0x222528, parapet: 0x3a3f43, win: 0x4f6573, frame: 0x1c1f21, accent: 0xb3875a, band: false,
    wallTex: "wall_metal", aptTex: "wall_metal", storeTex: "wall_metal", roofTex: "wall_metal", tint: 0x8a9096, roofTint: 0x6a7076, accentTex: "wall_wood", accentTint: 0xe0b98e },
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

// ---- 外構：道路以外の境界にブロック塀 ----
function inPoly(P: [number, number][], u: number, v: number): boolean {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ui, vi] = P[i], [uj, vj] = P[j];
    if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) c = !c;
  }
  return c;
}
// ブロック塀の材質：明るい灰色のブロック（39×19cm）を馬目地に積んだ模様を、その場で描く
let blockMaterial: THREE.MeshStandardMaterial | null = null;
function blockMat(): THREE.MeshStandardMaterial {
  if (blockMaterial) return blockMaterial;
  const c = document.createElement("canvas"); c.width = 256; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c9c9c4"; g.fillRect(0, 0, 256, 128);
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let row = 0; row < 2; row++) for (let col = -1; col < 2; col++) {
    const x = col * 128 + (row ? 64 : 0), k = 196 + Math.floor(rnd() * 14);
    g.fillStyle = `rgb(${k},${k},${k - 4})`; g.fillRect(x + 2, row * 64 + 2, 124, 60);
  }
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},0,${0.02 + rnd() * 0.03})`; g.fillRect(rnd() * 256, rnd() * 128, 2, 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 0.8, 1 / 0.4); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  blockMaterial = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
  blockMaterial.color.setScalar(1.5); // 日陰側が沈みすぎないよう持ち上げる
  return blockMaterial;
}

function exterior(P: [number, number][], roads: [number, number][][]): THREE.Group {
  const g = new THREE.Group();
  if (P.length < 3) return g;
  let area2 = 0; for (let i = 0; i < P.length; i++) { const [a, b2] = P[i], [c, d] = P[(i + 1) % P.length]; area2 += a * d - c * b2; }
  const inward = area2 > 0 ? 1 : -1; // 左回りなら辺の左側が内側

  const curbGeo: THREE.BufferGeometry[] = [], lineGeo: THREE.BufferGeometry[] = [];
  for (let i = 0; i < P.length; i++) {
    const [u0, v0] = P[i], [u1, v1] = P[(i + 1) % P.length];
    const L = Math.hypot(u1 - u0, v1 - v0); if (L < 0.5) continue;
    const tu = (u1 - u0) / L, tv = (v1 - v0) / L, nu = -tv * inward, nv = tu * inward; // nu,nv：内向き
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    const isRoad = roads.some(R => inPoly(R, mu - nu * 1, mv - nv * 1));
    if (isRoad) {
      // 道路との境目：コンクリートの側溝（幅0.5m）と、その外の白線（幅0.15m）
      const rot = Math.atan2(tv, tu);
      const strip = (wid: number, off: number, y: number) => { const q = new THREE.PlaneGeometry(L, wid), uv = q.attributes.uv as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * L, uv.getY(k) * wid);
        return q.rotateX(-Math.PI / 2).rotateY(rot).translate(mu - nu * off, y, -(mv - nv * off)); };
      curbGeo.push(strip(0.5, 0.25, 0.022));
      lineGeo.push(strip(0.15, 0.85, 0.024));
    }
    if (!isRoad) {
      // ブロック塀（高さ0.8m・厚さ12cm）を境界の少し内側に
      const geo = meterUVBox(L, 0.8, 0.12);
      geo.rotateY(Math.atan2(tv, tu)).translate(mu + nu * 0.08, 0.4, -(mv + nv * 0.08));
      const wall = new THREE.Mesh(geo, blockMat());
      wall.castShadow = true; wall.receiveShadow = true;
      wall.userData.fence = { x: mu, z: -mv, ox: -nu, oz: nv }; // 辺の中点と外向き（保存用の画像で手前の塀を外すため）
      g.add(wall);
    }
  }
  if (curbGeo.length) { const m = new THREE.Mesh(mergeGeometries(curbGeo), texMat("ground_concrete", 0xe9e7e2, 0.4, THREE.FrontSide, 2.0)); m.receiveShadow = true; g.add(m); }
  if (lineGeo.length) { const m = new THREE.Mesh(mergeGeometries(lineGeo), new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.9 })); m.receiveShadow = true; g.add(m); }
  return g;
}

function building(b: Box, pal: Palette, style: ExteriorStyle, others: readonly Box[] = []): THREE.Group {
  const g = new THREE.Group();
  const w = b.u1 - b.u0, d = b.v1 - b.v0, h = b.floors * b.floorHeight, fh = b.floorHeight;
  const y0 = (b.baseFloor ?? 0) * fh;
  const cx = (b.u0 + b.u1) / 2, cz = -(b.v0 + b.v1) / 2;
  const onGround = y0 === 0;
  const wallTex = b.kind === "house" ? pal.wallTex : b.kind === "apartment" ? pal.aptTex : pal.storeTex;
  const wallMat = texMat(wallTex, pal.tint, 0.8, THREE.FrontSide, pal.gain), wallMatBase = wallMat;
  const accent = texMat(pal.accentTex, pal.accentTint, 0.6, THREE.FrontSide, 1.1);
  const accentBay = texMat(pal.accentTex, pal.accentTint, 0.6, THREE.FrontSide, 1.25);
  const trimMat = new THREE.MeshStandardMaterial({ color: pal.parapet, roughness: 0.7 });
  const frameMat = new THREE.MeshStandardMaterial({ color: pal.frame, roughness: 0.5, metalness: 0.2 });
  const winMat = reflective(new THREE.MeshStandardMaterial({ color: pal.win, roughness: 0.05, metalness: 0, envMapIntensity: 1.8, transparent: true, opacity: 0.55, depthWrite: false })); // ガラスは空を映す
  const roomMat = new THREE.MeshStandardMaterial({ color: 0x1e2428, roughness: 1 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1cc, emissive: 0xffd88a, emissiveIntensity: 0.9, roughness: 0.6 });
  const curtainMat = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 1 });
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
  if (baseH) put(texMat("ground_concrete", 0xdedcd6, 0.4, THREE.FrontSide, 2.6), meterUVBox(w + 0.06, baseH, d + 0.06), cx, baseH / 2, cz);
  // 和風：1階の腰板と、各階の上の庇
  for (let f = 1; f < b.floors; f++) {
    const y = y0 + f * fh;
    if (pal.band) put(new THREE.MeshStandardMaterial({ color: pal.roof }), box(w + 1.0, 0.12, d + 1.0), cx, y, cz);
    else put(trimMat, box(w + 0.06, 0.14, d + 0.06), cx, y, cz); // 幕板（階の境目の帯）
  }

  // 窓と玄関は壁に本当の開口を開け、奥行き（見込み）の中にサッシ・ガラス・カーテン・室内の暗さを入れる。
  // face は外向きの向き（0=正面 +z, 1=右 +x, 2=裏 -z, 3=左 -x）。t はその面を外から見て左端からの距離
  const faceRot = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const faceAt = (face: number, t: number): [number, number] =>
    face === 0 ? [b.u0 + t, -b.v0] : face === 1 ? [b.u1, -(b.v0 + t)] : face === 2 ? [b.u1 - t, -b.v1] : [b.u0, -(b.v1 - t)];
  const faceLen = (face: number) => (face % 2 === 0 ? w : d);
  // ほかの棟に接している（隠れている）場所か：面の0.1m外側の点が、別の棟の中に入るか。
  // L字・コの字・段状で、隣の棟に埋もれる窓・バルコニー・屋上の立ち上がりを作らないために使う
  const OUT: [number, number][] = [[0, 0.1], [0.1, 0], [0, -0.1], [-0.1, 0]];
  const covered = (face: number, t: number, y: number) => {
    const [x, z] = faceAt(face, t), u = x + OUT[face][0], v = -(z + OUT[face][1]);
    return others.some(o => o !== b && u > o.u0 && u < o.u1 && v > o.v0 && v < o.v1
      && y > (o.baseFloor ?? 0) * o.floorHeight && y < ((o.baseFloor ?? 0) + o.floors) * o.floorHeight);
  };
  /** 面の座標（lx：面に沿って右、ly：上、lz：外向き）で置く */
  const onFace = (face: number, t: number, y: number, lx: number, ly: number, lz: number, mat: THREE.Material, geo: THREE.BufferGeometry) => {
    const [x, z] = faceAt(face, t), r = faceRot[face], c = Math.cos(r), sn = Math.sin(r);
    put(mat, geo, x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c, r);
  };
  const plane = (pw: number, ph: number) => { // UV を実寸（m）にした板
    const geo = new THREE.PlaneGeometry(pw, ph), uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * pw, uv.getY(i) * ph);
    return geo;
  };
  type Opening = { face: number; t: number; yc: number; W: number; H: number; ww: number; wh: number; door?: boolean };
  const openings: Opening[] = [];
  const store = b.kind === "store";
  const F = 0.05;          // サッシの枠の見付け
  const DEPTH = 0.14;      // 壁の見込み（開口の奥行き）
  let doorAt: { t: number; W: number } | null = null;
  if (b.kind === "house" && onGround) {
    const nU = Math.max(1, Math.floor(w / 2.4));
    const t = nU > 1 ? 0.5 * (w / nU) : 0.9;
    doorAt = { t, W: 1.0 };
    openings.push({ face: 0, t, yc: baseH + 1.06, W: 1.0, H: 2.12, ww: 0.92, wh: 2.06, door: true });
  }
  for (let f = 0; f < b.floors; f++) {
    const fy = y0 + f * fh;
    const wh = store ? fh * 0.7 : fh * 0.42;
    const yc = fy + (store ? wh / 2 + 0.2 : fh * 0.58);
    for (let face = 0; face < 4; face++) {
      const len = faceLen(face);
      const pitch = store && face === 0 ? 3 : face === 0 ? 2.4 : face === 2 ? 3.2 : 3.4; // 正面は多め、裏と横は少なめ
      const n = Math.max(1, Math.floor(len / pitch));
      for (let i = 0; i < n; i++) {
        if (doorAt && f === 0 && face === 0 && i === 0 && n > 1) continue; // 1階正面の左端は玄関
        let ww = (len / n) * (store && face === 0 ? 0.8 : face === 0 ? 0.45 : 0.36);
        const back = b.kind === "apartment" && face === 2 && f > 0; // 集合住宅の裏（共用廊下側）は小窓
        let hh = back ? wh * 0.55 : wh, y = back ? fy + fh * 0.72 : yc;
        if (!store && face === 0 && fh >= 2.7) {
          // 正面は床近くまである掃き出し窓（幅も広め）。住宅の南面らしい大きな開口
          hh = 1.95; y = fy + (f === 0 ? Math.max(baseH, 0.3) : 0.3) + hh / 2 + 0.05; ww = Math.min((len / n) * 0.62, 1.9);
        } else if (b.kind === "house" && face % 2 === 1 && i % 2 === 1) {
          // 側面は1つおきに小さな高窓（水まわりや階段の窓）
          ww = 0.6; hh = 0.75; y = fy + fh * 0.66;
        }
        openings.push({ face, t: (i + 0.5) * (len / n), yc: y, W: ww + 2 * F, H: hh + 2 * F, ww, wh: hh });
      }
    }
  }
  for (const o of openings) if ([0, -o.W / 2, o.W / 2].some(dt => covered(o.face, o.t + dt, o.yc))) o.W = 0;
  // 壁：面ごとに穴を開けた板。開口が壁の端や上下にはみ出すものは開けない
  const walls: THREE.BufferGeometry[] = [];
  // ホワイト・ブラックの戸建て：玄関のある列を木目の貼り分けにする（最近の住宅に多い2色使い）
  const nFront = Math.max(1, Math.floor(w / 2.4));
  const accentTo = !pal.band && b.kind === "house" && onGround && doorAt && nFront > 1 ? w / nFront : 0;
  const accentWall: THREE.BufferGeometry[] = [];
  for (let face = 0; face < 4; face++) {
    const len = faceLen(face);
    const cuts = face === 0 && accentTo ? [0, accentTo, len] : [0, len];
    for (const o of openings) {
      if (o.face !== face) continue;
      const x1 = o.t - o.W / 2, x2 = o.t + o.W / 2, yb = o.yc - o.H / 2, yt = o.yc + o.H / 2;
      if (!o.W || x1 < 0.05 || x2 > len - 0.05 || yb < y0 + 0.02 || yt > y0 + h - 0.05 || cuts.some(c => c > x1 - 0.03 && c < x2 + 0.03)) o.W = 0;
    }
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k], z2 = cuts[k + 1];
      const shape = new THREE.Shape([new THREE.Vector2(a, y0), new THREE.Vector2(z2, y0), new THREE.Vector2(z2, y0 + h), new THREE.Vector2(a, y0 + h)]);
      for (const o of openings) {
        if (o.face !== face || !o.W || o.t < a || o.t > z2) continue;
        const x1 = o.t - o.W / 2, x2 = o.t + o.W / 2, yb = o.yc - o.H / 2, yt = o.yc + o.H / 2;
        shape.holes.push(new THREE.Path([new THREE.Vector2(x1, yb), new THREE.Vector2(x1, yt), new THREE.Vector2(x2, yt), new THREE.Vector2(x2, yb)]));
      }
      const geo = new THREE.ShapeGeometry(shape); // UV は形の座標＝実寸（m）
      const [x, z] = faceAt(face, 0);
      geo.rotateY(faceRot[face]); geo.translate(x, 0, z);
      (face === 0 && accentTo && k === 0 ? accentWall : walls).push(geo);
    }
  }
  if (accentWall.length) { const m = new THREE.Mesh(mergeGeometries(accentWall.map(x => x.index ? x.toNonIndexed() : x)), accentBay); m.castShadow = true; m.receiveShadow = true; g.add(m); }
  walls.push(plane(w, d).rotateX(-Math.PI / 2).translate(cx, y0 + h, cz)); // 天面（屋根やパラペットの下）
  const body = new THREE.Mesh(mergeGeometries(walls.map(x => x.index ? x.toNonIndexed() : x)), wallMat);
  body.castShadow = true; body.receiveShadow = true; g.add(body);

  const doorMat = accentTo ? new THREE.MeshStandardMaterial({ color: pal.frame === 0x1c1f21 ? 0x23272a : 0x3b4246, roughness: 0.45, metalness: 0.3 }) : accent;
  for (const o of openings) {
    if (!o.W) continue;
    const { face, t, yc, W, H } = o;
    const wallMat = face === 0 && accentTo && t < accentTo ? accentBay : wallMatBase;
    // 開口の内側の4面（見込み）：上・下・左・右
    onFace(face, t, yc, 0, H / 2, -DEPTH / 2, wallMat, plane(W, DEPTH).rotateX(Math.PI / 2));
    onFace(face, t, yc, 0, -H / 2, -DEPTH / 2, wallMat, plane(W, DEPTH).rotateX(-Math.PI / 2));
    onFace(face, t, yc, -W / 2, 0, -DEPTH / 2, wallMat, plane(DEPTH, H).rotateY(Math.PI / 2));
    onFace(face, t, yc, W / 2, 0, -DEPTH / 2, wallMat, plane(DEPTH, H).rotateY(-Math.PI / 2));
    if (o.door) {
      onFace(face, t, yc, 0, 0, -0.07, doorMat, box(W - 0.08, H - 0.04, 0.04));      // 扉
      onFace(face, t, yc, W / 2 - 0.16, 0, -0.04, frameMat, box(0.03, 0.4, 0.05));    // 取っ手
      continue;
    }
    const { ww, wh } = o;
    // 奥から：室内の暗さ（開口をふさぐ）→ レースのカーテン → 半透明のガラス → サッシの枠
    onFace(face, t, yc, 0, 0, -DEPTH + 0.005, roomMat, new THREE.PlaneGeometry(W, H));
    const cw = ww * (0.22 + ((t * 7.3 + yc * 3.1) % 1) * 0.14); // 窓ごとに少しずつ開け具合を変える
    onFace(face, t, yc, -ww / 2 + cw / 2, 0, -0.11, curtainMat, new THREE.PlaneGeometry(cw, wh));
    onFace(face, t, yc, ww / 2 - cw * 0.4, 0, -0.11, curtainMat, new THREE.PlaneGeometry(cw * 0.8, wh));
    onFace(face, t, yc, 0, 0, -0.065, winMat, new THREE.PlaneGeometry(ww, wh));
    const FD = 0.07, fz = -0.06;
    onFace(face, t, yc, 0, H / 2 - F / 2, fz, frameMat, box(W, F, FD));
    onFace(face, t, yc, 0, -H / 2 + F / 2, fz, frameMat, box(W, F, FD));
    onFace(face, t, yc, -W / 2 + F / 2, 0, fz, frameMat, box(F, H - 2 * F, FD));
    onFace(face, t, yc, W / 2 - F / 2, 0, fz, frameMat, box(F, H - 2 * F, FD));
    if (ww > 0.9) onFace(face, t, yc, 0, 0, fz, frameMat, box(F * 0.9, wh, FD * 0.8)); // 引き違い窓の召し合わせ
    onFace(face, t, yc, 0, -H / 2 - 0.018, 0.035, frameMat, box(W + 0.16, 0.035, 0.09)); // 外の水切り
  }
  // 和風の腰板：面ごとの帯。玄関の前は空ける
  if (pal.band && onGround && b.kind !== "store") {
    for (let face = 0; face < 4; face++) {
      const len = faceLen(face), gaps: [number, number][] = [];
      if (face === 0 && doorAt) gaps.push([doorAt.t - doorAt.W / 2, doorAt.t + doorAt.W / 2]);
      let s0 = -0.04;
      for (const [g0, g1] of [...gaps, [len + 0.04, len + 0.04] as [number, number]]) {
        if (g0 - s0 > 0.05) onFace(face, (s0 + g0) / 2, baseH + 0.275, 0, 0, 0.02, accent, meterUVBox(g0 - s0, 0.55, 0.04));
        s0 = g1;
      }
    }
  }
  if (doorAt && !openings.some(o => o.door && o.W)) doorAt = null;
  if (doorAt) {
    const dx = b.u0 + doorAt.t;
    put(frameMat, box(1.4, 0.1, 0.9), dx, baseH + 2.35, -b.v0 + 0.45); // 玄関の小さな庇
    put(lampMat, box(0.1, 0.22, 0.08), dx + 0.72, baseH + 1.75, -b.v0 + 0.05); // 玄関灯
    put(texMat("ground_concrete", 0xdedcd6, 0.4, THREE.FrontSide, 2.4), meterUVBox(1.6, baseH, 1.0), dx, baseH / 2, -b.v0 + 0.5); // 玄関ポーチ
  }
  if (store && onGround && !covered(0, w / 2, fh * 0.5)) {
    // 店舗：入口の上に看板の帯と、張り出したひさし
    put(accentBay, meterUVBox(w - 0.3, 0.55, 0.08), cx, fh * 0.7 + 0.2 + 0.42, -b.v0 + 0.05);
    put(frameMat, box(w - 0.1, 0.08, 1.1), cx, fh * 0.7 + 0.2 + 0.1, -b.v0 + 0.55);
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
    if (![0.4, bw / 2, bw - 0.1].some(dt => covered(0, w - 0.3 - dt, y0 + fh + 0.5))) balcony(y0 + fh, b.u1 - bw - 0.3, b.u1 - 0.3, 0.9);
  }
  if (b.kind === "apartment") {
    for (let f = onGround ? 1 : 0; f < b.floors; f++) {
      const y = y0 + f * fh;
      if (![0.3, w / 2, w - 0.3].some(t => covered(0, t, y + 0.5))) balcony(y, b.u0 + 0.2, b.u1 - 0.2, 1.0);
      if ([0.3, w / 2, w - 0.3].some(t => covered(2, t, y + 0.5))) continue;
      put(new THREE.MeshStandardMaterial({ color: 0x3a4044, roughness: 0.9 }), new THREE.PlaneGeometry(w - 0.4, fh - 1.25), cx, y + 1.1 + (fh - 1.25) / 2, -b.v1 - 0.012, Math.PI); // 廊下の奥の影
      put(trimMat, box(w - 0.2, 1.1, 0.12), cx, y + 0.55, -b.v1 - 0.06);
    }
  }

  // 数値表示と同じ屋根仕様から生成する（色のパレットは形状を決めない）。
  const spec = roofSpec(b, style);
  const gutterMat = new THREE.MeshStandardMaterial({ color: spec.kind === "hip" ? 0x4a4f52 : pal.frame === 0x1c1f21 ? 0x2a2d2f : 0xe8e8e4, roughness: 0.5 });
  g.add(createRoof(b, spec, {
    surface: texMat(pal.roofTex, pal.roofTint, 1.0, THREE.DoubleSide, pal.roofGain),
    trim: trimMat, gutter: gutterMat,
    coping: pal.band ? new THREE.MeshStandardMaterial({ color: pal.roof }) : frameMat,
    membrane: texMat("ground_concrete", 0xb4c8f0, 0.5, THREE.FrontSide, 1.45),
    wall: wallMat,
    ridge: new THREE.MeshStandardMaterial({ color: spec.kind === "hip" ? 0x3d4347 : pal.band ? 0x3d4347 : pal.frame === 0x1c1f21 ? 0x1e2123 : 0x8b9296, roughness: 0.6, metalness: spec.kind === "hip" ? 0 : 0.3 }),
  }, (face, t) => !covered(face, t, spec.baseY + spec.parapetHeight / 2)));
  for (const [mat, list] of parts) {
    const m = new THREE.Mesh(mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x)), mat);
    m.castShadow = true; m.receiveShadow = true; g.add(m);
  }
  return g;
}
