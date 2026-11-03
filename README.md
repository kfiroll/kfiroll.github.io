# Trip Album Builder

A local-first web app that turns a zip of trip photos into a print-ready,
200 DPI photobook PDF — no server, no account, no upload. Drop a zip, get a
draft you can edit, approve, and export.

**Live:** https://kfiroll.github.io/

## What it does

0. **Pick a size.** Two top-level tabs — 30×30 cm and 20×20 cm — each with its
   own independent New Album / Draft / History flow and its own History list.
   Same 16 templates at both sizes (the grid is stored as 0-1 fractions of the
   page, not fixed measurements, so it's physical-size-agnostic — see below).
1. **Drop a zip.** Folders inside it = days (`Day 1 - Hanoi/`, `Day 2 - Halong Bay/`, ...).
2. **It builds a draft.** Every photo is laid out onto one of 16 fixed grid
   templates — 10 traced from an actual print-shop template PDF
   (`Grid_Design.pdf`), plus 6 simple hand-authored "picture count" layouts
   (1 full page; 2 as tall columns or wide rows; 3 as tall columns; 4 as a
   2×2 grid or wide rows) matching the same margins — filling every
   cell with a photo except one reserved text frame per day. No photo is
   ever left out, no cell is ever left blank except that one.
3. **You edit the draft.** Drag photos to swap them, change a page's layout,
   move the text frame to a different cell, zoom/pan/flip within any frame
   (plus fine arrow-key nudging for precise positioning), delete a photo,
   drag whole pages to reorder them, preview as two-page spreads (right-to-
   left, for a Hebrew book) with a one-click button to swap a spread's left
   and right page.
4. **Approve → export.** Renders every page to a canvas at exactly 200 DPI for
   the selected size (2362×2362px at 30cm, 1575×1575px at 20cm) and assembles
   a PDF with pdf-lib. Saved to that size's own History
   tab (IndexedDB) with a thumbnail for re-download later.

## Why it's built the way it is

- **No build step.** Plain `<script>` tags, vendored libraries
  (`vendor/jszip.min.js`, `pdf-lib.min.js`, `heic2any.min.js`), opens by
  double-clicking `index.html`. The target user is not a developer.
- **Nothing leaves the browser.** Zip parsing, HEIC→JPEG conversion, layout,
  rendering, and PDF assembly all happen client-side. Photos never touch a
  server — which is also why this is safe to host publicly on GitHub Pages.
- **The grid is the constraint, not a suggestion.** 10 of the 16 templates
  came from measuring an actual PDF (`Grid_Design.pdf`), not invented; the
  other 6 are simple picture-count layouts added later, built to the same
  margin convention. Every layout decision works *within* those shapes
  rather than generating new ones.

## The layout algorithm (the interesting part)

This is the part worth reusing. Three rules, all enforced together:

1. **Every page fully filled** — no blank photo cells except the one text
   frame per day. Given a fixed set of templates with known cell counts
   (1–9 photos each), picking a page size is really a bin-packing problem:
   find a sequence of template capacities that sums exactly to a day's
   photo count. (The minimum capacity isn't hardcoded anywhere — it's
   derived from whatever's in `GRIDS`, so adding a smaller template, like
   the 1-photo layout, automatically fixes edge cases like "a day with only
   2 photos" instead of needing a separate code change.)
2. **Two-page spreads never repeat a layout.** The book is planned as one
   continuous sequence of spreads (page pairs), not day-by-day, because a
   day boundary can fall in the middle of a spread. Some photo counts (e.g.
   exactly 9) fit only one template, so avoiding a same-layout spread
   sometimes means a different split a page earlier — a short-sighted
   greedy choice can paint itself into a corner. Solved with a **memoized
   shortest-path search** over `(day, photos-remaining, spread-side,
   previous-layout)`, minimizing same-layout spreads first and treating page
   count as a non-issue (deliberately *not* minimized — see below).
3. **Shape-matched placement, not sequence placement.** Within a page, photos
   are assigned to cells by landscape/portrait/square category (matching
   each cell's own aspect ratio), not left-to-right by filename — a tall
   portrait photo no longer gets crushed into a wide cell. The *set* of
   photos on a page is still strictly chronological; only which specific
   cell each one lands in is shape-aware.

One early bug worth knowing about if you reuse this: minimizing total page
count as a tiebreaker systematically starved out several of the 10
templates (it kept picking the same few high-capacity ones). Dropping that
tiebreaker in favor of a random choice among equally-valid options fixed it
— "fewest pages" was never actually a requirement, just an assumption that
crept in.

**Manual overrides reuse the same engine**, scoped smaller:
- Changing one page's layout by hand → replans *that day* from that page
  onward (`replanPageLayout`).
- Moving the text frame to a different cell → re-matches that page's photos
  to its new cell shapes (`setTextSlot`).
- Deleting a photo → replans the day from that page onward with one fewer
  photo (`deletePhoto`), same machinery as the layout override.

## Photo crop control

Every photo defaults to a centered "cover" crop (fill the cell, crop the
overflow). Per-photo zoom/pan is a `{zoom, x, y}` object stored on the cell
(not the photo — a crop tuned for one frame's shape doesn't carry to
another). `computeCropRect()` in `pdf-export.js` is the single source of
truth for the crop math; the draft preview (CSS `transform`, percentage-based
so it survives any responsive resize) and the final PDF (canvas
`drawImage`) both call it, so what you see is exactly what prints.

One lesson here too: the editor UI first lived *inside* the grid cell, which
broke silently on short/thin cells (a 110px-tall cell is shorter than a
slider + two buttons, so the controls covered the whole photo and dragging
had nothing to grab). Fixed by moving editing into a centered modal,
decoupled from the cell's actual rendered size.

## File structure

```
album-tool/
  index.html           size tabs, a <template> cloned once per album size,
                         each clone holding its own New Album/Draft/History
  css/style.css         all styling, light theme only
  js/
    grids.js            the 10 grid templates (normalized 0–1 cell coords,
                         extracted from Grid_Design.pdf via PyMuPDF) — no
                         physical size baked in, works at any page size
    layout-engine.js     the bin-packing + spread-safe search, shape matching,
                         manual-override replanning (the core logic)
    draft-view.js        all DOM rendering for the editable draft, drag/drop,
                         zoom modal, spread view
    pdf-export.js         canvas rendering + crop math + pdf-lib assembly +
                         page-number stamping, parametrized by `sizeCm`
    app.js                ALBUM_SIZES config, one isolated "context" object
                         per size (own sourceDays/project/DOM refs), zip
                         ingestion, HEIC conversion, day grouping, History
                         (IndexedDB, filtered per size), wiring
    db.js                 tiny IndexedDB wrapper
  vendor/                JSZip, pdf-lib, heic2any (vendored, not CDN —
                         works fully offline)
```

No `node_modules`, no `package.json`, no bundler. `grids.js` is the only
generated file (by a one-off Python script against the source PDF, not
checked in). Adding a third album size is one line in `ALBUM_SIZES`
(`js/app.js`) — the `<template>` clones itself per entry, so nothing else
needs touching.

## Known limitations

- A day with fewer than 4 photos can't fill even the smallest template
  (minimum photo capacity is 4) — leaves some blank cells, unavoidable.
- 3 of ~35 real-world HEIC files in testing used a libheif-unsupported
  variant (burst/depth-map HEIC) and get skipped with a warning.
- The exported PDF's page order is always sequential (1, 2, 3...); only the
  on-screen Spread View mirrors right-to-left. Whether a given printer needs
  the file itself pre-reversed for RTL binding depends on that printer.

---

## Reusing this for a different project

The grid-fitting engine (`layout-engine.js`) is the genuinely reusable part
— everything else is UI around it. To adapt this for a different use case:

**What transfers directly:**
- The bin-packing + spread-safe search (`solve`/`solveTail`/`isBetter`) —
  works for any fixed set of "templates" with known capacities, not just
  these 10 grids.
- The shape-matching placement (`assignPhotosToCells`) — any time you're
  filling fixed-shape slots from a pool of variable-shape items.
- The crop system (`computeCropRect` + percentage-based CSS transform) —
  reusable for any "crop this image into that box, let the user adjust"
  need.
- The zip → classify → plan → draft → export pipeline shape in general.

**What you'd change for a new use case:**
- `grids.js` — swap in a different set of template geometries (different
  page size, different cell counts/shapes). Everything downstream adapts
  automatically since nothing hardcodes "10" or specific cell counts.
- The "one text frame per group" rule in `buildPage`/`planProject` is
  specific to "day" grouping — a different domain might not group photos at
  all, or group by something else, or not need a text frame.
- `pdf-export.js`'s physical page size (currently 30×30cm / 850.39pt) and
  DPI (200) are constants at the top of the file.
- The HEIC-conversion and EXIF-orientation handling (`app.js`) is
  trip-photo-specific; drop it if the new use case has different input
  constraints (e.g. already-JPEG assets).

Tell me the new use case and what should change, and I'll scope it from
here rather than starting from scratch.
