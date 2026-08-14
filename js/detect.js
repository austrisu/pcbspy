/* detect.js — client-side automatic component detection for a PCBSpy project.

   A component-trained YOLO detector runs fully in the browser via ONNX Runtime
   Web (global `ort`, loaded from a <script> in detect.html). Pipeline per the
   spec: letterbox -> normalize (NCHW) -> session.run -> decode [1,4+C,P] ->
   threshold -> inverse-map -> NMS. Class output is discarded (localization only).

   The chosen image is fed at native resolution, so detected boxes are already in
   that image's pixel space; on "Add to BOM" they convert to WORLD-space corners
   via the layer matrix (same model as bom.js) and append to project.bom in the
   shared IndexedDB store, then hand off to bom.html for field editing.

   Depends on globals: ort (onnxruntime-web), Mat3, Persistence, ProjectStore. */
(function (global) {
  'use strict';

  const DEFAULTS = {
    confThreshold: 0.25, iouThreshold: 0.45, classAgnostic: true,
    maxDetections: 300, inputSize: 640, executionProvider: 'wasm',
    padColor: 114, minBoxFrac: 0, maxBoxFrac: 1.0,
  };
  // Where the ONNX Runtime Web assets come from (CDN — downloads once, then cached).
  const ORT_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
  const DEFAULT_MODEL_URL = 'models/pcb_components.onnx';

  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ------------------------------------------------------------------ Detector
  class Detector {
    static async load(url, cfg = {}) {
      const c = { ...DEFAULTS, ...cfg };
      if (!global.ort) throw new Error('ONNX Runtime Web (ort) failed to load.');
      try { global.ort.env.wasm.wasmPaths = ORT_WASM_PATH; } catch (_) {}
      const want = c.executionProvider === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
      let session;
      try {
        session = await global.ort.InferenceSession.create(url, { executionProviders: want });
      } catch (e) {
        if (c.executionProvider === 'webgpu') session = await global.ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
        else throw e;
      }
      const d = new Detector();
      d.session = session; d.c = c;
      d.inName = session.inputNames[0];
      d.outName = session.outputNames[0];
      await d._warmup();   // hide WASM/WebGPU cold-start behind load
      return d;
    }

    async _warmup() {
      try {
        const S = this.c.inputSize;
        const feed = {}; feed[this.inName] = new global.ort.Tensor('float32', new Float32Array(3 * S * S), [1, 3, S, S]);
        await this.session.run(feed);
      } catch (_) { /* non-fatal */ }
    }

    _letterbox(canvas) {
      const S = this.c.inputSize;
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const g = cv.getContext('2d');
      const r = Math.min(S / canvas.width, S / canvas.height);
      const nw = canvas.width * r, nh = canvas.height * r;
      const px = (S - nw) / 2, py = (S - nh) / 2;
      g.fillStyle = `rgb(${this.c.padColor},${this.c.padColor},${this.c.padColor})`;
      g.fillRect(0, 0, S, S);
      g.drawImage(canvas, px, py, nw, nh);
      const data = g.getImageData(0, 0, S, S).data, n = S * S;
      const t = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        t[i] = data[i * 4] / 255; t[n + i] = data[i * 4 + 1] / 255; t[2 * n + i] = data[i * 4 + 2] / 255;
      }
      return { t, r, px, py };
    }

    _decode(out, dims, m) {
      const c = this.c;
      const A = c.inputSize * c.inputSize;
      // Ultralytics raw output is [1, 4+C, P] (channel-major). Baked-NMS export is
      // [1, N, 6] — support both.
      if (dims.length === 3 && dims[2] === 6 && dims[1] >= 1 && dims[1] !== 6) {
        const boxes = [];
        const N = dims[1];
        for (let i = 0; i < N; i++) {
          const o = i * 6;
          const score = out[o + 4];
          if (score < c.confThreshold) continue;
          let x = out[o], y = out[o + 1], x2 = out[o + 2], y2 = out[o + 3];
          let w = x2 - x, h = y2 - y;
          if (w * h < A * c.minBoxFrac || w * h > A * c.maxBoxFrac) continue;
          x = (x - m.px) / m.r; y = (y - m.py) / m.r; w = w / m.r; h = h / m.r;
          boxes.push([x, y, w, h, score]);
        }
        return boxes.sort((a, b) => b[4] - a[4]).slice(0, c.maxDetections);
      }

      const nc = dims[1], np = dims[2];
      const boxes = [];
      for (let p = 0; p < np; p++) {
        let score = 0;
        for (let k = 4; k < nc; k++) { const v = out[k * np + p]; if (v > score) score = v; }
        if (score < c.confThreshold) continue;
        const cx = out[p], cy = out[np + p], w = out[2 * np + p], h = out[3 * np + p];
        if (w * h < A * c.minBoxFrac || w * h > A * c.maxBoxFrac) continue;
        const x = (cx - w / 2 - m.px) / m.r, y = (cy - h / 2 - m.py) / m.r;
        boxes.push([x, y, w / m.r, h / m.r, score]);
      }
      return nms(boxes, c.iouThreshold).slice(0, c.maxDetections);
    }

    async detect(canvas) {
      const m = this._letterbox(canvas);
      const S = this.c.inputSize;
      const feed = {}; feed[this.inName] = new global.ort.Tensor('float32', m.t, [1, 3, S, S]);
      const out = await this.session.run(feed);
      const o = out[this.outName];
      return this._decode(o.data, o.dims, m);
    }
  }

  function iou(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1), i = w * h;
    return i / (a[2] * a[3] + b[2] * b[3] - i);
  }
  function nms(boxes, thr) {
    boxes.sort((p, q) => q[4] - p[4]);
    const keep = [];
    for (const b of boxes) { if (keep.every(k => iou(b, k) < thr)) keep.push(b); }
    return keep;
  }

  // ------------------------------------------------------------- page controller
  const Detect = {
    project: null, images: new Map(), bitmaps: new Map(),
    layers: [],                 // [{filename,name,matrix,w,h}]
    chosen: null,               // filename of the image being detected
    detector: null, modelUrl: DEFAULT_MODEL_URL,
    boxes: [],                  // last detection, in chosen-image pixel coords
    cfg: { ...DEFAULTS },
    els: {},

    async init() {
      this.cacheEls();
      this.bindUI();
      this.syncCfgInputs();
      await this.restoreFromStore();
      this.drawPreview();
      this.updateModelStatus(global.ort ? 'Model not loaded. Click “Load model”.' : 'ONNX Runtime failed to load (check your connection).');
    },

    cacheEls() {
      const id = (x) => document.getElementById(x);
      this.els = {
        openBtn: id('openBtn'), demoBtn: id('demoBtn'),
        loadModelBtn: id('loadModelBtn'), modelFile: id('modelFile'),
        runBtn: id('runBtn'), addBtn: id('addBtn'),
        thumbs: id('thumbs'), canvas: id('preview'),
        modelStatus: id('modelStatus'), status: id('status'), count: id('count'),
        conf: id('pConf'), confV: id('pConfV'),
        iou: id('pIou'), iouV: id('pIouV'),
        inputSize: id('pInputSize'), maxDet: id('pMaxDet'),
        minFrac: id('pMinFrac'), maxFrac: id('pMaxFrac'), ep: id('pEp'),
      };
      this.ctx = this.els.canvas.getContext('2d');
    },

    bindUI() {
      const e = this.els;
      e.openBtn.onclick = () => this.openProject();
      e.demoBtn.onclick = () => this.loadDemo();
      e.loadModelBtn.onclick = () => this.loadModel();
      e.modelFile.onchange = () => { if (e.modelFile.files[0]) this.loadModel(e.modelFile.files[0]); };
      e.runBtn.onclick = () => this.run();
      e.addBtn.onclick = () => this.addToBom();
      e.conf.oninput = () => { this.cfg.confThreshold = +e.conf.value; e.confV.textContent = (+e.conf.value).toFixed(2); };
      e.iou.oninput = () => { this.cfg.iouThreshold = +e.iou.value; e.iouV.textContent = (+e.iou.value).toFixed(2); };
      e.inputSize.onchange = () => { this.cfg.inputSize = +e.inputSize.value; };
      e.maxDet.onchange = () => { this.cfg.maxDetections = clamp(+e.maxDet.value || 300, 1, 1000); };
      e.minFrac.onchange = () => { this.cfg.minBoxFrac = clamp(+e.minFrac.value || 0, 0, 0.05); };
      e.maxFrac.onchange = () => { this.cfg.maxBoxFrac = clamp(+e.maxFrac.value || 1, 0.05, 1); };
      e.ep.onchange = () => { this.cfg.executionProvider = e.ep.value; this.detector = null; this.updateModelStatus('Provider changed — reload the model.'); };
      window.addEventListener('resize', () => this.drawPreview());
    },

    syncCfgInputs() {
      const e = this.els, c = this.cfg;
      e.conf.value = c.confThreshold; e.confV.textContent = c.confThreshold.toFixed(2);
      e.iou.value = c.iouThreshold; e.iouV.textContent = c.iouThreshold.toFixed(2);
      e.inputSize.value = String(c.inputSize);
      e.maxDet.value = c.maxDetections;
      e.minFrac.value = c.minBoxFrac;
      e.maxFrac.value = c.maxBoxFrac;
      e.ep.value = c.executionProvider;
    },

    status(m) { this.els.status.textContent = m || ''; },
    updateModelStatus(m) { this.els.modelStatus.textContent = m || ''; },

    // ---- project load (shared store, or Open/Demo) ----
    async restoreFromStore() {
      try {
        const data = ProjectStore.available ? await ProjectStore.load() : null;
        if (data && data.project && (data.project.layers || []).length) {
          await this.applyProject(data.project, data.images);
          this.status('Loaded current project (' + this.layers.length + ' images).');
        } else {
          this.status('No project in this session — Open a .zip or Load Demo.');
        }
      } catch (e) { console.warn('Restore failed:', e); }
    },
    async openProject() {
      let file;
      try { file = await Persistence.pickZip(); } catch (err) { this.status('Open failed: ' + err.message); return; }
      if (!file) return;
      try {
        const { project, images } = await Persistence.loadZip(file);
        await this.applyProject(project, images);
        if (ProjectStore.available) { const clean = new Map(); for (const [k, v] of images.entries()) clean.set(k.replace(/^images\//, ''), v); await ProjectStore.save(project, clean); }
        this.status('Loaded project (' + this.layers.length + ' images).');
      } catch (err) { this.status('Load failed: ' + err.message); }
    },
    async loadDemo() {
      this.status('Loading demo…');
      try {
        const res = await fetch('demo.zip?b=' + Date.now());
        if (!res.ok) throw new Error('demo.zip not found (' + res.status + ')');
        const { project, images } = await Persistence.loadZip(await res.blob());
        await this.applyProject(project, images);
        if (ProjectStore.available) { const clean = new Map(); for (const [k, v] of images.entries()) clean.set(k.replace(/^images\//, ''), v); await ProjectStore.save(project, clean); }
        this.status('Loaded demo (' + this.layers.length + ' images).');
      } catch (err) { this.status('Could not load demo: ' + err.message + (location.protocol === 'file:' ? ' — serve over http to fetch demo.zip.' : '')); }
    },

    async applyProject(project, images) {
      this.project = project; this.images = images;
      this.bitmaps = new Map(); this.layers = []; this.chosen = null; this.boxes = [];
      for (const ld of project.layers || []) {
        const blob = images.get(ld.filename) || images.get('images/' + ld.filename);
        if (!blob) continue;
        let bmp; try { bmp = await createImageBitmap(blob); } catch (_) { continue; }
        this.bitmaps.set(ld.filename, bmp);
        this.layers.push({
          filename: ld.filename, name: ld.name || ld.filename,
          matrix: (ld.matrix && ld.matrix.length === 9) ? ld.matrix.slice() : Mat3.identity(),
          w: bmp.width, h: bmp.height,
        });
      }
      if (this.layers.length) this.chosen = this.layers[this.layers.length - 1].filename;  // front-most
      this.renderThumbs();
      this.drawPreview();
      this.updateCount();
    },

    layerOf(fn) { return this.layers.find(l => l.filename === fn) || null; },
    imgToWorld(layer, px, py) { return Mat3.apply(layer.matrix, [px / layer.w, py / layer.h]); },

    // ---- model ----
    async loadModel(file) {
      if (!global.ort) { this.updateModelStatus('ONNX Runtime not available.'); return; }
      const src = file ? URL.createObjectURL(file) : this.modelUrl;
      this.updateModelStatus('Loading model' + (file ? ' (' + file.name + ')' : ' from ' + this.modelUrl) + '…');
      try {
        this.detector = await Detector.load(src, this.cfg);
        this.updateModelStatus('Model ready (' + this.cfg.executionProvider + '). Choose an image and Run.');
      } catch (e) {
        this.detector = null;
        this.updateModelStatus('Model load failed: ' + e.message + (file ? '' : ' — put a component .onnx at ' + this.modelUrl + ', or use “Load .onnx file”.'));
        console.error(e);
      } finally {
        if (file) setTimeout(() => URL.revokeObjectURL(src), 2000);
      }
    },

    // ---- run detection on the chosen image ----
    async run() {
      const layer = this.chosen && this.layerOf(this.chosen);
      if (!layer) { this.status('Choose an image first.'); return; }
      if (!this.detector) { this.status('Load a model first.'); return; }
      // Feed the image at native resolution so boxes are in image-pixel space.
      const bmp = this.bitmaps.get(layer.filename);
      const cv = document.createElement('canvas'); cv.width = layer.w; cv.height = layer.h;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      this.status('Detecting…'); this.els.runBtn.disabled = true;
      try {
        const t0 = performance.now();
        // keep runtime config in sync with the sliders
        this.detector.c = { ...this.detector.c, ...this.cfg };
        this.boxes = await this.detector.detect(cv);
        const ms = Math.round(performance.now() - t0);
        this.status('Found ' + this.boxes.length + ' components in ' + ms + ' ms on “' + layer.name + '”.');
      } catch (e) {
        this.status('Detection failed: ' + e.message);
        console.error(e);
      } finally {
        this.els.runBtn.disabled = false;
        this.drawPreview();
        this.updateCount();
      }
    },

    // ---- add detections to the BOM and hand off ----
    async addToBom() {
      if (!this.boxes.length) { this.status('Nothing to add — run detection first.'); return; }
      const layer = this.chosen && this.layerOf(this.chosen);
      if (!layer || !this.project) { this.status('No project/image.'); return; }
      const existing = Array.isArray(this.project.bom) ? this.project.bom : [];
      const start = existing.length;
      const items = this.boxes.map((b, i) => {
        const [x, y, w, h] = b;
        const quad = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => this.imgToWorld(layer, px, py));
        return { id: uid('bom_'), ref: 'U' + (start + i + 1), type: '', value: '', description: '', loc: { image: layer.filename, quad } };
      });
      this.project.bom = existing.concat(items);
      this.project.version = 3;
      try { if (ProjectStore.available) await ProjectStore.saveMeta(this.project); } catch (e) { console.warn(e); }
      this.status('Added ' + items.length + ' components to the BOM.');
      window.location.href = 'bom.html';
    },

    // ---- rendering ----
    renderThumbs() {
      const box = this.els.thumbs;
      box.innerHTML = '';
      if (!this.layers.length) { box.innerHTML = '<div class="thumb-empty">No images.<br>Open a project.</div>'; return; }
      for (const layer of this.layers) {
        const cell = document.createElement('button');
        cell.className = 'thumb' + (layer.filename === this.chosen ? ' on' : '');
        cell.title = layer.name;
        const cnv = document.createElement('canvas'); cnv.width = 96; cnv.height = 72;
        const g = cnv.getContext('2d'); g.fillStyle = '#2c4a35'; g.fillRect(0, 0, 96, 72);
        const bmp = this.bitmaps.get(layer.filename);
        if (bmp) { const s = Math.min(96 / bmp.width, 72 / bmp.height); const w = bmp.width * s, h = bmp.height * s; g.drawImage(bmp, (96 - w) / 2, (72 - h) / 2, w, h); }
        cell.appendChild(cnv);
        if (layer.filename === this.chosen) { const st = document.createElement('span'); st.className = 'thumb-star'; st.textContent = '★'; cell.appendChild(st); }
        cell.onclick = () => { this.chosen = layer.filename; this.boxes = []; this.renderThumbs(); this.drawPreview(); this.updateCount(); this.status('Detecting image: ' + layer.name); };
        box.appendChild(cell);
      }
    },

    updateCount() {
      this.els.count.textContent = this.boxes.length + (this.boxes.length === 1 ? ' box' : ' boxes');
      this.els.addBtn.disabled = !this.boxes.length;
    },

    fitCanvas() {
      const cv = this.els.canvas, r = cv.parentElement.getBoundingClientRect();
      const dpr = global.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cssW = r.width; this.cssH = r.height;
    },

    drawPreview() {
      this.fitCanvas();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      ctx.fillStyle = '#DED9CC'; ctx.fillRect(0, 0, this.cssW, this.cssH);
      const layer = this.chosen && this.layerOf(this.chosen);
      if (!layer) { ctx.fillStyle = '#8B8E8A'; ctx.font = '12px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.fillText('Open a project and pick an image', this.cssW / 2, this.cssH / 2); ctx.textAlign = 'start'; return; }
      const bmp = this.bitmaps.get(layer.filename);
      const s = Math.min(this.cssW / layer.w, this.cssH / layer.h);
      const dw = layer.w * s, dh = layer.h * s, dx = (this.cssW - dw) / 2, dy = (this.cssH - dh) / 2;
      ctx.drawImage(bmp, dx, dy, dw, dh);
      ctx.strokeStyle = '#E8531B'; ctx.lineWidth = 1.5;
      ctx.fillStyle = 'rgba(232,83,27,0.08)';
      for (const b of this.boxes) {
        const [x, y, w, h] = b;
        ctx.fillRect(dx + x * s, dy + y * s, w * s, h * s);
        ctx.strokeRect(dx + x * s, dy + y * s, w * s, h * s);
      }
    },
  };

  global.Detect = Detect;
  global.Detector = Detector;
})(window);
