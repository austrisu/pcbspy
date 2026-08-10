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

  const ELEC = ['via', 'tag', 'hole', 'pad', 'ground', 'vcc']; // electrical dot kinds
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

  class Nets {
    constructor(app) {
      this.app = app;
      this.colorByNet = false;
      this.selectedDot = null; // dot id
      this.panel = document.getElementById('netsView');
    }

    isElectrical(s) { return s.type === 'point' && ELEC.includes(s.kind || 'via'); }
    electricalDots() { return this.app.ann.shapes.filter(s => this.isElectrical(s)); }
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

    // Nearest electrical dot to a SCREEN point (for selecting / snapping).
    hitDotScreen(sp, pad) {
      const cam = this.app.cam;
      let best = null, bestD = Infinity;
      for (const d of this.electricalDots()) {
        const s = cam.worldToScreen([d.x, d.y]);
        const r = this.app.ann.pointScreenRadius(d, cam) + (pad || 6);
        const dist = Math.hypot(sp[0] - s[0], sp[1] - s[1]);
        if (dist <= r && dist < bestD) { best = d; bestD = dist; }
      }
      return best;
    }

    // If a screen point is over an electrical dot, return its world centre (for
    // snapping line endpoints onto dots), else null.
    snapToDot(sp) {
      const d = this.hitDotScreen(sp, 8);
      return d ? [d.x, d.y] : null;
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

      // Edges from lines (endpoint dots).
      const lineNet = new Map();
      const lineEndpoints = new Map();
      for (const s of this.app.ann.shapes) {
        if (s.type !== 'line' || !s.pts || s.pts.length < 2) continue;
        const a = this.matchDot(s.pts[0], dots);
        const b = this.matchDot(s.pts[s.pts.length - 1], dots);
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
          if (n.color) lineNet.set(lineId, { color: n.color });
        }
      }

      // Premade nets always exist, even with no members yet.
      for (const dn of DEFAULT_NETS) {
        if (!netAgg.has(dn)) netAgg.set(dn, { color: netColorFor(dn, false), count: 0, short: false });
      }

      const nets = [...netAgg.entries()]
        .map(([name, v]) => ({ name, color: v.color, count: v.count, short: v.short }))
        .sort((a, b) => (a.short === b.short ? a.name.localeCompare(b.name) : (a.short ? -1 : 1)));

      return { dotNet, lineNet, nets, unassigned };
    }

    // ---------------- interaction ----------------
    onCanvasDown(sp) {
      const d = this.hitDotScreen(sp, 6);
      this.selectedDot = d ? d.id : null;
      if (!this.colorByNet) this.colorByNet = true;
      this.renderPanel();
    }

    assignSelected(name) {
      const d = this.getDot(this.selectedDot);
      if (!d) return;
      const k = d.kind || 'via';
      if (k === 'ground' || k === 'vcc') { this.app.hint(k === 'ground' ? 'Ground dots are always on GND.' : 'Vcc dots are always on VCC.'); return; }
      if (this.app.pushUndo) this.app.pushUndo();
      const n = (name || '').trim();
      if (n) d.net = n; else delete d.net;
      this.renderPanel();
    }

    // ---------------- drawing (from app.drawOverlay) ----------------
    draw(ctx, cam) {
      if (!this.colorByNet) return;
      const { dotNet, lineNet } = this.compute();
      ctx.save();

      // Net-coloured overlay on connecting lines.
      for (const s of this.app.ann.shapes) {
        if (s.type !== 'line' || !lineNet.has(s.id)) continue;
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

      // Halo ring around each electrical dot in its net colour (gray if netless).
      for (const d of this.electricalDots()) {
        const s = cam.worldToScreen([d.x, d.y]);
        const r = this.app.ann.pointScreenRadius(d, cam) + 4;
        const net = dotNet.get(d.id);
        ctx.beginPath();
        ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
        if (net && net.short) { ctx.setLineDash([4, 3]); ctx.strokeStyle = net.color; ctx.lineWidth = 3; }
        else if (net && net.color) { ctx.setLineDash([]); ctx.strokeStyle = net.color; ctx.lineWidth = 3; }
        else { ctx.setLineDash([2, 3]); ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1.5; }
        ctx.stroke();
        ctx.setLineDash([]);
        if (d.id === this.selectedDot) {
          ctx.beginPath(); ctx.arc(s[0], s[1], r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        }
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

      // Selected-dot assignment
      const sel = this.getDot(this.selectedDot);
      const assign = document.createElement('div');
      assign.className = 'nets-assign';
      if (!sel) {
        assign.innerHTML = '<p class="panel-hint">Pick the Nets tool and click a dot to assign it a net.</p>';
      } else {
        const k = sel.kind || 'via';
        if (k === 'ground' || k === 'vcc') {
          assign.innerHTML = `<p class="panel-hint">Selected ${k === 'ground' ? 'Ground' : 'Vcc'} dot — fixed to <b>${k === 'ground' ? 'GND' : 'VCC'}</b>.</p>`;
        } else {
          const cur = sel.net || '';
          const wrap = document.createElement('div');
          wrap.innerHTML = `<p class="panel-hint">Selected ${k} dot — net:</p>`;
          const input = document.createElement('input');
          input.type = 'text'; input.className = 'nets-input'; input.value = cur; input.placeholder = 'e.g. CLK, DATA0';
          input.onkeydown = (e) => { if (e.key === 'Enter') { this.assignSelected(input.value); } };
          const btn = document.createElement('button');
          btn.className = 'btn small primary'; btn.textContent = 'Assign';
          btn.onclick = () => this.assignSelected(input.value);
          const clr = document.createElement('button');
          clr.className = 'btn small'; clr.textContent = 'Clear';
          clr.onclick = () => this.assignSelected('');
          const row = document.createElement('div'); row.className = 'nets-input-row';
          row.append(input, btn, clr);
          wrap.appendChild(row);
          assign.appendChild(wrap);
        }
      }
      box.appendChild(assign);

      // Net list
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
        // Click a net to assign the selected dot to it (incl. the premade GND/VCC).
        const selK = sel && (sel.kind || 'via');
        if (sel && selK !== 'ground' && selK !== 'vcc' && !n.short) {
          row.classList.add('clickable');
          row.title = 'Assign selected dot to ' + n.name;
          row.onclick = () => this.assignSelected(n.name);
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
