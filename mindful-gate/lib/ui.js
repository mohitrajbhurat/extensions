// Small DOM helpers shared by extension pages.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer = null;
export function toast(message, isError = false) {
  let el = document.getElementById('mg-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mg-toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4500 : 2500);
}

/** Read the original URL that a redirect rule appended after "u=". */
export function targetFromLocation() {
  const href = location.href;
  const i = href.search(/[?&]u=/);
  if (i < 0) return '';
  let u = href.slice(i + 3);
  if (/^https?%3A/i.test(u)) { try { u = decodeURIComponent(u); } catch { /* keep raw */ } }
  return /^https?:\/\//i.test(u) ? u : '';
}

export function param(name) {
  const m = location.search.slice(1).split('&u=')[0].split('&').map(p => p.split('=')).find(([k]) => k === name);
  return m ? decodeURIComponent(m[1] || '') : '';
}

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
