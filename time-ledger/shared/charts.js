// Tiny canvas charts: stacked bars and donut, with hover tooltips.
// Colors for axes/text come from CSS custom properties so dark mode works.

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.clientWidth || 600;
  canvas.style.height = height + 'px';
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function ensureTip(wrap) {
  let tip = wrap.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip hidden';
    tip.setAttribute('role', 'status');
    wrap.appendChild(tip);
  }
  return tip;
}

/** Round an axis maximum up to a clean value; returns { max, ticks }. */
function niceAxis(v) {
  if (!(v > 0)) return { max: 1, ticks: 4 };
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return { max: nf * exp, ticks: nf === 2 ? 4 : 5 };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Stacked bar chart.
 * opts: { labels: string[], series: [{ label, color, values: number[] }], height,
 *         fmt: (v) => string (value formatter), unit: 'hours' (axis divides by 3.6e6) }
 */
export function stackedBars(canvas, opts) {
  const height = opts.height || 240;
  const wrap = canvas.parentElement;
  const draw = () => {
    const { ctx, width } = setupCanvas(canvas, height);
    const text = cssVar(canvas, '--muted', '#666');
    const grid = cssVar(canvas, '--border', '#ddd');
    const n = opts.labels.length;
    const totals = opts.labels.map((_, i) => opts.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    // Axis in minutes when the busiest bar is under an hour, else in hours.
    const peak = Math.max(...totals, 0);
    const inMinutes = peak < 3600000;
    const unitMs = inMinutes ? 60000 : 3600000;
    const toUnit = (v) => v / unitMs;
    const axis = niceAxis(Math.max(toUnit(peak), inMinutes ? 5 : 1));
    const maxH = axis.max;
    const pad = { l: 40, r: 8, t: 8, b: 24 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = text;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = axis.ticks;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxH / ticks) * i;
      const y = pad.t + plotH - (v / maxH) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(y) + 0.5);
      ctx.lineTo(width - pad.r, Math.round(y) + 0.5);
      ctx.stroke();
      const label = `${+v.toFixed(1)}${inMinutes ? 'm' : 'h'}`;
      ctx.fillText(label, pad.l - 6, y);
    }
    const slot = plotW / Math.max(n, 1);
    const barW = Math.max(2, Math.min(48, slot * 0.66));
    const bars = [];
    const labelEvery = Math.ceil(n / Math.max(1, Math.floor(plotW / 36)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      const x = pad.l + slot * i + (slot - barW) / 2;
      let y = pad.t + plotH;
      const parts = opts.series.filter((s) => s.values[i] > 0);
      parts.forEach((s, k) => {
        const h = (toUnit(s.values[i]) / maxH) * plotH;
        ctx.fillStyle = s.color;
        if (k === parts.length - 1) { roundRect(ctx, x, y - h, barW, h, 4); ctx.fill(); }
        else ctx.fillRect(x, y - h, barW, h);
        y -= h;
      });
      bars.push({ x, w: barW, i, top: y });
      if (i % labelEvery === 0) {
        ctx.fillStyle = text;
        ctx.fillText(opts.labels[i], x + barW / 2, pad.t + plotH + 6);
      }
    }
    canvas._bars = { bars, slot, pad, totals };
  };
  draw();
  const tip = ensureTip(wrap);
  canvas.onmousemove = (e) => {
    const st = canvas._bars;
    if (!st) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const i = Math.floor((mx - st.pad.l) / st.slot);
    if (i < 0 || i >= opts.labels.length || !st.totals[i]) { tip.classList.add('hidden'); return; }
    const fmt = opts.fmt || ((v) => String(v));
    const lines = opts.series.filter((s) => s.values[i] > 0)
      .sort((a, b) => b.values[i] - a.values[i]).slice(0, 6)
      .map((s) => `<div><span class="dot" style="background:${s.color};width:8px;height:8px"></span> ${escape(s.label)}: ${fmt(s.values[i])}</div>`);
    tip.innerHTML = `<strong>${escape(opts.tipLabels ? opts.tipLabels[i] : opts.labels[i])} · ${fmt(st.totals[i])}</strong>${lines.join('')}`;
    const b = st.bars[i];
    tip.style.left = Math.min(rect.width - 60, Math.max(60, b.x + b.w / 2)) + 'px';
    tip.style.top = Math.max(40, b.top) + 'px';
    tip.classList.remove('hidden');
  };
  canvas.onmouseleave = () => tip.classList.add('hidden');
  observe(canvas, draw);
  setAria(canvas, opts.ariaLabel || 'Bar chart');
}

/**
 * Donut chart. opts: { slices: [{ label, color, value }], height, center: string, sub: string, fmt }
 */
export function donut(canvas, opts) {
  const height = opts.height || 220;
  const wrap = canvas.parentElement;
  const total = opts.slices.reduce((a, s) => a + s.value, 0);
  const draw = () => {
    const { ctx, width } = setupCanvas(canvas, height);
    const cx = width / 2, cy = height / 2;
    const r = Math.min(width, height) / 2 - 8;
    const inner = r * 0.62;
    ctx.clearRect(0, 0, width, height);
    const arcs = [];
    if (!total) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);
      ctx.fillStyle = cssVar(canvas, '--surface-2', '#eee');
      ctx.fill();
    } else {
      let a = -Math.PI / 2;
      for (const s of opts.slices) {
        if (!s.value) continue;
        const da = (s.value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, a, a + da);
        ctx.arc(cx, cy, inner, a + da, a, true);
        ctx.closePath();
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = cssVar(canvas, '--surface', '#fff');
        ctx.lineWidth = 2;
        ctx.stroke();
        arcs.push({ s, a0: a, a1: a + da });
        a += da;
      }
    }
    ctx.fillStyle = cssVar(canvas, '--text', '#111');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText(opts.center || '', cx, cy - (opts.sub ? 8 : 0));
    if (opts.sub) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = cssVar(canvas, '--muted', '#666');
      ctx.fillText(opts.sub, cx, cy + 12);
    }
    canvas._donut = { cx, cy, r, inner, arcs };
  };
  draw();
  const tip = ensureTip(wrap);
  canvas.onmousemove = (e) => {
    const st = canvas._donut;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - st.cx, y = e.clientY - rect.top - st.cy;
    const d = Math.hypot(x, y);
    if (d < st.inner || d > st.r) { tip.classList.add('hidden'); return; }
    let ang = Math.atan2(y, x);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    const hit = st.arcs.find((a) => ang >= a.a0 && ang < a.a1);
    if (!hit) { tip.classList.add('hidden'); return; }
    const fmt = opts.fmt || String;
    tip.innerHTML = `<strong>${escape(hit.s.label)}</strong> · ${fmt(hit.s.value)} (${Math.round((hit.s.value / total) * 100)}%)`;
    tip.style.left = e.clientX - rect.left + 'px';
    tip.style.top = e.clientY - rect.top + 'px';
    tip.classList.remove('hidden');
  };
  canvas.onmouseleave = () => tip.classList.add('hidden');
  observe(canvas, draw);
  setAria(canvas, opts.ariaLabel || 'Donut chart');
}

function setAria(canvas, label) {
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const observers = new WeakMap();
function observe(canvas, draw) {
  const prev = observers.get(canvas);
  if (prev) prev.disconnect();
  if (typeof ResizeObserver === 'undefined') return;
  let w = canvas.parentElement.clientWidth;
  const ro = new ResizeObserver(() => {
    const nw = canvas.parentElement.clientWidth;
    if (nw !== w) { w = nw; draw(); }
  });
  ro.observe(canvas.parentElement);
  observers.set(canvas, ro);
}

/** Distinct fallback colors for projects without one. */
export const PALETTE = ['#0f766e', '#2563eb', '#9333ea', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#4f46e5', '#be123c', '#65a30d', '#7c3aed'];
