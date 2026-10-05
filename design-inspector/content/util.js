/* Small DOM / clipboard / storage helpers shared by the panels. */

export const HOST_ATTR = 'data-design-inspector';

/** Minimal hyperscript. h('div.row', {title:'x'}, 'text', child) */
export function h(spec, props, ...kids) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) {
    for (const token of m[2].match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') el.classList.add(token.slice(1));
      else el.id = token.slice(1);
    }
  }
  if (props && (typeof props !== 'object' || props instanceof Node)) {
    kids.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) append(el, kid);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Copy text; falls back to a hidden textarea when the async API is blocked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function downloadText(filename, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

export function sendMessage(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, res => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

export async function loadState(key, fallback) {
  try {
    const got = await chrome.storage.local.get(key);
    return got && got[key] != null ? got[key] : fallback;
  } catch {
    return fallback;
  }
}

export async function saveState(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {}
}

/** Is this node part of the inspector's own UI? */
export function isOurs(node) {
  for (let n = node; n; n = n.parentNode || (n.host ? n.host : null)) {
    if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(HOST_ATTR)) return true;
  }
  return false;
}

/** Topmost page element under the pointer, skipping our own overlay. */
export function elementAt(x, y) {
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if (!isOurs(el)) return el;
  }
  return null;
}

/** A short, reasonably stable CSS selector for an element. */
export function cssPath(el, maxDepth = 5) {
  if (!el || el.nodeType !== 1) return '';
  if (el === document.documentElement) return 'html';
  if (el === document.body) return 'body';
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < maxDepth) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift('#' + node.id);
      break;
    }
    let part = node.localName;
    const classes = [...node.classList]
      .filter(c => /^[A-Za-z_][\w-]*$/.test(c) && c.length < 32)
      .slice(0, 2);
    if (classes.length) part += '.' + classes.join('.');
    const parent = node.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter(s => s.localName === node.localName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
    depth++;
    if (node === document.body) break;
  }
  return parts.join(' > ');
}

export function tagLabel(el) {
  if (!el || !el.localName) return '';
  let s = el.localName;
  if (el.id) s += '#' + el.id;
  const cls = [...(el.classList || [])].slice(0, 3);
  if (cls.length) s += '.' + cls.join('.');
  if (el.classList && el.classList.length > 3) s += `+${el.classList.length - 3}`;
  return s;
}

export const px = v => (typeof v === 'number' ? `${Math.round(v * 10) / 10}px` : v);
export const num = v => Math.round(parseFloat(v) * 10) / 10 || 0;

export function titleCase(s) {
  return s.replace(/(^|[-_ ])(\w)/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase());
}

/** Short absolute-ish label for a URL. */
export function shortUrl(u, max = 46) {
  try {
    const url = new URL(u, location.href);
    const name = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    return name.length > max ? name.slice(0, max - 1) + '…' : name;
  } catch {
    return u.length > max ? u.slice(0, max - 1) + '…' : u;
  }
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** The first font family in a stack that the browser actually has, best effort. */
export function resolveRenderedFont(stack, sampleText = 'ABCDEFGhijklmn 0123456789') {
  const families = String(stack || '')
    .split(',')
    .map(f => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  if (!families.length) return { used: '', stack: [] };
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);
  let used = '';
  for (const fam of families) {
    if (generic.has(fam.toLowerCase())) {
      used = fam;
      break;
    }
    if (hasFont(fam, sampleText)) {
      used = fam;
      break;
    }
  }
  return { used: used || families[families.length - 1], stack: families };
}

let measureCtx = null;
const fontCache = new Map();

function hasFont(family, sample) {
  const key = family.toLowerCase();
  if (fontCache.has(key)) return fontCache.get(key);
  let ok = false;
  try {
    if (document.fonts && typeof document.fonts.check === 'function') {
      ok = document.fonts.check(`16px "${family.replace(/"/g, '')}"`);
    }
  } catch {}
  if (!ok) ok = measureDiffers(family, sample);
  fontCache.set(key, ok);
  return ok;
}

function measureDiffers(family, sample) {
  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return false;
    const quoted = `"${family.replace(/"/g, '')}"`;
    const widths = ['monospace', 'serif', 'sans-serif'].map(base => {
      measureCtx.font = `72px ${base}`;
      const ref = measureCtx.measureText(sample).width;
      measureCtx.font = `72px ${quoted}, ${base}`;
      return Math.abs(measureCtx.measureText(sample).width - ref) > 0.5;
    });
    return widths.some(Boolean);
  } catch {
    return false;
  }
}
