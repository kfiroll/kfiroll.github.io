// Assigns photos into grid-page layouts for each day, then across the whole book.
//
// Rules (from the user):
//  - Photos are placed strictly in sorted (filename) order into grid cells in reading
//    order (left-to-right, top-to-bottom) — no other sorting logic.
//  - The first page of each day reserves one cell as an empty text/caption area.
//  - Every page must be fully filled with photos except that one reserved text cell —
//    no leftover blank photo cells.
//  - The book is viewed as two-page spreads (page 1+2, 3+4, ...). The two pages of a
//    spread never use the same grid layout.
//
// Some photo counts only have ONE exact-fill page capacity available (e.g. 9 photos
// only fits the 3x3 grid), so a short-sighted page-by-page choice can walk itself into
// a spread where both sides are forced to the same layout even though a different
// (slightly longer) page split would have avoided it. So this plans the whole book —
// every day back to back — as a single shortest-path search: minimize same-layout
// spreads first, and use the fewest pages only as a tiebreaker among equally good
// options. Ties beyond that are broken at random (reseeded on every call) so the
// "Reshuffle" button and a fresh "New Album" run can land on a genuinely different,
// equally valid arrangement instead of the same one every time.

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Same landscape/portrait/square split used for both photos and grid cells, so a
// photo's shape can be matched to a cell's shape.
function categorizeAspect(w, h) {
  const r = w / h;
  if (r > 1.2) return "landscape";
  if (r < 0.83) return "portrait";
  return "square";
}

// Layouts grouped by how many photos they can hold.
const NONFIRST_CAPACITY_GROUPS = {}; // cellCount -> [grid, ...]
const FIRST_CAPACITY_GROUPS = {}; // (cellCount - 1) -> [grid, ...]
GRIDS.forEach((g) => {
  g.cells.forEach((c) => (c.cat = categorizeAspect(c.w, c.h))); // page is square, so w/h fractions are directly comparable
  (NONFIRST_CAPACITY_GROUPS[g.cellCount] ||= []).push(g);
  const firstCap = g.cellCount - 1;
  if (firstCap > 0) (FIRST_CAPACITY_GROUPS[firstCap] ||= []).push(g);
});
const FIRST_CAPS = Object.keys(FIRST_CAPACITY_GROUPS).map(Number); // e.g. [1,2,3,4,5,6,7,8]
const NONFIRST_CAPS = Object.keys(NONFIRST_CAPACITY_GROUPS).map(Number); // e.g. [1,2,3,4,5,6,7,8,9]
// The smallest capacity in each range — not hardcoded, because adding a smaller grid
// (e.g. a 1 or 2-photo layout) should lower these automatically rather than silently
// staying stuck at whatever the minimum used to be.
const MIN_FIRST_CAP = Math.min(...FIRST_CAPS);
const MIN_NONFIRST_CAP = Math.min(...NONFIRST_CAPS);

// Assigns a fixed set of photos to a grid's cells — same photos, same page, but
// matched to each cell's shape (landscape cell <- landscape photo, etc.) instead of
// just dropped in left-to-right order, so a tall portrait doesn't get crushed into a
// wide cell. Square cells are flexible and get whatever's left. Within a shape match,
// earlier-sorted photos are preferred first, so the original (filename) order is
// disturbed as little as possible — this is a per-page fit decision, not a resort.
function assignPhotosToCells(grid, photos, textSlot) {
  const photoSlots = grid.cells.map((c, i) => ({ i, cat: c.cat })).filter((s) => s.i !== textSlot);
  // Pickiest cells (non-square) placed first, since square cells accept anything.
  const order = photoSlots.slice().sort((a, b) => (a.cat === "square") - (b.cat === "square"));

  const pool = photos.slice();
  const placement = new Array(grid.cellCount).fill(null);
  for (const slot of order) {
    if (pool.length === 0) break;
    let idx = -1;
    if (slot.cat !== "square") idx = pool.findIndex((p) => p.cat === slot.cat);
    if (idx === -1) idx = pool.findIndex((p) => p.cat === "square");
    if (idx === -1) idx = 0; // no shape match left at all — take the next one anyway
    placement[slot.i] = pool.splice(idx, 1)[0];
  }
  return placement;
}

// `textSlot`: cell index to reserve for text, or null for a page with no text cell at
// all. Defaults to the grid's own suggested slot on first pages.
function buildPage(grid, photos, isFirst, textSlot) {
  const slot = isFirst ? textSlot ?? grid.defaultTextSlot : null;
  const placement = assignPhotosToCells(grid, photos, slot);
  const cells = [];
  for (let i = 0; i < grid.cellCount; i++) {
    if (i === slot) {
      cells.push({ type: "text", text: "" });
    } else if (placement[i]) {
      cells.push({ type: "photo", photo: placement[i] });
    } else {
      cells.push({ type: "blank" });
    }
  }
  return { layoutId: grid.id, grid, cells, textSlot: slot };
}

// True if cost is strictly better than `best`'s, or an equally-good tie that wins a
// coin flip. Page count is deliberately NOT a tiebreaker — minimizing it systematically
// favored a handful of large-capacity layouts and starved the rest of the set, so a
// plain random choice among equally spread-safe options is what actually gives variety
// across all the layouts in Grid_Design.pdf.
function isBetter(cost, best) {
  if (!best) return true;
  if (cost !== best.cost) return cost < best.cost;
  return Math.random() < 0.5;
}

// Builds the whole project plan: array of { dayName, pages }.
// days: [{ name, photos: [...] }]
function planProject(days) {
  const dayLens = days.map((d) => d.photos.length);
  const memo = new Map();

  // parity: 0 = this page starts a fresh spread (left side), 1 = right side of the
  // spread that began with prevId's page.
  function solve(dayIdx, remaining, parity, prevId) {
    if (dayIdx >= days.length) return { cost: 0, steps: [] };
    if (remaining === 0) return solve(dayIdx + 1, dayLens[dayIdx + 1] ?? 0, parity, prevId);

    const isFirst = remaining === dayLens[dayIdx];

    if (remaining < MIN_FIRST_CAP) {
      // Degenerate day: not enough photos for any template's smallest photo capacity.
      // One page, best-effort — the only case where blank cells are unavoidable.
      const grid = FIRST_CAPACITY_GROUPS[MIN_FIRST_CAP][0];
      const collision = parity === 1 && grid.id === prevId ? 1 : 0;
      const sub = solve(dayIdx, 0, (parity + 1) % 2, grid.id);
      return { cost: collision + sub.cost, steps: [{ dayIdx, cap: remaining, grid, isFirst }, ...sub.steps] };
    }

    const k = dayIdx + "|" + remaining + "|" + parity + "|" + prevId;
    if (memo.has(k)) return memo.get(k);

    const capRange = isFirst ? FIRST_CAPS : NONFIRST_CAPS;
    const groups = isFirst ? FIRST_CAPACITY_GROUPS : NONFIRST_CAPACITY_GROUPS;

    let best = null;
    for (const cap of capRange) {
      if (cap > remaining) continue;
      const leftover = remaining - cap;
      if (leftover !== 0 && leftover < MIN_NONFIRST_CAP) continue; // would strand leftover photos
      for (const grid of groups[cap]) {
        const collision = parity === 1 && grid.id === prevId ? 1 : 0;
        const sub = solve(dayIdx, leftover, (parity + 1) % 2, grid.id);
        const cost = collision + sub.cost;
        if (isBetter(cost, best)) {
          best = { cost, steps: [{ dayIdx, cap, grid, isFirst }, ...sub.steps] };
        }
      }
    }
    memo.set(k, best);
    return best;
  }

  const solved = solve(0, dayLens[0] ?? 0, 0, null);

  const result = days.map((d) => ({ dayName: d.name, pages: [] }));
  const cursors = days.map(() => 0);
  solved.steps.forEach((s) => {
    const photos = days[s.dayIdx].photos.slice(cursors[s.dayIdx], cursors[s.dayIdx] + s.cap);
    cursors[s.dayIdx] += photos.length;
    result[s.dayIdx].pages.push(buildPage(s.grid, photos, s.isFirst));
  });
  return result;
}

// ---------------------------------------------------------------------------
// Manual "change this page's layout" support.
// ---------------------------------------------------------------------------

// Same shortest-path idea as planProject's solve(), but scoped to a run of always-
// "non-first" (no text slot) pages — used to replan everything *after* a page whose
// layout the user picked by hand.
function solveTail(remaining, parity, prevId, memo) {
  if (remaining === 0) return { cost: 0, steps: [] };
  if (remaining < MIN_NONFIRST_CAP) {
    const grid = NONFIRST_CAPACITY_GROUPS[MIN_NONFIRST_CAP][0];
    const collision = parity === 1 && grid.id === prevId ? 1 : 0;
    return { cost: collision, steps: [{ cap: remaining, grid, isFirst: false }] };
  }

  const k = remaining + "|" + parity + "|" + prevId;
  if (memo.has(k)) return memo.get(k);

  let best = null;
  for (const cap of NONFIRST_CAPS) {
    if (cap > remaining) continue;
    const leftover = remaining - cap;
    if (leftover !== 0 && leftover < MIN_NONFIRST_CAP) continue;
    for (const grid of NONFIRST_CAPACITY_GROUPS[cap]) {
      const collision = parity === 1 && grid.id === prevId ? 1 : 0;
      const sub = solveTail(leftover, (parity + 1) % 2, grid.id, memo);
      const cost = collision + sub.cost;
      if (isBetter(cost, best)) {
        best = { cost, steps: [{ cap, grid, isFirst: false }, ...sub.steps] };
      }
    }
  }
  memo.set(k, best);
  return best;
}

function globalPageIndex(project, dayIdx, pageIdx) {
  let idx = 0;
  for (let d = 0; d < dayIdx; d++) idx += project.days[d].pages.length;
  return idx + pageIdx;
}

// Re-lays-out day `dayIdx` from page `pageIdx` onward: page `pageIdx` becomes
// `newGridId` (the user's explicit choice — always honored, even if it happens to
// collide with its spread partner), and every later page in that day is replanned so
// the whole day is still fully filled with photos and spread-safe where possible.
// Mutates `project` in place.
function replanPageLayout(project, dayIdx, pageIdx, newGridId) {
  const day = project.days[dayIdx];
  const newGrid = GRIDS.find((g) => g.id === newGridId);
  const isFirstPinned = pageIdx === 0;

  const tailPhotos = [];
  for (let i = pageIdx; i < day.pages.length; i++) {
    day.pages[i].cells.forEach((c) => {
      if (c.type === "photo") tailPhotos.push(c.photo);
    });
  }

  const capacity = newGrid.cellCount - (isFirstPinned ? 1 : 0);
  const pinnedPhotos = tailPhotos.slice(0, capacity);
  const rest = tailPhotos.slice(capacity);

  const globalIdx = globalPageIndex(project, dayIdx, pageIdx);
  const parityAfterPinned = (globalIdx + 1) % 2;
  const tailSolved = solveTail(rest.length, parityAfterPinned, newGridId, new Map());

  const newPages = day.pages.slice(0, pageIdx);
  newPages.push(buildPage(newGrid, pinnedPhotos, isFirstPinned));
  let cursor = 0;
  tailSolved.steps.forEach((s) => {
    const photos = rest.slice(cursor, cursor + s.cap);
    cursor += photos.length;
    newPages.push(buildPage(s.grid, photos, false));
  });

  day.pages = newPages;
}

// Moves the text frame on a page to a different cell: the chosen cell becomes text
// (its photo is freed back into the pool) and whatever cell was text before becomes a
// photo cell again. The page's photo set doesn't change — only where the text frame
// sits — so every other page in the book is untouched; the freed photo set is simply
// re-matched to the page's (now different) set of photo-shaped cells via the same
// landscape/portrait/square fit used everywhere else. Mutates `project` in place.
function setTextSlot(project, dayIdx, pageIdx, newTextCellIndex) {
  const page = project.days[dayIdx].pages[pageIdx];
  const oldText = page.cells.find((c) => c.type === "text");
  if (!oldText) return; // this page has no text frame to move (not a day's first page)

  const photos = page.cells.filter((c) => c.type === "photo").map((c) => c.photo);
  const rebuilt = buildPage(page.grid, photos, true, newTextCellIndex);
  rebuilt.cells[newTextCellIndex].text = oldText.text;
  project.days[dayIdx].pages[pageIdx] = rebuilt;
}

// The layout id of the page immediately before (dayIdx, pageIdx) in the whole book —
// possibly the last page of an earlier day. null if this is the very first page.
function prevPageLayoutId(project, dayIdx, pageIdx) {
  if (pageIdx > 0) return project.days[dayIdx].pages[pageIdx - 1].layoutId;
  for (let d = dayIdx - 1; d >= 0; d--) {
    const pages = project.days[d].pages;
    if (pages.length > 0) return pages[pages.length - 1].layoutId;
  }
  return null;
}

// Plans a run of pages for `photosLength` photos starting at (dayIdx, pageIdx)'s
// position in the book: if `isFirstPage`, the first page gets a text slot (reusing
// solveTail, which already does the rest, for everything after it) — otherwise it's
// just solveTail outright. Shared by deletePhoto below.
function solveDayFrom(photosLength, isFirstPage, parity, prevId) {
  if (!isFirstPage) return solveTail(photosLength, parity, prevId, new Map());

  if (photosLength < MIN_FIRST_CAP) {
    const grid = FIRST_CAPACITY_GROUPS[MIN_FIRST_CAP][0];
    const collision = parity === 1 && grid.id === prevId ? 1 : 0;
    return { cost: collision, steps: [{ cap: photosLength, grid, isFirst: true }] };
  }

  let best = null;
  for (const cap of FIRST_CAPS) {
    if (cap > photosLength) continue;
    const leftover = photosLength - cap;
    if (leftover !== 0 && leftover < MIN_NONFIRST_CAP) continue;
    for (const grid of FIRST_CAPACITY_GROUPS[cap]) {
      const collision = parity === 1 && grid.id === prevId ? 1 : 0;
      const sub = solveTail(leftover, (parity + 1) % 2, grid.id, new Map());
      const cost = collision + sub.cost;
      if (isBetter(cost, best)) {
        best = { cost, steps: [{ cap, grid, isFirst: true }, ...sub.steps] };
      }
    }
  }
  return best;
}

// Removes one photo from the album entirely and replans day `dayIdx` from the page it
// was on, so the day stays fully filled with photos (no leftover blank cells) just
// like everywhere else — pages before it are untouched. Mutates `project` in place.
function deletePhoto(project, dayIdx, pageIdx, cellIdx) {
  const day = project.days[dayIdx];
  const page = day.pages[pageIdx];
  const deletedPhoto = page.cells[cellIdx].photo;
  const isFirstPage = pageIdx === 0;
  const oldText = page.cells.find((c) => c.type === "text");

  const tailPhotos = [];
  for (let i = pageIdx; i < day.pages.length; i++) {
    day.pages[i].cells.forEach((c) => {
      if (c.type === "photo" && c.photo !== deletedPhoto) tailPhotos.push(c.photo);
    });
  }

  if (tailPhotos.length === 0) {
    day.pages = isFirstPage ? [buildPage(page.grid, [], true, oldText ? page.textSlot : undefined)] : day.pages.slice(0, pageIdx);
    if (isFirstPage && oldText) day.pages[0].cells[day.pages[0].textSlot].text = oldText.text;
    return;
  }

  const parity = globalPageIndex(project, dayIdx, pageIdx) % 2;
  const prevId = prevPageLayoutId(project, dayIdx, pageIdx);
  const solved = solveDayFrom(tailPhotos.length, isFirstPage, parity, prevId);

  const newPages = day.pages.slice(0, pageIdx);
  let cursor = 0;
  solved.steps.forEach((s) => {
    const photos = tailPhotos.slice(cursor, cursor + s.cap);
    cursor += photos.length;
    const built = buildPage(s.grid, photos, s.isFirst);
    if (s.isFirst && oldText) built.cells[built.textSlot].text = oldText.text;
    newPages.push(built);
  });
  day.pages = newPages;
}

// Exchanges the positions of two pages — possibly in different days. Used both for
// "flip this spread" (swap its left and right page) and for drag-to-reorder (drop a
// page onto another to swap them, same gesture as swapping two photos). A manual
// swap is always honored even if it happens to create a same-layout spread or move a
// page out of chronological order — that's the user's deliberate call, same as every
// other manual override in this file. Mutates `project` in place.
function swapPages(project, a, b) {
  const dayA = project.days[a.dayIdx];
  const dayB = project.days[b.dayIdx];
  const tmp = dayA.pages[a.pageIdx];
  dayA.pages[a.pageIdx] = dayB.pages[b.pageIdx];
  dayB.pages[b.pageIdx] = tmp;
}
