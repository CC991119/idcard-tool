// 把多张 canvas 合成 PDF (直接写 PDF 结构, 无外部依赖)
// 每张图独占一页, 页面尺寸按图片比例设定

function toAscii(str) {
  let out = '';
  for (const ch of str) out += ch.charCodeAt(0) < 128 ? ch : '?';
  return out;
}

async function canvasToJpegBytes(canvas, quality) {
  // JPG 不支持透明, 垫白底避免黑块
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('无法生成图片数据');
  return new Uint8Array(await blob.arrayBuffer());
}

// 把一张 canvas 编码成 PDF 用的 JPEG 页 (垫白底)
export async function canvasToJpegPage(canvas, quality = 0.92) {
  const bytes = await canvasToJpegBytes(canvas, quality);
  return { bytes, w: canvas.width, h: canvas.height };
}

// 用"已编码好的页面"组装 PDF (不再持有原始 canvas -> 内存占用低很多)
export function pagesToPdf(pages) {
  if (!pages.length) throw new Error('没有可用的页面');
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;

  const push = (bytes) => {
    chunks.push(bytes);
    pos += bytes.length;
  };
  const pushStr = (s) => push(enc.encode(s));

  const pageCount = pages.length;
  const objCount = 2 + pageCount * 3;
  const startObj = (n) => { offsets[n] = pos; pushStr(n + ' 0 obj\n'); };
  const endObj = () => pushStr('endobj\n');

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  // 用 96dpi 折算成点, 让 A4 附近的图接近实际纸张大小
  for (const p of pages) {
    p.wPt = (p.w / 96) * 72;
    p.hPt = (p.h / 96) * 72;
  }

  startObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  const kids = pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
  startObj(2);
  pushStr('<< /Type /Pages /Count ' + pageCount + ' /Kids [' + kids + '] >>\n');
  endObj();

  pages.forEach((p, i) => {
    const pageObj = 3 + i * 3;
    const contentObj = pageObj + 1;
    const imgObj = pageObj + 2;
    startObj(pageObj);
    pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.wPt.toFixed(2) + ' ' + p.hPt.toFixed(2) + ']'
      + ' /Resources << /XObject << /Im0 ' + imgObj + ' 0 R >> >>'
      + ' /Contents ' + contentObj + ' 0 R >>\n');
    endObj();

    const stream = 'q\n' + p.wPt.toFixed(2) + ' 0 0 ' + p.hPt.toFixed(2) + ' 0 0 cm\n/Im0 Do\nQ\n';
    startObj(contentObj);
    pushStr('<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream\n');
    endObj();

    startObj(imgObj);
    pushStr('<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h
      + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.bytes.length + ' >>\nstream\n');
    push(p.bytes);
    pushStr('\nendstream\n');
    endObj();
  });

  const xrefPos = pos;
  let xref = 'xref\n0 ' + (objCount + 1) + '\n0000000000 65535 f \n';
  for (let n = 1; n <= objCount; n++) {
    xref += String(offsets[n] ?? 0).padStart(10, '0') + ' 00000 n \n';
  }
  pushStr(xref);
  pushStr('trailer\n<< /Size ' + (objCount + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');

  return new Blob(chunks, { type: 'application/pdf' });
}

export async function canvasesToPdf(canvases, quality = 0.92) {
  const pages = [];
  for (const c of canvases) pages.push(await canvasToJpegPage(c, quality));
  return pagesToPdf(pages);
}
