// Duplicate guard: catch tabs opened on a URL that is already open, and bulk-close duplicates.
import * as store from './store.js';
import { normalizeUrl } from './util.js';
import { quiet, tabUrl, closeTabs } from './tabs.js';

const created = new Map(); // tabId -> creation time (only freshly opened tabs are checked)
const checked = new Set();

export function noteCreated(tabId) {
  created.set(tabId, Date.now());
  setTimeout(() => created.delete(tabId), 20000);
}

function keyOpts(s) { return { ignoreHash: s.dupIgnoreHash, ignoreTracking: s.dupIgnoreTracking }; }

/** Called when a tab commits a URL. */
export async function check(tab) {
  chrome.storage.session.get('dbg').then(r => chrome.storage.session.set({ dbg: [...(r.dbg || []), [tab.id, tabUrl(tab), created.has(tab.id), quiet.opening.has(tab.id), checked.has(tab.id), quiet.windows.has(tab.windowId)]] }));
  if (!created.has(tab.id) || quiet.opening.has(tab.id) || checked.has(tab.id)) return;
  if (quiet.windows.has(tab.windowId)) return;
  const s = await store.getSettings();
  if (s.duplicateMode === 'off') return;
  const key = normalizeUrl(tabUrl(tab), keyOpts(s));
  if (!key) return;
  checked.add(tab.id);
  setTimeout(() => checked.delete(tab.id), 30000);
  const q = s.duplicateScope === 'window' ? { windowId: tab.windowId } : {};
  const others = (await chrome.tabs.query(q)).filter(t => t.id !== tab.id && normalizeUrl(tabUrl(t), keyOpts(s)) === key);
  if (!others.length) return;
  const existing = others.find(t => t.active) || others[0];
  if (s.duplicateMode === 'auto') {
    await focusTab(existing);
    await closeTabs([tab.id]);
    await store.update('stats', {}, st => { st.dupsClosed = (st.dupsClosed || 0) + 1; });
    flashBadge('DUP');
    return { action: 'closed', existing: existing.id };
  }
  await notify(tab, existing);
  return { action: 'notified', existing: existing.id };
}

async function focusTab(t) {
  try {
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } catch {}
}

let restoreBadge = () => {};
export function setBadgeRestorer(fn) { restoreBadge = fn; }

function flashBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  setTimeout(() => restoreBadge(), 1500);
}

async function notify(tab, existing) {
  const id = 'dup:' + tab.id + ':' + existing.id;
  await store.supdate('dupNotices', {}, m => { m[id] = { newTab: tab.id, existing: existing.id }; });
  if (!chrome.notifications) { flashBadge('DUP'); return; }
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'This page is already open',
      message: (tab.title && tab.title !== tabUrl(tab) ? tab.title : tabUrl(tab)).slice(0, 140),
      contextMessage: 'Tab Workspaces · duplicate guard',
      buttons: [{ title: 'Switch to open tab (close this one)' }, { title: 'Keep both' }],
      priority: 1,
    });
  } catch { flashBadge('DUP'); }
}

export async function onNotificationButton(id, index) {
  const m = await store.sget('dupNotices', {});
  const info = m[id];
  chrome.notifications.clear(id);
  await store.supdate('dupNotices', {}, x => { delete x[id]; });
  if (!info) return;
  if (index === 0) {
    try { await focusTab(await chrome.tabs.get(info.existing)); } catch {}
    await closeTabs([info.newTab]);
    await store.update('stats', {}, st => { st.dupsClosed = (st.dupsClosed || 0) + 1; });
  }
}

export async function onNotificationClosed(id) {
  await store.supdate('dupNotices', {}, x => { delete x[id]; });
}

/** Groups of duplicate tabs: [{key, tabs:[tab,...]}] (first tab is the one that will be kept). */
export async function findDuplicates(scope = 'all', windowId) {
  const s = await store.getSettings();
  const tabs = await chrome.tabs.query(scope === 'window' && windowId ? { windowId } : {});
  const map = new Map();
  for (const t of tabs) {
    const k = normalizeUrl(tabUrl(t), keyOpts(s));
    if (!k) continue;
    const bucket = scope === 'window' ? t.windowId + '|' + k : k;
    if (!map.has(bucket)) map.set(bucket, []);
    map.get(bucket).push(t);
  }
  const rank = t => (t.active ? 0 : 10) + (t.pinned ? 0 : 5) + (t.audible ? 0 : 3) + (t.discarded ? 1 : 0);
  const out = [];
  for (const [key, list] of map) {
    if (list.length < 2) continue;
    list.sort((a, b) => rank(a) - rank(b) || a.windowId - b.windowId || a.index - b.index);
    out.push({ key, tabs: list.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: tabUrl(t), active: t.active, pinned: t.pinned })) });
  }
  return out;
}

export async function closeAllDuplicates(scope = 'all', windowId) {
  const groups = await findDuplicates(scope, windowId);
  const ids = groups.flatMap(g => g.tabs.slice(1).filter(t => !t.pinned).map(t => t.id));
  if (ids.length) {
    try { await chrome.tabs.remove(ids); } catch {}
    await store.update('stats', {}, st => { st.dupsClosed = (st.dupsClosed || 0) + ids.length; });
  }
  return ids.length;
}
