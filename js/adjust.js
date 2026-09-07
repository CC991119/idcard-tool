// 边框确认: 在缩略图上画出四边形, 四个角可拖动
const HANDLE_R = 9;      // 角点圆点半径
const GRAB_R = 22;       // 手指/鼠标的抓取范围, 比圆点大一些才好点

export class QuadEditor {
  /**
   * @param canvas 显示用的 canvas
   * @param imageData 原图像素
   * @param quad 原图坐标系下的四个角
   * @param onChange 角点变动时的回调
   */
  constructor(canvas, imageData, quad, onChange) {
    this.canvas = canvas;
    this.img = imageData;
    this.onChange = onChange || (() => {});
    this.quad = quad.map(p => [p[0], p[1]]);
    this.drag = -1;
    this.buildBase();
    this.bind();
    this.draw();
  }

  // 预先把原图缩成显示尺寸, 避免每次重绘都缩放大图
  buildBase() {
    const maxSide = 460;
    const s = Math.min(1, maxSide / Math.max(this.img.width, this.img.height));
    this.scale = s;
    const w = Math.max(1, Math.round(this.img.width * s));
    const h = Math.max(1, Math.round(this.img.height * s));
    const full = document.createElement('canvas');
    full.width = this.img.width;
    full.height = this.img.height;
    full.getContext('2d').putImageData(
      new ImageData(this.img.data, this.img.width, this.img.height), 0, 0);
    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    const c = this.base.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(full, 0, 0, w, h);
    this.canvas.width = w;
    this.canvas.height = h;
  }

  // 原图坐标 <-> 画布坐标
  toView(p) { return [p[0] * this.scale, p[1] * this.scale]; }
  toImg(p) { return [p[0] / this.scale, p[1] / this.scale]; }

  // 鼠标/触摸位置换算到画布坐标 (canvas 可能被 CSS 缩放过)
  eventPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (this.canvas.width / r.width),
      (e.clientY - r.top) * (this.canvas.height / r.height),
    ];
  }

  bind() {
    const cv = this.canvas;
    const down = (e) => {
      const [x, y] = this.eventPos(e);
      let hit = -1, bestD = GRAB_R;
      this.quad.forEach((p, i) => {
        const [vx, vy] = this.toView(p);
        const d = Math.hypot(vx - x, vy - y);
        if (d < bestD) { bestD = d; hit = i; }
      });
      if (hit >= 0) {
        this.drag = hit;
        // 某些环境下指针未激活会抛错, 抓取失败不影响拖动本身
        try { cv.setPointerCapture?.(e.pointerId); } catch (_) {}
        e.preventDefault();
      }
    };
    const move = (e) => {
      if (this.drag < 0) {
        // 靠近角点时换成抓手指针, 让人知道这里能拖
        const [x, y] = this.eventPos(e);
        const near = this.quad.some(p => {
          const [vx, vy] = this.toView(p);
          return Math.hypot(vx - x, vy - y) < GRAB_R;
        });
        cv.style.cursor = near ? 'grab' : 'crosshair';
        return;
      }
      const [x, y] = this.eventPos(e);
      // 允许略微超出画面, 这样贴边拍的照片也能把角拖到边界外
      const lim = 40;
      const cx = Math.max(-lim, Math.min(this.canvas.width + lim, x));
      const cy = Math.max(-lim, Math.min(this.canvas.height + lim, y));
      this.quad[this.drag] = this.toImg([cx, cy]);
      cv.style.cursor = 'grabbing';
      this.draw();
      e.preventDefault();
    };
    const up = (e) => {
      if (this.drag < 0) return;
      this.drag = -1;
      cv.style.cursor = 'grab';
      this.onChange(this.getQuad());
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  setQuad(quad) {
    this.quad = quad.map(p => [p[0], p[1]]);
    this.draw();
    this.onChange(this.getQuad());
  }

  getQuad() { return this.quad.map(p => [p[0], p[1]]); }

  draw() {
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    const v = this.quad.map(p => this.toView(p));

    // 框外压暗, 让保留范围一眼可见
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.canvas.width, this.canvas.height);
    ctx.moveTo(v[0][0], v[0][1]);
    for (let i = v.length - 1; i >= 1; i--) ctx.lineTo(v[i][0], v[i][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(15,22,30,0.5)';
    ctx.fill('evenodd');
    ctx.restore();

    // 边框线: 深色描边打底, 浅色在上, 深浅背景上都看得清
    ctx.beginPath();
    v.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // 四个角的可拖圆点
    v.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = this.drag === i ? '#2f6f4e' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#1f2933';
      ctx.stroke();
    });
  }
}
