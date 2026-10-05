// Point-and-Click Scraper service worker: result sessions, crawl resumption, shortcuts.
import { getSession, saveSession, newId, hostOf } from './lib/store.js';

const CONTENT_FILES = ['content/core.js', 'content/panel.js'];
const dedupeSets = new Map(); // session id -> Set of row keys (rebuilt lazily)
const queues = new Map(); // session id -> promise chain, serializes writes

function serial(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(id, next.catch(() => {}));
  return next;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
}

async function openPanel(tab, action) {
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return;
  try {
    await inject(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'ps:open', action });
  } catch (e) {
    console.warn('Page Scraper: cannot run on this page', e && e.message);
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (command === 'open-scraper') openPanel(t, 'detect');
  if (command === 'pick-manually') openPanel(t, 'manual');
});

async function createSession(msg, sender) {
  const id = newId('s');
  const url = msg.meta?.url || sender.tab?.url || '';
  const s = {
    id, title: msg.meta?.title || sender.tab?.title || hostOf(url) || 'Scrape',
    url, host: hostOf(url), recipeName: msg.meta?.recipeName || '',
    itemSelector: msg.meta?.itemSelector || '', recipe: msg.meta?.recipe || null,
    columns: msg.columns || [], rows: [], pages: 0, status: 'running',
    dedupe: msg.dedupe !== false, createdAt: Date.now(),
  };
  await saveSession(s);
  dedupeSets.set(id, new Set());
  return { id };
}

async function appendRows(msg) {
  return serial(msg.id, async () => {
    const s = await getSession(msg.id);
    if (!s) return { error: 'missing session' };
    let set = dedupeSets.get(s.id);
    if (!set) { set = new Set(s.rows.map((r) => JSON.stringify(r))); dedupeSets.set(s.id, set); }
    let added = 0;
    for (const row of msg.rows || []) {
      if (!Array.isArray(row)) continue;
      if (row.every((v) => !v)) continue;
      const key = JSON.stringify(row);
      if (s.dedupe && set.has(key)) continue;
      set.add(key);
      s.rows.push(row.map((v) => (v == null ? '' : String(v))));
      added++;
    }
    s.pages = Math.max(s.pages || 0, msg.page || 0);
    await saveSession(s);
    return { total: s.rows.length, added };
  });
}

async function finishSession(msg) {
  return serial(msg.id, async () => {
    const s = await getSession(msg.id);
    if (!s) return { error: 'missing session' };
    s.status = msg.status || 'done';
    if (msg.pages) s.pages = msg.pages;
    if (msg.note) s.note = msg.note;
    await saveSession(s);
    dedupeSets.delete(s.id);
    return { total: s.rows.length };
  });
}

const pendingKey = (tabId) => 'crawlPending:' + tabId;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ps:')) return false;
  const tabId = sender.tab?.id;
  const handlers = {
    'ps:session:create': () => createSession(msg, sender),
    'ps:session:append': () => appendRows(msg),
    'ps:session:finish': () => finishSession(msg),
    'ps:openResults': async () => {
      const url = chrome.runtime.getURL('results/results.html') + (msg.id ? '?id=' + encodeURIComponent(msg.id) : '');
      await chrome.tabs.create({ url, index: sender.tab ? sender.tab.index + 1 : undefined });
      return { ok: true };
    },
    'ps:openManager': async () => { await chrome.runtime.openOptionsPage(); return { ok: true }; },
    'ps:crawl:pending': async () => {
      if (tabId == null) return { ok: false };
      await chrome.storage.local.set({ [pendingKey(tabId)]: { ...msg.state, at: Date.now() } });
      return { ok: true };
    },
    'ps:crawl:clear': async () => {
      if (tabId != null) await chrome.storage.local.remove(pendingKey(tabId));
      return { ok: true };
    },
  };
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve().then(h).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});

// A "next" click that reloaded the page kills the content script. Re-inject and resume the crawl.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const key = pendingKey(tabId);
  const { [key]: state } = await chrome.storage.local.get(key);
  if (!state) return;
  if (Date.now() - state.at > 120000) { await chrome.storage.local.remove(key); return; }
  // Same-document pagination: the old script is alive and handles it.
  try {
    const alive = await chrome.tabs.sendMessage(tabId, { type: 'ps:ping' });
    if (alive && alive.crawling) return;
  } catch { /* no script: page navigated */ }
  await chrome.storage.local.remove(key);
  try {
    await inject(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'ps:crawl:resume', state });
  } catch (e) {
    await finishSession({ id: state.sessionId, status: 'done', note: 'Stopped after the page reloaded: grant site access in the popup to crawl pages that reload.' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.local.remove(pendingKey(tabId)); });

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const { recipes } = await chrome.storage.local.get('recipes');
    if (!recipes) await chrome.storage.local.set({ recipes: [] });
  }
});
