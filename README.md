# PCBSpy

A fully client-side (no backend) web tool for stacking images as layers,
transforming each **non-destructively** — including 4-corner perspective
correction — annotating with vector shapes/markers, and saving/loading the whole
project as a single `.zip` on your local file system.

## Run it

It's plain static HTML/JS/CSS. Either:

- **Just open `index.html`** in a modern browser (Chrome/Edge/Firefox), or
- Serve the folder from any static host / local server, e.g.:

```bash
python -m http.server 8000
```

then visit `http://localhost:8000`.

> The File System Access API (native Save/Open dialogs) needs Chrome/Edge over
> `http(s)://` or `file://`. On other browsers the tool automatically falls back
> to a normal download + file-picker. `JSZip` is loaded from a CDN — to run fully
> offline, download `jszip.min.js` next to `index.html` and update the `<script>`
> tag in `index.html`.

## How it works

- **Rendering is lossless & GPU-based.** Each layer's decoded image is uploaded
  **once** as a WebGL texture. A layer's placement is a single 3×3 homography
  matrix; every frame the layer is drawn as a textured quad through that matrix.
  Pixels are never baked or read-back-and-rewritten. Zooming resamples each
  layer's native-resolution texture, so cropped/small layers stay sharp to their
  own resolution.
- **Perspective-correct** freeform: the shader hand-sets `gl_Position.w` from the
  homography's homogeneous term so the GPU interpolates texture coordinates
  projectively (not just per-triangle affine).

## Tools

**Navigation**
- **Pan** (`H`) — drag to move the view; scroll to zoom (toward the cursor).
  `Space`+drag or middle-mouse pans in any tool. **Fit** frames the active layer.

**Layer transform** (acts on the *active* layer — click one in the panel):
- **Move** (`M`), **Scale** (`S`, about center), **Rotate** (`R`, about center),
  **Flip** (Horizontal / Vertical buttons), **Freeform** (`F`) — drag the 4
  corner handles independently to solve a perspective homography.

**Annotate** (vector layer above the images):
- **Select** (`V`) — click to select; drag to move; drag a selected rectangle's
  corners to resize; `Delete`/`Backspace` removes; `Esc` deselects.
- **Point** (`P`), **Rectangle** (`B`).
- **Marker** (`K`) — click an existing point or rectangle to attach a marker.
  A marker has a `shortName` (always shown) and a `description` (edit/read popup;
  click the marker with Select to reopen). The label box is draggable.

**Board side (top / bottom / through)** — every annotation carries a `side`
(`top` / `bottom` / `through`), a `size`, and an optional `color`. Selecting an
annotate tool opens a **tool-options popover** (Side T/B/⊕, Size S/M/L + number,
Color grid) that stamps everything you draw with that tool; each tool button
shows a side letter + colour dot so you can confirm before placing. Vias/holes
default to **through** (shown on every side); other kinds default to **top**.
**Right-click** any annotation to change its Side / Colour or Delete it.

The right **Annotate** panel is grouped by side (TOP / BOTTOM / THROUGH), each
with a master eye (one-click show/hide the whole side) and expandable per-kind
rows. Through marks ignore the top/bottom eyes. Electrically, a **line only
connects nodes on its own side** — top and bottom traces that merely cross no
longer merge into one net; only **through vias bridge sides**.

**Layer panel** — reorder (▲/▼, top = front), per-layer opacity slider,
show/hide (◉/○), select (click), delete (✕). The active layer also exposes a
collapsible **Adjustments** section (Brightness, Contrast, Saturation, Hue,
Sharpen/Soften) applied live in the shader.

## Landmark alignment (experimental)

**⧉ Align layers** (top bar) opens a guided wizard to align one layer onto
another by matching features:

1. **Pick layers** — a fixed **Top** (reference) and a **Bottom** (moving).
2. **Prepare** — optionally flip the Bottom layer H/V if it's mirror-reversed.
3. **Placement** — for each landmark, click the feature on the **Top** image,
   then the matching feature on the **Bottom** image. Use 5–8 pairs, spread
   across the board. Arrow keys nudge the selected point (Shift = 5px), Delete
   removes it.
4. **Review** — *Compute Alignment* solves a least-squares homography (normalized
   DLT) mapping the Bottom features onto the Top features and applies it to the
   Bottom layer; *Accept* keeps it. Undo/Redo/Start Over/Cancel are available
   throughout (Cancel restores the layer's original transform).

The Top layer is the common reference and never moves; the Bottom layer's
matrix is replaced with the solved homography. Landmarks on the Bottom layer are
stored in its own source space, so recompute is stable.

## Project file (`.zip`)

- `project.json` — version, camera (`cx,cy,zoom`), and per layer:
  `id, name, filename, opacity, visible, matrix` (row-major 3×3, source→world).
  Plus all annotation shapes and marker links/text.
- `images/` — each original uploaded file stored **verbatim** (STORE, no
  re-encoding — source compression preserved byte-for-byte).

At runtime each image is decoded once via `createImageBitmap` (off the main
thread), uploaded to a texture, and its original blob is kept aside only so it
can be re-saved unchanged.

## Footprints

**▦ Add Footprint** (top bar) opens a picker of KiCad footprints and places the
chosen one as a **layer**.

- Footprints are real KiCad `.kicad_mod` files in `/footprints`, listed in
  `/footprints/index.json`. A curated starter set is bundled (R/C 0402–1206,
  SOT-23, SOIC-8, QFN-16, 0.1in headers, and a BGA-153 / eMMC).
- They're parsed in-browser and rendered **simplified / monochrome** (copper
  pads filled, silkscreen + fab outline stroked, drill holes punched) onto a
  canvas, then placed as an ordinary **rasterized image layer** — so every layer
  tool applies (move / scale / rotate / flip / freeform perspective, opacity and
  color adjustments) and it saves into the project as a PNG.
- Place it, then scale/align it onto your board photo. Its pads can anchor nets
  by dropping Pad/Via dots on them.

Add more by copying `.kicad_mod` files into `/footprints` and adding entries to
`index.json` (`{ "name", "category", "file" }`). Over http(s) the picker reads
`/footprints` live. When the page is opened directly from disk (`file://`),
browsers block fetching local files, so the picker falls back to an embedded
copy in `js/footprints-data.js` — regenerate it after adding footprints with:

```bash
python tools/gen_footprints_data.py
```

## Nets (experimental)

Turns the dot/line annotations into a simple electrical model for PCB tracing.

- **Nodes** are electrical dots: Via, Hole, Ground, Vcc (Tags are labels only).
- **Edges** are lines: each line connects the dot under its **first** vertex to
  the dot under its **last** vertex (2-terminal). Line endpoints snap onto dots
  while drawing. Connectivity is transitive through shared dots.
- **Premade nets**: every Ground dot is on **GND**, every Vcc dot is on **VCC**;
  any dot connected to one inherits that net.
- **Named nets**: pick the **⚡ Nets** tool, click a dot, and assign/create a net
  (e.g. `CLK`, `DATA0`) in the **Nets** panel — the whole connected group adopts
  it. Click an existing net in the list to assign the selected dot to it.
- **Color by net** overlays a coloured halo on each electrical dot and colours the
  connecting traces by net (gray dashed = a node with no net yet).
- **Shorts** are flagged (⚠) when one group carries two different nets — GND+VCC,
  or two different named nets.

Net assignments are saved in `project.json` (per-dot `net` field).

## Out of scope

Exporting a flattened/rendered image (by design — the tool is non-destructive).

## Files

| File | Role |
|------|------|
| `index.html` | Layout: toolbar, canvases, layer panel, marker popup |
| `css/style.css` | Styling |
| `js/mat3.js` | 3×3 matrix math + 4-point homography (DLT) solver |
| `js/renderer.js` | WebGL renderer (perspective-correct textured quads) |
| `js/annotations.js` | Vector annotation model, rendering, hit-testing |
| `js/persistence.js` | `.zip` save/load (File System Access + fallback) |
| `js/app.js` | State, camera, layers, transforms, interaction, UI wiring |
