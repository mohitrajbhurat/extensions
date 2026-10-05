// Command Palette service worker: opens the palette, answers searches, runs actions.

import { loadAll } from './lib/settings.js';
import * as frecency from './lib/frecency.js';
import { search } from './lib/search.js';
import { getAction, runListItem } from './lib/actions.js';
import { touchTab, forgetTab, invalidateBookmarks, invalidateHistory, warm } from './lib/sources.js';
import { isRestrictedUrl } from './lib/util.js';

const PALETTE_PAGE = chrome.runtime.getURL('ui/palette.html');

// ---------- config cache ----------
let cfgPromise = null;
function getConfig() {
  if (!cfgPromise) cfgPromise = loadAll().catch(e => { cfgPromise = null; throw e; });
  return cfgPromise;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' || Object.keys(changes).some(k => k.startsWith('fallback_'))) cfgPromise = null;
  if (area === 'local' && changes.frecency) frecency.invalidate();
});

// ---------- bookkeeping ----------
chrome.tabs.onActivated.addListener(info => { touchTab(info.tabId); });
chrome.tabs.onRemoved.addListener(tabId => { forgetTab(tabId); });
chrome.windows.onFocusChanged.addListener(async winId => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [t] = await chrome.tabs.query({ active: true, windowId: winId });
    if (t && !(t.url || '').startsWith(PALETTE_PAGE)) touchTab(t.id);
  } catch (e) { /* window gone */ }
});
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportEnded']) {
  if (chrome.bookmarks[ev]) chrome.bookmarks[ev].addListener(invalidateBookmarks);
}
chrome.history.onVisitRemoved.addListener(invalidateHistory);

// ---------- opening the palette ----------
async function openPalette(tab) {
  const { settings } = await getConfig();
  warm(settings);
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return openPopupWindow(null);
  if (settings.preferPopup || isRestrictedUrl(tab.url || tab.pendingUrl)) return openPopupWindow(tab);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['ui/palette-ui.js', 'content/overlay.js'],
    });
  } catch (e) {
    // PDF viewer, file:// without access, error pages, other extensions' pages...
    await openPopupWindow(tab);
  }
}

async function openPopupWindow(tab) {
  // Toggle: if a palette window is already open, close it.
  try {
    const { paletteWindowId } = await chrome.storage.session.get('paletteWindowId');
    if (paletteWindowId) {
      try { await chrome.windows.remove(paletteWindowId); await chrome.storage.session.remove('paletteWindowId'); return; }
      catch (e) { /* stale id */ }
    }
  } catch (e) { /* ignore */ }
  const width = 720, height = 500;
  let left, top;
  if (tab) {
    try {
      const w = await chrome.windows.get(tab.windowId);
      left = Math.round(w.left + (w.width - width) / 2);
      top = Math.round(w.top + Math.min(120, Math.max(0, (w.height - height) / 3)));
    } catch (e) { /* use defaults */ }
  }
  const url = PALETTE_PAGE + '?mode=window' + (tab ? '&tab=' + tab.id : '');
  const win = await chrome.windows.create({ url, type: 'popup', width, height, left, top, focused: true });
  try { await chrome.storage.session.set({ paletteWindowId: win.id }); } catch (e) { /* ignore */ }
}
chrome.windows.onRemoved.addListener(async id => {
  try {
    const { paletteWindowId } = await chrome.storage.session.get('paletteWindowId');
    if (paletteWindowId === id) await chrome.storage.session.remove('paletteWindowId');
  } catch (e) { /* ignore */ }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-palette') openPalette(tab).catch(e => console.warn('Command Palette:', e));
});

// ---------- context ----------
async function resolveCtx(msg, sender) {
  let tabId = msg.ctx && msg.ctx.tabId;
  if (!tabId && sender.tab && !(sender.tab.url || '').startsWith(PALETTE_PAGE)) tabId = sender.tab.id;
  let tab = null;
  if (tabId) { try { tab = await chrome.tabs.get(tabId); } catch (e) { tab = null; } }
  if (!tab) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    tab = t || null;
  }
  const ctx = { tab, windowId: tab ? tab.windowId : (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id };
  return ctx;
}

// ---------- executing results ----------
async function openUrl(url, mods, ctx, settings) {
  const newTab = (settings.enterOpens === 'new') !== !!mods.shift;
  if (mods.mod) {
    await chrome.tabs.create({ url, active: false, windowId: ctx.windowId, index: ctx.tab ? ctx.tab.index + 1 : undefined });
    return { toast: 'Opened in background tab' };
  }
  if (newTab || !ctx.tab) {
    await chrome.tabs.create({ url, windowId: ctx.windowId, index: ctx.tab ? ctx.tab.index + 1 : undefined });
  } else {
    await chrome.tabs.update(ctx.tab.id, { url });
  }
  return {};
}

async function exec(msg, ctx, cfg) {
  const item = msg.item || {};
  const ref = item.ref || {};
  const mods = msg.mods || {};
  if (ref.setQuery !== undefined) return { setQuery: ref.setQuery };
  if (cfg.settings.learn && item.key) frecency.record(item.key, msg.query || '').catch(() => {});
  if (ref.tabId) {
    await chrome.tabs.update(ref.tabId, { active: true });
    await chrome.windows.update(ref.windowId, { focused: true });
    return {};
  }
  if (ref.sessionId) { await chrome.sessions.restore(ref.sessionId); return {}; }
  if (ref.url) return openUrl(ref.url, mods, ctx, cfg.settings);
  if (ref.action) {
    const a = getAction(ref.action);
    if (!a) return { error: 'Unknown action' };
    if (ctx.tab) ctx.bookmarked = (await chrome.bookmarks.search({ url: ctx.tab.url }).catch(() => [])).length > 0;
    return (await a.run(ctx, null, msg.query || '')) || {};
  }
  if (ref.list) return (await runListItem(ref.list, ref.arg, ctx)) || {};
  return { error: 'Nothing to run' };
}

async function pageOp(op, ctx) {
  if (!ctx.tab) return { error: 'No page' };
  const funcs = {
    scrollTop: () => { (document.scrollingElement || document.documentElement).scrollTo({ top: 0, behavior: 'smooth' }); },
    scrollBottom: () => { const el = document.scrollingElement || document.documentElement; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); },
    print: () => { window.print(); },
  };
  if (!funcs[op]) return { error: 'Unknown page operation' };
  try {
    await chrome.scripting.executeScript({ target: { tabId: ctx.tab.id }, func: funcs[op] });
    await chrome.tabs.update(ctx.tab.id, { active: true });
    return {};
  } catch (e) {
    return { error: 'This page cannot be scripted. Open the palette with the keyboard shortcut on the page itself.' };
  }
}

async function handle(msg, sender) {
  const cfg = await getConfig();
  switch (msg.type) {
    case 'config':
      return { settings: cfg.settings, shortcut: await shortcutText() };
    case 'search': {
      const ctx = await resolveCtx(msg, sender);
      if (ctx.tab && !msg.list) {
        ctx.bookmarked = (await chrome.bookmarks.search({ url: ctx.tab.url || 'about:blank' }).catch(() => [])).length > 0;
      }
      return search(msg.query || '', ctx, cfg, msg.list || null);
    }
    case 'exec': {
      const ctx = await resolveCtx(msg, sender);
      try { return await exec(msg, ctx, cfg); }
      catch (e) { return { error: e && e.message ? e.message : String(e) }; }
    }
    case 'pageOp':
      return pageOp(msg.op, await resolveCtx(msg, sender));
    case 'closeTab':
      try { await chrome.tabs.remove(msg.tabId); return { ok: true }; } catch (e) { return { error: e.message }; }
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return {};
    case 'clearFrecency':
      await frecency.clear();
      return { ok: true };
    case 'frecencyStats':
      return frecency.stats();
    default:
      return { error: 'Unknown message' };
  }
}

async function shortcutText() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find(x => x.name === 'open-palette');
    return c && c.shortcut ? c.shortcut : '';
  } catch (e) { return ''; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: String(e && e.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t && touchTab(t.id)).catch(() => {});
  }
});
