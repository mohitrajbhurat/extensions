/* Inspect mode: hover box-model overlay + tooltip, click to pin a card with grouped CSS. */
import { h, clear, elementAt, tagLabel, cssPath, copyText, num, resolveRenderedFont } from './util.js';
import { parseColor, toHex, contrastRatio, wcag, flatten, formatsOf } from './color.js';
import { drawDistances } from './measure.js';
import { openColors } from './eyedropper.js';

/* ------------------------------------------------------------ box model */
function sides(cs, prefix, suffix = '') {
  return ['top', 'right', 'bottom', 'left'].map(s => parseFloat(cs.getPropertyValue(`${prefix}-${s}${suffix}`)) || 0);
}

/** Box model numbers for an element (viewport coordinates). */
export function boxModel(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const m = sides(cs, 'margin');
  const b = sides(cs, 'border', '-width');
  const p = sides(cs, 'padding');
  return { rect: r, margin: m, border: b, padding: p, cs };
}

function ring(cls, left, top, width, height, widths) {
  const d = h('div.box.' + cls);
  const [t, r, b, l] = widths.map(v => Math.max(0, v));
  Object.assign(d.style, {
    left: left + 'px', top: top + 'px', width: Math.max(0, width) + 'px', height: Math.max(0, height) + 'px',
    borderStyle: 'solid', borderColor: 'inherit', boxSizing: 'border-box', background: 'none',
    borderWidth: `${t}px ${r}px ${b}px ${l}px`,
  });
  return d;
}

const RING_COLORS = {
  'box-margin': 'rgba(246, 183, 60, .38)',
  'box-border': 'rgba(255, 221, 153, .6)',
  'box-padding': 'rgba(130, 212, 167, .45)',
};

/** Draw margin / border / padding / content boxes for el into layer. */
export function drawBox(layer, el, { labels = true, size = true } = {}) {
  if (!el || !el.isConnected) return null;
  const bm = boxModel(el);
  const { rect: r, margin: m, border: b, padding: p } = bm;
  const mPos = m.map(v => Math.max(0, v));
  const frag = document.createDocumentFragment();
  const add = (cls, left, top, width, height, widths) => {
    const d = ring(cls, left, top, width, height, widths);
    d.style.borderColor = RING_COLORS[cls];
    frag.append(d);
  };
  add('box-margin', r.left - mPos[3], r.top - mPos[0], r.width + mPos[1] + mPos[3], r.height + mPos[0] + mPos[2], mPos);
  add('box-border', r.left, r.top, r.width, r.height, b);
  add('box-padding', r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2], p);
  const content = h('div.box.box-content');
  const cw = r.width - b[1] - b[3] - p[1] - p[3];
  const ch = r.height - b[0] - b[2] - p[0] - p[2];
  Object.assign(content.style, {
    left: r.left + b[3] + p[3] + 'px', top: r.top + b[0] + p[0] + 'px',
    width: Math.max(0, cw) + 'px', height: Math.max(0, ch) + 'px',
  });
  frag.append(content);
  if (labels) {
    const lab = (text, x, y) => {
      const d = h('div.boxlabel', text);
      d.style.left = x + 'px';
      d.style.top = y + 'px';
      frag.append(d);
    };
    // Margin and padding numbers, only where there is room.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (m[0] >= 10) lab(num(m[0]), cx, r.top - m[0] / 2);
    if (m[2] >= 10) lab(num(m[2]), cx, r.bottom + m[2] / 2);
    if (m[3] >= 18) lab(num(m[3]), r.left - m[3] / 2, cy);
    if (m[1] >= 18) lab(num(m[1]), r.right + m[1] / 2, cy);
    if (p[0] >= 10) lab(num(p[0]), cx, r.top + b[0] + p[0] / 2);
    if (p[2] >= 10) lab(num(p[2]), cx, r.bottom - b[2] - p[2] / 2);
    if (p[3] >= 18) lab(num(p[3]), r.left + b[3] + p[3] / 2, cy);
    if (p[1] >= 18) lab(num(p[1]), r.right - b[1] - p[1] / 2, cy);
  }
  if (size) {
    const s = h('div.boxlabel', `${num(r.width)} × ${num(r.height)}`);
    s.style.background = '#6d28d9';
    s.style.color = '#fff';
    s.style.left = r.left + r.width / 2 + 'px';
    const above = r.top - Math.max(0, m[0]) - 10;
    s.style.top = (above > 8 ? above : r.bottom + Math.max(0, m[2]) + 10) + 'px';
    frag.append(s);
  }
  layer.append(frag);
  return bm;
}

export function outlineBox(layer, el, cls = 'box-outline') {
  if (!el || !el.isConnected) return;
  const r = el.getBoundingClientRect();
  const d = h('div.box.' + cls);
  Object.assign(d.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  layer.append(d);
}

/* -------------------------------------------------------- color helpers */
/** Composite the backgrounds of el and its ancestors to an opaque color. */
export function effectiveBackground(el) {
  const stack = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    const c = parseColor(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) {
      stack.push(c);
      if (c.a >= 1) break;
    }
  }
  let out = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = stack.length - 1; i >= 0; i--) out = flatten(stack[i], out);
  return out;
}

/* ------------------------------------------------------- style capture */
const DEFAULTS = new Set(['none', 'normal', 'auto', '0px', 'static', 'visible', 'rgba(0, 0, 0, 0)', 'baseline', 'start', 'stretch', 'nowrap', 'row', '0s', 'all', 'ease']);

function compressBox(vals) {
  const [t, r, b, l] = vals;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

function boxShorthand(cs, prefix, suffix = '') {
  const v = ['top', 'right', 'bottom', 'left'].map(s => cs.getPropertyValue(`${prefix}-${s}${suffix}`));
  if (v.every(x => x === '0px')) return null;
  return compressBox(v);
}

function borderShorthand(cs) {
  const sideVals = ['top', 'right', 'bottom', 'left'].map(s => {
    const w = cs.getPropertyValue(`border-${s}-width`);
    const st = cs.getPropertyValue(`border-${s}-style`);
    const c = cs.getPropertyValue(`border-${s}-color`);
    if (st === 'none' || w === '0px') return null;
    const hc = parseColor(c);
    return `${w} ${st} ${hc ? toHex(hc, true) : c}`;
  });
  if (sideVals.every(v => v == null)) return [];
  if (sideVals.every(v => v === sideVals[0])) return [['border', sideVals[0]]];
  const out = [];
  ['top', 'right', 'bottom', 'left'].forEach((s, i) => { if (sideVals[i]) out.push([`border-${s}`, sideVals[i]]); });
  return out;
}

function colorValue(v) {
  const c = parseColor(v);
  if (!c || c.a === 0) return v;
  return toHex(c, true);
}

/** Grouped, non-default computed styles. [{name, props: [[prop, value]]}] */
export function collectStyles(el) {
  const cs = getComputedStyle(el);
  const get = p => cs.getPropertyValue(p);
  const keep = (list, prop, value = get(prop)) => {
    if (value == null || value === '' || DEFAULTS.has(value)) return;
    list.push([prop, value]);
  };
  const r = el.getBoundingClientRect();

  const layout = [];
  keep(layout, 'display');
  keep(layout, 'position');
  if (get('position') !== 'static') ['top', 'right', 'bottom', 'left'].forEach(p => keep(layout, p));
  keep(layout, 'z-index');
  layout.push(['width', `${num(r.width)}px`], ['height', `${num(r.height)}px`]);
  keep(layout, 'max-width');
  keep(layout, 'min-height', get('min-height') === '0px' ? null : get('min-height'));
  const margin = boxShorthand(cs, 'margin');
  if (margin) layout.push(['margin', margin]);
  const padding = boxShorthand(cs, 'padding');
  if (padding) layout.push(['padding', padding]);
  const disp = get('display');
  if (/flex/.test(disp)) {
    keep(layout, 'flex-direction');
    keep(layout, 'flex-wrap');
    keep(layout, 'justify-content');
    keep(layout, 'align-items');
  }
  if (/grid/.test(disp)) {
    keep(layout, 'grid-template-columns');
    keep(layout, 'grid-template-rows');
    keep(layout, 'justify-items');
    keep(layout, 'align-items');
  }
  if (/flex|grid/.test(disp)) {
    const rg = get('row-gap'), cg = get('column-gap');
    if (rg !== 'normal' || cg !== 'normal') layout.push(['gap', rg === cg ? rg : `${rg} ${cg}`]);
  }
  const parentDisp = el.parentElement ? getComputedStyle(el.parentElement).display : '';
  if (/flex/.test(parentDisp)) {
    const f = `${get('flex-grow')} ${get('flex-shrink')} ${get('flex-basis')}`;
    if (f !== '0 1 auto') layout.push(['flex', f]);
    keep(layout, 'align-self');
  }
  keep(layout, 'overflow');
  keep(layout, 'float');

  const type = [];
  type.push(['font-family', get('font-family')]);
  type.push(['font-size', get('font-size')]);
  type.push(['font-weight', get('font-weight')]);
  type.push(['line-height', get('line-height')]);
  keep(type, 'letter-spacing');
  keep(type, 'font-style');
  keep(type, 'text-transform');
  keep(type, 'text-align', /^(start|left)$/.test(get('text-align')) ? null : get('text-align'));
  keep(type, 'text-decoration-line');
  keep(type, 'white-space', get('white-space') === 'normal' ? null : get('white-space'));
  type.push(['color', colorValue(get('color'))]);

  const bg = [];
  keep(bg, 'background-color', colorValue(get('background-color')));
  keep(bg, 'background-image');
  for (const pair of borderShorthand(cs)) bg.push(pair);
  const radius = compressBox(['top-left', 'top-right', 'bottom-right', 'bottom-left'].map(c => get(`border-${c}-radius`)));
  if (radius !== '0px') bg.push(['border-radius', radius]);
  if (get('outline-style') !== 'none' && get('outline-width') !== '0px') bg.push(['outline', `${get('outline-width')} ${get('outline-style')} ${colorValue(get('outline-color'))}`]);

  const fx = [];
  keep(fx, 'box-shadow');
  keep(fx, 'text-shadow');
  keep(fx, 'opacity', get('opacity') === '1' ? null : get('opacity'));
  keep(fx, 'transform');
  keep(fx, 'filter');
  keep(fx, 'backdrop-filter');
  keep(fx, 'mix-blend-mode');
  keep(fx, 'transition', /^all 0s ease 0s$/.test(get('transition')) ? null : get('transition'));
  keep(fx, 'cursor', /^(auto|default)$/.test(get('cursor')) ? null : get('cursor'));

  return [
    { name: 'Layout & box', props: layout },
    { name: 'Typography', props: type },
    { name: 'Background & border', props: bg },
    { name: 'Effects', props: fx },
  ].filter(g => g.props.length);
}

export function cssText(selector, groups) {
  const lines = [];
  for (const g of groups) {
    lines.push(`  /* ${g.name} */`);
    for (const [p, v] of g.props) lines.push(`  ${p}: ${v};`);
  }
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/* ------------------------------------------------------------- tooltip */
export function typeInfo(el) {
  const cs = getComputedStyle(el);
  const font = resolveRenderedFont(cs.fontFamily);
  return {
    family: font.used,
    stack: font.stack,
    size: cs.fontSize,
    weight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    color: parseColor(cs.color),
    bg: parseColor(cs.backgroundColor),
  };
}

function swatchChip(c) {
  const s = h('span.chip-color');
  if (c) s.style.background = toHex(c, true);
  return s;
}

function renderTip(layer, el, x, y) {
  const t = typeInfo(el);
  const r = el.getBoundingClientRect();
  const effBg = effectiveBackground(el);
  const ratio = t.color ? contrastRatio(flatten(t.color, effBg), effBg) : 0;
  const grid = h('div.tip-grid',
    h('b', 'Size'), h('span', `${num(r.width)} × ${num(r.height)}`),
    h('b', 'Font'), h('span', t.family || '–'),
    h('b', 'Type'), h('span', `${t.size} / ${t.lineHeight} · ${t.weight}`),
    h('b', 'Color'), h('span', swatchChip(t.color), t.color ? toHex(t.color, true) : '–', ratio ? `  ${ratio.toFixed(2)}:1` : ''),
    t.bg && t.bg.a > 0 ? [h('b', 'Bg'), h('span', swatchChip(t.bg), toHex(t.bg, true))] : null,
  );
  const tip = h('div.tip', h('div.tip-tag', tagLabel(el)), grid, h('div.tip-dim', 'Click to pin · hold Alt to measure'));
  layer.append(tip);
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 16, top = y + 18;
  if (left + tw > innerWidth - 8) left = Math.max(8, x - tw - 16);
  if (top + th > innerHeight - 8) top = Math.max(8, y - th - 16);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

/* -------------------------------------------------------------- pin card */
function copyBtn(app, label, getText, title) {
  return h('button.btn', {
    type: 'button', title: title || `Copy ${label}`,
    onclick: async () => {
      const ok = await copyText(typeof getText === 'function' ? getText() : getText);
      app.toast(ok ? 'Copied' : 'Copy failed');
    },
  }, label);
}

function renderCard(app, el, state) {
  const groups = collectStyles(el);
  const selector = cssPath(el);
  const t = typeInfo(el);
  const effBg = effectiveBackground(el);
  const fg = t.color ? flatten(t.color, effBg) : null;
  const ratio = fg ? contrastRatio(fg, effBg) : 0;
  const verdict = wcag(ratio);
  const bodyKids = [];

  bodyKids.push(h('div.mono.dim', { title: selector }, selector));
  const nav = h('div.row.tight',
    h('button.btn', { type: 'button', title: 'Select parent element', disabled: !el.parentElement || el.parentElement === document.documentElement, onclick: () => state.pin(el.parentElement) }, '↑ Parent'),
    h('button.btn', { type: 'button', title: 'Select first child element', disabled: !el.firstElementChild, onclick: () => state.pin(el.firstElementChild) }, '↓ Child'),
    h('button.btn', { type: 'button', title: 'Previous sibling', disabled: !el.previousElementSibling, onclick: () => state.pin(el.previousElementSibling) }, '←'),
    h('button.btn', { type: 'button', title: 'Next sibling', disabled: !el.nextElementSibling, onclick: () => state.pin(el.nextElementSibling) }, '→'),
    h('button.btn', { type: 'button', title: 'Live edit this element', onclick: () => { app.setMode('edit'); app.modes.edit.select(el); } }, 'Edit'),
  );
  bodyKids.push(nav);

  // Type summary
  const fontSample = h('div', { style: { fontFamily: getComputedStyle(el).fontFamily, fontSize: '20px', lineHeight: '1.2', fontWeight: t.weight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, 'Aa Bb Cc 123');
  const typeSect = h('details.sect', { open: true },
    h('summary', 'Font'),
    h('div.sect-body',
      fontSample,
      h('dl.kv',
        h('dt', 'Rendered'), h('dd', t.family || '–'),
        h('dt', 'Stack'), h('dd', t.stack.join(', ') || '–'),
        h('dt', 'Size / line'), h('dd', `${t.size} / ${t.lineHeight}`),
        h('dt', 'Weight'), h('dd', t.weight),
      )));
  bodyKids.push(typeSect);

  // Colors + contrast
  if (t.color) {
    const pill = (label, ok) => h('span.pill.' + (ok ? 'ok' : 'bad'), (ok ? '✓ ' : '✕ ') + label);
    const colorRows = [];
    const addColor = (label, c) => {
      if (!c || c.a === 0) return;
      const f = formatsOf(c);
      const sw = h('span.chip-color');
      sw.style.background = f.hex;
      colorRows.push(h('dt', label), h('dd', h('button.btn.ghost', {
        type: 'button', title: 'Open in color tools', onclick: () => openColors(app, { pick: f.hex }),
      }, sw, f.hex)));
    };
    const cs = getComputedStyle(el);
    addColor('Text', t.color);
    addColor('Background', parseColor(cs.backgroundColor));
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') addColor('Border', parseColor(cs.borderTopColor));
    const effHex = toHex(effBg);
    bodyKids.push(h('details.sect', { open: true },
      h('summary', 'Colors & contrast'),
      h('div.sect-body',
        h('dl.kv', colorRows, h('dt', 'Effective bg'), h('dd', effHex)),
        h('div.row',
          h('span.bigratio', `${ratio.toFixed(2)}:1`),
          pill('AA', verdict.normalAA), pill('AAA', verdict.normalAAA), pill('AA large', verdict.largeAA)),
        h('div.row', h('button.btn', {
          type: 'button', onclick: () => openColors(app, { fg: toHex(t.color, true), bg: effHex }),
        }, 'Open in contrast checker')),
      )));
  }

  // Grouped CSS
  for (const g of groups) {
    const dl = h('dl.kv');
    for (const [p, v] of g.props) {
      const c = /color$/.test(p) ? parseColor(v) : null;
      dl.append(h('dt', p), h('dd', c && c.a > 0 ? swatchChip(c) : null, v));
    }
    bodyKids.push(h('details.sect', { open: g.name !== 'Effects' || g.props.length < 4 },
      h('summary', g.name, h('span.count', String(g.props.length))),
      h('div.sect-body', dl)));
  }

  const foot = [
    copyBtn(app, 'Copy CSS', () => cssText(selector, collectStyles(el))),
    copyBtn(app, 'Copy selector', selector),
    h('button.btn.ghost', { type: 'button', title: 'Unpin (Esc)', onclick: () => state.unpin() }, 'Unpin'),
  ];
  app.showPanel('inspect', {
    title: 'Element', sub: tagLabel(el), body: bodyKids, foot,
    onClose: replacing => { if (!replacing) state.unpin(true); },
  });
}

/* ---------------------------------------------------------------- mode */
export function createInspect(app) {
  let hover = null;
  let pinned = null;
  const layer = () => app.layer('inspect');

  const state = {
    pin(el) {
      if (!el || el.nodeType !== 1) return;
      pinned = el;
      renderCard(app, el, state);
      app.requestRedraw();
    },
    unpin(fromPanel = false) {
      pinned = null;
      if (!fromPanel && app.panelOwner === 'inspect') app.closePanel();
      app.requestRedraw();
    },
  };

  return {
    name: 'inspect',
    get pinned() { return pinned; },
    enter() {
      hover = null;
    },
    exit() {
      hover = null;
      clear(layer());
      if (app.panelOwner === 'inspect') app.closePanel();
      pinned = null;
    },
    onMove(e) {
      const el = elementAt(e.clientX, e.clientY);
      if (el !== hover || app.alt) {
        hover = el;
      }
      app.requestRedraw();
    },
    onLeave() {
      if (hover) {
        hover = null;
        app.requestRedraw();
      }
    },
    onAlt() {
      app.requestRedraw();
    },
    onClick(e) {
      const el = elementAt(e.clientX, e.clientY);
      if (el) state.pin(el);
    },
    onEscape() {
      if (pinned) {
        state.unpin();
        return true;
      }
      return false;
    },
    redraw(active) {
      const l = clear(layer());
      if (!active) return;
      if (pinned && !pinned.isConnected) state.unpin();
      if (pinned) outlineBox(l, pinned, 'box-sec');
      if (!hover || !hover.isConnected) return;
      if (app.alt) {
        const anchor = pinned && pinned !== hover ? pinned : hover.parentElement;
        if (anchor && anchor !== document.documentElement) {
          outlineBox(l, hover);
          outlineBox(l, anchor, 'box-sec');
          drawDistances(l, anchor.getBoundingClientRect(), hover.getBoundingClientRect());
          return;
        }
      }
      drawBox(l, hover);
      renderTip(l, hover, app.mouse.x, app.mouse.y);
    },
  };
}
