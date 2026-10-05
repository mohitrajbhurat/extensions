// Shared helpers for extension pages (popup, app, invoice).

import * as store from '../lib/store.js';
import { liveSegment } from '../lib/engine.js';
import { autoItems, manualItems, clip } from '../lib/report.js';
import { escapeHtml } from '../lib/util.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

let toastHost;
export function toast(message, { error = false, action = null, timeout = 4000 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

/** Promise-based confirm using a <dialog>. */
export function confirmDialog(message, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><p>${escapeHtml(message)}</p>
      <div class="actions"><button class="btn" value="cancel">Cancel</button>
      <button class="btn ${danger ? 'danger solid' : 'primary'}" value="ok">${escapeHtml(okLabel)}</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    d.showModal();
  });
}

export function projectMap(data) {
  const clients = new Map(data.clients.map((c) => [c.id, c]));
  return new Map(data.projects.map((p) => [p.id, { ...p, client: clients.get(p.clientId) || null }]));
}

export function projectName(id, data) {
  if (!id) return 'No project';
  const p = data.projects.find((x) => x.id === id);
  return p ? p.name : 'Deleted project';
}

export function projectColor(id, data) {
  if (!id) return 'var(--neutral)';
  const p = data.projects.find((x) => x.id === id);
  return (p && p.color) || '#94a3b8';
}

/** <option> list grouped by client. */
export function projectOptions(data, selected = null, { noneLabel = 'No project', includeArchived = false } = {}) {
  const active = data.projects.filter((p) => includeArchived || !p.archived || p.id === selected);
  const byClient = new Map();
  for (const p of active) {
    const k = p.clientId || '';
    if (!byClient.has(k)) byClient.set(k, []);
    byClient.get(k).push(p);
  }
  let html = `<option value="">${escapeHtml(noneLabel)}</option>`;
  const opt = (p) => `<option value="${escapeHtml(p.id)}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.name)}</option>`;
  for (const [cid, list] of byClient) {
    const c = data.clients.find((x) => x.id === cid);
    list.sort((a, b) => a.name.localeCompare(b.name));
    if (c) html += `<optgroup label="${escapeHtml(c.name)}">${list.map(opt).join('')}</optgroup>`;
    else html += list.map(opt).join('');
  }
  return html;
}

export function download(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Load everything for [from, to): data, automatic + manual items (clipped),
 * including the live in-progress segment and running timer.
 */
export async function loadRange(from, to, data = null) {
  data = data || await store.getData();
  const now = Date.now();
  const segs = await store.loadActivity(from, to);
  const live = liveSegment(data.engine, now);
  if (live) segs.push(live);
  const auto = clip(autoItems(segs, data.rules, data.categoryMap), from, to);
  // keep the storage location so items can be reassigned
  const manual = clip(manualItems(data.entries, data.timer, now), from, to);
  return { data, auto, manual, segs };
}

export function parseTags(text) {
  return [...new Set(String(text || '').split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
}

export function faviconFor(domain) {
  // Chrome's local favicon cache (needs the "favicon" permission) is not used;
  // render a letter avatar instead so no network or extra permission is needed.
  const letter = (domain || '?').replace(/^www\./, '').charAt(0).toUpperCase();
  let h = 0;
  for (const c of domain || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="avatar" style="background:hsl(${h} 55% 45%)" aria-hidden="true">${escapeHtml(letter)}</span>`;
}
