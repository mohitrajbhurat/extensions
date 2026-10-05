// Canvas charts: calendar heatmap and bar chart, with hover tooltips, HiDPI and light/dark support.
import { h } from './ui.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setupCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  canvas.style.height = cssHeight + 'px';
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, cssHeight);
  return { g, width, height: cssHeight };
}

function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Rounded top only (data end), flat at the baseline. */
function topRoundRect(g, x, y, w, hgt, r) {
  r = Math.max(0, Math.min(r, w / 2, hgt));
  g.beginPath();
  g.moveTo(x, y + hgt);
  g.lineTo(x, y + r);
  g.arcTo(x, y, x + r, y, r);
  g.lineTo(x + w - r, y);
  g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + hgt);
  g.closePath();
}

/**
 * Generic interactive chart wrapper. draw(ctx) must return an array of hit regions {x,y,w,h,label}.
 * Redraws on resize and color-scheme changes. Returns {el, redraw, destroy}.
 */
function chart({ height, draw, ariaLabel }) {
  const canvas = h('canvas', { role: 'img', 'aria-label': ariaLabel });
  const tip = h('div', { class: 'chart-tip', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'chart-wrap' }, canvas, tip);
  let regions = [];
  const redraw = () => {
    if (!canvas.isConnected) return;
    const c = setupCanvas(canvas, typeof height === 'function' ? height(canvas.clientWidth) : height);
    regions = draw(c) || [];
  };
  const hit = (x, y) => regions.find(r => x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 1 && y <= r.y + r.h + 1);
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const r = hit(e.clientX - rect.left, e.clientY - rect.top);
    if (!r) { tip.classList.remove('on'); return; }
    tip.textContent = r.label;
    tip.style.left = `${Math.min(Math.max(r.x + r.w / 2, 60), rect.width - 60)}px`;
    tip.style.top = `${r.y}px`;
    tip.classList.add('on');
  });
  canvas.addEventListener('mouseleave', () => tip.classList.remove('on'));
  const ro = new ResizeObserver(() => redraw());
  ro.observe(wrap);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', redraw);
  requestAnimationFrame(redraw);
  return { el: wrap, redraw, destroy: () => { ro.disconnect(); mq.removeEventListener('change', redraw); } };
}

/**
 * GitHub-style calendar heatmap of reviews per day.
 * counts: Map<'YYYY-MM-DD', number>; endDate: Date (today). Shows `weeks` columns.
 */
export function heatmap(counts, { weeks = 53, endDate = new Date() } = {}) {
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - end.getDay() - (weeks - 1) * 7); // Sunday of first week
  const max = Math.max(1, ...counts.values());
  const level = n => (n <= 0 ? 0 : n >= max * 0.75 ? 4 : n >= max * 0.5 ? 3 : n >= max * 0.25 ? 2 : 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return chart({
    ariaLabel: `Reviews per day over the last ${weeks} weeks: ${total} reviews in total, busiest day ${max}.`,
    height: w => {
      const cell = Math.max(8, Math.min(16, Math.floor((w - 32) / weeks) - 2));
      return 20 + 7 * (cell + 2) + 4;
    },
    draw: ({ g, width }) => {
      const left = 28;
      const cell = Math.max(8, Math.min(16, Math.floor((width - left - 4) / weeks) - 2));
      const step = cell + 2;
      const top = 18;
      const colors = [css('--heat-0'), css('--heat-1'), css('--heat-2'), css('--heat-3'), css('--heat-4')];
      g.font = `11px ${css('--font') || 'system-ui'}`;
      g.fillStyle = css('--muted');
      g.textBaseline = 'middle';
      ['Mon', 'Wed', 'Fri'].forEach((l, i) => g.fillText(l, 0, top + (1 + i * 2) * step + cell / 2));
      const regions = [];
      let lastMonth = -1;
      const d = new Date(start);
      for (let w = 0; w < weeks; w++) {
        for (let dow = 0; dow < 7; dow++) {
          if (d > end) break;
          const x = left + w * step;
          const y = top + dow * step;
          if (dow === 0 && d.getMonth() !== lastMonth && d.getDate() <= 7) {
            lastMonth = d.getMonth();
            g.fillStyle = css('--muted');
            g.textBaseline = 'alphabetic';
            g.fillText(d.toLocaleDateString(undefined, { month: 'short' }), x, 11);
          }
          const n = counts.get(dayKey(d)) || 0;
          g.fillStyle = colors[level(n)];
          roundRect(g, x, y, cell, cell, 2);
          g.fill();
          if (d.getTime() === end.getTime()) { g.strokeStyle = css('--fg'); g.lineWidth = 1.5; g.stroke(); }
          regions.push({ x, y, w: cell, h: cell, label: `${n} review${n === 1 ? '' : 's'} · ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}` });
          d.setDate(d.getDate() + 1);
        }
      }
      return regions;
    },
  });
}

/**
 * Single-series vertical bar chart (e.g. due forecast).
 * values: number[]; labels: string[] (tooltip text per bar); tick(i) => axis label or ''.
 */
export function barChart(values, { labels = [], tick = () => '', color = '--accent', height = 220, ariaLabel = 'Bar chart', highlightFirst = false } = {}) {
  return chart({
    ariaLabel,
    height,
    draw: ({ g, width, height: H }) => {
      const pad = { l: 36, r: 8, t: 12, b: 24 };
      const plotW = width - pad.l - pad.r;
      const plotH = H - pad.t - pad.b;
      const maxV = Math.max(1, ...values);
      const nice = niceMax(maxV);
      const font = css('--font') || 'system-ui';
      g.font = `11px ${font}`;
      // grid + y labels
      const ticks = 4;
      g.strokeStyle = css('--border');
      g.lineWidth = 1;
      g.fillStyle = css('--muted');
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      for (let i = 0; i <= ticks; i++) {
        const v = (nice / ticks) * i;
        const y = Math.round(pad.t + plotH - (v / nice) * plotH) + 0.5;
        g.beginPath(); g.moveTo(pad.l, y); g.lineTo(width - pad.r, y); g.stroke();
        g.fillText(formatTick(v), pad.l - 6, y);
      }
      const n = values.length;
      const slot = plotW / n;
      const gap = Math.max(2, Math.min(6, slot * 0.25));
      const bw = Math.max(2, slot - gap);
      const regions = [];
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      for (let i = 0; i < n; i++) {
        const x = pad.l + i * slot + gap / 2;
        const bh = (values[i] / nice) * plotH;
        const y = pad.t + plotH - bh;
        if (values[i] > 0) {
          g.fillStyle = css(color);
          g.globalAlpha = highlightFirst && i === 0 ? 1 : highlightFirst ? 0.75 : 1;
          topRoundRect(g, x, y, bw, Math.max(bh, 2), 4);
          g.fill();
          g.globalAlpha = 1;
        }
        regions.push({ x: pad.l + i * slot, y: pad.t, w: slot, h: plotH, label: labels[i] || String(values[i]) });
        const t = tick(i);
        if (t) { g.fillStyle = css('--muted'); g.fillText(t, x + bw / 2, H - 6); }
      }
      // baseline
      g.strokeStyle = css('--muted');
      g.beginPath(); g.moveTo(pad.l, pad.t + plotH + 0.5); g.lineTo(width - pad.r, pad.t + plotH + 0.5); g.stroke();
      return regions;
    },
  });
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.max(4, m * p);
  return 10 * p;
}
function formatTick(v) { return v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v)); }
