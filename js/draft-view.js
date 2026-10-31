// Renders the editable draft: absolutely-positioned grid cells per page,
// with drag-and-drop photo swapping, inline caption editing, a manual per-page
// layout override, a movable text frame, and a per-frame zoom/pan control.

let dragSource = null; // { dayIdx, pageIdx, cellIdx }

function renderDraft(project, containerEl) {
  containerEl.innerHTML = "";

  project.days.forEach((day, dayIdx) => {
    const heading = document.createElement("div");
    heading.className = "day-heading";
    heading.textContent = day.name;
    containerEl.appendChild(heading);

    day.pages.forEach((page, pageIdx) => {
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";

      const labelRow = document.createElement("div");
      labelRow.className = "page-label-row";

      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = `Page ${pageIdx + 1} of ${day.pages.length}`;
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
          attachDropTarget(cellEl, project, dayIdx, pageIdx, cellIdx);
        }

        pageEl.appendChild(cellEl);
      });

      wrap.appendChild(pageEl);
      containerEl.appendChild(wrap);
    });
  });
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
  attachDropTarget(cellEl, project, dayIdx, pageIdx, cellIdx);

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

function openZoomEditor(cellEl, img, cell, geom, applyNow) {
  if (cellEl.querySelector(".zoom-editor")) return; // already open
  cellEl.classList.add("editing");
  cellEl.draggable = false; // pointer-drag below is for panning, not cell-swap

  cell.crop = cell.crop || { zoom: 1, x: 0.5, y: 0.5 };

  const editor = document.createElement("div");
  editor.className = "zoom-editor";
  editor.addEventListener("click", (e) => e.stopPropagation());
  editor.addEventListener("dragstart", (e) => e.preventDefault());

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "1";
  slider.max = "3";
  slider.step = "0.05";
  slider.value = String(cell.crop.zoom);
  slider.className = "zoom-slider";
  slider.addEventListener("input", () => {
    cell.crop.zoom = parseFloat(slider.value);
    applyNow();
  });
  editor.appendChild(slider);

  const btnRow = document.createElement("div");
  btnRow.className = "zoom-btn-row";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", () => {
    cell.crop = { zoom: 1, x: 0.5, y: 0.5 };
    slider.value = "1";
    applyNow();
  });
  btnRow.appendChild(resetBtn);

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => {
    editor.remove();
    cellEl.classList.remove("editing");
    cellEl.draggable = true;
  });
  btnRow.appendChild(doneBtn);

  editor.appendChild(btnRow);
  cellEl.appendChild(editor);

  // Drag directly on the photo to pan it, while in edit mode.
  let dragging = false;
  let startPx = 0;
  let startPy = 0;
  let startCropX = 0;
  let startCropY = 0;

  img.addEventListener("pointerdown", (e) => {
    if (!cellEl.classList.contains("editing")) return;
    dragging = true;
    img.setPointerCapture(e.pointerId);
    startPx = e.clientX;
    startPy = e.clientY;
    startCropX = cell.crop.x;
    startCropY = cell.crop.y;
  });
  img.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = cellEl.getBoundingClientRect();
    const { sw, sh } = computeCropRect(cell.photo.width, cell.photo.height, geom.w, geom.h, cell.crop);
    const scale = rect.width / sw; // screen px per image px
    const maxX = cell.photo.width - sw;
    const maxY = cell.photo.height - sh;
    const dxImg = (e.clientX - startPx) / scale;
    const dyImg = (e.clientY - startPy) / scale;
    cell.crop.x = maxX > 0 ? clamp01(startCropX - dxImg / maxX) : 0.5;
    cell.crop.y = maxY > 0 ? clamp01(startCropY - dyImg / maxY) : 0.5;
    applyNow();
  });
  const endDrag = () => (dragging = false);
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function attachDropTarget(cellEl, project, dayIdx, pageIdx, cellIdx) {
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
    renderDraft(project, document.getElementById("pages"));
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
