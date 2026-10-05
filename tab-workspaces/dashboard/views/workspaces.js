import { h, icon, send, act, fav, clear, colorDot, dialog, confirmDialog } from '../../shared/ui.js';
import { COLOR_HEX, plural, relTime, fuzzyFilter, isMeaningfulUrl } from '../../lib/util.js';
import { menuButton, viewHead, searchBox, emptyState, openUrl, highlightText } from '../common.js';

let root, listEl, ctx;
let query = '';
const expanded = new Set();
let dragId = null;

function openWindowOf(wsId) {
  for (const [w, id] of Object.entries(ctx.bindings)) if (id === wsId) return +w;
  return null;
}

async function createDialog() {
  const v = await dialog({
    title: 'New workspace',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Client launch', required: true },
      { name: 'color', label: 'Color', type: 'color', value: 'blue' },
      { name: 'source', label: 'Start with', type: 'select', value: 'window', options: [
        { value: 'window', label: 'All tabs in this window (and keep working here)' },
        { value: 'selected', label: 'Selected (highlighted) tabs in this window' },
        { value: 'empty', label: 'Nothing: an empty workspace' },
      ] },
    ],
    okLabel: 'Create',
  });
  if (!v) return;
  await act(() => send('ws.create', { name: v.name, color: v.color, source: v.source, windowId: ctx.windowId }), `Created “${v.name}”`);
}

async function editDialog(ws) {
  const v = await dialog({
    title: 'Edit workspace',
    fields: [{ name: 'name', label: 'Name', value: ws.name, required: true }, { name: 'color', label: 'Color', type: 'color', value: ws.color }],
    okLabel: 'Save',
  });
  if (v) await act(() => send('ws.update', { id: ws.id, patch: v }));
}

function card(ws) {
  const openIn = openWindowOf(ws.id);
  const isHere = openIn === ctx.windowId;
  const isExpanded = expanded.has(ws.id);
  const live = openIn != null ? ctx.tabs.filter(t => t.windowId === openIn && isMeaningfulUrl(t.url || t.pendingUrl) && !(t.url || '').startsWith(chrome.runtime.getURL(''))) : null;
  const tabs = ws.tabs;
  const groupCount = ws.groups?.length || 0;

  const head = h('div.card-head',
    h('div.grow',
      h('button.ws-name-btn', { onclick: () => toggle(ws.id), 'aria-expanded': String(isExpanded), title: 'Show tabs' },
        h('div.card-title', highlightText(ws.name, query))),
      h('div.card-sub', [
        plural(live ? live.length : tabs.length, 'tab'),
        groupCount ? ` · ${plural(groupCount, 'group')}` : '',
        ws.lastOpenedAt ? ` · opened ${relTime(ws.lastOpenedAt)}` : ' · never opened',
      ].join(''))),
    openIn != null ? h('span.badge-open', isHere ? 'This window' : 'Open') : null,
    menuButton([
      { label: 'Rename / color', icon: 'edit', onClick: () => editDialog(ws) },
      { label: 'Replace with this window’s tabs', icon: 'save', onClick: async () => {
        if (await confirmDialog('Replace workspace tabs?', `“${ws.name}” will be overwritten with the tabs in this window, and this window will become “${ws.name}”.`, 'Replace')) {
          await act(() => send('ws.save', { id: ws.id, windowId: ctx.windowId }), 'Workspace updated');
        }
      } },
      { label: 'Duplicate', icon: 'copy', onClick: () => act(() => send('ws.duplicate', { id: ws.id })) },
      openIn != null ? { label: 'Save and close in its window', icon: 'x', onClick: () => act(() => send('ws.close', { windowId: openIn }), 'Workspace closed') } : null,
      'sep',
      { label: 'Delete workspace', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog(`Delete “${ws.name}”?`, `Its ${plural(ws.tabs.length, 'saved tab')} will be removed. Open tabs stay open.`)) await act(() => send('ws.delete', { id: ws.id }), 'Workspace deleted');
      } },
    ], `Actions for ${ws.name}`));

  const favs = h('div.favs', tabs.slice(0, 18).map(t => { const f = fav(t.url); f.title = t.title; return f; }),
    tabs.length > 18 ? h('span.more', `+${tabs.length - 18}`) : null,
    !tabs.length ? h('span.faint.small', 'Empty workspace') : null);

  const actions = h('div.ws-actions',
    isHere ? h('button.btn.sm', { disabled: true }, icon('check'), 'Active here') :
      h('button.btn.sm.primary', { onclick: () => act(() => send('ws.switch', { id: ws.id, windowId: ctx.windowId })) },
        openIn != null ? 'Go to window' : 'Switch here'),
    openIn == null ? h('button.btn.sm', { onclick: () => act(() => send('ws.switch', { id: ws.id, newWindow: true })) }, icon('window'), 'New window') : null,
    h('button.btn.sm.ghost', { onclick: () => toggle(ws.id), 'aria-expanded': String(isExpanded) }, isExpanded ? 'Hide tabs' : 'Show tabs'));

  const body = isExpanded ? h('div.card-body', tabList(ws)) : null;

  const el = h('article.card.ws-card' + (openIn != null ? '.is-open' : ''), {
    style: { '--ws-color': COLOR_HEX[ws.color] || ws.color }, draggable: true, dataset: { id: ws.id },
  }, head, favs, actions, body);
  el.addEventListener('dragstart', e => {
    if (e.target !== el) return;
    dragId = ws.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ws.id);
  });
  el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); listEl.querySelectorAll('.drop-before').forEach(x => x.classList.remove('drop-before')); });
  el.addEventListener('dragover', e => { if (dragId && dragId !== ws.id) { e.preventDefault(); el.classList.add('drop-before'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drop-before');
    if (!dragId || dragId === ws.id) return;
    const ids = ctx.data.workspaces.map(w => w.id).filter(id => id !== dragId);
    ids.splice(ids.indexOf(ws.id), 0, dragId);
    act(() => send('ws.reorder', { ids }));
  });
  return el;
}

function tabList(ws) {
  if (!ws.tabs.length) return h('p.faint.small', { style: { padding: '8px' } }, 'No saved tabs yet.');
  const rows = [];
  let lastGroup = -2;
  ws.tabs.forEach((t, i) => {
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      const g = ws.groups?.[t.group];
      if (g) rows.push(h('div.group-label', colorDot(g.color), g.title || 'Unnamed group'));
      else if (i > 0) rows.push(h('div.group-label', 'Ungrouped'));
    }
    rows.push(h('div.tab-row',
      fav(t.url),
      h('a.title', { href: t.url, title: t.url, onclick: e => { e.preventDefault(); openUrl(t.url, !e.metaKey && !e.ctrlKey); } }, highlightText(t.title || t.url, query)),
      t.pinned ? h('span.flag', 'Pinned') : null,
      h('div.actions',
        h('button.icon-btn.danger', { title: 'Remove from workspace', 'aria-label': 'Remove from workspace', onclick: () => act(() => send('ws.removeTab', { id: ws.id, index: i })) }, icon('x')))));
  });
  return rows;
}

function toggle(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  update(ctx);
}

function update(c) {
  ctx = c;
  const list = fuzzyFilter(ctx.data.workspaces, query, w => [w.name, ...w.tabs.map(t => t.title)]);
  if (!ctx.data.workspaces.length) {
    clear(listEl, emptyState('layers', 'No workspaces yet',
      'A workspace is a named set of tabs for one project. Save this window as a workspace, then switch between projects without losing a tab.',
      h('button.btn.primary', { onclick: createDialog }, icon('plus'), 'Create your first workspace')));
    listEl.className = '';
    return;
  }
  listEl.className = 'ws-grid';
  if (!list.length) { clear(listEl, h('p.muted', `No workspace matches “${query}”.`)); return; }
  if (query) list.forEach(w => { if (w.tabs.some(t => (t.title || '').toLowerCase().includes(query.toLowerCase()))) expanded.add(w.id); });
  clear(listEl, list.map(card));
}

export default {
  id: 'workspaces', label: 'Workspaces', icon: 'layers', key: 'w',
  count: c => c.data.workspaces.length,
  mount(el, c) {
    ctx = c;
    listEl = h('div');
    root = h('div',
      viewHead('Workspaces', 'Named sets of tabs, one per project. Switching saves the current window and swaps in the other workspace, groups included.',
        h('button.btn.primary', { onclick: createDialog }, icon('plus'), 'New workspace')),
      h('div.toolbar', searchBox('Filter workspaces and their tabs', query, v => { query = v; update(ctx); })),
      listEl);
    el.append(root);
    update(c);
  },
  update,
};
