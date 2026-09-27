// 身份证检测: 直线拟合(Hough) 为主 + 连通域为兜底 + 透视校正 + 拼接
import { minAreaRect, orderPts, expandQuad, polygonArea, dist } from './geom.js';
import { getPerspectiveTransform, applyM } from './geom.js';
import { toGray, canny, close, open, connectedComponents, adaptiveThreshold, dilate, mergeNearby, gaussBlur } from './imgproc.js';

export const CARD_ASPECT = 85.6 / 54.0;
const WORK_SIZE = 720;

// ============================================================
// 主检测: Hough 直线 + 平行线对组合 + 四边支撑度打分
// 思路: 身份证是四条长直边围成的凸四边形, 长宽比固定 1.586。
// 先找图中的强直线, 再两两配对(对边平行、邻边垂直)组成四边形,
// 按"四条边是否真的贴着边缘像素"打分, 选最好的。
// ============================================================

// Sobel: 幅值 + 方向
function sobel(gray, w, h) {
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h); // 梯度方向 0..179 度
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] + gray[i - w + 1] - 2 * gray[i - 1] + 2 * gray[i + 1] - gray[i + w - 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
      let a = Math.atan2(gy, gx) * 180 / Math.PI;
      if (a < 0) a += 180;
      dir[i] = a | 0;
    }
  }
  return { mag, dir };
}

// 自适应 Canny: 阈值按梯度分布取分位数, 对不同光照/对比度都稳
// 返回 { edge: 边缘图, dir: 每个边缘像素的梯度方向 }
function autoEdges(gray, w, h) {
  const { mag, dir } = sobel(gaussBlur(gray, w, h, 2), w, h);
  const hist = new Int32Array(256);
  let n = 0;
  for (let i = 0; i < mag.length; i++) {
    const v = mag[i] | 0;
    if (v > 8 && v < 256) { hist[v]++; n++; }
  }
  // 取候选像素的 88 分位作为高阈值
  let hi = 60;
  const want = n * 0.12;
  let acc = 0;
  for (let v = 255; v >= 8; v--) {
    acc += hist[v];
    if (acc >= want) { hi = v; break; }
  }
  hi = Math.min(150, Math.max(28, hi));
  const lo = Math.max(12, hi * 0.4);
  return { edge: canny(gray, w, h, lo, hi), dir };
}

// Hough 变换找直线 (theta 0.5 度一步, rho 1px 一票)
function houghLines(edge, w, h) {
  const rhoMax = Math.ceil(Math.hypot(w, h)) + 2;
  const nTheta = 360;
  const acc = new Int32Array(nTheta * (2 * rhoMax));
  const cosT = new Float32Array(nTheta), sinT = new Float32Array(nTheta);
  for (let t = 0; t < nTheta; t++) {
    cosT[t] = Math.cos(t * Math.PI / 360);
    sinT[t] = Math.sin(t * Math.PI / 360);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      for (let t = 0; t < nTheta; t++) {
        const rho = Math.round(x * cosT[t] + y * sinT[t]) + rhoMax;
        acc[t * 2 * rhoMax + rho]++;
      }
    }
  }
  // 找局部极大 + 非极大抑制
  let maxV = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxV) maxV = acc[i];
  const minVotes = Math.max(28, maxV * 0.12);
  const cands = [];
  for (let t = 0; t < nTheta; t++) {
    for (let r = 3; r < 2 * rhoMax - 3; r++) {
      const v = acc[t * 2 * rhoMax + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -6; dt <= 6 && isMax; dt++) {
        const tt = (t + dt + nTheta) % nTheta;
        for (let dr = -6; dr <= 6; dr++) {
          if (!dt && !dr) continue;
          const rr = r + dr;
          if (rr < 0 || rr >= 2 * rhoMax) continue;
          if (acc[tt * 2 * rhoMax + rr] > v) { isMax = false; break; }
        }
      }
      if (isMax) cands.push({ theta: t / 2, rho: r - rhoMax, votes: v });
    }
  }
  cands.sort((a, b) => b.votes - a.votes);
  // 同一条线只留票数最高的一条 (角度/距离接近的合并)
  const lines = [];
  for (const c of cands) {
    if (lines.length >= 36) break;
    let dup = false;
    for (const l of lines) {
      if (angleDiffDeg(c.theta, l.theta) <= 3
        && Math.abs(c.rho - l.rho) <= Math.max(6, Math.hypot(w, h) * 0.012)) { dup = true; break; }
    }
    if (!dup) lines.push(c);
  }
  return lines.map(l => {
    const nx = Math.cos(l.theta * Math.PI / 180);
    const ny = Math.sin(l.theta * Math.PI / 180);
    return { nx, ny, rho: l.rho, theta: l.theta, votes: l.votes };
  });
}

// 两条直线交点
function lineIntersect(a, b) {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [
    (a.rho * b.ny - a.ny * b.rho) / det,
    (a.nx * b.rho - a.rho * b.nx) / det,
  ];
}

function angleDiffDeg(a, b) {
  let d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

// 四边形按角度排序成顺/逆时针
function sortQuad(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= 4; cy /= 4;
  return pts.slice().sort((a, b) =>
    Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

// 检查一条边的支撑度(带方向一致性):
// 真边上的边缘像素, 梯度方向应垂直于边;
// 文字行/图案上凑出来的"假边", 梯度方向多半沿着边 -> 不算支撑
function sideSupport(edgeData, w, h, p1, p2, radius = 3) {
  const edge = edgeData.edge, dir = edgeData.dir;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return 0;
  // 边的法向角
  let na = Math.atan2(-dx, dy) * 180 / Math.PI;
  if (na < 0) na += 180;
  const K = Math.max(16, Math.min(48, Math.round(len / 8)));
  let hit = 0;
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    const x = Math.round(p1[0] + dx * t);
    const y = Math.round(p1[1] + dy * t);
    let found = false;
    for (let ddy = -radius; ddy <= radius && !found; ddy++) {
      for (let ddx = -radius; ddx <= radius; ddx++) {
        const xx = x + ddx, yy = y + ddy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const idx = yy * w + xx;
        if (!edge[idx]) continue;
        // 梯度方向与法向夹角 30 度内才算同一条边
        let dd = Math.abs(dir[idx] - na);
        if (dd > 90) dd = 180 - dd;
        if (dd <= 30) { found = true; break; }
      }
    }
    if (found) hit++;
  }
  return hit / (K + 1);
}

// 用边缘像素对直线做最小二乘精修 (在给定线段附近收集)
function refineLine(edgeMap, w, h, line, t0, t1, band = 3) {
  const dirx = -line.ny, diry = line.nx;
  const lo = Math.min(t0, t1) - 8, hi = Math.max(t0, t1) + 8;
  let sx = 0, sy = 0, n = 0;
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edgeMap[y * w + x]) continue;
      const d = x * line.nx + y * line.ny - line.rho;
      if (Math.abs(d) > band) continue;
      const t = x * dirx + y * diry;
      if (t < lo || t > hi) continue;
      pts.push([x, y]);
      sx += x; sy += y; n++;
    }
  }
  if (n < 30) return line;
  const cx = sx / n, cy = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - cx) * (x - cx);
    syy += (y - cy) * (y - cy);
    sxy += (x - cx) * (y - cy);
  }
  // 主方向 = 协方差最大特征向量
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const lam = tr / 2 + Math.sqrt(disc);
  let dx = sxy, dy = lam - syy;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return line;
  const len = Math.hypot(dx, dy);
  dx /= len; dy /= len;
  const nx = -dy, ny = dx;
  return { nx, ny, rho: cx * nx + cy * ny, theta: line.theta, votes: line.votes };
}

// 由直线构造四边形候选: 双平行对直接组框 + 平行对配单线预测补全
function buildLineQuads(edge, lines, w, h) {
  const imgArea = w * h;
  const minDim = Math.min(w, h);
  const diag = Math.hypot(w, h);

  const quads = [];
  const pushQuad = (A1, A2, B1, B2, perp) => {
    let pts = [];
    for (const [ai, bi] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
      const p = lineIntersect([A1, A2][ai], [B1, B2][bi]);
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
      pts.push(p);
    }
    pts = sortQuad(pts);
    const area = polygonArea(pts);
    const frac = area / imgArea;
    if (frac < 0.03 || frac > 0.98) return;
    const e = [0, 1, 2, 3].map(k => dist(pts[k], pts[(k + 1) % 4]));
    const long = Math.max(...e), short = Math.min(...e);
    if (short < minDim * 0.09) return;
    const ar = long / short;
    if (ar > 3.2) return;
    quads.push({ pts, lines: [A1, A2, B1, B2], perp, frac, ar, isLine: true });
  };

  // 近平行线对 (透视下对边夹角可达 30 度以上, 放宽)
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (angleDiffDeg(a.theta, b.theta) > 35) continue;
      const sep = Math.abs(a.rho - b.rho);
      if (sep < minDim * 0.10) continue;
      if (sep > diag * 0.95) continue;
      pairs.push([a, b]);
    }
  }
  // 票数高的对优先, 防止组合爆炸
  pairs.sort((a, b) => (b[0].votes + b[1].votes) - (a[0].votes + a[1].votes));
  const workPairs = pairs.slice(0, 150);
  const strongPairs = pairs.slice(0, 80);

  // 路径 1: 两个真实平行对直接组框
  for (let i = 0; i < strongPairs.length; i++) {
    for (let j = 0; j < strongPairs.length; j++) {
      if (i === j) continue;
      const A = strongPairs[i], B = strongPairs[j];
      const perp = Math.abs(angleDiffDeg(A[0].theta, B[0].theta) - 90);
      if (perp > 26) continue;
      pushQuad(A[0], A[1], B[0], B[1], perp);
    }
  }

  // 路径 2: 平行对 + 1 条近垂直线, 第 4 条边按平行四边形外推预测
  // (透视下两条对边不平行, 用线距比例预测会错, 必须从实际角点外推)
  for (const [A1, A2] of workPairs) {
    for (const L of lines) {
      if (L === A1 || L === A2) continue;
      const perp = Math.abs(angleDiffDeg(A1.theta, L.theta) - 90);
      if (perp > 26) continue;
      const P1 = lineIntersect(A1, L), P2 = lineIntersect(A2, L);
      if (!P1 || !P2) continue;
      const vx = P2[0] - P1[0], vy = P2[1] - P1[1];
      for (const f of [CARD_ASPECT, 1 / CARD_ASPECT]) {
        for (const sign of [1, -1]) {
          // 第 4 角 ≈ P1 + (P2-P1)*f*sign, 第 4 条边过该点、方向同 L
          const Dx = P1[0] + vx * f * sign, Dy = P1[1] + vy * f * sign;
          const rhoP = Dx * L.nx + Dy * L.ny;
          if (rhoP < -diag * 0.15 || rhoP > diag * 1.1) continue;
          const pred = { nx: L.nx, ny: L.ny, rho: rhoP, theta: L.theta, votes: 0 };
          // 预测位置附近若真有一条检出线, 用检出线 (更准)
          let partner = pred;
          let bestScore = Infinity;
          for (const l2 of lines) {
            if (l2 === A1 || l2 === A2 || l2 === L) continue;
            const dth = angleDiffDeg(l2.theta, L.theta);
            if (dth > 12) continue;
            const dr = Math.abs(l2.rho - rhoP);
            if (dr > Math.max(18, minDim * 0.04)) continue;
            const s = dth * 3 + dr;
            if (s < bestScore) { bestScore = s; partner = l2; }
          }
          const perp2 = Math.abs(angleDiffDeg(A1.theta, partner.theta) - 90);
          pushQuad(A1, A2, L, partner, Math.max(perp, perp2));
        }
      }
    }
  }
  // 去重: 中心和面积都接近的算同一个
  const uniq = [];
  outer: for (const q of quads) {
    const cx = (q.pts[0][0] + q.pts[2][0]) / 2, cy = (q.pts[0][1] + q.pts[2][1]) / 2;
    const a = polygonArea(q.pts);
    for (const u of uniq) {
      const ucx = (u.pts[0][0] + u.pts[2][0]) / 2, ucy = (u.pts[0][1] + u.pts[2][1]) / 2;
      if (Math.hypot(ucx - cx, ucy - cy) < diag * 0.02
        && Math.abs(polygonArea(u.pts) - a) / a < 0.08) continue outer;
    }
    uniq.push(q);
  }
  return uniq;
}

// 外侧杂乱度: 真正的卡边外侧是背景, 应该比较干净;
// 内部结构(文字行/照片框/半截框)的外侧不远处还有别的边缘
// (仅调试观察用, 不参与打分)
function outsideClutter(edgeData, w, h, pts) {
  const edge = edgeData.edge;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= 4; cy /= 4;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % 4];
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    if (len < 1) return 1;
    let nx = -dy / len, ny = dx / len;
    // 指向外侧 (背离中心)
    const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const K = 24;
    let hits = 0;
    for (let k = 0; k <= K; k++) {
      const t = k / K;
      const bx = p1[0] + dx * t, by = p1[1] + dy * t;
      let found = false;
      for (let d = 5; d <= 14 && !found; d += 3) {
        for (const j of [-1, 0, 1]) {
          const xx = Math.round(bx + nx * d - ny * j);
          const yy = Math.round(by + ny * d + nx * j);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (edge[yy * w + xx]) { found = true; break; }
        }
      }
      if (found) hits++;
    }
    total += hits / (K + 1);
  }
  return total / 4;
}

// 通用打分: 四边支撑度 + 长宽比 + 面积
function scoreQuadFull(edgeData, w, h, q) {
  const pts = q.pts;
  const perSide = [
    sideSupport(edgeData, w, h, pts[0], pts[1]),
    sideSupport(edgeData, w, h, pts[1], pts[2]),
    sideSupport(edgeData, w, h, pts[2], pts[3]),
    sideSupport(edgeData, w, h, pts[3], pts[0]),
  ];
  const sup = (perSide[0] + perSide[1] + perSide[2] + perSide[3]) / 4;
  const e = [0, 1, 2, 3].map(k => dist(pts[k], pts[(k + 1) % 4]));
  const ar = Math.max(...e) / Math.max(1, Math.min(...e));
  const arErr = Math.abs(ar - CARD_ASPECT) / CARD_ASPECT;
  const arScore = Math.max(0, 1 - arErr * 1.3);
  const frac = q.frac ?? polygonArea(pts) / (w * h);
  const areaScore = frac < 0.12 ? frac / 0.12 : (frac > 0.75 ? Math.max(0, 1 - (frac - 0.75) / 0.25) : 1);
  const score = 1.3 * sup + 0.5 * arScore + 0.15 * areaScore - (q.perp || 0) * 0.004;
  return { sup, score, perSide };
}

// 内框被更大的高分框包住时淘汰 (宁可多带背景, 不切小)
function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1 };
}
function contains(outer, inner, tol = 4) {
  const o = bboxOf(outer.pts), i = bboxOf(inner.pts);
  return i.x0 >= o.x0 - tol && i.y0 >= o.y0 - tol && i.x1 <= o.x1 + tol && i.y1 <= o.y1 + tol;
}
function dropNestedReal(pool) {
  return pool.filter(inner =>
    !pool.some(outer => outer !== inner
      && polygonArea(outer.pts) > polygonArea(inner.pts) * 1.6
      && outer.sup >= inner.sup - 0.04
      && outer.score >= inner.score - 0.10
      && contains(outer, inner)));
}

// 直线精修: 用边缘像素重新拟合四条边, 提高角点精度
function refineQuad(best, edgeData, w, h) {
  const { pts } = best;
  const lines = best.lines; // [A1, A2, B1, B2] 对应边 01 / 32(平行A) 与 03 / 12(平行B)
  const edge = edgeData.edge;
  // 边 0-1 在 A 组, 2-3 在 A 组, 1-2 在 B 组, 3-0 在 B 组
  const tOf = (line, p) => p[0] * (-line.ny) + p[1] * (line.nx);
  const refA1 = refineLine(edge, w, h, lines[0], tOf(lines[0], pts[0]), tOf(lines[0], pts[1]));
  const refA2 = refineLine(edge, w, h, lines[1], tOf(lines[1], pts[3]), tOf(lines[1], pts[2]));
  const refB1 = refineLine(edge, w, h, lines[2], tOf(lines[2], pts[0]), tOf(lines[2], pts[3]));
  const refB2 = refineLine(edge, w, h, lines[3], tOf(lines[3], pts[1]), tOf(lines[3], pts[2]));
  const corners = [];
  for (const [la, lb] of [[refA1, refB1], [refA1, refB2], [refA2, refB2], [refA2, refB1]]) {
    const p = lineIntersect(la, lb);
    if (!p) return pts;
    corners.push(p);
  }
  // 精修后不能有明显变化, 否则可能修歪了, 保守起见限制单角移动量
  let maxMove = 0;
  for (let i = 0; i < 4; i++) maxMove = Math.max(maxMove, dist(corners[i], pts[i]));
  if (maxMove > Math.max(w, h) * 0.06) return pts;
  return sortQuad(corners);
}

// ============================================================
// 兜底: 原来的三路连通域法 (直线法找不到才用)
// ============================================================

function candEdges(gray, w, h) {
  const e = close(canny(gray, w, h, 50, 150), w, h, 5);
  const comps = connectedComponents(dilate(e, w, h, 3), w, h, Math.max(150, (w * h) / 2000));
  return emitCands(comps, 'edge');
}

function candBgDiff(gray, w, h) {
  const m = Math.max(4, Math.round(Math.min(w, h) * 0.03));
  const s = [];
  for (let y = 0; y < m; y++) for (let x = 0; x < w; x++) s.push(gray[y * w + x]);
  for (let y = h - m; y < h; y++) for (let x = 0; x < w; x++) s.push(gray[y * w + x]);
  for (let y = m; y < h - m; y++) {
    for (let x = 0; x < m; x++) s.push(gray[y * w + x]);
    for (let x = w - m; x < w; x++) s.push(gray[y * w + x]);
  }
  s.sort((a, b) => a - b);
  const bg = s[s.length >> 1];
  const mask = new Uint8ClampedArray(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = Math.abs(gray[i] - bg) > 20 ? 255 : 0;
  const cleaned = open(close(mask, w, h, 7), w, h, 5);
  const comps = connectedComponents(cleaned, w, h, Math.max(200, (w * h) / 1500));
  return emitCands(comps, 'bg');
}

function candAdaptive(gray, w, h) {
  const th = close(adaptiveThreshold(gray, w, h, 10, 4), w, h, 5);
  const comps = connectedComponents(th, w, h, Math.max(200, (w * h) / 1500));
  return emitCands(comps, 'adapt');
}

function emitCands(comps, tag) {
  const out = [];
  for (const pts of comps) {
    const r = minAreaRect(pts);
    if (r) out.push({ quad: r.pts, src: tag });
  }
  for (const th of [0.15, 0.4, 0.8]) {
    for (const pts of mergeNearby(comps, th)) {
      const r = minAreaRect(pts);
      if (r) out.push({ quad: r.pts, src: tag + '+merge' });
    }
  }
  return out;
}

function scoreQuad(quad, imgArea, isMerged = false) {
  const r = minAreaRect(quad);
  if (!r) return 0;
  const long = Math.max(r.w, r.h), short = Math.min(r.w, r.h);
  if (short < 1) return 0;
  const ar = long / short;
  const rectArea = r.w * r.h;
  const frac = rectArea / imgArea;
  let areaScore;
  if (frac >= 0.08 && frac <= 0.55) areaScore = 1;
  else if (frac < 0.08) areaScore = Math.max(0, frac / 0.08);
  else areaScore = Math.max(0, 1 - (frac - 0.55) / 0.45);
  const arErr = Math.abs(ar - CARD_ASPECT) / CARD_ASPECT;
  const arScore = Math.max(0, 1 - arErr * 1.6);
  const fill = isMerged ? 1 : (rectArea > 0 ? Math.min(1, polygonArea(quad) / rectArea) : 0);
  const penalty = frac > 0.8 ? 0.3 : 0;
  return Math.max(0, 0.42 * arScore + 0.26 * areaScore + 0.17 * fill - 0.15 * penalty);
}

function fitToCardAspect(quad) {
  const r = minAreaRect(quad);
  if (!r) return quad;
  let { w, h, cx, cy } = r;
  if (w < 1 || h < 1) return quad;
  const pts = r.pts;
  let ux, uy;
  if (w >= h) {
    ux = (pts[1][0] - pts[0][0]) / w; uy = (pts[1][1] - pts[0][1]) / w;
  } else {
    ux = (pts[3][0] - pts[0][0]) / h; uy = (pts[3][1] - pts[0][1]) / h;
    const t = w; w = h; h = t;
  }
  const nx = -uy, ny = ux;
  const needW = Math.max(w, h * CARD_ASPECT);
  const needH = Math.max(h, w / CARD_ASPECT);
  const hw = needW / 2, hh = needH / 2;
  return [
    [cx - hw * ux - hh * nx, cy - hw * uy - hh * ny],
    [cx + hw * ux - hh * nx, cy + hw * uy - hh * ny],
    [cx + hw * ux + hh * nx, cy + hw * uy + hh * ny],
    [cx - hw * ux + hh * nx, cy - hw * uy + hh * ny],
  ];
}

function contentBBox(gray, w, h) {
  const step = Math.max(2, Math.round(Math.min(w, h) / 250));
  let sum = 0, cnt = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) { sum += gray[y * w + x]; cnt++; }
  }
  const mean = sum / Math.max(1, cnt);
  const th = mean * 0.78;
  let minX = w, minY = h, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (gray[y * w + x] < th) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        n++;
      }
    }
  }
  if (n < 15 || maxX < 0) return null;
  return { minX, minY, maxX, maxY, n };
}

function quadBBox(quad) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of quad) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

function legacyFind(gray, w, h, W, H) {
  const imgArea = w * h;
  const whole = [[0, 0], [w, 0], [w, h], [0, h]];
  let cands = [];
  try { cands = cands.concat(candEdges(gray, w, h)); } catch (e) {}
  try { cands = cands.concat(candBgDiff(gray, w, h)); } catch (e) {}
  try { cands = cands.concat(candAdaptive(gray, w, h)); } catch (e) {}
  const expanded = [];
  const seen = new Set();
  for (const c of cands) {
    const key = c.quad.map(p => Math.round(p[0]) + ',' + Math.round(p[1])).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    const merged = c.src.endsWith('+merge');
    expanded.push({ quad: c.quad, src: c.src, score: scoreQuad(c.quad, imgArea, merged) });
    const fitted = fitToCardAspect(c.quad);
    const fkey = fitted.map(p => Math.round(p[0]) + ',' + Math.round(p[1])).join(';');
    if (!seen.has(fkey)) {
      seen.add(fkey);
      expanded.push({
        quad: fitted,
        src: c.src + '+fit',
        score: scoreQuad(fitted, imgArea, merged) * 0.82,
      });
    }
  }
  expanded.sort((a, b) => (b.score - a.score) || (a.src.endsWith('+fit') ? 1 : -1));
  if (!expanded.length || expanded[0].score <= 0.05) {
    return { quad: whole, score: -0.01, method: 'fallback', alts: [] };
  }
  const alts = [];
  for (const c of expanded.slice(1)) {
    if (alts.length >= 5) break;
    const q = c.quad.map(p => [p[0], p[1]]);
    const near = alts.concat([{ quad: expanded[0].quad }]).some(a => {
      const ao = orderPts(a.quad), qo = orderPts(q);
      return ao.every((p, i) => dist(p, qo[i]) < Math.max(w, h) * 0.04);
    });
    if (!near) alts.push({ quad: q, score: c.score, method: c.src });
  }
  alts.push({ quad: whole, score: 0, method: '整幅图' });
  let best = expanded[0].quad.map(p => [p[0], p[1]]);
  let method = expanded[0].src;
  if (!method.endsWith('+fit')) {
    const r = minAreaRect(best);
    if (r) {
      const ar = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h));
      if (Math.abs(ar - CARD_ASPECT) / CARD_ASPECT > 0.25) {
        alts.unshift({ quad: best, score: expanded[0].score, method: method + '(未补全)' });
        best = fitToCardAspect(best);
        method = method + '+保险补全';
      }
    }
  }
  const cbSmall = contentBBox(gray, w, h);
  if (cbSmall) {
    const cb = cbSmall;
    const tol = 0.02 * Math.max(w, h);
    const cbW = cb.maxX - cb.minX, cbH = cb.maxY - cb.minY;
    if (cbW < w * 0.85 && cbH < h * 0.85) {
      const qBox = quadBBox(best);
      const outside = cb.minX < qBox.minX - tol || cb.minY < qBox.minY - tol
        || cb.maxX > qBox.maxX + tol || cb.maxY > qBox.maxY + tol;
      if (outside) {
        const original = best.slice();
        let t = 0;
        for (let iter = 0; iter < 8 && t <= 0.5; iter++) {
          const b = quadBBox(best);
          if (cb.minX >= b.minX - tol && cb.minY >= b.minY - tol
            && cb.maxX <= b.maxX + tol && cb.maxY <= b.maxY + tol) break;
          t += 0.07;
          best = expandQuad(original, t);
        }
        if (t > 0 && t <= 0.5) {
          const b = quadBBox(best);
          const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
          if (bw <= w * 0.95 && bh <= h * 0.95) {
            method = method + '+内容扩';
          } else {
            best = original;
          }
        } else {
          best = original;
        }
      }
    }
  }
  return { quad: best, score: expanded[0].score, method, alts };
}

/**
 * 找出身份证四角。传入 RGBA 像素, 返回原图坐标系下的 quad。
 * 永不失败: 找不到就回退整幅图。
 */
export function findCardQuad(rgba, W, H) {
  const scale = WORK_SIZE / Math.max(W, H);
  const useScale = scale < 1 ? scale : 1;
  const w = Math.max(1, Math.round(W * useScale));
  const h = Math.max(1, Math.round(H * useScale));
  const small = resampleRGBA(rgba, W, H, w, h);
  const gray = toGray(small, w, h);
  const inv = 1 / useScale;
  const toFull = (q) => q.map(p => [p[0] * inv, p[1] * inv]);
  const whole = [[0, 0], [W, 0], [W, H], [0, H]];

  let pool = [];
  let edge = null;
  let bestLines = null;

  // 1) 直线法候选
  try {
    edge = autoEdges(gray, w, h);
    const lines = houghLines(edge.edge, w, h);
    const lineQuads = buildLineQuads(edge, lines, w, h);
    for (const q of lineQuads) {
      const s = scoreQuadFull(edge, w, h, q);
      if (s.sup < 0.45) continue;
      pool.push({ ...q, ...s });
    }
  } catch (e) { /* ignore */ }

  // 2) 兜底连通域候选 (跟直线候选同台打分)
  let legacyAlts = [];
  try {
    const lg = legacyFind(gray, w, h, W, H);
    if (lg.method !== 'fallback') {
      pool.push({
        pts: lg.quad.map(p => [p[0] * inv, p[1] * inv]),
        isLine: false, perp: 0,
        sup: 0, score: 0,
      });
      const q = pool[pool.length - 1];
      const s = edge ? scoreQuadFull(edge, w, h, q) : { sup: 0.5, score: 0.5, perSide: [0.5, 0.5, 0.5, 0.5] };
      Object.assign(q, s);
      legacyAlts = (lg.alts || []).slice(0, 3);
    }
  } catch (e) { /* ignore */ }

  // 过滤: 平均支撑度 + 单边支撑度下限 (堵住"3 条真边 + 1 条瞎预测")
  pool = pool.filter(q => q.sup >= 0.45 && isFinite(q.score)
    && q.perSide.every(s => s >= 0.15));
  // 位置接近的候选只留分高的
  pool.sort((a, b) => b.score - a.score);
  const diagW = Math.max(w, h);
  const uniqPool = [];
  outer: for (const q of pool) {
    const cx = (q.pts[0][0] + q.pts[2][0]) / 2, cy = (q.pts[0][1] + q.pts[2][1]) / 2;
    for (const u of uniqPool) {
      const ucx = (u.pts[0][0] + u.pts[2][0]) / 2, ucy = (u.pts[0][1] + u.pts[2][1]) / 2;
      if (Math.hypot(ucx - cx, ucy - cy) < diagW * 0.02) continue outer;
    }
    uniqPool.push(q);
  }
  pool = dropNestedReal(uniqPool);

  if (pool.length) {
    // 分数接近时取更大的框 (多带背景比切掉角安全); 只在最高分附近一小档里选, 防连锁漂移
    const topScore = pool[0].score;
    let best = pool[0];
    for (const q of pool) {
      if (q.score >= topScore - 0.03 && polygonArea(q.pts) > polygonArea(best.pts)) best = q;
    }
    let quad = best.pts;
    // 直线候选做角点精修
    if (best.isLine && best.lines) {
      try { quad = refineQuad(best, edge, w, h); } catch (e) {}
    }
    const alts = pool.slice(1, 4).map(q => ({ quad: toFull(q.pts), score: q.score, method: q.isLine ? '直线候选' : '区域候选' }));
    for (const a of legacyAlts) alts.push({ quad: toFull(a.quad), score: a.score ?? 0, method: a.method });
    alts.push({ quad: whole, score: 0, method: '整幅图' });
    return {
      quad: toFull(quad),
      score: best.score,
      method: (best.isLine ? '直线(' : '区域(') + best.sup.toFixed(2) + ')',
      alts,
    };
  }

  // 3) 全军覆没: 整幅图
  return { quad: whole, score: -0.01, method: 'fallback', alts: [] };
}

// 调试: 返回中间结果 (测试用, 界面不调用)
export function debugDetect(rgba, W, H, truthQuadFull) {
  const scale = WORK_SIZE / Math.max(W, H);
  const useScale = scale < 1 ? scale : 1;
  const w = Math.max(1, Math.round(W * useScale));
  const h = Math.max(1, Math.round(H * useScale));
  const small = resampleRGBA(rgba, W, H, w, h);
  const gray = toGray(small, w, h);
  const edge = autoEdges(gray, w, h);
  let cnt = 0;
  for (let i = 0; i < edge.edge.length; i++) if (edge.edge[i]) cnt++;
  const lines = houghLines(edge.edge, w, h);
  const lineQuads = buildLineQuads(edge, lines, w, h);
  const pool = lineQuads.map(q => ({ ...q, ...scoreQuadFull(edge, w, h, q) }));
  pool.sort((a, b) => b.score - a.score);
  // 把真实四边形(工作坐标)放进同一套打分, 看它排第几
  let truthScore = null;
  if (truthQuadFull) {
    const k = w / W;
    const tq = { pts: truthQuadFull.map(p => [p[0] * k, p[1] * k]), isLine: false, perp: 0, frac: null };
    const s = scoreQuadFull(edge, w, h, tq);
    truthScore = {
      perSide: s.perSide.map(v => +v.toFixed(2)),
      sup: +s.sup.toFixed(2), score: +s.score.toFixed(2),
      rank: pool.filter(q => q.score > s.score).length + 1, of: pool.length,
    };
  }
  return {
    w, h, edgeCount: cnt, truthScore,
    lines: lines.map(l => ({ theta: +l.theta.toFixed(1), rho: Math.round(l.rho), votes: l.votes })),
    topQuads: pool.slice(0, 6).map(q => ({
      pts: q.pts.map(p => p.map(Math.round)),
      sup: +q.sup.toFixed(2), score: +q.score.toFixed(2),
      perp: +q.perp.toFixed(1), ar: +q.ar?.toFixed(2),
    })),
  };
}

// 最近邻缩放 RGBA
export function resampleRGBA(rgba, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return rgba;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y * yr) | 0);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x * xr) | 0);
      const si = (sy * sw + sx) * 4, di = (y * dw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/**
 * 按 quad 抠图校正。margin 向外扩张比例, 保证四角露出。
 * 超出原图的部分填白, 因此四角一定完整可见。
 */
export function warpCard(rgba, W, H, quad, margin = 0.03) {
  let q = orderPts(expandQuad(quad, margin));
  const wTop = dist(q[0], q[1]), wBot = dist(q[3], q[2]);
  const hLeft = dist(q[0], q[3]), hRight = dist(q[1], q[2]);
  let dw = Math.max(10, Math.round(Math.max(wTop, wBot)));
  let dh = Math.max(10, Math.round(Math.max(hLeft, hRight)));
  // 竖版转横版: 旋转角点顺序
  if (dw < dh) {
    const t = dw; dw = dh; dh = t;
    q = [q[3], q[0], q[1], q[2]];
  }
  const dst = [[0, 0], [dw, 0], [dw, dh], [0, dh]];
  const Minv = getPerspectiveTransform(dst, q);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const [sx, sy] = applyM(Minv, x + 0.5, y + 0.5);
      const di = (y * dw + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) {
        out[di] = 255; out[di + 1] = 255; out[di + 2] = 255; out[di + 3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4;
      const i01 = i00 + W * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const a = rgba[i00 + c] * (1 - fx) + rgba[i10 + c] * fx;
        const b = rgba[i01 + c] * (1 - fx) + rgba[i11 + c] * fx;
        out[di + c] = a * (1 - fy) + b * fy;
      }
      out[di + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * 上下拼接正反面。等宽缩放后纵向堆叠, 留白边和间距。
 */
export function mergeSides(front, back, gap = 20, pad = 10) {
  const innerW = Math.max(front.width, back.width);
  const scaleTo = (img) => {
    if (img.width === innerW) return img;
    const nh = Math.max(1, Math.round(img.height * (innerW / img.width)));
    return { data: resampleRGBA(img.data, img.width, img.height, innerW, nh), width: innerW, height: nh };
  };
  const f = scaleTo(front), b = scaleTo(back);
  const outW = innerW + pad * 2;
  const outH = f.height + b.height + gap + pad * 2;
  const out = new Uint8ClampedArray(outW * outH * 4);
  out.fill(255);
  const blit = (img, oy) => {
    for (let y = 0; y < img.height; y++) {
      const dRow = ((oy + y) * outW + pad) * 4;
      const sRow = y * img.width * 4;
      out.set(img.data.subarray(sRow, sRow + img.width * 4), dRow);
    }
  };
  blit(f, pad);
  blit(b, pad + f.height + gap);
  return { data: out, width: outW, height: outH };
}
