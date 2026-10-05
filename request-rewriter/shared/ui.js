// Tiny DOM helpers shared by the popup and the editor. No framework, no build step.
import { getSettings, onSettingsChanged } from '../lib/store.js';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list' && k !== 'type' && k !== 'size') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function toast(message, kind = '') {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
  t.textContent = message;
  t.className = `toast show ${kind}`;
  t.setAttribute('role', 'status');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 2400);
}

export async function applyTheme() {
  const apply = s => {
    document.documentElement.dataset.theme = s.theme === 'system' ? '' : s.theme;
    if (s.theme === 'system') delete document.documentElement.dataset.theme;
  };
  apply(await getSettings());
  onSettingsChanged(apply);
}

export function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function send(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, res => { void chrome.runtime.lastError; resolve(res || {}); });
    } catch { resolve({}); }
  });
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept = 'application/json,.json') {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept, class: 'hidden' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function confirmDialog(message) { return Promise.resolve(window.confirm(message)); }
