import { h, icon, send, act, fav, clear, dialog, confirmDialog, colorDot } from '../../shared/ui.js';
import { plural, fmtDateTime, relTime, fuzzyFilter } from '../../lib/util.js';
import { viewHead, menuButton, emptyState, searchBox, openUrl, highlightText } from '../common.js';

let ctx, listEl, infoEl;
const expanded = new Set();
let query = '';

const KIND = { auto: 'Auto', manual: 'Manual', previous: 'Before browser closed' };

function windowsBlock(sess) {
  return sess.windows.map((w, wi) => {
    const tabs = query ? fuzzyFilter(w.tabs, query, t => [t.title, t.url]) : w.tabs;
    if (!tabs.length) return null;
    return h('div',
      h('div.win-head', icon('window'), `Window ${wi + 1} · ${plural(w.tabs.length, 'tab')}`,
        h('button.btn.sm.ghost', { onclick: () => act(() => send('session.restore', { id: sess.id, windowIndex: wi }), 'Window restored') }, 'Restore window')),
      tabs.map(t => {
        const g = t.group > -1 ? w.groups?.[t.group] : null;
        return h('div.tab-row', fav(t.url),
          h('a.title', { href: t.url, title: t.url, onclick: e => { e.preventDefault(); openUrl(t.url, false); } }, highlightText(t.title || t.url, query)),
          g ? h('span.chip', colorDot(g.color), g.title || 'Group') : null,
          t.pinned ? h('span.flag', 'Pinned') : null);
      }));
  });
}

function sessionCard(sess, isLive = false) {
  const open = expanded.has(sess.id) || !!query;
  const title = isLive ? 'Right now (live backup)' : (sess.name || fmtDateTime(sess.createdAt));
  const sub = isLive
    ? `Updated ${relTime(sess.savedAt)} · ${plural(sess.windows.length, 'window')} · ${plural(sess.tabCount, 'tab')}`
    : `${sess.name ? fmtDateTime(sess.createdAt) + ' · ' : ''}${plural(sess.windows.length, 'window')} · ${plural(sess.tabCount, 'tab')}${sess.confirmedAt && sess.confirmedAt - sess.createdAt > 60000 ? ` · unchanged until ${relTime(sess.confirmedAt)}` : ''}`;
  const id = isLive ? 'live' : sess.id;
  return h('section.card',
    h('div.card-head',
      isLive ? h('span.kind.manual', 'Live') : h('span.kind.' + sess.kind, KIND[sess.kind] || sess.kind),
      h('div.grow',
        h('button.ws-name-btn', { onclick: () => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); update(ctx); }, 'aria-expanded': String(open) },
          h('div.card-title', title)),
        h('div.card-sub', sub)),
      !isLive ? h('button.icon-btn' + (sess.starred ? '.starred-icon' : ''), {
        title: sess.starred ? 'Kept forever (unstar to allow cleanup)' : 'Star to keep this snapshot forever', 'aria-label': 'Star', 'aria-pressed': String(!!sess.starred),
        onclick: () => act(() => send('session.update', { id: sess.id, patch: { starred: !sess.starred } })),
      }, icon('star')) : null,
      h('button.btn.sm', { onclick: () => act(() => send('session.restore', { id }), `Restored ${plural(sess.windows.length, 'window')}`) }, icon('restore'), 'Restore'),
      !isLive ? menuButton([
        { label: 'Rename', icon: 'edit', onClick: async () => {
          const v = await dialog({ title: 'Rename session', fields: [{ name: 'name', label: 'Name', value: sess.name || '' }], okLabel: 'Save' });
          if (v) await act(() => send('session.update', { id: sess.id, patch: { name: v.name } }));
        } },
        { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
          if (await confirmDialog('Delete this snapshot?', 'This cannot be undone.')) await act(() => send('session.delete', { id: sess.id }));
        } },
      ], 'Session actions') : null),
    open ? h('div.card-body', windowsBlock(sess)) : null);
}

function update(c) {
  ctx = c;
  const s = ctx.data.settings;
  clear(infoEl, s.sessionsEnabled
    ? `Automatic snapshots every ${plural(+s.sessionIntervalMin, 'minute')}, keeping the latest ${s.sessionMaxCount} (starred ones are kept forever). The state of all windows is also backed up continuously and offered here after the browser closes or crashes.`
    : 'Automatic snapshots are off. Turn them on in Settings.');
  let list = ctx.data.sessions;
  if (query) list = list.filter(se => se.windows.some(w => fuzzyFilter(w.tabs, query, t => [t.title, t.url]).length));
  const cards = [];
  if (ctx.data.liveSession && !query) cards.push(sessionCard(ctx.data.liveSession, true));
  cards.push(...list.map(se => sessionCard(se)));
  if (!cards.length) {
    clear(listEl, query ? h('p.muted', `No snapshot contains “${query}”.`) : emptyState('clock', 'No snapshots yet', 'Snapshots of all your windows appear here automatically. Take one now to have a restore point.',
      h('button.btn.primary', { onclick: snap }, icon('camera'), 'Snapshot now')));
    return;
  }
  clear(listEl, cards);
}

const snap = () => act(() => send('session.snapshot'), 'Snapshot saved');

export default {
  id: 'sessions', label: 'Sessions', icon: 'clock', key: 'e',
  count: c => c.data.sessions.length,
  mount(el, c) {
    ctx = c;
    infoEl = h('p.muted.small', { style: { marginBottom: '16px' } });
    listEl = h('div.stack');
    el.append(
      viewHead('Sessions', 'Restore points for all your windows. Use them to recover after a crash or to bring back yesterday’s setup.',
        h('button.btn.primary', { onclick: snap }, icon('camera'), 'Snapshot now')),
      h('div.toolbar', searchBox('Find a tab in past sessions', query, v => { query = v; update(ctx); })),
      infoEl, listEl);
    update(c);
  },
  update,
};
