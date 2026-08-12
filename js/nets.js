/* nets.js — experimental PCB net model built on the dot/line annotations.

   Electrical model:
     Nodes = electrical dots (via / hole / ground / vcc; tags excluded).
     Edges = lines, connecting the dot under their FIRST vertex to the dot under
             their LAST vertex (2-terminal). Connectivity is transitive through
             shared dots (union-find).
     Premade nets: every Ground dot is on GND, every Vcc dot is on VCC (all
             grounds share one net, all vccs share one net). A dot connected to
             any of them inherits that net.
     User nets: a dot may carry a `net` name (CLK, DATA0…); its whole connected
             group adopts it.
     A group carrying two different nets (GND+VCC, or two named nets) is a SHORT. */
(function (global) {
  'use strict';

  const ELEC = ['via', 'tag', 'pad', 'ground', 'vcc']; // electrical dot kinds (holes are mechanical, not electrical)
  const DEFAULT_NETS = ['GND', 'VCC']; // premade nets that always exist
  const PALETTE = ['#4dd2ff', '#6ee36e', '#ffd166', '#c86bff', '#ff9f43', '#7c8bff', '#ff6bd6', '#3ddc84'];
  const GND_COLOR = '#9aa3b0';
  const VCC_COLOR = '#ff3b3b';
  const SHORT_COLOR = '#ff2d2d';

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function netColorFor(name, short) {
    if (short) return SHORT_COLOR;
    if (name === 'GND') return GND_COLOR;
    if (name === 'VCC') return VCC_COLOR;
    return PALETTE[hash(name) % PALETTE.length];
  }

  // Kinds that may carry/show a net (holes can be assigned a net manually, even
  // though they are not line-connectable — see ELEC above).
  const NETABLE = ['via', 'tag', 'hole', 'pad', 'ground', 'vcc'];

  class Nets {
    constructor(app) {
      this.app = app;
      this.colorByNet = false;
      this.highlightNet = null; // net name to emphasise on hover
      this.panel = document.getElementById('netsView');
    }

    isElectrical(s) { return s.type === 'point' && ELEC.includes(s.kind || 'via'); }
    electricalDots() { return this.app.ann.shapes.filter(s => this.isElectrical(s)); }
    // Dots that can hold/show a net (includes holes).
    netableDots() { return this.app.ann.shapes.filter(s => s.type === 'point' && NETABLE.includes(s.kind || 'via')); }
    getDot(id) { return this.app.ann.shapes.find(s => s.id === id) || null; }

    // Nearest electrical dot to a WORLD point, within its own radius + margin.
    matchDot(wp, dots) {
      let best = null, bestD = Infinity;
      for (const d of dots) {
        const dist = Math.hypot(d.x - wp[0], d.y - wp[1]);
        const reach = (d.size || 6) + 6;
        if (dist <= reach && dist < bestD) { best = d; bestD = dist; }
      }
      return best;
    }

    // A dot is on `side` if same side, or either is 'through' (through bridges).
    sameSide(d, side) { const ds = d.side || 'top'; return !side || ds === side || ds === 'through' || side === 'through'; }

    // Nearest electrical dot to a SCREEN point (for selecting / snapping), optionally
    // restricted to a side (+ through).
    hitDotScreen(sp, pad, side) {
      const cam = this.app.cam;
      let best = null, bestD = Infinity;
      for (const d of this.electricalDots()) {
        if (side && !this.sameSide(d, side)) continue;
        const s = cam.worldToScreen([d.x, d.y]);
        const r = this.app.ann.pointScreenRadius(d, cam) + (pad || 6);
        const dist = Math.hypot(sp[0] - s[0], sp[1] - s[1]);
        if (dist <= r && dist < bestD) { best = d; bestD = dist; }
      }
      return best;
    }

    // If a screen point is over an electrical dot (on `side` ∪ through), return its
    // world centre (for snapping line endpoints onto dots), else null.
    snapToDot(sp, side) {
      const d = this.hitDotScreen(sp, 8, side);
      return d ? [d.x, d.y] : null;
    }

    // A dot's net: explicit assignment, or the anchor for ground/vcc.
    effectiveNet(d) {
      if (d.net) return d.net;
      const k = d.kind || 'via';
      if (k === 'ground') return 'GND';
      if (k === 'vcc') return 'VCC';
      return null;
    }
    // Dots whose net may be written by propagation (not the fixed ground/vcc).
    assignable(d) { const k = d.kind || 'via'; return k === 'via' || k === 'tag' || k === 'pad'; }

    /* Propagate net membership along lines and flag invalid lines.
       - A line connects its two endpoint dots (same side or through).
       - If one endpoint has a net and the other none, the net spreads onto it.
       - If the two endpoints carry different nets, the line is a mismatch:
         it does NOT connect them and is flagged (grayed + tooltip).
       - If an endpoint is nearest to a dot on an incompatible side, the line is
         a cross-side error. Writes dot.net for assignable dots. */
    propagate() {
      const dots = this.electricalDots();
      const lines = this.app.ann.shapes.filter(s => s.type === 'line' && s.pts && s.pts.length >= 2);
      for (const l of lines) delete l._err;

      const parent = {}, netAt = {};
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      for (const d of dots) { parent[d.id] = d.id; netAt[d.id] = this.effectiveNet(d); }
      // Keep all grounds one net and all vccs one net.
      let fg = null, fv = null;
      for (const d of dots) {
        const k = d.kind || 'via';
        if (k === 'ground') { if (fg) { const ra = find(d.id), rb = find(fg); if (ra !== rb) { parent[ra] = rb; netAt[rb] = 'GND'; } } else fg = d.id; }
        if (k === 'vcc') { if (fv) { const ra = find(d.id), rb = find(fv); if (ra !== rb) { parent[ra] = rb; netAt[rb] = 'VCC'; } } else fv = d.id; }
      }

      for (const l of lines) {
        const side = l.side || 'top';
        const same = dots.filter(d => this.sameSide(d, side));
        const a = this.matchDot(l.pts[0], same);
        const b = this.matchDot(l.pts[l.pts.length - 1], same);
        const aAny = this.matchDot(l.pts[0], dots);
        const bAny = this.matchDot(l.pts[l.pts.length - 1], dots);
        if ((aAny && !this.sameSide(aAny, side)) || (bAny && !this.sameSide(bAny, side))) {
          l._err = 'Node you want to connect is on the other side.';
          continue;
        }
        if (!a || !b || a.id === b.id) continue;
        const ra = find(a.id), rb = find(b.id);
        const na = netAt[ra], nb = netAt[rb];
        if (na && nb && na !== nb) { l._err = 'Net mismatch — check the net, or remove a node\'s net assignment.'; continue; }
        parent[ra] = rb; netAt[rb] = na || nb;
      }
      // Materialise: write each assignable dot's net from its component.
      for (const d of dots) {
        if (!this.assignable(d)) continue;
        const n = netAt[find(d.id)];
        if (n) d.net = n;
      }
    }

    /* Compute connectivity. Returns:
       { dotNet: Map(id -> {name,color,short}),
         lineNet: Map(lineId -> {color}),
         nets: [{name,color,count,short}], unassigned } */
    compute() {
      const dots = this.electricalDots();
      const parent = {};
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
      for (const d of dots) parent[d.id] = d.id;

      // Edges from lines. A line only connects nodes on its OWN side (plus
      // through), so a top trace and a bottom trace that merely cross don't merge;
      // only through vias bridge sides.
      const lineNet = new Map();
      const lineEndpoints = new Map();
      for (const s of this.app.ann.shapes) {
        if (s.type !== 'line' || !s.pts || s.pts.length < 2) continue;
        const side = s.side || 'top';
        const cand = dots.filter(d => this.sameSide(d, side));
        const a = this.matchDot(s.pts[0], cand);
        const b = this.matchDot(s.pts[s.pts.length - 1], cand);
        if (a && b && a.id !== b.id) union(a.id, b.id);
        lineEndpoints.set(s.id, a || b || null);
      }
      // All grounds share GND; all vccs share VCC.
      let firstGnd = null, firstVcc = null;
      for (const d of dots) {
        if ((d.kind || 'via') === 'ground') { if (firstGnd) union(d.id, firstGnd); else firstGnd = d.id; }
        if ((d.kind || 'via') === 'vcc') { if (firstVcc) union(d.id, firstVcc); else firstVcc = d.id; }
      }

      // Group dots by root.
      const comps = new Map();
      for (const d of dots) {
        const r = find(d.id);
        if (!comps.has(r)) comps.set(r, []);
        comps.get(r).push(d);
      }

      const dotNet = new Map();
      const netAgg = new Map(); // name -> {color,count,short}
      let unassigned = 0;

      for (const [, members] of comps) {
        const names = new Set();
        for (const d of members) {
          const k = d.kind || 'via';
          if (k === 'ground') names.add('GND');
          else if (k === 'vcc') names.add('VCC');
          if (d.net) names.add(d.net);
        }
        const short = names.size > 1;
        let name = null;
        if (names.size === 1) name = [...names][0];
        else if (short) name = [...names].join(' / ');
        const color = name ? netColorFor(short ? name : name, short) : null;
        for (const d of members) dotNet.set(d.id, { name, color, short });
        if (name) {
          const agg = netAgg.get(name) || { color, count: 0, short };
          agg.count += members.length;
          netAgg.set(name, agg);
        } else {
          unassigned += members.length;
        }
      }

      // Colour connecting lines by the net of the dot they touch.
      for (const [lineId, dot] of lineEndpoints) {
        if (dot && dotNet.has(dot.id)) {
          const n = dotNet.get(dot.id);
          if (n.color) lineNet.set(lineId, { color: n.color, name: n.name });
        }
      }

      // Holes are not line-connected but may carry a net manually — count them.
      for (const s of this.app.ann.shapes) {
        if (s.type !== 'point' || (s.kind || 'via') !== 'hole' || !s.net) continue;
        const color = netColorFor(s.net, false);
        dotNet.set(s.id, { name: s.net, color, short: false });
        const agg = netAgg.get(s.net) || { color, count: 0, short: false };
        agg.count += 1; netAgg.set(s.net, agg);
      }

      // Premade + user-created nets always exist, even with no members yet.
      for (const dn of DEFAULT_NETS) {
        if (!netAgg.has(dn)) netAgg.set(dn, { color: netColorFor(dn, false), count: 0, short: false });
      }
      for (const dn of (this.app.ann.customNets || [])) {
        if (!netAgg.has(dn)) netAgg.set(dn, { color: netColorFor(dn, false), count: 0, short: false });
      }

      const nets = [...netAgg.entries()]
        .map(([name, v]) => ({ name, color: v.color, count: v.count, short: v.short }))
        .sort((a, b) => (a.short === b.short ? a.name.localeCompare(b.name) : (a.short ? -1 : 1)));

      return { dotNet, lineNet, nets, unassigned };
    }

    createNet(name, input) {
      const n = (name || '').trim();
      if (!n) return;
      if (this.app.pushUndo) this.app.pushUndo();
      this.app.ann.customNets.add(n);
      if (input) input.value = '';
      this.renderPanel();
      this.app.hint('Net "' + n + '" created — right-click an item to assign it.');
    }

    // ---------------- drawing (from app.drawOverlay) ----------------
    draw(ctx, cam) {
      const { dotNet, lineNet } = this.compute();
      if (this.highlightNet) this.drawHighlight(ctx, cam, dotNet, lineNet);
      if (!this.colorByNet) return;
      ctx.save();

      // Net-coloured overlay on connecting lines (respects annotation visibility).
      for (const s of this.app.ann.shapes) {
        if (s.type !== 'line' || !lineNet.has(s.id) || !this.app.ann.isVisibleShape(s)) continue;
        const c = s.pts.map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.strokeStyle = lineNet.get(s.id).color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Halo ring around net-capable dots (holes only when they carry a net).
      for (const d of this.netableDots()) {
        if (!this.app.ann.isVisibleShape(d)) continue;
        const net = dotNet.get(d.id);
        const connectable = ELEC.includes(d.kind || 'via');
        if (!net && !connectable) continue; // netless hole: no ring
        const s = cam.worldToScreen([d.x, d.y]);
        const r = this.app.ann.pointScreenRadius(d, cam) + 4;
        ctx.beginPath();
        ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
        if (net && net.short) { ctx.setLineDash([4, 3]); ctx.strokeStyle = net.color; ctx.lineWidth = 3; }
        else if (net && net.color) { ctx.setLineDash([]); ctx.strokeStyle = net.color; ctx.lineWidth = 3; }
        else { ctx.setLineDash([2, 3]); ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1.5; }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // Emphasise every element on the hovered net so it's easy to find.
    drawHighlight(ctx, cam, dotNet, lineNet) {
      ctx.save();
      for (const s of this.app.ann.shapes) {
        if (s.type !== 'line' || !lineNet.has(s.id)) continue;
        if (lineNet.get(s.id).name !== this.highlightNet || !this.app.ann.isVisibleShape(s)) continue;
        const c = s.pts.map(p => cam.worldToScreen(p));
        ctx.beginPath(); ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 7; ctx.globalAlpha = 0.55; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.strokeStyle = lineNet.get(s.id).color; ctx.lineWidth = 3; ctx.stroke();
      }
      for (const d of this.netableDots()) {
        const net = dotNet.get(d.id);
        if (!net || net.name !== this.highlightNet || !this.app.ann.isVisibleShape(d)) continue;
        const s = cam.worldToScreen([d.x, d.y]);
        const r = this.app.ann.pointScreenRadius(d, cam) + 7;
        ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke();
        ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.strokeStyle = net.color; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }

    // ---------------- panel ----------------
    renderPanel() {
      const box = this.panel;
      if (!box) return;
      box.innerHTML = '';

      // Color-by-net toggle
      const togRow = document.createElement('label');
      togRow.className = 'nets-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = this.colorByNet;
      cb.onchange = () => { this.colorByNet = cb.checked; this.renderPanel(); };
      togRow.append(cb, document.createTextNode(' Color by net'));
      box.appendChild(togRow);

      // Create-net form
      const form = document.createElement('div');
      form.className = 'nets-assign';
      const hint = document.createElement('p');
      hint.className = 'panel-hint';
      hint.textContent = 'Create a net, then right-click an item to assign it.';
      const irow = document.createElement('div'); irow.className = 'nets-input-row';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'nets-input'; input.placeholder = 'new net name, e.g. CLK';
      input.onkeydown = (e) => { if (e.key === 'Enter') this.createNet(input.value, input); };
      const btn = document.createElement('button');
      btn.className = 'btn small primary'; btn.textContent = 'Create net';
      btn.onclick = () => this.createNet(input.value, input);
      irow.append(input, btn);
      form.append(hint, irow);
      box.appendChild(form);

      // Net list (hover a row to highlight its members on the canvas)
      const { nets, unassigned } = this.compute();
      const list = document.createElement('div');
      list.className = 'nets-list';
      if (!nets.length) {
        list.innerHTML = '<p class="panel-hint">No nets yet.</p>';
      }
      for (const n of nets) {
        const row = document.createElement('div');
        row.className = 'net-row' + (n.short ? ' short' : '');
        const sw = document.createElement('span'); sw.className = 'net-swatch'; sw.style.background = n.color;
        const nm = document.createElement('span'); nm.className = 'net-name'; nm.textContent = n.name + (n.short ? '  ⚠ short' : '');
        const ct = document.createElement('span'); ct.className = 'net-count'; ct.textContent = n.count;
        row.append(sw, nm, ct);
        row.title = 'Hover to highlight this net on the board';
        row.onmouseenter = () => { this.highlightNet = n.name; this.app.scheduleRender(); };
        row.onmouseleave = () => { if (this.highlightNet === n.name) { this.highlightNet = null; this.app.scheduleRender(); } };
        // Delete a user-created net (only removes the empty entry).
        if (this.app.ann.customNets.has(n.name) && n.count === 0) {
          const del = document.createElement('button');
          del.className = 'icon-btn danger'; del.textContent = '✕'; del.title = 'Remove net';
          del.onclick = (e) => { e.stopPropagation(); this.app.ann.customNets.delete(n.name); this.renderPanel(); };
          row.append(del);
        }
        list.appendChild(row);
      }
      if (unassigned) {
        const u = document.createElement('div');
        u.className = 'net-row muted';
        u.innerHTML = `<span class="net-swatch" style="background:#3a404b"></span><span class="net-name">unassigned</span><span class="net-count">${unassigned}</span>`;
        list.appendChild(u);
      }
      box.appendChild(list);
    }
  }

  global.Nets = Nets;
})(window);
