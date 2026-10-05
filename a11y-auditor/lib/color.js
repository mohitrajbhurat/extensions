/* Accessibility Auditor - colour maths.
 * Classic script (no modules) so the same file can be injected into pages with
 * chrome.scripting.executeScript and loaded with <script> in extension pages.
 * Exposes window.A11Y.color
 */
(function (root) {
  'use strict';
  const A11Y = (root.A11Y = root.A11Y || {});
  if (A11Y.color) return;

  const cache = new Map();
  let probeCtx = null;

  function probe(str) {
    // Canvas round-trip handles every colour syntax the browser understands
    // (named colours, hsl, oklch, color(display-p3 ...), ...).
    try {
      if (!probeCtx && typeof root.document !== 'undefined' && root.document.createElement) {
        const c = root.document.createElement('canvas');
        c.width = c.height = 1;
        probeCtx = c.getContext('2d', { willReadFrequently: true });
      }
      if (!probeCtx) return null;
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = '#000';
      probeCtx.fillStyle = str;
      if (probeCtx.fillStyle === '#000' && !/^#0{3,8}$|black/i.test(str.trim())) return null;
      probeCtx.globalCompositeOperation = 'copy';
      probeCtx.fillRect(0, 0, 1, 1);
      const d = probeCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  /** Parse any CSS colour string into {r,g,b,a} (0-255, alpha 0-1) or null. */
  function parse(str) {
    if (!str) return null;
    const key = String(str).trim();
    if (cache.has(key)) return cache.get(key);
    let out = null;
    const s = key.toLowerCase();
    if (s === 'transparent' || s === 'rgba(0, 0, 0, 0)') {
      out = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      let m = /^rgba?\(\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)(?:[\s,/]+([-\d.%]+))?\s*\)$/.exec(s);
      if (m) {
        let a = m[4] == null ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        out = { r: +m[1], g: +m[2], b: +m[3], a: isNaN(a) ? 1 : a };
      } else if (/^#([0-9a-f]{3,8})$/.test(s)) {
        const h = s.slice(1);
        const ex = h.length <= 4 ? h.split('').map((c) => c + c).join('') : h;
        out = {
          r: parseInt(ex.slice(0, 2), 16),
          g: parseInt(ex.slice(2, 4), 16),
          b: parseInt(ex.slice(4, 6), 16),
          a: ex.length >= 8 ? parseInt(ex.slice(6, 8), 16) / 255 : 1,
        };
      } else {
        out = probe(key);
      }
    }
    if (out) {
      out.r = Math.max(0, Math.min(255, Math.round(out.r)));
      out.g = Math.max(0, Math.min(255, Math.round(out.g)));
      out.b = Math.max(0, Math.min(255, Math.round(out.b)));
      out.a = Math.max(0, Math.min(1, out.a));
    }
    cache.set(key, out);
    return out;
  }

  /** Composite `fg` (may be translucent) over opaque `bg`. */
  function flatten(fg, bg) {
    const a = fg.a == null ? 1 : fg.a;
    if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    };
  }

  function channel(v) {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(c) {
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  /** WCAG 2.x contrast ratio between two opaque colours. */
  function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function hex(c) {
    const h = (n) => Math.round(n).toString(16).padStart(2, '0');
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  const NO_BG = /^(none|normal)$/;

  /**
   * Walk the ancestor chain and composite every painted layer to get the colour
   * actually behind `el`'s text. Reports when the result cannot be trusted
   * (background images, gradients, translucent media, transformed stacking).
   */
  function effectiveBackground(el, win) {
    const w = win || root;
    const layers = [];
    let node = el;
    let opacity = 1;
    let hasImage = false;
    let imageOwner = null;
    let elementBehind = false;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 120) {
      let st;
      try {
        st = w.getComputedStyle(node);
      } catch (e) {
        break;
      }
      const op = parseFloat(st.opacity);
      if (!isNaN(op) && op < 1) opacity *= op;
      const bgImage = st.backgroundImage;
      if (bgImage && !NO_BG.test(bgImage)) {
        hasImage = true;
        if (!imageOwner) imageOwner = node;
      }
      const bg = parse(st.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1 && !hasImage) break; // fully opaque: nothing below matters
      }
      if (node === w.document.documentElement) break;
      const parent = node.parentElement;
      if (!parent) {
        // Shadow DOM or detached: hop out of the shadow root when possible.
        const r = node.getRootNode && node.getRootNode();
        node = r && r.host ? r.host : null;
      } else {
        node = parent;
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = flatten(layers[i], base);
    return {
      color: base,
      hasImage,
      imageOwner,
      opacity,
      elementBehind,
      incomplete: hasImage,
    };
  }

  /** Text colour as painted, including inherited opacity and the background behind it. */
  function textColor(el, win, bgColor, opacity) {
    const w = win || root;
    const st = w.getComputedStyle(el);
    let fg = parse(st.color) || { r: 0, g: 0, b: 0, a: 1 };
    const a = (fg.a == null ? 1 : fg.a) * (opacity == null ? 1 : opacity);
    return flatten({ r: fg.r, g: fg.g, b: fg.b, a }, bgColor);
  }

  /** WCAG 1.4.3 / 1.4.6 large-text thresholds. */
  function isLargeText(fontSizePx, fontWeight) {
    const size = parseFloat(fontSizePx) || 0;
    const weight = parseInt(fontWeight, 10) || (/bold/i.test(String(fontWeight)) ? 700 : 400);
    const pt = size * 0.75;
    return pt >= 18 || (pt >= 14 && weight >= 700);
  }

  A11Y.color = { parse, flatten, luminance, contrast, hex, effectiveBackground, textColor, isLargeText };
})(typeof window !== 'undefined' ? window : self);
