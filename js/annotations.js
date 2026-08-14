/* annotations.js — vector annotation layer (points, rectangles, markers).
   Geometry is stored in WORLD coordinates. Rendering/hit-testing happen in
   SCREEN space via a `cam` object exposing worldToScreen([x,y]) and
   screenToWorld([x,y]) (both CSS pixels). Labels/handles are fixed pixel sizes
   so they stay legible at any zoom; shape outlines follow the projected geometry.

   Shapes: { id, type:'point'|'rect', x, y, [w, h] }
   Markers:{ id, type:'marker', targetId, x, y, shortName, description } */
(function (global) {
  'use strict';

  const POINT_R = 6;
  const HANDLE_R = 5;

  // Point kinds: shape + color (+ optional outline stroke). Ordered as shown in
  // the Annotate view.
  const POINT_KINDS = {
    via:    { label: 'Via',    shape: 'circle', color: '#3ddc84' }, // green circle
    tag:    { label: 'Tag',    shape: 'rhomb',  color: '#ffd166' }, // yellow rhomb
    hole:   { label: 'Hole',   shape: 'circle', color: '#4a90d9' }, // blue circle
    pad:    { label: 'Pad',    shape: 'square', color: '#aab2bd' }, // silver square (solder pad)
    ground: { label: 'Ground', shape: 'circle', color: '#000000', stroke: '#e6e6e6' }, // black circle
    vcc:    { label: 'Vcc',    shape: 'circle', color: '#ff1e1e' }, // bright red circle
  };
  const POINT_KIND_ORDER = ['via', 'tag', 'hole', 'pad', 'ground', 'vcc'];
  const QUAD_COLOR = '#b07cff';
  const LINE_COLOR = '#ff9f43';

  let _seq = 1;
  function uid(prefix) { return prefix + '_' + (_seq++) + '_' + Date.now().toString(36); }

  // via/hole default to a through-board node; everything else to the top side.
  function defaultSide(kind) { return (kind === 'via' || kind === 'hole') ? 'through' : 'top'; }

  class Annotations {
    constructor() {
      this.shapes = [];
      this.markers = [];
      this.hiddenKinds = new Set(); // per-kind eyes (nested under a side)
      this.hiddenSides = new Set(); // side-group master eyes: top | bottom | through
      this.customNets = new Set();  // user-created net names (may have no members yet)
    }

    clear() { this.shapes = []; this.markers = []; }

    // side: 'top' | 'bottom' | 'through'. size is an ABSOLUTE world radius. color
    // is an optional hex override (falls back to the kind's legend colour).
    addPoint(wx, wy, kind, size, side, color) {
      kind = POINT_KINDS[kind] ? kind : 'via';
      const s = {
        id: uid('pt'), type: 'point', x: wx, y: wy, kind,
        size: size || POINT_R, side: side || defaultSide(kind),
      };
      if (color) s.color = color;
      this.shapes.push(s);
      return s;
    }

    pointsOfKind(kind) { return this.shapes.filter(s => s.type === 'point' && (s.kind || 'via') === kind); }
    isKindHidden(kind) { return this.hiddenKinds.has(kind); }

    // Screen-space radius of a point (world size projected through the camera).
    pointScreenRadius(s, cam) {
      const c0 = cam.worldToScreen([s.x, s.y]);
      const c1 = cam.worldToScreen([s.x + (s.size || POINT_R), s.y]);
      return Math.max(2, Math.hypot(c1[0] - c0[0], c1[1] - c0[1]));
    }

    addRect(wx, wy, w, h, side, color) {
      const s = { id: uid('rc'), type: 'rect', x: wx, y: wy, w, h, side: side || 'top' };
      if (color) s.color = color;
      this.shapes.push(s);
      return s;
    }

    // Freeform quadrilateral defined by 4 world points (TL,TR,BR,BL order as clicked).
    addQuad(pts, side, color) {
      const s = { id: uid('qd'), type: 'quad', pts: pts.map(p => [p[0], p[1]]), side: side || 'top' };
      if (color) s.color = color;
      this.shapes.push(s);
      return s;
    }

    // Open polyline: a single entity made of >=2 world points. size = stroke width.
    addPolyline(pts, side, size, color) {
      const s = { id: uid('ln'), type: 'line', pts: pts.map(p => [p[0], p[1]]), side: side || 'top', size: size || 2 };
      if (color) s.color = color;
      this.shapes.push(s);
      return s;
    }

    shapesOfType(type) { return this.shapes.filter(s => s.type === type); }

    addMarker(targetId, wx, wy, shortName, description, side, color) {
      const m = {
        id: uid('mk'), type: 'marker', targetId,
        x: wx, y: wy,
        shortName: shortName || 'M',
        description: description || '',
        side: side || 'top',
      };
      if (color) m.color = color;
      this.markers.push(m);
      return m;
    }

    // Kind label used for the per-kind eye / annotate-list grouping.
    kindOf(s) { return s.type === 'point' ? (s.kind || 'via') : s.type; }
    // Visible iff its side group is on AND its kind is on. Through marks carry
    // side='through', so hiding 'top'/'bottom' never hides them.
    isVisibleShape(s) {
      if (this.hiddenSides.has(s.side || 'top')) return false;
      if (this.hiddenKinds.has(this.kindOf(s))) return false;
      return true;
    }

    getShape(id) { return this.shapes.find(s => s.id === id) || null; }
    getMarker(id) { return this.markers.find(m => m.id === id) || null; }

    get(kind, id) { return kind === 'marker' ? this.getMarker(id) : this.getShape(id); }

    remove(kind, id) {
      if (kind === 'marker') {
        this.markers = this.markers.filter(m => m.id !== id);
      } else {
        this.shapes = this.shapes.filter(s => s.id !== id);
        // Drop markers that pointed at the removed shape.
        this.markers = this.markers.filter(m => m.targetId !== id);
      }
    }

    // Anchor point (world) that a marker's connector points to.
    targetAnchor(marker) {
      const t = this.getShape(marker.targetId);
      if (!t) return [marker.x, marker.y];
      if (t.type === 'point') return [t.x, t.y];
      return [t.x + t.w / 2, t.y + t.h / 2]; // rect center
    }

    // Corners of a rect (world), order TL, TR, BR, BL.
    rectCorners(r) {
      return [
        [r.x, r.y], [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h], [r.x, r.y + r.h],
      ];
    }

    /* Hit test in screen space. Returns { kind, id } topmost-first, or null.
       Order of priority: markers (labels), then points, then rect edges/inside. */
    hitTest(sx, sy, cam) {
      // Markers (iterate last-added first = on top)
      for (let i = this.markers.length - 1; i >= 0; i--) {
        if (!this.isVisibleShape(this.markers[i])) continue;
        const box = this._markerBox(this.markers[i], cam);
        if (sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) {
          return { kind: 'marker', id: this.markers[i].id };
        }
      }
      // Points
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'point' || !this.isVisibleShape(s)) continue;
        const [px, py] = cam.worldToScreen([s.x, s.y]);
        const r = this.pointScreenRadius(s, cam);
        if (Math.hypot(sx - px, sy - py) <= r + 4) return { kind: 'shape', id: s.id };
      }
      // Polylines (near any segment)
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'line' || !s.pts || s.pts.length < 2 || !this.isVisibleShape(s)) continue;
        const c = s.pts.map(p => cam.worldToScreen(p));
        for (let j = 0; j < c.length - 1; j++) {
          if (distToSeg(sx, sy, c[j], c[j + 1]) <= 6) return { kind: 'shape', id: s.id };
        }
      }
      // Quads
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'quad' || !this.isVisibleShape(s)) continue;
        const c = s.pts.map(p => cam.worldToScreen(p));
        if (pointInPoly(sx, sy, c) || nearPolyEdge(sx, sy, c, 6)) return { kind: 'shape', id: s.id };
      }
      // Rects
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'rect' || !this.isVisibleShape(s)) continue;
        const c = this.rectCorners(s).map(p => cam.worldToScreen(p));
        if (pointInPoly(sx, sy, c) || nearPolyEdge(sx, sy, c, 6)) {
          return { kind: 'shape', id: s.id };
        }
      }
      return null;
    }

    // Screen-space corner handles for a selected rect (for resize). Returns
    // [{corner:0..3, x, y}] with 0=TL,1=TR,2=BR,3=BL.
    rectHandles(rect, cam) {
      return this.rectCorners(rect).map((p, i) => {
        const [x, y] = cam.worldToScreen(p);
        return { corner: i, x, y };
      });
    }

    hitRectHandle(rect, sx, sy, cam) {
      for (const h of this.rectHandles(rect, cam)) {
        if (Math.hypot(sx - h.x, sy - h.y) <= HANDLE_R + 4) return h.corner;
      }
      return -1;
    }

    _markerBox(marker, cam) {
      const [mx, my] = cam.worldToScreen([marker.x, marker.y]);
      const w = Math.max(24, marker.shortName.length * 8 + 12);
      const h = 20;
      return { x: mx, y: my - h, w, h };
    }

    /* Draw everything. selected = { kind, id } | null. */
    draw(ctx, cam, selected) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';

      // Rectangles
      for (const s of this.shapes) {
        if (s.type !== 'rect' || !this.isVisibleShape(s)) continue;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const col = s.color || '#4a90d9';
        const c = this.rectCorners(s).map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.closePath();
        ctx.globalAlpha = sel ? 0.18 : 0.08; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = sel ? 3 : 2;
        ctx.strokeStyle = col;
        ctx.stroke();
        if (sel) for (const h of this.rectHandles(s, cam)) drawHandle(ctx, h.x, h.y);
      }

      // Freeform quads
      for (const s of this.shapes) {
        if (s.type !== 'quad' || !this.isVisibleShape(s)) continue;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const col = s.color || QUAD_COLOR;
        const c = s.pts.map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.closePath();
        ctx.globalAlpha = sel ? 0.18 : 0.10; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = sel ? 3 : 2;
        ctx.strokeStyle = col;
        ctx.stroke();
        if (sel) for (const p of c) drawHandle(ctx, p[0], p[1]);
      }

      // Polylines (open, single entity)
      for (const s of this.shapes) {
        if (s.type !== 'line' || !s.pts || s.pts.length < 2 || !this.isVisibleShape(s)) continue;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const c = s.pts.map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.lineWidth = (s.size || 2) + (sel ? 1 : 0);
        if (s._err) { ctx.setLineDash([6, 4]); ctx.strokeStyle = '#9a9a9a'; }  // invalid: grayed
        else ctx.strokeStyle = s.color || LINE_COLOR;
        ctx.stroke();
        ctx.setLineDash([]);
        if (sel) for (const p of c) drawHandle(ctx, p[0], p[1]);
      }

      // Points (kind shape/colour; absolute image-unit size)
      for (const s of this.shapes) {
        if (s.type !== 'point' || !this.isVisibleShape(s)) continue;
        const def = POINT_KINDS[s.kind || 'via'] || POINT_KINDS.via;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const [px, py] = cam.worldToScreen([s.x, s.y]);
        const r = this.pointScreenRadius(s, cam);
        ctx.beginPath();
        if (def.shape === 'rhomb') {
          ctx.moveTo(px, py - r); ctx.lineTo(px + r, py);
          ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
        } else if (def.shape === 'square') {
          ctx.rect(px - r, py - r, r * 2, r * 2);
        } else {
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fillStyle = s.color || def.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = def.stroke || '#1a1a1a';
        ctx.stroke();
        if (sel) {
          ctx.beginPath();
          ctx.arc(px, py, r + 4, 0, Math.PI * 2);
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Markers (connector + label)
      for (const m of this.markers) {
        if (!this.isVisibleShape(m)) continue;
        const sel = selected && selected.kind === 'marker' && selected.id === m.id;
        const col = m.color || '#59b35c';   // keep the marker's own colour, even when selected
        const [ax, ay] = cam.worldToScreen(this.targetAnchor(m));
        const box = this._markerBox(m, cam);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(box.x, box.y + box.h);
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = col; ctx.stroke();
        ctx.beginPath(); ctx.arc(ax, ay, 3, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
        roundRect(ctx, box.x, box.y, box.w, box.h, 4);
        ctx.fillStyle = '#264d28'; ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = col; ctx.stroke();
        ctx.fillStyle = '#eaffea'; ctx.textAlign = 'left';
        ctx.fillText(m.shortName, box.x + 6, box.y + box.h / 2 + 1);
        // selection cue: a neutral white dashed ring (does not replace the colour)
        if (sel) {
          roundRect(ctx, box.x - 3, box.y - 3, box.w + 6, box.h + 6, 6);
          ctx.setLineDash([4, 3]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }

    serialize() {
      const clean = (o) => { const c = {}; for (const k in o) if (k[0] !== '_') c[k] = o[k]; return c; };
      return {
        shapes: this.shapes.map(clean),   // drop transient _err etc.
        markers: this.markers.map(clean),
        customNets: [...this.customNets],
      };
    }

    load(data) {
      this.clear();
      if (!data) return;
      // Migrate pre-side files: via/hole -> through, else top; line width -> 2.
      this.shapes = (data.shapes || []).map(s => {
        const o = { ...s };
        if (!o.side) o.side = o.type === 'point' ? defaultSide(o.kind || 'via') : 'top';
        if (o.type === 'line' && o.size == null) o.size = 2;
        return o;
      });
      this.markers = (data.markers || []).map(m => {
        const o = { ...m };
        if (!o.side) o.side = 'top';
        return o;
      });
      this.customNets = new Set(data.customNets || []);
    }
  }

  // ---- helpers ----
  function drawHandle(ctx, x, y) {
    ctx.beginPath();
    ctx.rect(x - HANDLE_R, y - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#5aa0ff';
    ctx.stroke();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function pointInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function nearPolyEdge(px, py, pts, tol) {
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (distToSeg(px, py, pts[j], pts[i]) <= tol) return true;
    }
    return false;
  }

  function distToSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }

  Annotations.KINDS = POINT_KINDS;
  Annotations.KIND_ORDER = POINT_KIND_ORDER;
  Annotations.RECT_COLOR = '#4a90d9';
  Annotations.QUAD_COLOR = QUAD_COLOR;
  Annotations.LINE_COLOR = LINE_COLOR;
  global.Annotations = Annotations;
})(window);
