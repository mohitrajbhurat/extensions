/* Type Kit popup: recent clipboard items and snippet search. */
(function () {
  'use strict';
  const S = window.TKStore, E = window.TKEngine;
  const $ = (id) => document.getElementById(id);
  const st = { tab: 'clips', index: 0, rows: [], snippets: [], clips: [], settings: {}, tabId: null, tabUrl: '' };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  function relTime(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function highlight(text, positions) {
    const frag = document.createDocumentFragment();
    const set = new Set(positions || []);
    let buf = '';
    for (let i = 0; i < text.length; i++) {
      if (set.has(i)) { if (buf) { frag.append(buf); buf = ''; } frag.append(h('mark', { text: text[i] })); } else buf += text[i];
    }
    if (buf) frag.append(buf);
    return frag;
  }

  function scriptable(url) { return /^(https?|file):/i.test(url || ''); }

  async function load() {
    const data = await S.loadAll();
    st.snippets = data.snippets;
    st.settings = data.settings;
    st.clips = await S.getClips();
    $('expander').checked = !!st.settings.expanderEnabled;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) { st.tabId = tab.id; st.tabUrl = tab.url || ''; }
    } catch (e) { /* ignore */ }
    if (!st.clips.length && st.snippets.length) setTab('snippets', true);
    render();
  }

  function setTab(tab, silent) {
    st.tab = tab; st.index = 0;
    document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (!silent) render();
  }

  function computeRows() {
    const q = $('q').value.trim();
    if (st.tab === 'clips') {
      const sorted = st.clips.slice().sort((a, b) => (b.pinned - a.pinned) || (new Date(b.createdAt) - new Date(a.createdAt)));
      const list = q ? E.search(q, sorted, (c) => [c.text.slice(0, 2000), c.title, c.host]) : sorted.map((item) => ({ item }));
      return list.slice(0, 100).map((r) => ({ kind: 'clip', item: r.item, positions: r.field === 0 ? r.positions : null }));
    }
    const enabled = st.snippets.filter((s) => s.enabled !== false);
    const list = q
      ? E.search(q, enabled, (s) => [s.shortcut, s.name, E.preview(s, { snippets: st.snippets, clips: st.clips }).slice(0, 300)])
      : enabled.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0) || String(a.name).localeCompare(b.name)).map((item) => ({ item, field: -1 }));
    return list.slice(0, 100).map((r) => ({ kind: 'snippet', item: r.item, positions: r.positions, field: r.field }));
  }

  function render() {
    st.rows = computeRows();
    if (st.index >= st.rows.length) st.index = Math.max(0, st.rows.length - 1);
    const list = $('list');
    list.textContent = '';
    $('count').textContent = st.tab === 'clips' ? st.clips.length + ' saved' : st.snippets.length + ' snippets';
    if (!st.rows.length) {
      const q = $('q').value.trim();
      let msg;
      if (q) msg = 'No matches for "' + q + '"';
      else if (st.tab === 'clips') msg = st.settings.historyEnabled ? 'Copy some text on a web page and it will show up here.' : 'Clipboard history is turned off in settings.';
      else msg = 'No snippets yet. Open the manager to create one.';
      list.append(h('div', { class: 'empty', text: msg }));
      return;
    }
    st.rows.forEach((r, i) => list.append(r.kind === 'clip' ? clipRow(r, i) : snippetRow(r, i)));
    scrollSel();
  }

  function scrollSel() {
    const sel = $('list').querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    $('q').setAttribute('aria-activedescendant', sel ? sel.id : '');
  }

  function rowShell(i, main, acts) {
    const row = h('div', { class: 'row', role: 'option', id: 'row-' + i, 'aria-selected': String(i === st.index), 'data-i': i }, main, h('div', { class: 'acts' }, acts));
    row.addEventListener('click', (e) => {
      if (e.target.closest('.acts')) return;
      activate(st.rows[i], e.shiftKey ? 'copy' : 'insert');
    });
    row.addEventListener('mousemove', () => { if (st.index !== i) { st.index = i; updateSel(); } });
    return row;
  }

  function updateSel() {
    $('list').querySelectorAll('.row').forEach((r) => r.setAttribute('aria-selected', String(Number(r.dataset.i) === st.index)));
    scrollSel();
  }

  function clipRow(r, i) {
    const c = r.item;
    const short = c.text.length > 400 ? c.text.slice(0, 400) + '…' : c.text;
    const text = h('div', { class: 'text' }, r.positions && c.text.length <= 400 ? highlight(short, r.positions) : short);
    const meta = h('div', { class: 'meta' },
      c.pinned ? h('span', { class: 'pinned', text: '● Pinned · ' }) : null,
      [c.host || 'unknown site', relTime(c.createdAt), c.text.length + ' chars'].join(' · '));
    const acts = [
      h('button', { class: 'btn ghost', title: 'Paste into the focused field on the page', text: 'Paste', onclick: () => activate(r, 'insert') }),
      h('button', { class: 'btn ghost', title: 'Copy to clipboard', text: 'Copy', onclick: () => activate(r, 'copy') }),
      h('button', { class: 'btn ghost', title: c.pinned ? 'Unpin' : 'Pin (kept when clearing)', text: c.pinned ? 'Unpin' : 'Pin', onclick: () => togglePin(c) }),
      h('button', { class: 'btn ghost danger', title: 'Delete', 'aria-label': 'Delete', text: '✕', onclick: () => removeClip(c) }),
    ];
    return rowShell(i, h('div', { class: 'main' }, text, meta), acts);
  }

  function snippetRow(r, i) {
    const s = r.item;
    const title = h('div', { class: 'title' },
      r.field === 1 ? highlight(s.name, r.positions) : s.name, ' ',
      s.shortcut ? h('span', { class: 'kbd' }, r.field === 0 ? highlight(s.shortcut, r.positions) : s.shortcut) : null);
    const prev = E.preview(s, { snippets: st.snippets, clips: st.clips }).replace(/\s+/g, ' ').slice(0, 140);
    const meta = h('div', { class: 'meta', text: prev });
    const acts = [
      h('button', { class: 'btn ghost', title: 'Insert into the focused field on the page', text: 'Insert', onclick: () => activate(r, 'insert') }),
      h('button', { class: 'btn ghost', title: 'Copy to clipboard', text: 'Copy', onclick: () => activate(r, 'copy') }),
      h('button', { class: 'btn ghost', title: 'Edit in the manager', text: 'Edit', onclick: () => openManager('#snippet=' + encodeURIComponent(s.id)) }),
    ];
    return rowShell(i, h('div', { class: 'main' }, title, meta), acts);
  }

  async function togglePin(c) {
    await S.updateClip(c.id, { pinned: !c.pinned });
    st.clips = await S.getClips();
    render();
  }

  async function removeClip(c) {
    await S.deleteClip(c.id);
    st.clips = await S.getClips();
    render();
    toast('Deleted');
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  async function sendInsert(payload) {
    if (st.tabId == null || !scriptable(st.tabUrl)) return { ok: false };
    try {
      return await chrome.runtime.sendMessage(Object.assign({ type: 'tk:insert-in-tab', tabId: st.tabId }, payload));
    } catch (e) { return { ok: false }; }
  }

  async function activate(r, mode) {
    if (!r) return;
    if (r.kind === 'clip') {
      chrome.runtime.sendMessage({ type: 'tk:touch-clip', id: r.item.id }).catch(() => {});
      if (mode === 'insert') {
        const res = await sendInsert({ kind: 'clip', text: r.item.text });
        if (res && res.ok) { window.close(); return; }
      }
      toast((await copy(r.item.text)) ? (mode === 'insert' ? 'No text field focused on the page. Copied instead.' : 'Copied') : 'Could not copy');
      return;
    }
    if (mode === 'insert') {
      const res = await sendInsert({ kind: 'snippet', id: r.item.id });
      if (res && res.ok) { window.close(); return; }
    }
    const text = await renderForCopy(r.item);
    if (text == null) return;
    chrome.runtime.sendMessage({ type: 'tk:record-use', id: r.item.id, insertedLength: text.length, shortcutLength: 0 }).catch(() => {});
    toast((await copy(text)) ? (mode === 'insert' ? 'No text field focused on the page. Copied instead.' : 'Copied') : 'Could not copy');
  }

  /* ---------- fill-in for copy ---------- */

  async function renderForCopy(snippet) {
    let clips = st.clips.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (/\{\s*(clipboard|clip|paste)\b/i.test(snippet.body)) {
      const res = await chrome.runtime.sendMessage({ type: 'tk:read-clipboard' }).catch(() => null);
      if (res && res.text) clips = [{ text: res.text }].concat(clips);
    }
    const ctx = { snippets: st.snippets, clips, settings: st.settings };
    const fields = E.collectFields(snippet.body, ctx);
    const values = fields.length ? await fillIn(snippet, fields, ctx) : {};
    if (!values) return null;
    const r = E.render(snippet.body, Object.assign({}, ctx, { values, rich: snippet.format === 'rich' }));
    return snippet.format === 'rich' ? E.htmlToText(r.text) : r.text;
  }

  function fillIn(snippet, fields, ctx) {
    return new Promise((resolve) => {
      const sec = $('fill'), form = $('fill-form'), prev = $('fill-preview');
      $('fill-title').textContent = 'Fill in: ' + snippet.name;
      form.textContent = '';
      const ctls = new Map();
      const values = () => { const v = {}; for (const [k, el] of ctls) v[k] = el.value; return v; };
      const update = () => {
        const r = E.render(snippet.body, Object.assign({}, ctx, { values: values(), rich: snippet.format === 'rich' }));
        prev.textContent = snippet.format === 'rich' ? E.htmlToText(r.text) : r.text;
      };
      fields.forEach((f, i) => {
        const id = 'f' + i;
        let ctl;
        if (f.type === 'select') { ctl = h('select', { class: 'input', id }, f.options.map((o) => h('option', { value: o, text: o }))); ctl.value = f.default; }
        else if (f.multiline) { ctl = h('textarea', { class: 'input', id, rows: 3 }); ctl.value = f.default || ''; }
        else { ctl = h('input', { class: 'input', id, type: 'text' }); ctl.value = f.default || ''; }
        ctl.addEventListener('input', update);
        ctl.addEventListener('change', update);
        ctls.set(f.key, ctl);
        form.append(h('label', { for: id, text: f.label }), ctl);
      });
      const done = (ok) => {
        sec.hidden = true;
        $('fill-ok').onclick = $('fill-cancel').onclick = sec.onkeydown = null;
        $('q').focus();
        resolve(ok ? values() : null);
      };
      $('fill-ok').onclick = () => done(true);
      $('fill-cancel').onclick = () => done(false);
      sec.onkeydown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      sec.hidden = false;
      update();
      const first = form.querySelector('input, select, textarea');
      if (first) first.focus();
    });
  }

  function openManager(hash) {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html' + (hash || '')) });
    window.close();
  }

  /* ---------- events ---------- */

  $('q').addEventListener('input', () => { st.index = 0; render(); });
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (st.rows.length) { st.index = (st.index + 1) % st.rows.length; updateSel(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (st.rows.length) { st.index = (st.index - 1 + st.rows.length) % st.rows.length; updateSel(); } }
    else if (e.key === 'Enter') { e.preventDefault(); activate(st.rows[st.index], e.shiftKey ? 'copy' : 'insert'); }
    else if (e.altKey && e.code === 'KeyP') { e.preventDefault(); const r = st.rows[st.index]; if (r && r.kind === 'clip') togglePin(r.item); }
  });
  document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => { setTab(b.dataset.tab); $('q').focus(); }));
  document.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = st.tab === 'clips' ? 'snippets' : 'clips';
    setTab(next);
    $('tab-' + next).focus();
  });
  $('expander').addEventListener('change', async (e) => {
    st.settings = await S.saveSettings({ expanderEnabled: e.target.checked });
    toast(e.target.checked ? 'Shortcut expansion on' : 'Shortcut expansion paused');
  });
  $('manage').addEventListener('click', () => openManager(''));

  load().then(() => $('q').focus());
})();
