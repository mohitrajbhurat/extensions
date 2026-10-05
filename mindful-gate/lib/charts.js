// Minimal canvas bar charts with hover tooltips, HiDPI and light/dark support.
// barChart(container, { labels, series: [{ name, color, values }], stacked, format, xLabelEvery })

function css(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function roundTopRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

export function barChart(container, opts) {
  container.textContent = '';
  container.classList.add('chart');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', opts.ariaLabel || 'Bar chart');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(canvas, tip);
  const fmt = opts.format || (v => String(v));
  const tipFmt = opts.tipFormat || fmt;
  const height = opts.height || 220;
  let geom = null;
  let hover = -1;

  function draw() {
    const width = container.clientWidth;
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const n = opts.labels.length;
    const totals = opts.labels.map((_, i) => opts.stacked
      ? opts.series.reduce((a, s) => a + (s.values[i] || 0), 0)
      : Math.max(0, ...opts.series.map(s => s.values[i] || 0)));
    const raw = Math.max(...totals, opts.minMax || 0, (opts.goal || 0) * 1.15);
    let max;
    if (opts.integer) max = Math.max(4, Math.ceil(raw / 4) * 4);
    else if (opts.steps) max = 4 * (opts.steps.find(st => st * 4 >= raw) || Math.ceil(raw / 4 / 60) * 60);
    else max = niceMax(raw);
    ctx.font = '12px ' + css('--font');
    const yLabels = [0, max / 4, max / 2, (3 * max) / 4, max];
    const padL = Math.max(...yLabels.map(v => ctx.measureText(fmt(v)).width)) + 12;
    const padR = 8, padT = 12, padB = 26;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const slot = plotW / Math.max(1, n);
    const groupW = Math.min(slot * 0.7, opts.stacked ? 36 : 22 * opts.series.length + 6);
    const muted = css('--muted'), grid = css('--border'), surface = css('--surface');

    // grid + y labels
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yLabels.forEach(v => {
      const y = padT + plotH - (v / max) * plotH;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.globalAlpha = v === 0 ? 1 : 0.6;
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(width - padR, Math.round(y) + 0.5); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = muted;
      ctx.fillText(fmt(v), padL - 8, y);
    });

    if (hover >= 0) {
      ctx.fillStyle = css('--surface-2');
      ctx.fillRect(padL + hover * slot, padT, slot, plotH);
    }

    // bars
    const every = opts.xLabelEvery || Math.ceil(n / Math.max(1, Math.floor(plotW / 56)));
    for (let i = 0; i < n; i++) {
      const cx = padL + slot * i + slot / 2;
      if (opts.stacked) {
        let base = padT + plotH;
        const x = cx - groupW / 2;
        const segs = opts.series.map(s => s.values[i] || 0);
        const lastIdx = segs.reduce((acc, v, k) => (v > 0 ? k : acc), -1);
        opts.series.forEach((s, k) => {
          const v = segs[k];
          if (!v) return;
          const h = (v / max) * plotH;
          ctx.fillStyle = s.color;
          if (k === lastIdx) roundTopRect(ctx, x, base - h, groupW, h, 4);
          else ctx.fillRect(x, base - h, groupW, h);
          // 2px surface gap between stacked segments
          ctx.fillStyle = surface;
          if (k !== lastIdx) ctx.fillRect(x, base - h - 1, groupW, 2);
          base -= h;
        });
      } else {
        const m = opts.series.length;
        const bw = (groupW - 2 * (m - 1)) / m;
        opts.series.forEach((s, k) => {
          const v = s.values[i] || 0;
          if (!v) return;
          const h = Math.max(1, (v / max) * plotH);
          ctx.fillStyle = s.color;
          roundTopRect(ctx, cx - groupW / 2 + k * (bw + 2), padT + plotH - h, bw, h, 4);
        });
      }
      if (i % every === 0 || i === n - 1) {
        ctx.fillStyle = muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(opts.labels[i], cx, padT + plotH + 8);
      }
    }
    if (opts.goal && opts.goal > 0 && opts.goal <= max) {
      const y = padT + plotH - (opts.goal / max) * plotH;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = css('--text-2');
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css('--text-2');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(opts.goalLabel || 'Goal', width - padR, y - 2);
    }
    geom = { padL, slot, n, plotH, padT };
  }

  function showTip(i, evt) {
    if (i < 0) { tip.hidden = true; return; }
    const rows = opts.series
      .map(s => ({ s, v: s.values[i] || 0 }))
      .filter(r => r.v > 0 || opts.series.length <= 3);
    const total = rows.reduce((a, r) => a + r.v, 0);
    tip.textContent = '';
    const head = document.createElement('strong');
    head.textContent = (opts.tipTitles && opts.tipTitles[i]) || opts.labels[i];
    tip.append(head);
    const list = opts.stacked ? rows.slice().reverse() : rows;
    for (const { s, v } of list) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = s.color;
      const name = document.createElement('span');
      name.textContent = s.name;
      const val = document.createElement('b');
      val.textContent = tipFmt(v);
      row.append(sw, name, val);
      tip.append(row);
    }
    if (opts.stacked && rows.length > 1) {
      const row = document.createElement('div');
      row.className = 'tip-row total';
      row.append(document.createElement('span'), Object.assign(document.createElement('span'), { textContent: 'Total' }), Object.assign(document.createElement('b'), { textContent: tipFmt(total) }));
      tip.append(row);
    }
    if (!rows.length) tip.append(Object.assign(document.createElement('div'), { className: 'tip-row', textContent: 'Nothing recorded' }));
    tip.hidden = false;
    const rect = container.getBoundingClientRect();
    const x = geom.padL + geom.slot * i + geom.slot / 2;
    const tw = tip.offsetWidth;
    let left = x + 12;
    if (left + tw > rect.width) left = x - tw - 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = (evt && evt.offsetY != null ? Math.min(evt.offsetY, height - tip.offsetHeight) : 8) + 'px';
  }

  canvas.addEventListener('mousemove', e => {
    if (!geom) return;
    const i = Math.floor((e.offsetX - geom.padL) / geom.slot);
    const idx = i >= 0 && i < geom.n ? i : -1;
    if (idx !== hover) { hover = idx; draw(); }
    showTip(idx, e);
  });
  canvas.addEventListener('mouseleave', () => { hover = -1; draw(); showTip(-1); });

  // Keyboard: focus the chart and move with arrow keys.
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', e => {
    if (!geom) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      hover = hover < 0 ? geom.n - 1 : Math.max(0, Math.min(geom.n - 1, hover + (e.key === 'ArrowRight' ? 1 : -1)));
      draw();
      showTip(hover);
    }
  });
  canvas.addEventListener('blur', () => { hover = -1; draw(); showTip(-1); });

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', draw);
  draw();
  return { redraw: draw, destroy: () => { ro.disconnect(); mq.removeEventListener('change', draw); } };
}

export function legend(container, series) {
  container.textContent = '';
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = s.color;
    item.append(sw, document.createTextNode(s.name));
    container.append(item);
  }
}
