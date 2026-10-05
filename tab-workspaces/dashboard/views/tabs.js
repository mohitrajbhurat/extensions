import { h, icon, send, act, fav, clear, toast, dialog } from '../../shared/ui.js';
import { COLOR_HEX, plural, normalizeUrl, fuzzyFilter, hostOf } from '../../lib/util.js';
import { viewHead, searchBox, menuButton, highlightText } from '../common.js';

let ctx, tilesEl, listEl, bulkEl;
let query = '';
let onlyDups = false;
let reasons = {};
const selected = new Set();

function dupKeys() {
  const s = ctx.data.settings;
  const count = new Map();
  const keyOf = new Map();
  for (const t of ctx.tabs) {
    const k = normalizeUrl(t.url || t.pendingUrl, { ignoreHash: s.dupIgnoreHash, ignoreTracking: s.dupIgnoreTracking });
    if (!k) continue;
    keyOf.set(t.id, k);
    count.set(k, (count.get(k) || 0) + 1);
  }
  return { isDup: id => (count.get(keyOf.get(id)) || 0) > 1, extra: [...count.values()].reduce((n, c) => n + c - 1, 0) };
}

function tile(num, lbl, warn = false) {
  return h('div.card.tile' + (warn ? '.warn' : ''), h('div.num', String(num)), h('div.lbl', lbl));
}

function renderTiles(d) {
  const suspended = ctx.tabs.filter(t => t.discarded).length;
  const wins = new Set(ctx.tabs.map(t => t.windowId)).size;
  clear(tilesEl,
    tile(ctx.tabs.length, 'Open tabs', ctx.tabs.length >= (+ctx.data.settings.badgeWarnAt || 50)),
    tile(wins, wins === 1 ? 'Window' : 'Windows'),
    tile(suspended, 'Suspended now'),
    tile(d.extra, 'Duplicate tabs', d.extra > 0),
    tile(ctx.data.stats.discarded || 0, 'Suspended (all time)'),
    tile(ctx.data.stats.dupsClosed || 0, 'Duplicates closed'));
}

async function bulk(action) {
  const ids = [...selected].filter(id => ctx.tabs.some(t => t.id === id));
  if (!ids.length) return;
  if (action === 'close') { await chrome.tabs.remove(ids); toast(`Closed ${plural(ids.length, 'tab')}`); }
  if (action === 'suspend') {
    let n = 0;
    for (const id of ids) if (await send('mem.suspendTab', { tabId: id }).catch(() => false)) n++;
    toast(`Suspended ${plural(n, 'tab')}`);
  }
  if (action === 'stash') {
    const byWin = new Map();
    for (const id of ids) { const t = ctx.tabs.find(x => x.id === id); if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(id); }
    let n = 0;
    for (const [windowId, tabIds] of byWin) n += (await send('stash.tabs', { windowId, which: 'tabs', tabIds })).count;
    toast(`Stashed ${plural(n, 'tab')}`);
  }
  if (action === 'workspace') {
    if (!ctx.data.workspaces.length) { toast('Create a workspace first', { error: true }); return; }
    const v = await dialog({ title: 'Add tabs to workspace', fields: [{ name: 'ws', label: 'Workspace', type: 'select', value: ctx.data.workspaces[0].id, options: ctx.data.workspaces.map(w => ({ value: w.id, label: w.name })) }], okLabel: 'Add' });
    if (!v) return;
    await act(() => send('ws.addTabs', { id: v.ws, tabIds: ids }), `Added ${plural(ids.length, 'tab')}`);
  }
  if (action === 'window') {
    const [first, ...rest] = ids;
    const w = await chrome.windows.create({ tabId: first });
    if (rest.length) await chrome.tabs.move(rest, { windowId: w.id, index: -1 });
  }
  selected.clear();
  ctx.refresh();
}

function renderBulk() {
  const n = [...selected].filter(id => ctx.tabs.some(t => t.id === id)).length;
  bulkEl.hidden = !n;
  if (!n) return;
  clear(bulkEl,
    h('b', `${n} selected`),
    h('span.spacer', { style: { flex: 1 } }),
    h('button.btn.sm', { onclick: () => bulk('stash') }, icon('inbox'), 'Stash'),
    h('button.btn.sm', { onclick: () => bulk('suspend') }, icon('moon'), 'Suspend'),
    h('button.btn.sm', { onclick: () => bulk('workspace') }, icon('layers'), 'Add to workspace'),
    h('button.btn.sm', { onclick: () => bulk('window') }, icon('window'), 'Move to new window'),
    h('button.btn.sm.danger', { onclick: () => bulk('close') }, icon('x'), 'Close'),
    h('button.btn.sm.ghost', { onclick: () => { selected.clear(); update(ctx); } }, 'Clear'));
}

function tabRow(t, d) {
  const g = t.groupId > -1 ? ctx.groups.get(t.groupId) : null;
  const own = (t.url || '').startsWith(chrome.runtime.getURL(''));
  const reason = reasons[t.id];
  const box = h('input', { type: 'checkbox', checked: selected.has(t.id), 'aria-label': 'Select tab', onchange: e => { e.target.checked ? selected.add(t.id) : selected.delete(t.id); renderBulk(); } });
  return h('div.tab-row' + (t.active ? '.is-active' : '') + (t.discarded ? '.is-discarded' : ''),
    box,
    fav(t.url),
    h('a.title', { href: t.url, title: `${t.title}\n${t.url}`, onclick: async e => { e.preventDefault(); await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } },
      highlightText(t.title || t.url, query)),
    g ? h('span.group-chip', { style: { background: COLOR_HEX[g.color] } }, g.title || 'Group') : null,
    t.pinned ? h('span.flag', 'Pinned') : null,
    t.audible ? h('span.flag', 'Audio') : null,
    t.discarded ? h('span.flag.sleep', 'Suspended') : null,
    d.isDup(t.id) ? h('span.flag.dup', 'Duplicate') : null,
    !t.discarded && reason && reason !== 'active' && reason !== 'browser page' ? h('span.flag', { title: 'Memory saver will not suspend this tab' }, reason) : null,
    h('span.meta', own ? 'Tab Workspaces' : hostOf(t.url)),
    h('div.actions',
      !own && !t.discarded ? h('button.icon-btn', { title: 'Suspend now', 'aria-label': 'Suspend now', onclick: () => act(() => send('mem.suspendTab', { tabId: t.id }), r => (r ? 'Tab suspended' : 'This tab cannot be suspended')) }, icon('moon')) : null,
      !own ? h('button.icon-btn', { title: 'Stash', 'aria-label': 'Stash tab', onclick: () => act(() => send('stash.tabs', { windowId: t.windowId, which: 'tabs', tabIds: [t.id] }), 'Tab stashed') }, icon('inbox')) : null,
      h('button.icon-btn.danger', { title: 'Close tab', 'aria-label': 'Close tab', onclick: () => chrome.tabs.remove(t.id) }, icon('x'))));
}

function update(c) {
  ctx = c;
  const d = dupKeys();
  renderTiles(d);
  const byWin = new Map();
  let tabs = ctx.tabs;
  if (onlyDups) tabs = tabs.filter(t => d.isDup(t.id));
  if (query) tabs = fuzzyFilter(tabs, query, t => [t.title, t.url]);
  for (const t of tabs) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t); }
  const winIds = [...new Set(ctx.tabs.map(t => t.windowId))];
  const cards = [];
  winIds.forEach((wid, i) => {
    const list = byWin.get(wid);
    if (!list) return;
    if (!query) list.sort((a, b) => a.index - b.index);
    const wsId = ctx.bindings[wid];
    const ws = ctx.data.workspaces.find(w => w.id === wsId);
    const all = ctx.tabs.filter(t => t.windowId === wid);
    cards.push(h('section.card',
      h('div.card-head',
        h('div.grow',
          h('div.card-title', `Window ${i + 1}`, wid === ctx.windowId ? h('span.faint', ' · this window') : null, ws ? h('span', ' · ', h('span', { style: { color: COLOR_HEX[ws.color] } }, ws.name)) : null),
          h('div.card-sub', `${plural(all.length, 'tab')} · ${all.filter(t => t.discarded).length} suspended`)),
        h('button.btn.sm', { onclick: () => { const allSel = list.every(t => selected.has(t.id)); list.forEach(t => allSel ? selected.delete(t.id) : selected.add(t.id)); update(ctx); } }, 'Select all'),
        menuButton([
          { label: 'Suspend background tabs', icon: 'moon', onClick: () => act(() => send('mem.suspendMany', { windowId: wid }), r => `Suspended ${plural(r, 'tab')}`) },
          { label: 'Close duplicates in this window', icon: 'copy', onClick: () => act(() => send('dup.closeAll', { scope: 'window', windowId: wid }), r => `Closed ${plural(r, 'duplicate')}`) },
          { label: 'Group tabs by site', icon: 'folder', onClick: () => act(() => send('rules.groupByDomain', { windowId: wid }), r => r ? `Created ${plural(r, 'group')}` : 'No site has 2 or more ungrouped tabs') },
          { label: 'Stash this window', icon: 'inbox', onClick: () => act(() => send('stash.tabs', { windowId: wid, which: 'all' }), r => `Stashed ${plural(r.count, 'tab')}`) },
          !ws ? { label: 'Save as workspace…', icon: 'layers', onClick: async () => {
            const v = await dialog({ title: 'Save window as workspace', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'color', label: 'Color', type: 'color', value: 'blue' }], okLabel: 'Save' });
            if (v) await act(() => send('ws.create', { ...v, source: 'window', windowId: wid }), 'Workspace saved');
          } } : null,
        ], 'Window actions')),
      h('div.card-body', list.map(t => tabRow(t, d)))));
  });
  clear(listEl, cards.length ? cards : h('p.muted', onlyDups ? 'No duplicate tabs open. Nice.' : `No open tab matches “${query}”.`));
  renderBulk();
}

async function loadReasons() {
  try { reasons = await send('mem.reasons'); } catch { reasons = {}; }
}

export default {
  id: 'tabs', label: 'Open tabs', icon: 'tabs', key: 't',
  count: c => c.tabs.length,
  mount(el, c) {
    ctx = c;
    tilesEl = h('div.tiles');
    listEl = h('div.stack');
    bulkEl = h('div.bulkbar', { hidden: true });
    const dupToggle = h('button.btn', { 'aria-pressed': String(onlyDups), onclick: () => { onlyDups = !onlyDups; dupToggle.setAttribute('aria-pressed', String(onlyDups)); dupToggle.classList.toggle('primary', onlyDups); update(ctx); } }, 'Only duplicates');
    if (onlyDups) dupToggle.classList.add('primary');
    el.append(
      viewHead('Open tabs', 'Everything open right now, across windows. Find duplicates, suspend memory hogs, or select tabs to stash, move or close in bulk.',
        h('button.btn', { onclick: () => act(() => send('dup.closeAll', { scope: 'all' }), r => `Closed ${plural(r, 'duplicate')}`) }, icon('copy'), 'Close all duplicates'),
        h('button.btn', { onclick: () => act(() => send('mem.suspendMany', {}), r => `Suspended ${plural(r, 'tab')}`) }, icon('moon'), 'Suspend all background tabs')),
      tilesEl,
      h('div.toolbar',
        searchBox('Filter open tabs', query, v => { query = v; update(ctx); }),
        dupToggle,
        h('button.btn', { onclick: () => act(() => send('rules.applyAll'), r => `Grouped ${plural(r, 'tab')} by your rules`) }, icon('folder'), 'Apply grouping rules')),
      listEl, bulkEl);
    update(c);
    loadReasons().then(() => update(ctx));
  },
  update(c) { update(c); clearTimeout(this._t); this._t = setTimeout(() => loadReasons().then(() => update(ctx)), 800); },
};
