// API Workbench service worker: opens the app, keeps the JSON page viewer registered,
// and formats JSON in the current tab on request (activeTab).
const APP = 'app/workbench.html';
const VIEWER_ID = 'aw-json-viewer';
const VIEWER_JS = ['lib/jsontree.js', 'content/json-viewer.js'];
const VIEWER_CSS = ['lib/jsontree.css', 'content/json-viewer.css'];

async function findAppTab() {
  const base = chrome.runtime.getURL(APP);
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const hit = ctx.find(c => c.documentUrl && c.documentUrl.startsWith(base) && c.tabId >= 0);
      if (hit) return chrome.tabs.get(hit.tabId);
    }
  } catch { /* fall through */ }
  try {
    const [t] = await chrome.tabs.query({ url: base + '*' });
    return t || null;
  } catch { return null; }
}

async function openWorkbench(url) {
  const t = await findAppTab();
  if (t) {
    await chrome.tabs.update(t.id, { active: true });
    try { await chrome.windows.update(t.windowId, { focused: true }); } catch { /* no windows API in some contexts */ }
    if (url) {
      try { await chrome.runtime.sendMessage({ type: 'aw-open-url', url }); return; }
      catch { /* page not ready: reload with the URL */ }
      await chrome.tabs.update(t.id, { url: chrome.runtime.getURL(`${APP}?url=${encodeURIComponent(url)}`) });
    }
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(url ? `${APP}?url=${encodeURIComponent(url)}` : APP) });
}

/** Register the JSON viewer for every site the user has granted (Chrome injects only where we have access). */
async function syncViewer() {
  if (!chrome.scripting?.registerContentScripts) return;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const enabled = settings?.jsonViewer?.enabled !== false;
    const perms = await chrome.permissions.getAll();
    const origins = (perms.origins || []).filter(o => /^(<all_urls>|\*|https?|file):/.test(o));
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [VIEWER_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [VIEWER_ID] });
    if (!enabled || !origins.length) return;
    await chrome.scripting.registerContentScripts([{
      id: VIEWER_ID, matches: origins, js: VIEWER_JS, runAt: 'document_end', allFrames: false, persistAcrossSessions: true,
    }]);
  } catch (e) {
    console.warn('JSON viewer registration failed', e);
  }
}

async function formatTab(tab) {
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) return;
  const target = { tabId: tab.id };
  try {
    await chrome.scripting.executeScript({ target, func: () => { globalThis.__awForce = true; } });
    await chrome.scripting.insertCSS({ target, files: VIEWER_CSS });
    await chrome.scripting.executeScript({ target, files: VIEWER_JS });
  } catch (e) {
    console.warn('Cannot format this page', e);
  }
}

async function clearStaleRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(r => r.id) });
  } catch { /* unavailable */ }
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'aw-format', title: 'Format JSON on this page', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'aw-send-url', title: 'Open this page’s URL as a request', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'aw-link', title: 'Open link in API Workbench', contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
  });
}

chrome.runtime.onInstalled.addListener(() => { createMenus(); syncViewer(); clearStaleRules(); });
chrome.runtime.onStartup.addListener(() => { syncViewer(); clearStaleRules(); });

chrome.action.onClicked.addListener(() => { openWorkbench(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'aw-format') formatTab(tab);
  else if (info.menuItemId === 'aw-send-url' && /^https?:/.test(tab?.url || '')) openWorkbench(tab.url);
  else if (info.menuItemId === 'aw-link' && info.linkUrl) openWorkbench(info.linkUrl);
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'open-workbench') openWorkbench();
  else if (cmd === 'format-json') {
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    formatTab(tab);
  }
});

chrome.permissions.onAdded.addListener(syncViewer);
chrome.permissions.onRemoved.addListener(syncViewer);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const a = changes.settings.oldValue?.jsonViewer?.enabled, b = changes.settings.newValue?.jsonViewer?.enabled;
  if (a !== b) syncViewer();
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'aw-viewer-css' && sender.tab?.id != null) {
    chrome.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, files: VIEWER_CSS })
      .then(() => reply({ ok: true }), e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'aw-open' && typeof msg.url === 'string' && /^https?:/.test(msg.url)) {
    openWorkbench(msg.url).then(() => reply({ ok: true }), e => reply({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
