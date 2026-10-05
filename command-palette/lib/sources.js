// Data sources: open tabs, recently closed, bookmarks and history.
// Bookmarks and history are cached in the service worker and invalidated on change.

import { prettyUrl } from './util.js';

let bookmarkCache = null;
let historyCache = null;
let historyAt = 0;
let historyLimitKey = '';
const HISTORY_TTL = 90 * 1000;

export function invalidateBookmarks() { bookmarkCache = null; }
export function invalidateHistory() { historyCache = null; }

// MRU order of tab activations, persisted in session storage so it survives SW restarts.
let mru = null;
async function loadMru() {
  if (mru) return mru;
  try {
    const r = await chrome.storage.session.get('mru');
    mru = Array.isArray(r.mru) ? r.mru : [];
  } catch (e) { mru = []; }
  return mru;
}
export async function touchTab(tabId) {
  await loadMru();
  const i = mru.indexOf(tabId);
  if (i >= 0) mru.splice(i, 1);
  mru.unshift(tabId);
  if (mru.length > 300) mru.length = 300;
  try { await chrome.storage.session.set({ mru }); } catch (e) { /* ignore */ }
}
export async function forgetTab(tabId) {
  await loadMru();
  const i = mru.indexOf(tabId);
  if (i >= 0) { mru.splice(i, 1); try { await chrome.storage.session.set({ mru }); } catch (e) { /* ignore */ } }
}
/** The most recently used tab other than `currentId`. */
export async function previousTabId(currentId) {
  await loadMru();
  for (const id of mru) {
    if (id === currentId) continue;
    try { await chrome.tabs.get(id); return id; } catch (e) { /* closed */ }
  }
  return null;
}

/** All tabs in all normal windows, sorted most recently used first. */
export async function getTabs() {
  const [tabs, order] = await Promise.all([chrome.tabs.query({}), loadMru()]);
  const rank = new Map(order.map((id, i) => [id, i]));
  tabs.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : 1e6;
    const rb = rank.has(b.id) ? rank.get(b.id) : 1e6;
    if (ra !== rb) return ra - rb;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  return tabs;
}

export async function getClosed() {
  if (!chrome.sessions) return [];
  try {
    const list = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    const out = [];
    for (const s of list) {
      if (s.tab && s.tab.sessionId) {
        out.push({ sessionId: s.tab.sessionId, title: s.tab.title || s.tab.url, url: s.tab.url, time: (s.lastModified || 0) * 1000, kind: 'tab', favIconUrl: s.tab.favIconUrl });
      } else if (s.window && s.window.sessionId) {
        const n = (s.window.tabs || []).length;
        const first = (s.window.tabs || [])[0];
        out.push({
          sessionId: s.window.sessionId,
          title: `Window with ${n} tab${n === 1 ? '' : 's'}` + (first ? `: ${first.title || first.url}` : ''),
          url: first ? first.url : '',
          time: (s.lastModified || 0) * 1000,
          kind: 'window',
        });
      }
    }
    return out;
  } catch (e) { return []; }
}

export async function getBookmarks() {
  if (bookmarkCache) return bookmarkCache;
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, path) => {
    if (node.url) {
      out.push({
        id: node.id,
        title: node.title || prettyUrl(node.url),
        url: node.url,
        sub: prettyUrl(node.url),
        folder: path.join(' › '),
        dateAdded: node.dateAdded || 0,
      });
      return;
    }
    const next = node.title && node.parentId && node.parentId !== '0' ? path.concat(node.title) : (node.title && node.parentId === '0' ? [node.title] : path);
    for (const c of node.children || []) walk(c, next);
  };
  for (const root of tree) walk(root, []);
  // Javascript bookmarklets cannot run from an extension page; drop them.
  bookmarkCache = out.filter(b => !/^javascript:/i.test(b.url));
  return bookmarkCache;
}

export async function getHistory(max, days) {
  const key = max + ':' + days;
  if (historyCache && Date.now() - historyAt < HISTORY_TTL && key === historyLimitKey) return historyCache;
  const items = await chrome.history.search({ text: '', startTime: Date.now() - days * 86400000, maxResults: max });
  historyCache = items
    .filter(h => h.url && !/^(javascript|data):/i.test(h.url))
    .map(h => ({
      id: h.id,
      title: h.title || prettyUrl(h.url),
      url: h.url,
      sub: prettyUrl(h.url),
      lastVisitTime: h.lastVisitTime || 0,
      visitCount: h.visitCount || 0,
      typedCount: h.typedCount || 0,
    }));
  historyAt = Date.now();
  historyLimitKey = key;
  return historyCache;
}

/** Warm caches so the first keystroke is fast. */
export function warm(settings) {
  getBookmarks().catch(() => {});
  getHistory(settings.historyMax, settings.historyDays).catch(() => {});
}
