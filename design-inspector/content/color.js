/* Color math: parsing, conversion (HEX / RGB / HSL / OKLCH), WCAG contrast. */

let probe = null;

/** Normalize any CSS color string to {r,g,b,a} (0-255, a 0-1) or null. */
export function parseColor(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'none' || s === 'currentcolor' || s === 'inherit') return null;

  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const h = m[1];
    const ex = n => parseInt(n.length === 1 ? n + n : n, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: ex(h[0]), g: ex(h[1]), b: ex(h[2]),
        a: h.length === 4 ? ex(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: ex(h.slice(0, 2)), g: ex(h.slice(2, 4)), b: ex(h.slice(4, 6)),
        a: h.length === 8 ? ex(h.slice(6, 8)) / 255 : 1,
      };
    }
  }
  m = /^rgba?\(\s*([-\d.]+)(%?)[\s,]+([-\d.]+)(%?)[\s,]+([-\d.]+)(%?)\s*(?:[,/]\s*([-\d.]+)(%?)\s*)?\)$/i.exec(s);
  if (m) {
    const ch = (v, pct) => clamp(Math.round(pct ? (parseFloat(v) / 100) * 255 : parseFloat(v)), 0, 255);
    let a = 1;
    if (m[7] != null) a = clamp(m[8] ? parseFloat(m[7]) / 100 : parseFloat(m[7]), 0, 1);
    return { r: ch(m[1], m[2]), g: ch(m[3], m[4]), b: ch(m[5], m[6]), a };
  }
  // Anything else (named colors, hsl(), lab(), color-mix(), ...) goes through the engine.
  try {
    if (!probe) {
      probe = document.createElement('span');
      probe.style.display = 'none';
      probe.setAttribute('data-design-inspector-probe', '');
    }
    if (!probe.isConnected) (document.body || document.documentElement).appendChild(probe);
    probe.style.color = '';
    probe.style.color = s;
    if (!probe.style.color) return null;
    const out = getComputedStyle(probe).color;
    probe.remove();
    if (out && out !== s) return parseColor(out);
  } catch {}
  return null;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r2 = v => Math.round(v * 100) / 100;

export function toHex(c, withAlpha = false) {
  if (!c) return '';
  const h = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  if (withAlpha && c.a != null && c.a < 1) return base + h(c.a * 255);
  return base;
}

export function toRgbString(c) {
  if (!c) return '';
  const n = v => Math.round(v);
  return c.a != null && c.a < 1
    ? `rgb(${n(c.r)} ${n(c.g)} ${n(c.b)} / ${r2(c.a)})`
    : `rgb(${n(c.r)} ${n(c.g)} ${n(c.b)})`;
}

export function rgbToHsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100, a: c.a == null ? 1 : c.a };
}

export function hslToRgb(h, s, l, a = 1) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  const k = n => (n + h / 30) % 12;
  const f = n => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a };
}

export function toHslString(c) {
  const h = rgbToHsl(c);
  const base = `hsl(${Math.round(h.h)} ${Math.round(h.s)}% ${Math.round(h.l)}%`;
  return h.a < 1 ? `${base} / ${r2(h.a)})` : `${base})`;
}

/* ---- OKLab / OKLCH ------------------------------------------------- */
const srgbToLin = v => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const linToSrgb = v => {
  const o = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(Math.round(o * 255), 0, 255) || 0;
};

export function rgbToOklch(c) {
  const r = srgbToLin(c.r), g = srgbToLin(c.g), b = srgbToLin(c.b);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: C < 1e-4 ? 0 : H, a: c.a == null ? 1 : c.a };
}

export function oklchToRgb(L, C, H, a = 1) {
  const hr = (H * Math.PI) / 180;
  const A = Math.cos(hr) * C, B = Math.sin(hr) * C;
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return {
    r: linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  };
}

export function toOklchString(c) {
  const o = rgbToOklch(c);
  const base = `oklch(${(o.l * 100).toFixed(1)}% ${o.c.toFixed(3)} ${o.h.toFixed(1)}`;
  return o.a < 1 ? `${base} / ${r2(o.a)})` : `${base})`;
}

/* ---- Contrast ------------------------------------------------------ */
export function luminance(c) {
  return 0.2126 * srgbToLin(c.r) + 0.7152 * srgbToLin(c.g) + 0.0722 * srgbToLin(c.b);
}

/** Flatten a translucent color over a backdrop. */
export function flatten(fg, bg) {
  if (!fg) return null;
  const a = fg.a == null ? 1 : fg.a;
  if (a >= 1 || !bg) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export function contrastRatio(a, b) {
  if (!a || !b) return 0;
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const l1 = luminance(flatten(a, white));
  const l2 = luminance(flatten(b, white));
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.1 verdicts for a ratio. */
export function wcag(ratio) {
  return {
    ratio,
    normalAA: ratio >= 4.5,
    normalAAA: ratio >= 7,
    largeAA: ratio >= 3,
    largeAAA: ratio >= 4.5,
    uiAA: ratio >= 3,
  };
}

/** A readable text color (black or white) for a swatch background. */
export function readableOn(c) {
  const f = flatten(c, { r: 255, g: 255, b: 255, a: 1 });
  return luminance(f) > 0.38 ? '#111827' : '#ffffff';
}

/** Rough family bucket used to group an extracted palette. */
export function colorFamily(c) {
  const { h, s, l } = rgbToHsl(c);
  if (c.a != null && c.a < 0.08) return 'transparent';
  // Low OKLCH chroma reads as neutral even when HSL saturation is inflated (e.g. bluish grays).
  if (s < 10 || rgbToOklch(c).c < 0.03) return l < 12 ? 'black' : l > 92 ? 'white' : 'gray';
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 250) return 'blue';
  if (h < 290) return 'violet';
  if (h < 345) return 'pink';
  return 'other';
}

export const FAMILY_ORDER = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink', 'gray', 'black', 'white', 'transparent', 'other'];

export function formatsOf(c) {
  return {
    hex: toHex(c, true),
    rgb: toRgbString(c),
    hsl: toHslString(c),
    oklch: toOklchString(c),
  };
}
