// 几何运算: 凸包 / 最小外接矩形 / 排序 / 透视变换

export function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
}

export function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lo = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
    up.push(p[i]);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

// 旋转卡尺法: 最小外接矩形
export function minAreaRect(pts) {
  const hull = convexHull(pts);
  const n = hull.length;
  if (n < 3) return null;
  let minArea = Infinity, best = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-10) continue;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    let minP = Infinity, maxP = -Infinity, minQ = Infinity, maxQ = -Infinity;
    for (const q of hull) {
      const vx = q[0] - a[0], vy = q[1] - a[1];
      const pp = vx * ux + vy * uy;
      const qq = vx * nx + vy * ny;
      if (pp < minP) minP = pp;
      if (pp > maxP) maxP = pp;
      if (qq < minQ) minQ = qq;
      if (qq > maxQ) maxQ = qq;
    }
    const w = maxP - minP, h = maxQ - minQ;
    const area = w * h;
    if (area < minArea) {
      minArea = area;
      const c0 = [a[0] + minP * ux + minQ * nx, a[1] + minP * uy + minQ * ny];
      best = {
        w, h,
        cx: c0[0] + (w / 2) * ux + (h / 2) * nx,
        cy: c0[1] + (w / 2) * uy + (h / 2) * ny,
        pts: [
          c0,
          [c0[0] + w * ux, c0[1] + w * uy],
          [c0[0] + w * ux + h * nx, c0[1] + w * uy + h * ny],
          [c0[0] + h * nx, c0[1] + h * ny],
        ],
      };
    }
  }
  return best;
}

// 排序为 [左上, 右上, 右下, 左下]
export function orderPts(pts) {
  const s = pts.map(p => p[0] + p[1]);
  const d = pts.map(p => p[1] - p[0]);
  return [
    pts[s.indexOf(Math.min(...s))],
    pts[d.indexOf(Math.min(...d))],
    pts[s.indexOf(Math.max(...s))],
    pts[d.indexOf(Math.max(...d))],
  ];
}

// 四边形从中心向外扩张
export function expandQuad(quad, ratio) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p[1], 0) / quad.length;
  return quad.map(p => [cx + (p[0] - cx) * (1 + ratio), cy + (p[1] - cy) * (1 + ratio)]);
}

// 把四边形"补正"到目标长宽比 (只扩张、不收缩 -> 宁可多带背景, 不切内容)
// 身份证真实长宽比 1.586; 透视/漏检会让框变扁, 这里把短边补回来
export function rectifyAspect(quad, aspect) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p[1], 0) / quad.length;
  const e0 = dist(quad[0], quad[1]);
  const e1 = dist(quad[1], quad[2]);
  if (e0 < 1e-6 || e1 < 1e-6) return quad;
  const long = Math.max(e0, e1), short = Math.min(e0, e1);
  const ar = long / short;
  if (Math.abs(ar - aspect) < 1e-3) return quad;
  // 长轴方向
  let ux, uy;
  if (e0 >= e1) { ux = (quad[1][0] - quad[0][0]) / e0; uy = (quad[1][1] - quad[0][1]) / e0; }
  else { ux = (quad[2][0] - quad[1][0]) / e1; uy = (quad[2][1] - quad[1][1]) / e1; }
  const growShort = ar > aspect;               // 太扁 -> 补短轴
  const f = growShort ? (ar / aspect) : (aspect / ar);
  return quad.map(p => {
    const vx = p[0] - cx, vy = p[1] - cy;
    const t = vx * ux + vy * uy;               // 长轴分量
    let px = vx - t * ux, py = vy - t * uy;    // 短轴分量
    let nt = t;
    if (growShort) { px *= f; py *= f; } else { nt = t * f; }
    return [cx + px + nt * ux, cy + py + nt * uy];
  });
}

// 8x8 线性方程组: 高斯消元 + 部分选主元
function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : s / M[i][i];
  }
  return x;
}

// 求 src -> dst 的 3x3 透视矩阵 (返回长度 9 数组)
export function getPerspectiveTransform(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i][0], sy = src[i][1];
    const dx = dst[i][0], dy = dst[i][1];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
  }
  const x = solve8(A, b);
  return [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1];
}

// 用矩阵变换单点
export function applyM(M, x, y) {
  const w = M[6] * x + M[7] * y + M[8];
  if (Math.abs(w) < 1e-12) return [0, 0];
  return [(M[0] * x + M[1] * y + M[2]) / w, (M[3] * x + M[4] * y + M[5]) / w];
}
