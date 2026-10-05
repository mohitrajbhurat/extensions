/* JSON viewer for raw JSON documents. Classic content script; relies on lib/jsontree.js (AWJsonTree).
   Runs automatically on granted sites (registered by the service worker) or on demand via the
   "Format JSON on this page" action menu / shortcut, which sets globalThis.__awForce first. */
(function () {
  'use strict';
  const forced = !!globalThis.__awForce;
  globalThis.__awForce = false;
  if (document.getElementById('aw-jv')) {
    if (forced) document.getElementById('aw-jv').querySelector('input[type=search]')?.focus();
    return;
  }
  if (!document.body || !globalThis.AWJsonTree) return;

  const MAX = 40 * 1024 * 1024;
  const ct = (document.contentType || '').toLowerCase();
  const jsonType = /[/+]json\b/.test(ct) || ct === 'application/json';
  const plainType = ct === 'text/plain';
  const body = document.body;
  const pre = body.querySelector(':scope > pre');
  // A raw document is the browser's plain-text rendering: one <pre> (Chrome may add its own formatter container).
  const raw = pre && [...body.children].every(c => c === pre || c.classList.contains('json-formatter-container'));
  if (!forced) {
    if (!(jsonType || plainType) || !raw) return;
  }
  const text = raw ? pre.textContent : body.innerText;
  if (!text || text.length > MAX) { if (forced) note(text ? 'This document is too large to format.' : 'This page is empty.'); return; }
  const trimmed = text.replace(/^﻿/, '').replace(/^\)\]\}',?\s*/, '').replace(/^while\s*\(1\);\s*/, '').trim();
  if (!forced && !jsonType && !/^[[{]/.test(trimmed)) return;
  let data;
  try { data = JSON.parse(trimmed); }
  catch (e) { if (forced) note('This page is not valid JSON: ' + e.message); return; }
  if (!forced && (data === null || typeof data !== 'object')) return; // bare scalars are not worth a viewer

  if (!forced) {
    try { chrome.runtime.sendMessage({ type: 'aw-viewer-css' }).catch(() => {}); } catch { /* extension reloaded */ }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function note(msg) {
    const n = el('div', 'aw-jv-note', msg);
    n.setAttribute('role', 'status');
    n.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#1f2328;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    document.documentElement.append(n);
    setTimeout(() => n.remove(), 4000);
  }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function copy(s, btn) {
    const done = () => { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1200); };
    navigator.clipboard.writeText(s).then(done, () => {
      const ta = el('textarea'); ta.value = s; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
    });
  }

  const root = el('div', 'aw-jv');
  root.id = 'aw-jv';
  const bar = el('div', 'aw-jv-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'JSON viewer');
  const views = el('div', 'aw-jv-seg');
  views.setAttribute('role', 'radiogroup');
  views.setAttribute('aria-label', 'View');
  const viewBtns = {};
  for (const [k, l] of [['tree', 'Tree'], ['pretty', 'Pretty'], ['raw', 'Raw']]) {
    const b = el('button', '', l);
    b.type = 'button'; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => show(k, true));
    viewBtns[k] = b; views.append(b);
  }
  const search = el('input');
  search.type = 'search'; search.placeholder = 'Search ( / )'; search.setAttribute('aria-label', 'Search JSON');
  const count = el('span', 'aw-jv-count');
  const expand = el('button', '', 'Expand all'); expand.type = 'button';
  const collapse = el('button', '', 'Collapse all'); collapse.type = 'button';
  const copyBtn = el('button', '', 'Copy'); copyBtn.type = 'button';
  const openBtn = el('button', 'aw-jv-primary', 'Open in API Workbench'); openBtn.type = 'button';
  const info = el('span', 'aw-jv-info', `${Array.isArray(data) ? `Array(${data.length})` : `Object, ${Object.keys(data || {}).length} keys`} · ${fmtBytes(new Blob([text]).size)}`);
  const spacer = el('span', 'aw-jv-spacer');
  bar.append(views, search, count, expand, collapse, spacer, info, copyBtn);
  if (/^https?:/.test(location.protocol)) bar.append(openBtn);
  const main = el('div', 'aw-jv-main');
  root.append(bar, main);

  let tree = null, prettyEl = null, rawEl = null, current = null, hits = [], cur = -1;
  let depth = 3;

  function show(view, remember) {
    current = view;
    for (const [k, b] of Object.entries(viewBtns)) { b.classList.toggle('active', k === view); b.setAttribute('aria-checked', String(k === view)); }
    for (const n of main.children) n.hidden = true;
    const isTree = view === 'tree';
    search.disabled = expand.disabled = collapse.disabled = !isTree;
    if (isTree) {
      if (!tree) { tree = globalThis.AWJsonTree.render(data, { expandDepth: depth }); main.append(tree); }
      tree.hidden = false;
    } else if (view === 'pretty') {
      if (!prettyEl) { prettyEl = el('pre', 'aw-jv-pre', JSON.stringify(data, null, 2)); main.append(prettyEl); }
      prettyEl.hidden = false;
    } else {
      if (!rawEl) { rawEl = el('pre', 'aw-jv-pre aw-jv-wrap', text); main.append(rawEl); }
      rawEl.hidden = false;
    }
    if (remember) { try { chrome.storage.local.set({ viewerView: view }); } catch { /* ignore */ } }
  }
  function go(d) {
    if (!hits.length) return;
    hits[cur]?.classList.remove('jt-current');
    cur = (cur + d + hits.length) % hits.length;
    hits[cur].classList.add('jt-current');
    hits[cur].scrollIntoView({ block: 'center' });
    count.textContent = `${cur + 1}/${hits.length}`;
  }
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!tree) return;
      const n = tree.search(search.value.trim());
      hits = tree.hits(); cur = -1;
      count.textContent = search.value.trim() ? (n ? `${n}` : 'none') : '';
      go(1);
    }, 180);
  });
  search.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); } });
  expand.addEventListener('click', () => tree && tree.expandAll());
  collapse.addEventListener('click', () => tree && tree.collapseAll());
  copyBtn.addEventListener('click', () => copy(current === 'raw' ? text : JSON.stringify(data, null, 2), copyBtn));
  openBtn.addEventListener('click', () => { try { chrome.runtime.sendMessage({ type: 'aw-open', url: location.href }); } catch { note('Reload the page: the extension was updated.'); } });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== search && !e.ctrlKey && !e.metaKey && !e.altKey && current === 'tree') { e.preventDefault(); search.focus(); }
  });

  // Replace the browser's plain rendering; keep the original <pre> in the DOM (hidden) for other tools.
  for (const c of [...body.children]) c.hidden = true;
  body.classList.add('aw-jv-body');
  body.prepend(root);

  const start = view => { show(view || 'tree', false); };
  try {
    chrome.storage.local.get(['viewerView', 'settings']).then(r => {
      depth = Number(r.settings?.jsonViewer?.expandDepth ?? 3);
      const def = r.viewerView || (r.settings?.jsonViewer?.defaultView === 'raw' ? 'pretty' : 'tree');
      start(def);
    }, () => start('tree'));
  } catch { start('tree'); }
})();
