import * as THREE from "three";
import type { Vec2 } from "../engine/geom.ts";

const MAX_POLY = 32;
const INSIDE = `
uniform vec2 uPoly[${MAX_POLY}];
uniform int uN;
uniform bool uClip;
varying vec3 vWorldPos;
bool insideSite(vec2 p) {
  bool c = false;
  for (int i = 0; i < ${MAX_POLY}; i++) {
    if (i >= uN) break;
    int jj = (i == 0) ? uN - 1 : i - 1;
    vec2 a = uPoly[i]; vec2 b = uPoly[jj];
    if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) c = !c;
  }
  return c;
}`;

function polyUniform(P: Vec2[]) {
  return { value: Array.from({ length: MAX_POLY }, (_, i) => new THREE.Vector2(...(P[i] ?? [0, 0]))) };
}

/** 線形の深度（near で白、far で黒） */
export function linearDepthMaterial(P: Vec2[], near: number, far: number, clip: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { uNear: { value: near }, uFar: { value: far }, uPoly: polyUniform(P), uN: { value: Math.min(P.length, MAX_POLY) }, uClip: { value: clip } },
    vertexShader: `varying float vDepth; varying vec3 vWorldPos;
      void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWorldPos = wp.xyz; vec4 mv = viewMatrix * wp; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uNear; uniform float uFar; varying float vDepth; ${INSIDE}
      void main() { if (uClip && insideSite(vec2(vWorldPos.x, -vWorldPos.z))) discard;
        float d = 1.0 - clamp((vDepth - uNear) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(d), 1.0); }`,
    side: THREE.DoubleSide,
  });
}

/** 法線（カメラ空間、RGB = n*0.5+0.5） */
export function normalMaterial(P: Vec2[], clip: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { uPoly: polyUniform(P), uN: { value: Math.min(P.length, MAX_POLY) }, uClip: { value: clip } },
    vertexShader: `varying vec3 vN; varying vec3 vWorldPos;
      void main() { vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vN; ${INSIDE}
      void main() { if (uClip && insideSite(vec2(vWorldPos.x, -vWorldPos.z))) discard;
        vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }`,
    side: THREE.DoubleSide,
  });
}
