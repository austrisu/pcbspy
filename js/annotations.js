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

  class Annotations {
    constructor() {
      this.shapes = [];
      this.markers = [];
      this.hiddenKinds = new Set(); // point kinds hidden via the Annotate view
    }

    clear() { this.shapes = []; this.markers = []; }

    // kind: 'via' | 'tag' | 'hole'. size is an ABSOLUTE radius in world (image)
    // units, so a point keeps its size relative to the image and scales on zoom.
    addPoint(wx, wy, kind, size) {
      const s = {
        id: uid('pt'), type: 'point', x: wx, y: wy,
        kind: POINT_KINDS[kind] ? kind : 'via',
        size: size || POINT_R,
      };
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

    addRect(wx, wy, w, h) {
      const s = { id: uid('rc'), type: 'rect', x: wx, y: wy, w, h };
      this.shapes.push(s);
      return s;
    }

    // Freeform quadrilateral defined by 4 world points (TL,TR,BR,BL order as clicked).
    addQuad(pts) {
      const s = { id: uid('qd'), type: 'quad', pts: pts.map(p => [p[0], p[1]]) };
      this.shapes.push(s);
      return s;
    }

    // Open polyline: a single entity made of >=2 world points.
    addPolyline(pts) {
      const s = { id: uid('ln'), type: 'line', pts: pts.map(p => [p[0], p[1]]) };
      this.shapes.push(s);
      return s;
    }

    shapesOfType(type) { return this.shapes.filter(s => s.type === type); }

    addMarker(targetId, wx, wy, shortName, description) {
      const m = {
        id: uid('mk'), type: 'marker', targetId,
        x: wx, y: wy,
        shortName: shortName || 'M',
        description: description || '',
      };
      this.markers.push(m);
      return m;
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
        const box = this._markerBox(this.markers[i], cam);
        if (sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) {
          return { kind: 'marker', id: this.markers[i].id };
        }
      }
      // Points (skip hidden kinds)
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'point') continue;
        if (this.hiddenKinds.has(s.kind || 'via')) continue;
        const [px, py] = cam.worldToScreen([s.x, s.y]);
        const r = this.pointScreenRadius(s, cam);
        if (Math.hypot(sx - px, sy - py) <= r + 4) return { kind: 'shape', id: s.id };
      }
      // Polylines (near any segment)
      if (!this.hiddenKinds.has('line'))
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'line' || !s.pts || s.pts.length < 2) continue;
        const c = s.pts.map(p => cam.worldToScreen(p));
        for (let j = 0; j < c.length - 1; j++) {
          if (distToSeg(sx, sy, c[j], c[j + 1]) <= 6) return { kind: 'shape', id: s.id };
        }
      }
      // Quads
      if (!this.hiddenKinds.has('quad'))
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'quad') continue;
        const c = s.pts.map(p => cam.worldToScreen(p));
        if (pointInPoly(sx, sy, c) || nearPolyEdge(sx, sy, c, 6)) return { kind: 'shape', id: s.id };
      }
      // Rects
      if (!this.hiddenKinds.has('rect'))
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.type !== 'rect') continue;
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
      if (!this.hiddenKinds.has('rect'))
      for (const s of this.shapes) {
        if (s.type !== 'rect') continue;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const c = this.rectCorners(s).map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.closePath();
        ctx.fillStyle = sel ? 'rgba(90,170,255,0.16)' : 'rgba(90,170,255,0.08)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = sel ? '#5aa0ff' : '#4a90d9';
        ctx.stroke();
        if (sel) {
          for (const h of this.rectHandles(s, cam)) drawHandle(ctx, h.x, h.y);
        }
      }

      // Freeform quads
      if (!this.hiddenKinds.has('quad'))
      for (const s of this.shapes) {
        if (s.type !== 'quad') continue;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const c = s.pts.map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.closePath();
        ctx.fillStyle = sel ? 'rgba(176,124,255,0.18)' : 'rgba(176,124,255,0.10)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = QUAD_COLOR;
        ctx.stroke();
        if (sel) for (const p of c) drawHandle(ctx, p[0], p[1]);
      }

      // Polylines (open, single entity)
      if (!this.hiddenKinds.has('line'))
      for (const s of this.shapes) {
        if (s.type !== 'line' || !s.pts || s.pts.length < 2) continue;
        const sel = selected && selected.kind === 'shape' && selected.id === s.id;
        const c = s.pts.map(p => cam.worldToScreen(p));
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.lineWidth = sel ? 3 : 2;
        ctx.strokeStyle = LINE_COLOR;
        ctx.stroke();
        if (sel) for (const p of c) drawHandle(ctx, p[0], p[1]);
      }

      // Points (kind = via/tag/hole; absolute image-unit size; per-kind hide)
      for (const s of this.shapes) {
        if (s.type !== 'point') continue;
        const kind = s.kind || 'via';
        if (this.hiddenKinds.has(kind)) continue;
        const def = POINT_KINDS[kind] || POINT_KINDS.via;
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
        ctx.fillStyle = def.color;
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
        const sel = selected && selected.kind === 'marker' && selected.id === m.id;
        const [ax, ay] = cam.worldToScreen(this.targetAnchor(m));
        const box = this._markerBox(m, cam);
        // connector
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(box.x, box.y + box.h);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = sel ? '#7ee081' : '#59b35c';
        ctx.stroke();
        // anchor tick
        ctx.beginPath();
        ctx.arc(ax, ay, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#59b35c';
        ctx.fill();
        // label box
        roundRect(ctx, box.x, box.y, box.w, box.h, 4);
        ctx.fillStyle = sel ? '#2f6d32' : '#264d28';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = sel ? '#7ee081' : '#59b35c';
        ctx.stroke();
        ctx.fillStyle = '#eaffea';
        ctx.textAlign = 'left';
        ctx.fillText(m.shortName, box.x + 6, box.y + box.h / 2 + 1);
      }
      ctx.restore();
    }

    serialize() {
      return {
        shapes: this.shapes.map(s => ({ ...s })),
        markers: this.markers.map(m => ({ ...m })),
      };
    }

    load(data) {
      this.clear();
      if (!data) return;
      this.shapes = (data.shapes || []).map(s => ({ ...s }));
      this.markers = (data.markers || []).map(m => ({ ...m }));
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
