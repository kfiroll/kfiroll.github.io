// App shell: tabs, zip ingestion, day grouping, and wiring the draft/export/history views.

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
  heic: "image/heic", heif: "image/heif",
};

let sourceDays = null; // [{ name, photos: [{name, url, blob}] }] — untouched, used to (re)build the project
let project = null; // { title, days: [{ name, pages }] }
let skippedFiles = [];

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "history") renderHistory();
}

// ---------- Dropzone ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const loadStatus = document.getElementById("loadStatus");
const projectSetup = document.getElementById("projectSetup");
const dayListEl = document.getElementById("dayList");
const albumTitleInput = document.getElementById("albumTitle");

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleZipFile(fileInput.files[0]);
});
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleZipFile(f);
});

function setStatus(msg) {
  loadStatus.hidden = false;
  loadStatus.textContent = msg;
}

async function handleZipFile(file) {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    setStatus("Please drop a .zip file.");
    return;
  }
  projectSetup.hidden = true;
  setStatus("Reading zip…");
  skippedFiles = [];

  try {
    const zip = await JSZip.loadAsync(file);
    const entries = [];
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      const base = relPath.split("/").pop();
      if (!base || base.startsWith(".") || relPath.includes("__MACOSX")) return;
      if (!IMAGE_EXT.test(base)) {
        skippedFiles.push(relPath);
        return;
      }
      entries.push({ path: relPath, entry });
    });

    if (entries.length === 0) {
      setStatus("No supported images (jpg/png/webp/gif/bmp/heic) found in that zip.");
      return;
    }

    const heicCount = entries.filter((e) => HEIC_EXT.test(e.path)).length;
    const loaded = [];
    let i = 0;
    for (const { path, entry } of entries) {
      i++;
      const ext = path.split(".").pop().toLowerCase();
      setStatus(
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
            skippedFiles.push(path + " (unreadable HEIC — couldn't be converted)");
            continue;
          }
        }
      }
      loaded.push({ segments: path.split("/").filter(Boolean), blob });
    }

    sourceDays = groupByDay(loaded);
    await classifyPhotoShapes(sourceDays);
    renderDayList(sourceDays);
    const title = file.name.replace(/\.zip$/i, "");
    albumTitleInput.value = title;
    projectSetup.hidden = false;
    const extra = skippedFiles.length ? ` (${skippedFiles.length} non-image file(s) skipped)` : "";
    setStatus(`Loaded ${loaded.length} photo(s) across ${sourceDays.length} day(s).${extra}`);
  } catch (err) {
    console.error(err);
    setStatus("Could not read that zip: " + err.message);
  }
}

// Groups extracted files into days based on folder structure.
// Strips a common single wrapping folder (e.g. the zip's own top folder) if present,
// then uses the first remaining path segment as the day name. Flat zips (no day
// folders) become a single day named after the last stripped wrapper, or "Day 1".
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
async function classifyPhotoShapes(days) {
  const total = days.reduce((n, d) => n + d.photos.length, 0);
  let done = 0;
  for (const day of days) {
    for (const photo of day.photos) {
      done++;
      setStatus(`Checking photo shapes… ${done}/${total}`);
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

function renderDayList(days) {
  dayListEl.innerHTML = "";
  days.forEach((day) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = day.name;
    const count = document.createElement("span");
    count.className = "day-count";
    count.textContent = `${day.photos.length} photo${day.photos.length === 1 ? "" : "s"}`;
    li.appendChild(name);
    li.appendChild(count);
    dayListEl.appendChild(li);
  });
}

// ---------- Draft ----------
const buildDraftBtn = document.getElementById("buildDraftBtn");
const draftEmpty = document.getElementById("draftEmpty");
const draftToolbar = document.getElementById("draftToolbar");
const draftTitleEl = document.getElementById("draftTitle");
const pagesEl = document.getElementById("pages");
const rebuildBtn = document.getElementById("rebuildBtn");
const approveBtn = document.getElementById("approveBtn");

buildDraftBtn.addEventListener("click", () => {
  if (!sourceDays) return;
  buildProject();
  switchTab("draft");
});

function buildProject() {
  const title = albumTitleInput.value.trim() || "Trip Album";
  const planned = planProject(sourceDays.map((d) => ({ name: d.name, photos: d.photos.slice() })));
  project = {
    title,
    days: planned.map((p) => ({ name: p.dayName, pages: p.pages })),
  };
  draftEmpty.hidden = true;
  draftToolbar.hidden = false;
  draftTitleEl.textContent = project.title;
  renderDraft(project, pagesEl);
}

rebuildBtn.addEventListener("click", () => {
  if (!sourceDays) return;
  buildProject();
});

// ---------- Export ----------
const overlay = document.getElementById("exportOverlay");
const exportMsg = document.getElementById("exportMsg");

approveBtn.addEventListener("click", async () => {
  if (!project) return;
  overlay.hidden = false;
  exportMsg.textContent = "Rendering pages…";
  approveBtn.disabled = true;
  try {
    const { bytes, thumbnailDataUrl } = await exportPdf(project, project.title, (done, total) => {
      exportMsg.textContent = `Rendering pages… ${done}/${total}`;
    });
    const pdfBlob = new Blob([bytes], { type: "application/pdf" });

    const pageCount = project.days.reduce((n, d) => n + d.pages.length, 0) + 1;
    const record = {
      id: "album-" + Date.now(),
      title: project.title,
      createdAt: Date.now(),
      dayCount: project.days.length,
      pageCount,
      thumbnail: thumbnailDataUrl,
      pdfBlob,
    };
    await AlbumDB.add(record);
    downloadBlob(pdfBlob, sanitizeFileName(project.title) + ".pdf");
    exportMsg.textContent = "Done! PDF downloaded and saved to History.";
    setTimeout(() => {
      overlay.hidden = true;
      switchTab("history");
    }, 900);
  } catch (err) {
    console.error(err);
    exportMsg.textContent = "Export failed: " + err.message;
    setTimeout(() => (overlay.hidden = true), 2000);
  } finally {
    approveBtn.disabled = false;
  }
});

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
const historyEmpty = document.getElementById("historyEmpty");
const historyList = document.getElementById("historyList");

async function renderHistory() {
  const records = await AlbumDB.all();
  historyList.innerHTML = "";
  historyEmpty.hidden = records.length > 0;
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
      renderHistory();
    });
    li.appendChild(delBtn);

    historyList.appendChild(li);
  }
}

renderHistory();
