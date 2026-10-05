// Tab stash (OneTab style): park tabs in dated lists and bring them back later.
import * as store from './store.js';
import { uid, isMeaningfulUrl } from './util.js';
import { serializeTab, closeTabs, openTabs, openInNewWindow, lastFocusedNormalWindow, tabUrl } from './tabs.js';

const KEY = 'stashes';

function defaultName(ts = Date.now()) {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function createStash(tabs, name) {
  const stash = {
    id: uid('st_'), name: name || '', createdAt: Date.now(), starred: false,
    tabs: tabs.map(t => ({ id: uid('t_'), url: t.url, title: t.title || t.url, favIconUrl: t.favIconUrl || '', pinned: !!t.pinned })),
  };
  if (!stash.name) stash.name = defaultName(stash.createdAt);
  await store.update(KEY, [], list => { list.unshift(stash); });
  return stash;
}

/**
 * Stash tabs from a window. which: 'all' | 'others' | 'selected' | 'tabs' (with tabIds).
 * Stashed tabs are closed. If the window would be left empty, the dashboard opens on the stash view.
 */
export async function stashTabs({ windowId, which = 'all', tabIds, name } = {}) {
  const s = await store.getSettings();
  const win = windowId ? { id: windowId } : await lastFocusedNormalWindow();
  if (!win) throw new Error('No browser window');
  const all = await chrome.tabs.query({ windowId: win.id });
  const dashUrl = chrome.runtime.getURL('dashboard/dashboard.html');
  let pick;
  switch (which) {
    case 'others': pick = all.filter(t => !t.active); break;
    case 'selected': pick = all.filter(t => t.highlighted); break;
    case 'tabs': pick = all.filter(t => tabIds?.includes(t.id)); break;
    default: pick = all;
  }
  if (!s.stashIncludePinned && which !== 'tabs') pick = pick.filter(t => !t.pinned);
  pick = pick.filter(t => !tabUrl(t).startsWith(dashUrl));
  const keepable = pick.filter(t => isMeaningfulUrl(tabUrl(t)));
  if (!pick.length) return { count: 0 };
  let stash = null;
  if (keepable.length) stash = await createStash(keepable.map(serializeTab), name);
  const remaining = all.filter(t => !pick.includes(t));
  if (!remaining.length) {
    await chrome.tabs.create({ windowId: win.id, url: dashUrl + '#stash', active: true });
  }
  // Blank tabs that were "stashed" are simply closed.
  await closeTabs(pick.map(t => t.id));
  return { count: keepable.length, stashId: stash?.id };
}

async function target(windowId) {
  if (windowId) return windowId;
  const w = await lastFocusedNormalWindow();
  return w ? w.id : (await chrome.windows.create({})).id;
}

export async function restoreTab(stashId, tabId, { windowId, keep } = {}) {
  const s = await store.getSettings();
  const list = await store.get(KEY, []);
  const st = list.find(x => x.id === stashId);
  const t = st?.tabs.find(x => x.id === tabId);
  if (!t) return;
  const wid = await target(windowId);
  await chrome.tabs.create({ windowId: wid, url: t.url, pinned: t.pinned, active: false });
  if (s.removeFromStashOnRestore && !keep) await removeTab(stashId, tabId);
}

export async function restoreStash(stashId, { windowId, newWindow = false, keep } = {}) {
  const s = await store.getSettings();
  const list = await store.get(KEY, []);
  const st = list.find(x => x.id === stashId);
  if (!st) return;
  const data = { tabs: st.tabs.map(t => ({ ...t, group: -1 })), groups: [] };
  if (newWindow) await openInNewWindow(data, { lazy: s.lazyRestore });
  else await openTabs(await target(windowId), data, { lazy: s.lazyRestore, activate: false });
  if (s.removeFromStashOnRestore && !keep && !st.starred) await deleteStash(stashId);
}

export async function removeTab(stashId, tabId) {
  await store.update(KEY, [], list => {
    const st = list.find(x => x.id === stashId);
    if (!st) return;
    st.tabs = st.tabs.filter(t => t.id !== tabId);
    if (!st.tabs.length && !st.starred) return list.filter(x => x.id !== stashId);
  });
}

export async function deleteStash(stashId) {
  await store.update(KEY, [], list => list.filter(x => x.id !== stashId));
}

export async function updateStash(stashId, patch) {
  await store.update(KEY, [], list => {
    const st = list.find(x => x.id === stashId);
    if (!st) return;
    if (typeof patch.name === 'string') st.name = patch.name.trim().slice(0, 120) || defaultName(st.createdAt);
    if (typeof patch.starred === 'boolean') st.starred = patch.starred;
  });
}

/** Move a stashed tab to another stash (or a new one when toStashId is 'new'), at an optional index. */
export async function moveTab(fromStashId, tabId, toStashId, index = -1) {
  await store.update(KEY, [], list => {
    const from = list.find(x => x.id === fromStashId);
    if (!from) return;
    const i = from.tabs.findIndex(t => t.id === tabId);
    if (i < 0) return;
    const [tab] = from.tabs.splice(i, 1);
    let to = list.find(x => x.id === toStashId);
    if (!to) {
      to = { id: uid('st_'), name: defaultName(), createdAt: Date.now(), starred: false, tabs: [] };
      list.unshift(to);
    }
    if (index < 0 || index > to.tabs.length) to.tabs.push(tab); else to.tabs.splice(index, 0, tab);
    if (!from.tabs.length && !from.starred && from !== to) return list.filter(x => x !== from);
  });
}

export async function mergeStashes(fromId, intoId) {
  await store.update(KEY, [], list => {
    const from = list.find(x => x.id === fromId), into = list.find(x => x.id === intoId);
    if (!from || !into || from === into) return;
    into.tabs.push(...from.tabs);
    return list.filter(x => x !== from);
  });
}

/** Drop repeated URLs inside every stash, keeping the first occurrence. */
export async function dedupeStashes() {
  let removed = 0;
  await store.update(KEY, [], list => {
    const seen = new Set();
    for (const st of list) {
      st.tabs = st.tabs.filter(t => { if (seen.has(t.url)) { removed++; return false; } seen.add(t.url); return true; });
    }
    return list.filter(st => st.tabs.length || st.starred);
  });
  return removed;
}
