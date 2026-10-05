// Archive: a searchable history of every tab the user closes.
import * as store from './store.js';
import { uid, isMeaningfulUrl } from './util.js';
import { quiet, tabUrl } from './tabs.js';

// tabId -> {url,title,favIconUrl}. onRemoved only gives an id, so we keep a cache that
// survives service worker restarts in storage.session.
let cache = null;
let loading = null;
let persistTimer = null;

export function ready() {
  if (cache) return Promise.resolve();
  if (!loading) loading = (async () => {
    const saved = await store.sget('tabCache', {});
    cache = new Map(Object.entries(saved).map(([k, v]) => [+k, v]));
    for (const t of await chrome.tabs.query({})) remember(t, false);
    persist();
  })();
  return loading;
}

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => store.sset('tabCache', Object.fromEntries(cache)), 400);
}

export function remember(tab, save = true) {
  if (!cache) return;
  const url = tabUrl(tab);
  if (!url) return;
  const prev = cache.get(tab.id);
  const entry = {
    url,
    title: tab.title || prev?.title || url,
    favIconUrl: tab.favIconUrl && !tab.favIconUrl.startsWith('data:') ? tab.favIconUrl : (prev?.url === url ? prev.favIconUrl : ''),
  };
  if (prev && prev.url === entry.url && prev.title === entry.title && prev.favIconUrl === entry.favIconUrl) return;
  cache.set(tab.id, entry);
  if (save) persist();
}

let buffer = [];
let flushTimer = null;

export async function onRemoved(tabId, removeInfo) {
  await ready();
  const info = cache.get(tabId);
  cache.delete(tabId);
  persist();
  if (quiet.closing.has(tabId) || !info) return;
  const s = await store.getSettings();
  if (!s.archiveEnabled || !isMeaningfulUrl(info.url) || info.url.startsWith(chrome.runtime.getURL(''))) return;
  buffer.push({ id: uid('a_'), ...info, closedAt: Date.now(), windowClosing: !!removeInfo?.isWindowClosing });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 600);
}

export async function flush() {
  if (!buffer.length) return;
  const items = buffer.reverse();
  buffer = [];
  const s = await store.getSettings();
  await store.update('archive', [], list => {
    for (const it of items) {
      // Collapse a page closed again within a minute into one entry.
      const dup = list.slice(0, 20).findIndex(x => x.url === it.url && it.closedAt - x.closedAt < 60000);
      if (dup >= 0) list.splice(dup, 1);
    }
    return [...items, ...list].slice(0, Math.max(100, +s.archiveMax || 5000));
  });
}

export async function deleteEntries(ids) {
  const set = new Set(ids);
  await store.update('archive', [], list => list.filter(x => !set.has(x.id)));
}

export async function clear(olderThan = 0) {
  await store.update('archive', [], list => olderThan ? list.filter(x => x.closedAt >= olderThan) : []);
}
