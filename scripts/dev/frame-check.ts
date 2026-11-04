import * as THREE from "three";
import { WGS84_ELLIPSOID } from "3d-tiles-renderer";
import { lngLatToLocal } from "/home/claude/realestate-building-image/engine/geom.ts";
import { computePlans } from "/home/claude/realestate-building-image/engine/engine.ts";
// 三木市の地点周辺：敷地（約12m×20m、回転あり）
const o = [134.981201, 34.803135];
const dLat = 1/111320, dLng = 1/(111320*Math.cos(o[1]*Math.PI/180));
const loc = [[0,0],[12,3],[9,23],[-3,20]];
const pts = loc.map(([x,y]) => [o[0]+x*dLng, o[1]+y*dLat] as [number,number]);
const { local, origin } = lngLatToLocal(pts);
const r = computePlans({ polygon: local, roadEdges: [{index:0,width:"4to6"}], zone: "r1" });
const { a, ux, vx } = r.site.frame;
const enu = new THREE.Matrix4();
WGS84_ELLIPSOID.getEastNorthUpFrame(origin[1]*Math.PI/180, origin[0]*Math.PI/180, 0, enu);
const toView = new THREE.Matrix4().set(ux[0],ux[1],0,-(a[0]*ux[0]+a[1]*ux[1]), 0,0,1,0, -vx[0],-vx[1],0,a[0]*vx[0]+a[1]*vx[1], 0,0,0,1);
const base = new THREE.Matrix4().multiplyMatrices(toView, enu.clone().invert());
// 各頂点のECEF（高さ10m）を変換し、エンジンの (u, 10, -v) と比較
let maxErr = 0;
pts.forEach((p, i) => {
  const ecef = new THREE.Vector3();
  WGS84_ELLIPSOID.getCartographicToPosition(p[1]*Math.PI/180, p[0]*Math.PI/180, 10, ecef);
  const v = ecef.applyMatrix4(base);
  const uv = r.site.polygonUV[i] ?? [NaN,NaN];
  console.log(i, v.x.toFixed(2), v.y.toFixed(2), (-v.z).toFixed(2), "| engine uv (order may differ):", r.site.polygonUV.map(q=>q.map(n=>n.toFixed(2)).join(",")).join(" "));
});
