// ComfyUI 等で使う制御パッケージ（白模型・深度・線画・マスク・仕様）を ZIP で書き出す
import { zipSync, strToU8 } from "three/examples/jsm/libs/fflate.module.js";
import type { Viewer } from "./viewer.ts";
import type { EngineResult, Plan } from "../engine/engine.ts";

const toPng = (cv: HTMLCanvasElement) => new Promise<Uint8Array>((res) => cv.toBlob(async b => res(new Uint8Array(await b!.arrayBuffer())), "image/png"));

/** 深度と法線の変化からエッジを取り、白地に黒線の線画にする（Sobel） */
function lineart(depth: HTMLCanvasElement, normal: HTMLCanvasElement): HTMLCanvasElement {
  const w = depth.width, h = depth.height;
  const D = depth.getContext("2d")!.getImageData(0, 0, w, h).data;
  const N = normal.getContext("2d")!.getImageData(0, 0, w, h).data;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const ctx = out.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const at = (a: Uint8ClampedArray, x: number, y: number, c: number) => a[(y * w + x) * 4 + c];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let g = 0;
    for (const [arr, chans, k] of [[D, [0], 1.5], [N, [0, 1, 2], 1]] as [Uint8ClampedArray, number[], number][]) {
      for (const c of chans) {
        const gx = -at(arr, x - 1, y - 1, c) - 2 * at(arr, x - 1, y, c) - at(arr, x - 1, y + 1, c) + at(arr, x + 1, y - 1, c) + 2 * at(arr, x + 1, y, c) + at(arr, x + 1, y + 1, c);
        const gy = -at(arr, x - 1, y - 1, c) - 2 * at(arr, x, y - 1, c) - at(arr, x + 1, y - 1, c) + at(arr, x - 1, y + 1, c) + 2 * at(arr, x, y + 1, c) + at(arr, x + 1, y + 1, c);
        g = Math.max(g, Math.hypot(gx, gy) * k);
      }
    }
    const v = g > 90 ? 0 : 255;
    const i = (y * w + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

const ROOF_EN = { gable: "gable roof", flat: "flat roof" } as const;
const USE_EN: Record<string, string> = { house: "detached house", apartment: "low-rise apartment building", store: "single-story retail store" };

function promptFor(p: Plan): { prompt: string; negative: string } {
  const b = p.buildings[0];
  const floors = p.metrics.floors;
  const kind = b ? USE_EN[b.kind] : "parking lot";
  const roof = b ? ROOF_EN[b.roof] : "";
  return {
    prompt: `photorealistic architectural exterior rendering, ${floors ? `${floors}-story ` : ""}Japanese ${kind}${roof ? `, ${roof}` : ""}, residential street in Japan, daylight, clear sky, realistic materials, high detail`,
    negative: "cartoon, anime, illustration, extra floors, distorted geometry, people, text, watermark",
  };
}

export async function exportControlPackage(viewer: Viewer, res: EngineResult, plans: Plan[], setPlan: (i: number) => void, meta: Record<string, unknown>): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Record<string, unknown>[] = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    setPlan(i);
    for (const view of ["front", "aerial"] as const) {
      const r = viewer.renderPasses(view);
      const dir = `${p.id}_${view}`;
      files[`${dir}/base.png`] = await toPng(r.base);
      files[`${dir}/depth.png`] = await toPng(r.depth);
      files[`${dir}/normal.png`] = await toPng(r.normal);
      files[`${dir}/lineart.png`] = await toPng(lineart(r.depth, r.normal));
      files[`${dir}/mask.png`] = await toPng(r.mask);
      manifest.push({ dir, plan: p.id, view, camera: r.camera });
    }
    files[`${p.id}.glb`] = new Uint8Array(await viewer.exportGlb());
  }
  const spec = {
    format: "tochi-mirai-control/1",
    createdAt: new Date().toISOString(),
    engineVersion: res.version,
    site: { area: res.site.area, zone: res.site.zone.label, bcr: res.site.bcr, far: res.site.far, roadWidth: res.site.roadWidth, rotationDeg: Math.round((res.site.rotation * 180) / Math.PI) },
    ...meta,
    plans: plans.map(p => ({ id: p.id, use: p.use, size: p.size ?? null, title: p.title, subtitle: p.subtitle, metrics: p.metrics, buildings: p.buildings.map(b => ({ kind: b.kind, floors: b.floors, floorHeight: b.floorHeight, roof: b.roof, baseFloor: b.baseFloor ?? 0, widthM: +(b.u1 - b.u0).toFixed(2), depthM: +(b.v1 - b.v0).toFixed(2) })), ...promptFor(p) })),
    views: manifest,
    notes: [
      "base.png: 白模型（影・周辺建物つき）。img2img の下絵",
      "depth.png: 深度（近いほど白）。ControlNet Depth 用",
      "lineart.png: 深度・法線のエッジから作った線画（白地に黒線）。ControlNet Lineart/Canny 用（必要なら色を反転）",
      "normal.png: 法線。ControlNet Normal 用",
      "mask.png: 計画建物だけ白。仕上げ範囲の限定と品質チェック用",
      "X.glb: 計画建物と敷地の3Dデータ（Blender 等で読み込み可）",
    ],
  };
  files["spec.json"] = strToU8(JSON.stringify(spec, null, 2));
  return new Blob([zipSync(files, { level: 0 })], { type: "application/zip" });
}
