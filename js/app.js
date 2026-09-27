// 界面逻辑: 全部在浏览器本地运行, 不上传任何文件
import { findCardQuad, warpCard, mergeSides } from './detect.js';
import { canvasToJpegPage, pagesToPdf } from './pdfout.js';
import { QuadEditor } from './adjust.js';
import { docxToCanvases } from './docx.js';

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

// 浏览器是否支持"另存为"弹窗 (Chrome / Edge 支持, Firefox / Safari 不支持)
// 每次用到时再判断, 避免页面刚打开时判断结果被记死
const canPickSave = () => typeof window.showSaveFilePicker === 'function';
const canPickOpen = () => typeof window.showOpenFilePicker === 'function';

const IMAGE_MIME = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/bmp': ['.bmp'],
  'image/gif': ['.gif'],
};
const ACCEPT_IMAGE = { description: '图片', accept: IMAGE_MIME };
const ACCEPT_ANY = {
  description: 'PDF / Word / 图片',
  accept: Object.assign({
    'application/pdf': ['.pdf'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  }, IMAGE_MIME),
};

// 通用拖放/点选绑定
// onFiles(files, handles): handles 是文件位置句柄, 用来让保存弹窗停在原图那个文件夹
function bindDrop(dropId, inputId, onFiles, multiple = false, accept = ACCEPT_IMAGE) {
  const drop = $(dropId), input = $(inputId);
  const open = async () => {
    if (canPickOpen()) {
      try {
        const handles = await window.showOpenFilePicker({ multiple, types: [accept] });
        const files = await Promise.all(handles.map(h => h.getFile()));
        if (files.length) onFiles(files, handles);
        return;
      } catch (err) {
        // 用户按了取消就什么都不做, 其他意外情况退回普通选择框
        if (err && err.name === 'AbortError') return;
      }
    }
    input.click();
  };
  drop.addEventListener('click', open);
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files.length) onFiles([...input.files], null);
  });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', e => {
    const fs = [...(e.dataTransfer?.files || [])];
    if (fs.length) onFiles(multiple ? fs : [fs[0]], null);
  });
}

// ---------- 保存 ----------
// 记住最近一次选图的位置句柄, 保存弹窗会停在同一个文件夹
let lastSourceHandle = null;

// 保存文件: 支持的浏览器弹出"另存为"窗口, 不支持的直接下载
// makeBlob 可以是 Blob, 也可以是一个返回 Blob 的函数;
// 传函数时会先弹窗再生成, 避免浏览器因等待过久而拒绝打开弹窗
async function saveBlob(makeBlob, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const types = [];
  if (ext === 'jpg' || ext === 'jpeg') types.push({ description: 'JPG 图片', accept: { 'image/jpeg': ['.jpg'] } });
  else if (ext === 'png') types.push({ description: 'PNG 图片', accept: { 'image/png': ['.png'] } });
  else if (ext === 'pdf') types.push({ description: 'PDF 文件', accept: { 'application/pdf': ['.pdf'] } });

  const getBlob = async () => (typeof makeBlob === 'function' ? await makeBlob() : makeBlob);

  if (canPickSave()) {
    const opts = { suggestedName: name };
    if (types.length) opts.types = types;
    // startIn 传入原图句柄, 弹窗就会停在原图所在的文件夹
    if (lastSourceHandle) opts.startIn = lastSourceHandle;
    else opts.id = 'idcard-save';
    let handle;
    try {
      handle = await window.showSaveFilePicker(opts);
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, cancelled: true };
      // 弹窗因为任何原因用不了, 退回普通下载, 不让用户白点一次
      triggerDownload(await getBlob(), name);
      return { ok: true, fallback: true, name };
    }
    const blob = await getBlob();
    if (!blob) throw new Error('生成文件失败');
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return { ok: true, name: handle.name };
  }
  triggerDownload(await getBlob(), name);
  return { ok: true, fallback: true, name };
}

function triggerDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- 身份证 ----------
const state = { front: null, back: null, merged: null };
// 每一面的边框状态: 编辑器实例 / 自动识别结果 / 备选方案 / 当前用的是第几个备选
const edit = {
  front: { editor: null, auto: null, alts: [], altIdx: -1 },
  back: { editor: null, auto: null, alts: [], altIdx: -1 },
};

function refreshRunBtn() {
  $('btn-run').disabled = !(state.front && state.back);
}

function setCardStatus(msg, isErr = false) {
  const el = $('card-status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function loadSide(which) {
  return async (files, handles) => {
    const drop = $('drop-' + which);
    try {
      const data = await fileToImageData(files[0]);
      state[which] = data;
      if (handles && handles[0]) lastSourceHandle = handles[0];
      drawThumb(drop.querySelector('.thumb'), data);
      drop.classList.add('loaded');
      // 换了图, 之前的边框和结果都不再有效
      edit[which] = { editor: null, auto: null, alts: [], altIdx: -1 };
      $('adjust').hidden = true;
      $('out-canvas').hidden = true;
      $('result-empty').hidden = false;
      $('btn-save').disabled = true;
      state.merged = null;
      setCardStatus('');
      refreshRunBtn();
    } catch (err) {
      setCardStatus(err.message, true);
    }
  };
}

bindDrop('drop-front', 'file-front', loadSide('front'));
bindDrop('drop-back', 'file-back', loadSide('back'));

// 第一步: 识别边框, 交给用户确认
$('btn-run').addEventListener('click', async () => {
  if (!state.front || !state.back) return;
  const btn = $('btn-run');
  btn.disabled = true;
  setCardStatus('正在识别边框...');
  await new Promise(r => setTimeout(r, 30));
  try {
    for (const which of ['front', 'back']) {
      const d = state[which];
      const r = findCardQuad(d.data, d.width, d.height);
      const st = edit[which];
      st.auto = r.quad;
      st.alts = r.alts || [];
      st.altIdx = -1;
      const cv = $('adj-' + which);
      st.editor = new QuadEditor(cv, d, r.quad, () => setAdjustStatus('边框已调整，确认后点下面的按钮'));
      setCardStatus(which === 'front' ? '正面识别完成，继续识别背面...' : '识别完成');
      await new Promise(r2 => setTimeout(r2, 20));
    }
    $('adjust').hidden = false;
    setAdjustStatus('识别不准的话，直接拖动四个角上的圆点');
    setCardStatus('请先确认下面的边框位置');
    $('adjust').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // 供自动化检查读取当前边框位置, 不影响正常使用
    window.__quadOf = (w) => edit[w].editor ? edit[w].editor.getQuad() : null;
    window.__scaleOf = (w) => edit[w].editor ? edit[w].editor.scale : 1;
  } catch (err) {
    setCardStatus('识别失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function setAdjustStatus(msg, isErr = false) {
  const el = $('adjust-status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

// 三个小按钮: 重新识别 / 换一个 / 用整张
document.querySelectorAll('[data-reset]').forEach(b => {
  b.addEventListener('click', () => {
    const w = b.dataset.reset, st = edit[w];
    if (!st.editor || !st.auto) return;
    st.altIdx = -1;
    st.editor.setQuad(st.auto);
    setAdjustStatus('已回到自动识别的位置');
  });
});

document.querySelectorAll('[data-alt]').forEach(b => {
  b.addEventListener('click', () => {
    const w = b.dataset.alt, st = edit[w];
    if (!st.editor) return;
    if (!st.alts.length) { setAdjustStatus('这张图没有其他候选了，可以手动拖角'); return; }
    st.altIdx = (st.altIdx + 1) % st.alts.length;
    st.editor.setQuad(st.alts[st.altIdx].quad);
    setAdjustStatus('换到第 ' + (st.altIdx + 1) + ' / ' + st.alts.length + ' 个候选');
  });
});

document.querySelectorAll('[data-full]').forEach(b => {
  b.addEventListener('click', () => {
    const w = b.dataset.full, st = edit[w], d = state[w];
    if (!st.editor || !d) return;
    st.altIdx = -1;
    st.editor.setQuad([[0, 0], [d.width, 0], [d.width, d.height], [0, d.height]]);
    setAdjustStatus('已改成保留整张照片，不裁剪');
  });
});

// 第二步: 按确认后的边框抠图拼接
$('btn-confirm').addEventListener('click', async () => {
  const btn = $('btn-confirm');
  if (!edit.front.editor || !edit.back.editor) return;
  btn.disabled = true;
  setAdjustStatus('正在拼接...');
  await new Promise(r => setTimeout(r, 30));
  try {
    const margin = parseFloat($('margin').value) / 100;
    const gap = parseInt($('gap').value, 10);
    const out = [];
    for (const which of ['front', 'back']) {
      const d = state[which];
      out.push(warpCard(d.data, d.width, d.height, edit[which].editor.getQuad(), margin));
      await new Promise(r => setTimeout(r, 20));
    }
    const merged = mergeSides(out[0], out[1], gap, 10);
    state.merged = merged;
    blitTo($('out-canvas'), merged);
    $('out-canvas').hidden = false;
    $('result-empty').hidden = true;
    $('btn-save').disabled = false;
    setAdjustStatus('拼接完成，结果在下面');
    setCardStatus('处理完成，' + merged.width + ' × ' + merged.height + ' 像素');
    $('out-canvas').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    setAdjustStatus('拼接失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btn-save').addEventListener('click', async () => {
  const btn = $('btn-save');
  const q = parseInt($('quality').value, 10) / 100;
  btn.disabled = true;
  try {
    // 先弹窗问位置, 用户确认后再生成图片
    const r = await saveBlob(
      () => new Promise(res => $('out-canvas').toBlob(res, 'image/jpeg', q)),
      '身份证-正反面.jpg'
    );
    if (r.cancelled) setCardStatus('已取消保存');
    else if (r.fallback) setCardStatus('已保存到浏览器的下载文件夹：' + r.name);
    else setCardStatus('已保存：' + r.name);
  } catch (err) {
    setCardStatus('保存失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

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
      const label = (canPickSave() ? '保存 ' : '下载 ')
        + r.name.split('.').pop().toUpperCase()
        + (f.results.length > 1 ? ' ' + r.idx : '');
      b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          if (f.handle) lastSourceHandle = f.handle;
          const res = await saveBlob(r.blob, r.name);
          if (res.cancelled) b.textContent = label;
          else b.textContent = '已保存';
        } catch (err) {
          setConvStatus('保存失败：' + err.message, true);
          b.textContent = label;
        } finally {
          b.disabled = false;
        }
      });
      li.append(b);
    }
    ul.append(li);
  });
  $('btn-conv').disabled = convFiles.length === 0;
}

bindDrop('drop-conv', 'file-conv', (files, handles) => {
  files.forEach((f, i) => {
    convFiles.push({ file: f, handle: handles && handles[i] ? handles[i] : null });
  });
  if (handles && handles[0]) lastSourceHandle = handles[0];
  setConvStatus('');
  renderConvList();
}, true, ACCEPT_ANY);

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
const isDocx = (f) => /\.docx$/i.test(f.name)
  || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// 单页画布像素上限。超过这个量, 浏览器内存不够会**静默画出坏内容**,
// 而且是时好时坏(取决于当时内存), 表现就是"转出来的图少了很多东西, 没规律"。
const MAX_PDF_PX = 32e6;   // PDF 每页最多 ~32 兆像素 (实测 64MP 以上会把页面卡死)
const MAX_IMG_PX = 40e6;   // 单张图片最多 ~40 兆像素
const MAX_SIDE = 9000;     // 单边上限

function capScale(wPt, hPt, scale, maxPx) {
  let s = scale;
  const px = (wPt * s) * (hPt * s);
  if (px > maxPx) s *= Math.sqrt(maxPx / px);
  const long = Math.max(wPt, hPt) * s;
  if (long > MAX_SIDE) s *= MAX_SIDE / long;
  return s;
}

// 逐页产出 canvas: 每页处理完交给回调, 回调返回后**立刻释放这一页的位图**。
// 多页 PDF 不再把所有页的画布同时堆在内存里 -> 又快又不会炸。
async function eachPage(file, dpi, onPage) {
  if (isPdf(file)) {
    const pdfjs = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const want = dpi / 72;
        const s = capScale(vp1.width, vp1.height, want, MAX_PDF_PX);
        const vp = page.getViewport({ scale: s });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        await onPage(c, { total: doc.numPages, capped: s < want - 1e-6, effDpi: Math.round(s * 72) });
        c.width = 0; c.height = 0;
        if (page.cleanup) page.cleanup();
      }
    } finally {
      if (doc.destroy) await doc.destroy();
    }
  } else if (isDocx(file)) {
    const canvases = await docxToCanvases(file);
    for (const c of canvases) {
      await onPage(c, { total: canvases.length });
      c.width = 0; c.height = 0;
    }
  } else {
    const c = await imageToCanvas(file);
    await onPage(c, { total: 1, capped: !!c.__capped });
    c.width = 0; c.height = 0;
  }
}

// 图片文件 -> canvas (直接绘制, 不再做 ImageData 往返, 大图快很多)
async function imageToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('这个文件不是能识别的图片'));
      im.src = url;
    });
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    let s = 1;
    if (w0 * h0 > MAX_IMG_PX) s = Math.sqrt(MAX_IMG_PX / (w0 * h0));
    if (Math.max(w0, h0) * s > MAX_SIDE) s = MAX_SIDE / Math.max(w0, h0);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s));
    c.height = Math.max(1, Math.round(h0 * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (s < 1) c.__capped = true;
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
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
      const base = stripExt(entry.file.name);
      let capped = false, effDpi = 0;
      if (target === 'pdf') {
        const pages = [];
        await eachPage(entry.file, dpi, async (c, info) => {
          if (info && info.capped) { capped = true; effDpi = info.effDpi || 0; }
          pages.push(await canvasToJpegPage(c, quality)); // 编码完就释放原始 canvas
        });
        const blob = pagesToPdf(pages);
        entry.results.push({ name: base + '.pdf', blob, idx: 1 });
        entry.note = pages.length + ' 页 → PDF'
          + (capped ? '（页面太大，清晰度已自动降到约 ' + effDpi + '）' : '');
      } else {
        await eachPage(entry.file, dpi, async (c, info) => {
          if (info && info.capped) capped = true;
          const blob = await canvasToBlob(c, target, quality);
          entry.results.push({ name: base + '.' + target, blob, idx: entry.results.length + 1 });
        });
        const n = entry.results.length;
        if (n > 1) {
          for (const r of entry.results) r.name = base + '-第' + r.idx + '页.' + target;
        }
        entry.note = (n > 1 ? n + ' 张图片' : '完成') + (capped ? '（图太大，已按上限缩放）' : '');
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
