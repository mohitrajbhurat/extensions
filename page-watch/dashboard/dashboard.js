import { createEditor } from '../lib/editor.js';
import { listSnapshots, getSnapshot, countSnapshots } from '../lib/db.js';
import { diffWords, diffStats, sideBySide } from '../lib/diff.js';
import { describeCondition } from '../lib/conditions.js';
import {
  getMonitors, getSettings, saveSettings, send, statusOf, STATUS_LABEL, relTime, fmtTime, escapeHtml, hostOf,
  intervalLabel, INTERVALS, originPattern, pickConfig,
} from '../lib/store.js';

const $ = (id) => document.getElementById(id);

const state = {
  monitors: {},
  settings: null,
  selectedId: null,
  filter: 'all',
  query: '',
  snapshots: [],
  a: null,
  b: null,
  mode: localStorageGet('diffMode') || 'inline',
  editing: null,
  missingOrigins: [],
};

function localStorageGet(k) { try { return localStorage.getItem('pw.' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('pw.' + k, v); } catch { /* ignore */ } }

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

const COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#65a30d', '#0891b2', '#9333ea', '#b45309'];
function colorFor(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
function sortedMonitors() {
  return Object.values(state.monitors).sort((a, b) => {
    const ua = a.unread > 0 ? 1 : 0;
    const ub = b.unread > 0 ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return (b.lastChange || b.createdAt || 0) - (a.lastChange || a.createdAt || 0);
  });
}

function matchesFilter(m) {
  const st = statusOf(m);
  if (state.filter === 'changed' && !(m.unread > 0)) return false;
  if (state.filter === 'problems' && !['error', 'needs_permission'].includes(st)) return false;
  if (state.filter === 'paused' && !m.paused) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    if (![m.name, m.url, m.selector].some((s) => String(s || '').toLowerCase().includes(q))) return false;
  }
  return true;
}

function renderList() {
  const all = sortedMonitors();
  const items = all.filter(matchesFilter);
  const ul = $('list');
  ul.replaceChildren(...items.map((m) => {
    const st = statusOf(m);
    const li = document.createElement('li');
    li.className = 'item' + (m.paused ? ' paused' : '');
    li.setAttribute('role', 'option');
    li.tabIndex = m.id === state.selectedId ? 0 : -1;
    li.dataset.id = m.id;
    li.setAttribute('aria-selected', String(m.id === state.selectedId));
    const host = hostOf(m.url);
    const sub = st === 'error' || st === 'needs_permission' ? (m.error || STATUS_LABEL[st]) : m.lastChange ? `Changed ${relTime(m.lastChange)}` : `${host} · checked ${relTime(m.lastCheck)}`;
    li.innerHTML = `
      <span class="avatar" style="background:${colorFor(host)}" aria-hidden="true">${escapeHtml(host[0] || '?')}</span>
      <span class="name">${escapeHtml(m.name)}</span>
      <span class="side">${m.unread ? `<span class="count-badge" title="Unread changes">${m.unread}</span>` : ''}<span class="pill ${st}">${STATUS_LABEL[st]}</span></span>
      <span class="sub">${escapeHtml(sub)}</span>`;
    return li;
  }));
  if (!ul.querySelector('[tabindex="0"]') && ul.firstElementChild) ul.firstElementChild.tabIndex = 0;
  $('list-empty').hidden = items.length > 0 || all.length === 0;
  $('list-empty').textContent = all.length ? 'No monitors match.' : '';
  document.querySelectorAll('.filters button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
  const unread = all.reduce((n, m) => n + (m.unread || 0), 0);
  document.title = unread ? `(${unread}) Page Watch` : 'Page Watch';
}

function select(id, { focus = false } = {}) {
  if (!state.monitors[id]) id = null;
  const changed = state.selectedId !== id;
  state.selectedId = id;
  const hash = id ? 'm=' + encodeURIComponent(id) : '';
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', hash ? '#' + hash : location.pathname);
  renderList();
  renderDetail();
  if (changed) loadHistory();
  if (focus) $('list').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
  markReadIfVisible();
}

function markReadIfVisible() {
  const m = state.monitors[state.selectedId];
  if (m && m.unread > 0 && document.visibilityState === 'visible') send('monitor:markRead', { id: m.id }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
async function renderDetail() {
  const m = state.monitors[state.selectedId];
  $('monitor').hidden = !m;
  if (!m) {
    $('welcome').hidden = false;
    return;
  }
  $('welcome').hidden = true;
  const st = statusOf(m);
  $('m-name').textContent = m.name;
  $('m-status').className = 'pill ' + st;
  $('m-status').textContent = STATUS_LABEL[st];
  $('m-unread').innerHTML = m.unread ? `<span class="count-badge" title="Unread changes">${m.unread}</span>` : '';
  $('m-url').href = m.url;
  $('m-url').textContent = m.url;
  $('m-pause').textContent = m.paused ? 'Resume' : 'Pause';
  $('m-check').disabled = !!m.checking;
  $('m-check').innerHTML = m.checking ? '<span class="spinner" aria-hidden="true"></span> Checking…' : 'Check now';

  const notices = [];
  if (m.status === 'needs_permission') {
    notices.push(`<div class="notice warn"><span>Page Watch needs access to <b>${escapeHtml(hostOf(m.url))}</b> to check this page in the background.</span><button class="btn small" data-act="grant">Grant access</button></div>`);
  } else if (m.status === 'error' && m.error) {
    notices.push(`<div class="notice error"><span><b>Last check failed:</b> ${escapeHtml(m.error)}${m.errorCount > 1 ? ` (${m.errorCount} times in a row)` : ''}</span></div>`);
  }
  if (m.warning && m.status === 'ok') {
    notices.push(`<div class="notice warn"><span>${escapeHtml(m.warning)}.${m.mode === 'fetch' ? ' If the content is added by JavaScript, edit the monitor and choose rendering in a background tab.' : ''}</span></div>`);
  }
  $('m-notices').innerHTML = notices.join('');

  const alarm = !m.paused ? await chrome.alarms.get('pw:' + m.id).catch(() => null) : null;
  const facts = [
    ['Watching', m.selector ? `<code>${escapeHtml(m.selector)}</code>` : 'Whole page text'],
    ['Loaded by', m.mode === 'render' ? `Background tab (wait ${m.renderWait}s)` : 'Fetching HTML'],
    ['Frequency', escapeHtml(intervalLabel(m.interval))],
    ['Alert when', escapeHtml(describeCondition(m.condition)) + (m.condition.type !== 'any' && m.lastCheck ? ` · <b>${m.conditionMet ? 'met' : 'not met'}</b>` : '')],
    ['Last check', m.lastCheck ? `<span title="${escapeHtml(fmtTime(m.lastCheck))}">${relTime(m.lastCheck)}</span>` : 'Not yet'],
    ['Last change', m.lastChange ? `<span title="${escapeHtml(fmtTime(m.lastChange))}">${relTime(m.lastChange)}</span>` : 'No changes yet'],
    ['Next check', m.paused ? 'Paused' : alarm ? relTime(alarm.scheduledTime) : '—'],
    ['Checks · changes', `${m.checks || 0} · ${m.changes || 0}`],
  ];
  if (m.lastValue != null) facts.push(['Current number', escapeHtml(String(m.lastValue))]);
  $('m-facts').innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

// ---------------------------------------------------------------------------
// History + diff
// ---------------------------------------------------------------------------
let historyToken = 0;
async function loadHistory({ keepSelection = false } = {}) {
  const id = state.selectedId;
  const token = ++historyToken;
  if (!id) return;
  const snaps = await listSnapshots(id, { withText: false });
  if (token !== historyToken) return;
  const prevA = state.a;
  const prevB = state.b;
  state.snapshots = snaps;
  const ids = new Set(snaps.map((s) => s.id));
  if (keepSelection && ids.has(prevA) && ids.has(prevB) && prevB !== snaps[1]?.id) {
    state.a = prevA; state.b = prevB;
  } else {
    state.b = snaps[0]?.id ?? null;
    state.a = snaps[1]?.id ?? null;
  }
  renderTimeline();
  await renderDiff();
}

function renderTimeline() {
  const ol = $('timeline');
  const snaps = state.snapshots;
  if (!snaps.length) {
    ol.innerHTML = '<li class="hint">No snapshots yet. The first check records a baseline.</li>';
    fillCompareSelects();
    return;
  }
  ol.replaceChildren(...snaps.map((s, i) => {
    const li = document.createElement('li');
    li.className = 'tl' + (s.met && !s.baseline ? ' met' : '') + (s.id === state.a ? ' is-a' : '');
    li.tabIndex = 0;
    li.dataset.id = s.id;
    li.setAttribute('aria-current', String(s.id === state.b));
    const tags = [];
    if (s.baseline || i === snaps.length - 1 && !s.added && !s.removed) tags.push('<span class="tag">Baseline</span>');
    if (s.added) tags.push(`<span class="tag add">+${s.added}</span>`);
    if (s.removed) tags.push(`<span class="tag del">−${s.removed}</span>`);
    if (s.met && !s.baseline) tags.push('<span class="tag alert">Alert</span>');
    if (i === 0) tags.push('<span class="tag">Latest</span>');
    li.innerHTML = `<div class="when">${escapeHtml(fmtTime(s.ts))}</div><div class="rel">${relTime(s.ts)}</div><div class="tags">${tags.join('')}</div>`;
    li.title = 'Click to view this change. Shift+click to set it as the older side.';
    return li;
  }));
  fillCompareSelects();
}

function fillCompareSelects() {
  const opts = state.snapshots.map((s, i) => `<option value="${s.id}">${escapeHtml(fmtTime(s.ts))}${i === 0 ? ' (latest)' : ''}</option>`).join('');
  $('cmp-a').innerHTML = opts;
  $('cmp-b').innerHTML = opts;
  $('cmp-a').value = state.a ?? '';
  $('cmp-b').value = state.b ?? '';
  $('cmp-a').disabled = $('cmp-b').disabled = state.snapshots.length < 2;
}

function pickFromTimeline(id, asOlder) {
  const idx = state.snapshots.findIndex((s) => s.id === id);
  if (idx < 0) return;
  if (asOlder) state.a = id;
  else {
    state.b = id;
    state.a = state.snapshots[idx + 1]?.id ?? null;
  }
  renderTimeline();
  renderDiff();
}

const textCache = new Map();
async function snapText(id) {
  if (id == null) return null;
  if (textCache.has(id)) return textCache.get(id);
  const s = await getSnapshot(id);
  const t = s ? s.text : null;
  if (textCache.size > 40) textCache.clear();
  textCache.set(id, t);
  return t;
}

function foldEq(text) {
  const lines = text.split('\n');
  if (lines.length <= 8) return escapeHtml(text);
  const head = lines.slice(0, 3).join('\n');
  const tail = lines.slice(-3).join('\n');
  const mid = lines.slice(3, -3).join('\n');
  const n = lines.length - 6;
  return `${escapeHtml(head)}\n<button class="fold" data-full="${escapeHtml(mid)}" aria-label="Show ${n} unchanged lines">⋯ ${n} unchanged line${n === 1 ? '' : 's'} (click to expand)</button>${escapeHtml(tail)}`;
}

function inlineHtml(ops) {
  return ops.map((o) => {
    if (o.type === 'add') return `<ins>${escapeHtml(o.text)}</ins>`;
    if (o.type === 'del') return `<del>${escapeHtml(o.text)}</del>`;
    return foldEq(o.text);
  }).join('');
}

function splitHtml(ops) {
  const rows = sideBySide(ops);
  const cell = (parts, side) => {
    if (parts == null) return `<td class="${side === 'l' ? 'chg-l' : 'chg-r'}"></td>`;
    const changed = parts.some((p) => p.type !== 'eq');
    const html = parts.map((p) => (p.type === 'add' ? `<ins>${escapeHtml(p.text)}</ins>` : p.type === 'del' ? `<del>${escapeHtml(p.text)}</del>` : escapeHtml(p.text))).join('');
    return `<td class="${changed ? (side === 'l' ? 'chg-l' : 'chg-r') : ''}">${html || '&nbsp;'}</td>`;
  };
  return `<table class="split"><thead><tr><th>Before</th><th>After</th></tr></thead><tbody>${rows.map((r) => `<tr>${cell(r.left, 'l')}${cell(r.right, 'r')}</tr>`).join('')}</tbody></table>`;
}

let diffToken = 0;
async function renderDiff() {
  const token = ++diffToken;
  document.querySelectorAll('#diff-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  const diffEl = $('diff');
  const statsEl = $('diff-stats');
  if (state.b == null) {
    diffEl.innerHTML = '<p class="empty">Nothing to compare yet.</p>';
    statsEl.textContent = '';
    return;
  }
  const [ta, tb] = await Promise.all([snapText(state.a), snapText(state.b)]);
  if (token !== diffToken) return;
  const sa = state.snapshots.find((s) => s.id === state.a);
  const sb = state.snapshots.find((s) => s.id === state.b);
  if (state.mode === 'text' || ta == null) {
    statsEl.innerHTML = `${ta == null ? 'Only one snapshot so far. ' : ''}Showing the full text from ${escapeHtml(fmtTime(sb?.ts))} · ${(tb || '').length.toLocaleString()} characters`;
    diffEl.textContent = tb || '(empty)';
    return;
  }
  const t0 = performance.now();
  const ops = diffWords(ta, tb);
  const stats = diffStats(ops);
  const ms = Math.round(performance.now() - t0);
  const older = sa && sb && sa.ts > sb.ts ? ' · note: “before” is newer than “after”' : '';
  statsEl.innerHTML = stats.changed
    ? `<span class="tag add">+${stats.added} words</span><span class="tag del">−${stats.removed} words</span><span>${escapeHtml(fmtTime(sa?.ts))} → ${escapeHtml(fmtTime(sb?.ts))}${older}</span><span title="Diff time">${ms} ms</span>`
    : `<span>No differences between these snapshots.</span>`;
  diffEl.innerHTML = state.mode === 'split' ? splitHtml(ops) : inlineHtml(ops) || '<p class="empty">(empty)</p>';
  const first = diffEl.querySelector('ins, del');
  if (first) diffEl.scrollTop = Math.max(0, first.offsetTop - diffEl.offsetTop - 48);
}

// ---------------------------------------------------------------------------
// Editor dialog
// ---------------------------------------------------------------------------
let editor = null;
function openEditor(monitor, draft) {
  const dlg = $('editor-dialog');
  state.editing = monitor ? monitor.id : null;
  $('editor-title').textContent = monitor ? 'Edit monitor' : 'New monitor';
  $('editor-save').textContent = monitor ? 'Save changes' : 'Start watching';
  $('draft-picked').hidden = !draft;
  if (draft) {
    $('draft-label').textContent = draft.selector ? `Selected on the page · ${draft.count} match${draft.count === 1 ? '' : 'es'}` : 'Whole page';
    $('draft-text').textContent = (draft.preview || '(no text)').slice(0, 1200);
  }
  const initial = monitor
    ? pickConfig(monitor)
    : { url: draft?.url || '', name: (draft?.title || '').slice(0, 80), selector: draft?.selector || '', interval: state.settings.defaultInterval, notify: true };
  editor = createEditor($('editor'), initial, { settings: state.settings, showUrl: true });
  if (!dlg.open) dlg.showModal();
  editor.focus();
}

function saveEditor() {
  let m;
  try { m = editor.get(); } catch (e) { editor.showError(e.message); return; }
  const access = chrome.permissions.request({ origins: [originPattern(m.url)] }).catch(() => false);
  const btn = $('editor-save');
  btn.disabled = true;
  Promise.all([access, send('monitor:save', { monitor: m })]).then(async ([granted, res]) => {
    await chrome.storage.local.remove('draft');
    $('editor-dialog').close();
    state.monitors[res.monitor.id] = res.monitor;
    select(res.monitor.id);
    toast(granted ? 'Saved' : 'Saved. Site access was not granted, so background checks cannot run yet.');
    if (state.editing === res.monitor.id) loadHistory();
  }).catch((e) => editor.showError(e.message)).finally(() => { btn.disabled = false; });
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------
async function exportMonitors() {
  const list = Object.values(await getMonitors()).map(pickConfig);
  const data = { format: 'page-watch', version: 1, exportedAt: new Date().toISOString(), monitors: list };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `page-watch-monitors-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${list.length} monitor${list.length === 1 ? '' : 's'}`);
}

async function importFile(file) {
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('File is too large');
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data) ? data : data && Array.isArray(data.monitors) ? data.monitors : null;
    if (!items) throw new Error('This file does not contain Page Watch monitors');
    const res = await send('monitor:import', { monitors: items });
    toast(`Imported ${res.added} monitor${res.added === 1 ? '' : 's'}${res.skipped.length ? `, skipped ${res.skipped.length} (duplicates or invalid)` : ''}`);
    await refreshPermissionBanner();
  } catch (e) {
    toast('Import failed: ' + e.message);
  }
}

async function refreshPermissionBanner() {
  const list = Object.values(state.monitors);
  const origins = [...new Set(list.map((m) => { try { return originPattern(m.url); } catch { return null; } }).filter(Boolean))];
  const missing = [];
  for (const o of origins) {
    if (!(await chrome.permissions.contains({ origins: [o] }).catch(() => true))) missing.push(o);
  }
  state.missingOrigins = missing;
  $('perm-banner').hidden = !missing.length;
  $('perm-banner-text').textContent = missing.length
    ? `${missing.length} site${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} access before background checks can run: ${missing.map((o) => o.replace(/^https?:\/\/|\/\*$/g, '')).slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`
    : '';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function openSettings() {
  const s = state.settings;
  const form = $('settings-form');
  $('s-interval').innerHTML = INTERVALS.map((i) => `<option value="${i.min}">${escapeHtml(i.label)}</option>`).join('');
  form.defaultInterval.value = String(s.defaultInterval);
  form.maxSnapshots.value = String(s.maxSnapshots);
  form.renderWait.value = String(s.renderWait);
  form.notifications.checked = !!s.notifications;
  form.showBadge.checked = !!s.showBadge;
  form.sound.value = s.sound;
  form.soundVolume.value = String(s.soundVolume);
  const n = Object.keys(state.monitors).length;
  const snaps = await countSnapshots().catch(() => 0);
  $('data-stats').textContent = `${n} monitor${n === 1 ? '' : 's'} · ${snaps} snapshot${snaps === 1 ? '' : 's'} stored locally on this device.`;
  $('settings-dialog').showModal();
}

async function saveSettingsForm() {
  const form = $('settings-form');
  state.settings = await saveSettings({
    defaultInterval: Number(form.defaultInterval.value),
    maxSnapshots: Math.min(1000, Math.max(2, Number(form.maxSnapshots.value) || 100)),
    renderWait: Math.min(60, Math.max(1, Number(form.renderWait.value) || 5)),
    notifications: form.notifications.checked,
    showBadge: form.showBadge.checked,
    sound: form.sound.value,
    soundVolume: Number(form.soundVolume.value),
  });
  await send('badge:refresh').catch(() => {});
  $('settings-dialog').close();
  toast('Settings saved');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function confirmDialog(title, text, yesLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yesLabel;
    const done = (v) => { dlg.close(); $('confirm-yes').onclick = $('confirm-no').onclick = null; resolve(v); };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
    dlg.onclose = () => resolve(false);
    dlg.showModal();
    $('confirm-no').focus();
  });
}

function bind() {
  $('search').addEventListener('input', (e) => { state.query = e.target.value.trim(); renderList(); });
  document.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderList(); }));

  $('list').addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (li) select(li.dataset.id);
  });
  $('list').addEventListener('keydown', (e) => {
    const items = [...$('list').querySelectorAll('.item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.dataset.id, { focus: true });
    } else if (e.key === 'Enter' && i >= 0) select(items[i].dataset.id);
  });

  $('timeline').addEventListener('click', (e) => {
    const li = e.target.closest('.tl');
    if (li) pickFromTimeline(Number(li.dataset.id), e.shiftKey);
  });
  $('timeline').addEventListener('keydown', (e) => {
    const li = e.target.closest('.tl');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFromTimeline(Number(li.dataset.id), e.shiftKey); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (sib) sib.focus();
    }
  });
  $('cmp-a').addEventListener('change', (e) => { state.a = Number(e.target.value); renderTimeline(); renderDiff(); });
  $('cmp-b').addEventListener('change', (e) => { state.b = Number(e.target.value); renderTimeline(); renderDiff(); });
  document.querySelectorAll('#diff-mode button').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    localStorageSet('diffMode', state.mode);
    renderDiff();
  }));
  $('diff').addEventListener('click', (e) => {
    const fold = e.target.closest('.fold');
    if (fold) fold.replaceWith(document.createTextNode(fold.dataset.full + '\n'));
  });

  $('m-check').addEventListener('click', async () => {
    const id = state.selectedId;
    const res = await send('monitor:check', { id }).catch((e) => ({ error: e.message }));
    if (res && res.error) toast('Check failed: ' + res.error);
    else if (res && res.changed) toast(res.met ? 'Changed, and the alert condition is met' : 'Changed (alert condition not met)');
    else toast('No change');
  });
  $('m-pause').addEventListener('click', () => {
    const m = state.monitors[state.selectedId];
    if (m) send('monitor:pause', { id: m.id, paused: !m.paused });
  });
  $('m-edit').addEventListener('click', () => { const m = state.monitors[state.selectedId]; if (m) openEditor(m); });
  $('m-delete').addEventListener('click', async () => {
    const m = state.monitors[state.selectedId];
    if (!m) return;
    if (!(await confirmDialog('Delete monitor?', `“${m.name}” and its ${state.snapshots.length} snapshot${state.snapshots.length === 1 ? '' : 's'} will be removed.`))) return;
    await send('monitor:delete', { id: m.id });
    delete state.monitors[m.id];
    const next = sortedMonitors()[0];
    select(next ? next.id : null);
    toast('Monitor deleted');
  });
  $('m-notices').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="grant"]');
    const m = state.monitors[state.selectedId];
    if (b && m) chrome.permissions.request({ origins: [originPattern(m.url)] }).then((ok) => { if (ok) toast('Access granted. Checking now…'); }).catch(() => {});
  });
  $('perm-banner-grant').addEventListener('click', () => {
    chrome.permissions.request({ origins: state.missingOrigins }).then((ok) => { if (ok) { toast('Access granted'); refreshPermissionBanner(); } }).catch(() => {});
  });

  $('new-monitor').addEventListener('click', () => openEditor(null));
  $('welcome-new').addEventListener('click', () => openEditor(null));
  $('editor-save').addEventListener('click', saveEditor);
  $('editor-cancel').addEventListener('click', () => $('editor-dialog').close());
  $('editor-dialog').addEventListener('close', () => { chrome.storage.local.remove('draft'); });
  $('editor-dialog').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEditor(); });

  $('check-all').addEventListener('click', async () => {
    const b = $('check-all');
    b.disabled = true;
    b.innerHTML = '<span class="spinner" aria-hidden="true"></span> Checking…';
    const res = await send('monitor:checkAll').catch(() => null);
    b.disabled = false;
    b.textContent = 'Check all';
    if (res) toast(`Checked ${res.checked} monitor${res.checked === 1 ? '' : 's'}`);
  });
  $('export').addEventListener('click', exportMonitors);
  $('import').addEventListener('click', () => $('import-file').click());
  $('welcome-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });

  $('open-settings').addEventListener('click', openSettings);
  $('settings-save').addEventListener('click', saveSettingsForm);
  $('settings-cancel').addEventListener('click', () => $('settings-dialog').close());
  $('sound-test').addEventListener('click', async () => {
    const form = $('settings-form');
    await send('sound:test', { sound: form.sound.value, volume: Number(form.soundVolume.value) })
      .catch((e) => toast('Could not play sound: ' + e.message));
  });

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'n') { e.preventDefault(); openEditor(null); }
    else if (e.key === 'c' && state.selectedId) { e.preventDefault(); $('m-check').click(); }
    else if (e.key === 'e' && state.selectedId) { e.preventDefault(); $('m-edit').click(); }
    else if ((e.key === 'j' || e.key === 'k') && !e.shiftKey) {
      const list = sortedMonitors().filter(matchesFilter);
      const i = list.findIndex((m) => m.id === state.selectedId);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'j' ? 1 : -1)))];
      if (next) select(next.id);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.monitors) {
      state.monitors = changes.monitors.newValue || {};
      if (state.selectedId && !state.monitors[state.selectedId]) state.selectedId = null;
      renderList();
      renderDetail();
      refreshPermissionBanner();
    }
    if (changes.settings) getSettings().then((s) => { state.settings = s; });
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'snapshots:changed' && msg.id === state.selectedId) {
      loadHistory();
      markReadIfVisible();
    }
    return false;
  });
  chrome.permissions.onAdded.addListener(() => refreshPermissionBanner());
  document.addEventListener('visibilitychange', markReadIfVisible);
  window.addEventListener('hashchange', route);
  setInterval(() => { renderList(); renderDetail(); }, 30000);
}

async function route() {
  const hash = location.hash.slice(1);
  if (hash === 'new') {
    const { draft } = await chrome.storage.local.get('draft');
    openEditor(null, draft || null);
    history.replaceState(null, '', location.pathname);
    const first = sortedMonitors()[0];
    if (first && !state.selectedId) select(first.id);
    return;
  }
  const params = new URLSearchParams(hash);
  const id = params.get('m');
  if (id && state.monitors[id]) { select(id); return; }
  if (!state.selectedId) {
    const first = sortedMonitors()[0];
    select(first ? first.id : null);
  }
}

async function init() {
  state.settings = await getSettings();
  state.monitors = await getMonitors();
  bind();
  renderList();
  await route();
  refreshPermissionBanner();
}

init();
