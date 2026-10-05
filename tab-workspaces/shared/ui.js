// Small DOM helpers shared by the popup and the dashboard.
import { COLOR_HEX, GROUP_COLORS, faviconFor } from '../lib/util.js';

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  pin: '<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  tabs: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6V4h8v2"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h8V4M8 20v-6h8v6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  wand: '<path d="m4 20 11-11M14 4v3M18 6h3M17 10l2 2M12 3l1 1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
};

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = ICONS[name] || '';
  return s;
}

/** Hyperscript: h('div.card#id', {onclick, title}, children...) */
export function h(sel, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    if (props != null) children.unshift(props);
    props = {};
  }
  const m = sel.match(/^([a-z0-9-]+)?(.*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && !k.startsWith('aria') && k !== 'list' && k !== 'role') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }

export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error || 'Something went wrong');
  return res.result;
}

const GLOBE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a93a0" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>');

export function fav(url) {
  const img = h('img.fav', { alt: '', width: 16, height: 16, loading: 'lazy', decoding: 'async' });
  img.src = /^(https?|file):/.test(url || '') ? faviconFor(url) || GLOBE : GLOBE;
  img.addEventListener('error', () => { img.src = GLOBE; }, { once: true });
  return img;
}

let toastHost;
export function toast(message, { action, onAction, error = false, timeout = 4000 } = {}) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div.toast' + (error ? '.error' : ''), h('span', message));
  if (action) t.append(h('button', { type: 'button', onclick: () => { t.remove(); onAction?.(); } }, action));
  toastHost.append(t);
  setTimeout(() => t.remove(), timeout);
}

/** Run an async action, reporting errors as a toast. */
export async function act(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
    return r;
  } catch (e) {
    toast(e.message || String(e), { error: true });
    throw e;
  }
}

export function swatchPicker(value, onChange) {
  const wrap = h('div.swatches', { role: 'radiogroup', 'aria-label': 'Color' });
  const btns = GROUP_COLORS.map(c => {
    const b = h('button.swatch', {
      type: 'button', role: 'radio', 'aria-label': c, title: c, 'aria-checked': String(c === value),
      style: { background: COLOR_HEX[c] },
      onclick: () => { value = c; btns.forEach(x => x.setAttribute('aria-checked', String(x === b))); onChange?.(c); },
    });
    return b;
  });
  wrap.append(...btns);
  wrap.getValue = () => value;
  return wrap;
}

/** Modal dialog. fields: [{name, label, type:'text'|'color'|'select'|'textarea', value, options}] */
export function dialog({ title, message, fields = [], okLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const controls = {};
    const body = fields.map(f => {
      let ctl;
      if (f.type === 'color') ctl = swatchPicker(f.value || 'blue');
      else if (f.type === 'select') ctl = h('select.input', {}, f.options.map(o => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      else if (f.type === 'textarea') ctl = h('textarea.input', { rows: f.rows || 8, placeholder: f.placeholder || '', value: f.value || '' });
      else ctl = h('input.input', { type: 'text', value: f.value || '', placeholder: f.placeholder || '', maxLength: f.maxLength || 120, required: !!f.required });
      controls[f.name] = ctl;
      return h('label.field', h('span', f.label), ctl);
    });
    const dlg = h('dialog.modal', h('form', { method: 'dialog' },
      h('h2', title),
      message ? h('p.muted', message) : null,
      body,
      h('div.row',
        h('button.btn', { type: 'button', value: 'cancel', onclick: () => dlg.close('cancel') }, cancelLabel),
        h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'submit', value: 'ok' }, okLabel)),
    ));
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const values = {};
      for (const [k, c] of Object.entries(controls)) values[k] = c.getValue ? c.getValue() : c.value;
      dlg.remove();
      resolve(ok ? values : null);
    });
    dlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); dlg.close('ok'); });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, textarea, select');
    if (first) { first.focus(); first.select?.(); }
  });
}

export const confirmDialog = (title, message, okLabel = 'Delete') => dialog({ title, message, okLabel, danger: true }).then(Boolean);

export async function currentWindowId() {
  try { return (await chrome.windows.getCurrent()).id; } catch { return undefined; }
}

export function colorDot(color) { return h('span.dot', { style: { background: COLOR_HEX[color] || color || '#888' } }); }
