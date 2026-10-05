// Small UI helpers shared by extension pages.
import './defaults.js';

export const ICONS = {
  note: '<path d="M5 4h10l4 4v12H5V4zm9 1.5V9h3.5L14 5.5zM8 12h8v1.6H8V12zm0 3.2h6v1.6H8v-1.6z"/>',
  camera: '<path d="M9 4h6l1.6 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.4L9 4zm3 4a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21V3z"/>',
  edit: '<path d="m14.06 6.19 3.75 3.75L8.75 19H5v-3.75l9.06-9.06zm1.41-1.41 1.83-1.83a1 1 0 0 1 1.41 0l2.34 2.34a1 1 0 0 1 0 1.41l-1.83 1.83-3.75-3.75z"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 8h12l-1 13H7L6 8zm4 3v7h1.6v-7H10zm2.4 0v7H14v-7h-1.6z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  rewind: '<path d="M11 6 4 12l7 6V6zm9 0-7 6 7 6V6z"/>',
  forward: '<path d="m13 6 7 6-7 6V6zM4 6l7 6-7 6V6z"/>',
  minus: '<path d="M5 11h14v2H5z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  loop: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
  close: '<path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/>',
  library: '<path d="M4 4h4v16H4V4zm6 0h4v16h-4V4zm6.2.6 3.8-1 4 15.5-3.9 1-3.9-15.5z"/>',
  settings: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5-2.2-1.6zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
  download: '<path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3zM4 18h16v2H4z"/>',
  upload: '<path d="M11 16h2V6.8l3.3 3.3 1.4-1.4L12 3 6.3 8.7l1.4 1.4L11 6.8V16zM4 18h16v2H4z"/>',
  external: '<path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H7v10h10v-4h2v6H5V5z"/>',
  search: '<path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/>',
  video: '<path d="M3 5h13a1 1 0 0 1 1 1v3.5l4-3v11l-4-3V18a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  print: '<path d="M7 3h10v4H7V3zM4 8h16a1 1 0 0 1 1 1v7h-4v5H7v-5H3V9a1 1 0 0 1 1-1zm5 8v3h6v-3H9z"/>',
  copy: '<path d="M8 3h11v13h-2V5H8V3zM4 7h11v14H4V7zm2 2v10h7V9H6z"/>',
  panel: '<path d="M3 4h18v16H3V4zm2 2v12h9V6H5zm11 0v12h3V6h-3z"/>',
};

export function icon(name, cls = 'icon-svg') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

let toastHost = null;
export function toast(text, opts = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  let timer = null;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (opts.action) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => { close(); opts.action.run(); });
    el.appendChild(b);
  }
  toastHost.appendChild(el);
  timer = setTimeout(close, opts.ms || (opts.action ? 6000 : 2600));
  return close;
}

let lb = null;
export function lightbox(src, caption) {
  if (!lb) {
    lb = document.createElement('dialog');
    lb.className = 'lightbox';
    lb.innerHTML = '<img alt=""><div class="lb-bar"><a class="btn small" download="frame.jpg">Save image</a><button class="btn small" value="close">Close</button></div>';
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.value === 'close') lb.close(); });
    document.body.appendChild(lb);
  }
  lb.querySelector('img').src = src;
  lb.querySelector('img').alt = caption || 'Screenshot';
  const a = lb.querySelector('a');
  a.href = src;
  a.download = (caption || 'frame').replace(/[^\w.-]+/g, '-') + '.jpg';
  lb.showModal();
}

// Message the content script of a tab (routed through the service worker, which knows
// which frame holds the video).
export async function toTab(tabId, msg) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'vs-relay', tabId, msg });
    return r || { error: 'no-response' };
  } catch (e) {
    return { error: 'no-content-script', message: String(e && e.message || e) };
  }
}

export async function getSettings() {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    return globalThis.VS.normalizeSettings(settings);
  } catch (_) {
    return globalThis.VS.normalizeSettings({});
  }
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.sync.set({ settings: next });
  return globalThis.VS.normalizeSettings(next);
}

export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}
