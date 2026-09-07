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
  // 比例偏离按相对误差算, 偏离越多掉得越快;
  // 背面只圈住文字行时比例会明显偏长, 这里必须狠扣, 否则会选中残缺框
  const arErr = Math.abs(ar - CARD_ASPECT) / CARD_ASPECT;
  const arScore = Math.max(0, 1 - arErr * 1.6);
  // 合并候选按满填充计, 避免碎块拼出的正确轮廓被压制
  const fill = isMerged ? 1 : (rectArea > 0 ? Math.min(1, polygonArea(quad) / rectArea) : 0);
  const penalty = frac > 0.8 ? 0.3 : 0;
  return Math.max(0, 0.42 * arScore + 0.26 * areaScore + 0.17 * fill - 0.15 * penalty);
}

/**
 * 身份证长宽比固定 (85.6:54)。若候选框比例偏离, 说明它只框住了卡的一部分
 * (背面常只圈到几行文字)。这里沿短的那一边把框补足到标准比例, 只放大不缩小,
 * 宁可多带一点背景, 也不切掉卡的边角。
 */
function fitToCardAspect(quad) {
  const r = minAreaRect(quad);
  if (!r) return quad;
  let { w, h, cx, cy } = r;
  if (w < 1 || h < 1) return quad;
  // 以长边为基准方向, 保证不把横竖判断弄反
  const pts = r.pts;
  let ux, uy;
  if (w >= h) {
    ux = (pts[1][0] - pts[0][0]) / w; uy = (pts[1][1] - pts[0][1]) / w;
  } else {
    ux = (pts[3][0] - pts[0][0]) / h; uy = (pts[3][1] - pts[0][1]) / h;
    const t = w; w = h; h = t;
  }
  const nx = -uy, ny = ux;
  // 只补足, 不裁剪
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
  // 每个候选都额外产出一个"按标准比例补全"的版本一起参与打分
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
      // 补全是"猜"出来的形状, 打个折扣;
      // 只有当原始框比例明显不像身份证时, 补全版才可能胜出
      expanded.push({
        quad: fitted,
        src: c.src + '+fit',
        score: scoreQuad(fitted, imgArea, merged) * 0.82,
      });
    }
  }
  // 补全版只作为备选参与排序; 同分时优先原始候选, 避免补全把框推偏
  expanded.sort((a, b) => (b.score - a.score) || (a.src.endsWith('+fit') ? 1 : -1));
  const inv = 1 / useScale;
  const toFull = (q) => q.map(p => [p[0] * inv, p[1] * inv]);
  const whole = [[0, 0], [W, 0], [W, H], [0, H]];
  if (!expanded.length || expanded[0].score <= 0.05) {
    return { quad: whole, score: -0.01, method: 'fallback', alts: [] };
  }
  // 备选方案: 供界面上"换一个识别结果"使用, 去掉位置太接近的重复项
  const alts = [];
  for (const c of expanded.slice(1)) {
    if (alts.length >= 5) break;
    const q = toFull(c.quad);
    const near = alts.concat([{ quad: toFull(expanded[0].quad) }]).some(a => {
      const ao = orderPts(a.quad), qo = orderPts(q);
      return ao.every((p, i) => dist(p, qo[i]) < Math.max(W, H) * 0.04);
    });
    if (!near) alts.push({ quad: q, score: c.score, method: c.src });
  }
  alts.push({ quad: whole, score: 0, method: '整幅图' });
  // 最后一道保险: 胜出的框如果比例明显不像身份证, 说明只框到了卡的一部分
  // (背面只有文字行时最常见)。这里按标准比例往外补足, 原框留作备选。
  let best = toFull(expanded[0].quad);
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
  return { quad: best, score: expanded[0].score, method, alts };
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
