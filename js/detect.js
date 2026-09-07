// 身份证检测: 三路候选 + 打分 + 透视校正 + 拼接
import { minAreaRect, orderPts, expandQuad, polygonArea, dist } from './geom.js';
import { getPerspectiveTransform, applyM } from './geom.js';
import { toGray, canny, close, open, connectedComponents, adaptiveThreshold, dilate, mergeNearby } from './imgproc.js';

export const CARD_ASPECT = 85.6 / 54.0;
const WORK_SIZE = 900;

// 候选 1: Canny 边缘 + 连通域
function candEdges(gray, w, h) {
  const e = close(canny(gray, w, h, 50, 150), w, h, 5);
  const comps = connectedComponents(dilate(e, w, h, 3), w, h, Math.max(150, (w * h) / 2000));
  return emitCands(comps, 'edge');
}

// 候选 2: 边框取背景基准亮度, 差异分割
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

// 候选 3: 自适应阈值
function candAdaptive(gray, w, h) {
  const th = close(adaptiveThreshold(gray, w, h, 10, 4), w, h, 5);
  const comps = connectedComponents(th, w, h, Math.max(200, (w * h) / 1500));
  return emitCands(comps, 'adapt');
}

/**
 * 每路都产出两种候选: 单个连通域, 以及把邻近碎块合并后的整体。
 * 身份证上的文字/头像常被切成多块, 合并后才能还原整张卡的轮廓。
 */
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

/**
 * 打分: 长宽比 + 面积占比 + 填充度 - 过大惩罚
 * isMerged: 合并候选内部本就是分散碎块, 低填充度属正常, 不应扣分。
 */
function scoreQuad(quad, imgArea, isMerged = false) {
  const r = minAreaRect(quad);
  if (!r) return 0;
  const long = Math.max(r.w, r.h), short = Math.min(r.w, r.h);
  if (short < 1) return 0;
  const ar = long / short;
  const rectArea = r.w * r.h;
  const frac = rectArea / imgArea;
  // 手机拍身份证常占画面 8%-55%, 该区间内不因偏小而扣分
  let areaScore;
  if (frac >= 0.08 && frac <= 0.55) areaScore = 1;
  else if (frac < 0.08) areaScore = Math.max(0, frac / 0.08);
  else areaScore = Math.max(0, 1 - (frac - 0.55) / 0.45);
  const arScore = Math.max(0, 1 - Math.abs(ar - CARD_ASPECT) / CARD_ASPECT);
  // 合并候选按满填充计, 避免碎块拼出的正确轮廓被压制
  const fill = isMerged ? 1 : (rectArea > 0 ? Math.min(1, polygonArea(quad) / rectArea) : 0);
  const penalty = frac > 0.8 ? 0.3 : 0;
  return Math.max(0, 0.35 * arScore + 0.30 * areaScore + 0.20 * fill - 0.15 * penalty);
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
  const imgArea = w * h;
  let cands = [];
  try { cands = cands.concat(candEdges(gray, w, h)); } catch (e) {}
  try { cands = cands.concat(candBgDiff(gray, w, h)); } catch (e) {}
  try { cands = cands.concat(candAdaptive(gray, w, h)); } catch (e) {}
  let best = null, bestScore = -1;
  const seen = new Set();
  for (const c of cands) {
    const key = c.quad.map(p => Math.round(p[0]) + ',' + Math.round(p[1])).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    const s = scoreQuad(c.quad, imgArea, c.src.endsWith('+merge'));
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best || bestScore <= 0.05) {
    return { quad: [[0, 0], [W, 0], [W, H], [0, H]], score: -0.01, method: 'fallback' };
  }
  const inv = 1 / useScale;
  return {
    quad: best.quad.map(p => [p[0] * inv, p[1] * inv]),
    score: bestScore,
    method: best.src,
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
  // 反向映射: 目标 -> 源, 便于逐像素采样
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
      // 双线性插值
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
