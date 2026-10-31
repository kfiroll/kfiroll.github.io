// App shell: tabs, zip ingestion, day grouping, and wiring the draft/export/history
// views. Runs as one independent instance per album size (see ALBUM_SIZES) — each
// gets its own New Album / Draft / History sub-tabs, cloned from the same <template>,
// so adding a third size later is one more entry here, not a rewrite.

const ALBUM_SIZES = [
  { id: "30", cm: 30, label: "30×30 cm" },
  { id: "20", cm: 20, label: "20×20 cm" },
];

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
  heic: "image/heic", heif: "image/heif",
};

// ---------- Top-level size tabs ----------
document.querySelectorAll(".size-tabs .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchSize(btn.dataset.size));
});
function switchSize(sizeId) {
  document.querySelectorAll(".size-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.size === sizeId));
  document.querySelectorAll(".size-panel").forEach((p) => p.classList.toggle("active", p.dataset.sizePanel === sizeId));
}

// ---------- One context per size, cloned from the shared template ----------
const sizePanelTemplate = document.getElementById("sizePanelTemplate");
const sizePanelsRoot = document.getElementById("sizePanels");

const sizeContexts = ALBUM_SIZES.map((size, i) => {
  const panel = sizePanelTemplate.content.firstElementChild.cloneNode(true);
  panel.dataset.sizePanel = size.id;
  panel.classList.toggle("active", i === 0);
  sizePanelsRoot.appendChild(panel);
  return createSizeContext(size, panel);
});

function createSizeContext(size, panel) {
  const el = (name) => panel.querySelector(`[data-el="${name}"]`);
  const ctx = {
    size, // { id, cm, label }
    panel,
    sourceDays: null, // [{ name, photos }] — untouched, used to (re)build the project
    project: null, // { title, days: [{ name, pages }] }
    skippedFiles: [],
    spreadViewOn: false,
    dropzone: el("dropzone"),
    fileInput: el("fileInput"),
    loadStatus: el("loadStatus"),
    projectSetup: el("projectSetup"),
    albumTitleInput: el("albumTitle"),
    dayListEl: el("dayList"),
    buildDraftBtn: el("buildDraftBtn"),
    draftEmpty: el("draftEmpty"),
    draftToolbar: el("draftToolbar"),
    draftTitleEl: el("draftTitle"),
    pagesEl: el("pages"),
    rebuildBtn: el("rebuildBtn"),
    approveBtn: el("approveBtn"),
    spreadViewBtn: el("spreadViewBtn"),
    historyEmpty: el("historyEmpty"),
    historyList: el("historyList"),
  };

  panel.querySelectorAll(".subtabs .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSubtab(ctx, btn.dataset.subtab));
  });

  wireDropzone(ctx);
  wireDraft(ctx);
  wireExport(ctx);

  renderHistory(ctx);
  return ctx;
}

function switchSubtab(ctx, name) {
  ctx.panel.querySelectorAll(".subtabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.subtab === name));
  ctx.panel.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.subpanel === name));
  if (name === "history") renderHistory(ctx);
}

function setStatus(ctx, msg) {
  ctx.loadStatus.hidden = false;
  ctx.loadStatus.textContent = msg;
}

// ---------- Dropzone ----------
function wireDropzone(ctx) {
  ctx.dropzone.addEventListener("click", () => ctx.fileInput.click());
  ctx.fileInput.addEventListener("change", () => {
    if (ctx.fileInput.files[0]) handleZipFile(ctx, ctx.fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((evt) =>
    ctx.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      ctx.dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    ctx.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      ctx.dropzone.classList.remove("drag");
    })
  );
  ctx.dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleZipFile(ctx, f);
  });
}

async function handleZipFile(ctx, file) {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    setStatus(ctx, "Please drop a .zip file.");
    return;
  }
  ctx.projectSetup.hidden = true;
  setStatus(ctx, "Reading zip…");
  ctx.skippedFiles = [];

  try {
    const zip = await JSZip.loadAsync(file);
    const entries = [];
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      const base = relPath.split("/").pop();
      if (!base || base.startsWith(".") || relPath.includes("__MACOSX")) return;
      if (!IMAGE_EXT.test(base)) {
        ctx.skippedFiles.push(relPath);
        return;
      }
      entries.push({ path: relPath, entry });
    });

    if (entries.length === 0) {
      setStatus(ctx, "No supported images (jpg/png/webp/gif/bmp/heic) found in that zip.");
      return;
    }

    const heicCount = entries.filter((e) => HEIC_EXT.test(e.path)).length;
    const loaded = [];
    let i = 0;
    for (const { path, entry } of entries) {
      i++;
      const ext = path.split(".").pop().toLowerCase();
      setStatus(
        ctx,
        heicCount > 0
          ? `Extracting & converting photos… ${i}/${entries.length}${HEIC_EXT.test(path) ? " (HEIC → JPEG)" : ""}`
          : `Extracting photo(s)… ${i}/${entries.length}`
      );
      const buf = await entry.async("arraybuffer");
      let blob = new Blob([buf], { type: MIME_BY_EXT[ext] || "application/octet-stream" });

      if (HEIC_EXT.test(path)) {
        try {
          blob = await heic2any({ blob, toType: "image/jpeg", quality: 0.9 });
          if (Array.isArray(blob)) blob = blob[0]; // live-photo HEIC: use the still frame
        } catch (err) {
          if (err && err.code === 1) {
            // Some iPhone exports carry a .heic extension but the bytes are already
            // a browser-readable format (e.g. JPEG) — just use them as-is.
            blob = new Blob([buf], { type: "image/jpeg" });
          } else {
            console.warn("HEIC conversion failed for", path, err);
            ctx.skippedFiles.push(path + " (unreadable HEIC — couldn't be converted)");
            continue;
          }
        }
      }
      loaded.push({ segments: path.split("/").filter(Boolean), blob });
    }

    ctx.sourceDays = groupByDay(loaded);
    await classifyPhotoShapes(ctx, ctx.sourceDays);
    renderDayList(ctx, ctx.sourceDays);
    const title = file.name.replace(/\.zip$/i, "");
    ctx.albumTitleInput.value = title;
    ctx.projectSetup.hidden = false;
    const extra = ctx.skippedFiles.length ? ` (${ctx.skippedFiles.length} non-image file(s) skipped)` : "";
    setStatus(ctx, `Loaded ${loaded.length} photo(s) across ${ctx.sourceDays.length} day(s).${extra}`);
  } catch (err) {
    console.error(err);
    setStatus(ctx, "Could not read that zip: " + err.message);
  }
}

// Groups extracted files into days based on folder structure.
// Strips a common single wrapping folder (e.g. the zip's own top folder) if present,
// then uses the first remaining path segment as the day name. Flat zips (no day
// folders) become a single day named after the last stripped wrapper, or "Day 1".
// Pure — shared by every size context.
function groupByDay(loaded) {
  let items = loaded.map((l) => ({ segs: l.segments.slice(), blob: l.blob }));
  let lastWrapper = null;

  while (true) {
    if (items.every((it) => it.segs.length > 1)) {
      const firstSegs = new Set(items.map((it) => it.segs[0]));
      if (firstSegs.size === 1) {
        lastWrapper = [...firstSegs][0];
        items.forEach((it) => it.segs.shift());
        continue;
      }
    }
    break;
  }

  const groups = new Map();
  for (const it of items) {
    const isFlat = it.segs.length === 1;
    const dayName = isFlat ? lastWrapper || "Day 1" : it.segs[0];
    const fileName = it.segs[it.segs.length - 1];
    if (!groups.has(dayName)) groups.set(dayName, []);
    groups.get(dayName).push({ name: fileName, blob: it.blob });
  }

  const days = [...groups.entries()].map(([name, files]) => {
    files.sort((a, b) => naturalCompare(a.name, b.name));
    const photos = files.map((f) => ({ name: f.name, blob: f.blob, url: URL.createObjectURL(f.blob) }));
    return { name, photos };
  });
  days.sort((a, b) => naturalCompare(a.name, b.name));
  return days;
}

// Reads each photo's real (post-EXIF-rotation) dimensions so the layout engine can
// match landscape/portrait/square photos to similarly-shaped grid cells instead of
// just dropping them in left-to-right order.
async function classifyPhotoShapes(ctx, days) {
  const total = days.reduce((n, d) => n + d.photos.length, 0);
  let done = 0;
  for (const day of days) {
    for (const photo of day.photos) {
      done++;
      setStatus(ctx, `Checking photo shapes… ${done}/${total}`);
      try {
        const img = await loadImage(photo.url);
        photo.width = img.naturalWidth;
        photo.height = img.naturalHeight;
        photo.cat = categorizeAspect(photo.width, photo.height);
      } catch {
        photo.cat = "square"; // unreadable dimensions — treat as flexible
      }
    }
  }
}

function renderDayList(ctx, days) {
  ctx.dayListEl.innerHTML = "";
  days.forEach((day) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = day.name;
    const count = document.createElement("span");
    count.className = "day-count";
    count.textContent = `${day.photos.length} photo${day.photos.length === 1 ? "" : "s"}`;
    li.appendChild(name);
    li.appendChild(count);
    ctx.dayListEl.appendChild(li);
  });
}

// ---------- Draft ----------
function wireDraft(ctx) {
  ctx.buildDraftBtn.addEventListener("click", () => {
    if (!ctx.sourceDays) return;
    buildProject(ctx);
    switchSubtab(ctx, "draft");
  });

  ctx.rebuildBtn.addEventListener("click", () => {
    if (!ctx.sourceDays) return;
    buildProject(ctx);
  });

  ctx.spreadViewBtn.addEventListener("click", () => {
    if (!ctx.project) return;
    ctx.spreadViewOn = !ctx.spreadViewOn;
    ctx.spreadViewBtn.textContent = ctx.spreadViewOn ? "Single page view" : "Spread view";
    ctx.spreadViewBtn.classList.toggle("active", ctx.spreadViewOn);
    setSpreadView(ctx.spreadViewOn, ctx.project, ctx.pagesEl);
  });
}

function buildProject(ctx) {
  const title = ctx.albumTitleInput.value.trim() || "Trip Album";
  const planned = planProject(ctx.sourceDays.map((d) => ({ name: d.name, photos: d.photos.slice() })));
  ctx.project = {
    title,
    days: planned.map((p) => ({ name: p.dayName, pages: p.pages })),
  };
  ctx.draftEmpty.hidden = true;
  ctx.draftToolbar.hidden = false;
  ctx.draftTitleEl.textContent = ctx.project.title;
  renderDraft(ctx.project, ctx.pagesEl);
}

// ---------- Export ----------
const overlay = document.getElementById("exportOverlay"); // shared: only one export runs at a time
const exportMsg = document.getElementById("exportMsg");

function wireExport(ctx) {
  ctx.approveBtn.addEventListener("click", async () => {
    if (!ctx.project) return;
    overlay.hidden = false;
    exportMsg.textContent = "Rendering pages…";
    ctx.approveBtn.disabled = true;
    try {
      const { bytes, thumbnailDataUrl } = await exportPdf(ctx.project, ctx.project.title, ctx.size.cm, (done, total) => {
        exportMsg.textContent = `Rendering pages… ${done}/${total}`;
      });
      const pdfBlob = new Blob([bytes], { type: "application/pdf" });

      const pageCount = ctx.project.days.reduce((n, d) => n + d.pages.length, 0) + 1;
      const record = {
        id: "album-" + Date.now(),
        title: ctx.project.title,
        createdAt: Date.now(),
        dayCount: ctx.project.days.length,
        pageCount,
        sizeCm: ctx.size.cm,
        thumbnail: thumbnailDataUrl,
        pdfBlob,
      };
      await AlbumDB.add(record);
      downloadBlob(pdfBlob, sanitizeFileName(ctx.project.title) + ".pdf");
      exportMsg.textContent = "Done! PDF downloaded and saved to History.";
      setTimeout(() => {
        overlay.hidden = true;
        switchSubtab(ctx, "history");
      }, 900);
    } catch (err) {
      console.error(err);
      exportMsg.textContent = "Export failed: " + err.message;
      setTimeout(() => (overlay.hidden = true), 2000);
    } finally {
      ctx.approveBtn.disabled = false;
    }
  });
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "album";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- History ----------
// One shared IndexedDB store, filtered per size (older records saved before sizeCm
// existed are treated as 30cm, since that was the only size at the time).
async function renderHistory(ctx) {
  const all = await AlbumDB.all();
  const records = all.filter((r) => (r.sizeCm ?? 30) === ctx.size.cm);
  ctx.historyList.innerHTML = "";
  ctx.historyEmpty.hidden = records.length > 0;
  for (const r of records) {
    const li = document.createElement("li");
    li.className = "history-item";

    const thumb = document.createElement("img");
    thumb.className = "history-thumb";
    thumb.src = r.thumbnail;
    li.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const t = document.createElement("div");
    t.className = "h-title";
    t.textContent = r.title;
    const sub = document.createElement("div");
    sub.className = "h-sub";
    sub.textContent = `${new Date(r.createdAt).toLocaleString()} · ${r.dayCount} day(s) · ${r.pageCount} pages`;
    meta.appendChild(t);
    meta.appendChild(sub);
    li.appendChild(meta);

    const dlBtn = document.createElement("button");
    dlBtn.className = "primary-btn";
    dlBtn.textContent = "Download";
    dlBtn.addEventListener("click", () => downloadBlob(r.pdfBlob, sanitizeFileName(r.title) + ".pdf"));
    li.appendChild(dlBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "ghost-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      await AlbumDB.remove(r.id);
      renderHistory(ctx);
    });
    li.appendChild(delBtn);

    ctx.historyList.appendChild(li);
  }
}
