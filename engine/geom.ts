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

/**
 * [lng,lat] のリングを maxVertices 以下に単純化する（閉合用の重複点なし）。
 * 重心原点の等角投影（m）で Visvalingam-Whyatt 法を行う。各頂点の「有効面積」
 * （前後の頂点と作る三角形の面積）に角の鋭さで重みを付け、まっすぐな辺の途中点から
 * 先に落とし、鋭い角を残す（mapshaper と同系統の角保護つき間引き）。
 * 小野市85,326筆の実測比較（2026-11-21）で、旧 Douglas-Peucker（上限40）と
 * 面積誤差はほぼ同等（平均0.44%）のまま頂点数の上限を24に抑えられることを確認した。
 */
export function simplifyRing(points: Vec2[], maxVertices = 24): Vec2[] {
  const n = points.length;
  if (n <= maxVertices) return points;
  const lng0 = points.reduce((s, q) => s + q[0], 0) / n;
  const lat0 = points.reduce((s, q) => s + q[1], 0) / n;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const m = points.map(([lng, lat]): Vec2 => [(lng - lng0) * cosLat * 111320, (lat - lat0) * 110540]);
  const prev = m.map((_, i) => (i - 1 + n) % n);
  const next = m.map((_, i) => (i + 1) % n);
  const alive = new Array<boolean>(n).fill(true);
  const eff = new Array<number>(n).fill(0);
  const calc = (i: number): number => {
    const a = m[prev[i]], b = m[i], d = m[next[i]];
    const area = Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])) / 2;
    const v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = d[0] - b[0], v2y = d[1] - b[1];
    const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
    if (n1 === 0 || n2 === 0) return area;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
    const ang = (Math.acos(cos) * 180) / Math.PI; // 180 = 直線、0 = 針のような角
    return area * (0.25 + ((180 - ang) / 180) * 1.75);
  };
  for (let i = 0; i < n; i++) eff[i] = calc(i);
  let remaining = n;
  while (remaining > maxVertices) {
    let best = -1, bestVal = Infinity;
    for (let i = 0; i < n; i++) if (alive[i] && eff[i] < bestVal) { bestVal = eff[i]; best = i; }
    if (best < 0) break;
    alive[best] = false;
    remaining--;
    const p = prev[best], q = next[best];
    next[p] = q;
    prev[q] = p;
    eff[p] = calc(p);
    eff[q] = calc(q);
  }
  const out = points.filter((_, i) => alive[i]);
  if (out.length < 3) return points.slice(0, Math.min(3, n));
  return out;
}
