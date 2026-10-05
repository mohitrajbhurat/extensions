// Total Recall service worker: receives page text from the content script, indexes it locally,
// powers omnibox suggestions and runs retention / storage-cap maintenance.
import { upsertPage, deleteDocs, getStats, idsOlderThan, idsForDomain, oldestDocs, getTexts } from './lib/db.js';
import { SearchEngine, makeSnippet, fragmentUrl, parseQuery } from './lib/search.js';
import { getSettings, setSettings, DEFAULT_SETTINGS } from './lib/settings.js';
import { normalizeUrl, isExcluded, hostOf, cleanRule } from './lib/util.js';

const SEARCH_PAGE = 'search/search.html';
const engine = new SearchEngine();

// ---- Serial work queue so index writes never interleave --------------------------------------
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn, fn).catch(e => { console.warn('Total Recall:', e); throw e; }));

async function indexPage({ url, title, text }, { force = false, tab } = {}) {
  if (tab && tab.incognito) return { ok: false, reason: 'incognito' };
  const norm = normalizeUrl(url);
  if (!norm) return { ok: false, reason: 'unsupported' };
  const s = await getSettings();
  if (s.paused && !force) return { ok: false, reason: 'paused' };
  if (isExcluded(norm, s.excludedDomains)) return { ok: false, reason: 'excluded' };
  text = String(text || '').slice(0, s.maxCharsPerPage || DEFAULT_SETTINGS.maxCharsPerPage);
  if (!force && text.length < (s.minChars ?? 120)) return { ok: false, reason: 'too-short' };
  const res = await enqueue(() => upsertPage({ url: norm, title: String(title || '').slice(0, 500), text }));
  maybeEnforceCap();
  return { ok: true, ...res };
}

// ---- Maintenance ------------------------------------------------------------------------------
let capTimer = null;
function maybeEnforceCap() {
  if (capTimer) return;
  capTimer = setTimeout(() => { capTimer = null; enqueue(enforceStorageCap).catch(() => {}); }, 5000);
}

async function enforceStorageCap() {
  const s = await getSettings();
  const max = (s.maxStorageMB || DEFAULT_SETTINGS.maxStorageMB) * 1024 * 1024;
  let stats = await getStats();
  let removed = 0;
  while (stats.bytes > max && stats.docs > 0) {
    const target = stats.bytes - max * 0.9;
    const batch = await oldestDocs(200);
    const ids = [];
    let freed = 0;
    for (const d of batch) { if (freed >= target) break; ids.push(d.id); freed += d.bytes; }
    if (!ids.length) break;
    removed += await deleteDocs(ids);
    stats = await getStats();
  }
  return removed;
}

async function pruneByRetention() {
  const s = await getSettings();
  if (!s.retentionDays) return 0;
  const ids = await idsOlderThan(Date.now() - s.retentionDays * 86400000);
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) n += await deleteDocs(ids.slice(i, i + 200));
  return n;
}

async function maintenance() {
  const a = await enqueue(pruneByRetention);
  const b = await enqueue(enforceStorageCap);
  await chrome.storage.local.set({ lastMaintenance: { at: Date.now(), removed: a + b } });
  return a + b;
}

// ---- Index the current tab on demand (popup "Index this page now") ----------------------------
async function indexTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito) return { ok: false, reason: 'incognito' };
  if (!normalizeUrl(tab.url || '')) return { ok: false, reason: 'unsupported' };
  let data;
  try {
    data = await chrome.tabs.sendMessage(tabId, { type: 'tr:extract' });
  } catch {
    // Content script not present (tab opened before install): inject it now (activeTab grant).
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/extract.js'] });
      data = await chrome.tabs.sendMessage(tabId, { type: 'tr:extract' });
    } catch (e) {
      return { ok: false, reason: 'blocked', message: String(e && e.message || e) };
    }
  }
  if (!data || !data.ok) return data || { ok: false, reason: 'empty' };
  return indexPage(data, { force: true, tab });
}

async function forgetSite(domain, { exclude = true } = {}) {
  domain = cleanRule(domain).split('/')[0];
  if (!domain) return { ok: false };
  const ids = await idsForDomain(domain);
  let removed = 0;
  for (let i = 0; i < ids.length; i += 200) removed += await enqueue(() => deleteDocs(ids.slice(i, i + 200)));
  if (exclude) {
    const s = await getSettings();
    if (!s.excludedDomains.map(cleanRule).includes(domain)) await setSettings({ excludedDomains: [...s.excludedDomains, domain] });
  }
  return { ok: true, removed };
}

// ---- Messages ---------------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('tr:')) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const handle = async () => {
    switch (msg.type) {
      case 'tr:index':
        if (!sender.tab) return { ok: false, reason: 'no-tab' };
        return indexPage(msg, { force: !!msg.force, tab: sender.tab });
      case 'tr:indexTab': return indexTab(msg.tabId);
      case 'tr:forgetSite': return forgetSite(msg.domain, { exclude: msg.exclude !== false });
      case 'tr:maintenance': return { ok: true, removed: await maintenance() };
      case 'tr:openSearch': await openSearch(msg.q || ''); return { ok: true };
      default: return { ok: false, reason: 'unknown' };
    }
  };
  handle().then(sendResponse, e => sendResponse({ ok: false, reason: 'error', message: String(e && e.message || e) }));
  return true;
});

async function openSearch(q = '', disposition = 'newForegroundTab') {
  const url = chrome.runtime.getURL(SEARCH_PAGE) + (q ? '?q=' + encodeURIComponent(q) : '');
  if (disposition === 'currentTab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) return chrome.tabs.update(tab.id, { url });
  }
  return chrome.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
}

// ---- Omnibox: "tr <query>" --------------------------------------------------------------------
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
let omniSeq = 0;

chrome.omnibox.setDefaultSuggestion({ description: 'Search everything you have read with Total Recall' });

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const seq = ++omniSeq;
  const q = text.trim();
  if (!q) {
    chrome.omnibox.setDefaultSuggestion({ description: 'Search everything you have read with Total Recall' });
    return suggest([]);
  }
  chrome.omnibox.setDefaultSuggestion({ description: `Open all Total Recall results for <match>${xml(q)}</match>` });
  try {
    const { results, query } = await engine.search(text, { live: true, limit: 6 });
    if (seq !== omniSeq) return;
    const texts = await getTexts(results.map(r => r.doc.id));
    const items = results.map(r => {
      const { html, fragment } = makeSnippet(texts.get(r.doc.id) || '', query, { maxWords: 14 });
      const snippet = html.replace(/<mark>/g, '').replace(/<\/mark>/g, '').replace(/&[a-z#0-9]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || ' '));
      return {
        content: fragmentUrl(r.doc.url, fragment),
        description: `<match>${xml((r.doc.title || r.doc.url).slice(0, 80))}</match> <dim>${xml(snippet.slice(0, 110))}</dim> <url>${xml(r.doc.domain)}</url>`,
        deletable: false,
      };
    });
    suggest(items);
  } catch (e) {
    console.warn('Total Recall omnibox:', e);
    suggest([]);
  }
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  if (/^https?:\/\//i.test(text)) {
    if (disposition === 'currentTab') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) return chrome.tabs.update(tab.id, { url: text });
    }
    return chrome.tabs.create({ url: text, active: disposition !== 'newBackgroundTab' });
  }
  return openSearch(text.trim(), disposition);
});

// ---- Commands, badge, lifecycle ---------------------------------------------------------------
chrome.commands.onCommand.addListener(cmd => { if (cmd === 'open-search') openSearch(); });

async function updateBadge() {
  const s = await getSettings();
  await chrome.action.setBadgeText({ text: s.paused ? 'OFF' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  await chrome.action.setTitle({ title: s.paused ? 'Total Recall (indexing paused)' : 'Total Recall' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    updateBadge();
    const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
    if (o.retentionDays !== n.retentionDays || o.maxStorageMB !== n.maxStorageMB) maintenance().catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(a => { if (a.name === 'tr-maintenance') maintenance().catch(() => {}); });

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  chrome.alarms.create('tr-maintenance', { periodInMinutes: 360, delayInMinutes: 1 });
  updateBadge();
  if (reason === 'install') openSearch('', 'newForegroundTab').catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  chrome.alarms.get('tr-maintenance', a => { if (!a) chrome.alarms.create('tr-maintenance', { periodInMinutes: 360, delayInMinutes: 1 }); });
});

// Expose a tiny surface for debugging from the service worker console.
self.totalRecall = { engine, maintenance, forgetSite, parseQuery, hostOf };
