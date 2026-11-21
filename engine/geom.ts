export type Vec2 = [number, number];

export function signedArea(p: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export const area = (p: Vec2[]) => Math.abs(signedArea(p));

export function pointInPolygon([x, y]: Vec2, p: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment([px, py]: Vec2, [ax, ay]: Vec2, [bx, by]: Vec2): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export const edgeLength = (p: Vec2[], i: number) => {
  const a = p[i], b = p[(i + 1) % p.length];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

/** 経緯度 → 重心を原点とする局所平面座標（m）。数百m規模なら誤差は無視できる */
export function lngLatToLocal(lngLat: Vec2[]): { local: Vec2[]; origin: Vec2 } {
  const lng0 = lngLat.reduce((s, q) => s + q[0], 0) / lngLat.length;
  const lat0 = lngLat.reduce((s, q) => s + q[1], 0) / lngLat.length;
  const R = 6378137;
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * R;
  return { local: lngLat.map(([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky]), origin: [lng0, lat0] };
}

export interface Rect { u0: number; v0: number; u1: number; v1: number }
export const rectArea = (r: Rect) => (r.u1 - r.u0) * (r.v1 - r.v0);

/**
 * 2値グリッド（rows×cols、mask[row][col]）の中の最大の長方形（ヒストグラム法）。
 * 戻り値はセル単位の [col0, row0, col1, row1)（右端・下端は含まない）
 */
export function maxRectInMask(mask: Uint8Array[], cols: number):
  { c0: number; r0: number; c1: number; r1: number; cells: number } | null {
  const h = new Int32Array(cols);
  let best: { c0: number; r0: number; c1: number; r1: number; cells: number } | null = null;
  for (let r = 0; r < mask.length; r++) {
    for (let c = 0; c < cols; c++) h[c] = mask[r][c] ? h[c] + 1 : 0;
    const stack: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const cur = c === cols ? 0 : h[c];
      while (stack.length && h[stack[stack.length - 1]] >= cur) {
        const top = stack.pop()!;
        const height = h[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const width = c - left;
        const cells = height * width;
        if (height > 0 && (!best || cells > best.cells)) {
          best = { c0: left, r0: r - height + 1, c1: c, r1: r + 1, cells };
        }
      }
      stack.push(c);
    }
  }
  return best;
}

function douglasPeucker(pts: Vec2[], tol: number): Vec2[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * [lng,lat] のリングを maxVertices 以下に単純化する（閉合用の重複点なし・始点は保持）。
 * 重心原点の等角投影（m）で Douglas-Peucker を行い、許容誤差を 0.5m から倍々で 8m まで上げる
 */
export function simplifyRing(points: Vec2[], maxVertices = 40): Vec2[] {
  if (points.length <= maxVertices) return points;
  const lng0 = points.reduce((s, q) => s + q[0], 0) / points.length;
  const lat0 = points.reduce((s, q) => s + q[1], 0) / points.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const m = points.map(([lng, lat]): Vec2 => [(lng - lng0) * cosLat * 111320, (lat - lat0) * 110540]);
  const closed = [...m, m[0]];
  let out: Vec2[] = [];
  let idx: number[] = [];
  for (let tol = 0.5; tol <= 8; tol *= 2) {
    const kept = douglasPeucker(closed.map((p, i) => [p[0], p[1], i] as unknown as Vec2), tol);
    idx = kept.map(p => (p as unknown as number[])[2]).slice(0, -1); // 末尾は始点の複製
    out = idx.map(i => points[i]);
    if (out.length <= maxVertices) break;
  }
  if (out.length < 3) return points.slice(0, Math.min(3, points.length));
  return out;
}
