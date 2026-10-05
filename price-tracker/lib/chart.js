// Price Tracker: canvas price-history chart with hover/keyboard tooltip. No dependencies.
const DAY = 86400000;

function css(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function niceStep(range, count) {
  const raw = range / Math.max(count, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
  return step * mag;
}

function niceTicks(min, max, count) {
  if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad; }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks, step };
}

function timeTicks(from, to, width) {
  const span = to - from;
  const maxTicks = Math.max(2, Math.floor(width / 90));
  const steps = [DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 61 * DAY, 91 * DAY, 182 * DAY, 365 * DAY];
  let step = steps.find(s => span / s <= maxTicks) || 365 * DAY;
  const ticks = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (step >= 30 * DAY) {
    d.setDate(1);
    const months = Math.round(step / (30 * DAY));
    while (d.getTime() < from) d.setMonth(d.getMonth() + 1);
    while (d.getTime() <= to) { ticks.push(d.getTime()); d.setMonth(d.getMonth() + months); }
  } else {
    while (d.getTime() < from) d.setTime(d.getTime() + DAY);
    while (d.getTime() <= to) { ticks.push(d.getTime()); d.setTime(d.getTime() + step); }
  }
  return { ticks, step };
}

export class PriceChart {
  /**
   * @param {HTMLElement} container
   * @param {{mini?: boolean, height?: number, format: (n:number)=>string, locale?: string}} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.opts = { mini: false, height: 280, ...opts };
    this.container.classList.add('chart-wrap');
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    this.tip.setAttribute('aria-hidden', 'true');
    this.live = document.createElement('div');
    this.live.className = 'sr-only';
    this.live.setAttribute('aria-live', 'polite');
    container.replaceChildren(this.canvas, this.tip, this.live);
    this.hoverIndex = null;
    this.data = null;
    this._onMove = e => this.hoverAt(e.clientX);
    this._onLeave = () => { if (document.activeElement !== this.canvas) this.setHover(null); };
    this._onKey = e => this.onKey(e);
    this._onBlur = () => this.setHover(null);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerdown', this._onMove);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    this.canvas.addEventListener('keydown', this._onKey);
    this.canvas.addEventListener('blur', this._onBlur);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(container);
    this.mq = matchMedia('(prefers-color-scheme: dark)');
    this._onScheme = () => this.draw();
    this.mq.addEventListener('change', this._onScheme);
  }

  destroy() {
    this.ro.disconnect();
    this.mq.removeEventListener('change', this._onScheme);
    this.container.replaceChildren();
  }

  /**
   * @param {{history: Array<{t:number,p:number|null,a:string}>, target?: number|null, from?: number|null, now?: number, label?: string}} data
   */
  setData(data) {
    const now = data.now || Date.now();
    const all = (data.history || []).filter(h => h && typeof h.t === 'number').sort((a, b) => a.t - b.t);
    let pts = all;
    if (data.from) {
      const before = all.filter(h => h.t < data.from);
      pts = all.filter(h => h.t >= data.from);
      if (before.length) pts.unshift({ ...before[before.length - 1], t: data.from, carried: true });
    }
    this.data = { ...data, pts, now };
    this.hoverIndex = null;
    const priced = pts.filter(p => p.p != null);
    if (priced.length) {
      const min = Math.min(...priced.map(p => p.p)), max = Math.max(...priced.map(p => p.p));
      const f = this.opts.format;
      this.canvas.setAttribute('aria-label', `${data.label || 'Price history'}: ${priced.length} prices from ${new Date(pts[0].t).toLocaleDateString()} to now. Low ${f(min)}, high ${f(max)}, current ${f(priced[priced.length - 1].p)}. Use left and right arrow keys to read individual prices.`);
    } else {
      this.canvas.setAttribute('aria-label', 'No price history yet');
    }
    this.draw();
  }

  layout() {
    const w = this.container.clientWidth || 300;
    const h = this.opts.height;
    const mini = this.opts.mini;
    const pad = mini ? { l: 4, r: 4, t: 8, b: 8 } : { l: 64, r: 16, t: 16, b: 28 };
    return { w, h, pad, pw: Math.max(10, w - pad.l - pad.r), ph: Math.max(10, h - pad.t - pad.b) };
  }

  draw() {
    if (!this.data) return;
    const { w, h, pad, pw, ph } = this.layout();
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    c.style.height = h + 'px';
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const el = this.container;
    const col = {
      line: css(el, '--chart-line', '#2a78d6'), fill: css(el, '--chart-fill', 'rgba(42,120,214,.14)'),
      grid: css(el, '--chart-grid', '#e6e9e7'), axis: css(el, '--chart-axis', '#727b77'),
      target: css(el, '--chart-target', '#c27a00'), oos: css(el, '--chart-oos', 'rgba(194,58,58,.1)'),
      surface: css(el, '--chart-surface', '#fff'), text: css(el, '--text-2', '#4d5652'),
    };
    const { pts, now, target } = this.data;
    const priced = pts.filter(p => p.p != null);
    if (!priced.length) {
      ctx.fillStyle = col.axis;
      ctx.font = '13px ' + css(el, '--font', 'system-ui');
      ctx.textAlign = 'center';
      ctx.fillText('No price history yet', w / 2, h / 2);
      this.geom = null;
      return;
    }
    const t0 = pts[0].t;
    const t1 = Math.max(now, pts[pts.length - 1].t + 1);
    const tSpan = Math.max(t1 - t0, 3600000);
    let vMin = Math.min(...priced.map(p => p.p));
    let vMax = Math.max(...priced.map(p => p.p));
    if (target && target > 0 && target >= vMin * 0.6 && target <= vMax * 1.4) { vMin = Math.min(vMin, target); vMax = Math.max(vMax, target); }
    const yt = niceTicks(vMin, vMax, this.opts.mini ? 2 : Math.max(3, Math.floor(ph / 48)));
    const lo = this.opts.mini ? vMin - (vMax - vMin || vMax * 0.05) * 0.15 : yt.lo;
    const hi = this.opts.mini ? vMax + (vMax - vMin || vMax * 0.05) * 0.15 : yt.hi;
    const x = t => pad.l + ((t - t0) / tSpan) * pw;
    const y = v => pad.t + (1 - (v - lo) / (hi - lo || 1)) * ph;
    this.geom = { x, y, t0, t1, tSpan, pad, pw, ph, w, h };
    const fontFamily = css(el, '--font', 'system-ui');

    // Out-of-stock bands.
    ctx.fillStyle = col.oos;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].a !== 'out_of_stock') continue;
      const xa = x(pts[i].t), xb = x(i + 1 < pts.length ? pts[i + 1].t : t1);
      ctx.fillRect(xa, pad.t, Math.max(1, xb - xa), ph);
    }

    // Grid + axes.
    if (!this.opts.mini) {
      ctx.font = '11px ' + fontFamily;
      ctx.lineWidth = 1;
      ctx.strokeStyle = col.grid;
      ctx.fillStyle = col.axis;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of yt.ticks) {
        const yy = Math.round(y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke();
        ctx.fillText(this.opts.format(v), pad.l - 8, yy);
      }
      const tt = timeTicks(t0, t1, pw);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const fmt = tt.step >= 30 * DAY
        ? { month: 'short', year: (t1 - t0) > 300 * DAY ? '2-digit' : undefined }
        : { month: 'short', day: 'numeric' };
      let lastRight = -Infinity;
      for (const t of tt.ticks) {
        const xx = x(t);
        const label = new Date(t).toLocaleDateString(this.opts.locale, fmt);
        const half = ctx.measureText(label).width / 2;
        if (xx - half < lastRight + 8 || xx - half < 0 || xx + half > w) continue;
        ctx.fillText(label, xx, pad.t + ph + 8);
        lastRight = xx + half;
      }
    }

    // Target line.
    if (target && target > 0 && y(target) >= pad.t - 1 && y(target) <= pad.t + ph + 1) {
      const ty = Math.round(y(target)) + 0.5;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = col.target;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(pad.l, ty); ctx.lineTo(pad.l + pw, ty); ctx.stroke();
      ctx.restore();
      if (!this.opts.mini) {
        ctx.font = '600 11px ' + fontFamily;
        ctx.fillStyle = col.target;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Target ' + this.opts.format(target), pad.l + pw - 4, ty - 3);
      }
    }

    // Step line segments (price holds until the next observation). Gaps where price is unknown.
    const segs = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const tEnd = i + 1 < pts.length ? pts[i + 1].t : t1;
      if (p.p == null) { cur = null; continue; }
      if (!cur) { cur = []; segs.push(cur); }
      cur.push([x(p.t), y(p.p)], [x(tEnd), y(p.p)]);
    }
    const base = pad.t + ph;
    for (const s of segs) {
      const grad = ctx.createLinearGradient(0, pad.t, 0, base);
      grad.addColorStop(0, col.fill);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(s[0][0], base);
      for (const [px, py] of s) ctx.lineTo(px, py);
      ctx.lineTo(s[s.length - 1][0], base);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = col.line;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
    }

    // Direct labels: all-time low in range, and the current price dot.
    const minP = priced.reduce((a, b) => (b.p < a.p ? b : a));
    const lastP = priced[priced.length - 1];
    const dot = (px, py, r) => {
      ctx.beginPath(); ctx.arc(px, py, r + 2, 0, Math.PI * 2); ctx.fillStyle = col.surface; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fillStyle = col.line; ctx.fill();
    };
    if (!this.opts.mini && priced.length > 1 && minP !== lastP) {
      const mx = x(minP.t), my = y(minP.p);
      dot(mx, my, 3.5);
      ctx.font = '600 11px ' + fontFamily;
      ctx.fillStyle = col.text;
      ctx.textBaseline = 'top';
      ctx.textAlign = mx < pad.l + 40 ? 'left' : mx > pad.l + pw - 40 ? 'right' : 'center';
      const ly = my + 8 + 14 > base ? my - 22 : my + 8;
      ctx.fillText('Low ' + this.opts.format(minP.p), mx, ly);
    }
    dot(Math.min(x(t1), pad.l + pw), y(lastP.p), this.opts.mini ? 3 : 4);

    // Hover layer.
    if (this.hoverIndex != null && pts[this.hoverIndex]) {
      const p = pts[this.hoverIndex];
      const hx = this.hoverX != null ? this.hoverX : x(p.t);
      ctx.strokeStyle = col.axis;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, pad.t); ctx.lineTo(Math.round(hx) + 0.5, base); ctx.stroke();
      if (p.p != null) dot(hx, y(p.p), 4.5);
    }
  }

  indexAtTime(t) {
    const pts = this.data.pts;
    let idx = 0;
    for (let i = 0; i < pts.length; i++) { if (pts[i].t <= t) idx = i; else break; }
    return idx;
  }

  hoverAt(clientX) {
    if (!this.geom) return;
    const r = this.canvas.getBoundingClientRect();
    const g = this.geom;
    const px = Math.max(g.pad.l, Math.min(clientX - r.left, g.pad.l + g.pw));
    const t = g.t0 + ((px - g.pad.l) / g.pw) * g.tSpan;
    this.setHover(this.indexAtTime(t), px, t);
  }

  setHover(index, px, t) {
    this.hoverIndex = index;
    this.hoverX = px != null ? px : null;
    this.draw();
    if (index == null || !this.geom) { this.tip.hidden = true; return; }
    const p = this.data.pts[index];
    const g = this.geom;
    const when = t != null ? t : p.t;
    const date = new Date(p.carried ? when : (t != null ? when : p.t));
    const price = p.p != null ? this.opts.format(p.p) : 'No price';
    const avail = p.a === 'out_of_stock' ? 'Out of stock' : p.a === 'in_stock' ? 'In stock' : '';
    this.tip.replaceChildren();
    const b = document.createElement('b');
    b.textContent = price;
    const d = document.createElement('div');
    d.className = 'subtle';
    d.textContent = date.toLocaleDateString(this.opts.locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + (avail ? ' · ' + avail : '');
    this.tip.append(b, d);
    const xx = this.hoverX != null ? this.hoverX : g.x(p.t);
    const yy = p.p != null ? g.y(p.p) : g.pad.t + g.ph / 2;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    const left = Math.max(tw / 2 + 2, Math.min(xx, g.w - tw / 2 - 2));
    this.tip.style.left = left + 'px';
    const top = yy - 12 - this.tip.offsetHeight < 0 ? yy + this.tip.offsetHeight + 24 : yy;
    this.tip.style.top = top + 'px';
    this.live.textContent = `${price}, ${d.textContent}`;
  }

  onKey(e) {
    if (!this.data || !this.data.pts.length) return;
    const n = this.data.pts.length;
    let i = this.hoverIndex;
    if (e.key === 'ArrowRight') i = i == null ? 0 : Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') i = i == null ? n - 1 : Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'Escape') i = null;
    else return;
    e.preventDefault();
    this.setHover(i);
  }
}
