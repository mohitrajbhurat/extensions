// Reading Studio dark mode engine.
//  - filter mode: inverts the page with a CSS filter and counter-inverts media.
//  - dynamic mode: rewrites colors from readable stylesheets and inline styles, resolves CSS variables
//    by how they are used, then sweeps computed styles to catch anything left light.
(function () {
  const RS = globalThis.RS;
  if (!RS || RS.dark) return;

  // ---------------------------------------------------------------- color math
  const colorCache = new Map();
  let ctx2d = null;
  function parseColor(str) {
    if (!str) return null;
    str = String(str).trim();
    if (colorCache.has(str)) return colorCache.get(str);
    let c = null;
    const low = str.toLowerCase();
    if (low === 'transparent') c = { r: 0, g: 0, b: 0, a: 0 };
    else if (/^(inherit|initial|unset|revert|revert-layer|currentcolor|none|auto)$/.test(low) || low.includes('var(')) c = null;
    else {
      let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(str);
      if (m) c = { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) };
      else if ((m = /^#([0-9a-f]{3,8})$/i.exec(str))) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
        if (h.length === 6 || h.length === 8) {
          c = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
        }
      } else {
        // Named colors, hsl(), lab(), oklch(), color(): let the canvas normalize them.
        try {
          if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
          ctx2d.fillStyle = '#010203';
          ctx2d.fillStyle = str;
          const v = ctx2d.fillStyle;
          if (v !== '#010203' || low === '#010203') c = parseColor(v);
        } catch (e) { c = null; }
      }
    }
    if (colorCache.size > 4000) colorCache.clear();
    colorCache.set(str, c);
    return c;
  }

  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  }
  function hslToRgb({ h, s, l }) {
    if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
  }
  // Relative luminance-ish lightness (perceptual weighting) in 0..1.
  function lightness(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

  let tune = { brightness: 1, contrast: 1, sepia: 0, grayscale: 0 };

  function finalize(rgb, a) {
    let { r, g, b } = rgb;
    r /= 255; g /= 255; b /= 255;
    if (tune.brightness !== 1) { r *= tune.brightness; g *= tune.brightness; b *= tune.brightness; }
    if (tune.contrast !== 1) { r = (r - 0.5) * tune.contrast + 0.5; g = (g - 0.5) * tune.contrast + 0.5; b = (b - 0.5) * tune.contrast + 0.5; }
    if (tune.grayscale) { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; r += (y - r) * tune.grayscale; g += (y - g) * tune.grayscale; b += (y - b) * tune.grayscale; }
    if (tune.sepia) {
      const s = tune.sepia;
      const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * s; g += (sg - g) * s; b += (sb - b) * s;
    }
    const cl = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const A = a == null ? 1 : Math.round(a * 1000) / 1000;
    return A >= 1 ? `rgb(${cl(r)}, ${cl(g)}, ${cl(b)})` : `rgba(${cl(r)}, ${cl(g)}, ${cl(b)}, ${A})`;
  }

  // Role transforms: 'bg' darkens light surfaces, 'fg' lightens dark text, 'border' sits in between.
  function transform(c, role) {
    if (!c) return null;
    if (c.a === 0) return 'transparent';
    const hsl = rgbToHsl(c);
    const L = lightness(c);
    let out;
    if (role === 'bg') {
      if (L < 0.3) out = { h: hsl.h, s: hsl.s, l: Math.min(hsl.l, 0.3) };
      else {
        const t = (L - 0.3) / 0.7;              // 0 (mid) .. 1 (white)
        const l = 0.3 - t * 0.2;                // white -> 0.10, mid -> 0.30
        out = { h: hsl.h, s: hsl.s * (hsl.s > 0.6 ? 0.75 : 0.9), l };
      }
    } else if (role === 'fg') {
      if (L > 0.62) out = hsl;
      else {
        const t = L / 0.62;                     // 0 (black) .. 1
        const l = 0.88 - t * 0.2;               // black -> 0.88, mid -> 0.68
        out = { h: hsl.h, s: Math.min(1, hsl.s * 1.05), l: Math.max(l, hsl.s > 0.3 ? 0.68 : l) };
      }
    } else { // border
      const l = L > 0.5 ? 0.18 + (1 - L) * 0.25 : 0.38 + (0.5 - L) * 0.3;
      out = { h: hsl.h, s: hsl.s * 0.8, l };
    }
    return finalize(hslToRgb(out), c.a);
  }

  const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\b(?:white|black|silver|gray|grey|whitesmoke|gainsboro|lightgray|lightgrey|ghostwhite|snow|ivory|beige|linen|floralwhite|azure|aliceblue|mintcream|honeydew|seashell|oldlace|lavender|lavenderblush|cornsilk|lemonchiffon|papayawhip|blanchedalmond|mistyrose|antiquewhite|navy|blue|red|green|darkgray|darkgrey|dimgray|dimgrey|yellow|orange|purple|teal|maroon|olive|lightyellow|lightblue|lightgreen|lightpink|lightcyan)\b/gi;

  function transformValue(value, role) {
    if (!value) return null;
    const v = value.trim();
    if (/^(inherit|initial|unset|revert|revert-layer|currentcolor|none|transparent)$/i.test(v)) return null;
    if (v.includes('var(')) return null;
    if (/gradient\(/i.test(v)) {
      if (/url\(/i.test(v)) return null; // mixed image layers: leave natural
      return v.replace(COLOR_TOKEN, (tok) => transform(parseColor(tok), 'bg') || tok);
    }
    if (/url\(/i.test(v)) return null;
    const c = parseColor(v);
    if (!c) return null;
    return transform(c, role);
  }

  // ---------------------------------------------------------------- state
  const D = {
    active: false,
    mode: null,
    alreadyDark: null,
    reason: '',
    styleBase: null,
    styleRules: null,
    styleDyn: null,
    sheetCache: new WeakMap(),
    dynRules: new Map(),       // key -> id
    dynCss: [],
    inlineId: 0,
    observer: null,
    attrObserver: null,
    queue: new Set(),
    scheduled: false,
    sheetTimer: null,
    lastSheetSig: '',
    pollUntil: 0
  };

  const BG = '#181a1b', FG = '#e3e1dc', BG2 = '#222527', BORDER = '#3d4245', LINK = '#7fb2ff', VISITED = '#c49cff';

  function makeStyle(id) {
    const s = document.createElement('style');
    s.id = id;
    s.setAttribute('data-rs-dark', '');
    return s;
  }
  function mountStyles(...els) {
    const parent = document.head || document.documentElement;
    for (const el of els) if (el && el.parentNode !== parent) parent.appendChild(el);
    else if (el && parent.lastElementChild !== el && el === D.styleDyn) parent.appendChild(el); // keep last
  }
  function keepLast() {
    // Our sheets must come after the page's so equal-specificity overrides win.
    const parent = document.head || document.documentElement;
    const ours = [D.styleBase, D.styleRules, D.styleDyn].filter(Boolean);
    const last = parent.lastElementChild;
    if (ours.length && !ours.includes(last)) for (const s of ours) parent.appendChild(s);
  }

  function setOurStylesEnabled(on) {
    for (const s of document.querySelectorAll('style[data-rs-dark]')) s.media = on ? '' : 'not all';
  }

  // ---------------------------------------------------------------- page analysis
  function effectiveBg(el) {
    while (el && el.nodeType === 1) {
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) return c;
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage)) {
        const m = cs.backgroundImage.match(COLOR_TOKEN); if (m) { const g = parseColor(m[0]); if (g && g.a > 0.5) return g; }
      }
      el = el.parentElement;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    return scheme.includes('dark') && !scheme.includes('light') ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }

  // True when the page (without our styles) already has a dark background with light text.
  function detectAlreadyDark() {
    if (!document.body) return false;
    setOurStylesEnabled(false);
    const wasFilter = document.documentElement.getAttribute('data-rs-dark-mode');
    document.documentElement.removeAttribute('data-rs-dark-mode');
    try {
      let dark = 0, total = 0;
      const pts = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.3, 0.75], [0.7, 0.75], [0.5, 0.12], [0.5, 0.9]];
      const W = innerWidth, H = innerHeight;
      for (const [x, y] of pts) {
        let el = document.elementFromPoint(W * x, H * y);
        if (!el || RS.isOurUI(el)) continue;
        if (/^(IMG|VIDEO|CANVAS|PICTURE|IFRAME|svg)$/i.test(el.tagName)) el = el.parentElement;
        const bg = effectiveBg(el);
        total++;
        if (lightness(bg) < 0.35) dark++;
      }
      const bodyBg = effectiveBg(document.body);
      const fg = parseColor(getComputedStyle(document.body).color);
      const bodyDark = lightness(bodyBg) < 0.35;
      const textLight = fg ? lightness(fg) > 0.6 : false;
      if (total === 0) return bodyDark;
      return (dark / total >= 0.6) || (bodyDark && textLight && dark / total >= 0.4);
    } finally {
      if (wasFilter) document.documentElement.setAttribute('data-rs-dark-mode', wasFilter);
      setOurStylesEnabled(true);
    }
  }

  // ---------------------------------------------------------------- base + filter css
  function baseCss() {
    const t = (c, role) => transform(parseColor(c), role);
    const bg = finalize(parseColor(BG)), fg = finalize(parseColor(FG));
    return `
:root{color-scheme:dark !important}
:where(html){background-color:${bg};color:${fg}}
:where(body){background-color:${bg};color:${fg}}
:where(input,textarea,select,button,option){background-color:${finalize(parseColor(BG2))};color:${fg};border-color:${finalize(parseColor(BORDER))}}
:where(a:link){color:${finalize(parseColor(LINK))}}
:where(a:visited){color:${finalize(parseColor(VISITED))}}
:where(table,th,td,hr){border-color:${finalize(parseColor(BORDER))}}
:where(mark){background-color:${t('#ffe066', 'bg')};color:${fg}}
::placeholder{color:${finalize(parseColor('#8b9095'))}}
::selection{background-color:#1f4f8f;color:#fff}
html{scrollbar-color:${finalize(parseColor('#454a4d'))} ${finalize(parseColor('#202324'))}}
img,video,picture{opacity:.96}
`;
  }

  function filterCss() {
    const f = `invert(1) hue-rotate(180deg) brightness(${tune.brightness}) contrast(${tune.contrast}) sepia(${tune.sepia}) grayscale(${tune.grayscale})`;
    return `
html[data-rs-dark-mode="filter"]{filter:${f} !important;background-color:#fff !important}
html[data-rs-dark-mode="filter"]:not([data-rs-reader]) :is(img,video,picture,canvas,iframe,embed,object,svg image,[style*="background-image"]):not(:is(picture,[style*="background-image"]) *),
html[data-rs-dark-mode="filter"]:not([data-rs-reader]) rs-ui[data-rs-ui]{filter:invert(1) hue-rotate(180deg) !important}
html[data-rs-dark-mode="filter"][data-rs-reader]{filter:none !important}
html[data-rs-dark-mode="filter"] :fullscreen{filter:invert(1) hue-rotate(180deg) !important}
`;
  }

  // ---------------------------------------------------------------- stylesheet rewriting (dynamic)
  const PROPS = [
    ['background-color', 'bg'], ['background-image', 'bg'], ['color', 'fg'], ['border-top-color', 'border'], ['border-right-color', 'border'],
    ['border-bottom-color', 'border'], ['border-left-color', 'border'], ['outline-color', 'border'], ['text-decoration-color', 'fg'],
    ['column-rule-color', 'border'], ['caret-color', 'fg'], ['fill', 'fg'], ['stroke', 'fg'], ['-webkit-text-fill-color', 'fg']
  ];
  const ROLE_BIT = { bg: 1, fg: 2, border: 4 };

  function collectRules(list, out, wrappers) {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) out.push({ rule, wrappers });
      else if (typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule) collectRules(rule.cssRules, out, wrappers.concat(`@media ${rule.conditionText || rule.media.mediaText}`));
      else if (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) collectRules(rule.cssRules, out, wrappers.concat(`@supports ${rule.conditionText}`));
      else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) collectRules(rule.cssRules, out, wrappers);
      else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) collectRules(rule.cssRules, out, wrappers.concat(`@container ${rule.conditionText}`));
      else if (rule.styleSheet) { // @import
        try { collectRules(rule.styleSheet.cssRules, out, rule.media && rule.media.mediaText ? wrappers.concat(`@media ${rule.media.mediaText}`) : wrappers); } catch (e) { /* cross-origin import */ }
      }
    }
  }

  function varNames(v) { const out = []; const re = /var\(\s*(--[\w-]+)/g; let m; while ((m = re.exec(v))) out.push(m[1]); return out; }

  function rewriteSheets() {
    const entries = [];
    const varRole = new Map();
    const varTriplet = new Set();
    const varDecls = [];
    const alias = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const owner = sheet.ownerNode;
      if (owner && owner.hasAttribute && owner.hasAttribute('data-rs-dark')) continue;
      if (sheet.disabled) continue;
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin: the computed sweep covers it
      if (!rules) continue;
      const list = [];
      try { collectRules(rules, list, sheet.media && sheet.media.mediaText && sheet.media.mediaText !== 'all' ? [`@media ${sheet.media.mediaText}`] : []); } catch (e) { continue; }
      entries.push(...list);
    }
    // Adopted stylesheets (constructable) too.
    try { for (const sh of document.adoptedStyleSheets || []) { const list = []; collectRules(sh.cssRules, list, []); entries.push(...list); } } catch (e) { /* ignore */ }

    const blocks = [];
    for (const { rule, wrappers } of entries) {
      const st = rule.style;
      if (!st || !st.length) continue;
      const decls = [];
      for (const [prop, role] of PROPS) {
        const v = st.getPropertyValue(prop);
        if (!v) continue;
        if (v.includes('var(')) {
          for (const n of varNames(v)) {
            varRole.set(n, (varRole.get(n) || 0) | ROLE_BIT[role]);
            if (/(rgba?|hsla?)\(\s*var\(/.test(v)) varTriplet.add(n);
          }
          continue;
        }
        if ((prop === 'fill' || prop === 'stroke') && !/^(#|rgb|hsl)/i.test(v.trim())) continue;
        const nv = transformValue(v, role);
        if (nv && nv !== v) decls.push(`${prop}:${nv}${st.getPropertyPriority(prop) ? ' !important' : ''}`);
      }
      for (let i = 0; i < st.length; i++) {
        const name = st[i];
        if (!name.startsWith('--')) continue;
        const v = st.getPropertyValue(name).trim();
        if (!v) continue;
        if (v.includes('var(')) { for (const n of varNames(v)) alias.push([name, n]); continue; }
        varDecls.push({ rule, wrappers, name, value: v, important: !!st.getPropertyPriority(name) });
      }
      if (decls.length) blocks.push({ wrappers, css: `${rule.selectorText}{${decls.join(';')}}` });
    }
    // Inline styles with variables or colors on elements are handled in the sweep; their var usage too.
    for (const el of document.querySelectorAll('[style*="var(--"]')) {
      const st = el.style;
      for (const [prop, role] of PROPS) { const v = st.getPropertyValue(prop); if (v && v.includes('var(')) for (const n of varNames(v)) varRole.set(n, (varRole.get(n) || 0) | ROLE_BIT[role]); }
    }
    // Propagate roles through aliases (--a: var(--b)).
    for (let k = 0; k < 3; k++) for (const [a, b] of alias) { const ra = varRole.get(a); if (ra) varRole.set(b, (varRole.get(b) || 0) | ra); }

    for (const d of varDecls) {
      const nv = rewriteVar(d.name, d.value, varRole.get(d.name) || 0, varTriplet.has(d.name));
      if (nv && nv !== d.value) blocks.push({ wrappers: d.wrappers, css: `${d.rule.selectorText}{${d.name}:${nv}${d.important ? ' !important' : ''}}` });
    }

    let css = '';
    for (const b of blocks) {
      let s = b.css;
      for (let i = b.wrappers.length - 1; i >= 0; i--) s = `${b.wrappers[i]}{${s}}`;
      css += s + '\n';
    }
    return css;
  }

  function guessRole(name, c) {
    const n = name.toLowerCase();
    if (/(^|-)(bg|background|backdrop|surface|canvas|paper|base|fill|layer|card|panel|overlay|well|highlight|shade|tint)(-|$)/.test(n)) return 'bg';
    if (/(^|-)(text|fg|foreground|ink|font|heading|title|body-color|link|icon|on-)/.test(n)) return 'fg';
    if (/(border|line|divider|outline|stroke|ring|rule|separator)/.test(n)) return 'border';
    return lightness(c) > 0.5 ? 'bg' : 'fg';
  }

  function rewriteVar(name, value, roleBits, triplet) {
    // RGB triplets ("255 255 255" / "255, 255, 255") used inside rgb(var(--x) / a).
    const tm = /^(\d{1,3})(\s*,\s*|\s+)(\d{1,3})\2(\d{1,3})$/.exec(value);
    if (tm) {
      if (!triplet && !roleBits) return null;
      const c = { r: +tm[1], g: +tm[3], b: +tm[4], a: 1 };
      const role = roleBits === 1 ? 'bg' : roleBits === 2 ? 'fg' : roleBits === 4 ? 'border' : guessRole(name, c);
      const out = parseColor(transform(c, role));
      return out ? [Math.round(out.r), Math.round(out.g), Math.round(out.b)].join(tm[2].includes(',') ? ', ' : ' ') : null;
    }
    if (/gradient\(/i.test(value)) return transformValue(value, 'bg');
    if (/^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\()/i.test(value) || /^[a-z]+$/i.test(value)) {
      const c = parseColor(value);
      if (!c) return null;
      let role;
      if (roleBits === 1) role = 'bg';
      else if (roleBits === 2) role = 'fg';
      else if (roleBits === 4) role = 'border';
      else if (roleBits) role = (roleBits & 1) && lightness(c) > 0.5 ? 'bg' : (roleBits & 2) ? 'fg' : 'bg';
      else role = guessRole(name, c);
      return transform(c, role);
    }
    return null;
  }

  function sheetSignature() {
    let sig = '';
    for (const s of document.styleSheets) {
      let n = -1;
      try { n = s.cssRules.length; } catch (e) { /* cross-origin */ }
      sig += (s.href || 'inline') + ':' + n + '|';
    }
    try { sig += 'A' + (document.adoptedStyleSheets || []).length; } catch (e) { /* ignore */ }
    return sig;
  }

  function refreshRules(force) {
    if (!D.active || D.mode !== 'dynamic') return;
    const sig = sheetSignature();
    if (!force && sig === D.lastSheetSig) return;
    D.lastSheetSig = sig;
    D.styleRules.textContent = rewriteSheets();
    keepLast();
    scheduleSweep(document.documentElement);
  }

  // ---------------------------------------------------------------- computed sweep (dynamic)
  const SWEEP_SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT', 'RS-UI', 'BR', 'WBR', 'SOURCE', 'TRACK', 'TITLE']);
  const SVG_SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan', 'g', 'use']);

  // Queue a subtree for the computed-style sweep (null just continues the pending queue).
  function scheduleSweep(root) {
    if (root) D.queue.add(root);
    if (!D.queue.size || D.scheduled) return;
    D.scheduled = true;
    const run = () => { D.scheduled = false; sweep(); };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 300 }); else setTimeout(run, 50);
  }

  function ruleIdFor(decls) {
    const key = decls.join(';');
    let id = D.dynRules.get(key);
    if (id == null) {
      id = D.dynRules.size + 1;
      D.dynRules.set(key, id);
      D.dynCss.push(`[data-rs-dk="${id}"]{${decls.map((d) => d + ' !important').join(';')}}`);
      D.dynDirty = true;
    }
    return id;
  }

  function sweepElement(el) {
    const tag = el.tagName;
    if (SWEEP_SKIP.has(tag)) return false;
    if (el.hasAttribute('data-rs-ui')) return false;
    const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return false;
    const decls = [];
    if (isSvg) {
      const ln = el.localName;
      if (SVG_SHAPES.has(ln)) {
        const fill = parseColor(cs.fill);
        if (fill && fill.a > 0 && lightness(fill) < 0.3 && el.getAttribute('fill') && el.getAttribute('fill') !== 'currentColor') decls.push(`fill:${transform(fill, 'fg')}`);
        const stroke = parseColor(cs.stroke);
        if (stroke && stroke.a > 0 && lightness(stroke) < 0.3 && el.getAttribute('stroke')) decls.push(`stroke:${transform(stroke, 'fg')}`);
      }
    } else {
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.04 && lightness(bg) > 0.42) decls.push(`background-color:${transform(bg, 'bg')}`);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none' && /gradient/i.test(bi) && !/url\(/i.test(bi)) {
        const toks = bi.match(COLOR_TOKEN) || [];
        if (toks.some((t) => { const c = parseColor(t); return c && c.a > 0.1 && lightness(c) > 0.45; })) decls.push(`background-image:${transformValue(bi, 'bg')}`);
      }
      const fg = parseColor(cs.color);
      if (fg && fg.a > 0 && lightness(fg) < 0.55) decls.push(`color:${transform(fg, 'fg')}`);
      const tf = cs.webkitTextFillColor;
      if (tf) { const c = parseColor(tf); if (c && c.a > 0 && lightness(c) < 0.55 && tf !== cs.color) decls.push(`-webkit-text-fill-color:${transform(c, 'fg')}`); }
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') {
          const bc = parseColor(cs[`border${side}Color`]);
          if (bc && bc.a > 0 && lightness(bc) > 0.55) decls.push(`border-${side.toLowerCase()}-color:${transform(bc, 'border')}`);
        }
      }
      if (cs.boxShadow && cs.boxShadow !== 'none' && /rgba?\(\s*(2[0-5]\d|1\d\d)/.test(cs.boxShadow) && lightness(parseColor((cs.boxShadow.match(/rgba?\([^)]*\)/) || [''])[0]) || { r: 0, g: 0, b: 0 }) > 0.7) {
        decls.push('box-shadow:none');
      }
    }
    if (!decls.length) return false;
    el.setAttribute('data-rs-dk', String(ruleIdFor(decls)));
    return true;
  }

  function sweep() {
    if (!D.active || D.mode !== 'dynamic') { D.queue.clear(); return; }
    const roots = Array.from(D.queue);
    D.queue.clear();
    const deadline = performance.now() + 40;
    let count = 0;
    const pending = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(n) { return SWEEP_SKIP.has(n.tagName) || n.hasAttribute('data-rs-ui') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
      });
      let n = root.nodeType === 1 && !SWEEP_SKIP.has(root.tagName) ? root : walker.nextNode();
      while (n) {
        if (!n.hasAttribute('data-rs-dk')) {
          // Flush rules periodically so descendants see their parents' new colors.
          if (D.dynDirty && count % 200 === 0) flushDyn();
          sweepElement(n);
        }
        count++;
        if (count % 300 === 0 && performance.now() > deadline) { pending.push(walker.currentNode); break; }
        n = walker.nextNode();
      }
      if (pending.length) {
        // Continue from where we stopped: re-queue the remaining siblings by queueing the stop node's ancestors' later siblings.
        let cur = pending[pending.length - 1];
        const rest = [];
        while (cur && cur !== root) { let s = cur.nextElementSibling; while (s) { rest.push(s); s = s.nextElementSibling; } cur = cur.parentElement; }
        const stop = pending[pending.length - 1];
        for (const c of stop.children) rest.unshift(c);
        for (const r of rest) D.queue.add(r);
        for (const r of roots.slice(roots.indexOf(root) + 1)) D.queue.add(r);
        break;
      }
    }
    flushDyn();
    if (D.queue.size) scheduleSweep(null);
  }
  function flushDyn() {
    if (!D.dynDirty || !D.styleDyn) return;
    D.styleDyn.textContent = D.dynCss.join('\n');
    D.dynDirty = false;
  }

  function startObservers() {
    stopObservers();
    D.observer = new MutationObserver((muts) => {
      let sheetsChanged = false;
      for (const m of muts) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) { if (m.target && m.target.nodeName === 'STYLE') sheetsChanged = true; continue; }
            if (n.hasAttribute('data-rs-dark') || n.hasAttribute('data-rs-ui')) continue;
            if (n.tagName === 'STYLE' || (n.tagName === 'LINK' && /stylesheet/i.test(n.rel))) {
              sheetsChanged = true;
              if (n.tagName === 'LINK') n.addEventListener('load', () => refreshRules(), { once: true });
            } else if (D.mode === 'dynamic') scheduleSweep(n);
          }
          if (m.target && m.target.nodeName === 'STYLE') sheetsChanged = true;
        } else if (m.type === 'attributes') {
          const el = m.target;
          if (el.hasAttribute && el.hasAttribute('data-rs-ui')) continue;
          if (m.attributeName === 'style' && el.tagName === 'STYLE') continue;
          if (el.hasAttribute('data-rs-dk')) el.removeAttribute('data-rs-dk');
          if (D.mode === 'dynamic') scheduleSweep(el);
        } else if (m.type === 'characterData') {
          if (m.target.parentNode && m.target.parentNode.nodeName === 'STYLE') sheetsChanged = true;
        }
      }
      if (sheetsChanged) { clearTimeout(D.sheetTimer); D.sheetTimer = setTimeout(() => { refreshRules(); keepLast(); }, 120); }
    });
    D.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'], characterData: true });
    // CSS-in-JS libraries insert rules via CSSOM without DOM mutations: poll for a while after load.
    D.pollUntil = Date.now() + 20000;
    D.poll = setInterval(() => {
      if (!D.active) return;
      refreshRules();
      if (Date.now() > D.pollUntil) { clearInterval(D.poll); D.poll = setInterval(() => refreshRules(), 5000); }
    }, 1000);
  }
  function stopObservers() {
    if (D.observer) D.observer.disconnect();
    D.observer = null;
    clearInterval(D.poll);
  }

  // ---------------------------------------------------------------- apply / remove
  function applyTune(dark) {
    tune = {
      brightness: (dark.brightness || 100) / 100,
      contrast: (dark.contrast || 100) / 100,
      sepia: (dark.sepia || 0) / 100,
      grayscale: (dark.grayscale || 0) / 100
    };
    colorCache.clear();
  }

  function enable(mode, dark) {
    applyTune(dark);
    const html = document.documentElement;
    const modeChanged = D.mode !== mode || !D.active;
    D.active = true;
    D.mode = mode;
    if (!D.styleBase) D.styleBase = makeStyle('rs-dark-base');
    if (!D.styleRules) D.styleRules = makeStyle('rs-dark-rules');
    if (!D.styleDyn) D.styleDyn = makeStyle('rs-dark-dyn');
    if (mode === 'filter') {
      html.setAttribute('data-rs-dark-mode', 'filter');
      D.styleBase.textContent = filterCss();
      D.styleRules.textContent = '';
      clearDynamic();
      mountStyles(D.styleBase);
      stopObservers();
    } else {
      html.setAttribute('data-rs-dark-mode', 'dynamic');
      D.styleBase.textContent = baseCss();
      mountStyles(D.styleBase, D.styleRules, D.styleDyn);
      if (modeChanged) startObservers();
      clearDynamic();
      D.lastSheetSig = '';
      refreshRules(true);
      if (document.body) scheduleSweep(document.documentElement);
    }
    keepLast();
  }

  function clearDynamic() {
    for (const el of document.querySelectorAll('[data-rs-dk]')) el.removeAttribute('data-rs-dk');
    D.dynRules.clear();
    D.dynCss = [];
    D.dynDirty = false;
    if (D.styleDyn) D.styleDyn.textContent = '';
  }

  function disable() {
    D.active = false;
    stopObservers();
    clearDynamic();
    document.documentElement.removeAttribute('data-rs-dark-mode');
    for (const s of document.querySelectorAll('style[data-rs-dark]')) s.remove();
    D.styleBase = D.styleRules = D.styleDyn = null;
    D.mode = null;
  }

  // ---------------------------------------------------------------- decision
  let evaluating = null;
  async function evaluate(opts) {
    opts = opts || {};
    await RS.ready;
    const S = globalThis.RS_SETTINGS;
    const settings = RS.settings;
    const siteRule = (RS.sites[RS.siteHost] || {}).dark;
    const decision = S.darkDecision(settings, siteRule, RS.prefersDark());
    let mode = settings.dark.mode === 'filter' ? 'filter' : 'dynamic';
    // In subframes, a top-level filter already inverts us (and counter-inverts iframes): only dynamic mode runs here.
    if (!RS.isTop && mode === 'filter') { if (D.active) disable(); D.reason = 'frame'; return state(); }
    if (decision === 'off') { if (D.active) disable(); D.reason = siteRule === 'off' ? 'site-off' : 'global-off'; return state(); }
    if (decision === 'auto') {
      if (!document.body) {
        // Too early to analyze: paint a dark canvas to avoid a white flash, decide when the DOM is ready.
        preflash();
        return state();
      }
      if (D.alreadyDark === null || opts.reanalyze) D.alreadyDark = detectAlreadyDark();
      if (D.alreadyDark) { if (D.active) disable(); removePreflash(); D.reason = 'already-dark'; return state(); }
    }
    removePreflash();
    D.reason = decision === 'on' && siteRule === 'on' ? 'site-on' : 'global-on';
    enable(mode, settings.dark);
    return state();
  }

  let pre = null;
  function preflash() {
    if (pre || D.active) return;
    pre = makeStyle('rs-dark-pre');
    pre.textContent = 'html{background-color:#181a1b !important}';
    (document.head || document.documentElement).appendChild(pre);
  }
  function removePreflash() { if (pre) { pre.remove(); pre = null; } }

  function state() {
    return { active: D.active, mode: D.mode, alreadyDark: !!D.alreadyDark, reason: D.reason, siteRule: (RS.sites[RS.siteHost] || {}).dark || null };
  }

  function reevaluate(opts) {
    evaluating = (evaluating || Promise.resolve()).then(() => evaluate(opts)).catch((e) => console.warn('[Reading Studio] dark mode', e));
    return evaluating;
  }

  RS.dark = { evaluate: reevaluate, state, disable, parseColor, transform, lightness, detectAlreadyDark };

  RS.handlers['dark-state'] = async () => { await evaluating; return state(); };
  RS.handlers['dark-evaluate'] = async (args) => { await reevaluate({ reanalyze: !!(args && args.reanalyze) }); return state(); };

  RS.onSettings((s, changed) => { if (changed.has('dark') || changed.has('sites')) reevaluate(); });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => reevaluate()); } catch (e) { /* ignore */ }

  // Initial run, then re-check once the DOM and styles are ready (a page may turn out to be dark already).
  reevaluate();
  const onReady = () => reevaluate();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  window.addEventListener('load', () => {
    if (!D.active && D.reason !== 'already-dark') return;
    // Re-verify after all styles loaded (e.g. late stylesheets that make the page dark).
    const settings = RS.settings;
    const siteRule = (RS.sites[RS.siteHost] || {}).dark;
    if (globalThis.RS_SETTINGS.darkDecision(settings, siteRule, RS.prefersDark()) === 'auto') reevaluate({ reanalyze: true });
    else if (D.active && D.mode === 'dynamic') refreshRules(true);
  }, { once: true });
})();
