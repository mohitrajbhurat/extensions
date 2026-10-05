import { h, icon, send, act, fav, clear, confirmDialog } from '../../shared/ui.js';
import { plural, fuzzyFilter, hostOf } from '../../lib/util.js';
import { viewHead, searchBox, emptyState, openUrl, highlightText, menuButton } from '../common.js';

let ctx, listEl, countEl;
let query = '';
let range = 'all';
let limit = 200;

const RANGES = { today: 'Today', week: '7 days', month: '30 days', all: 'All' };

function since() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (range === 'today') return d.getTime();
  if (range === 'week') return Date.now() - 7 * 86400000;
  if (range === 'month') return Date.now() - 30 * 86400000;
  return 0;
}

function dayLabel(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function row(a) {
  return h('div.tab-row',
    fav(a.url),
    h('a.title', { href: a.url, title: a.url, onclick: e => { e.preventDefault(); openUrl(a.url, !(e.metaKey || e.ctrlKey)); } }, highlightText(a.title || a.url, query)),
    h('span.meta', highlightText(hostOf(a.url), query)),
    h('span.meta', { title: new Date(a.closedAt).toLocaleString() }, new Date(a.closedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
    h('div.actions',
      h('button.icon-btn.danger', { title: 'Remove from archive', 'aria-label': 'Remove from archive', onclick: () => act(() => send('archive.delete', { ids: [a.id] })) }, icon('x'))));
}

function update(c) {
  ctx = c;
  const all = ctx.data.archive;
  if (!all.length) {
    countEl.textContent = '';
    clear(listEl, emptyState('archive', 'Nothing archived yet', ctx.data.settings.archiveEnabled
      ? 'Every tab you close is recorded here with the time, so you can find it again with a fuzzy search.'
      : 'The archive is turned off in Settings.'));
    return;
  }
  const from = since();
  let items = from ? all.filter(a => a.closedAt >= from) : all;
  if (query) items = fuzzyFilter(items, query, a => [a.title, a.url]);
  countEl.textContent = query || from ? `${plural(items.length, 'match', 'matches')} of ${all.length}` : plural(all.length, 'closed tab');
  const shown = items.slice(0, limit);
  const out = [];
  if (query) out.push(...shown.map(row));
  else {
    let last = '';
    for (const a of shown) {
      const lbl = dayLabel(a.closedAt);
      if (lbl !== last) { out.push(h('div.day-head', lbl)); last = lbl; }
      out.push(row(a));
    }
  }
  if (items.length > limit) out.push(h('div', { style: { textAlign: 'center', padding: '16px' } }, h('button.btn', { onclick: () => { limit += 300; update(ctx); } }, `Show more (${items.length - limit} left)`)));
  clear(listEl, out.length ? h('div.card', h('div.card-body', { style: { borderTop: 0 } }, out)) : h('p.muted', 'No closed tabs match.'));
}

export default {
  id: 'archive', label: 'Archive', icon: 'archive', key: 'a',
  count: c => c.data.archive.length,
  mount(el, c) {
    ctx = c;
    listEl = h('div');
    countEl = h('span.faint.small');
    const seg = h('div.seg', { role: 'group', 'aria-label': 'Time range' }, Object.entries(RANGES).map(([k, v]) =>
      h('button', { type: 'button', 'aria-pressed': String(range === k), onclick: e => {
        range = k; limit = 200;
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        update(ctx);
      } }, v)));
    el.append(
      viewHead('Archive', 'Every tab you closed, newest first. Type a few letters from the title or address; the search is fuzzy, so “gh pr” finds “GitHub pull request”.'),
      h('div.toolbar',
        searchBox('Fuzzy search closed tabs', query, v => { query = v; limit = 200; update(ctx); }),
        seg, countEl, h('span.spacer'),
        menuButton([
          { label: 'Clear entries older than 30 days', icon: 'trash', onClick: async () => {
            if (await confirmDialog('Clear old entries?', 'Archive entries older than 30 days will be deleted.', 'Clear')) await act(() => send('archive.clear', { olderThan: Date.now() - 30 * 86400000 }), 'Old entries cleared');
          } },
          { label: 'Clear entire archive', icon: 'trash', danger: true, onClick: async () => {
            if (await confirmDialog('Clear the whole archive?', 'All closed-tab history kept by Tab Workspaces will be deleted.', 'Clear all')) await act(() => send('archive.clear'), 'Archive cleared');
          } },
        ], 'Archive actions')),
      listEl);
    update(c);
    setTimeout(() => el.querySelector('[data-search]')?.focus(), 0);
  },
  update,
};
