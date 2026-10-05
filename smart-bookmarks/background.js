// Smart Bookmarks service worker: badge, context menus, shortcuts, metadata cleanup,
// and optional auto-suggest / text capture for newly created bookmarks.
import { getSettings, setMeta, getMeta, deleteMeta, hasSiteAccess } from './lib/meta.js';
import { saveForLater, peekReadLaterFolders, unreadItems } from './lib/readlater.js';
import { extractPageInTab, fetchAndExtract, countWords, readingMinutes } from './lib/extract.js';
import { suggestForPage } from './lib/corpus.js';
import { putText, deleteTexts } from './lib/db.js';
import { isHttpUrl } from './lib/url.js';

const MANAGER = 'manager/manager.html';

// ---------- Badge ----------
let badgeTimer = null;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 300);
}

async function updateBadge() {
  try {
    const settings = await getSettings();
    const items = settings.showBadge ? await unreadItems() : [];
    const n = items.length;
    await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    await chrome.action.setBadgeText({ text: n ? (n > 999 ? '999+' : String(n)) : '' });
    await chrome.action.setTitle({ title: n ? `Smart Bookmarks: ${n} unread in Read Later` : 'Smart Bookmarks' });
  } catch (e) {
    console.warn('Badge update failed', e);
  }
}

async function flashBadge(text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    await chrome.action.setBadgeText({ text });
    setTimeout(scheduleBadge, 1500);
  } catch { /* ignore */ }
}

// ---------- Context menus ----------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sb-save-page', title: 'Save page for later', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'sb-save-link', title: 'Save link for later', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'sb-open-manager', title: 'Open bookmark manager', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'sb-open-readlater', title: 'Open Read Later list', contexts: ['action'] });
  });
}

async function openManager(hash = '') {
  const url = chrome.runtime.getURL(MANAGER) + (hash ? '#' + hash : '');
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL(MANAGER)] });
      const hit = ctx.find(c => c.tabId >= 0);
      if (hit) {
        await chrome.tabs.update(hit.tabId, { active: true, ...(hash ? { url } : {}) });
        if (hit.windowId >= 0) await chrome.windows.update(hit.windowId, { focused: true });
        return;
      }
    }
  } catch { /* fall back to a new tab */ }
  await chrome.tabs.create({ url });
}

async function saveTab(tab) {
  if (!tab || !isHttpUrl(tab.url)) { await flashBadge('×'); return; }
  let page = { url: tab.url, title: tab.title || tab.url, text: '' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageInTab });
    if (res && res.result) page = { ...page, ...res.result, url: tab.url };
  } catch { /* restricted page: save without text */ }
  const settings = await getSettings();
  let suggested = [];
  if (page.text || page.description) { try { suggested = await suggestForPage(page, 6); } catch { /* ignore */ } }
  await saveForLater({ ...page, tags: [], suggested, saveText: settings.saveTextOnSave });
  await flashBadge('✓');
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'sb-save-page') await saveTab(tab);
    else if (info.menuItemId === 'sb-save-link') {
      if (!isHttpUrl(info.linkUrl)) return;
      const title = (info.selectionText || '').trim() || info.linkUrl;
      await saveForLater({ url: info.linkUrl, title, tags: [] });
      await flashBadge('✓');
    } else if (info.menuItemId === 'sb-open-manager') await openManager();
    else if (info.menuItemId === 'sb-open-readlater') await openManager('readlater');
  } catch (e) { console.warn('Context menu action failed', e); }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (command === 'save-for-later') {
      if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await saveTab(tab);
    } else if (command === 'open-manager') await openManager();
  } catch (e) { console.warn('Command failed', e); }
});

// ---------- Bookmark events ----------
function collectIds(node, out = []) {
  out.push(node.id);
  for (const c of node.children || []) collectIds(c, out);
  return out;
}

chrome.bookmarks.onRemoved.addListener(async (id, info) => {
  const ids = info && info.node ? collectIds(info.node) : [id];
  try { await deleteMeta(ids); await deleteTexts(ids); } catch (e) { console.warn('Cleanup failed', e); }
  scheduleBadge();
});

chrome.bookmarks.onMoved.addListener(scheduleBadge);
chrome.bookmarks.onChanged.addListener(scheduleBadge);
if (chrome.bookmarks.onImportEnded) chrome.bookmarks.onImportEnded.addListener(scheduleBadge);

let importing = false;
if (chrome.bookmarks.onImportBegan) chrome.bookmarks.onImportBegan.addListener(() => { importing = true; });
if (chrome.bookmarks.onImportEnded) chrome.bookmarks.onImportEnded.addListener(() => { importing = false; });

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  scheduleBadge();
  if (importing || !node.url || !isHttpUrl(node.url)) return;
  try {
    const { bulkOp } = await chrome.storage.session.get('bulkOp');
    if (bulkOp && Date.now() - bulkOp < 60000) return; // manager is importing/restoring
    const rl = await peekReadLaterFolders();
    if (rl && (node.parentId === rl.rootId || node.parentId === rl.archiveId)) return; // handled by saveForLater
    const settings = await getSettings();
    if (!settings.suggestOnCreate && !settings.saveTextOnCreate) return;
    if (!await hasSiteAccess()) return;
    const page = await fetchAndExtract(node.url, { timeout: 15000 });
    page.url = node.url;
    const patch = {};
    if (settings.suggestOnCreate) {
      const cur = await getMeta(id);
      const sugg = await suggestForPage(page, 8);
      patch.suggested = sugg.filter(t => !(cur.tags || []).includes(t));
    }
    if (settings.saveTextOnCreate && page.text) {
      const words = countWords(page.text);
      await putText(id, page.text, words);
      patch.hasText = true; patch.textAt = Date.now(); patch.words = words; patch.minutes = readingMinutes(words, settings.wpm);
    }
    // Bookmark may have been deleted while we were fetching.
    try { await chrome.bookmarks.get(id); } catch { return; }
    await setMeta(id, patch);
  } catch (e) {
    console.warn('Auto-processing of new bookmark failed:', node.url, e && e.message);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) scheduleBadge();
  if (area === 'local' && Object.keys(changes).some(k => k.startsWith('m:') || k === 'rlFolders')) scheduleBadge();
});

// ---------- Messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'updateBadge': await updateBadge(); return { ok: true };
      case 'openManager': await openManager(msg.hash || ''); return { ok: true };
      default: return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse, e => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  createMenus();
  updateBadge();
  if (details.reason === 'install') openManager('welcome').catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { createMenus(); updateBadge(); });
