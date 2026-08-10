/* footprints.js — parse KiCad .kicad_mod footprints and rasterize them to a
   canvas so they can be placed as ordinary (image) layers.

   Simplified / monochrome rendering: copper pads filled, silkscreen + fab
   outlines stroked, drill holes punched through. Everything in one accent hue.
   The KiCad subset handled: module/footprint root, pad (circle/rect/roundrect/
   oval + drill), fp_line, fp_circle, fp_poly, fp_arc (3-point). Text/courtyard
   and 3D models are ignored. Coordinates are millimetres; Y is down (same as
   screen), so no flip is needed. */
(function (global) {
  'use strict';

  const PX_PER_MM = 40;   // render resolution
  const MAX_DIM = 1600;   // cap texture size
  const MARGIN_MM = 0.4;
  const PAD_COLOR = '#22d3ee';
  const OUTLINE_COLOR = '#a5f3fc';

  // ---- S-expression parser ----
  function tokenize(s) {
    const t = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(' || c === ')') { t.push(c); i++; }
      else if (c <= ' ') { i++; }
      else if (c === '"') {
        let j = i + 1, str = '';
        while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; str += s[j]; j++; }
        t.push({ a: str }); i = j + 1;
      } else {
        let j = i;
        while (j < s.length && s[j] > ' ' && s[j] !== '(' && s[j] !== ')' && s[j] !== '"') j++;
        t.push({ a: s.slice(i, j) }); i = j;
      }
    }
    return t;
  }
  function parseSexpr(text) {
    const toks = tokenize(text);
    let i = 0;
    while (i < toks.length && toks[i] !== '(') i++;
    function node() {
      i++; // skip '('
      const arr = [];
      while (i < toks.length && toks[i] !== ')') {
        if (toks[i] === '(') arr.push(node());
        else { arr.push(toks[i].a); i++; }
      }
      i++; // skip ')'
      return arr;
    }
    return i < toks.length ? node() : [];
  }
  const child = (arr, key) => arr.find(x => Array.isArray(x) && x[0] === key);
  const num = (v) => parseFloat(v);

  // ---- parse a footprint into pads + graphics ----
  function parseKicadMod(text) {
    const root = parseSexpr(text);
    const name = typeof root[1] === 'string' ? root[1] : 'footprint';
    const pads = [], graphics = [];
    for (const el of root) {
      if (!Array.isArray(el)) continue;
      if (el[0] === 'pad') {
        const at = child(el, 'at'), size = child(el, 'size');
        if (!at || !size) continue;
        const drillN = child(el, 'drill');
        let drill = null;
        if (drillN) {
          if (drillN[1] === 'oval') drill = { ox: num(drillN[2]), oy: num(drillN[3]) };
          else if (drillN[1] != null) drill = { d: num(drillN[1]) };
        }
        const rr = child(el, 'roundrect_rratio');
        pads.push({
          shape: el[3], x: num(at[1]), y: num(at[2]), rot: at[3] != null ? num(at[3]) : 0,
          sx: num(size[1]), sy: num(size[2]), drill, rratio: rr ? num(rr[1]) : 0.25,
        });
      } else if (el[0] === 'fp_line' || el[0] === 'fp_circle' || el[0] === 'fp_arc' || el[0] === 'fp_poly') {
        const layerN = child(el, 'layer');
        const layer = layerN ? layerN[1] : '';
        if (!/SilkS|Fab/.test(layer)) continue; // outline layers only
        const widthN = child(el, 'width');
        const w = widthN ? num(widthN[1]) : 0.12;
        if (el[0] === 'fp_line') {
          const s = child(el, 'start'), e = child(el, 'end');
          graphics.push({ t: 'line', x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w });
        } else if (el[0] === 'fp_circle') {
          const c = child(el, 'center'), e = child(el, 'end');
          graphics.push({ t: 'circle', cx: num(c[1]), cy: num(c[2]), r: Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])), w });
        } else if (el[0] === 'fp_arc') {
          const s = child(el, 'start'), m = child(el, 'mid'), e = child(el, 'end');
          if (s && m && e) graphics.push({ t: 'arc', p: [[num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]], w });
        } else if (el[0] === 'fp_poly') {
          const ptsN = child(el, 'pts');
          if (ptsN) {
            const pts = ptsN.filter(x => Array.isArray(x) && x[0] === 'xy').map(x => [num(x[1]), num(x[2])]);
            if (pts.length >= 2) graphics.push({ t: 'poly', pts, w });
          }
        }
      }
    }
    return { name, pads, graphics };
  }

  // ---- bounding box (mm) ----
  function bbox(fp) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
    for (const p of fp.pads) { const h = 0.5 * Math.hypot(p.sx, p.sy); acc(p.x - h, p.y - h); acc(p.x + h, p.y + h); }
    for (const g of fp.graphics) {
      const m = (g.w || 0.1) / 2;
      if (g.t === 'line') { acc(g.x1 - m, g.y1 - m); acc(g.x2 + m, g.y2 + m); acc(g.x2 - m, g.y2 - m); acc(g.x1 + m, g.y1 + m); }
      else if (g.t === 'circle') { acc(g.cx - g.r - m, g.cy - g.r - m); acc(g.cx + g.r + m, g.cy + g.r + m); }
      else if (g.t === 'poly' || g.t === 'arc') { for (const pt of (g.pts || g.p)) { acc(pt[0] - m, pt[1] - m); acc(pt[0] + m, pt[1] + m); } }
    }
    if (!isFinite(minX)) { minX = minY = -1; maxX = maxY = 1; }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function shapePath(ctx, shape, w, h, rratio) {
    ctx.beginPath();
    if (shape === 'circle') { ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); }
    else if (shape === 'oval') { roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) / 2); }
    else if (shape === 'roundrect') { roundRect(ctx, -w / 2, -h / 2, w, h, rratio * Math.min(w, h)); }
    else { ctx.rect(-w / 2, -h / 2, w, h); } // rect / trapezoid / custom
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function arcThrough(ctx, p, X, Y, scale) {
    // circle through 3 points -> sample
    const [a, b, c] = p;
    const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) { ctx.moveTo(X(ax), Y(ay)); ctx.lineTo(X(cx), Y(cy)); return; }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    let a0 = Math.atan2(ay - uy, ax - ux), a2 = Math.atan2(cy - uy, cx - ux);
    const am = Math.atan2(by - uy, bx - ux);
    // ensure the sampled arc passes through the mid point
    const norm = (t) => { while (t < a0) t += 2 * Math.PI; return t; };
    let end = norm(a2), mid = norm(am);
    if (mid > end) { end += 2 * Math.PI; } // shouldn't happen; guard
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (end - a0) * (i / steps);
      const px = X(ux + r * Math.cos(t)), py = Y(uy + r * Math.sin(t));
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
  }

  // ---- render to a canvas ----
  function render(fp) {
    const bb = bbox(fp);
    let scale = PX_PER_MM;
    const wPx = (bb.w + 2 * MARGIN_MM) * scale, hPx = (bb.h + 2 * MARGIN_MM) * scale;
    if (Math.max(wPx, hPx) > MAX_DIM) scale *= MAX_DIM / Math.max(wPx, hPx);
    const W = Math.max(2, Math.round((bb.w + 2 * MARGIN_MM) * scale));
    const H = Math.max(2, Math.round((bb.h + 2 * MARGIN_MM) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const X = (mm) => (mm - (bb.minX - MARGIN_MM)) * scale;
    const Y = (mm) => (mm - (bb.minY - MARGIN_MM)) * scale;

    // Outlines (silk + fab)
    ctx.strokeStyle = OUTLINE_COLOR; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.fillStyle = OUTLINE_COLOR;
    for (const g of fp.graphics) {
      ctx.lineWidth = Math.max(1, (g.w || 0.12) * scale);
      if (g.t === 'line') { ctx.beginPath(); ctx.moveTo(X(g.x1), Y(g.y1)); ctx.lineTo(X(g.x2), Y(g.y2)); ctx.stroke(); }
      else if (g.t === 'circle') { ctx.beginPath(); ctx.ellipse(X(g.cx), Y(g.cy), g.r * scale, g.r * scale, 0, 0, Math.PI * 2); ctx.stroke(); }
      else if (g.t === 'arc') { ctx.beginPath(); arcThrough(ctx, g.p, X, Y, scale); ctx.stroke(); }
      else if (g.t === 'poly') {
        ctx.beginPath(); ctx.moveTo(X(g.pts[0][0]), Y(g.pts[0][1]));
        for (let i = 1; i < g.pts.length; i++) ctx.lineTo(X(g.pts[i][0]), Y(g.pts[i][1]));
        ctx.closePath(); ctx.fill();
      }
    }

    // Pads (copper)
    ctx.fillStyle = PAD_COLOR;
    for (const p of fp.pads) {
      ctx.save();
      ctx.translate(X(p.x), Y(p.y));
      if (p.rot) ctx.rotate(-p.rot * Math.PI / 180);
      shapePath(ctx, p.shape, p.sx * scale, p.sy * scale, p.rratio);
      ctx.fill();
      ctx.restore();
    }
    // Drill holes (punch)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const p of fp.pads) {
      if (!p.drill) continue;
      ctx.save();
      ctx.translate(X(p.x), Y(p.y));
      if (p.rot) ctx.rotate(-p.rot * Math.PI / 180);
      ctx.beginPath();
      if (p.drill.d != null) ctx.ellipse(0, 0, p.drill.d / 2 * scale, p.drill.d / 2 * scale, 0, 0, Math.PI * 2);
      else roundRect(ctx, -p.drill.ox / 2 * scale, -p.drill.oy / 2 * scale, p.drill.ox * scale, p.drill.oy * scale, Math.min(p.drill.ox, p.drill.oy) / 2 * scale);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    return canvas;
  }

  // ---- controller (picker + placement) ----
  class Footprints {
    constructor(app) {
      this.app = app;
      this.modal = document.getElementById('footprintModal');
      this.list = null;
      this.index = null;
      this.cache = new Map(); // file -> parsed footprint
      const close = document.getElementById('fpClose');
      if (close) close.onclick = () => this.close();
      if (this.modal) this.modal.onclick = (e) => { if (e.target === this.modal) this.close(); };
    }

    async open() {
      this.modal.classList.add('open');
      const body = document.getElementById('fpItems');
      if (!this.index) {
        body.innerHTML = '<p class="panel-hint">Loading footprints…</p>';
        try {
          this.index = await this.loadIndex();
        } catch (e) {
          body.innerHTML = '<p class="panel-hint">No footprints available. Serve the folder over http (e.g. <code>python -m http.server</code>) or regenerate <code>js/footprints-data.js</code>.</p>';
          return;
        }
      }
      this.renderList();
    }
    close() { this.modal.classList.remove('open'); }

    // Prefer a live fetch (picks up files you add), fall back to the embedded
    // data so the picker also works when opened from disk (file://).
    async loadIndex() {
      try {
        const r = await fetch('footprints/index.json?b=' + Date.now());
        if (!r.ok) throw new Error('http ' + r.status);
        return await r.json();
      } catch (e) {
        if (global.FOOTPRINT_DATA && global.FOOTPRINT_DATA.index) return global.FOOTPRINT_DATA.index;
        throw e;
      }
    }
    async fileText(file) {
      try {
        const r = await fetch('footprints/' + file + '?b=' + Date.now());
        if (!r.ok) throw new Error('http ' + r.status);
        return await r.text();
      } catch (e) {
        if (global.FOOTPRINT_DATA && global.FOOTPRINT_DATA.files && global.FOOTPRINT_DATA.files[file] != null) {
          return global.FOOTPRINT_DATA.files[file];
        }
        throw e;
      }
    }

    async parseFile(file) {
      if (this.cache.has(file)) return this.cache.get(file);
      const text = await this.fileText(file);
      const fp = parseKicadMod(text);
      this.cache.set(file, fp);
      return fp;
    }

    async renderList() {
      const body = document.getElementById('fpItems');
      body.innerHTML = '';
      let cat = null;
      for (const it of this.index) {
        if (it.category !== cat) {
          cat = it.category;
          const h = document.createElement('div'); h.className = 'fp-cat'; h.textContent = cat;
          body.appendChild(h);
        }
        const card = document.createElement('button');
        card.className = 'fp-card';
        card.title = it.file;
        const thumb = document.createElement('div'); thumb.className = 'fp-thumb';
        const label = document.createElement('div'); label.className = 'fp-name'; label.textContent = it.name;
        card.append(thumb, label);
        card.onclick = () => this.place(it);
        body.appendChild(card);
        // lazy thumbnail
        this.parseFile(it.file).then(fp => {
          const c = render(fp);
          c.style.maxWidth = '64px'; c.style.maxHeight = '64px';
          c.style.width = 'auto'; c.style.height = 'auto';
          thumb.appendChild(c);
        }).catch(() => { thumb.textContent = '?'; });
      }
    }

    async place(it) {
      try {
        const fp = await this.parseFile(it.file);
        const canvas = render(fp);
        await this.app.addFootprintLayer(it.name, canvas);
        this.app.hint('Placed footprint: ' + it.name + '. Scale/align it onto your board.');
        this.close();
      } catch (e) {
        this.app.hint('Could not place footprint: ' + e.message);
      }
    }
  }

  Footprints.parseKicadMod = parseKicadMod;
  Footprints.render = render;
  global.Footprints = Footprints;
})(window);
