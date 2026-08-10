/* align.js — experimental landmark-based layer alignment wizard.

   Flow (mirrors common photo-alignment tools):
     Phase 0  Pick layers   — choose Top (reference, fixed) and Bottom (moving).
     Phase 1  Prepare       — optionally flip the Bottom layer H/V.
     Phase 2  Placement     — for each landmark: click the feature on the TOP
                              image, then the matching feature on the BOTTOM
                              image. Need 5..8 pairs. Arrow keys nudge, Delete
                              removes the current point.
     Phase 3  Review        — Compute Alignment (solves a least-squares homography
                              mapping Bottom's features onto Top's), then Accept.

   Math: the Top layer is the fixed common reference. Each pair stores
     a = target world position (clicked on Top), and
     b = the clicked feature in the Bottom layer's own source space
         (inverse(B.matrix) * worldClick) — invariant to B's transform.
   Compute solves H: bSrc -> aWorld (Mat3.homographyLS) and sets B.matrix = H. */
(function (global) {
  'use strict';

  const MIN_PAIRS = 5;
  const MAX_PAIRS = 8;
  // One distinct colour per landmark pair (shared by its Top and Bottom marker).
  const PALETTE = ['#ff5c5c', '#ffb03b', '#ffe14d', '#6ee36e', '#4dd2ff', '#7c8bff', '#c86bff', '#ff6bd6'];
  const pairColor = (i) => PALETTE[i % PALETTE.length];

  class Align {
    constructor(app) {
      this.app = app;
      this.panel = document.getElementById('alignPanel');
      this.active = false;
      this.reset();
      this.panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (btn && !btn.disabled) this.onAction(btn.dataset.action);
      });
    }

    reset() {
      this.phase = 0;
      this.refId = null;
      this.movId = null;
      this.origMatrix = null; // before any flip (Cancel restores this)
      this.prepMatrix = null; // after flips, before compute (Start Over restores)
      this.origOrder = null;  // layer z-order at start (restored on finish)
      this.pairs = [];
      this.curIndex = 0;
      this.curSide = 'a';
      this.history = [];
      this.future = [];
    }

    // Bring the layer for the active side to the front so you work on one image
    // at a time (Top up while placing on Top, Bottom up after Next).
    showSide(side) {
      const L = side === 'a' ? this.refLayer() : this.movLayer();
      if (!L) return;
      L.visible = true;
      const arr = this.app.layers;
      const i = arr.indexOf(L);
      if (i >= 0 && i !== arr.length - 1) { arr.splice(i, 1); arr.push(L); }
      this.app.activeId = L.id;
      this.app.renderPanel();
    }

    // Restore the original z-order (for review / after finishing).
    restoreOrder() {
      if (!this.origOrder) return;
      const order = this.origOrder.filter(l => this.app.layers.includes(l));
      for (const l of this.app.layers) if (!order.includes(l)) order.push(l);
      this.app.layers = order;
      this.app.renderPanel();
    }

    refLayer() { return this.app.layers.find(l => l.id === this.refId) || null; }
    movLayer() { return this.app.layers.find(l => l.id === this.movId) || null; }
    completed() { return this.pairs.filter(p => p.a && p.b); }

    // ---------------- lifecycle ----------------
    start() {
      if (this.app.layers.length < 2) {
        this.app.hint('Landmark alignment needs at least two image layers.');
        return;
      }
      this.reset();
      this.active = true;
      this.origOrder = this.app.layers.slice();
      this.app.setTool('pan'); // avoid annotation placement while aligning
      // default: Top = topmost layer, Bottom = the one below it
      const top = this.app.layers.length - 1;
      this.refId = this.app.layers[top].id;
      this.movId = this.app.layers[top - 1].id;
      this.panel.style.display = 'block';
      this.renderPanel();
    }

    finalize(accept) {
      if (!accept && this.origMatrix && this.movLayer()) {
        this.movLayer().matrix = this.origMatrix.slice();
      }
      this.restoreOrder();
      this.active = false;
      this.panel.style.display = 'none';
      this.app.hint(accept ? 'Alignment accepted.' : 'Alignment cancelled.');
      this.app.renderPanel();
    }

    // ---------------- history ----------------
    snapshot() {
      return {
        phase: this.phase,
        pairs: JSON.parse(JSON.stringify(this.pairs)),
        curIndex: this.curIndex,
        curSide: this.curSide,
        matrix: this.movLayer() ? this.movLayer().matrix.slice() : null,
      };
    }
    restore(s) {
      this.phase = s.phase;
      this.pairs = JSON.parse(JSON.stringify(s.pairs));
      this.curIndex = s.curIndex;
      this.curSide = s.curSide;
      if (s.matrix && this.movLayer()) this.movLayer().matrix = s.matrix.slice();
      if (this.phase === 2) this.showSide(this.curSide); else this.restoreOrder();
    }
    pushHistory() { this.history.push(this.snapshot()); this.future = []; if (this.history.length > 200) this.history.shift(); }
    undo() { if (!this.history.length) return; this.future.push(this.snapshot()); this.restore(this.history.pop()); this.renderPanel(); }
    redo() { if (!this.future.length) return; this.history.push(this.snapshot()); this.restore(this.future.pop()); this.renderPanel(); }

    // ---------------- actions ----------------
    onAction(action) {
      const mov = this.movLayer();
      switch (action) {
        case 'cancel': this.finalize(false); break;
        case 'undo': this.undo(); break;
        case 'redo': this.redo(); break;
        case 'startOver':
          this.pushHistory();
          if (this.prepMatrix && mov) mov.matrix = this.prepMatrix.slice();
          this.pairs = [{ a: null, b: null }];
          this.curIndex = 0; this.curSide = 'a';
          this.phase = 2;
          this.showSide('a');
          this.renderPanel();
          break;
        case 'phase0next': {
          const ref = document.getElementById('alignRef').value;
          const movSel = document.getElementById('alignMov').value;
          if (ref === movSel) { this.app.hint('Top and Bottom must be different layers.'); return; }
          this.refId = ref; this.movId = movSel;
          this.origMatrix = this.movLayer().matrix.slice();
          this.phase = 1;
          this.renderPanel();
          break;
        }
        case 'flipH': this.flip('h'); break;
        case 'flipV': this.flip('v'); break;
        case 'begin':
          this.prepMatrix = mov.matrix.slice();
          this.pairs = [{ a: null, b: null }];
          this.curIndex = 0; this.curSide = 'a';
          this.phase = 2;
          this.showSide('a');
          this.renderPanel();
          break;
        case 'next': this.nextStep(); break;
        case 'compute': this.compute(); break;
        case 'accept': this.finalize(true); break;
      }
    }

    flip(axis) {
      const mov = this.movLayer();
      if (!mov) return;
      this.pushHistory();
      const c = this.app.centroid(mov);
      const S = axis === 'h' ? Mat3.scale(-1, 1) : Mat3.scale(1, -1);
      mov.matrix = Mat3.multiply(Mat3.aboutPivot(S, c[0], c[1]), mov.matrix);
    }

    nextStep() {
      this.pushHistory();
      if (this.curSide === 'a') {
        this.curSide = 'b';
      } else {
        if (this.curIndex === this.pairs.length - 1 && this.pairs.length < MAX_PAIRS) {
          this.pairs.push({ a: null, b: null });
        }
        this.curIndex = Math.min(this.curIndex + 1, this.pairs.length - 1);
        this.curSide = 'a';
      }
      this.showSide(this.curSide);
      this.renderPanel();
    }

    // ---------------- canvas interaction ----------------
    onCanvasDown(wp, sp) {
      if (this.phase !== 2 && this.phase !== 3) return;
      const mov = this.movLayer();
      if (!mov) return;
      // Clicking an existing (different) landmark selects it for nudging/re-placing.
      const hit = this.hitLandmark(sp);
      if (hit && !(hit.index === this.curIndex && hit.side === this.curSide)) {
        this.curIndex = hit.index;
        this.curSide = hit.side;
        this.showSide(this.curSide);
        this.renderPanel();
        return;
      }
      this.pushHistory();
      const p = this.pairs[this.curIndex];
      if (this.curSide === 'a') {
        p.a = [wp[0], wp[1]];
      } else {
        p.b = Mat3.apply(Mat3.invert(mov.matrix), wp); // store in Bottom source space
      }
      this.renderPanel();
    }

    // Screen-space hit test against placed landmark markers; topmost/newest first.
    hitLandmark(sp) {
      if (!sp) return null;
      const mov = this.movLayer();
      const cam = this.app.cam;
      for (let i = this.pairs.length - 1; i >= 0; i--) {
        const p = this.pairs[i];
        if (p.b && mov) {
          const s = cam.worldToScreen(Mat3.apply(mov.matrix, p.b));
          if (Math.hypot(sp[0] - s[0], sp[1] - s[1]) <= 11) return { index: i, side: 'b' };
        }
        if (p.a) {
          const s = cam.worldToScreen(p.a);
          if (Math.hypot(sp[0] - s[0], sp[1] - s[1]) <= 11) return { index: i, side: 'a' };
        }
      }
      return null;
    }

    onKey(e) {
      if (!this.active) return false;
      if (e.key === 'Escape') { this.finalize(false); return true; }
      if (this.phase !== 2 && this.phase !== 3) return false;
      const p = this.pairs[this.curIndex];
      if (!p) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.pushHistory();
        p[this.curSide] = null;
        this.renderPanel();
        return true;
      }
      const step = (e.shiftKey ? 5 : 1) / this.app.camera.zoom;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step; else if (e.key === 'ArrowDown') dy = step;
      else return false;
      const cur = p[this.curSide];
      if (!cur) return true;
      this.pushHistory();
      const mov = this.movLayer();
      if (this.curSide === 'a') {
        cur[0] += dx; cur[1] += dy;
      } else {
        const w = Mat3.apply(mov.matrix, cur);
        w[0] += dx; w[1] += dy;
        p.b = Mat3.apply(Mat3.invert(mov.matrix), w);
      }
      this.renderPanel();
      return true;
    }

    // ---------------- compute ----------------
    compute() {
      const done = this.completed();
      if (done.length < MIN_PAIRS) { this.app.hint('Place at least ' + MIN_PAIRS + ' landmark pairs first.'); return; }
      const mov = this.movLayer();
      const srcB = done.map(p => p.b);   // Bottom source coords
      const dstA = done.map(p => p.a);   // target world coords (on Top)
      const H = Mat3.homographyLS(srcB, dstA);
      mov.matrix = H;
      this.phase = 3;
      this.restoreOrder(); // show both overlaid for review
      this.renderPanel();
      this.app.hint('Alignment computed from ' + done.length + ' pairs. Review, then Accept.');
    }

    // ---------------- drawing (called from app.drawOverlay) ----------------
    draw(ctx, cam) {
      const mov = this.movLayer();
      ctx.save();
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      this.pairs.forEach((p, i) => {
        const color = pairColor(i);
        let as = null, bs = null;
        if (p.a) as = cam.worldToScreen(p.a);
        if (p.b && mov) bs = cam.worldToScreen(Mat3.apply(mov.matrix, p.b));
        if (as && bs) {
          ctx.beginPath(); ctx.moveTo(as[0], as[1]); ctx.lineTo(bs[0], bs[1]);
          ctx.globalAlpha = 0.55; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (as) this.marker(ctx, as, color, i + 1, 'a', i === this.curIndex && this.curSide === 'a');
        if (bs) this.marker(ctx, bs, color, i + 1, 'b', i === this.curIndex && this.curSide === 'b');
      });
      ctx.restore();
    }

    // side 'a' = Top (plain circle), side 'b' = Bottom (white ring to tell them apart).
    marker(ctx, s, color, label, side, current) {
      const r = 8;
      if (current) {
        ctx.beginPath(); ctx.arc(s[0], s[1], r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = side === 'b' ? 2.5 : 1.5;
      ctx.strokeStyle = side === 'b' ? '#ffffff' : '#12151a';
      ctx.stroke();
      ctx.fillStyle = '#0a0d12';
      ctx.fillText(String(label), s[0], s[1] + 0.5);
    }

    // ---------------- panel UI ----------------
    renderPanel() {
      this.panel.innerHTML = this[`phase${this.phase}Html`]();
      if (this.phase === 0) {
        this.fillSelect('alignRef', this.refId);
        this.fillSelect('alignMov', this.movId);
      }
    }

    fillSelect(id, selectedId) {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '';
      // top of the visual stack first, to match the layer panel
      for (let i = this.app.layers.length - 1; i >= 0; i--) {
        const l = this.app.layers[i];
        const opt = document.createElement('option');
        opt.value = l.id; opt.textContent = l.name;
        if (l.id === selectedId) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    header(sub, phaseLabel) {
      return `<div class="al-head"><div><h3>Landmark Alignment</h3><div class="al-sub">${sub}</div></div>
              <span class="al-phase">${phaseLabel}</span></div>`;
    }

    sessionHtml() {
      const u = this.history.length ? '' : 'disabled';
      const r = this.future.length ? '' : 'disabled';
      return `<div class="al-session">SESSION
        <div class="al-row2">
          <button class="btn" data-action="undo" ${u}>Undo</button>
          <button class="btn" data-action="redo" ${r}>Redo</button>
        </div>
        <button class="btn" data-action="startOver">Start Over</button>
        <button class="btn danger-solid" data-action="cancel">Cancel</button>
      </div>`;
    }

    phase0Html() {
      return this.header('Choose Layers', 'Phase 0') +
        `<p class="al-text">Pick the fixed reference (Top) and the layer to move onto it (Bottom).</p>
         <label class="al-field">Top (reference)<select id="alignRef"></select></label>
         <label class="al-field">Bottom (moving)<select id="alignMov"></select></label>
         <button class="btn primary" data-action="phase0next">Next → Prepare</button>
         <button class="btn danger-solid" data-action="cancel">Cancel</button>`;
    }

    phase1Html() {
      return this.header('Image Preparation', 'Phase 1') +
        `<p class="al-text">If the Bottom photo is mirror-reversed compared to the Top, flip it. Then click <i>Begin Landmark Placement</i>.</p>
         <button class="btn" data-action="flipH">Flip Bottom Horizontally</button>
         <button class="btn" data-action="flipV">Flip Bottom Vertically</button>
         <button class="btn primary" data-action="begin">Begin Landmark Placement →</button>` +
        this.sessionHtml();
    }

    phase2Html() {
      const done = this.completed().length;
      const need = Math.max(0, MIN_PAIRS - done);
      const side = this.curSide === 'a' ? 'TOP' : 'BOTTOM';
      const color = pairColor(this.curIndex);
      const needTxt = need > 0 ? `<span class="al-need">${need} more needed</span>` : `<span class="al-ok">ready</span>`;
      const canCompute = done >= MIN_PAIRS ? '' : 'disabled';
      return this.header('Landmark Placement', 'Phase 2') +
        `<p class="al-text">Click ${this.curSide === 'a' ? 'a distinctive feature on the' : 'the matching feature on the'} <b>${side}</b> photo.</p>
         <p class="al-hint">The <b>${side}</b> image is brought to the front automatically. Zoom with the wheel and Space-drag to pan to the feature, then click. Mounting holes &gt; vias &gt; pad corners — spread across the board.</p>
         <div class="al-count"><b>${done}</b> / ${MAX_PAIRS} landmark pairs ${needTxt}</div>
         <p class="al-hint"><span class="al-chip" style="background:${color}"></span> Landmark ${this.curIndex + 1} (${side}) — click a placed marker to reselect, arrow keys nudge 1px (Shift = 5px), Delete to remove.</p>
         <button class="btn primary" data-action="next">Next → ${this.curSide === 'a' ? 'Bottom' : 'Top'} photo</button>
         <button class="btn ok" data-action="compute" ${canCompute}>Compute Alignment</button>` +
        this.sessionHtml();
    }

    phase3Html() {
      const done = this.completed().length;
      return this.header('Review & Accept', 'Phase 3') +
        `<p class="al-text">${done} pairs used. Recompute if you adjust points, then accept.</p>
         <button class="btn" data-action="compute">Recompute Alignment</button>
         <button class="btn ok" data-action="accept">Accept Alignment</button>` +
        this.sessionHtml();
    }
  }

  global.Align = Align;
})(window);
