/* bom.js — standalone Bill-of-Materials editor for a PCBSpy project.

   Loads a project .zip (the same format app.html saves): project.json + images/.
   Adds/edits a `bom` array on project.json and writes the whole project back out,
   preserving layers / annotations / camera untouched so it round-trips into the app.

   A BOM element:
     { id, ref, type, value, description,
       loc: { image:<filename>, quad:[[wx,wy]x4] } }   // quad in WORLD space

   The rectangle is drawn on the chosen image (pixel space); on save it is converted
   to world-space corners via that image's layer matrix (source 0..1 -> world), so the
   location integrates with layer alignment while the closeup still crops the exact image.

   Depends on globals: JSZip, Mat3, Persistence. */
(function (global) {
  'use strict';

  const TYPES = [
    'Resistor', 'Capacitor', 'Inductor', 'Ferrite/Bead', 'Diode', 'LED',
    'Transistor', 'Crystal/Oscillator', 'Connector', 'Switch/Button',
    'IC – Logic', 'IC – Analog', 'IC – Power/Regulator', 'IC – Microcontroller',
    'IC – Memory (Flash/NAND/NOR)', 'IC – Memory (RAM/SRAM/DRAM)', 'IC – eMMC/Storage',
    'Sensor', 'Transformer', 'Test point', 'Other',
  ];

  const uid = (p) => p + Math.random().toString(36).slice(2, 9);

  const BOM = {
    // ---- state ----
    project: null,                 // parsed project.json (kept whole for round-trip)
    images: new Map(),             // filename -> Blob
    bitmaps: new Map(),            // filename -> ImageBitmap
    layers: [],                    // [{filename, name, matrix, w, h}]
    items: [],                     // BOM elements
    selectedId: null,
    dirty: false,
    _restored: false,          // gate store autosave until the initial restore has run
    _metaTimer: null,

    // placement viewport state (2D canvas over one image)
    view: { img: null, scale: 1, ox: 0, oy: 0 },   // ox/oy in image px at canvas origin
    mode: 'closeup',               // 'closeup' | 'place'
    draft: null,                   // {x,y,w,h} rect in image px while drawing
    dragging: null,                // 'pan' | 'draw' | null

    els: {},                       // cached DOM refs

    // ---------------------------------------------------------------- boot
    init() {
      this.cacheEls();
      this.bindUI();
      this.renderTypeOptions();
      this.renderThumbs();
      this.renderTable();
      this.renderEditor();
      this.restoreFromStore();
    },

    // ---- working-store handoff (IndexedDB, shared with app.html) ----
    async restoreFromStore() {
      try {
        const data = ProjectStore.available ? await ProjectStore.load() : null;
        if (data && data.project) {
          await this.applyProject(data.project, data.images);
          this.status('Loaded current project (' + this.layers.length + ' images, ' + this.items.length + ' items).');
          this.focusHandoff();
        }
      } catch (e) { console.warn('Restore failed:', e); }
      this._restored = true;
    },
    // If we arrived here from the app's "Add element → Apply", select that new
    // element and focus its Ref field so the user only has to type the fields.
    focusHandoff() {
      let id;
      try { id = sessionStorage.getItem('pcbspy_bom_focus'); sessionStorage.removeItem('pcbspy_bom_focus'); } catch (_) { id = null; }
      if (id && this.items.some(i => i.id === id)) {
        this.select(id);
        setTimeout(() => { this.els.ref.focus(); this.els.ref.select(); }, 0);
        this.status('New element placed from the board — fill in its fields, then Save.');
      }
    },
    syncProjectBom() {
      if (!this.project) return;
      this.project.version = 3;
      this.project.bom = this.items.map(serializeItem);
    },
    autosaveMeta() {
      if (!this._restored || !this.project || !ProjectStore.available) return;
      this.syncProjectBom();
      clearTimeout(this._metaTimer);
      this._metaTimer = setTimeout(() => ProjectStore.saveMeta(this.project), 500);
    },
    async persistFull() {
      if (!this.project || !ProjectStore.available) return;
      this.syncProjectBom();
      const clean = new Map();
      for (const [k, v] of this.images.entries()) clean.set(k.replace(/^images\//, ''), v);
      await ProjectStore.save(this.project, clean);
    },
    async newProject() {
      if (!confirm('Start a new, empty project?\n\nThis clears the current in-browser session (images, annotations and BOM). Any .zip files you saved to disk are untouched.')) return;
      try { await ProjectStore.clear(); } catch (e) { console.warn(e); }
      location.reload();   // clean reset; restore then finds an empty store
    },
    // Hand off to the board editor and have it zoom to this element (no layer changes).
    async locateOnBoard(id) {
      const it = this.items.find(x => x.id === id);
      if (!it || !it.loc || !Array.isArray(it.loc.quad)) { this.status('Place this element on the board first.'); return; }
      try { this.syncProjectBom(); if (ProjectStore.available) await ProjectStore.saveMeta(this.project); } catch (e) { console.warn(e); }
      try { sessionStorage.setItem('pcbspy_locate', id); } catch (_) {}
      window.location.href = 'app.html';
    },

    cacheEls() {
      const id = (x) => document.getElementById(x);
      this.els = {
        openBtn: id('openBtn'), demoBtn: id('demoBtn'), saveBtn: id('saveBtn'),
        csvBtn: id('csvBtn'), newBtn: id('newBtn'), addBtn: id('addBtn'),
        thumbs: id('thumbs'), viewport: id('viewport'), zoomLabel: id('zoomLabel'),
        placeBtn: id('placeBtn'), placeHint: id('placeHint'),
        ref: id('fRef'), type: id('fType'), val: id('fVal'), desc: id('fDesc'),
        formSave: id('fSave'), formDelete: id('fDelete'),
        table: id('bomBody'), count: id('bomCount'),
        status: id('status'), title: id('editorTitle'),
      };
      this.ctx = this.els.viewport.getContext('2d');
    },

    bindUI() {
      const e = this.els;
      e.openBtn.onclick = () => this.openProject();
      e.demoBtn.onclick = () => this.loadDemo();
      e.saveBtn.onclick = () => this.saveProject();
      e.csvBtn.onclick = () => this.exportCsv();
      e.newBtn.onclick = () => this.newProject();
      e.addBtn.onclick = () => this.addItem();
      e.formSave.onclick = () => this.saveForm();
      e.formDelete.onclick = () => this.deleteItem(this.selectedId);
      e.placeBtn.onclick = () => this.togglePlace();

      // live-edit fields mark dirty but only commit on Save
      for (const f of [e.ref, e.type, e.val, e.desc]) {
        f.addEventListener('input', () => this.onFieldEdit());
      }

      // viewport interactions
      const vp = e.viewport;
      vp.addEventListener('mousedown', (ev) => this.onDown(ev));
      window.addEventListener('mousemove', (ev) => this.onMove(ev));
      window.addEventListener('mouseup', (ev) => this.onUp(ev));
      vp.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
      window.addEventListener('resize', () => this.fitCanvas());
      this.fitCanvas();
    },

    renderTypeOptions() {
      this.els.type.innerHTML = TYPES.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');
    },

    status(msg) { this.els.status.textContent = msg || ''; },

    // ---------------------------------------------------------------- load
    async openProject() {
      let file;
      try { file = await Persistence.pickZip(); } catch (err) { this.status('Open failed: ' + err.message); return; }
      if (!file) return;
      this.status('Loading…');
      try {
        const { project, images } = await Persistence.loadZip(file);
        await this.applyProject(project, images);
        await this.persistFull();   // make this the shared working project
        this.status('Loaded project (' + this.layers.length + ' images, ' + this.items.length + ' items).');
      } catch (err) { this.status('Load failed: ' + err.message); console.error(err); }
    },

    async loadDemo() {
      this.status('Loading demo…');
      try {
        const res = await fetch('demo.zip?b=' + Date.now());
        if (!res.ok) throw new Error('demo.zip not found (' + res.status + ')');
        const { project, images } = await Persistence.loadZip(await res.blob());
        await this.applyProject(project, images);
        await this.persistFull();   // make this the shared working project
        this.status('Loaded demo (' + this.layers.length + ' images, ' + this.items.length + ' items).');
      } catch (err) {
        this.status('Could not load demo: ' + err.message + (location.protocol === 'file:' ? ' — serve over http to fetch demo.zip.' : ''));
      }
    },

    async applyProject(project, images) {
      this.project = project;
      this.images = images;
      this.bitmaps = new Map();
      this.layers = [];
      this.selectedId = null;
      this.dirty = false;

      for (const ld of project.layers || []) {
        const blob = images.get(ld.filename) || images.get('images/' + ld.filename);
        if (!blob) continue;
        let bmp;
        try { bmp = await createImageBitmap(blob); } catch (_) { continue; }
        this.bitmaps.set(ld.filename, bmp);
        this.layers.push({
          filename: ld.filename,
          name: ld.name || ld.filename,
          matrix: (ld.matrix && ld.matrix.length === 9) ? ld.matrix.slice() : Mat3.identity(),
          w: bmp.width, h: bmp.height,
        });
      }

      this.items = Array.isArray(project.bom) ? project.bom.map(normalizeItem) : [];
      this.renderThumbs();
      this.renderTable();
      if (this.items.length) this.select(this.items[0].id);
      else this.renderEditor();
    },

    layerOf(filename) { return this.layers.find(l => l.filename === filename) || null; },

    // ---------------------------------------------------------- coord maps
    // image px -> world, using the chosen image's layer matrix (source 0..1 -> world)
    imgToWorld(layer, px, py) {
      return Mat3.apply(layer.matrix, [px / layer.w, py / layer.h]);
    },
    // world -> image px
    worldToImg(layer, wx, wy) {
      const n = Mat3.apply(Mat3.invert(layer.matrix), [wx, wy]);
      return [n[0] * layer.w, n[1] * layer.h];
    },
    // world quad -> image-px axis-aligned bbox {x,y,w,h} on the given layer
    quadToImgRect(layer, quad) {
      const pts = quad.map(([wx, wy]) => this.worldToImg(layer, wx, wy));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    },

    // ---------------------------------------------------------------- CRUD
    addItem() {
      if (!this.layers.length) { this.status('Open a project with images first.'); return; }
      const item = {
        id: uid('bom_'), ref: nextRef(this.items), type: TYPES[0],
        value: '', description: '', loc: null,
      };
      this.items.push(item);
      this.markDirty();
      this.renderTable();
      this.select(item.id);
      this.els.ref.focus();
      this.els.ref.select();
    },

    deleteItem(id) {
      if (!id) return;
      const it = this.items.find(x => x.id === id);
      if (!it) return;
      if (!confirm(`Delete ${it.ref || 'this element'}?`)) return;
      this.items = this.items.filter(x => x.id !== id);
      if (this.selectedId === id) this.selectedId = null;
      this.markDirty();
      this.mode = 'closeup';
      this.renderTable();
      if (this.items.length) this.select(this.items[0].id);
      else this.renderEditor();
    },

    select(id) {
      this.selectedId = id;
      this.mode = 'closeup';
      this.draft = null;
      this.renderEditor();
      this.renderTable();      // refresh active row
      this.showCloseup();
    },

    selected() { return this.items.find(x => x.id === this.selectedId) || null; },

    onFieldEdit() {
      // reflect REF live into the table without full commit
      const it = this.selected();
      if (!it) return;
      this.markDirty();
    },

    saveForm() {
      const it = this.selected();
      if (!it) { this.status('No element selected.'); return; }
      it.ref = this.els.ref.value.trim();
      it.type = this.els.type.value;
      it.value = this.els.val.value.trim();
      it.description = this.els.desc.value;
      this.markDirty();
      this.renderTable();
      this.status('Saved ' + (it.ref || 'element') + '.');
    },

    // ---------------------------------------------------------- image pick
    chooseImage(filename) {
      const it = this.selected();
      if (!it) { this.status('Select or add an element first.'); return; }
      if (!it.loc) it.loc = { image: filename, quad: null };
      else it.loc.image = filename;
      this.markDirty();
      this.renderThumbs();
      if (this.mode === 'place') this.startPlace();
      else this.showCloseup();
    },

    // ---------------------------------------------------------- placement
    togglePlace() {
      const it = this.selected();
      if (!it) { this.status('Select or add an element first.'); return; }
      if (!it.loc || !it.loc.image) {
        // default to first image if none chosen yet
        if (!this.layers.length) { this.status('No images in project.'); return; }
        it.loc = { image: this.layers[0].filename, quad: it.loc && it.loc.quad || null };
        this.renderThumbs();
      }
      if (this.mode === 'place') { this.mode = 'closeup'; this.draft = null; this.showCloseup(); }
      else { this.mode = 'place'; this.startPlace(); }
      this.updatePlaceUI();
    },

    startPlace() {
      const it = this.selected();
      const layer = it && it.loc && this.layerOf(it.loc.image);
      if (!layer) return;
      this.view.img = this.bitmaps.get(layer.filename);
      // seed draft from existing quad (mapped back onto this image), else null
      this.draft = it.loc.quad ? this.quadToImgRect(layer, it.loc.quad) : null;
      this.fitImageToCanvas(layer);
      this.drawViewport();
    },

    updatePlaceUI() {
      const placing = this.mode === 'place';
      this.els.placeBtn.textContent = placing ? '✓ Done placing' : '⊹ Set on PCB';
      this.els.placeBtn.classList.toggle('ok', placing);
      this.els.placeHint.style.display = placing ? '' : 'none';
      this.els.viewport.style.cursor = placing ? 'crosshair' : 'default';
    },

    // ---------------------------------------------------------- viewport
    fitCanvas() {
      const cv = this.els.viewport;
      const r = cv.getBoundingClientRect();
      const dpr = global.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cssW = r.width; this.cssH = r.height;
      if (this.mode === 'place') this.drawViewport();
      else this.showCloseup();
    },

    fitImageToCanvas(layer) {
      const pad = 20;
      const sx = (this.cssW - pad * 2) / layer.w;
      const sy = (this.cssH - pad * 2) / layer.h;
      this.view.scale = Math.min(sx, sy);
      this.view.ox = (this.cssW - layer.w * this.view.scale) / 2;
      this.view.oy = (this.cssH - layer.h * this.view.scale) / 2;
    },

    // canvas(css) <-> image px
    canvasToImg(cx, cy) {
      return [(cx - this.view.ox) / this.view.scale, (cy - this.view.oy) / this.view.scale];
    },
    imgToCanvas(px, py) {
      return [px * this.view.scale + this.view.ox, py * this.view.scale + this.view.oy];
    },

    onDown(ev) {
      if (this.mode !== 'place') return;
      ev.preventDefault();
      const [cx, cy] = this.evtCanvas(ev);
      if (ev.button === 1 || ev.shiftKey) {
        this.dragging = 'pan';
        this.panStart = { cx, cy, ox: this.view.ox, oy: this.view.oy };
      } else if (ev.button === 0) {
        this.dragging = 'draw';
        const [ix, iy] = this.canvasToImg(cx, cy);
        this.drawStart = [ix, iy];
        this.draft = { x: ix, y: iy, w: 0, h: 0 };
        this.drawViewport();
      }
    },

    onMove(ev) {
      if (!this.dragging) return;
      const [cx, cy] = this.evtCanvas(ev);
      if (this.dragging === 'pan') {
        this.view.ox = this.panStart.ox + (cx - this.panStart.cx);
        this.view.oy = this.panStart.oy + (cy - this.panStart.cy);
        this.drawViewport();
      } else if (this.dragging === 'draw') {
        const [ix, iy] = this.canvasToImg(cx, cy);
        const [sx, sy] = this.drawStart;
        this.draft = { x: Math.min(sx, ix), y: Math.min(sy, iy), w: Math.abs(ix - sx), h: Math.abs(iy - sy) };
        this.drawViewport();
      }
    },

    onUp(ev) {
      if (!this.dragging) return;
      const was = this.dragging;
      this.dragging = null;
      if (was === 'draw') this.commitDraft();
    },

    onWheel(ev) {
      if (this.mode !== 'place') return;
      ev.preventDefault();
      const [cx, cy] = this.evtCanvas(ev);
      const [ix, iy] = this.canvasToImg(cx, cy);
      const factor = Math.exp(-ev.deltaY * 0.0015);
      this.view.scale = clamp(this.view.scale * factor, 0.02, 200);
      // keep the point under the cursor fixed
      this.view.ox = cx - ix * this.view.scale;
      this.view.oy = cy - iy * this.view.scale;
      this.drawViewport();
    },

    evtCanvas(ev) {
      const r = this.els.viewport.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    },

    // convert the current draft rect (image px) to a world quad and store it
    commitDraft() {
      const it = this.selected();
      const layer = it && it.loc && this.layerOf(it.loc.image);
      if (!it || !layer || !this.draft) return;
      if (this.draft.w < 2 || this.draft.h < 2) { this.draft = it.loc.quad ? this.quadToImgRect(layer, it.loc.quad) : null; this.drawViewport(); return; }
      const { x, y, w, h } = this.draft;
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      it.loc.quad = corners.map(([px, py]) => this.imgToWorld(layer, px, py));
      this.markDirty();
      this.renderTable();
      this.status('Placed ' + (it.ref || 'element') + '.');
      this.drawViewport();
    },

    drawViewport() {
      const ctx = this.ctx, cv = this.els.viewport;
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      ctx.fillStyle = '#DED9CC';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      const it = this.selected();
      const layer = it && it.loc && this.layerOf(it.loc.image);
      if (!layer || !this.view.img) return;

      ctx.imageSmoothingEnabled = this.view.scale < 4;
      const [ox, oy] = [this.view.ox, this.view.oy];
      ctx.drawImage(this.view.img, ox, oy, layer.w * this.view.scale, layer.h * this.view.scale);

      // draft rectangle
      if (this.draft) {
        const [rx, ry] = this.imgToCanvas(this.draft.x, this.draft.y);
        const rw = this.draft.w * this.view.scale, rh = this.draft.h * this.view.scale;
        ctx.save();
        ctx.strokeStyle = '#E8531B';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(232,83,27,0.10)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.restore();
      }
      this.els.zoomLabel.textContent = fmtZoom(this.view.scale);
    },

    // ---------------------------------------------------------- closeup
    showCloseup() {
      if (this.mode === 'place') return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      ctx.fillStyle = '#DED9CC';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      this.els.zoomLabel.textContent = '';

      const it = this.selected();
      if (!it) { this.hintOnCanvas('No element selected'); return; }
      const layer = it.loc && this.layerOf(it.loc.image);
      if (!layer) { this.hintOnCanvas('Pick an image, then “Set on PCB”'); return; }
      if (!it.loc.quad) { this.hintOnCanvas('Not placed yet — “Set on PCB”'); return; }

      const rect = this.quadToImgRect(layer, it.loc.quad);
      const pad = Math.max(rect.w, rect.h) * 0.25 + 6;
      const rx = rect.x - pad, ry = rect.y - pad, rw = rect.w + pad * 2, rh = rect.h + pad * 2;
      const scale = Math.min(this.cssW / rw, this.cssH / rh);
      const dw = rw * scale, dh = rh * scale;
      const dx = (this.cssW - dw) / 2, dy = (this.cssH - dh) / 2;

      ctx.imageSmoothingEnabled = scale < 4;
      ctx.drawImage(this.bitmaps.get(layer.filename), rx, ry, rw, rh, dx, dy, dw, dh);

      // element outline
      const ex = dx + pad * scale, ey = dy + pad * scale, ew = rect.w * scale, eh = rect.h * scale;
      ctx.strokeStyle = '#E8531B';
      ctx.lineWidth = 2;
      ctx.strokeRect(ex, ey, ew, eh);
      // crosshair through element centre
      const cxp = ex + ew / 2, cyp = ey + eh / 2;
      ctx.strokeStyle = 'rgba(232,83,27,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dx, cyp); ctx.lineTo(dx + dw, cyp);
      ctx.moveTo(cxp, dy); ctx.lineTo(cxp, dy + dh);
      ctx.stroke();

      this.els.zoomLabel.textContent = fmtZoom(scale);
    },

    hintOnCanvas(text) {
      const ctx = this.ctx;
      ctx.fillStyle = '#8B8E8A';
      ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(text, this.cssW / 2, this.cssH / 2);
      ctx.textAlign = 'start';
    },

    // ---------------------------------------------------------- rendering
    renderThumbs() {
      const box = this.els.thumbs;
      box.innerHTML = '';
      const it = this.selected();
      const chosen = it && it.loc && it.loc.image;
      if (!this.layers.length) {
        box.innerHTML = '<div class="thumb-empty">No images.<br>Open a project.</div>';
        return;
      }
      for (const layer of this.layers) {
        const cell = document.createElement('button');
        cell.className = 'thumb' + (layer.filename === chosen ? ' on' : '');
        cell.title = layer.name;
        const cnv = document.createElement('canvas');
        cnv.width = 96; cnv.height = 72;
        drawThumb(cnv, this.bitmaps.get(layer.filename));
        cell.appendChild(cnv);
        if (layer.filename === chosen) {
          const star = document.createElement('span');
          star.className = 'thumb-star'; star.textContent = '★';
          cell.appendChild(star);
        }
        cell.onclick = () => this.chooseImage(layer.filename);
        box.appendChild(cell);
      }
    },

    renderEditor() {
      const it = this.selected();
      const e = this.els;
      const on = !!it;
      for (const f of [e.ref, e.type, e.val, e.desc, e.formSave, e.formDelete, e.placeBtn, e.addBtn]) {
        if (f === e.addBtn) continue;         // add is always enabled
        f.disabled = !on;
      }
      e.title.textContent = on ? (it.ref || 'Unnamed element') : 'No element selected';
      e.ref.value = on ? (it.ref || '') : '';
      e.type.value = on ? (it.type || TYPES[0]) : TYPES[0];
      e.val.value = on ? (it.value || '') : '';
      e.desc.value = on ? (it.description || '') : '';
      this.updatePlaceUI();
    },

    renderTable() {
      const body = this.els.table;
      body.innerHTML = '';
      this.els.count.textContent = this.items.length + (this.items.length === 1 ? ' item' : ' items');
      for (const it of this.items) {
        const tr = document.createElement('tr');
        if (it.id === this.selectedId) tr.className = 'active';
        const placed = it.loc && it.loc.quad;
        tr.innerHTML =
          `<td class="c-ref">${placed ? '<span class="dot placed" title="placed on board"></span>' : '<span class="dot" title="not placed"></span>'}<b>${escapeHtml(it.ref || '—')}</b></td>` +
          `<td class="c-type">${escapeHtml(it.type || '')}</td>` +
          `<td class="c-val">${escapeHtml(it.value || '—')}</td>` +
          `<td class="c-desc">${escapeHtml(it.description || '')}</td>`;
        const act = document.createElement('td');
        act.className = 'c-act';
        if (placed) {
          const view = document.createElement('button');
          view.className = 'icon-btn'; view.title = 'Open the board editor zoomed to this element'; view.textContent = '⤢';
          view.onclick = (ev) => { ev.stopPropagation(); this.locateOnBoard(it.id); };
          act.appendChild(view);
        }
        const locate = document.createElement('button');
        locate.className = 'icon-btn'; locate.title = 'Set / edit location on board'; locate.textContent = '⊹';
        locate.onclick = (ev) => { ev.stopPropagation(); this.select(it.id); this.mode = 'closeup'; this.togglePlace(); };
        const del = document.createElement('button');
        del.className = 'icon-btn danger'; del.title = 'Delete'; del.textContent = '✕';
        del.onclick = (ev) => { ev.stopPropagation(); this.deleteItem(it.id); };
        act.appendChild(locate); act.appendChild(del);
        tr.appendChild(act);
        tr.onclick = () => this.select(it.id);
        body.appendChild(tr);
      }
    },

    // ---------------------------------------------------------------- save
    markDirty() { this.dirty = true; this.els.saveBtn.classList.add('primary'); this.autosaveMeta(); },

    async saveProject() {
      if (!this.project) { this.status('Nothing loaded to save.'); return; }
      // commit any pending form edits for the selected item
      if (this.selected()) this.saveForm();
      this.project.version = 3;
      this.project.bom = this.items.map(serializeItem);
      this.status('Saving…');
      try {
        const blobs = this.images;
        // Persistence stores images under images/<name>; our map keys may include that prefix.
        const clean = new Map();
        for (const [k, v] of blobs.entries()) clean.set(k.replace(/^images\//, ''), v);
        const res = await Persistence.save(this.project, clean, this.saveFilename());
        if (res.aborted) { this.status('Save cancelled.'); return; }
        this.dirty = false;
        this.els.saveBtn.classList.remove('primary');
        this.status(res.method === 'download' ? 'Saved (downloaded ' + res.name + ').' : 'Saved to ' + res.name + '.');
      } catch (err) { this.status('Save failed: ' + err.message); console.error(err); }
    },

    saveFilename() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      return `pcbspy_data_${ts}.zip`;
    },

    // Export the component list (no images) as a CSV file.
    exportCsv() {
      if (this.selected()) this.saveForm();   // commit any pending edits first
      if (!this.items.length) { this.status('No components to export.'); return; }
      const cols = ['Ref', 'Type', 'Value', 'Description', 'Placed', 'Image'];
      const rows = [cols];
      for (const it of this.items) {
        rows.push([
          it.ref || '', it.type || '', it.value || '', it.description || '',
          (it.loc && it.loc.quad) ? 'yes' : 'no',
          (it.loc && it.loc.image) || '',
        ]);
      }
      // Prefix with a UTF-8 BOM so Excel opens accented text correctly.
      const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pcbspy_bom_${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.status('Exported ' + this.items.length + ' components to CSV.');
    },
  };

  // ---------------------------------------------------------------- helpers
  function normalizeItem(raw) {
    return {
      id: raw.id || uid('bom_'),
      ref: raw.ref || '',
      type: raw.type || TYPES[0],
      value: raw.value || '',
      description: raw.description || '',
      loc: raw.loc && raw.loc.image
        ? { image: raw.loc.image, quad: Array.isArray(raw.loc.quad) ? raw.loc.quad : null }
        : null,
    };
  }
  function serializeItem(it) {
    return {
      id: it.id, ref: it.ref, type: it.type, value: it.value, description: it.description,
      loc: it.loc && it.loc.image ? { image: it.loc.image, quad: it.loc.quad || null } : null,
    };
  }

  function nextRef(items) {
    // suggest U<n> style default; keep simple and unique
    let n = items.length + 1;
    const used = new Set(items.map(i => (i.ref || '').toUpperCase()));
    while (used.has('U' + n)) n++;
    return 'U' + n;
  }

  function drawThumb(cnv, bmp) {
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#2c4a35';
    ctx.fillRect(0, 0, cnv.width, cnv.height);
    if (!bmp) return;
    const s = Math.min(cnv.width / bmp.width, cnv.height / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    ctx.drawImage(bmp, (cnv.width - w) / 2, (cnv.height - h) / 2, w, h);
  }

  function fmtZoom(scale) {
    if (!scale || !isFinite(scale)) return '';
    return (scale >= 1 ? scale.toFixed(scale >= 10 ? 0 : 1) : scale.toFixed(2)) + '×';
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Flatten any embedded newlines (a Description is a textarea) to single spaces so a
  // record never spans multiple physical lines, then quote/escape for commas & quotes.
  function csvCell(v) {
    const s = String(v == null ? '' : v).replace(/\s*[\r\n]+\s*/g, ' ').trim();
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  global.BOM = BOM;
  BOM.TYPES = TYPES;
})(window);
