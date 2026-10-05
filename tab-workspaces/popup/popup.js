import { h, icon, send, toast, act, fav, clear, colorDot, currentWindowId, dialog } from '../shared/ui.js';
import { fuzzyFilter, plural, normalizeUrl, relTime, DEFAULT_SETTINGS } from '../lib/util.js';

const $ = s => document.querySelector(s);
let windowId;
let data = { workspaces: [], stashes: [], archive: [], settings: DEFAULT_SETTINGS };
let tabs = [];
let binding = null;
let results = [];
let sel = 0;

$('#open-dashboard').append(icon('grid'));
$('#q').parentElement.prepend(icon('search'));

async function load() {
  windowId = await currentWindowId();
  const [store, allTabs, bindings] = await Promise.all([
    chrome.storage.local.get(['workspaces', 'stashes', 'archive', 'settings']),
    chrome.tabs.query({}),
    send('state.bindings').catch(() => ({})),
  ]);
  data = { workspaces: store.workspaces || [], stashes: store.stashes || [], archive: store.archive || [], settings: { ...DEFAULT_SETTINGS, ...(store.settings || {}) } };
  tabs = allTabs;
  binding = bindings[windowId] || null;
  render();
}

function render() {
  renderCurrent();
  renderWorkspaces();
  renderActions();
  renderStats();
  if ($('#q').value.trim()) renderResults();
}

function renderCurrent() {
  const ws = data.workspaces.find(w => w.id === binding);
  const el = $('#current');
  if (ws) clear(el, colorDot(ws.color), h('span', 'In workspace ', h('b', ws.name)));
  else clear(el, 'No workspace in this window');
}

function renderWorkspaces() {
  const list = $('#ws-list');
  if (!data.workspaces.length) {
    clear(list, h('li.faint.small', { style: { padding: '8px' } }, 'Save this window as your first workspace to switch between projects in one click.'));
    $('#ws-hint').textContent = '';
    return;
  }
  $('#ws-hint').textContent = data.workspaces.length > 1 ? 'Press 1–9 to switch' : '';
  clear(list, data.workspaces.map((ws, i) => {
    const current = ws.id === binding;
    return h('li.ws-item' + (current ? '.current' : ''),
      h('button.ws-main', {
        title: current ? 'Current workspace' : `Switch this window to “${ws.name}”`,
        onclick: () => switchTo(ws.id),
      },
        h('span.key', i < 9 ? String(i + 1) : ''),
        colorDot(ws.color),
        h('span.name', ws.name),
        h('span.count', current ? 'current' : plural(ws.tabs.length, 'tab'))),
      h('button.icon-btn', { title: 'Open in new window', 'aria-label': `Open ${ws.name} in new window`, onclick: () => switchTo(ws.id, true) }, icon('window')));
  }));
}

async function switchTo(id, newWindow = false) {
  if (id === binding && !newWindow) return;
  await act(() => send('ws.switch', { id, windowId, newWindow }));
  window.close();
}

function actionBtn(iconName, label, sub, fn, disabled = false) {
  return h('button.action', { onclick: fn, disabled }, icon(iconName), h('span', h('span.label', label), h('br'), h('span.sub', sub)));
}

function dupCount() {
  const s = data.settings;
  const seen = new Set();
  let n = 0;
  for (const t of tabs) {
    const k = normalizeUrl(t.url || t.pendingUrl, { ignoreHash: s.dupIgnoreHash, ignoreTracking: s.dupIgnoreTracking });
    if (!k) continue;
    if (seen.has(k)) n++; else seen.add(k);
  }
  return n;
}

function renderActions() {
  const win = tabs.filter(t => t.windowId === windowId);
  const selected = win.filter(t => t.highlighted).length;
  const others = win.filter(t => !t.active && !t.pinned).length;
  const dups = dupCount();
  const suspendable = win.filter(t => !t.active && !t.discarded).length;
  clear($('#actions'),
    actionBtn('inbox', 'Stash all tabs', plural(win.filter(t => !t.pinned).length, 'tab'), () => stash('all')),
    actionBtn('inbox', 'Stash other tabs', `${others} besides this one`, () => stash('others'), !others),
    actionBtn('inbox', 'Stash selected', selected > 1 ? `${selected} highlighted` : 'Shift-click tabs first', () => stash('selected'), selected < 2),
    actionBtn('moon', 'Suspend others', `${suspendable} in this window`, async () => {
      const n = await act(() => send('mem.suspendMany', { windowId }), r => `Suspended ${plural(r, 'tab')}`);
      load();
      return n;
    }, !suspendable),
    actionBtn('copy', 'Close duplicates', dups ? `${dups} found` : 'None open', async () => {
      await act(() => send('dup.closeAll', { scope: 'all' }), r => `Closed ${plural(r, 'duplicate')}`);
      load();
    }, !dups),
    actionBtn('camera', 'Snapshot session', 'Back up all windows', () => act(() => send('session.snapshot'), 'Session saved')),
  );
}

async function stash(which) {
  const r = await act(() => send('stash.tabs', { windowId, which }));
  toast(`Stashed ${plural(r.count, 'tab')}`, { action: 'View', onAction: () => send('ui.dashboard', { hash: 'stash' }) });
  setTimeout(load, 300);
}

function renderStats() {
  const wins = new Set(tabs.map(t => t.windowId)).size;
  const suspended = tabs.filter(t => t.discarded).length;
  const stashed = data.stashes.reduce((n, s) => n + s.tabs.length, 0);
  clear($('#stats'),
    h('span', h('b', tabs.length), ' tabs'),
    h('span', h('b', wins), wins === 1 ? ' window' : ' windows'),
    h('span', h('b', suspended), ' suspended'),
    h('span', h('b', stashed), ' stashed'));
}

// ---------- Search ----------
function buildResults(q) {
  const out = [];
  const ws = fuzzyFilter(data.workspaces, q, w => [w.name], 4);
  if (ws.length) out.push({ group: 'Workspaces', items: ws.map(w => ({ kind: 'ws', w, title: w.name, sub: plural(w.tabs.length, 'tab') })) });
  const open = fuzzyFilter(tabs, q, t => [t.title, t.url], 6);
  if (open.length) out.push({ group: 'Open tabs', items: open.map(t => ({ kind: 'tab', t, title: t.title || t.url, sub: t.url, url: t.url })) });
  const stashTabs = data.stashes.flatMap(s => s.tabs.map(t => ({ ...t, stash: s })));
  const st = fuzzyFilter(stashTabs, q, t => [t.title, t.url], 4);
  if (st.length) out.push({ group: 'Stash', items: st.map(t => ({ kind: 'stash', t, title: t.title, sub: `${t.stash.name} · ${t.url}`, url: t.url })) });
  const ar = fuzzyFilter(data.archive, q, a => [a.title, a.url], 4);
  if (ar.length) out.push({ group: 'Recently closed', items: ar.map(a => ({ kind: 'archive', a, title: a.title, sub: `${relTime(a.closedAt)} · ${a.url}`, url: a.url })) });
  return out;
}

function renderResults() {
  const q = $('#q').value.trim();
  const box = $('#results');
  $('#home').hidden = !!q;
  box.hidden = !q;
  if (!q) return;
  const groups = buildResults(q);
  results = groups.flatMap(g => g.items);
  sel = Math.min(sel, Math.max(0, results.length - 1));
  if (!results.length) { clear(box, h('div.empty', h('p', 'Nothing matches “' + q + '”.'))); return; }
  let i = 0;
  clear(box, groups.map(g => h('div.res-group', h('h3', g.group), g.items.map(item => {
    const idx = i++;
    return h('button.tab-row.res-item', {
      role: 'option', 'aria-selected': String(idx === sel), onclick: () => choose(item),
      onmousemove: () => { if (sel !== idx) { sel = idx; highlight(); } },
    },
      item.kind === 'ws' ? colorDot(item.w.color) : fav(item.url),
      h('span.txt', h('span.title', item.title), h('span.sub', item.sub)));
  }))));
}

function highlight() {
  document.querySelectorAll('.res-item').forEach((el, i) => {
    el.setAttribute('aria-selected', String(i === sel));
    if (i === sel) el.scrollIntoView({ block: 'nearest' });
  });
}

async function choose(item) {
  if (!item) return;
  if (item.kind === 'ws') return switchTo(item.w.id);
  if (item.kind === 'tab') {
    await chrome.tabs.update(item.t.id, { active: true });
    await chrome.windows.update(item.t.windowId, { focused: true });
  } else if (item.kind === 'stash') {
    await send('stash.restoreTab', { stashId: item.t.stash.id, tabId: item.t.id, windowId });
    const [t] = await chrome.tabs.query({ windowId, url: item.url }).catch(() => []);
    if (t) await chrome.tabs.update(t.id, { active: true });
  } else {
    await chrome.tabs.create({ url: item.url, windowId });
  }
  window.close();
}

$('#q').addEventListener('input', () => { sel = 0; renderResults(); });
$('#q').addEventListener('keydown', e => {
  if (!$('#q').value.trim()) return;
  if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); highlight(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); highlight(); e.preventDefault(); }
  else if (e.key === 'Enter') { choose(results[sel]); e.preventDefault(); }
  else if (e.key === 'Escape') { $('#q').value = ''; renderResults(); e.preventDefault(); }
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[1-9]$/.test(e.key)) {
    const ws = data.workspaces[+e.key - 1];
    if (ws) { e.preventDefault(); switchTo(ws.id); }
  } else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
});

// ---------- New workspace ----------
async function newWorkspace(source) {
  const values = await dialog({
    title: source === 'window' ? 'Save window as workspace' : source === 'selected' ? 'Workspace from selected tabs' : 'New empty workspace',
    fields: [{ name: 'name', label: 'Name', placeholder: 'e.g. Thesis research', required: true }, { name: 'color', label: 'Color', type: 'color', value: 'blue' }],
    okLabel: 'Create',
  });
  if (!values) return;
  await act(() => send('ws.create', { name: values.name, color: values.color, source, windowId, switchTo: source === 'empty' }), `Workspace “${values.name}” created`);
  load();
}
$('#new-window').addEventListener('click', () => newWorkspace('window'));
$('#new-selected').addEventListener('click', () => newWorkspace('selected'));
$('#new-empty').addEventListener('click', () => newWorkspace('empty'));
$('#open-dashboard').addEventListener('click', async () => { await send('ui.dashboard'); window.close(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.workspaces || changes.stashes || changes.settings)) load();
});

load().then(() => $('#q').focus());
