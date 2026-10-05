// Built-in actions. Each action: { id, title, sub, keywords, icon, when?(ctx), run(ctx, arg, query) }.
// run() returns a result object for the UI:
//   {}                          close the palette
//   { toast }                   close and show a short message
//   { clipboard, toast }        copy text (done by the UI, which has the user gesture)
//   { pageOp }                  run an in-page operation (scrollTop, scrollBottom, print)
//   { list: { id, placeholder, title } }  open a sub-list (see LISTS below)
//   { setQuery }                replace the palette input
//   { error }                   show an error and keep the palette open

import { hostOf, originOf, urlKey, prettyUrl } from './util.js';
import { previousTabId } from './sources.js';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function needTab(ctx) {
  if (!ctx.tab) throw new Error('No active tab');
  return ctx.tab;
}
function isWeb(tab) { return !!(tab && /^(https?|file):/i.test(tab.url || '')); }

async function windowTabs(ctx) {
  return chrome.tabs.query({ windowId: ctx.windowId });
}
async function closeTabs(ids) {
  if (!ids.length) return { toast: 'No tabs to close' };
  await chrome.tabs.remove(ids);
  return { toast: `Closed ${ids.length} tab${ids.length === 1 ? '' : 's'}` };
}
async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}
async function openChromePage(ctx, path) {
  // Edge and Brave redirect chrome:// URLs to their own scheme.
  await chrome.tabs.create({ url: 'chrome://' + path, windowId: ctx.windowId });
  return {};
}
async function zoomBy(ctx, dir) {
  const tab = needTab(ctx);
  const cur = await chrome.tabs.getZoom(tab.id);
  let next;
  if (dir === 0) next = 1;
  else if (dir > 0) next = ZOOM_STEPS.find(z => z > cur + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  else next = [...ZOOM_STEPS].reverse().find(z => z < cur - 0.001) || ZOOM_STEPS[0];
  await chrome.tabs.setZoom(tab.id, next);
  return { toast: `Zoom ${Math.round(next * 100)}%`, keepOpen: false };
}
function mdEscape(s) { return String(s || '').replace(/([\[\]])/g, '\\$1'); }

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

export const ACTIONS = [
  // ---- Tabs and windows ----
  { id: 'new-tab', title: 'New Tab', sub: 'Tabs', icon: 'plus', keywords: 'open create blank',
    run: async ctx => { await chrome.tabs.create({ windowId: ctx.windowId }); return {}; } },
  { id: 'new-window', title: 'New Window', sub: 'Windows', icon: 'window', keywords: 'open create',
    run: async () => { await chrome.windows.create({}); return {}; } },
  { id: 'new-incognito', title: 'New Incognito Window', sub: 'Windows', icon: 'incognito', keywords: 'private inprivate',
    run: async () => {
      try { await chrome.windows.create({ incognito: true }); return {}; }
      catch (e) { return { error: 'Could not open an incognito window: ' + e.message }; }
    } },
  { id: 'open-in-incognito', title: 'Open This Page in Incognito', sub: 'Windows', icon: 'incognito', keywords: 'private inprivate',
    when: ctx => isWeb(ctx.tab),
    run: async ctx => {
      try { await chrome.windows.create({ incognito: true, url: needTab(ctx).url }); return {}; }
      catch (e) { return { error: 'Could not open an incognito window: ' + e.message }; }
    } },
  { id: 'close-tab', title: 'Close Tab', sub: 'Tabs', icon: 'x', keywords: 'remove kill',
    run: async ctx => { await chrome.tabs.remove(needTab(ctx).id); return {}; } },
  { id: 'close-window', title: 'Close Window', sub: 'Windows', icon: 'x', keywords: 'remove all tabs',
    run: async ctx => { await chrome.windows.remove(ctx.windowId); return {}; } },
  { id: 'duplicate-tab', title: 'Duplicate Tab', sub: 'Tabs', icon: 'duplicate', keywords: 'copy clone',
    run: async ctx => { await chrome.tabs.duplicate(needTab(ctx).id); return {}; } },
  { id: 'toggle-pin', title: ctx => (ctx.tab && ctx.tab.pinned ? 'Unpin Tab' : 'Pin Tab'), sub: 'Tabs', icon: 'pin', keywords: 'pin unpin stick',
    run: async ctx => { const t = needTab(ctx); await chrome.tabs.update(t.id, { pinned: !t.pinned }); return { toast: t.pinned ? 'Tab unpinned' : 'Tab pinned' }; } },
  { id: 'toggle-mute', title: ctx => (ctx.tab && ctx.tab.mutedInfo && ctx.tab.mutedInfo.muted ? 'Unmute Tab' : 'Mute Tab'), sub: 'Tabs', icon: 'sound', keywords: 'mute unmute audio sound silence',
    run: async ctx => { const t = needTab(ctx); const m = !!(t.mutedInfo && t.mutedInfo.muted); await chrome.tabs.update(t.id, { muted: !m }); return { toast: m ? 'Tab unmuted' : 'Tab muted' }; } },
  { id: 'mute-others', title: 'Mute All Other Tabs', sub: 'Tabs', icon: 'sound', keywords: 'silence audio',
    run: async ctx => {
      const tabs = await chrome.tabs.query({ audible: true });
      const others = tabs.filter(t => !ctx.tab || t.id !== ctx.tab.id);
      await Promise.all(others.map(t => chrome.tabs.update(t.id, { muted: true })));
      return { toast: `Muted ${others.length} tab${others.length === 1 ? '' : 's'}` };
    } },
  { id: 'unmute-all', title: 'Unmute All Tabs', sub: 'Tabs', icon: 'sound', keywords: 'audio sound',
    run: async () => {
      const tabs = (await chrome.tabs.query({})).filter(t => t.mutedInfo && t.mutedInfo.muted);
      await Promise.all(tabs.map(t => chrome.tabs.update(t.id, { muted: false })));
      return { toast: `Unmuted ${tabs.length} tab${tabs.length === 1 ? '' : 's'}` };
    } },
  { id: 'reload', title: 'Reload Tab', sub: 'Tabs', icon: 'reload', keywords: 'refresh',
    run: async ctx => { await chrome.tabs.reload(needTab(ctx).id); return {}; } },
  { id: 'hard-reload', title: 'Hard Reload (Bypass Cache)', sub: 'Tabs', icon: 'reload', keywords: 'refresh force bypass cache',
    run: async ctx => { await chrome.tabs.reload(needTab(ctx).id, { bypassCache: true }); return {}; } },
  { id: 'reload-all', title: 'Reload All Tabs in Window', sub: 'Tabs', icon: 'reload', keywords: 'refresh',
    run: async ctx => { const tabs = await windowTabs(ctx); await Promise.all(tabs.map(t => chrome.tabs.reload(t.id))); return { toast: `Reloaded ${tabs.length} tabs` }; } },
  { id: 'go-back', title: 'Go Back', sub: 'Navigation', icon: 'left', keywords: 'previous page history back',
    run: async ctx => { try { await chrome.tabs.goBack(needTab(ctx).id); return {}; } catch (e) { return { toast: 'No previous page' }; } } },
  { id: 'go-forward', title: 'Go Forward', sub: 'Navigation', icon: 'right', keywords: 'next page history',
    run: async ctx => { try { await chrome.tabs.goForward(needTab(ctx).id); return {}; } catch (e) { return { toast: 'No next page' }; } } },
  { id: 'previous-tab', title: 'Switch to Last Used Tab', sub: 'Tabs', icon: 'swap', keywords: 'previous recent toggle alt tab mru',
    run: async ctx => {
      const id = await previousTabId(ctx.tab && ctx.tab.id);
      if (!id) return { toast: 'No previous tab' };
      await focusTab(await chrome.tabs.get(id));
      return {};
    } },
  { id: 'reopen-closed', title: 'Reopen Closed Tab', sub: 'Tabs', icon: 'restore', keywords: 'undo restore recently closed',
    run: async () => { try { await chrome.sessions.restore(); return {}; } catch (e) { return { toast: 'Nothing to reopen' }; } } },

  // ---- Moving tabs ----
  { id: 'move-new-window', title: 'Move Tab to New Window', sub: 'Windows', icon: 'window', keywords: 'detach pop out tear off',
    run: async ctx => { await chrome.windows.create({ tabId: needTab(ctx).id, focused: true }); return {}; } },
  { id: 'move-to-window', title: 'Move Tab to Window…', sub: 'Windows', icon: 'move', keywords: 'send another other',
    run: async () => ({ list: { id: 'move-to-window', title: 'Move tab to window', placeholder: 'Pick a window…' } }) },
  { id: 'merge-windows', title: 'Merge All Windows Into This One', sub: 'Windows', icon: 'merge', keywords: 'combine gather consolidate',
    run: async ctx => {
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      const cur = wins.find(w => w.id === ctx.windowId);
      let moved = 0;
      for (const w of wins) {
        if (w.id === ctx.windowId || (cur && w.incognito !== cur.incognito)) continue;
        const ids = w.tabs.map(t => t.id);
        if (ids.length) { await chrome.tabs.move(ids, { windowId: ctx.windowId, index: -1 }); moved += ids.length; }
      }
      return { toast: moved ? `Moved ${moved} tabs into this window` : 'Only one window open' };
    } },
  { id: 'move-tab-left', title: 'Move Tab Left', sub: 'Tabs', icon: 'left', keywords: 'reorder shift',
    run: async ctx => { const t = needTab(ctx); if (t.index > 0) await chrome.tabs.move(t.id, { index: t.index - 1 }); return {}; } },
  { id: 'move-tab-right', title: 'Move Tab Right', sub: 'Tabs', icon: 'right', keywords: 'reorder shift',
    run: async ctx => { const t = needTab(ctx); await chrome.tabs.move(t.id, { index: t.index + 1 }); return {}; } },
  { id: 'move-tab-first', title: 'Move Tab to Start', sub: 'Tabs', icon: 'left', keywords: 'reorder beginning first front',
    run: async ctx => { await chrome.tabs.move(needTab(ctx).id, { index: 0 }); return {}; } },
  { id: 'move-tab-last', title: 'Move Tab to End', sub: 'Tabs', icon: 'right', keywords: 'reorder last back',
    run: async ctx => { await chrome.tabs.move(needTab(ctx).id, { index: -1 }); return {}; } },

  // ---- Groups ----
  { id: 'group-tab', title: 'Add Tab to Group…', sub: 'Groups', icon: 'group', keywords: 'tab group new group organize',
    when: () => !!chrome.tabGroups,
    run: async () => ({ list: { id: 'group-tab', title: 'Add tab to group', placeholder: 'Pick a group, or type a name for a new one…' } }) },
  { id: 'ungroup-tab', title: 'Remove Tab from Group', sub: 'Groups', icon: 'group', keywords: 'ungroup',
    when: ctx => ctx.tab && ctx.tab.groupId > -1,
    run: async ctx => { await chrome.tabs.ungroup(needTab(ctx).id); return { toast: 'Tab ungrouped' }; } },
  { id: 'group-by-domain', title: 'Group Tabs by Domain', sub: 'Groups', icon: 'group', keywords: 'organize site cluster',
    when: () => !!chrome.tabGroups,
    run: async ctx => {
      const tabs = (await windowTabs(ctx)).filter(t => !t.pinned && t.groupId === -1 && hostOf(t.url));
      const by = new Map();
      for (const t of tabs) { const h = hostOf(t.url); if (!by.has(h)) by.set(h, []); by.get(h).push(t.id); }
      let n = 0, c = 0;
      for (const [host, ids] of by) {
        if (ids.length < 2) continue;
        const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: ctx.windowId } });
        await chrome.tabGroups.update(gid, { title: host.split('.').slice(-2, -1)[0] || host, color: GROUP_COLORS[c++ % GROUP_COLORS.length] });
        n++;
      }
      return { toast: n ? `Created ${n} group${n === 1 ? '' : 's'}` : 'No domains with 2+ ungrouped tabs' };
    } },
  { id: 'ungroup-all', title: 'Ungroup All Tabs in Window', sub: 'Groups', icon: 'group', keywords: 'remove groups',
    when: () => !!chrome.tabGroups,
    run: async ctx => {
      const ids = (await windowTabs(ctx)).filter(t => t.groupId > -1).map(t => t.id);
      if (ids.length) await chrome.tabs.ungroup(ids);
      return { toast: ids.length ? `Ungrouped ${ids.length} tabs` : 'No grouped tabs' };
    } },
  { id: 'collapse-groups', title: 'Collapse All Groups', sub: 'Groups', icon: 'group', keywords: 'fold hide',
    when: () => !!chrome.tabGroups,
    run: async ctx => {
      const groups = await chrome.tabGroups.query({ windowId: ctx.windowId });
      const activeGroup = ctx.tab ? ctx.tab.groupId : -1;
      await Promise.all(groups.filter(g => g.id !== activeGroup).map(g => chrome.tabGroups.update(g.id, { collapsed: true })));
      return {};
    } },
  { id: 'expand-groups', title: 'Expand All Groups', sub: 'Groups', icon: 'group', keywords: 'unfold show',
    when: () => !!chrome.tabGroups,
    run: async ctx => {
      const groups = await chrome.tabGroups.query({ windowId: ctx.windowId });
      await Promise.all(groups.map(g => chrome.tabGroups.update(g.id, { collapsed: false })));
      return {};
    } },

  // ---- Bulk tab cleanup ----
  { id: 'close-other-tabs', title: 'Close Other Tabs', sub: 'Tabs', icon: 'x', keywords: 'only this keep',
    run: async ctx => { const t = needTab(ctx); return closeTabs((await windowTabs(ctx)).filter(x => x.id !== t.id && !x.pinned).map(x => x.id)); } },
  { id: 'close-tabs-right', title: 'Close Tabs to the Right', sub: 'Tabs', icon: 'x', keywords: 'after',
    run: async ctx => { const t = needTab(ctx); return closeTabs((await windowTabs(ctx)).filter(x => x.index > t.index && !x.pinned).map(x => x.id)); } },
  { id: 'close-tabs-left', title: 'Close Tabs to the Left', sub: 'Tabs', icon: 'x', keywords: 'before',
    run: async ctx => { const t = needTab(ctx); return closeTabs((await windowTabs(ctx)).filter(x => x.index < t.index && !x.pinned).map(x => x.id)); } },
  { id: 'close-duplicates', title: 'Close Duplicate Tabs', sub: 'Tabs', icon: 'duplicate', keywords: 'dedupe dedup same',
    run: async ctx => {
      const tabs = await chrome.tabs.query({});
      const keep = new Map();
      const close = [];
      // Prefer keeping the current tab, then pinned, then the earliest.
      tabs.sort((a, b) => (b.id === (ctx.tab && ctx.tab.id)) - (a.id === (ctx.tab && ctx.tab.id)) || (b.pinned - a.pinned) || (a.windowId - b.windowId) || (a.index - b.index));
      for (const t of tabs) {
        const k = (t.incognito ? 'i:' : '') + urlKey(t.url || t.pendingUrl);
        if (!k) continue;
        if (keep.has(k)) close.push(t.id); else keep.set(k, t.id);
      }
      return closeTabs(close);
    } },
  { id: 'close-domain', title: 'Close All Tabs from Site…', sub: 'Tabs', icon: 'x', keywords: 'domain host',
    run: async () => ({ list: { id: 'close-domain', title: 'Close all tabs from site', placeholder: 'Pick a site…' } }) },
  { id: 'sort-by-domain', title: 'Sort Tabs by Domain', sub: 'Tabs', icon: 'sort', keywords: 'order organize arrange alphabetical',
    run: async ctx => {
      const tabs = (await windowTabs(ctx)).filter(t => !t.pinned && t.groupId === -1);
      const sorted = tabs.slice().sort((a, b) => {
        const ha = hostOf(a.url) || 'zzzz' + (a.url || '');
        const hb = hostOf(b.url) || 'zzzz' + (b.url || '');
        return ha.localeCompare(hb) || (a.url || '').localeCompare(b.url || '');
      });
      for (const t of sorted) await chrome.tabs.move(t.id, { index: -1 });
      return { toast: `Sorted ${sorted.length} tabs` };
    } },
  { id: 'discard-tab', title: 'Discard Tab (Free Memory)', sub: 'Tabs', icon: 'sleep', keywords: 'suspend unload sleep memory',
    run: async ctx => {
      const t = needTab(ctx);
      // The active tab cannot be discarded: switch to the last used tab first.
      const prev = await previousTabId(t.id);
      const others = prev ? [await chrome.tabs.get(prev)] : (await windowTabs(ctx)).filter(x => x.id !== t.id);
      if (!others.length) return { toast: 'Cannot discard the only tab' };
      await focusTab(others[0]);
      try { await chrome.tabs.discard(t.id); } catch (e) { return { toast: 'This tab cannot be discarded' }; }
      return { toast: 'Tab discarded' };
    } },
  { id: 'discard-others', title: 'Discard All Other Tabs', sub: 'Tabs', icon: 'sleep', keywords: 'suspend unload sleep memory free',
    run: async ctx => {
      const tabs = (await chrome.tabs.query({ active: false, discarded: false })).filter(t => !t.audible);
      let n = 0;
      for (const t of tabs) { try { await chrome.tabs.discard(t.id); n++; } catch (e) { /* some tabs refuse */ } }
      return { toast: `Discarded ${n} tab${n === 1 ? '' : 's'}` };
    } },

  // ---- Page ----
  { id: 'bookmark-page', title: ctx => (ctx.bookmarked ? 'Remove Bookmark for This Page' : 'Bookmark This Page'), sub: 'Page', icon: 'star', keywords: 'bookmark save favorite star unbookmark',
    when: ctx => !!(ctx.tab && ctx.tab.url),
    run: async ctx => {
      const t = needTab(ctx);
      const existing = await chrome.bookmarks.search({ url: t.url });
      if (existing.length) {
        await Promise.all(existing.map(b => chrome.bookmarks.remove(b.id)));
        return { toast: 'Bookmark removed' };
      }
      await chrome.bookmarks.create({ title: t.title || t.url, url: t.url });
      return { toast: 'Bookmarked to Other Bookmarks' };
    } },
  { id: 'copy-url', title: 'Copy URL', sub: 'Page', icon: 'copy', keywords: 'link address clipboard',
    run: async ctx => ({ clipboard: needTab(ctx).url, toast: 'URL copied' }) },
  { id: 'copy-title', title: 'Copy Page Title', sub: 'Page', icon: 'copy', keywords: 'name clipboard',
    run: async ctx => ({ clipboard: needTab(ctx).title || '', toast: 'Title copied' }) },
  { id: 'copy-markdown', title: 'Copy as Markdown Link', sub: 'Page', icon: 'copy', keywords: 'md link clipboard',
    run: async ctx => { const t = needTab(ctx); return { clipboard: `[${mdEscape(t.title || t.url)}](${t.url})`, toast: 'Markdown link copied' }; } },
  { id: 'copy-all-urls', title: 'Copy All Tab URLs in Window', sub: 'Page', icon: 'copy', keywords: 'links list clipboard',
    run: async ctx => { const tabs = await windowTabs(ctx); return { clipboard: tabs.map(t => t.url).join('\n'), toast: `Copied ${tabs.length} URLs` }; } },
  { id: 'copy-domain', title: 'Copy Domain', sub: 'Page', icon: 'copy', keywords: 'host site clipboard',
    when: ctx => !!hostOf(ctx.tab && ctx.tab.url),
    run: async ctx => ({ clipboard: hostOf(needTab(ctx).url), toast: 'Domain copied' }) },
  { id: 'clear-site-cache', title: 'Clear Cache for This Site', sub: 'Privacy', icon: 'trash', keywords: 'cache storage service worker browsingdata purge',
    when: ctx => !!originOf(ctx.tab && ctx.tab.url),
    run: async ctx => {
      const t = needTab(ctx);
      const origin = originOf(t.url);
      // The HTTP cache cannot be filtered by origin, so clear the per-origin caches
      // (Cache Storage, service workers) and hard-reload to refetch everything else.
      await chrome.browsingData.remove({ origins: [origin] }, { cacheStorage: true, serviceWorkers: true });
      await chrome.tabs.reload(t.id, { bypassCache: true });
      return { toast: `Cleared cache for ${hostOf(t.url)} and reloaded` };
    } },
  { id: 'clear-site-data', title: 'Clear Cookies and Site Data for This Site…', sub: 'Privacy', icon: 'trash', keywords: 'cookies storage localstorage indexeddb logout reset browsingdata',
    when: ctx => !!originOf(ctx.tab && ctx.tab.url),
    run: async ctx => ({ list: { id: 'confirm-clear-site-data', title: 'Clear site data for ' + hostOf(needTab(ctx).url), placeholder: 'This signs you out of the site. Confirm?' } }) },
  { id: 'view-source', title: 'View Page Source', sub: 'Page', icon: 'code', keywords: 'html developer',
    when: ctx => isWeb(ctx.tab),
    run: async ctx => { const t = needTab(ctx); await chrome.tabs.create({ url: 'view-source:' + t.url, index: t.index + 1, windowId: t.windowId }); return {}; } },
  { id: 'print', title: 'Print Page', sub: 'Page', icon: 'print', keywords: 'pdf save paper',
    when: ctx => isWeb(ctx.tab), run: async () => ({ pageOp: 'print' }) },
  { id: 'scroll-top', title: 'Scroll to Top', sub: 'Page', icon: 'up', keywords: 'beginning start home',
    when: ctx => isWeb(ctx.tab), run: async () => ({ pageOp: 'scrollTop' }) },
  { id: 'scroll-bottom', title: 'Scroll to Bottom', sub: 'Page', icon: 'down', keywords: 'end footer',
    when: ctx => isWeb(ctx.tab), run: async () => ({ pageOp: 'scrollBottom' }) },
  { id: 'toggle-fullscreen', title: 'Toggle Fullscreen', sub: 'View', icon: 'fullscreen', keywords: 'full screen maximize f11',
    run: async ctx => {
      const w = await chrome.windows.get(ctx.windowId);
      if (w.state === 'fullscreen') {
        let prev = 'normal';
        try { prev = (await chrome.storage.session.get('preFullscreen')).preFullscreen || 'normal'; } catch (e) { /* ignore */ }
        await chrome.windows.update(w.id, { state: prev });
      } else {
        try { await chrome.storage.session.set({ preFullscreen: w.state === 'maximized' ? 'maximized' : 'normal' }); } catch (e) { /* ignore */ }
        await chrome.windows.update(w.id, { state: 'fullscreen' });
      }
      return {};
    } },
  { id: 'zoom-in', title: 'Zoom In', sub: 'View', icon: 'zoomIn', keywords: 'bigger larger magnify', run: ctx => zoomBy(ctx, 1) },
  { id: 'zoom-out', title: 'Zoom Out', sub: 'View', icon: 'zoomOut', keywords: 'smaller', run: ctx => zoomBy(ctx, -1) },
  { id: 'zoom-reset', title: 'Reset Zoom', sub: 'View', icon: 'zoomReset', keywords: 'actual size 100%', run: ctx => zoomBy(ctx, 0) },

  // ---- Browser pages ----
  { id: 'open-downloads', title: 'Open Downloads', sub: 'Browser', icon: 'download', keywords: 'files', run: ctx => openChromePage(ctx, 'downloads') },
  { id: 'open-extensions', title: 'Open Extensions', sub: 'Browser', icon: 'puzzle', keywords: 'addons plugins', run: ctx => openChromePage(ctx, 'extensions') },
  { id: 'open-shortcuts', title: 'Open Extension Keyboard Shortcuts', sub: 'Browser', icon: 'keyboard', keywords: 'hotkeys keys bindings', run: ctx => openChromePage(ctx, 'extensions/shortcuts') },
  { id: 'open-settings', title: 'Open Browser Settings', sub: 'Browser', icon: 'gear', keywords: 'preferences options', run: ctx => openChromePage(ctx, 'settings') },
  { id: 'open-history', title: 'Open History', sub: 'Browser', icon: 'clock', keywords: 'visited', run: ctx => openChromePage(ctx, 'history') },
  { id: 'open-bookmarks', title: 'Open Bookmark Manager', sub: 'Browser', icon: 'star', keywords: 'favorites', run: ctx => openChromePage(ctx, 'bookmarks') },
  { id: 'open-clear-data', title: 'Open Clear Browsing Data', sub: 'Privacy', icon: 'trash', keywords: 'history cache cookies', run: ctx => openChromePage(ctx, 'settings/clearBrowserData') },
  { id: 'open-passwords', title: 'Open Password Manager', sub: 'Browser', icon: 'key', keywords: 'passwords logins autofill', run: ctx => openChromePage(ctx, 'settings/passwords') },

  // ---- Palette ----
  { id: 'search-tabs', title: 'Search Open Tabs', sub: 'Palette', icon: 'tab', keywords: 'find switch >', run: async () => ({ setQuery: '>' }) },
  { id: 'search-bookmarks', title: 'Search Bookmarks', sub: 'Palette', icon: 'star', keywords: 'find #', run: async () => ({ setQuery: '#' }) },
  { id: 'search-history', title: 'Search History', sub: 'Palette', icon: 'clock', keywords: 'find visited @', run: async () => ({ setQuery: '@' }) },
  { id: 'search-actions', title: 'Show All Actions', sub: 'Palette', icon: 'command', keywords: 'commands list help /', run: async () => ({ setQuery: '/' }) },
  { id: 'palette-settings', title: 'Command Palette Settings', sub: 'Palette', icon: 'gear', keywords: 'options custom commands quicklinks preferences configure',
    run: async () => { await chrome.runtime.openOptionsPage(); return {}; } },
];

const BY_ID = new Map(ACTIONS.map(a => [a.id, a]));
export function getAction(id) { return BY_ID.get(id); }

export function actionTitle(a, ctx) {
  return typeof a.title === 'function' ? a.title(ctx) : a.title;
}

export function availableActions(ctx) {
  return ACTIONS.filter(a => {
    try { return !a.when || a.when(ctx); } catch (e) { return false; }
  });
}

// ---- Sub-lists ----
// Each returns raw items { title, sub, icon, arg, always?, fav? }; `always` items skip filtering.
export const LISTS = {
  async 'move-to-window'(ctx) {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const items = [];
    let n = 0;
    for (const w of wins) {
      n++;
      if (w.id === ctx.windowId) continue;
      const active = (w.tabs || []).find(t => t.active) || (w.tabs || [])[0];
      items.push({
        title: `Window ${n}: ${active ? active.title : ''}`,
        sub: `${(w.tabs || []).length} tabs${w.incognito ? ' · incognito' : ''}`,
        icon: 'window', arg: w.id,
      });
    }
    items.push({ title: 'New Window', sub: 'Move the tab into a new window', icon: 'plus', arg: 'new', always: true });
    return items;
  },
  async 'group-tab'(ctx, query) {
    const items = [];
    const groups = chrome.tabGroups ? await chrome.tabGroups.query({ windowId: ctx.windowId }) : [];
    for (const g of groups) {
      items.push({ title: g.title || '(unnamed group)', sub: `${g.color} group`, icon: 'group', arg: g.id, color: g.color });
    }
    const name = (query || '').trim();
    items.push({ title: name ? `New Group “${name}”` : 'New Group', sub: name ? 'Create a group with this name' : 'Type a name to label the group', icon: 'plus', arg: 'new:' + name, always: true });
    return items;
  },
  async 'close-domain'() {
    const tabs = await chrome.tabs.query({});
    const by = new Map();
    for (const t of tabs) { const h = hostOf(t.url); if (h) by.set(h, (by.get(h) || 0) + 1); }
    return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([h, c]) => ({
      title: h, sub: `${c} tab${c === 1 ? '' : 's'}`, icon: 'x', arg: h, fav: 'https://' + h + '/',
    }));
  },
  async 'confirm-clear-site-data'(ctx) {
    const h = hostOf(ctx.tab && ctx.tab.url);
    return [
      { title: `Yes, clear cookies and storage for ${h}`, sub: 'Cookies, local storage, IndexedDB, Cache Storage, service workers', icon: 'trash', arg: 'yes', always: true },
      { title: 'Cancel', sub: 'Keep everything', icon: 'x', arg: 'no', always: true },
    ];
  },
};

/** Run the chosen sub-list entry. */
export async function runListItem(listId, arg, ctx) {
  switch (listId) {
    case 'move-to-window': {
      const t = needTab(ctx);
      if (arg === 'new') { await chrome.windows.create({ tabId: t.id, focused: true }); return {}; }
      await chrome.tabs.move(t.id, { windowId: arg, index: -1 });
      await focusTab(await chrome.tabs.get(t.id));
      return {};
    }
    case 'group-tab': {
      const t = needTab(ctx);
      if (typeof arg === 'string' && arg.startsWith('new:')) {
        const name = arg.slice(4);
        const gid = await chrome.tabs.group({ tabIds: [t.id] });
        const used = new Set((await chrome.tabGroups.query({ windowId: t.windowId })).map(g => g.color));
        const color = GROUP_COLORS.find(c => !used.has(c)) || GROUP_COLORS[0];
        await chrome.tabGroups.update(gid, { title: name, color });
        return { toast: name ? `Added to new group “${name}”` : 'Added to new group' };
      }
      await chrome.tabs.group({ tabIds: [t.id], groupId: arg });
      return { toast: 'Added to group' };
    }
    case 'close-domain': {
      const tabs = (await chrome.tabs.query({})).filter(t => hostOf(t.url) === arg);
      return closeTabs(tabs.map(t => t.id));
    }
    case 'confirm-clear-site-data': {
      if (arg !== 'yes') return {};
      const t = needTab(ctx);
      const origin = originOf(t.url);
      await chrome.browsingData.remove({ origins: [origin] }, {
        cookies: true, localStorage: true, indexedDB: true, cacheStorage: true,
        serviceWorkers: true, fileSystems: true,
      });
      await chrome.tabs.reload(t.id, { bypassCache: true });
      return { toast: `Cleared site data for ${prettyUrl(origin)}` };
    }
    default:
      return { error: 'Unknown list' };
  }
}
