/* Measuring: distances between two boxes, the Measure mode, rulers and guides. */
import { h, clear, elementAt, num } from './util.js';
import { outlineBox } from './inspect.js';

const RULER = 18;

/* ------------------------------------------------------------ distances */
const contains = (o, i) => i.left >= o.left - 0.5 && i.right <= o.right + 0.5 && i.top >= o.top - 0.5 && i.bottom <= o.bottom + 0.5;

/**
 * Distance segments between rect a (anchor) and rect b. Pure function so it can be tested.
 * Returns [{x1, y1, x2, y2, length, axis}].
 */
export function distanceSegments(a, b) {
  const segs = [];
  const add = (x1, y1, x2, y2) => {
    const length = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    if (length >= 0.5) segs.push({ x1, y1, x2, y2, length: Math.round(length * 10) / 10, axis: y1 === y2 ? 'x' : 'y' });
  };
  const inside = contains(a, b) ? [a, b] : contains(b, a) ? [b, a] : null;
  if (inside) {
    const [o, i] = inside;
    const cx = (i.left + i.right) / 2, cy = (i.top + i.bottom) / 2;
    add(cx, o.top, cx, i.top);
    add(cx, i.bottom, cx, o.bottom);
    add(o.left, cy, i.left, cy);
    add(i.right, cy, o.right, cy);
    return segs;
  }
  const vTop = Math.max(a.top, b.top), vBottom = Math.min(a.bottom, b.bottom);
  const hLeft = Math.max(a.left, b.left), hRight = Math.min(a.right, b.right);
  const yMid = vTop < vBottom ? (vTop + vBottom) / 2 : (b.top + b.bottom) / 2;
  const xMid = hLeft < hRight ? (hLeft + hRight) / 2 : (b.left + b.right) / 2;
  let separated = false;
  if (b.left >= a.right) { add(a.right, yMid, b.left, yMid); separated = true; }
  else if (a.left >= b.right) { add(b.right, yMid, a.left, yMid); separated = true; }
  if (b.top >= a.bottom) { add(xMid, a.bottom, xMid, b.top); separated = true; }
  else if (a.top >= b.bottom) { add(xMid, b.bottom, xMid, a.top); separated = true; }
  if (!separated) {
    // Overlapping boxes: offsets between matching edges.
    add(xMid, Math.min(a.top, b.top), xMid, Math.max(a.top, b.top));
    add(xMid, Math.min(a.bottom, b.bottom), xMid, Math.max(a.bottom, b.bottom));
    add(Math.min(a.left, b.left), yMid, Math.max(a.left, b.left), yMid);
    add(Math.min(a.right, b.right), yMid, Math.max(a.right, b.right), yMid);
  }
  return segs;
}

export function drawDistances(layer, a, b) {
  const segs = distanceSegments(a, b);
  for (const s of segs) {
    const line = h('div.mline');
    if (s.axis === 'x') {
      Object.assign(line.style, { left: Math.min(s.x1, s.x2) + 'px', top: s.y1 + 'px', width: Math.abs(s.x2 - s.x1) + 'px', height: '1px' });
    } else {
      Object.assign(line.style, { left: s.x1 + 'px', top: Math.min(s.y1, s.y2) + 'px', width: '1px', height: Math.abs(s.y2 - s.y1) + 'px' });
    }
    const label = h('div.mlabel', String(num(s.length)));
    label.style.left = (s.x1 + s.x2) / 2 + 'px';
    label.style.top = (s.y1 + s.y2) / 2 + 'px';
    layer.append(line, label);
  }
  return segs;
}

function sizeLabel(layer, el) {
  const r = el.getBoundingClientRect();
  const s = h('div.boxlabel', `${num(r.width)} × ${num(r.height)}`);
  s.style.left = r.left + r.width / 2 + 'px';
  s.style.top = (r.top > 14 ? r.top - 9 : r.bottom + 9) + 'px';
  layer.append(s);
}

/* --------------------------------------------------------- measure mode */
export function createMeasure(app) {
  let anchor = null;
  let hover = null;
  const layer = () => app.layer('measure');
  return {
    name: 'measure',
    enter() {
      anchor = null;
      hover = null;
      app.toast('Click an element, then hover another to measure');
    },
    exit() {
      anchor = null;
      hover = null;
      clear(layer());
    },
    onMove(e) {
      hover = elementAt(e.clientX, e.clientY);
      app.requestRedraw();
    },
    onLeave() {
      hover = null;
      app.requestRedraw();
    },
    onClick(e) {
      const el = elementAt(e.clientX, e.clientY);
      anchor = el && el !== anchor ? el : null;
      app.requestRedraw();
    },
    onEscape() {
      if (anchor) {
        anchor = null;
        app.requestRedraw();
        return true;
      }
      return false;
    },
    redraw(active) {
      const l = clear(layer());
      if (!active) return;
      if (anchor && !anchor.isConnected) anchor = null;
      const from = anchor || (app.alt && hover ? hover.parentElement : null);
      if (from && from !== document.documentElement) {
        outlineBox(l, from, 'box-sec');
        sizeLabel(l, from);
      }
      if (hover && hover.isConnected) {
        outlineBox(l, hover);
        if (hover !== from) sizeLabel(l, hover);
        if (from && hover !== from) drawDistances(l, from.getBoundingClientRect(), hover.getBoundingClientRect());
      }
    },
  };
}

/* ------------------------------------------------------ rulers & guides */
export function createRulers(app) {
  const guides = []; // {axis: 'h' | 'v', pos: document coordinate}
  let wrap = null, hCanvas = null, vCanvas = null;
  const api = {
    on: false,
    guides,
    setOn(on) {
      api.on = on;
      if (on && !wrap) build();
      if (wrap) wrap.hidden = !on;
      app.syncButtons();
      api.redraw();
    },
    onMove() {
      if (api.on) app.requestRedraw();
    },
    redraw() {
      if (!wrap || !api.on) return;
      drawRuler(hCanvas, 'h');
      drawRuler(vCanvas, 'v');
      renderGuides();
    },
    clearGuides() {
      guides.length = 0;
      renderGuides();
    },
  };

  function build() {
    hCanvas = h('canvas');
    vCanvas = h('canvas');
    const hr = h('div.ruler.ruler-h', { title: 'Drag down to add a horizontal guide' }, hCanvas);
    const vr = h('div.ruler.ruler-v', { title: 'Drag right to add a vertical guide' }, vCanvas);
    const corner = h('button.icon', {
      type: 'button', title: 'Clear all guides', 'aria-label': 'Clear all guides',
      style: { position: 'fixed', left: '0', top: '0', width: RULER + 'px', height: RULER + 'px', padding: '0', borderRadius: '0', fontSize: '9px', justifyContent: 'center', zIndex: '1' },
      onclick: () => api.clearGuides(),
    }, '✕');
    hr.addEventListener('pointerdown', e => startNew(e, 'h'));
    vr.addEventListener('pointerdown', e => startNew(e, 'v'));
    wrap = h('div.rulers', h('div.guides'), hr, vr, corner);
    app.guidesLayer.append(wrap);
  }

  function startNew(e, axis) {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = { axis, pos: axis === 'h' ? e.clientY + scrollY : e.clientX + scrollX };
    guides.push(g);
    renderGuides();
    drag(e, g, e.currentTarget);
  }

  function drag(e, g, captureEl) {
    captureEl.setPointerCapture(e.pointerId);
    const move = ev => {
      g.pos = g.axis === 'h' ? ev.clientY + scrollY : ev.clientX + scrollX;
      renderGuides();
    };
    const up = ev => {
      captureEl.removeEventListener('pointermove', move);
      captureEl.removeEventListener('pointerup', up);
      captureEl.removeEventListener('pointercancel', up);
      const client = g.axis === 'h' ? ev.clientY : ev.clientX;
      if (client < RULER) guides.splice(guides.indexOf(g), 1);
      renderGuides();
    };
    captureEl.addEventListener('pointermove', move);
    captureEl.addEventListener('pointerup', up);
    captureEl.addEventListener('pointercancel', up);
  }

  function guideEl(g) {
    const el = h('div.guide.guide-' + g.axis, {
      title: 'Drag to move, drag onto the ruler or double-click to remove',
      tabindex: '0', role: 'separator',
    });
    const remove = () => {
      const i = guides.indexOf(g);
      if (i >= 0) guides.splice(i, 1);
      renderGuides();
    };
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag(e, g, el);
    });
    el.addEventListener('dblclick', remove);
    el.addEventListener('keydown', e => {
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowUp: -step, ArrowLeft: -step, ArrowDown: step, ArrowRight: step }[e.key];
      if (delta) g.pos += delta;
      else if (e.key === 'Delete' || e.key === 'Backspace') remove();
      else return;
      e.preventDefault();
      e.stopPropagation();
      renderGuides();
    });
    return el;
  }

  /** Update guide elements in place so a drag in progress keeps its pointer capture. */
  function renderGuides() {
    if (!wrap) return;
    const box = wrap.querySelector('.guides');
    for (const el of [...box.children]) if (!guides.some(g => g.el === el)) el.remove();
    for (const g of guides) {
      if (!g.el) g.el = guideEl(g);
      if (!g.el.isConnected) box.append(g.el);
      const client = g.axis === 'h' ? g.pos - scrollY : g.pos - scrollX;
      const pos = String(Math.round(g.pos));
      g.el.setAttribute('data-pos', pos);
      g.el.setAttribute('aria-label', `${g.axis === 'h' ? 'Horizontal' : 'Vertical'} guide at ${pos}px`);
      if (g.axis === 'h') g.el.style.top = client + 'px';
      else g.el.style.left = client + 'px';
    }
  }

  function drawRuler(canvas, axis) {
    const dpr = devicePixelRatio || 1;
    const len = axis === 'h' ? innerWidth : innerHeight;
    const w = axis === 'h' ? len : RULER, hgt = axis === 'h' ? RULER : len;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = '#5b5b6b';
    ctx.strokeStyle = '#8a8a99';
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.lineWidth = 1;
    const offset = axis === 'h' ? scrollX : scrollY;
    const start = Math.floor(offset / 10) * 10;
    ctx.beginPath();
    for (let v = start; v <= offset + len; v += 10) {
      const p = Math.round(v - offset) + 0.5;
      const tick = v % 100 === 0 ? RULER : v % 50 === 0 ? 9 : 5;
      if (axis === 'h') { ctx.moveTo(p, RULER); ctx.lineTo(p, RULER - tick); }
      else { ctx.moveTo(RULER, p); ctx.lineTo(RULER - tick, p); }
      if (v % 100 === 0) {
        if (axis === 'h') ctx.fillText(String(v), p + 2, 9);
        else {
          ctx.save();
          ctx.translate(9, p + 2);
          ctx.rotate(Math.PI / 2);
          ctx.fillText(String(v), 0, 0);
          ctx.restore();
        }
      }
    }
    ctx.stroke();
    // Pointer marker
    const m = axis === 'h' ? app.mouse.x : app.mouse.y;
    if (m >= 0) {
      ctx.fillStyle = '#e11d8f';
      if (axis === 'h') ctx.fillRect(m, 0, 1, RULER);
      else ctx.fillRect(0, m, RULER, 1);
    }
  }

  return api;
}
