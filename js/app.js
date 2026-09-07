// 界面逻辑: 全部在浏览器本地运行, 不上传任何文件
import { findCardQuad, warpCard, mergeSides } from './detect.js';
import { canvasesToPdf } from './pdfout.js';

const $ = (id) => document.getElementById(id);

// 标签切换
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    const key = t.dataset.tab;
    document.querySelectorAll('.panel').forEach(p => {
      p.classList.toggle('active', p.id === 'panel-' + key);
    });
  });
});

// 滑块数值联动
function bindOut(id, outId, fmt = v => v) {
  const el = $(id), out = $(outId);
  const sync = () => { out.textContent = fmt(el.value); };
  el.addEventListener('input', sync);
  sync();
}
bindOut('margin', 'margin-out', v => v + '%');
bindOut('gap', 'gap-out');
bindOut('quality', 'quality-out');
bindOut('conv-dpi', 'conv-dpi-out');
bindOut('conv-quality', 'conv-quality-out');

// 把 File 读成 ImageData
async function fileToImageData(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('这个文件不是能识别的图片'));
      im.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 把 {data,width,height} 画到 canvas
function blitTo(canvas, img) {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
}

// 缩略图 (限制边长, 避免大图卡顿)
function drawThumb(canvas, imageData, maxSide = 520) {
  const s = Math.min(1, maxSide / Math.max(imageData.width, imageData.height));
  const w = Math.max(1, Math.round(imageData.width * s));
  const h = Math.max(1, Math.round(imageData.height * s));
  const tmp = document.createElement('canvas');
  tmp.width = imageData.width; tmp.height = imageData.height;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, w, h);
  canvas.hidden = false;
}

// 通用拖放/点选绑定
function bindDrop(dropId, inputId, onFiles, multiple = false) {
  const drop = $(dropId), input = $(inputId);
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files.length) onFiles([...input.files]);
  });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', e => {
    const fs = [...(e.dataTransfer?.files || [])];
    if (fs.length) onFiles(multiple ? fs : [fs[0]]);
  });
}

// ---------- 身份证 ----------
const state = { front: null, back: null, merged: null };

function refreshRunBtn() {
  $('btn-run').disabled = !(state.front && state.back);
}

function setCardStatus(msg, isErr = false) {
  const el = $('card-status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function loadSide(which) {
  return async (files) => {
    const drop = $('drop-' + which);
    try {
      const data = await fileToImageData(files[0]);
      state[which] = data;
      drawThumb(drop.querySelector('.thumb'), data);
      drop.classList.add('loaded');
      setCardStatus('');
      refreshRunBtn();
    } catch (err) {
      setCardStatus(err.message, true);
    }
  };
}

bindDrop('drop-front', 'file-front', loadSide('front'));
bindDrop('drop-back', 'file-back', loadSide('back'));

$('btn-run').addEventListener('click', async () => {
  if (!state.front || !state.back) return;
  const btn = $('btn-run');
  btn.disabled = true;
  setCardStatus('正在识别边框...');
  // 让浏览器有机会渲染这行提示
  await new Promise(r => setTimeout(r, 30));
  try {
    const margin = parseFloat($('margin').value) / 100;
    const gap = parseInt($('gap').value, 10);
    const out = [];
    for (const which of ['front', 'back']) {
      const d = state[which];
      const q = findCardQuad(d.data, d.width, d.height);
      out.push(warpCard(d.data, d.width, d.height, q.quad, margin));
      setCardStatus(which === 'front' ? '正面识别完成，继续处理背面...' : '正在拼接...');
      await new Promise(r => setTimeout(r, 20));
    }
    const merged = mergeSides(out[0], out[1], gap, 10);
    state.merged = merged;
    blitTo($('out-canvas'), merged);
    $('out-canvas').hidden = false;
    $('result-empty').hidden = true;
    $('btn-save').disabled = false;
    setCardStatus('处理完成，' + merged.width + ' × ' + merged.height + ' 像素');
  } catch (err) {
    setCardStatus('处理失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btn-save').addEventListener('click', () => {
  const q = parseInt($('quality').value, 10) / 100;
  $('out-canvas').toBlob(b => {
    if (b) triggerDownload(b, '身份证-正反面.jpg');
  }, 'image/jpeg', q);
});

function triggerDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- 格式转换 ----------
const convFiles = [];

function setConvStatus(msg, isErr = false) {
  const el = $('conv-status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function renderConvList() {
  const ul = $('conv-list');
  ul.textContent = '';
  convFiles.forEach((f, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.file.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = f.note || (f.file.size / 1024).toFixed(0) + ' KB';
    if (f.bad) meta.classList.add('bad');
    li.append(name, meta);
    for (const r of f.results || []) {
      const b = document.createElement('button');
      b.className = 'dl';
      b.textContent = '下载 ' + r.name.split('.').pop().toUpperCase() + (f.results.length > 1 ? ' ' + r.idx : '');
      b.addEventListener('click', () => triggerDownload(r.blob, r.name));
      li.append(b);
    }
    ul.append(li);
  });
  $('btn-conv').disabled = convFiles.length === 0;
}

bindDrop('drop-conv', 'file-conv', (files) => {
  for (const f of files) convFiles.push({ file: f });
  setConvStatus('');
  renderConvList();
}, true);

let pdfjsPromise = null;
// 按需加载 pdf.js: 不用转 PDF 就完全不下载
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdf.mjs').then(mod => {
      mod.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
      return mod;
    });
  }
  return pdfjsPromise;
}

const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

// PDF 每页渲染成 canvas
async function pdfToCanvases(file, dpi) {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  const scale = dpi / 72;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pages.push(c);
  }
  return pages;
}

// 图片文件 -> canvas
async function imageToCanvas(file) {
  const d = await fileToImageData(file);
  const c = document.createElement('canvas');
  c.width = d.width; c.height = d.height;
  c.getContext('2d').putImageData(d, 0, 0);
  return c;
}

function canvasToBlob(canvas, target, quality) {
  // JPG 不支持透明, 先垫白底
  if (target === 'jpg') {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, 0);
    canvas = c;
  }
  const mime = target === 'png' ? 'image/png' : 'image/jpeg';
  return new Promise(res => canvas.toBlob(res, mime, quality));
}

const stripExt = (n) => n.replace(/\.[^.]+$/, '');

$('btn-conv').addEventListener('click', async () => {
  const btn = $('btn-conv');
  btn.disabled = true;
  const target = $('conv-target').value;
  const dpi = parseInt($('conv-dpi').value, 10);
  const quality = parseInt($('conv-quality').value, 10) / 100;
  let done = 0, failed = 0;
  for (const entry of convFiles) {
    entry.results = [];
    entry.bad = false;
    try {
      setConvStatus('正在处理：' + entry.file.name);
      await new Promise(r => setTimeout(r, 15));
      const canvases = isPdf(entry.file)
        ? await pdfToCanvases(entry.file, dpi)
        : [await imageToCanvas(entry.file)];
      const base = stripExt(entry.file.name);
      if (target === 'pdf') {
        const blob = await canvasesToPdf(canvases, quality);
        entry.results.push({ name: base + '.pdf', blob, idx: 1 });
        entry.note = canvases.length + ' 页 → PDF';
      } else {
        for (let i = 0; i < canvases.length; i++) {
          const blob = await canvasToBlob(canvases[i], target, quality);
          const suffix = canvases.length > 1 ? '-第' + (i + 1) + '页' : '';
          entry.results.push({ name: base + suffix + '.' + target, blob, idx: i + 1 });
        }
        entry.note = canvases.length > 1 ? canvases.length + ' 张图片' : '完成';
      }
      done++;
    } catch (err) {
      entry.bad = true;
      entry.note = '失败：' + err.message;
      failed++;
    }
    renderConvList();
  }
  setConvStatus(failed ? ('完成 ' + done + ' 个，失败 ' + failed + ' 个') : ('全部完成，共 ' + done + ' 个'), failed > 0);
  btn.disabled = false;
});
