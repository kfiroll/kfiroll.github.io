// Rasterizes each page at 200 DPI onto a canvas (cells cropped to fill, "cover" style,
// exactly matching the grid geometry taken from Grid_Design.pdf) and assembles a PDF
// via pdf-lib. The grid itself (js/grids.js) is stored as 0-1 fractions of the page,
// so it's physical-size-agnostic — exportPdf takes `sizeCm` (e.g. 30 or 20) and
// everything scales from that one number.

const DPI = 200;

function pageSizePt(sizeCm) {
  return (sizeCm / 2.54) * 72;
}
function pagePx(sizeCm) {
  return Math.round((pageSizePt(sizeCm) / 72) * DPI);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

const DEFAULT_CROP = { zoom: 1, x: 0.5, y: 0.5 };

// The source rectangle (in the image's own pixels) that gets drawn into a dw x dh
// cell. zoom=1 is the plain "cover" fit (crops only the dimension that overflows);
// zoom>1 shows a smaller, more zoomed-in slice. x/y (0-1) pan that slice around the
// full image — not just within the zoom=1 crop — so at higher zoom you can reach any
// part of the photo, not only what the default center-crop happened to keep. This is
// the single source of truth for cropping — both the draft preview (via CSS
// transform) and the final PDF render call it, so what you see is what prints.
function computeCropRect(imgW, imgH, dw, dh, crop) {
  const { zoom, x, y } = crop || DEFAULT_CROP;
  const targetAspect = dw / dh;
  const imgAspect = imgW / imgH;
  let baseW, baseH;
  if (imgAspect > targetAspect) {
    baseH = imgH;
    baseW = baseH * targetAspect;
  } else {
    baseW = imgW;
    baseH = baseW / targetAspect;
  }
  const sw = baseW / zoom;
  const sh = baseH / zoom;
  const maxX = imgW - sw;
  const maxY = imgH - sh;
  return { sx: x * maxX, sy: y * maxY, sw, sh };
}

function drawCover(ctx, img, dx, dy, dw, dh, crop) {
  const { sx, sy, sw, sh } = computeCropRect(img.width, img.height, dw, dh, crop);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCoverPage(albumTitle, dayCount, px) {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);

  ctx.fillStyle = "#2a2622";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(px * 0.07)}px Georgia, serif`;
  ctx.fillText(albumTitle || "Trip Album", px / 2, px / 2 - px * 0.02);

  ctx.fillStyle = "#b5651d";
  ctx.font = `${Math.round(px * 0.025)}px Georgia, serif`;
  ctx.fillText(`${dayCount} day${dayCount === 1 ? "" : "s"}`, px / 2, px / 2 + px * 0.05);

  return canvas;
}

async function drawGridPage(page, pageNumber, px) {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);

  for (let i = 0; i < page.cells.length; i++) {
    const cell = page.cells[i];
    const geom = page.grid.cells[i];
    const dx = Math.round(geom.x * px);
    const dy = Math.round(geom.y * px);
    const dw = Math.round(geom.w * px);
    const dh = Math.round(geom.h * px);

    if (cell.type === "photo") {
      const img = await loadImage(cell.photo.url);
      drawCover(ctx, img, dx, dy, dw, dh, cell.crop);
    } else if (cell.type === "text") {
      const text = (cell.text || "").trim();
      if (text) {
        const pad = Math.round(px * 0.012);
        ctx.fillStyle = "#3a2d18";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const fontSize = Math.round(px * 0.022);
        ctx.font = `${fontSize}px Georgia, serif`;
        const lineHeight = fontSize * 1.35;
        const maxWidth = dw - pad * 2;
        const lines = text.split("\n").flatMap((l) => (l ? wrapText(ctx, l, maxWidth) : [""]));
        let ly = dy + pad;
        for (const line of lines) {
          if (ly + lineHeight > dy + dh) break;
          ctx.fillText(line, dx + pad, ly);
          ly += lineHeight;
        }
      }
      // blank text cell -> left empty (white), as requested
    }
    // 'blank' cells are left empty
  }

  if (pageNumber != null) {
    ctx.fillStyle = "#9a9284";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `${Math.round(px * 0.014)}px Georgia, serif`;
    ctx.fillText(String(pageNumber), px / 2, px - px * 0.028);
  }

  return canvas;
}

// JPEG at high quality: full photo detail is preserved for print, but unlike PNG it
// doesn't balloon the PDF to hundreds of MB once real (non-flat) photos are involved.
function canvasToJpegBytes(canvas, quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/jpeg", quality);
  });
}

function makeThumbnail(canvas, size) {
  const t = document.createElement("canvas");
  t.width = size;
  t.height = size;
  t.getContext("2d").drawImage(canvas, 0, 0, size, size);
  return t.toDataURL("image/jpeg", 0.85);
}

async function exportPdf(project, albumTitle, sizeCm, onProgress) {
  const ptVal = pageSizePt(sizeCm);
  const pxVal = pagePx(sizeCm);
  const pdfDoc = await PDFLib.PDFDocument.create();

  const cover = drawCoverPage(albumTitle, project.days.length, pxVal);
  const thumbnailDataUrl = makeThumbnail(cover, 160);
  const coverBytes = await canvasToJpegBytes(cover);
  const coverImg = await pdfDoc.embedJpg(coverBytes);
  const coverPage = pdfDoc.addPage([ptVal, ptVal]);
  coverPage.drawImage(coverImg, { x: 0, y: 0, width: ptVal, height: ptVal });

  let totalPages = project.days.reduce((n, d) => n + d.pages.length, 0);
  let done = 0;

  for (const day of project.days) {
    for (const page of day.pages) {
      const canvas = await drawGridPage(page, done + 1, pxVal);
      const bytes = await canvasToJpegBytes(canvas);
      const img = await pdfDoc.embedJpg(bytes);
      const pdfPage = pdfDoc.addPage([ptVal, ptVal]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: ptVal, height: ptVal });
      done++;
      if (onProgress) onProgress(done, totalPages);
    }
  }

  const bytes = await pdfDoc.save();
  return { bytes, thumbnailDataUrl };
}
