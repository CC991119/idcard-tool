// Word(.docx) -> HTML(mammoth) -> 按 A4 分页渲染成 canvas
// 老版 .doc 二进制格式不支持, 会给出明确提示

// Word 组件加载: 本地 vendor 优先, 加载失败自动回退到国内镜像/CDN
const MAMMOTH_SOURCES = [
  '../vendor/mammoth.browser.min.js',
  'https://registry.npmmirror.com/mammoth/1.8.0/files/mammoth.browser.min.js',
  'https://fastly.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js',
];

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (window.mammoth ? res(window.mammoth) : rej(new Error('组件内容异常')));
    s.onerror = () => rej(new Error('网络不可达'));
    document.head.appendChild(s);
  });
}

let mammothPromise = null;
function loadMammoth() {
  if (!mammothPromise) {
    mammothPromise = (async () => {
      let lastErr;
      for (const src of MAMMOTH_SOURCES) {
        try {
          const url = src.startsWith('http') ? src : new URL(src, import.meta.url).href;
          return await loadScript(url);
        } catch (e) { lastErr = e; }
      }
      throw new Error('Word 组件加载失败, 请检查网络后刷新重试');
    })();
  }
  return mammothPromise;
}

// A4 @ 96dpi
const PAGE_W = 794, PAGE_H = 1123, PAD = 42;

// 排版样式: 测量(宿主 DOM) 和 渲染(SVG foreignObject) 两处必须完全一致
const STYLE = 'width:710px;font-family:\'Microsoft YaHei\',\'PingFang SC\',SimSun,sans-serif;'
  + 'font-size:15px;line-height:1.75;color:#1a1a1a;'
  + 'h1{font-size:22px;margin:14px 0 10px}h2{font-size:19px;margin:12px 0 9px}'
  + 'h3{font-size:17px;margin:10px 0 8px}p{margin:7px 0}'
  + 'li{margin:3px 0}img{max-width:100%}'
  + 'table{border-collapse:collapse;width:100%;font-size:13px}'
  + 'td,th{border:1px solid #999;padding:4px 6px}';
// host 上选择器要能作用于子元素, SVG 里包在 div 上也一样, 这里统一拼一层
const wrapStyle = 'box-sizing:border-box;font-family:\'Microsoft YaHei\',\'PingFang SC\',SimSun,sans-serif;'
  + 'font-size:15px;line-height:1.75;color:#1a1a1a;'
  + 'h1{font-size:22px;margin:14px 0 10px}h2{font-size:19px;margin:12px 0 9px}'
  + 'h3{font-size:17px;margin:10px 0 8px}p{margin:7px 0}'
  + 'li{margin:3px 0}img{max-width:100%}'
  + 'table{border-collapse:collapse;width:100%;font-size:13px}'
  + 'td,th{border:1px solid #999;padding:4px 6px}';

function svgToImage(svg) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('文档渲染失败 (内容可能含不支持的元素)'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/**
 * docx 文件 -> canvas 数组 (每页一张 A4)
 * @returns {Promise<HTMLCanvasElement[]>}
 */
export async function docxToCanvases(file) {
  if (/\.doc$/i.test(file.name) && !/\.docx$/i.test(file.name)) {
    throw new Error('老版 .doc 格式不支持, 请先在 Word/WPS 里另存为 .docx');
  }
  const mammoth = await loadMammoth();
  const buf = await file.arrayBuffer();
  let html;
  try {
    const r = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = r.value;
  } catch (e) {
    throw new Error('不是有效的 .docx 文件');
  }
  if (!html || !html.replace(/<[^>]*>/g, '').trim()) {
    throw new Error('文档内容为空');
  }

  // 先在隐藏容器里排版, 拿到每块的真实高度
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;' + wrapStyle + ';width:710px;';
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    const blocks = [...host.children];
    if (!blocks.length) throw new Error('文档内容为空');
    const usable = PAGE_H - PAD * 2;
    const pages = [];
    let cur = [], curH = 0;
    for (const b of blocks) {
      const h = b.getBoundingClientRect().height;
      if (h > usable) {
        // 超高块 (长表格/大图): 独占一页, 渲染时缩放
        if (cur.length) { pages.push(cur); cur = []; }
        pages.push([b]);
      } else if (curH + h > usable && cur.length) {
        pages.push(cur); cur = [b]; curH = h;
      } else {
        cur.push(b); curH += h;
      }
    }
    if (cur.length) pages.push(cur);

    // 逐页渲染成 canvas
    const canvases = [];
    for (const pageBlocks of pages) {
      const inner = pageBlocks.map(b => b.outerHTML).join('');
      // 超高块缩放: 实际渲染高度超出可用区时, 按比例缩小字号方案太粗糙, 直接缩放绘制
      const c = document.createElement('canvas');
      c.width = PAGE_W; c.height = PAGE_H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + PAGE_W + '" height="' + PAGE_H + '">'
        + '<foreignObject width="100%" height="100%">'
        + '<div xmlns="http://www.w3.org/1999/xhtml" style="' + wrapStyle + 'padding:' + PAD + 'px;">'
        + inner
        + '</div></foreignObject></svg>';
      const img = await svgToImage(svg);
      ctx.drawImage(img, 0, 0);
      canvases.push(c);
    }
    return canvases;
  } finally {
    host.remove();
  }
}
