import { loadAll, save, newId, DEFAULT_COMMANDS, DEFAULT_SETTINGS, templateHasQuery } from '../lib/settings.js';

const $ = s => document.querySelector(s);
let state = null;
let statusTimer = null;

function status(msg, isError) {
  const el = $('#status');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : '';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

async function persist(key) {
  try {
    const r = await save(key, state[key]);
    status(r.synced ? 'Saved' : 'Saved locally (sync unavailable)');
  } catch (e) {
    status('Could not save: ' + e.message, true);
  }
}

function validUrl(u) {
  try { const x = new URL(u.replace(/\{query\}|\{raw\}|%s/g, 'x')); return /^(https?|file|chrome|edge|about):$/.test(x.protocol); } catch (e) { return false; }
}

// ---------- tabs ----------
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(t) {
  for (const x of tabs) {
    const on = x === t;
    x.setAttribute('aria-selected', on);
    x.tabIndex = on ? 0 : -1;
    document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
  }
  try { history.replaceState(null, '', '#' + t.id.replace('tab-', '')); } catch (e) { /* ignore */ }
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', e => {
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    if (j !== null) { e.preventDefault(); tabs[j].focus(); selectTab(tabs[j]); }
  });
});
const initial = document.getElementById('tab-' + location.hash.slice(1));
if (initial) selectTab(initial);

// ---------- general ----------
function bindGeneral() {
  const s = state.settings;
  for (const id of ['enterOpens', 'theme', 'historyMax', 'historyDays', 'maxResults']) {
    const el = $('#' + id);
    el.value = String(s[id]);
    el.onchange = () => {
      s[id] = ['historyMax', 'historyDays', 'maxResults'].includes(id) ? Number(el.value) : el.value;
      persist('settings');
    };
  }
  for (const id of ['preferPopup', 'learn']) {
    const el = $('#' + id);
    el.checked = !!s[id];
    el.onchange = () => { s[id] = el.checked; persist('settings'); };
  }
  for (const el of document.querySelectorAll('[data-source]')) {
    const k = el.dataset.source;
    el.checked = s.sources[k] !== false;
    el.onchange = () => { s.sources[k] = el.checked; persist('settings'); };
  }
}

async function refreshStats() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'frecencyStats' });
    $('#frecency-stats').textContent = st && st.items !== undefined
      ? `${st.items} learned item${st.items === 1 ? '' : 's'}, ${st.queries} quer${st.queries === 1 ? 'y' : 'ies'}`
      : 'Unavailable';
  } catch (e) { $('#frecency-stats').textContent = 'Unavailable'; }
}
$('#clear-frecency').addEventListener('click', async () => {
  if (!confirm('Forget everything the palette has learned about your picks?')) return;
  await chrome.runtime.sendMessage({ type: 'clearFrecency' });
  refreshStats();
  status('Learned ranking reset');
});

// ---------- tables ----------
function input(value, attrs) {
  const el = document.createElement('input');
  el.value = value || '';
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}
function deleteButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small danger';
  b.textContent = 'Delete';
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}
function emptyRow(cols, text) {
  const tr = document.createElement('tr');
  tr.className = 'empty';
  const td = document.createElement('td');
  td.colSpan = cols; td.textContent = text;
  tr.appendChild(td);
  return tr;
}
function keywordTaken(kw, exceptId) {
  kw = (kw || '').toLowerCase();
  if (!kw) return false;
  return state.customCommands.some(c => c.id !== exceptId && (c.keyword || '').toLowerCase() === kw) ||
    state.quicklinks.some(q => q.id !== exceptId && (q.keyword || '').toLowerCase() === kw);
}

function renderCommands() {
  const tbody = $('#commands-table tbody');
  tbody.textContent = '';
  if (!state.customCommands.length) tbody.appendChild(emptyRow(5, 'No search commands. Add one below.'));
  for (const c of state.customCommands) {
    const tr = document.createElement('tr');
    const name = input(c.name, { 'aria-label': 'Name' });
    const kw = input(c.keyword, { 'aria-label': 'Keyword' });
    const url = input(c.url, { 'aria-label': 'URL template' });
    const fb = document.createElement('input');
    fb.type = 'checkbox'; fb.checked = !!c.fallback; fb.setAttribute('aria-label', 'Fallback');
    const commit = () => {
      const okName = !!name.value.trim();
      const okKw = /^\S+$/.test(kw.value.trim()) && !keywordTaken(kw.value.trim(), c.id);
      const okUrl = validUrl(url.value.trim());
      name.classList.toggle('invalid', !okName);
      kw.classList.toggle('invalid', !okKw);
      url.classList.toggle('invalid', !okUrl);
      if (!okName || !okKw || !okUrl) { status('Fix the highlighted field', true); return; }
      c.name = name.value.trim(); c.keyword = kw.value.trim(); c.url = url.value.trim(); c.fallback = fb.checked;
      persist('customCommands');
    };
    for (const el of [name, kw, url]) el.addEventListener('change', commit);
    fb.addEventListener('change', commit);
    const cells = [[name], [kw, 'kw'], [url], [fb, 'fb'], [deleteButton('Delete ' + c.name, () => {
      state.customCommands = state.customCommands.filter(x => x !== c);
      persist('customCommands'); renderCommands();
    }), 'act']];
    for (const [node, cls] of cells) { const td = document.createElement('td'); if (cls) td.className = cls; td.appendChild(node); tr.appendChild(td); }
    tbody.appendChild(tr);
  }
}

function renderQuicklinks() {
  const tbody = $('#quicklinks-table tbody');
  tbody.textContent = '';
  if (!state.quicklinks.length) tbody.appendChild(emptyRow(4, 'No quicklinks yet. Add your most-visited pages below.'));
  for (const q of state.quicklinks) {
    const tr = document.createElement('tr');
    const name = input(q.name, { 'aria-label': 'Name' });
    const kw = input(q.keyword, { 'aria-label': 'Keyword' });
    const url = input(q.url, { 'aria-label': 'URL' });
    const commit = () => {
      const okName = !!name.value.trim();
      const okKw = /^\S*$/.test(kw.value.trim()) && !keywordTaken(kw.value.trim(), q.id);
      const okUrl = validUrl(url.value.trim());
      name.classList.toggle('invalid', !okName);
      kw.classList.toggle('invalid', !okKw);
      url.classList.toggle('invalid', !okUrl);
      if (!okName || !okKw || !okUrl) { status('Fix the highlighted field', true); return; }
      q.name = name.value.trim(); q.keyword = kw.value.trim(); q.url = url.value.trim();
      persist('quicklinks');
    };
    for (const el of [name, kw, url]) el.addEventListener('change', commit);
    const cells = [[name], [kw, 'kw'], [url], [deleteButton('Delete ' + q.name, () => {
      state.quicklinks = state.quicklinks.filter(x => x !== q);
      persist('quicklinks'); renderQuicklinks();
    }), 'act']];
    for (const [node, cls] of cells) { const td = document.createElement('td'); if (cls) td.className = cls; td.appendChild(node); tr.appendChild(td); }
    tbody.appendChild(tr);
  }
}

$('#add-command').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const err = $('#command-error');
  const name = f.name.value.trim(), keyword = f.keyword.value.trim(), url = f.url.value.trim();
  if (!validUrl(url)) { err.textContent = 'Enter a valid URL (http or https).'; return; }
  if (!templateHasQuery(url)) { err.textContent = 'The URL needs a {query} placeholder where your search goes. For a fixed link, add a quicklink instead.'; return; }
  if (keywordTaken(keyword)) { err.textContent = `The keyword “${keyword}” is already used.`; return; }
  err.textContent = '';
  state.customCommands.push({ id: newId(), name, keyword, url, fallback: f.fallback.checked });
  persist('customCommands');
  renderCommands();
  f.reset();
  f.name.focus();
});
$('#restore-commands').addEventListener('click', () => {
  if (!confirm('Replace your search commands with the defaults?')) return;
  state.customCommands = DEFAULT_COMMANDS.map(c => ({ ...c }));
  persist('customCommands');
  renderCommands();
});

$('#add-quicklink').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const err = $('#quicklink-error');
  const name = f.name.value.trim(), keyword = f.keyword.value.trim();
  let url = f.url.value.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  if (!validUrl(url)) { err.textContent = 'Enter a valid URL.'; return; }
  if (keywordTaken(keyword)) { err.textContent = `The keyword “${keyword}” is already used.`; return; }
  err.textContent = '';
  state.quicklinks.push({ id: newId(), name, keyword, url });
  persist('quicklinks');
  renderQuicklinks();
  f.reset();
  f.name.focus();
});

// ---------- backup ----------
$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'command-palette', version: 1, ...state }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'command-palette-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.settings && typeof data.settings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...data.settings, sources: { ...DEFAULT_SETTINGS.sources, ...(data.settings.sources || {}) } };
      await persist('settings');
    }
    const clean = (arr, needQuery) => (Array.isArray(arr) ? arr : [])
      .filter(x => x && typeof x.name === 'string' && typeof x.url === 'string' && validUrl(x.url) && (!needQuery || templateHasQuery(x.url)))
      .map(x => ({ id: x.id || newId(), name: x.name.slice(0, 80), keyword: String(x.keyword || '').replace(/\s+/g, '').slice(0, 24), url: x.url, fallback: !!x.fallback }));
    if (Array.isArray(data.customCommands)) { state.customCommands = clean(data.customCommands, true); await persist('customCommands'); }
    if (Array.isArray(data.quicklinks)) { state.quicklinks = clean(data.quicklinks, false).map(({ fallback, ...q }) => q); await persist('quicklinks'); }
    bindGeneral(); renderCommands(); renderQuicklinks();
    status('Imported');
  } catch (err) {
    status('Import failed: ' + err.message, true);
  }
});

// ---------- shortcut ----------
async function showShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find(x => x.name === 'open-palette');
    $('#shortcut').textContent = c && c.shortcut ? c.shortcut : 'not set';
  } catch (e) { /* ignore */ }
}
$('#edit-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------- init ----------
(async () => {
  state = await loadAll();
  bindGeneral();
  renderCommands();
  renderQuicklinks();
  refreshStats();
  showShortcut();
})();
