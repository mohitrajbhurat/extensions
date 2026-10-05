/* Eyedropper (EyeDropper API with a screenshot loupe fallback), color formats,
   history palette and WCAG contrast checker. */
import { h, clear, copyText, sendMessage, loadState, saveState } from './util.js';
import { parseColor, toHex, formatsOf, contrastRatio, wcag, flatten, rgbToOklch, oklchToRgb } from './color.js';

const KEY = 'di.colors';
const HISTORY_MAX = 32;
const DEFAULTS = { history: [], fg: '#1f2937', bg: '#ffffff', useLoupe: false };

async function loadSettings() {
  const s = await loadState(KEY, {});
  return { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
}

export const hasEyeDropper = () => typeof window.EyeDropper === 'function';

const frames = n => new Promise(r => {
  const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step));
  step();
});

/** Pick a color from the screen. Resolves to a hex string or null when cancelled. */
export async function pickColor(app) {
  const settings = await loadSettings();
  if (!settings.useLoupe && hasEyeDropper()) {
    app.hideUI(true);
    try {
      const res = await new window.EyeDropper().open();
      return res && res.sRGBHex ? toHex(parseColor(res.sRGBHex), true) : null;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // NotAllowedError etc.: fall through to the loupe.
    } finally {
      app.hideUI(false);
    }
  }
  return loupePick(app);
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function captureTab(app) {
  app.hideUI(true);
  await frames(2);
  let res;
  try {
    res = await sendMessage({ type: 'di-capture' });
  } finally {
    app.hideUI(false);
  }
  if (!res || !res.ok || !res.dataUrl) throw new Error((res && res.error) || 'capture failed');
  const bmp = await createImageBitmap(dataUrlToBlob(res.dataUrl));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return { canvas, ctx, sx: canvas.width / innerWidth, sy: canvas.height / innerHeight };
}

/** Screenshot-based picker with a magnifying loupe. */
export async function loupePick(app) {
  let shot;
  try {
    shot = await captureTab(app);
  } catch (e) {
    app.toast('Could not capture this tab: ' + (e.message || e), 3200);
    return null;
  }
  return new Promise(resolve => {
    const ZOOM = 12, CELLS = 11, SIZE = ZOOM * CELLS;
    const loupeCanvas = h('canvas');
    const dpr = devicePixelRatio || 1;
    loupeCanvas.width = SIZE * dpr;
    loupeCanvas.height = SIZE * dpr;
    const lctx = loupeCanvas.getContext('2d');
    lctx.imageSmoothingEnabled = false;
    const loupe = h('div.loupe', loupeCanvas, h('div.cross'));
    const label = h('div.loupe-label');
    const grab = h('div.grab-layer', { tabindex: '0', role: 'application', 'aria-label': 'Color picker. Move with the mouse or arrow keys, click or press Enter to pick, Escape to cancel.' });
    const wrap = h('div', { 'data-di-loupe': '', style: { position: 'fixed', inset: '0', pointerEvents: 'auto', cursor: 'crosshair' } }, grab, loupe, label);
    app.hideUI(true);
    app.shadow.append(wrap);
    let x = app.mouse.x >= 0 ? app.mouse.x : innerWidth / 2;
    let y = app.mouse.y >= 0 ? app.mouse.y : innerHeight / 2;
    let current = null;

    const sample = () => {
      const px = Math.min(shot.canvas.width - 1, Math.max(0, Math.round(x * shot.sx)));
      const py = Math.min(shot.canvas.height - 1, Math.max(0, Math.round(y * shot.sy)));
      const d = shot.ctx.getImageData(px, py, 1, 1).data;
      current = { r: d[0], g: d[1], b: d[2], a: 1 };
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.fillStyle = '#000';
      lctx.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height);
      lctx.imageSmoothingEnabled = false;
      const half = Math.floor(CELLS / 2);
      lctx.drawImage(shot.canvas, px - half, py - half, CELLS, CELLS, 0, 0, loupeCanvas.width, loupeCanvas.height);
      // Pixel grid
      lctx.strokeStyle = 'rgba(0,0,0,.15)';
      lctx.lineWidth = 1;
      const cell = loupeCanvas.width / CELLS;
      lctx.beginPath();
      for (let i = 1; i < CELLS; i++) {
        lctx.moveTo(Math.round(i * cell) + 0.5, 0); lctx.lineTo(Math.round(i * cell) + 0.5, loupeCanvas.height);
        lctx.moveTo(0, Math.round(i * cell) + 0.5); lctx.lineTo(loupeCanvas.width, Math.round(i * cell) + 0.5);
      }
      lctx.stroke();
      loupe.style.left = x + 'px';
      loupe.style.top = y + 'px';
      label.textContent = `${toHex(current)}  ${Math.round(x)}, ${Math.round(y)}`;
      label.style.left = x + 'px';
      label.style.top = Math.min(innerHeight - 20, y + SIZE / 2 + 8) + 'px';
    };
    const finish = value => {
      wrap.remove();
      app.hideUI(false);
      resolve(value);
    };
    grab.addEventListener('pointermove', e => { x = e.clientX; y = e.clientY; sample(); });
    grab.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return finish(null);
      x = e.clientX; y = e.clientY;
      sample();
      finish(toHex(current));
    });
    grab.addEventListener('contextmenu', e => e.preventDefault());
    grab.addEventListener('keydown', e => {
      const step = e.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      e.stopPropagation();
      if (moves[e.key]) {
        e.preventDefault();
        x = Math.min(innerWidth - 1, Math.max(0, x + moves[e.key][0]));
        y = Math.min(innerHeight - 1, Math.max(0, y + moves[e.key][1]));
        sample();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        finish(toHex(current));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    sample();
    grab.focus();
  });
}

/** Lighten or darken fg (in OKLCH) until it reaches the target ratio on bg. */
export function suggestFix(fg, bg, target = 4.5) {
  if (!fg || !bg) return null;
  const base = flatten(fg, bg);
  if (contrastRatio(base, bg) >= target) return null;
  const o = rgbToOklch(base);
  let best = null;
  for (const dir of [-1, 1]) {
    for (let step = 1; step <= 100; step++) {
      const L = o.l + dir * step * 0.01;
      if (L < 0 || L > 1) break;
      const c = oklchToRgb(L, o.c, o.h);
      if (contrastRatio(c, bg) >= target) {
        if (!best || step < best.step) best = { step, color: c };
        break;
      }
    }
  }
  return best ? toHex(best.color) : null;
}

/* ------------------------------------------------------------- panel */
export async function openColors(app, { pick, fg, bg } = {}) {
  const st = await loadSettings();
  if (pick) {
    st.history = [pick, ...st.history.filter(c => c !== pick)].slice(0, HISTORY_MAX);
  }
  if (fg) st.fg = fg;
  if (bg) st.bg = bg;
  let current = pick || st.history[0] || st.fg;
  const persist = () => saveState(KEY, st);
  persist();

  /* Current color */
  const bigSwatch = h('div.swatch.lg.alpha', { role: 'img' });
  const swatchFill = h('div', { style: { position: 'absolute', inset: '0' } });
  bigSwatch.append(swatchFill);
  const formatRows = h('dl.kv');
  const colorInput = h('input', { type: 'text', 'aria-label': 'Color value (any CSS color)', spellcheck: 'false' });
  const updateCurrent = () => {
    const c = parseColor(current);
    if (!c) return;
    swatchFill.style.background = toHex(c, true);
    bigSwatch.setAttribute('aria-label', `Current color ${toHex(c, true)}`);
    clear(formatRows);
    const f = formatsOf(c);
    for (const [k, v] of Object.entries(f)) {
      formatRows.append(h('dt', k.toUpperCase()), h('dd', h('div.row.spread',
        h('span.mono', v),
        h('button.icon', { type: 'button', title: `Copy ${k.toUpperCase()}`, 'aria-label': `Copy ${k.toUpperCase()} ${v}`, onclick: async () => app.toast((await copyText(v)) ? `Copied ${v}` : 'Copy failed') }, '⧉'))));
    }
    if (app.shadow.activeElement !== colorInput) colorInput.value = toHex(c, true);
  };
  colorInput.addEventListener('input', () => {
    if (parseColor(colorInput.value)) {
      current = colorInput.value.trim();
      updateCurrent();
    }
  });
  colorInput.addEventListener('change', () => {
    const c = parseColor(colorInput.value);
    if (c) addHistory(toHex(c, true));
  });

  const currentSect = h('section.sect',
    h('div.sect-head', 'Color'),
    h('div.sect-body',
      h('div.row', bigSwatch, h('div.grow', colorInput)),
      formatRows,
      h('div.row.tight',
        h('button.btn.primary', { type: 'button', onclick: () => app.startPick() }, 'Pick from page'),
        h('button.btn', { type: 'button', onclick: () => setPair('fg', current) }, 'Use as text'),
        h('button.btn', { type: 'button', onclick: () => setPair('bg', current) }, 'Use as background'))));

  /* History */
  const histBox = h('div.swatches');
  const renderHistory = () => {
    clear(histBox);
    if (!st.history.length) histBox.append(h('div.empty', 'Picked colors show up here.'));
    for (const hex of st.history) {
      const c = parseColor(hex);
      const sw = h('button.swatch' + (c && c.a < 1 ? '.alpha' : ''), {
        type: 'button', title: `${hex} (click to select, Shift+click to copy)`, 'aria-label': `History color ${hex}`,
        onclick: async e => {
          if (e.shiftKey) app.toast((await copyText(hex)) ? `Copied ${hex}` : 'Copy failed');
          current = hex;
          updateCurrent();
        },
      });
      const fill = h('span', { style: { position: 'absolute', inset: '0', background: hex } });
      sw.append(fill);
      histBox.append(sw);
    }
  };
  const addHistory = hex => {
    st.history = [hex, ...st.history.filter(c => c !== hex)].slice(0, HISTORY_MAX);
    persist();
    renderHistory();
  };
  const histSect = h('section.sect',
    h('div.sect-head', 'History', h('span.count', `max ${HISTORY_MAX}`)),
    h('div.sect-body', histBox, h('div.row.tight',
      h('button.btn', {
        type: 'button', title: 'Copy history as CSS custom properties',
        onclick: async () => {
          const css = `:root {\n${st.history.map((c, i) => `  --picked-${i + 1}: ${c};`).join('\n')}\n}`;
          app.toast((await copyText(css)) ? 'Copied as CSS variables' : 'Copy failed');
        },
      }, 'Copy as CSS'),
      h('button.btn.ghost', { type: 'button', onclick: () => { st.history = []; persist(); renderHistory(); } }, 'Clear'))));

  /* Contrast */
  const pairInput = (which, label) => {
    const text = h('input', { type: 'text', value: st[which], 'aria-label': `${label} color`, spellcheck: 'false' });
    const picker = h('input', { type: 'color', 'aria-label': `${label} color picker` });
    const sync = () => {
      const c = parseColor(st[which]);
      if (c) picker.value = toHex(c);
    };
    text.addEventListener('input', () => {
      if (parseColor(text.value)) {
        st[which] = text.value.trim();
        sync();
        updateContrast();
      }
    });
    text.addEventListener('change', persist);
    picker.addEventListener('input', () => {
      st[which] = picker.value;
      text.value = picker.value;
      updateContrast();
    });
    picker.addEventListener('change', persist);
    sync();
    return { el: h('label.field', label, h('div.row', picker, h('div.grow', text))), text, sync };
  };
  const fgIn = pairInput('fg', 'Text');
  const bgIn = pairInput('bg', 'Background');
  const setPair = (which, value) => {
    st[which] = value;
    const inp = which === 'fg' ? fgIn : bgIn;
    inp.text.value = value;
    inp.sync();
    persist();
    updateContrast();
  };
  const preview = h('div', { style: { borderRadius: '8px', padding: '10px 12px', border: '1px solid var(--di-line)' } },
    h('div', { style: { fontSize: '14px' } }, 'Normal text, 14px. The quick brown fox.'),
    h('div', { style: { fontSize: '19px', fontWeight: '700' } }, 'Large bold text, 19px'));
  const results = h('div.list');
  const updateContrast = () => {
    const f = parseColor(st.fg), b = parseColor(st.bg);
    clear(results);
    if (!f || !b) {
      results.append(h('div.empty', 'Enter two valid colors.'));
      return;
    }
    const bgFlat = flatten(b, { r: 255, g: 255, b: 255, a: 1 });
    const fgFlat = flatten(f, bgFlat);
    preview.style.background = toHex(bgFlat);
    preview.style.color = toHex(f, true);
    const ratio = contrastRatio(fgFlat, bgFlat);
    const v = wcag(ratio);
    const pill = (label, ok, title) => h('span.pill.' + (ok ? 'ok' : 'bad'), { title }, (ok ? '✓ ' : '✕ ') + label);
    results.append(
      h('div.row', h('span.bigratio', { 'data-ratio': ratio.toFixed(2) }, `${ratio.toFixed(2)}:1`),
        h('span.dim', ratio >= 7 ? 'Excellent' : ratio >= 4.5 ? 'Passes AA' : ratio >= 3 ? 'Large text only' : 'Fails')),
      h('div.row.tight',
        pill('AA normal', v.normalAA, '4.5:1 for body text'),
        pill('AAA normal', v.normalAAA, '7:1 for body text'),
        pill('AA large', v.largeAA, '3:1 for 18.66px bold or 24px text'),
        pill('AAA large', v.largeAAA, '4.5:1 for large text'),
        pill('UI 3:1', v.uiAA, 'WCAG 1.4.11 non-text contrast')));
    if (!v.normalAA) {
      const fix = suggestFix(f, bgFlat, 4.5);
      if (fix) {
        const sw = h('span.chip-color');
        sw.style.background = fix;
        results.append(h('div.row', h('span.dim', 'Nearest AA text color:'),
          h('button.btn', { type: 'button', title: 'Use this text color', onclick: () => setPair('fg', fix) }, sw, fix)));
      }
    }
  };
  const contrastSect = h('section.sect',
    h('div.sect-head', 'Contrast checker (WCAG 2.2)'),
    h('div.sect-body', fgIn.el, bgIn.el,
      h('div.row', h('button.btn', { type: 'button', title: 'Swap text and background', onclick: () => { const t = st.fg; setPair('fg', st.bg); setPair('bg', t); } }, '⇅ Swap')),
      preview, results));

  /* Settings */
  const loupeToggle = h('input', { type: 'checkbox', checked: !!st.useLoupe || !hasEyeDropper(), disabled: !hasEyeDropper() });
  loupeToggle.addEventListener('change', () => { st.useLoupe = loupeToggle.checked; persist(); });
  const setSect = h('label.row.hint', loupeToggle,
    hasEyeDropper() ? 'Use the screenshot loupe instead of the system eyedropper' : 'System eyedropper not available here, using the screenshot loupe');

  app.showPanel('colors', { title: 'Colors', body: [currentSect, contrastSect, histSect, setSect] });
  updateCurrent();
  renderHistory();
  updateContrast();
}
