/* app.js — orchestration: state, camera, layers, transforms, interaction,
   UI wiring, render loop, save/load. Depends on Mat3, Renderer, Annotations,
   Persistence (loaded before this file). No modules, so it runs from file://. */
(function () {
  'use strict';

  // Source quad in normalized texture space (TL, TR, BR, BL).
  const SRC = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const TRANSFORM_TOOLS = ['move', 'scale', 'rotate', 'flip', 'freeform'];
  const POINT_TOOLS = ['via', 'tag', 'hole', 'pad', 'ground', 'vcc']; // each places a point of that kind
  const CROSSHAIR_TOOLS = ['via', 'tag', 'hole', 'pad', 'ground', 'vcc', 'rect', 'quad', 'line', 'marker']; // full-view guide cross
  const HANDLE_HIT = 10; // px radius for grabbing corner handles

  const App = {
    // state
    renderer: null,
    ann: null,
    layers: [],              // index 0 = bottom, last = top
    activeId: null,
    blobs: new Map(),        // filename -> original Blob (for re-saving)
    usedNames: new Set(),
    camera: { cx: 0, cy: 0, zoom: 1 },
    tool: 'pan',
    pointSizes: { via: 8, tag: 8, hole: 8, pad: 8, ground: 8, vcc: 8 }, // per-kind absolute size (image units)
    selected: null,          // annotation selection { kind, id }
    cursor: null,            // last pointer position (screen px) for the guide cross
    adjustExpanded: false,   // layer color-adjustments section collapsed by default
    rectStart: null,         // first corner (world) while drawing a two-click rectangle
    quadPts: null,           // clicked corners (world) while drawing a freeform quad
    linePts: null,           // vertices (world) while drawing a polyline
    _lastLineClick: null,    // for double-click-to-finish detection
    undoStack: [],           // history snapshots (annotations + layer state)
    redoStack: [],
    drag: null,
    preview: null,
    spaceDown: false,
    dirty: true,
    W: 0, H: 0, dpr: 1,

    init() {
      this.glCanvas = document.getElementById('glCanvas');
      this.overlay = document.getElementById('overlay');
      this.octx = this.overlay.getContext('2d');
      this.stage = document.getElementById('stage');
      this.layerPanel = document.getElementById('layerList');
      this.hintEl = document.getElementById('hint');
      this.popup = document.getElementById('markerPopup');

      try {
        this.renderer = new Renderer(this.glCanvas);
      } catch (e) {
        this.fatal(e.message);
        return;
      }
      this.ann = new Annotations();
      this.align = new Align(this);
      this.nets = new Nets(this);
      this.footprints = new Footprints(this);

      this.cam = {
        worldToScreen: (p) => [
          (p[0] - this.camera.cx) * this.camera.zoom + this.W / 2,
          (p[1] - this.camera.cy) * this.camera.zoom + this.H / 2,
        ],
        screenToWorld: (p) => [
          (p[0] - this.W / 2) / this.camera.zoom + this.camera.cx,
          (p[1] - this.H / 2) / this.camera.zoom + this.camera.cy,
        ],
      };

      this.bindUI();
      this.bindPointer();
      this.bindKeys();

      window.addEventListener('resize', () => this.resize());
      this.resize();
      this.loop();
      this.setTool('pan');
      this.renderAnnotateView();
      this.updateReadout();
      this.hint('Add images to begin. Scroll to zoom, drag with Pan to move the view.');
    },

    fatal(msg) {
      const el = document.getElementById('hint');
      if (el) el.textContent = 'Error: ' + msg;
      alert('Error: ' + msg);
    },

    // ---------------- rendering ----------------
    scheduleRender() { this.dirty = true; },

    // Render every frame. On-demand rendering (only when `dirty`) left the WebGL
    // canvas showing a stale/previous frame when the cursor moved over other
    // elements without triggering a redraw (esp. with preserveDrawingBuffer off),
    // which looked like the zoom "jumping" between two states. Continuous
    // rendering keeps the canvas in sync with the camera at all times.
    loop() {
      this.render();
      requestAnimationFrame(() => this.loop());
    },

    camMatrix() {
      const { cx, cy, zoom } = this.camera;
      const W = this.W, H = this.H;
      return [
        2 * zoom / W, 0, -2 * zoom / W * cx,
        0, -2 * zoom / H, 2 * zoom / H * cy,
        0, 0, 1,
      ];
    },

    render() {
      this.renderer.draw(this.camMatrix(), this.layers);
      this.drawOverlay();
    },

    drawOverlay() {
      const ctx = this.octx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);

      // Annotations
      this.ann.draw(ctx, this.cam, this.selected);
      // Net overlay (halos + net-coloured traces) when enabled
      this.nets.draw(ctx, this.cam);

      // Live rectangle preview while drawing
      if (this.preview && this.preview.type === 'rect') {
        const p = this.preview;
        const a = this.cam.worldToScreen([p.x, p.y]);
        const b = this.cam.worldToScreen([p.x + p.w, p.y + p.h]);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#5aa0ff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
          Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        ctx.restore();
      }

      // Live polyline preview: placed vertices + rubber-band to the cursor.
      if (this.preview && this.preview.type === 'line') {
        const pts = this.preview.pts.map(p => this.cam.worldToScreen(p));
        const chain = this.preview.cursor ? pts.concat([this.cam.worldToScreen(this.preview.cursor)]) : pts;
        ctx.save();
        ctx.strokeStyle = '#ff9f43';
        ctx.lineWidth = 2;
        if (chain.length >= 2) {
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(chain[0][0], chain[0][1]);
          for (let i = 1; i < chain.length; i++) ctx.lineTo(chain[i][0], chain[i][1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fillStyle = '#ff9f43'; ctx.fill(); }
        ctx.restore();
      }

      // Live freeform-quad preview: placed corners + rubber-band to the cursor.
      if (this.preview && this.preview.type === 'quad') {
        const pts = this.preview.pts.map(p => this.cam.worldToScreen(p));
        const chain = this.preview.cursor ? pts.concat([this.cam.worldToScreen(this.preview.cursor)]) : pts;
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#b07cff';
        ctx.lineWidth = 1.5;
        if (chain.length) {
          ctx.beginPath();
          ctx.moveTo(chain[0][0], chain[0][1]);
          for (let i = 1; i < chain.length; i++) ctx.lineTo(chain[i][0], chain[i][1]);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fillStyle = '#b07cff'; ctx.fill(); }
        ctx.restore();
      }

      // Active-layer transform handles
      const layer = this.activeLayer();
      if (layer && TRANSFORM_TOOLS.includes(this.tool)) {
        this.drawLayerHandles(ctx, layer);
      }

      // Landmark-alignment markers
      if (this.align.active) this.align.draw(ctx, this.cam);

      // Full-view dark-red crosshair for annotation placement / alignment
      const alignPlacing = this.align.active && (this.align.phase === 2 || this.align.phase === 3);
      if ((CROSSHAIR_TOOLS.includes(this.tool) || alignPlacing) && this.cursor) {
        const cx = Math.round(this.cursor[0]) + 0.5;
        const cy = Math.round(this.cursor[1]) + 0.5;
        ctx.save();
        ctx.strokeStyle = 'rgba(139, 0, 0, 0.95)'; // dark red
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cy); ctx.lineTo(this.W, cy);
        ctx.moveTo(cx, 0); ctx.lineTo(cx, this.H);
        ctx.stroke();
        ctx.restore();
      }
    },

    drawLayerHandles(ctx, layer) {
      const corners = this.destCorners(layer).map(p => this.cam.worldToScreen(p));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(corners[0][0], corners[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
      ctx.closePath();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffd166';
      ctx.stroke();
      ctx.setLineDash([]);
      // corner handles
      for (const c of corners) {
        ctx.beginPath();
        ctx.rect(c[0] - 5, c[1] - 5, 10, 10);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffb703';
        ctx.stroke();
      }
      // center pivot dot (for scale/rotate)
      if (this.tool === 'scale' || this.tool === 'rotate') {
        const ctr = this.cam.worldToScreen(this.centroid(layer));
        ctx.beginPath();
        ctx.arc(ctr[0], ctr[1], 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb703';
        ctx.fill();
      }
      ctx.restore();
    },

    // ---------------- layers ----------------
    activeLayer() { return this.layers.find(l => l.id === this.activeId) || null; },

    destCorners(layer) { return SRC.map(s => Mat3.apply(layer.matrix, s)); },

    centroid(layer) {
      const c = this.destCorners(layer);
      return [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4,
              (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
    },

    uniqueName(name) {
      if (!this.usedNames.has(name)) { this.usedNames.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 1, cand;
      do { cand = `${base} (${i++})${ext}`; } while (this.usedNames.has(cand));
      this.usedNames.add(cand);
      return cand;
    },

    async addImageFiles(fileList) {
      const files = Array.from(fileList);
      let first = this.layers.length === 0;
      for (const file of files) {
        try {
          const bitmap = await createImageBitmap(file);
          if (bitmap.width > this.renderer.maxTexSize || bitmap.height > this.renderer.maxTexSize) {
            this.hint(`"${file.name}" is larger than the GPU limit (${this.renderer.maxTexSize}px) and was skipped.`);
            bitmap.close && bitmap.close();
            continue;
          }
          const filename = this.uniqueName(file.name || 'image.png');
          this.blobs.set(filename, file);
          const idx = this.layers.length;
          const layer = this.buildLayer({
            filename,
            name: file.name || filename,
            bitmap,
            opacity: 1,
            visible: true,
            matrix: this.defaultMatrix(bitmap.width, bitmap.height, idx),
          });
          this.layers.push(layer);
          this.activeId = layer.id;
        } catch (e) {
          this.hint(`Could not decode "${file.name}": ${e.message}`);
        }
      }
      if (first && this.layers.length) this.fitToLayer(this.layers[0]);
      this.renderPanel();
      this.scheduleRender();
    },

    // Place a rendered footprint canvas as an ordinary (image) layer.
    async addFootprintLayer(name, canvas) {
      const bitmap = await createImageBitmap(canvas);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const filename = this.uniqueName((name || 'footprint').replace(/[^\w.-]+/g, '_') + '.png');
      if (blob) this.blobs.set(filename, blob);
      const first = this.layers.length === 0;
      const idx = this.layers.length;
      const layer = this.buildLayer({
        filename, name, bitmap, opacity: 1, visible: true,
        matrix: this.defaultMatrix(bitmap.width, bitmap.height, idx),
      });
      this.layers.push(layer);
      this.activeId = layer.id;
      if (first) this.fitToLayer(layer);
      this.renderPanel();
      this.scheduleRender();
    },

    buildLayer(cfg) {
      const texture = this.renderer.createTexture(cfg.bitmap);
      return {
        id: cfg.id || ('layer_' + Math.random().toString(36).slice(2, 9)),
        name: cfg.name,
        filename: cfg.filename,
        bitmap: cfg.bitmap,
        texture,
        opacity: cfg.opacity,
        visible: cfg.visible,
        matrix: cfg.matrix,
        locked: !!cfg.locked,
        // per-layer color transforms
        brightness: cfg.brightness != null ? cfg.brightness : 1,
        contrast: cfg.contrast != null ? cfg.contrast : 1,
        saturation: cfg.saturation != null ? cfg.saturation : 1,
        hue: cfg.hue != null ? cfg.hue : 0, // degrees
        sharpen: cfg.sharpen != null ? cfg.sharpen : 0, // -1 soften .. +1 sharpen
        w: cfg.bitmap.width,
        h: cfg.bitmap.height,
      };
    },

    // Place image at native pixel size, staggered around the world origin.
    defaultMatrix(w, h, idx) {
      const off = idx * 32;
      const ox = -w / 2 + off, oy = -h / 2 + off;
      const dst = [[ox, oy], [ox + w, oy], [ox + w, oy + h], [ox, oy + h]];
      return Mat3.homography(SRC, dst);
    },

    fitToLayer(layer) {
      const ctr = this.centroid(layer);
      this.camera.cx = ctr[0];
      this.camera.cy = ctr[1];
      const zx = this.W / (layer.w * 1.15);
      const zy = this.H / (layer.h * 1.15);
      this.camera.zoom = Math.max(0.02, Math.min(zx, zy));
    },

    deleteLayer(id) {
      const i = this.layers.findIndex(l => l.id === id);
      if (i < 0) return;
      const layer = this.layers[i];
      this.renderer.deleteTexture(layer.texture);
      layer.bitmap.close && layer.bitmap.close();
      this.layers.splice(i, 1);
      if (this.activeId === id) this.activeId = this.layers.length ? this.layers[this.layers.length - 1].id : null;
      this.renderPanel();
      this.scheduleRender();
    },

    moveLayer(id, dir) { // dir -1 = toward bottom, +1 = toward top
      const i = this.layers.findIndex(l => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= this.layers.length) return;
      this.pushUndo();
      [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
      this.renderPanel();
      this.scheduleRender();
    },

    renderPanel() {
      const list = this.layerPanel;
      list.innerHTML = '';
      // Show top layer first.
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const layer = this.layers[i];
        const row = document.createElement('div');
        row.className = 'layer-row' + (layer.id === this.activeId ? ' active' : '') + (layer.locked ? ' locked' : '');

        const vis = document.createElement('button');
        vis.className = 'icon-btn';
        vis.title = layer.visible ? 'Hide' : 'Show';
        vis.textContent = layer.visible ? '◉' : '○';
        vis.onclick = (e) => { e.stopPropagation(); this.pushUndo(); layer.visible = !layer.visible; this.renderPanel(); this.scheduleRender(); };

        const lock = document.createElement('button');
        lock.className = 'icon-btn' + (layer.locked ? ' locked' : '');
        lock.title = layer.locked ? 'Locked — click to unlock (allow transforms)' : 'Lock (protect from transforms)';
        lock.textContent = layer.locked ? '🔒' : '🔓';
        lock.onclick = (e) => { e.stopPropagation(); layer.locked = !layer.locked; this.renderPanel(); };

        const name = document.createElement('span');
        name.className = 'layer-name';
        name.textContent = layer.name;
        name.title = layer.name;

        const up = document.createElement('button');
        up.className = 'icon-btn'; up.textContent = '▲'; up.title = 'Move up';
        up.onclick = (e) => { e.stopPropagation(); this.moveLayer(layer.id, +1); };
        const down = document.createElement('button');
        down.className = 'icon-btn'; down.textContent = '▼'; down.title = 'Move down';
        down.onclick = (e) => { e.stopPropagation(); this.moveLayer(layer.id, -1); };

        const del = document.createElement('button');
        del.className = 'icon-btn danger'; del.textContent = '✕'; del.title = 'Delete layer';
        del.onclick = (e) => { e.stopPropagation(); if (confirm('Delete layer "' + layer.name + '"?')) this.deleteLayer(layer.id); };

        const top = document.createElement('div');
        top.className = 'layer-top';
        top.append(vis, lock, name, up, down, del);

        const opacityRow = this.sliderRow('Opacity', layer, 'opacity', 0, 1, 0.01, 1, v => v.toFixed(2));

        row.append(top, opacityRow);
        // Color adjustments only for the active layer, to keep the panel tidy.
        if (layer.id === this.activeId) row.append(this.layerAdjustControls(layer));
        row.onclick = () => { this.activeId = layer.id; this.renderPanel(); this.scheduleRender(); };
        list.appendChild(row);
      }
      if (!this.layers.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No layers yet.';
        list.appendChild(empty);
      }
      this.updateReadout();
    },

    // Generic labelled slider bound to layer[prop]; returns a row element.
    sliderRow(label, layer, prop, min, max, step, def, fmt) {
      const row = document.createElement('label');
      row.className = 'adj-row';
      const name = document.createElement('span'); name.className = 'adj-name'; name.textContent = label;
      const val = document.createElement('span'); val.className = 'adj-val';
      const r = document.createElement('input');
      r.type = 'range'; r.min = min; r.max = max; r.step = step;
      if (layer[prop] == null) layer[prop] = def;
      r.value = String(layer[prop]);
      const show = () => { val.textContent = fmt(Number(layer[prop])); };
      show();
      r.onpointerdown = () => this.pushUndo(); // one undo step per slider adjustment
      r.oninput = (e) => { e.stopPropagation(); layer[prop] = parseFloat(r.value); show(); this.scheduleRender(); };
      r.onclick = (e) => e.stopPropagation();
      row.append(name, r, val);
      return row;
    },

    layerAdjustControls(layer) {
      const wrap = document.createElement('div');
      wrap.className = 'adjust';
      wrap.onclick = (e) => e.stopPropagation();

      const header = document.createElement('button');
      header.className = 'adjust-header';
      header.textContent = (this.adjustExpanded ? '▾ ' : '▸ ') + 'Adjustments';
      header.onclick = (e) => { e.stopPropagation(); this.adjustExpanded = !this.adjustExpanded; this.renderPanel(); };
      wrap.append(header);
      if (!this.adjustExpanded) return wrap;

      const body = document.createElement('div');
      body.className = 'adjust-body';
      const deg = v => Math.round(v) + '°';
      const two = v => v.toFixed(2);
      const signed = v => (v > 0 ? '+' : '') + v.toFixed(2);
      body.append(
        this.sliderRow('Brightness', layer, 'brightness', 0, 2, 0.01, 1, two),
        this.sliderRow('Contrast', layer, 'contrast', 0, 2, 0.01, 1, two),
        this.sliderRow('Saturation', layer, 'saturation', 0, 2, 0.01, 1, two),
        this.sliderRow('Hue', layer, 'hue', -180, 180, 1, 0, deg),
        this.sliderRow('Sharpen', layer, 'sharpen', -1, 1, 0.01, 0, signed),
      );
      const actions = document.createElement('div');
      actions.className = 'adjust-actions';
      const gray = document.createElement('button');
      gray.className = 'btn small'; gray.textContent = 'Grayscale';
      gray.title = 'Set saturation to 0';
      gray.onclick = (e) => { e.stopPropagation(); layer.saturation = 0; this.renderPanel(); this.scheduleRender(); };
      const reset = document.createElement('button');
      reset.className = 'btn small'; reset.textContent = 'Reset';
      reset.title = 'Reset all adjustments';
      reset.onclick = (e) => {
        e.stopPropagation();
        layer.brightness = 1; layer.contrast = 1; layer.saturation = 1; layer.hue = 0; layer.sharpen = 0;
        this.renderPanel(); this.scheduleRender();
      };
      actions.append(gray, reset);
      body.append(actions);
      wrap.append(body);
      return wrap;
    },

    // ---------------- transforms (edit the active layer's matrix) ----------------
    applyToActive(T, pivot) {
      const layer = this.activeLayer();
      if (!layer) return;
      const M = pivot ? Mat3.aboutPivot(T, pivot[0], pivot[1]) : T;
      layer.matrix = Mat3.multiply(M, layer.startMatrix || layer.matrix);
      this.scheduleRender();
    },

    flipActive(axis) {
      const layer = this.activeLayer();
      if (!layer) return;
      if (layer.locked) { this.hint('Layer is locked.'); return; }
      this.pushUndo();
      const ctr = this.centroid(layer);
      const S = axis === 'h' ? Mat3.scale(-1, 1) : Mat3.scale(1, -1);
      layer.matrix = Mat3.multiply(Mat3.aboutPivot(S, ctr[0], ctr[1]), layer.matrix);
      this.scheduleRender();
    },

    // ---------------- pointer interaction ----------------
    bindPointer() {
      const el = this.overlay;
      const pos = (e) => {
        const r = el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId);
        this.onDown(pos(e), e);
      });
      el.addEventListener('pointermove', (e) => this.onMove(pos(e), e));
      el.addEventListener('pointerup', (e) => { this.onUp(pos(e), e); });
      el.addEventListener('pointercancel', () => { this.drag = null; this.preview = null; });
      el.addEventListener('pointerleave', () => { this.cursor = null; this.scheduleRender(); });
      el.addEventListener('wheel', (e) => this.onWheel(pos(e), e), { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    },

    isPanGesture(e) {
      return this.tool === 'pan' || this.spaceDown || e.button === 1;
    },

    onDown(sp, e) {
      const wp = this.cam.screenToWorld(sp);
      this.downScreen = sp;
      this.cursor = sp; // snap the guide cross to the exact click point
      this.moved = false;

      // While the alignment wizard is active a left-click places/selects a
      // landmark; Space-drag or middle-mouse still pan for navigation.
      if (this.align.active) {
        if (this.spaceDown || e.button === 1) {
          this.drag = { type: 'pan', startScreen: sp, startCam: { ...this.camera } };
          this.overlay.style.cursor = 'grabbing';
          return;
        }
        if (e.button === 0) this.align.onCanvasDown(wp, sp);
        return;
      }

      if (this.isPanGesture(e)) {
        this.drag = { type: 'pan', startScreen: sp, startCam: { ...this.camera } };
        this.overlay.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;

      if (TRANSFORM_TOOLS.includes(this.tool)) return this.onDownTransform(sp, wp);
      return this.onDownAnnotate(sp, wp);
    },

    onDownTransform(sp, wp) {
      const layer = this.activeLayer();
      if (!layer) { this.hint('Add or select a layer first.'); return; }
      if (layer.locked) { this.hint('Layer is locked — click the 🔒 in the layer panel to unlock.'); return; }
      this.pushUndo();
      layer.startMatrix = layer.matrix.slice();
      const ctr = this.centroid(layer);

      if (this.tool === 'move') {
        this.drag = { type: 't-move', startWorld: wp };
      } else if (this.tool === 'scale') {
        const d0 = Math.max(1e-3, Math.hypot(wp[0] - ctr[0], wp[1] - ctr[1]));
        this.drag = { type: 't-scale', pivot: ctr, startDist: d0 };
      } else if (this.tool === 'rotate') {
        this.drag = { type: 't-rotate', pivot: ctr, startAngle: Math.atan2(wp[1] - ctr[1], wp[0] - ctr[0]) };
      } else if (this.tool === 'freeform') {
        const corner = this.hitLayerCorner(sp, layer);
        this.drag = { type: 'freeform', corner, startCorners: this.destCorners(layer), startWorld: wp };
      } else if (this.tool === 'flip') {
        // handled by buttons; allow re-center click to do nothing
      }
    },

    hitLayerCorner(sp, layer) {
      const corners = this.destCorners(layer).map(p => this.cam.worldToScreen(p));
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(sp[0] - corners[i][0], sp[1] - corners[i][1]) <= HANDLE_HIT) return i;
      }
      return -1;
    },

    onDownAnnotate(sp, wp) {
      const t = this.tool;
      if (POINT_TOOLS.includes(t)) {
        // Press on an existing dot to reposition it; otherwise place a new one.
        const hitId = this.hitPoint(sp);
        if (hitId) {
          this.pushUndo();
          const s = this.ann.getShape(hitId);
          this.selected = { kind: 'shape', id: hitId };
          this.drag = { type: 'move-ann', kind: 'shape', id: hitId, grab: [wp[0] - s.x, wp[1] - s.y] };
          return;
        }
        this.pushUndo();
        const s = this.ann.addPoint(wp[0], wp[1], t, this.pointSizes[t]);
        this.selected = { kind: 'shape', id: s.id };
        this.renderAnnotateView();
        this.scheduleRender();
      } else if (t === 'rect') {
        // Two-click rectangle: first click sets a corner, second click finalizes;
        // in between, the opposite corner tracks the cursor.
        if (!this.rectStart) {
          this.rectStart = wp;
          this.preview = { type: 'rect', x: wp[0], y: wp[1], w: 0, h: 0 };
          this.hint('Rectangle: move to the opposite corner and click again to finish (Esc to cancel).');
        } else {
          const x = Math.min(this.rectStart[0], wp[0]);
          const y = Math.min(this.rectStart[1], wp[1]);
          const w = Math.abs(wp[0] - this.rectStart[0]);
          const h = Math.abs(wp[1] - this.rectStart[1]);
          this.rectStart = null;
          this.preview = null;
          if (w > 1e-3 || h > 1e-3) {
            this.pushUndo();
            const s = this.ann.addRect(x, y, w, h);
            this.selected = { kind: 'shape', id: s.id };
          }
        }
        this.scheduleRender();
      } else if (t === 'quad') {
        // Freeform quad: click all four corners; the 4th click finalizes it.
        if (!this.quadPts) this.quadPts = [];
        this.quadPts.push([wp[0], wp[1]]);
        if (this.quadPts.length >= 4) {
          this.pushUndo();
          const s = this.ann.addQuad(this.quadPts.slice(0, 4));
          this.selected = { kind: 'shape', id: s.id };
          this.quadPts = null;
          this.preview = null;
          this.renderAnnotateView();
        } else {
          this.preview = { type: 'quad', pts: this.quadPts.slice() };
          this.hint('Freeform: click corner ' + (this.quadPts.length + 1) + ' of 4 (Esc to cancel).');
        }
        this.scheduleRender();
      } else if (t === 'line') {
        // Polyline: each click adds a vertex; a double-click (or Enter) finishes.
        const now = Date.now();
        const isDbl = this.linePts && this._lastLineClick &&
          (now - this._lastLineClick.t < 350) &&
          Math.hypot(sp[0] - this._lastLineClick.sp[0], sp[1] - this._lastLineClick.sp[1]) < 6;
        if (isDbl) {
          this.finishLine();
        } else {
          if (!this.linePts) this.linePts = [];
          const snap = this.nets.snapToDot(sp); // land endpoints exactly on dots
          const vp = snap || wp;
          this.linePts.push([vp[0], vp[1]]);
          this.preview = { type: 'line', pts: this.linePts.slice() };
          this._lastLineClick = { t: now, sp: sp.slice() };
          this.hint('Line: click to add points (snaps to dots); double-click or Enter to finish, Esc to cancel.');
          this.scheduleRender();
        }
      } else if (t === 'net') {
        this.nets.onCanvasDown(sp);
      } else if (t === 'marker') {
        const hit = this.ann.hitTest(sp[0], sp[1], this.cam);
        if (hit && hit.kind === 'marker') {
          // Drag a marker's label to a better spot (click without moving = edit).
          this.pushUndo();
          const m = this.ann.getMarker(hit.id);
          this.selected = { kind: 'marker', id: hit.id };
          this.drag = { type: 'move-ann', kind: 'marker', id: hit.id, grab: [wp[0] - m.x, wp[1] - m.y] };
          return;
        }
        if (hit && hit.kind === 'shape') {
          this.pushUndo();
          const anchor = this.ann.targetAnchor({ targetId: hit.id, x: wp[0], y: wp[1] });
          const off = 40 / this.camera.zoom;
          const m = this.ann.addMarker(hit.id, anchor[0] + off, anchor[1] - off, 'M' + (this.ann.markers.length + 1), '');
          this.selected = { kind: 'marker', id: m.id };
          this.openPopup(m);
          this.scheduleRender();
        } else {
          this.hint('Marker tool: click a point/rectangle to attach a marker, or drag an existing marker to move it.');
        }
      }
    },

    // Topmost visible point under a screen point, or null.
    hitPoint(sp) {
      for (let i = this.ann.shapes.length - 1; i >= 0; i--) {
        const s = this.ann.shapes[i];
        if (s.type !== 'point') continue;
        if (this.ann.hiddenKinds.has(s.kind || 'via')) continue;
        const c = this.cam.worldToScreen([s.x, s.y]);
        const r = this.ann.pointScreenRadius(s, this.cam) + 4;
        if (Math.hypot(sp[0] - c[0], sp[1] - c[1]) <= r) return s.id;
      }
      return null;
    },

    finishLine() {
      if (this.linePts && this.linePts.length >= 2) {
        this.pushUndo();
        const s = this.ann.addPolyline(this.linePts);
        this.selected = { kind: 'shape', id: s.id };
        this.renderAnnotateView();
      }
      this.linePts = null;
      this.preview = null;
      this._lastLineClick = null;
      this.scheduleRender();
    },

    onMove(sp, e) {
      this.cursor = sp;
      if (CROSSHAIR_TOOLS.includes(this.tool)) this.scheduleRender(); // track guide cross
      // Rubber-band the pending two-click rectangle's opposite corner.
      if (this.rectStart && this.tool === 'rect') {
        const w = this.cam.screenToWorld(sp);
        this.preview.x = Math.min(this.rectStart[0], w[0]);
        this.preview.y = Math.min(this.rectStart[1], w[1]);
        this.preview.w = Math.abs(w[0] - this.rectStart[0]);
        this.preview.h = Math.abs(w[1] - this.rectStart[1]);
        this.scheduleRender();
      }
      // Rubber-band the next segment of a pending polyline.
      if (this.linePts && this.tool === 'line') {
        this.preview = { type: 'line', pts: this.linePts.slice(), cursor: this.cam.screenToWorld(sp) };
        this.scheduleRender();
      }
      // Rubber-band the next edge of a pending freeform quad.
      if (this.quadPts && this.tool === 'quad') {
        this.preview = { type: 'quad', pts: this.quadPts.slice(), cursor: this.cam.screenToWorld(sp) };
        this.scheduleRender();
      }
      if (this.downScreen && !this.moved) {
        if (Math.hypot(sp[0] - this.downScreen[0], sp[1] - this.downScreen[1]) > 3) this.moved = true;
      }
      const d = this.drag;
      if (!d) { this.updateCursor(sp); return; }
      const wp = this.cam.screenToWorld(sp);

      switch (d.type) {
        case 'pan': {
          const z = this.camera.zoom;
          this.camera.cx = d.startCam.cx - (sp[0] - d.startScreen[0]) / z;
          this.camera.cy = d.startCam.cy - (sp[1] - d.startScreen[1]) / z;
          this.scheduleRender();
          break;
        }
        case 't-move': {
          const dx = wp[0] - d.startWorld[0], dy = wp[1] - d.startWorld[1];
          this.applyToActive(Mat3.translate(dx, dy));
          break;
        }
        case 't-scale': {
          const dist = Math.max(1e-3, Math.hypot(wp[0] - d.pivot[0], wp[1] - d.pivot[1]));
          const f = dist / d.startDist;
          this.applyToActive(Mat3.scale(f, f), d.pivot);
          break;
        }
        case 't-rotate': {
          const a = Math.atan2(wp[1] - d.pivot[1], wp[0] - d.pivot[0]);
          this.applyToActive(Mat3.rotate(a - d.startAngle), d.pivot);
          break;
        }
        case 'freeform': {
          const layer = this.activeLayer();
          const corners = d.startCorners.map(c => c.slice());
          if (d.corner >= 0) {
            corners[d.corner] = [wp[0], wp[1]];
          } else {
            const dx = wp[0] - d.startWorld[0], dy = wp[1] - d.startWorld[1];
            for (const c of corners) { c[0] += dx; c[1] += dy; }
          }
          layer.matrix = Mat3.homography(SRC, corners);
          this.scheduleRender();
          break;
        }
        case 'move-ann': {
          const obj = this.ann.get(d.kind, d.id);
          if (obj) { obj.x = wp[0] - d.grab[0]; obj.y = wp[1] - d.grab[1]; this.scheduleRender(); }
          break;
        }
        case 'resize-rect': {
          const r = this.ann.getShape(d.id);
          if (r) { resizeRectCorner(r, d.corner, wp); this.scheduleRender(); }
          break;
        }
      }
    },

    onUp(sp) {
      const d = this.drag;
      this.overlay.style.cursor = '';
      // Clicking a marker (no drag) with Select tool opens its popup.
      if (d && d.type === 'move-ann' && d.kind === 'marker' && !this.moved) {
        this.openPopup(this.ann.getMarker(d.id));
      }
      const layer = this.activeLayer();
      if (layer) delete layer.startMatrix;
      this.drag = null;
      this.downScreen = null;
      this.updateCursor(sp);
    },

    updateCursor(sp) {
      let c = 'default';
      // Keep the real OS crosshair for placement tools (it never lags the pointer)
      // AND draw the full-view guide lines; hiding the cursor made fast clicks look
      // like they "drifted" because the drawn cross trailed the true pointer.
      if (this.align.active && (this.align.phase === 2 || this.align.phase === 3)) c = 'crosshair';
      else if (this.tool === 'pan') c = 'grab';
      else if (TRANSFORM_TOOLS.includes(this.tool)) c = 'move';
      else if (CROSSHAIR_TOOLS.includes(this.tool)) c = 'crosshair';
      this.overlay.style.cursor = c;
    },

    onWheel(sp, e) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const before = this.cam.screenToWorld(sp);
      this.camera.zoom = Math.max(0.02, Math.min(64, this.camera.zoom * factor));
      // keep the world point under the cursor fixed
      this.camera.cx = before[0] - (sp[0] - this.W / 2) / this.camera.zoom;
      this.camera.cy = before[1] - (sp[1] - this.H / 2) / this.camera.zoom;
      // If a pan drag is in progress, rebase it so the changed zoom/center does
      // not make the next pan move snap the view.
      if (this.drag && this.drag.type === 'pan') {
        this.drag.startCam = { cx: this.camera.cx, cy: this.camera.cy, zoom: this.camera.zoom };
        this.drag.startScreen = sp;
      }
      this.scheduleRender();
    },

    // ---------------- keyboard ----------------
    bindKeys() {
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !this.isTyping(e)) { this.spaceDown = true; if (this.tool !== 'pan') this.overlay.style.cursor = 'grab'; e.preventDefault(); }
        if (this.isTyping(e)) return;
        // Alignment wizard consumes nudge/delete/escape while active.
        if (this.align.active && this.align.onKey(e)) { e.preventDefault(); return; }
        // Undo / redo (global; align wizard has its own history).
        if (!this.align.active && (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
          if (e.shiftKey) this.redo(); else this.undo();
          e.preventDefault(); return;
        }
        if (!this.align.active && (e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
          this.redo(); e.preventDefault(); return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
          this.pushUndo();
          this.ann.remove(this.selected.kind, this.selected.id);
          this.selected = null; this.closePopup(); this.renderAnnotateView(); this.scheduleRender(); e.preventDefault();
        }
        if (e.key === 'Enter' && this.linePts) { this.finishLine(); e.preventDefault(); return; }
        if (e.key === 'Escape') { this.selected = null; this.drag = null; this.preview = null; this.rectStart = null; this.quadPts = null; this.linePts = null; this._lastLineClick = null; this.closePopup(); this.scheduleRender(); }
        const map = { m: 'move', s: 'scale', r: 'rotate', f: 'freeform', h: 'pan', b: 'rect', k: 'marker' };
        if (map[e.key] && !e.ctrlKey && !e.metaKey) this.setTool(map[e.key]);
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); }
      });
    },

    isTyping(e) {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    },

    // ---------------- UI wiring ----------------
    bindUI() {
      document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.onclick = () => this.setTool(btn.dataset.tool);
      });
      document.getElementById('fileInput').onchange = (e) => {
        this.addImageFiles(e.target.files);
        e.target.value = '';
      };
      document.getElementById('flipH').onclick = () => this.flipActive('h');
      document.getElementById('flipV').onclick = () => this.flipActive('v');
      document.getElementById('saveBtn').onclick = () => this.save();
      document.getElementById('loadBtn').onclick = () => this.load();
      document.getElementById('alignBtn').onclick = () => this.align.start();
      document.getElementById('footprintBtn').onclick = () => this.footprints.open();
      document.getElementById('resetView').onclick = () => {
        if (this.layers.length) this.fitToLayer(this.activeLayer() || this.layers[0]);
        else { this.camera = { cx: 0, cy: 0, zoom: 1 }; }
        this.scheduleRender();
      };

      // per-kind absolute size (bound to the active point tool: via/tag/hole)
      const sizeInput = document.getElementById('pointSize');
      sizeInput.oninput = () => {
        if (!POINT_TOOLS.includes(this.tool)) return;
        const v = Math.max(1, Math.min(1000, parseInt(sizeInput.value, 10) || 8));
        this.pointSizes[this.tool] = v;
        // Resize the selected point too, if it is of the active kind.
        if (this.selected && this.selected.kind === 'shape') {
          const s = this.ann.getShape(this.selected.id);
          if (s && s.type === 'point' && (s.kind || 'via') === this.tool) { s.size = v; this.scheduleRender(); }
        }
      };

      // marker popup
      document.getElementById('mpSave').onclick = () => this.savePopup();
      document.getElementById('mpDelete').onclick = () => this.deletePopupMarker();
      document.getElementById('mpClose').onclick = () => this.closePopup();
    },

    // ---------------- Annotate view (one summary row per kind / shape type) ------
    renderAnnotateView() {
      const box = document.getElementById('annotateView');
      if (!box) return;
      box.innerHTML = '';
      // Point kinds (via / tag / hole / ground / vcc)
      for (const kind of Annotations.KIND_ORDER) {
        const def = Annotations.KINDS[kind];
        const swClass = def.shape === 'rhomb' ? 'rhomb' : def.shape === 'square' ? 'square' : 'circle';
        box.appendChild(this.annotateRow(
          kind, def.label, def.color, swClass,
          this.ann.pointsOfKind(kind).length, 'point'));
      }
      // Rectangles, freeform quads, polylines
      box.appendChild(this.annotateRow('rect', 'Rectangles', Annotations.RECT_COLOR, 'square',
        this.ann.shapesOfType('rect').length, 'shape'));
      box.appendChild(this.annotateRow('quad', 'Freeform', Annotations.QUAD_COLOR, 'square',
        this.ann.shapesOfType('quad').length, 'shape'));
      box.appendChild(this.annotateRow('line', 'Lines', Annotations.LINE_COLOR, 'square',
        this.ann.shapesOfType('line').length, 'line'));
      if (this.nets) this.nets.renderPanel(); // nets depend on dots + lines
      this.updateReadout();
    },

    // ---------------- undo / redo ----------------
    // Snapshots the editable state: annotations + per-layer transform/appearance/
    // lock + z-order + annotate-view hidden kinds. (Layer add/delete and image
    // bytes are structural and not part of undo.)
    snapshot() {
      return {
        ann: this.ann.serialize(),
        hiddenKinds: [...this.ann.hiddenKinds],
        order: this.layers.map(l => l.id),
        layers: this.layers.map(l => ({
          id: l.id, matrix: l.matrix.slice(),
          opacity: l.opacity, visible: l.visible, locked: !!l.locked,
          brightness: l.brightness, contrast: l.contrast,
          saturation: l.saturation, hue: l.hue, sharpen: l.sharpen,
        })),
      };
    },
    pushUndo() {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    },
    applySnapshot(s) {
      this.ann.load(s.ann);
      this.ann.hiddenKinds = new Set(s.hiddenKinds || []);
      const byId = new Map(this.layers.map(l => [l.id, l]));
      for (const ls of s.layers) {
        const l = byId.get(ls.id);
        if (!l) continue;
        l.matrix = ls.matrix.slice();
        l.opacity = ls.opacity; l.visible = ls.visible; l.locked = !!ls.locked;
        l.brightness = ls.brightness; l.contrast = ls.contrast;
        l.saturation = ls.saturation; l.hue = ls.hue; l.sharpen = ls.sharpen;
      }
      const pos = id => { const i = s.order.indexOf(id); return i < 0 ? 1e9 : i; };
      this.layers.sort((a, b) => pos(a.id) - pos(b.id));
      this.selected = null;
      this.renderPanel();
      this.renderAnnotateView();
      this.scheduleRender();
    },
    undo() {
      if (!this.undoStack.length) { this.hint('Nothing to undo.'); return; }
      this.redoStack.push(this.snapshot());
      this.applySnapshot(this.undoStack.pop());
      this.hint('Undo — Ctrl+Shift+Z to redo.');
    },
    redo() {
      if (!this.redoStack.length) { this.hint('Nothing to redo.'); return; }
      this.undoStack.push(this.snapshot());
      this.applySnapshot(this.redoStack.pop());
      this.hint('Redo.');
    },

    // Bottom-right corner readout in the domain's own vocabulary.
    updateReadout() {
      const el = document.getElementById('readout');
      if (!el) return;
      const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 'S');
      const layers = this.layers.length;
      const dots = this.ann.shapes.filter(s => s.type === 'point').length;
      let nets = 0;
      try { nets = this.nets ? this.nets.compute().nets.filter(n => n.count > 0).length : 0; } catch (e) {}
      const txt = `${plural(layers, 'LAYER')} · ${plural(dots, 'DOT')} · ${plural(nets, 'NET')}`;
      const armed = !!(this.align && this.align.active);
      el.classList.toggle('hazard', armed);
      el.textContent = armed ? '⚠ ALIGNMENT ARMED · ' + txt : txt;
    },

    annotateRow(key, label, color, swClass, n, noun) {
      const hidden = this.ann.hiddenKinds.has(key);
      const row = document.createElement('div');
      row.className = 'annotate-head';
      const sw = document.createElement('span');
      sw.className = 'swatch ' + swClass;
      sw.style.background = color;
      const name = document.createElement('span');
      name.className = 'k-name'; name.textContent = label;
      const cnt = document.createElement('span');
      cnt.className = 'k-count'; cnt.textContent = n + ' ' + noun + (n === 1 ? '' : 's');
      const tog = document.createElement('button');
      tog.className = 'icon-btn';
      tog.textContent = hidden ? '○' : '◉';
      tog.title = hidden ? 'Show ' + label : 'Hide ' + label;
      tog.onclick = (e) => { e.stopPropagation(); this.toggleKind(key); };
      row.append(sw, name, cnt, tog);
      return row;
    },

    toggleKind(kind) {
      this.pushUndo();
      if (this.ann.hiddenKinds.has(kind)) {
        this.ann.hiddenKinds.delete(kind);
      } else {
        this.ann.hiddenKinds.add(kind);
        if (this.selected && this.selected.kind === 'shape') {
          const s = this.ann.getShape(this.selected.id);
          if (s && ((s.type === 'point' && (s.kind || 'via') === kind) || s.type === kind)) this.selected = null;
        }
      }
      this.renderAnnotateView();
      this.scheduleRender();
    },

    setTool(tool) {
      // Finish any in-progress polyline, cancel any pending rectangle/quad.
      if (this.linePts) this.finishLine();
      if (this.rectStart || this.quadPts) { this.rectStart = null; this.quadPts = null; this.preview = null; }
      this.tool = tool;
      document.querySelectorAll('[data-tool]').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === tool);
      });
      document.getElementById('flipActions').style.display = tool === 'flip' ? 'flex' : 'none';
      if (tool === 'net') { this.nets.colorByNet = true; this.nets.renderPanel(); }
      const isPoint = POINT_TOOLS.includes(tool);
      document.getElementById('pointOptions').classList.toggle('open', isPoint);
      if (isPoint) {
        document.getElementById('pointSize').value = this.pointSizes[tool];
        document.getElementById('pointSizeKind').textContent = Annotations.KINDS[tool].label;
      }
      this.updateCursor();
      this.scheduleRender();
      const help = {
        pan: 'Pan: drag to move the view. Scroll to zoom. (Space+drag works in any tool.)',
        move: 'Move: drag the active layer.',
        scale: 'Scale: drag outward/inward to resize the active layer about its center.',
        rotate: 'Rotate: drag around the active layer\'s center.',
        flip: 'Flip: use the Horizontal / Vertical buttons on the active layer.',
        freeform: 'Freeform: drag each corner independently for perspective correction.',
        via: 'Via: click to place a green circular via (set its size at left).',
        tag: 'Tag: click to place a yellow rhomb tag (set its size at left).',
        hole: 'Hole: click to place a blue circular hole (set its size at left).',
        pad: 'Pad: click to place a silver square pad where a component solders (set its size at left).',
        ground: 'Ground: click to place a black circular ground point (set its size at left).',
        vcc: 'Vcc: click to place a bright-red circular Vcc point (set its size at left).',
        rect: 'Rectangle: click one corner, then click the opposite corner to finish (Esc to cancel).',
        quad: 'Freeform: click the 4 corners in turn to define a quadrilateral (Esc to cancel).',
        line: 'Line: click to add points; double-click or Enter to finish, Esc to cancel.',
        marker: 'Marker: click a point or rectangle to attach a labelled marker.',
      };
      this.hint(help[tool] || '');
      this.updateReadout();
    },

    hint(msg) { if (this.hintEl) this.hintEl.textContent = msg; },

    // ---------------- marker popup ----------------
    openPopup(marker) {
      if (!marker) return;
      this.popupId = marker.id;
      document.getElementById('mpShort').value = marker.shortName;
      document.getElementById('mpDesc').value = marker.description;
      const [mx, my] = this.cam.worldToScreen([marker.x, marker.y]);
      const r = this.stage.getBoundingClientRect();
      this.popup.style.left = Math.min(r.width - 240, Math.max(8, mx + 12)) + 'px';
      this.popup.style.top = Math.min(r.height - 180, Math.max(8, my + 12)) + 'px';
      this.popup.style.display = 'block';
      document.getElementById('mpShort').focus();
    },
    savePopup() {
      const m = this.ann.getMarker(this.popupId);
      if (m) {
        m.shortName = document.getElementById('mpShort').value.trim() || 'M';
        m.description = document.getElementById('mpDesc').value;
        this.scheduleRender();
      }
      this.closePopup();
    },
    deletePopupMarker() {
      if (this.popupId) { this.ann.remove('marker', this.popupId); this.selected = null; this.scheduleRender(); }
      this.closePopup();
    },
    closePopup() { this.popup.style.display = 'none'; this.popupId = null; },

    // ---------------- persistence ----------------
    projectData() {
      return {
        version: 1,
        app: 'layered-image-annotator',
        camera: { cx: this.camera.cx, cy: this.camera.cy, zoom: this.camera.zoom },
        layers: this.layers.map(l => ({
          id: l.id,
          name: l.name,
          filename: l.filename,
          opacity: l.opacity,
          visible: l.visible,
          locked: !!l.locked,
          matrix: l.matrix.slice(), // row-major 3x3, source(0..1) -> world
          brightness: l.brightness,
          contrast: l.contrast,
          saturation: l.saturation,
          hue: l.hue,
          sharpen: l.sharpen,
        })),
        annotations: this.ann.serialize(),
      };
    },

    async save() {
      if (!this.layers.length && !this.ann.shapes.length) { this.hint('Nothing to save yet.'); return; }
      this.hint('Saving…');
      try {
        const res = await Persistence.save(this.projectData(), this.blobs, 'annotation-project.zip');
        if (res.aborted) { this.hint('Save cancelled.'); return; }
        this.hint(res.method === 'download' ? 'Saved (downloaded ' + res.name + ').' : 'Saved to ' + res.name + '.');
      } catch (e) {
        this.hint('Save failed: ' + e.message);
      }
    },

    async load() {
      let file;
      try { file = await Persistence.pickZip(); } catch (e) { this.hint('Load failed: ' + e.message); return; }
      if (!file) return;
      this.hint('Loading…');
      try {
        const { project, images } = await Persistence.loadZip(file);
        await this.applyProject(project, images);
        this.hint('Loaded project (' + this.layers.length + ' layers).');
      } catch (e) {
        this.hint('Load failed: ' + e.message);
        console.error(e);
      }
    },

    async applyProject(project, images) {
      // Clear existing state
      for (const l of this.layers) { this.renderer.deleteTexture(l.texture); l.bitmap.close && l.bitmap.close(); }
      this.layers = [];
      this.blobs = new Map();
      this.usedNames = new Set();
      this.ann.clear();
      this.selected = null;

      for (const ld of project.layers || []) {
        const blob = images.get(ld.filename) || images.get('images/' + ld.filename);
        if (!blob) { this.hint('Missing image in zip: ' + ld.filename); continue; }
        const bitmap = await createImageBitmap(blob);
        this.blobs.set(ld.filename, blob);
        this.usedNames.add(ld.filename);
        const layer = this.buildLayer({
          id: ld.id,
          name: ld.name || ld.filename,
          filename: ld.filename,
          bitmap,
          opacity: ld.opacity != null ? ld.opacity : 1,
          visible: ld.visible !== false,
          locked: !!ld.locked,
          matrix: ld.matrix && ld.matrix.length === 9 ? ld.matrix.slice() : this.defaultMatrix(bitmap.width, bitmap.height, 0),
          brightness: ld.brightness, contrast: ld.contrast, saturation: ld.saturation, hue: ld.hue, sharpen: ld.sharpen,
        });
        this.layers.push(layer);
      }
      this.activeId = this.layers.length ? this.layers[this.layers.length - 1].id : null;
      this.ann.load(project.annotations);
      if (project.camera) this.camera = { cx: project.camera.cx || 0, cy: project.camera.cy || 0, zoom: project.camera.zoom || 1 };
      this.renderPanel();
      this.renderAnnotateView();
      this.scheduleRender();
    },

    // ---------------- resize ----------------
    resize() {
      const r = this.stage.getBoundingClientRect();
      this.W = Math.max(1, Math.round(r.width));
      this.H = Math.max(1, Math.round(r.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const c of [this.glCanvas, this.overlay]) {
        c.width = Math.round(this.W * this.dpr);
        c.height = Math.round(this.H * this.dpr);
        c.style.width = this.W + 'px';
        c.style.height = this.H + 'px';
      }
      this.scheduleRender();
    },
  };

  function resizeRectCorner(r, corner, wp) {
    // corner: 0=TL,1=TR,2=BR,3=BL. Opposite corner stays fixed.
    const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
    if (corner === 0) { nx0 = wp[0]; ny0 = wp[1]; }
    else if (corner === 1) { nx1 = wp[0]; ny0 = wp[1]; }
    else if (corner === 2) { nx1 = wp[0]; ny1 = wp[1]; }
    else { nx0 = wp[0]; ny1 = wp[1]; }
    r.x = Math.min(nx0, nx1); r.y = Math.min(ny0, ny1);
    r.w = Math.abs(nx1 - nx0); r.h = Math.abs(ny1 - ny0);
  }

  window.addEventListener('DOMContentLoaded', () => App.init());
  window.App = App;
})();
