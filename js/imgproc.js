// 图像处理: 灰度 / 模糊 / Canny / 形态学 / 连通域

export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  }
  return g;
}

// 分离式高斯模糊
export function gaussBlur(src, w, h, radius = 2) {
  const sigma = radius / 2 || 0.8;
  const size = radius * 2 + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = 0; i < size; i++) {
        let xx = x + i - radius;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        a += src[y * w + xx] * k[i];
      }
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = 0; i < size; i++) {
        let yy = y + i - radius;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        a += tmp[yy * w + x] * k[i];
      }
      out[y * w + x] = a;
    }
  }
  return out;
}

// Canny 边缘检测
export function canny(gray, w, h, lo = 50, hi = 150) {
  const b = gaussBlur(gray, w, h, 2);
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -b[i - w - 1] + b[i - w + 1] - 2 * b[i - 1] + 2 * b[i + 1] - b[i + w - 1] + b[i + w + 1];
      const gy = -b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
      let a = Math.atan2(gy, gx) * 180 / Math.PI;
      if (a < 0) a += 180;
      dir[i] = a < 22.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : a < 157.5 ? 3 : 0;
    }
  }
  // 非极大值抑制
  const nms = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let n1, n2;
      switch (dir[i]) {
        case 0: n1 = mag[i - 1]; n2 = mag[i + 1]; break;
        case 1: n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; break;
        case 2: n1 = mag[i - w]; n2 = mag[i + w]; break;
        default: n1 = mag[i - w - 1]; n2 = mag[i + w + 1];
      }
      nms[i] = (mag[i] >= n1 && mag[i] >= n2) ? mag[i] : 0;
    }
  }
  // 双阈值 + 滞后连接
  const out = new Uint8ClampedArray(w * h);
  const stack = [];
  for (let i = 0; i < nms.length; i++) {
    if (nms[i] >= hi) { out[i] = 255; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const y = (i / w) | 0, x = i % w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (out[j] === 0 && nms[j] >= lo) { out[j] = 255; stack.push(j); }
      }
    }
  }
  return out;
}

// 形态学膨胀 (方形核)
export function dilate(src, w, h, k = 3) {
  const r = k >> 1;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r && !m; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (src[yy * w + xx]) { m = 255; break; }
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

// 形态学腐蚀 (方形核)
export function erode(src, w, h, k = 3) {
  const r = k >> 1;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let dy = -r; dy <= r && m; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (!src[yy * w + xx]) { m = 0; break; }
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

export function close(src, w, h, k = 5) {
  return erode(dilate(src, w, h, k), w, h, k);
}

export function open(src, w, h, k = 5) {
  return dilate(erode(src, w, h, k), w, h, k);
}

// 连通域标记, 返回每个域的像素点集 (4 连通, BFS)
export function connectedComponents(mask, w, h, minSize = 200) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  const qx = new Int32Array(w * h);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0;
    qx[tail++] = start;
    seen[start] = 1;
    const pts = [];
    while (head < tail) {
      const i = qx[head++];
      const y = (i / w) | 0, x = i % w;
      pts.push([x, y]);
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; qx[tail++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; qx[tail++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; qx[tail++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; qx[tail++] = i + w; }
    }
    if (pts.length >= minSize) comps.push(pts);
  }
  return comps;
}

// 合并相邻的连通域: 两组点的最小外接矩在阈值内则合并
export function mergeNearby(comps, threshold = 0.15) {
  if (comps.length <= 1) return comps;
  // 计算每组的外接矩形边界
  const boxes = comps.map(pts => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { pts, x0, y0, x1, y1 };
  });
  // 贪心合并
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < boxes.length && !changed; i++) {
      for (let j = i + 1; j < boxes.length && !changed; j++) {
        const a = boxes[i], b = boxes[j];
        const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
        if (gapX < 0 && gapY < 0) {
          // 直接重叠, 必合并
        } else if (gapX < 1 && gapY < 1) {
          // 相邻或略微重叠, 合并
        } else {
          const aW = a.x1 - a.x0, aH = a.y1 - a.y0;
          const bW = b.x1 - b.x0, bH = b.y1 - b.y0;
          const maxDim = Math.max(aW, aH, bW, bH);
          const thresholdPx = maxDim * threshold;
          if (gapX > thresholdPx || gapY > thresholdPx) continue;
        }
        // 合并 b 到 a
        a.pts = a.pts.concat(b.pts);
        a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
        a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
        boxes.splice(j, 1);
        changed = true;
      }
    }
  }
  return boxes.map(b => b.pts);
}

// 自适应阈值 (高斯邻域均值)
export function adaptiveThreshold(gray, w, h, blockRadius = 10, C = 4) {
  const blur = gaussBlur(gray, w, h, blockRadius);
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < gray.length; i++) {
    out[i] = gray[i] < blur[i] - C ? 255 : 0;
  }
  return out;
}
