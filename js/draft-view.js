// Renders the editable draft: absolutely-positioned grid cells per page,
// with drag-and-drop photo swapping, inline caption editing, a manual per-page
// layout override, a movable text frame, a per-frame zoom/pan control, photo
// deletion, a page-number stamp, and a two-page spread view.

let dragSource = null; // { dayIdx, pageIdx, cellIdx }
let spreadView = false;

function setSpreadView(on, project, containerEl) {
  spreadView = on;
  renderDraft(project, containerEl);
}

function renderDraft(project, containerEl) {
  containerEl.innerHTML = "";
  containerEl.classList.toggle("spread-mode", spreadView);

  if (spreadView) renderSpreadMode(project, containerEl);
  else renderSingleMode(project, containerEl);
}

function renderSingleMode(project, containerEl) {
  let pageNum = 0;
  project.days.forEach((day, dayIdx) => {
    const heading = document.createElement("div");
    heading.className = "day-heading";
    heading.textContent = day.name;
    containerEl.appendChild(heading);

    day.pages.forEach((page, pageIdx) => {
      pageNum++;
      const wrap = buildPageWrap(project, containerEl, day, dayIdx, page, pageIdx, pageNum, `Page ${pageIdx + 1} of ${day.pages.length}`);
      containerEl.appendChild(wrap);
    });
  });
}

// Two pages per row, in the same global page-pairing the layout engine itself used to
// decide which layouts can't repeat — so what's paired here is exactly what will face
// each other in the printed book. This is a Hebrew album: the book reads right to
// left, so within each spread the earlier (lower-numbered) page sits on the right and
// the later one on the left — the opposite of a Western left-to-right book.
function renderSpreadMode(project, containerEl) {
  const flat = [];
  project.days.forEach((day, dayIdx) => {
    day.pages.forEach((page, pageIdx) => flat.push({ day, dayIdx, page, pageIdx }));
  });

  for (let i = 0; i < flat.length; i += 2) {
    const row = document.createElement("div");
    row.className = "spread-row";

    const earlier = flat[i];
    const earlierWrap = buildPageWrap(project, containerEl, earlier.day, earlier.dayIdx, earlier.page, earlier.pageIdx, i + 1, earlier.day.name);
    earlierWrap.classList.add("spread-page");

    const later = flat[i + 1];
    let laterWrap = null;
    if (later) {
      laterWrap = buildPageWrap(project, containerEl, later.day, later.dayIdx, later.page, later.pageIdx, i + 2, later.day.name);
      laterWrap.classList.add("spread-page");
    }

    // Right-to-left: append the later page first (so it lands on screen-left), then
    // the earlier page (screen-right) — mirroring a Hebrew book's page order.
    if (laterWrap) row.appendChild(laterWrap);
    row.appendChild(earlierWrap);

    containerEl.appendChild(row);
  }
}

function buildPageWrap(project, containerEl, day, dayIdx, page, pageIdx, globalPageNum, labelText) {
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";

  const labelRow = document.createElement("div");
  labelRow.className = "page-label-row";

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = labelText;
  labelRow.appendChild(label);

  const layoutPicker = document.createElement("select");
  layoutPicker.className = "layout-picker";
  layoutPicker.title = "Change this page's layout";
  GRIDS.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.id} (${g.cellCount} photos)`;
    if (g.id === page.layoutId) opt.selected = true;
    layoutPicker.appendChild(opt);
  });
  layoutPicker.addEventListener("change", () => {
    replanPageLayout(project, dayIdx, pageIdx, layoutPicker.value);
    renderDraft(project, containerEl);
  });
  labelRow.appendChild(layoutPicker);

  wrap.appendChild(labelRow);

  const pageEl = document.createElement("div");
  pageEl.className = "page";

  page.cells.forEach((cell, cellIdx) => {
    const geom = page.grid.cells[cellIdx];
    const cellEl = document.createElement("div");
    cellEl.className = "cell";
    cellEl.style.left = (geom.x * 100).toFixed(3) + "%";
    cellEl.style.top = (geom.y * 100).toFixed(3) + "%";
    cellEl.style.width = (geom.w * 100).toFixed(3) + "%";
    cellEl.style.height = (geom.h * 100).toFixed(3) + "%";
    cellEl.dataset.day = dayIdx;
    cellEl.dataset.page = pageIdx;
    cellEl.dataset.cell = cellIdx;

    if (cell.type === "photo") {
      buildPhotoCell(cellEl, project, containerEl, day, page, cell, dayIdx, pageIdx, cellIdx, geom);
    } else if (cell.type === "text") {
      cellEl.classList.add("text-cell");
      const ta = document.createElement("textarea");
      ta.placeholder = "Day title / notes (leave blank to print empty)";
      ta.value = cell.text || "";
      ta.addEventListener("input", () => {
        cell.text = ta.value;
      });
      cellEl.appendChild(ta);
    } else {
      cellEl.classList.add("empty-cell");
      cellEl.textContent = "empty";
      attachDropTarget(cellEl, project, containerEl, dayIdx, pageIdx, cellIdx);
    }

    pageEl.appendChild(cellEl);
  });

  const stamp = document.createElement("div");
  stamp.className = "page-number-stamp";
  stamp.textContent = String(globalPageNum);
  pageEl.appendChild(stamp);

  wrap.appendChild(pageEl);
  return wrap;
}

// Sizes/positions the <img> inside its (overflow-hidden) cell to match the crop
// rectangle computed by computeCropRect — purely with percentages, so it stays
// correct at any responsive page size with no pixel measurement needed.
function applyCrop(img, photo, geom, crop) {
  if (!photo.width || !photo.height) {
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.transform = "none";
    img.style.objectFit = "cover"; // dimensions unknown — best-effort fallback
    return;
  }
  const { sx, sy, sw, sh } = computeCropRect(photo.width, photo.height, geom.w, geom.h, crop);
  img.style.objectFit = "";
  img.style.width = (photo.width / sw) * 100 + "%";
  img.style.height = (photo.height / sh) * 100 + "%";
  img.style.transform = `translate(${-(sx / photo.width) * 100}%, ${-(sy / photo.height) * 100}%)`;
}

function buildPhotoCell(cellEl, project, containerEl, day, page, cell, dayIdx, pageIdx, cellIdx, geom) {
  const img = document.createElement("img");
  img.src = cell.photo.url;
  img.draggable = false; // avoid the browser's own native image drag fighting ours
  cellEl.appendChild(img);
  const applyNow = () => applyCrop(img, cell.photo, geom, cell.crop);
  if (img.complete) applyNow();
  else img.addEventListener("load", applyNow, { once: true });

  cellEl.draggable = true;
  cellEl.addEventListener("dragstart", (e) => {
    dragSource = { dayIdx, pageIdx, cellIdx };
    cellEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ""); // Firefox needs data set to allow the drag
  });
  cellEl.addEventListener("dragend", () => cellEl.classList.remove("dragging"));
  attachDropTarget(cellEl, project, containerEl, dayIdx, pageIdx, cellIdx);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "delete-photo-btn";
  deleteBtn.title = "Remove this photo from the album";
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm("Remove this photo from the album? The rest of the day will re-fill automatically.")) return;
    deletePhoto(project, dayIdx, pageIdx, cellIdx);
    renderDraft(project, containerEl);
  });
  cellEl.appendChild(deleteBtn);

  if (page.textSlot != null) {
    const makeTextBtn = document.createElement("button");
    makeTextBtn.type = "button";
    makeTextBtn.className = "make-text-btn";
    makeTextBtn.title = "Use this frame for text instead";
    makeTextBtn.textContent = "Aa";
    makeTextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setTextSlot(project, dayIdx, pageIdx, cellIdx);
      renderDraft(project, containerEl);
    });
    cellEl.appendChild(makeTextBtn);
  }

  const zoomBtn = document.createElement("button");
  zoomBtn.type = "button";
  zoomBtn.className = "zoom-btn";
  zoomBtn.title = "Zoom / reposition this photo";
  zoomBtn.textContent = "🔍";
  zoomBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openZoomEditor(cellEl, img, cell, geom, applyNow);
  });
  cellEl.appendChild(zoomBtn);
}

// Editing happens in a centered overlay sized for comfortable dragging, not inside
// the grid cell itself — a cell can be as short as ~100px on screen (thin layout
// strips), which isn't enough room for both the photo and the slider/buttons, let
// alone a visible, draggable image. The overlay shows the same photo at the same
// crop (via the same computeCropRect math as the small cell and the PDF export), just
// bigger; dragging there updates `cell.crop`, and `applyNow` keeps the small in-grid
// thumbnail live-synced on every change so both match exactly once you hit Done.
function openZoomEditor(cellEl, img, cell, geom, applyNow) {
  if (document.querySelector(".zoom-modal-backdrop")) return; // already open

  cell.crop = cell.crop || { zoom: 1, x: 0.5, y: 0.5 };

  const backdrop = document.createElement("div");
  backdrop.className = "zoom-modal-backdrop";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const modal = document.createElement("div");
  modal.className = "zoom-modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  const viewport = document.createElement("div");
  viewport.className = "zoom-modal-viewport";
  viewport.style.aspectRatio = `${geom.w} / ${geom.h}`;

  const bigImg = document.createElement("img");
  bigImg.src = cell.photo.url;
  bigImg.draggable = false;
  viewport.appendChild(bigImg);
  modal.appendChild(viewport);

  const applyBoth = () => {
    applyCrop(bigImg, cell.photo, geom, cell.crop);
    applyNow();
  };
  if (bigImg.complete) applyBoth();
  else bigImg.addEventListener("load", applyBoth, { once: true });

  const hint = document.createElement("div");
  hint.className = "zoom-hint";
  hint.textContent = "✥ Drag the photo to reposition it · slide to zoom";
  modal.appendChild(hint);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "1";
  slider.max = "3";
  slider.step = "0.05";
  slider.value = String(cell.crop.zoom);
  slider.className = "zoom-slider";
  slider.addEventListener("input", () => {
    cell.crop.zoom = parseFloat(slider.value);
    applyBoth();
  });
  modal.appendChild(slider);

  const btnRow = document.createElement("div");
  btnRow.className = "zoom-btn-row";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", () => {
    cell.crop = { zoom: 1, x: 0.5, y: 0.5 };
    slider.value = "1";
    applyBoth();
  });
  btnRow.appendChild(resetBtn);

  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", close);
  btnRow.appendChild(doneBtn);

  modal.appendChild(btnRow);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Drag directly on the enlarged photo to pan it.
  let dragging = false;
  let startPx = 0;
  let startPy = 0;
  let startCropX = 0;
  let startCropY = 0;

  bigImg.addEventListener("pointerdown", (e) => {
    dragging = true;
    bigImg.setPointerCapture(e.pointerId);
    startPx = e.clientX;
    startPy = e.clientY;
    startCropX = cell.crop.x;
    startCropY = cell.crop.y;
  });
  bigImg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = viewport.getBoundingClientRect();
    const { sw, sh } = computeCropRect(cell.photo.width, cell.photo.height, geom.w, geom.h, cell.crop);
    const scale = rect.width / sw; // screen px per image px
    const maxX = cell.photo.width - sw;
    const maxY = cell.photo.height - sh;
    const dxImg = (e.clientX - startPx) / scale;
    const dyImg = (e.clientY - startPy) / scale;
    cell.crop.x = maxX > 0 ? clamp01(startCropX - dxImg / maxX) : 0.5;
    cell.crop.y = maxY > 0 ? clamp01(startCropY - dyImg / maxY) : 0.5;
    applyBoth();
  });
  const endDrag = () => (dragging = false);
  bigImg.addEventListener("pointerup", endDrag);
  bigImg.addEventListener("pointercancel", endDrag);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function attachDropTarget(cellEl, project, containerEl, dayIdx, pageIdx, cellIdx) {
  cellEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    cellEl.classList.add("dragover");
  });
  cellEl.addEventListener("dragleave", () => cellEl.classList.remove("dragover"));
  cellEl.addEventListener("drop", (e) => {
    e.preventDefault();
    cellEl.classList.remove("dragover");
    if (!dragSource) return;
    const target = { dayIdx, pageIdx, cellIdx };
    swapCells(project, dragSource, target);
    dragSource = null;
    renderDraft(project, containerEl);
  });
}

// Only photo and blank cells are ever droppable/draggable (see renderDraft),
// so a swap here never needs to touch a 'text' cell. Crop is cell-specific (tuned to
// that cell's shape), so it's dropped on both sides rather than carried along.
function swapCells(project, a, b) {
  const cellA = project.days[a.dayIdx].pages[a.pageIdx].cells[a.cellIdx];
  const cellB = project.days[b.dayIdx].pages[b.pageIdx].cells[b.cellIdx];
  const tmp = { type: cellA.type, photo: cellA.photo };
  cellA.type = cellB.type;
  cellA.photo = cellB.photo;
  cellA.crop = undefined;
  cellB.type = tmp.type;
  cellB.photo = tmp.photo;
  cellB.crop = undefined;
}
