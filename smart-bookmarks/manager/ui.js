// Dialogs, toasts, background task progress, folder picker and a concurrency pool.
import { icon, esc } from '../lib/icons.js';
import { S, folderPath } from './state.js';

// ---------- Toasts ----------
export function toast(message, { action, timeout = 5000, kind = '' } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="msg">${esc(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.innerHTML = action.icon ? icon(action.icon) + esc(action.label) : esc(action.label);
    b.addEventListener('click', () => { close(); action.fn(); });
    el.append(b);
  }
  const x = document.createElement('button');
  x.className = 'btn ghost icon sm';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = icon('x');
  x.addEventListener('click', () => close());
  el.append(x);
  host.append(el);
  let t = setTimeout(close, timeout);
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', () => { t = setTimeout(close, 2500); });
  function close() { clearTimeout(t); el.classList.add('out'); setTimeout(() => el.remove(), 180); }
  return close;
}

// ---------- Dialog ----------
export function dialog({ title, body = '', actions = [{ label: 'OK', value: true, primary: true }], wide = false, onOpen, validate } = {}) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg' + (wide ? ' wide' : '');
    d.innerHTML = `<form method="dialog" class="dlg-inner">
      <header class="dlg-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost icon sm" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="dlg-body"></div>
      <footer class="dlg-foot"></footer></form>`;
    const bodyEl = d.querySelector('.dlg-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.append(body);
    const foot = d.querySelector('.dlg-foot');
    actions.forEach(a => {
      const b = document.createElement('button');
      b.type = a.primary ? 'submit' : 'button';
      b.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger solid' : '');
      b.textContent = a.label;
      b.addEventListener('click', e => {
        e.preventDefault();
        if (a.value !== null && a.value !== undefined && a.value !== false && validate && validate(a.value, d) === false) return;
        done(typeof a.value === 'function' ? a.value(d) : a.value);
      });
      if (a.left) b.style.marginRight = 'auto';
      foot.append(b);
    });
    d.querySelector('[data-close]').addEventListener('click', () => done(null));
    d.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    d.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const p = actions.find(a => a.primary);
      if (!p) return;
      if (validate && validate(p.value, d) === false) return;
      done(typeof p.value === 'function' ? p.value(d) : p.value);
    });
    let finished = false;
    function done(v) {
      if (finished) return;
      finished = true;
      d.close();
      d.remove();
      resolve(v);
    }
    document.body.append(d);
    d.showModal();
    if (onOpen) onOpen(d);
    const f = d.querySelector('[autofocus]') || d.querySelector('.dlg-body input, .dlg-body select, .dlg-body textarea') || d.querySelector('.dlg-foot .primary');
    if (f) f.focus();
  });
}

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return dialog({
    title,
    body: `<p class="dlg-text">${message}</p>`,
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true, danger }]
  }).then(v => !!v);
}

export function promptDialog(title, label, value = '', okLabel = 'Save') {
  return dialog({
    title,
    body: `<label class="field"><span class="field-label">${esc(label)}</span><input class="input" name="v" value="${esc(value)}" autofocus></label>`,
    actions: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: d => d.querySelector('[name=v]').value.trim() }],
    onOpen: d => { const i = d.querySelector('[name=v]'); i.select(); }
  });
}

// ---------- Background tasks ----------
export function startTask(label, { total = 0, cancellable = true } = {}) {
  const host = document.getElementById('tasks');
  const ctrl = new AbortController();
  const el = document.createElement('div');
  el.className = 'task';
  el.innerHTML = `<div class="task-row"><span class="spinner"></span><span class="task-label">${esc(label)}</span><span class="task-count"></span>
    ${cancellable ? `<button class="btn ghost sm" data-cancel>Cancel</button>` : ''}</div>
    <div class="progress"><div></div></div>`;
  host.append(el);
  const bar = el.querySelector('.progress > div');
  const count = el.querySelector('.task-count');
  const lab = el.querySelector('.task-label');
  const cancelBtn = el.querySelector('[data-cancel]');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { ctrl.abort(); cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…'; });
  const api = {
    signal: ctrl.signal,
    get cancelled() { return ctrl.signal.aborted; },
    cancel: () => ctrl.abort(),
    update(done, t = total, text) {
      total = t;
      if (text) lab.textContent = text;
      count.textContent = total ? `${done} / ${total}` : '';
      bar.style.width = total ? `${Math.round(done / total * 100)}%` : '0';
    },
    finish(message, kind) {
      el.remove();
      if (message) toast(message, { kind });
    }
  };
  api.update(0, total);
  return api;
}

// Runs worker over items with bounded concurrency. Stops early when signal aborts.
export async function runPool(items, worker, { concurrency = 4, signal, onProgress } = {}) {
  let i = 0, done = 0;
  const results = new Array(items.length);
  const next = async () => {
    while (i < items.length) {
      if (signal && signal.aborted) return;
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); } catch (e) { results[idx] = { error: e }; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

// ---------- Folder picker ----------
export function pickFolder({ title = 'Move to folder', okLabel = 'Move here', exclude = new Set(), initial } = {}) {
  const body = document.createElement('div');
  body.className = 'picker';
  body.innerHTML = `<input class="input" type="search" placeholder="Filter folders…" aria-label="Filter folders" autofocus>
    <div class="picker-list" role="listbox" tabindex="0" aria-label="Folders"></div>
    <button type="button" class="btn ghost sm picker-new">${icon('folderPlus')}New folder in selected</button>`;
  const list = body.querySelector('.picker-list');
  const filter = body.querySelector('input');
  let selected = initial && S.nodes.has(initial) ? initial : null;
  const blocked = id => [...exclude].some(x => { let n = S.nodes.get(id); while (n) { if (n.id === x) return true; n = S.nodes.get(n.parentId); } return false; });

  function render() {
    const q = filter.value.trim().toLowerCase();
    const rows = S.folders
      .filter(f => !blocked(f.id))
      .filter(f => !q || folderPath(f.id).toLowerCase().includes(q))
      .map(f => `<div class="picker-item${f.id === selected ? ' sel' : ''}" role="option" aria-selected="${f.id === selected}" data-id="${f.id}" style="padding-left:${q ? 8 : 8 + (f.depth - 1) * 16}px">
        ${icon('folder')}<span class="pt">${esc(q ? folderPath(f.id) : f.title || '(untitled)')}</span><span class="faint small">${f.total || ''}</span></div>`);
    list.innerHTML = rows.join('') || '<div class="muted small" style="padding:8px">No folders match.</div>';
    const s = list.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }
  list.addEventListener('click', e => { const it = e.target.closest('[data-id]'); if (it) { selected = it.dataset.id; render(); } });
  list.addEventListener('dblclick', e => { const it = e.target.closest('[data-id]'); if (it) { selected = it.dataset.id; body.closest('form').requestSubmit(); } });
  const move = d => {
    const items = [...list.querySelectorAll('[data-id]')];
    const i = items.findIndex(x => x.dataset.id === selected);
    const n = items[Math.max(0, Math.min(items.length - 1, i + d))];
    if (n) { selected = n.dataset.id; render(); }
  };
  const keys = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  };
  list.addEventListener('keydown', keys);
  filter.addEventListener('keydown', keys);
  filter.addEventListener('input', () => {
    render();
    const first = list.querySelector('[data-id]');
    if (first && !list.querySelector('.sel')) { selected = first.dataset.id; render(); }
  });
  body.querySelector('.picker-new').addEventListener('click', async () => {
    const parentId = selected || (S.folders[0] && S.folders[0].id);
    const name = await promptDialog('New folder', 'Folder name', '', 'Create');
    if (!name) return;
    const f = await chrome.bookmarks.create({ parentId, title: name });
    const parent = S.nodes.get(parentId);
    const node = { ...f, children: [], depth: (parent ? parent.depth : 0) + 1, path: folderPath(parentId), total: 0 };
    S.nodes.set(f.id, node);
    const idx = S.folders.indexOf(parent);
    S.folders.splice(idx + 1, 0, node);
    selected = f.id;
    render();
  });
  render();
  return dialog({
    title,
    body,
    actions: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: () => selected }],
    validate: () => !!selected
  });
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

export function plural(n, word, pl = word + 's') { return `${n.toLocaleString()} ${n === 1 ? word : pl}`; }

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
