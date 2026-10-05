import { h, icon, send, act, fav, clear, dialog, confirmDialog, toast } from '../../shared/ui.js';
import { plural, fmtDateTime, fuzzyFilter, toOneTab, hostOf } from '../../lib/util.js';
import { menuButton, viewHead, searchBox, emptyState, download, highlightText } from '../common.js';

let ctx, listEl;
let query = '';
let drag = null; // {stashId, tabId}

function clearDropMarks() {
  listEl?.querySelectorAll('.drop-target, .drop-line').forEach(x => x.classList.remove('drop-target', 'drop-line'));
}

async function importOneTab() {
  const v = await dialog({
    title: 'Import from OneTab',
    message: 'In OneTab, choose “Export / Import URLs”, copy the list, and paste it here. Each block separated by a blank line becomes its own stash.',
    fields: [{ name: 'text', label: 'OneTab URLs', type: 'textarea', rows: 10, placeholder: 'https://example.com | Example Domain' }],
    okLabel: 'Import',
  });
  if (!v || !v.text.trim()) return;
  await act(() => send('data.importOneTab', { text: v.text }), r => `Imported ${plural(r.tabs, 'tab')} into ${plural(r.stashes, 'stash', 'stashes')}`);
}

function tabRow(stash, t, idx) {
  const row = h('div.tab-row', { draggable: true, dataset: { tab: t.id } },
    icon('grip', 'grip'),
    fav(t.url),
    h('a.title', {
      href: t.url, title: `${t.title}\n${t.url}\nClick to restore${ctx.data.settings.removeFromStashOnRestore ? ' (removes it from the stash)' : ''}`,
      onclick: e => {
        e.preventDefault();
        act(() => send('stash.restoreTab', { stashId: stash.id, tabId: t.id, keep: e.shiftKey }));
      },
    }, highlightText(t.title || t.url, query)),
    h('span.meta', hostOf(t.url)),
    h('div.actions',
      h('button.icon-btn', { title: 'Open, keep in stash', 'aria-label': 'Open and keep in stash', onclick: () => act(() => send('stash.restoreTab', { stashId: stash.id, tabId: t.id, keep: true })) }, icon('open')),
      h('button.icon-btn.danger', { title: 'Remove from stash', 'aria-label': 'Remove from stash', onclick: () => act(() => send('stash.removeTab', { stashId: stash.id, tabId: t.id })) }, icon('x'))));
  row.addEventListener('dragstart', e => {
    drag = { stashId: stash.id, tabId: t.id };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/uri-list', t.url);
    e.dataTransfer.setData('text/plain', t.url);
    listEl.querySelector('.new-stash-drop')?.removeAttribute('hidden');
  });
  row.addEventListener('dragend', () => {
    drag = null; row.classList.remove('dragging'); clearDropMarks();
    listEl.querySelector('.new-stash-drop')?.setAttribute('hidden', '');
  });
  row.addEventListener('dragover', e => {
    if (!drag || drag.tabId === t.id) return;
    e.preventDefault(); e.stopPropagation();
    clearDropMarks(); row.classList.add('drop-line');
  });
  row.addEventListener('drop', e => {
    if (!drag) return;
    e.preventDefault(); e.stopPropagation();
    const d = drag;
    clearDropMarks();
    let index = idx;
    if (d.stashId === stash.id) {
      const from = stash.tabs.findIndex(x => x.id === d.tabId);
      if (from < idx) index = idx - 1;
    }
    act(() => send('stash.move', { fromStashId: d.stashId, tabId: d.tabId, toStashId: stash.id, index }));
  });
  return row;
}

function stashCard(stash, visibleTabs) {
  const name = h('input.stash-name', { value: stash.name, 'aria-label': 'Stash name', maxLength: 120 });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = stash.name; name.blur(); } });
  name.addEventListener('change', () => act(() => send('stash.update', { stashId: stash.id, patch: { name: name.value } })));
  const others = ctx.data.stashes.filter(s => s.id !== stash.id);
  const card = h('section.card.stash-card', { dataset: { stash: stash.id } },
    h('div.card-head',
      h('button.icon-btn' + (stash.starred ? '.starred-icon' : ''), {
        title: stash.starred ? 'Starred: kept when restoring all' : 'Star to keep this list when you restore it',
        'aria-label': stash.starred ? 'Unstar' : 'Star', 'aria-pressed': String(!!stash.starred),
        onclick: () => act(() => send('stash.update', { stashId: stash.id, patch: { starred: !stash.starred } })),
      }, icon('star')),
      h('div.grow', name, h('div.card-sub', `${plural(stash.tabs.length, 'tab')} · ${fmtDateTime(stash.createdAt)}`)),
      h('button.btn.sm', { onclick: () => act(() => send('stash.restore', { stashId: stash.id }), `Restored ${plural(stash.tabs.length, 'tab')}`) }, icon('restore'), 'Restore all'),
      menuButton([
        { label: 'Restore in new window', icon: 'window', onClick: () => act(() => send('stash.restore', { stashId: stash.id, newWindow: true })) },
        { label: 'Open all, keep in stash', icon: 'open', onClick: () => act(() => send('stash.restore', { stashId: stash.id, keep: true })) },
        { label: 'Save as workspace', icon: 'layers', onClick: async () => {
          const ws = await act(() => send('ws.create', { name: stash.name, source: 'empty' }));
          await act(() => send('ws.update', { id: ws.id, patch: { tabs: stash.tabs.map(t => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: false, group: -1, active: false })) } }), `Workspace “${stash.name}” created`);
        } },
        { label: 'Copy as OneTab text', icon: 'copy', onClick: async () => { await navigator.clipboard.writeText(toOneTab([stash])); toast('Copied to clipboard'); } },
        ...(others.length ? ['sep', ...others.slice(0, 5).map(o => ({ label: `Merge into “${o.name.slice(0, 32)}”`, icon: 'inbox', onClick: () => act(() => send('stash.merge', { fromId: stash.id, intoId: o.id }), 'Merged') }))] : []),
        'sep',
        { label: 'Delete stash', icon: 'trash', danger: true, onClick: async () => {
          if (await confirmDialog('Delete this stash?', `${plural(stash.tabs.length, 'tab')} in “${stash.name}” will be deleted.`)) await act(() => send('stash.delete', { stashId: stash.id }), 'Stash deleted');
        } },
      ], `Actions for ${stash.name}`)),
    h('div.card-body', visibleTabs.map(t => tabRow(stash, t, stash.tabs.indexOf(t)))));
  card.addEventListener('dragover', e => { if (drag) { e.preventDefault(); if (!card.classList.contains('drop-target')) { clearDropMarks(); card.classList.add('drop-target'); } } });
  card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drop-target'); });
  card.addEventListener('drop', e => {
    if (!drag) return;
    e.preventDefault();
    const d = drag; clearDropMarks();
    if (d.stashId !== stash.id) act(() => send('stash.move', { fromStashId: d.stashId, tabId: d.tabId, toStashId: stash.id }));
  });
  return card;
}

function newStashDrop() {
  const z = h('div.new-stash-drop', { hidden: true }, 'Drop here to move the tab into a new stash');
  z.addEventListener('dragover', e => { if (drag) { e.preventDefault(); clearDropMarks(); z.classList.add('drop-target'); } });
  z.addEventListener('dragleave', () => z.classList.remove('drop-target'));
  z.addEventListener('drop', e => {
    if (!drag) return;
    e.preventDefault();
    const d = drag; clearDropMarks();
    act(() => send('stash.move', { fromStashId: d.stashId, tabId: d.tabId, toStashId: 'new' }));
  });
  return z;
}

function update(c) {
  ctx = c;
  if (drag) return; // don't rebuild mid-drag
  const stashes = ctx.data.stashes;
  if (!stashes.length) {
    clear(listEl, emptyState('inbox', 'Your stash is empty',
      'Stash tabs to close them without losing them. They land here as a dated list you can restore any time, like OneTab.',
      h('button.btn.primary', { onclick: () => stashFrom('others') }, 'Stash other tabs in this window'),
      h('button.btn', { onclick: importOneTab }, icon('upload'), 'Import from OneTab')));
    return;
  }
  const sorted = [...stashes].sort((a, b) => (b.starred - a.starred) || 0);
  const cards = [];
  for (const s of sorted) {
    let tabs = s.tabs;
    if (query) {
      tabs = fuzzyFilter(s.tabs, query, t => [t.title, t.url]);
      if (!tabs.length && !s.name.toLowerCase().includes(query.toLowerCase())) continue;
      if (!tabs.length) tabs = s.tabs;
    }
    cards.push(stashCard(s, tabs));
  }
  clear(listEl, newStashDrop(), cards.length ? cards : h('p.muted', `Nothing in the stash matches “${query}”.`));
}

async function stashFrom(which) {
  const r = await act(() => send('stash.tabs', { windowId: ctx.windowId, which }));
  toast(r.count ? `Stashed ${plural(r.count, 'tab')}` : 'No tabs to stash');
}

export default {
  id: 'stash', label: 'Stash', icon: 'inbox', key: 's',
  count: c => c.data.stashes.reduce((n, s) => n + s.tabs.length, 0),
  mount(el, c) {
    ctx = c;
    listEl = h('div.stack');
    const total = () => ctx.data.stashes.reduce((n, s) => n + s.tabs.length, 0);
    el.append(
      viewHead('Stash', 'Tabs you parked for later. Click a tab to restore it, Shift-click to open it and keep it here. Drag tabs between lists.',
        h('button.btn.primary', { onclick: () => stashFrom('all') }, icon('inbox'), 'Stash all tabs'),
        h('button.btn', { onclick: () => stashFrom('others') }, 'Stash other tabs')),
      h('div.toolbar',
        searchBox('Search stashed tabs', query, v => { query = v; update(ctx); }),
        h('span.spacer'),
        h('button.btn', { onclick: importOneTab }, icon('upload'), 'Import OneTab'),
        h('button.btn', { onclick: () => { if (!total()) { toast('Nothing to export'); return; } download(`stash-onetab-${new Date().toISOString().slice(0, 10)}.txt`, toOneTab(ctx.data.stashes), 'text/plain'); } }, icon('download'), 'Export as OneTab'),
        menuButton([
          { label: 'Remove duplicate URLs across stashes', icon: 'copy', onClick: () => act(() => send('stash.dedupe'), r => `Removed ${plural(r, 'duplicate')}`) },
          { label: 'Delete all unstarred stashes', icon: 'trash', danger: true, onClick: async () => {
            const victims = ctx.data.stashes.filter(s => !s.starred);
            if (!victims.length) return;
            if (await confirmDialog('Delete all unstarred stashes?', `${plural(victims.length, 'stash', 'stashes')} will be deleted. Starred stashes are kept.`)) {
              for (const s of victims) await send('stash.delete', { stashId: s.id });
              toast('Stashes deleted');
            }
          } },
        ], 'More stash actions')),
      listEl);
    update(c);
  },
  update,
};
