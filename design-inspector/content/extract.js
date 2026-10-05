/* Page palette & typography extraction, plus token export (CSS variables, DTCG JSON, Tailwind). */
import { h, clear, copyText, downloadText, isOurs, resolveRenderedFont } from './util.js';
import { parseColor, toHex, colorFamily, FAMILY_ORDER, rgbToOklch } from './color.js';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title', 'br', 'wbr', 'source', 'track', 'param']);
const MAX_ELEMENTS = 8000;

/* --------------------------------------------------------------- scan */
function bump(map, key, extra) {
  let e = map.get(key);
  if (!e) {
    e = { key, count: 0 };
    map.set(key, e);
  }
  e.count++;
  if (extra) extra(e);
  return e;
}

function hasOwnText(el) {
  for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
  return false;
}

function isVisible(el) {
  if (typeof el.checkVisibility === 'function') {
    try {
      return el.checkVisibility({ visibilityProperty: true });
    } catch {}
  }
  return el.getClientRects().length > 0;
}

const byCount = (a, b) => b.count - a.count;

/** Walk the page and tally design values. Returns plain data (no DOM references). */
export function scanPage(root = document.body || document.documentElement) {
  const colors = new Map(), fonts = new Map(), sizes = new Map(), weights = new Map(), lineHeights = new Map();
  const styles = new Map(), spacing = new Map(), radii = new Map(), shadows = new Map();
  const fontCache = new Map();
  let seen = 0, truncated = false;

  const addColor = (value, role) => {
    const c = parseColor(value);
    if (!c || c.a === 0) return;
    bump(colors, toHex(c, true), e => {
      e.roles = e.roles || {};
      e.roles[role] = (e.roles[role] || 0) + 1;
    });
  };
  const addSpace = v => {
    const n = Math.round(parseFloat(v) * 2) / 2;
    if (n > 0 && n <= 256) bump(spacing, n);
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (SKIP_TAGS.has(n.localName) || isOurs(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    if (el.nodeType !== 1 || SKIP_TAGS.has(el.localName) || isOurs(el)) continue;
    if (++seen > MAX_ELEMENTS) {
      truncated = true;
      break;
    }
    if (!isVisible(el)) continue;
    const cs = getComputedStyle(el);
    const isSvgShape = el instanceof SVGElement && el.localName !== 'svg';

    // Colors
    addColor(cs.backgroundColor, 'background');
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') {
        addColor(cs[`border${side}Color`], 'border');
        break;
      }
    }
    if (isSvgShape) {
      if (cs.fill && cs.fill !== 'none' && !/^url\(/.test(cs.fill)) addColor(cs.fill, 'svg');
      if (cs.stroke && cs.stroke !== 'none' && !/^url\(/.test(cs.stroke)) addColor(cs.stroke, 'svg');
    }

    // Typography (only for elements that render their own text)
    if (hasOwnText(el)) {
      addColor(cs.color, 'text');
      let font = fontCache.get(cs.fontFamily);
      if (!font) {
        font = resolveRenderedFont(cs.fontFamily);
        fontCache.set(cs.fontFamily, font);
      }
      bump(fonts, font.used, e => { e.stack = e.stack || cs.fontFamily; });
      bump(sizes, cs.fontSize);
      bump(weights, cs.fontWeight);
      if (cs.lineHeight !== 'normal') bump(lineHeights, cs.lineHeight);
      bump(styles, `${font.used}|${cs.fontSize}|${cs.fontWeight}|${cs.lineHeight}`, e => {
        Object.assign(e, { family: font.used, stack: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight });
      });
    }

    // Spacing
    for (const p of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) addSpace(cs[p]);
    if (/flex|grid/.test(cs.display)) {
      if (cs.rowGap !== 'normal') addSpace(cs.rowGap);
      if (cs.columnGap !== 'normal' && cs.columnGap !== cs.rowGap) addSpace(cs.columnGap);
    }
    // Radii & shadows
    if (cs.borderRadius && cs.borderRadius !== '0px') bump(radii, cs.borderRadius);
    if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow);
  }

  const list = m => [...m.values()].sort(byCount);
  return {
    url: location.href,
    elements: Math.min(seen, MAX_ELEMENTS),
    truncated,
    colors: list(colors).map(e => ({ hex: e.key, count: e.count, roles: e.roles })),
    fonts: list(fonts).map(e => ({ family: e.key, stack: e.stack, count: e.count })),
    sizes: list(sizes).map(e => ({ value: e.key, count: e.count })),
    weights: list(weights).map(e => ({ value: e.key, count: e.count })),
    lineHeights: list(lineHeights).map(e => ({ value: e.key, count: e.count })),
    styles: list(styles).map(e => ({ family: e.family, stack: e.stack, size: e.size, weight: e.weight, lineHeight: e.lineHeight, count: e.count })),
    spacing: list(spacing).map(e => ({ px: e.key, count: e.count })),
    radii: list(radii).map(e => ({ value: e.key, count: e.count })),
    shadows: list(shadows).map(e => ({ value: e.key, count: e.count })),
    vars: declaredVariables(),
  };
}

/** Custom properties declared on :root / html in readable (same-origin) stylesheets. */
export function declaredVariables(limit = 300) {
  const names = new Set();
  const visit = rules => {
    for (const rule of rules) {
      if (names.size >= limit) return;
      if (rule.cssRules && !rule.selectorText) {
        try { visit(rule.cssRules); } catch {}
        continue;
      }
      if (!rule.selectorText || !/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) continue;
      for (const prop of rule.style) if (prop.startsWith('--')) names.add(prop);
    }
  };
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules); } catch {}
  }
  const cs = getComputedStyle(document.documentElement);
  return [...names].map(name => ({ name, value: cs.getPropertyValue(name).trim() })).filter(v => v.value);
}

/* ------------------------------------------------------------- tokens */
const slug = s => String(s).toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';

function uniqueNamer() {
  const used = new Set();
  return base => {
    let name = base, i = 2;
    while (used.has(name)) name = `${base}-${i++}`;
    used.add(name);
    return name;
  };
}

const WEIGHT_NAMES = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };

const LIGHTNESS_STEPS = [[50, 0.97], [100, 0.93], [200, 0.88], [300, 0.81], [400, 0.71], [500, 0.62], [600, 0.55], [700, 0.49], [800, 0.42], [900, 0.38], [950, 0.28]];

export function colorTokenName(hex) {
  const c = parseColor(hex);
  if (!c) return 'color';
  const fam = colorFamily(c);
  const alpha = c.a < 1 ? `-a${Math.round(c.a * 100)}` : '';
  if (fam === 'black' || fam === 'white') return fam + alpha;
  // Nearest step on a Tailwind-like OKLCH lightness scale.
  const L = rgbToOklch(c).l;
  let step = 500, best = Infinity;
  for (const [s, l] of LIGHTNESS_STEPS) {
    if (Math.abs(L - l) < best) {
      best = Math.abs(L - l);
      step = s;
    }
  }
  return `${fam === 'transparent' ? 'gray' : fam}-${step}${alpha}`;
}

export function fontStackValue(stack) {
  return String(stack).split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function quoteFamily(f) {
  return /^[a-z-]+$/i.test(f) ? f : `"${f.replace(/"/g, '')}"`;
}

/**
 * Turn scan data into named tokens. Pure: works on plain objects.
 * @returns {{colors, fonts, fontSizes, fontWeights, lineHeights, spacing, radii, shadows}} arrays of {name, value}
 */
export function buildTokens(scan, { maxColors = 24, maxSpacing = 12, maxRadii = 8, maxShadows = 6 } = {}) {
  const colorName = uniqueNamer();
  const colors = scan.colors.slice(0, maxColors)
    .map(c => ({ hex: c.hex, parsed: parseColor(c.hex) }))
    .filter(c => c.parsed)
    .sort((a, b) => FAMILY_ORDER.indexOf(colorFamily(a.parsed)) - FAMILY_ORDER.indexOf(colorFamily(b.parsed)) || rgbToOklch(b.parsed).l - rgbToOklch(a.parsed).l)
    .map(c => ({ name: colorName(colorTokenName(c.hex)), value: c.hex }));

  const fontName = uniqueNamer();
  const fonts = scan.fonts.slice(0, 6).map(f => ({ name: fontName(slug(f.family)), value: fontStackValue(f.stack || f.family) }));

  const px = v => parseFloat(v);
  const sizeVals = [...new Set(scan.sizes.slice(0, 12).map(s => s.value))].filter(v => px(v) > 0).sort((a, b) => px(a) - px(b));
  let baseIdx = 0;
  sizeVals.forEach((v, i) => { if (Math.abs(px(v) - 16) < Math.abs(px(sizeVals[baseIdx]) - 16)) baseIdx = i; });
  const below = ['sm', 'xs', '2xs', '3xs', '4xs', '5xs'];
  const fontSizes = sizeVals.map((v, i) => {
    let name;
    if (i === baseIdx) name = 'base';
    else if (i < baseIdx) name = below[baseIdx - i - 1] || `${baseIdx - i + 1}xs`;
    else name = i - baseIdx === 1 ? 'lg' : i - baseIdx === 2 ? 'xl' : `${i - baseIdx - 1}xl`;
    return { name, value: v };
  });

  const fontWeights = [...new Set(scan.weights.map(w => String(w.value)))]
    .sort((a, b) => Number(a) - Number(b))
    .map(v => ({ name: WEIGHT_NAMES[v] || `w${v}`, value: Number(v) || v }));

  const lineHeights = [...new Set(scan.lineHeights.slice(0, 10).map(l => l.value))]
    .filter(v => /px$/.test(v)).sort((a, b) => px(a) - px(b))
    .map((v, i) => ({ name: String(i + 1), value: v }));

  const spacing = scan.spacing.slice(0, maxSpacing).map(s => s.px).sort((a, b) => a - b)
    .map((v, i) => ({ name: String(i + 1), value: `${v}px` }));

  const radii = scan.radii.slice(0, maxRadii).map(r => r.value)
    .sort((a, b) => px(a) - px(b))
    .map((v, i) => ({ name: px(v) >= 999 || /50%/.test(v) ? 'full' : String(i + 1), value: v }));
  const rn = uniqueNamer();
  radii.forEach(r => { r.name = rn(r.name); });

  const shadows = scan.shadows.slice(0, maxShadows).map((s, i) => ({ name: String(i + 1), value: s.value }));
  return { colors, fonts, fontSizes, fontWeights, lineHeights, spacing, radii, shadows };
}

export function toCssVariables(t, source = '') {
  const lines = [];
  const group = (title, items, prefix, fmt = v => v) => {
    if (!items.length) return;
    lines.push(`  /* ${title} */`);
    for (const it of items) lines.push(`  --${prefix}-${it.name}: ${fmt(it.value)};`);
  };
  group('Colors', t.colors, 'color');
  group('Font families', t.fonts, 'font', v => v.map(quoteFamily).join(', '));
  group('Font sizes', t.fontSizes, 'text');
  group('Font weights', t.fontWeights, 'font-weight');
  group('Line heights', t.lineHeights, 'leading');
  group('Spacing', t.spacing, 'space');
  group('Radii', t.radii, 'radius');
  group('Shadows', t.shadows, 'shadow');
  return `${source ? `/* Extracted by Design Inspector from ${source} */\n` : ''}:root {\n${lines.join('\n')}\n}\n`;
}

/** Design Tokens Community Group (DTCG) format. */
export function toJsonTokens(t) {
  const obj = (items, type, fmt = v => v) => Object.fromEntries(items.map(i => [i.name, { $type: type, $value: fmt(i.value) }]));
  const out = {
    color: obj(t.colors, 'color'),
    fontFamily: obj(t.fonts, 'fontFamily'),
    fontSize: obj(t.fontSizes, 'dimension'),
    fontWeight: obj(t.fontWeights, 'fontWeight'),
    lineHeight: obj(t.lineHeights, 'dimension'),
    spacing: obj(t.spacing, 'dimension'),
    radius: obj(t.radii, 'dimension'),
    shadow: Object.fromEntries(t.shadows.map(s => [s.name, { $type: 'shadow', $value: s.value, $description: 'CSS box-shadow' }])),
  };
  for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
  return JSON.stringify(out, null, 2) + '\n';
}

export function toTailwindConfig(t) {
  const map = (items, fmt = v => v) => Object.fromEntries(items.map(i => [i.name, fmt(i.value)]));
  const extend = {
    colors: map(t.colors),
    fontFamily: map(t.fonts),
    fontSize: map(t.fontSizes),
    fontWeight: map(t.fontWeights, String),
    lineHeight: map(t.lineHeights),
    spacing: Object.fromEntries(t.spacing.map(s => [`ds-${s.name}`, s.value])),
    borderRadius: map(t.radii),
    boxShadow: map(t.shadows),
  };
  for (const k of Object.keys(extend)) if (!Object.keys(extend[k]).length) delete extend[k];
  const body = JSON.stringify({ theme: { extend } }, null, 2)
    .replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:');
  return `/** @type {import('tailwindcss').Config} */\n// Extracted by Design Inspector. Spacing keys are prefixed "ds-" (p-ds-1, gap-ds-2) to avoid clashing with Tailwind's scale.\nmodule.exports = ${body};\n`;
}

/** Guess a spacing grid (8 or 4px) from weighted spacing values. */
export function spacingGrid(spacing) {
  const total = spacing.reduce((s, v) => s + v.count, 0);
  if (!total) return null;
  for (const unit of [8, 4]) {
    const fit = spacing.reduce((s, v) => s + (v.px % unit === 0 ? v.count : 0), 0) / total;
    if (fit >= 0.7) return { unit, fit };
  }
  return null;
}

/* -------------------------------------------------------------- panel */
function bars(items, labelOf, extra) {
  const max = Math.max(1, ...items.map(i => i.count));
  return h('div.bars', items.map(i => {
    const fill = h('div.fill');
    fill.style.width = (i.count / max) * 100 + '%';
    return h('div.barrow', h('div.track', fill, h('div.lbl', extra ? extra(i) : null, labelOf(i))), h('div.cnt', String(i.count)));
  }));
}

const sect = (title, count, ...body) => h('section.sect', h('div.sect-head', title, count != null ? h('span.count', String(count)) : null), h('div.sect-body', ...body));

export function openTokens(app) {
  let scan = null;
  let tab = 'colors';
  let role = 'all';
  let format = 'css';
  let maxColors = 24;

  const tabNames = { colors: 'Colors', type: 'Type', spacing: 'Spacing', effects: 'Effects', export: 'Export' };
  const tabsEl = h('div.tabs', { role: 'tablist' });
  const renderTabs = () => {
    clear(tabsEl);
    for (const [id, label] of Object.entries(tabNames)) {
      tabsEl.append(h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(tab === id), 'data-tab': id,
        onclick: () => { tab = id; renderTabs(); render(); },
      }, label));
    }
  };

  const copy = async (text, msg = 'Copied') => app.toast((await copyText(text)) ? msg : 'Copy failed');

  const renderColors = () => {
    const roles = ['all', 'text', 'background', 'border', 'svg'];
    const sel = h('select', { 'aria-label': 'Filter colors by usage' }, roles.map(r => h('option', { value: r, selected: r === role }, r === 'all' ? 'All usages' : r)));
    sel.addEventListener('change', () => { role = sel.value; render(); });
    const items = scan.colors.filter(c => role === 'all' || (c.roles && c.roles[role]));
    const groups = new Map();
    for (const c of items) {
      const fam = colorFamily(parseColor(c.hex));
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam).push(c);
    }
    const famSections = FAMILY_ORDER.filter(f => groups.has(f)).map(f => {
      const sw = groups.get(f).map(c => {
        const p = parseColor(c.hex);
        const roleText = Object.entries(c.roles || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        const b = h('button.swatch.lg' + (p.a < 1 ? '.alpha' : ''), {
          type: 'button', title: `${c.hex} · used ${c.count}× (${roleText}). Click to copy`, 'aria-label': `${c.hex}, used ${c.count} times`,
          onclick: () => copy(c.hex, `Copied ${c.hex}`),
        });
        const fill = h('span', { style: { position: 'absolute', inset: '0', background: c.hex } });
        const n = h('span.n', { style: { position: 'relative' } }, String(c.count));
        b.append(fill, n);
        return b;
      });
      return h('div', h('div.hint', f), h('div.swatches', sw));
    });
    const vars = scan.vars.filter(v => parseColor(v.value) && !/^-?[\d.]+(px|rem|em|%)?$/.test(v.value));
    return [
      h('div.row.spread', h('span.hint', `${items.length} colors across ${scan.elements} elements${scan.truncated ? ' (first 8000 scanned)' : ''}`), h('div', { style: { width: '140px' } }, sel)),
      famSections.length ? famSections : h('div.empty', 'No colors found.'),
      vars.length ? sect('Declared CSS color variables', vars.length, h('div.list', vars.slice(0, 60).map(v => {
        const chip = h('span.chip-color');
        chip.style.background = v.value;
        return h('div.row.mono', { style: { fontSize: '10.5px' } }, chip, h('span.grow', v.name), h('span.dim', v.value));
      }))) : null,
    ];
  };

  const renderType = () => {
    const fontsList = h('div.list', scan.fonts.map(f => h('div.item',
      h('div.meta',
        h('div.name', { style: { fontFamily: f.stack, fontSize: '16px', fontWeight: '500' } }, f.family),
        h('div.sub', { title: f.stack }, f.stack)),
      h('span.pill', `${f.count}×`))));
    const stylesList = h('div.list', scan.styles.slice(0, 14).map(s => h('button.item', {
      type: 'button', style: { textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' },
      title: 'Copy as CSS',
      onclick: () => copy(`font-family: ${s.stack};\nfont-size: ${s.size};\nfont-weight: ${s.weight};\nline-height: ${s.lineHeight};`, 'Copied type style'),
    }, h('div.meta',
      h('div', { style: { fontFamily: s.stack, fontSize: Math.min(30, parseFloat(s.size) || 14) + 'px', fontWeight: s.weight, lineHeight: '1.25', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, 'The quick brown fox'),
      h('div.sub', `${s.family} · ${s.size}/${s.lineHeight} · ${s.weight}`)),
    h('span.pill', `${s.count}×`))));
    const sizesSorted = [...scan.sizes].sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
    const wSorted = [...scan.weights].sort((a, b) => Number(a.value) - Number(b.value));
    return [
      sect('Font families', scan.fonts.length, scan.fonts.length ? fontsList : h('div.empty', 'No text found.')),
      sect('Type styles', scan.styles.length, stylesList),
      sect('Font sizes', scan.sizes.length, bars(sizesSorted, i => i.value)),
      sect('Font weights', scan.weights.length, bars(wSorted, i => `${i.value} ${WEIGHT_NAMES[i.value] || ''}`)),
      sect('Line heights', scan.lineHeights.length, bars(scan.lineHeights.slice(0, 16), i => i.value)),
    ];
  };

  const renderSpacing = () => {
    const grid = spacingGrid(scan.spacing);
    const sorted = [...scan.spacing].slice(0, 30).sort((a, b) => a.px - b.px);
    return [
      h('div.hint', grid ? `Looks like a ${grid.unit}px grid: ${Math.round(grid.fit * 100)}% of margins, paddings and gaps are multiples of ${grid.unit}.` : 'No consistent 4px or 8px grid detected.'),
      sect('Margins, paddings & gaps', scan.spacing.length, scan.spacing.length ? bars(sorted, i => `${i.px}px`, i => {
        const b = h('span', { style: { display: 'inline-block', width: Math.min(120, i.px) + 'px', height: '6px', background: '#e11d8f', marginRight: '6px', verticalAlign: 'middle', borderRadius: '2px' } });
        return b;
      }) : h('div.empty', 'No spacing found.')),
    ];
  };

  const renderEffects = () => [
    sect('Border radii', scan.radii.length, scan.radii.length ? h('div.list', scan.radii.slice(0, 20).map(r => h('button.item', {
      type: 'button', style: { cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left' }, title: 'Copy',
      onclick: () => copy(`border-radius: ${r.value};`),
    }, h('span', { style: { width: '36px', height: '28px', border: '2px solid var(--di-accent)', borderRadius: r.value, flex: '0 0 auto' } }),
    h('div.meta', h('div.name.mono', r.value)), h('span.pill', `${r.count}×`)))) : h('div.empty', 'No rounded corners found.')),
    sect('Shadows', scan.shadows.length, scan.shadows.length ? h('div.list', scan.shadows.slice(0, 20).map(s => h('button.item', {
      type: 'button', style: { cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left' }, title: 'Copy',
      onclick: () => copy(`box-shadow: ${s.value};`),
    }, h('span', { style: { width: '36px', height: '28px', background: '#fff', borderRadius: '6px', boxShadow: s.value, flex: '0 0 auto', margin: '6px' } }),
    h('div.meta', h('div.sub', { title: s.value, style: { whiteSpace: 'normal' } }, s.value)), h('span.pill', `${s.count}×`)))) : h('div.empty', 'No box shadows found.')),
  ];

  const exportText = () => {
    const tokens = buildTokens(scan, { maxColors });
    if (format === 'json') return toJsonTokens(tokens);
    if (format === 'tailwind') return toTailwindConfig(tokens);
    return toCssVariables(tokens, location.host);
  };
  const renderExport = () => {
    const fmt = h('select', { 'aria-label': 'Export format' },
      h('option', { value: 'css', selected: format === 'css' }, 'CSS variables'),
      h('option', { value: 'json', selected: format === 'json' }, 'JSON design tokens (DTCG)'),
      h('option', { value: 'tailwind', selected: format === 'tailwind' }, 'Tailwind config'));
    const maxIn = h('input', { type: 'number', min: '1', max: '200', value: String(maxColors), 'aria-label': 'Maximum colors' });
    const out = h('textarea', { readonly: true, 'aria-label': 'Exported tokens', rows: '16', spellcheck: 'false' });
    out.style.minHeight = '260px';
    const refresh = () => { out.value = exportText(); };
    fmt.addEventListener('change', () => { format = fmt.value; refresh(); });
    maxIn.addEventListener('change', () => { maxColors = Math.max(1, Math.min(200, parseInt(maxIn.value, 10) || 24)); refresh(); });
    refresh();
    const ext = { css: ['tokens.css', 'text/css'], json: ['tokens.json', 'application/json'], tailwind: ['tailwind.config.js', 'text/javascript'] };
    return [
      h('div.row', h('label.field.grow', 'Format', fmt), h('label.field', { style: { width: '96px' } }, 'Max colors', maxIn)),
      out,
      h('div.row.tight',
        h('button.btn.primary', { type: 'button', onclick: () => copy(out.value, 'Tokens copied') }, 'Copy'),
        h('button.btn', { type: 'button', onclick: () => downloadText(`${slug(location.host || 'page')}-${ext[format][0]}`, out.value, ext[format][1]) }, 'Download')),
    ];
  };

  const render = () => {
    if (!scan) return;
    const fn = { colors: renderColors, type: renderType, spacing: renderSpacing, effects: renderEffects, export: renderExport }[tab];
    app.setPanelBody(...fn().flat().filter(Boolean));
  };

  const rescan = () => {
    app.setPanelBody(h('div.empty', 'Scanning page…'));
    setTimeout(() => {
      try {
        scan = scanPage();
      } catch (e) {
        app.setPanelBody(h('div.empty', 'Scan failed: ' + (e && e.message)));
        return;
      }
      render();
    }, 30);
  };

  renderTabs();
  app.showPanel('tokens', {
    title: 'Palette & type', wide: true, tabs: tabsEl,
    body: [h('div.empty', 'Scanning page…')],
    foot: [h('button.btn', { type: 'button', onclick: rescan, title: 'Scan the page again' }, 'Rescan')],
  });
  rescan();
}
