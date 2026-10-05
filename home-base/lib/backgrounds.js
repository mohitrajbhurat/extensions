// Procedural, calm backgrounds drawn on a canvas. The same seed always gives the same picture,
// so every new tab on a given day shows the same scene (until the user shuffles).

export const STYLES = [
  { id: 'dunes', name: 'Dunes' },
  { id: 'peaks', name: 'Peaks' },
  { id: 'waves', name: 'Sea' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'mesh', name: 'Haze' },
];

export const PALETTES = [
  { name: 'Dawn', sky: ['#2b3a67', '#b56576', '#f4b393'], layers: ['#8f6f8f', '#6d5a7f', '#4b4466', '#2e2c46'], sun: '#ffd8a8' },
  { name: 'Sea mist', sky: ['#9fc3d0', '#c6dde3', '#eef4f1'], layers: ['#8fb3bf', '#6a95a6', '#4a768a', '#2f5468'], sun: '#ffffff' },
  { name: 'Forest', sky: ['#a9c1a6', '#d2dfc9', '#f2efe3'], layers: ['#93ab8c', '#6f8f6a', '#4d6e4f', '#2f4a36'], sun: '#fff6dc' },
  { name: 'Dusk', sky: ['#1d1b3a', '#5b3f74', '#e08e79'], layers: ['#7b4f73', '#58406a', '#3a2f55', '#221d3a'], sun: '#ffb38a' },
  { name: 'Desert', sky: ['#e9b98f', '#f3d3b1', '#f9efe1'], layers: ['#d9a273', '#c4825a', '#a26245', '#7a4632'], sun: '#fff1d6' },
  { name: 'Lavender', sky: ['#b9abd9', '#d9d0ee', '#f4eef7'], layers: ['#b3a5d6', '#9586c0', '#7466a3', '#524a80'], sun: '#ffffff' },
  { name: 'Midnight', sky: ['#0b1026', '#1a2348', '#34427a'], layers: ['#2a3563', '#1f2850', '#161d3c', '#0e1328'], sun: '#e8ecff' },
  { name: 'Glacier', sky: ['#8fbad3', '#bcdcec', '#f3f8fb'], layers: ['#a3c4d8', '#7fa6c0', '#5b87a6', '#3a6584'], sun: '#ffffff' },
  { name: 'Ember', sky: ['#2a1a2e', '#7a3b4a', '#e7905f'], layers: ['#a1504f', '#7a3b47', '#55293d', '#331a2b'], sun: '#ffd29a' },
  { name: 'Sage', sky: ['#c3cdb2', '#dfe4d3', '#f7f6ef'], layers: ['#b7c2a5', '#98a888', '#79896c', '#5a6a52'], sun: '#fffbe8' },
  { name: 'Lagoon', sky: ['#14324a', '#2f6f86', '#9fd6cf'], layers: ['#3f8a8f', '#2e6c78', '#1f4f5f', '#123545'], sun: '#e6fff8' },
  { name: 'Peach', sky: ['#f0a487', '#f6c9a9', '#fde9d7'], layers: ['#e59a83', '#cc7c6f', '#a8615d', '#7d4749'], sun: '#fff4e6' },
];

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const x = hex(a), y = hex(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
function rgba(c, alpha) {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Pick style + palette for a seed. styleId 'auto' rotates through the styles. */
export function pickScene(seed, styleId = 'auto') {
  const r = rng(seed);
  const style = styleId !== 'auto' && STYLES.some((s) => s.id === styleId)
    ? styleId : STYLES[Math.floor(r() * STYLES.length)].id;
  const palette = PALETTES[Math.floor(r() * PALETTES.length)];
  return { style, palette, seed: Math.floor(r() * 2 ** 31) };
}

/** Is the scene mostly dark? (decides nothing visual by itself; exposed for callers) */
export function isDark(palette) {
  const [r, g, b] = hex(palette.sky[1]);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

/**
 * Draw a scene into `canvas` at its current pixel size.
 * @returns {{name:string}}
 */
export function drawScene(canvas, scene) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const r = rng(scene.seed);
  const p = scene.palette;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  const fn = { dunes, peaks, waves, aurora, mesh }[scene.style] || dunes;
  fn(ctx, W, H, p, r);
  grain(ctx, W, H, r);
  ctx.restore();
  const styleName = STYLES.find((s) => s.id === scene.style)?.name || '';
  return { name: `${p.name} ${styleName.toLowerCase()}` };
}

function sky(ctx, W, H, p, horizon = 1) {
  const g = ctx.createLinearGradient(0, 0, 0, H * horizon);
  g.addColorStop(0, p.sky[0]);
  g.addColorStop(0.55, p.sky[1]);
  g.addColorStop(1, p.sky[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function sun(ctx, x, y, rad, color, glow = 6) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, rad * glow);
  g.addColorStop(0, rgba(color, 0.55));
  g.addColorStop(0.25, rgba(color, 0.18));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = rgba(color, 0.92);
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();
}

function waveFn(r, count = 3) {
  const parts = [];
  for (let i = 0; i < count; i++) parts.push({ f: (0.5 + r() * 2.5) * (i + 1), ph: r() * Math.PI * 2, a: 1 / (i + 1.3) });
  return (x) => parts.reduce((s, q) => s + Math.sin(x * q.f * Math.PI * 2 + q.ph) * q.a, 0);
}

function fillLayer(ctx, W, H, yAt, top, bottom) {
  ctx.beginPath();
  ctx.moveTo(0, H);
  const step = Math.max(4, W / 240);
  for (let x = 0; x <= W + step; x += step) ctx.lineTo(x, yAt(x / W));
  ctx.lineTo(W, H);
  ctx.closePath();
  const minY = H * 0.3;
  const g = ctx.createLinearGradient(0, minY, 0, H);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
}

function dunes(ctx, W, H, p, r) {
  sky(ctx, W, H, p, 0.75);
  sun(ctx, W * (0.2 + r() * 0.6), H * (0.22 + r() * 0.2), Math.min(W, H) * (0.04 + r() * 0.03), p.sun);
  const n = p.layers.length;
  for (let i = 0; i < n; i++) {
    const wf = waveFn(r, 3);
    const base = H * (0.52 + i * 0.12);
    const amp = H * (0.03 + r() * 0.04) * (1 - i * 0.12);
    const c = p.layers[i];
    fillLayer(ctx, W, H, (t) => base + wf(t) * amp, mix(c, p.sky[2], 0.12 * (n - i)), mix(c, '#000000', 0.08 * i));
  }
}

function ridge(r, rough = 0.55, n = 9) {
  const size = 2 ** n + 1;
  const pts = new Float32Array(size);
  pts[0] = r();
  pts[size - 1] = r();
  let step = size - 1;
  let amp = 1;
  while (step > 1) {
    const half = step / 2;
    for (let i = half; i < size; i += step) pts[i] = (pts[i - half] + pts[i + half]) / 2 + (r() - 0.5) * amp;
    amp *= rough;
    step = half;
  }
  return (t) => pts[Math.min(size - 1, Math.max(0, Math.round(t * (size - 1))))];
}

function peaks(ctx, W, H, p, r) {
  sky(ctx, W, H, p, 0.7);
  sun(ctx, W * (0.15 + r() * 0.7), H * (0.18 + r() * 0.18), Math.min(W, H) * 0.035, p.sun, 8);
  const n = p.layers.length;
  for (let i = 0; i < n; i++) {
    const rf = ridge(r, 0.5 + i * 0.03);
    const base = H * (0.42 + i * 0.13);
    const amp = H * (0.28 - i * 0.04);
    const c = p.layers[i];
    fillLayer(ctx, W, H, (t) => base - (rf(t) - 0.2) * amp, mix(c, p.sky[2], 0.18 * (n - i)), mix(c, '#000000', 0.1 * i));
    // mist between layers
    const mist = ctx.createLinearGradient(0, base - amp * 0.2, 0, base + H * 0.12);
    mist.addColorStop(0, rgba(p.sky[2], 0));
    mist.addColorStop(1, rgba(p.sky[2], 0.22 - i * 0.04));
    ctx.fillStyle = mist;
    ctx.fillRect(0, base - amp * 0.2, W, H * 0.3);
  }
}

function waves(ctx, W, H, p, r) {
  const horizon = H * (0.5 + r() * 0.12);
  sky(ctx, W, H, p, horizon / H);
  const sx = W * (0.25 + r() * 0.5);
  sun(ctx, sx, horizon - H * (0.08 + r() * 0.12), Math.min(W, H) * 0.045, p.sun, 7);
  const bands = 28;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    const y0 = horizon + (H - horizon) * Math.pow(t, 1.6);
    const wf = waveFn(r, 2);
    const amp = 2 + t * H * 0.012;
    const idx = Math.min(p.layers.length - 1, Math.floor(t * p.layers.length));
    const c = mix(p.layers[idx], p.sky[2], 0.35 * (1 - t));
    fillLayer(ctx, W, H, (x) => y0 + wf(x * (1 + t * 3)) * amp, c, mix(p.layers[p.layers.length - 1], '#000000', 0.15));
  }
  // sun glitter path
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 160; i++) {
    const t = r();
    const y = horizon + (H - horizon) * t * t;
    const spread = 6 + t * W * 0.08;
    const x = sx + (r() - 0.5) * spread * 2;
    ctx.fillStyle = rgba(p.sun, 0.12 + r() * 0.25 * (1 - t));
    ctx.fillRect(x, y, 6 + t * 40 * r(), 1 + t * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function aurora(ctx, W, H, p, r) {
  const deep = mix(p.layers[3], '#000000', 0.55);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, mix(deep, '#000000', 0.3));
  g.addColorStop(0.7, deep);
  g.addColorStop(1, mix(p.layers[2], '#000000', 0.3));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.15 + r() * 0.6})`;
    const s = r() < 0.92 ? 1 : 2;
    ctx.fillRect(r() * W, r() * H * 0.75, s, s);
  }
  const ribbons = ['#5ee7b0', '#7aa8ff', mix(p.sun, '#c08bff', 0.5), '#9af0d8'];
  // Draw the ribbons small, then scale up with a blur: soft light at a fraction of the cost.
  const sw = Math.max(64, Math.round(W / 6)), sh = Math.max(64, Math.round(H / 6));
  const off = new OffscreenCanvas(sw, sh);
  const o = off.getContext('2d');
  for (let k = 0; k < 3; k++) {
    const wf = waveFn(r, 3);
    const base = sh * (0.25 + r() * 0.25);
    const amp = sh * 0.08;
    const color = ribbons[Math.floor(r() * ribbons.length)];
    for (let x = 0; x < sw; x++) {
      const t = x / sw;
      const y = base + wf(t) * amp;
      const len = sh * (0.12 + 0.1 * (0.5 + 0.5 * Math.sin(t * 9 + k)));
      const lg = o.createLinearGradient(0, y - len, 0, y + 2);
      lg.addColorStop(0, rgba(color, 0));
      lg.addColorStop(1, rgba(color, 0.35));
      o.fillStyle = lg;
      o.fillRect(x, y - len, 1.5, len + 2);
    }
  }
  ctx.globalCompositeOperation = 'screen';
  ctx.filter = `blur(${Math.round(Math.min(W, H) * 0.012)}px)`;
  ctx.drawImage(off, 0, 0, W, H);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  const rf = ridge(r, 0.5);
  fillLayer(ctx, W, H, (t) => H * 0.82 - rf(t) * H * 0.12, mix(p.layers[3], '#000000', 0.5), '#05070d');
}

function mesh(ctx, W, H, p, r) {
  ctx.fillStyle = p.sky[1];
  ctx.fillRect(0, 0, W, H);
  const colors = [...p.sky, ...p.layers.slice(0, 3), p.sun];
  for (let i = 0; i < 9; i++) {
    const x = r() * W, y = r() * H;
    const rad = Math.max(W, H) * (0.25 + r() * 0.35);
    const c = colors[Math.floor(r() * colors.length)];
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, rgba(c, 0.85));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function grain(ctx, W, H, r) {
  const size = 128;
  const off = new OffscreenCanvas(size, size);
  const o = off.getContext('2d');
  const img = o.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(r() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 10;
  }
  o.putImageData(img, 0, 0);
  ctx.fillStyle = ctx.createPattern(off, 'repeat');
  ctx.fillRect(0, 0, W, H);
}
