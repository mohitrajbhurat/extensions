// Small helpers shared by the popup, options and dashboard pages.
import { CATEGORIES } from '../lib/trackers.js';

export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from the background worker');
  if (!res.ok) throw new Error(res.error || 'Request failed');
  return res.result;
}

/** Tiny element builder: h('div', { class: 'x', onclick }, child, 'text'). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const EXTRA_CATEGORIES = {
  learned: { id: 'learned', label: 'Learned', short: 'Learned', description: 'Seen using cookies or storage on several unrelated sites.' },
  custom: { id: 'custom', label: 'Blocked by you', short: 'Custom', description: 'Domains you chose to block everywhere.' },
};

export function categoryInfo(id) {
  return CATEGORIES[id] || EXTRA_CATEGORIES[id] || { id, label: id, short: id };
}

export function categoryColor(id) {
  return `var(--cat-${id}, var(--muted))`;
}

export function formatNumber(n) {
  return new Intl.NumberFormat().format(n || 0);
}

let toastTimer;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

export function switchControl({ id, checked, label, onchange, disabled }) {
  const input = h('input', { type: 'checkbox', id, role: 'switch', 'aria-label': label, disabled });
  input.checked = !!checked;
  if (onchange) input.addEventListener('change', () => onchange(input.checked, input));
  return h('span', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }));
}
