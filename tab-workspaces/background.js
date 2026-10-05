// Tab Workspaces service worker: wires browser events to the feature modules and
// answers messages from the popup and dashboard.
import * as store from './lib/store.js';
import * as ws from './lib/workspaces.js';
import * as stash from './lib/stash.js';
import * as sessions from './lib/sessions.js';
import * as memory from './lib/memory.js';
import * as dups from './lib/duplicates.js';
import * as grouping from './lib/grouping.js';
import * as archive from './lib/archive.js';
import * as transfer from './lib/transfer.js';
import { quiet, tabUrl, serializeTab, lastFocusedNormalWindow } from './lib/tabs.js';
import { hostOf, DEFAULT_SETTINGS } from './lib/util.js';

const DASHBOARD = 'dashboard/dashboard.html';

// ---------- Badge ----------
let badgeTimer = null;
function refreshBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const s = await store.getSettings();
    if (s.badgeMode === 'off') { chrome.action.setBadgeText({ text: '' }); return; }
    let tabs;
    if (s.badgeMode === 'window') {
      const w = await lastFocusedNormalWindow();
      tabs = w ? await chrome.tabs.query({ windowId: w.id }) : [];
    } else tabs = await chrome.tabs.query({});
    const n = tabs.length;
    chrome.action.setBadgeText({ text: n > 999 ? '999+' : String(n) });
    chrome.action.setBadgeBackgroundColor({ color: n >= (+s.badgeWarnAt || 50) ? '#c5221f' : '#3c4a5e' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }, 150);
}

dups.setBadgeRestorer(refreshBadge);

// ---------- Context menus ----------
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = (o) => chrome.contextMenus.create(o, () => void chrome.runtime.lastError);
    add({ id: 'a:stash-all', title: 'Stash all tabs in this window', contexts: ['action'] });
    add({ id: 'a:stash-others', title: 'Stash other tabs', contexts: ['action'] });
    add({ id: 'a:suspend-others', title: 'Suspend other tabs', contexts: ['action'] });
    add({ id: 'a:close-dups', title: 'Close duplicate tabs', contexts: ['action'] });
    add({ id: 'a:snapshot', title: 'Save session snapshot now', contexts: ['action'] });
    add({ id: 'a:dashboard', title: 'Open dashboard', contexts: ['action'] });
    add({ id: 'p:root', title: 'Tab Workspaces', contexts: ['page'] });
    add({ id: 'p:stash-tab', parentId: 'p:root', title: 'Stash this tab', contexts: ['page'] });
    add({ id: 'p:stash-all', parentId: 'p:root', title: 'Stash all tabs in this window', contexts: ['page'] });
    add({ id: 'p:stash-others', parentId: 'p:root', title: 'Stash other tabs', contexts: ['page'] });
    add({ id: 'p:sep1', parentId: 'p:root', type: 'separator', contexts: ['page'] });
    add({ id: 'p:suspend-tab', parentId: 'p:root', title: 'Suspend this tab', contexts: ['page'] });
    add({ id: 'p:whitelist', parentId: 'p:root', title: 'Never suspend this site', contexts: ['page'] });
    add({ id: 'p:sep2', parentId: 'p:root', type: 'separator', contexts: ['page'] });
    add({ id: 'p:close-dups', parentId: 'p:root', title: 'Close duplicate tabs', contexts: ['page'] });
    add({ id: 'p:dashboard', parentId: 'p:root', title: 'Open dashboard', contexts: ['page'] });
  });
}

async function openDashboard(hash = '') {
  const url = chrome.runtime.getURL(DASHBOARD);
  const [existing] = await chrome.tabs.query({ url: url + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, ...(hash ? { url: url + '#' + hash } : {}) });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url + (hash ? '#' + hash : '') });
  }
}

async function whitelistSite(url) {
  const host = hostOf(url);
  if (!host) return;
  await store.update('settings', {}, s => {
    const list = Array.isArray(s.whitelist) ? s.whitelist : [];
    if (!list.includes(host)) list.push(host);
    s.whitelist = list;
  });
}

async function runMenu(id, tab) {
  const windowId = tab?.windowId > -1 ? tab.windowId : undefined;
  switch (id.split(':')[1]) {
    case 'stash-tab': return tab && stash.stashTabs({ windowId, which: 'tabs', tabIds: [tab.id] });
    case 'stash-all': return stash.stashTabs({ windowId, which: 'all' });
    case 'stash-others': return stash.stashTabs({ windowId, which: 'others' });
    case 'suspend-tab': return tab && memory.suspendTab(tab.id);
    case 'suspend-others': return memory.suspendMany({ windowId });
    case 'whitelist': return tab && whitelistSite(tabUrl(tab));
    case 'close-dups': return dups.closeAllDuplicates('all');
    case 'snapshot': return sessions.snapshot('manual');
    case 'dashboard': return openDashboard();
  }
}

// ---------- Messages ----------
const handlers = {
  // workspaces
  'ws.create': m => ws.createWorkspace(m),
  'ws.switch': m => ws.switchWorkspace(m.id, { windowId: m.windowId, newWindow: m.newWindow }),
  'ws.close': m => ws.closeWorkspace(m.windowId),
  'ws.save': async m => { await ws.saveWindow(m.id, m.windowId); await ws.bind(m.windowId, m.id); },
  'ws.update': m => ws.updateWorkspace(m.id, m.patch || {}),
  'ws.delete': m => ws.deleteWorkspace(m.id),
  'ws.duplicate': m => ws.duplicateWorkspace(m.id),
  'ws.removeTab': m => ws.removeWorkspaceTab(m.id, m.index),
  'ws.reorder': m => ws.reorderWorkspaces(m.ids),
  'ws.addTabs': async m => {
    const tabs = await Promise.all((m.tabIds || []).map(id => chrome.tabs.get(id).catch(() => null)));
    await ws.addTabsToWorkspace(m.id, tabs.filter(Boolean).map(serializeTab));
  },
  'ws.next': m => ws.switchRelative(m.delta || 1),
  // stash
  'stash.tabs': m => stash.stashTabs(m),
  'stash.restoreTab': m => stash.restoreTab(m.stashId, m.tabId, m),
  'stash.restore': m => stash.restoreStash(m.stashId, m),
  'stash.removeTab': m => stash.removeTab(m.stashId, m.tabId),
  'stash.delete': m => stash.deleteStash(m.stashId),
  'stash.update': m => stash.updateStash(m.stashId, m.patch || {}),
  'stash.move': m => stash.moveTab(m.fromStashId, m.tabId, m.toStashId, m.index ?? -1),
  'stash.merge': m => stash.mergeStashes(m.fromId, m.intoId),
  'stash.dedupe': () => stash.dedupeStashes(),
  'stash.create': m => stash.createStash(m.tabs || [], m.name),
  // sessions
  'session.snapshot': m => sessions.snapshot('manual', m.name || ''),
  'session.restore': m => sessions.restoreSession(m.id, m),
  'session.delete': m => sessions.deleteSession(m.id),
  'session.update': m => sessions.updateSession(m.id, m.patch || {}),
  // memory
  'mem.suspendTab': m => memory.suspendTab(m.tabId),
  'mem.suspendMany': m => memory.suspendMany(m),
  'mem.sweep': () => memory.sweep(),
  'mem.whitelistSite': m => whitelistSite(m.url),
  'mem.reasons': async () => {
    const s = await store.getSettings();
    const can = s.protectForms && await memory.hasFormPermission();
    const out = {};
    for (const t of await chrome.tabs.query({})) out[t.id] = await memory.protectionReason(t, s, can);
    return out;
  },
  // duplicates
  'dup.find': m => dups.findDuplicates(m.scope || 'all', m.windowId),
  'dup.closeAll': m => dups.closeAllDuplicates(m.scope || 'all', m.windowId),
  // rules
  'rules.save': m => grouping.saveRule(m.rule),
  'rules.delete': m => grouping.deleteRule(m.id),
  'rules.reorder': m => grouping.reorderRules(m.ids),
  'rules.applyAll': () => grouping.applyAll(),
  'rules.groupByDomain': m => grouping.groupByDomain(m.windowId),
  // archive
  'archive.delete': m => archive.deleteEntries(m.ids || []),
  'archive.clear': m => archive.clear(m.olderThan || 0),
  // settings & data
  'settings.set': m => store.update('settings', {}, s => {
    for (const [k, v] of Object.entries(m.patch || {})) if (k in DEFAULT_SETTINGS) s[k] = v;
  }),
  'settings.reset': () => store.set('settings', {}),
  'data.export': () => transfer.exportAll(),
  'data.import': m => transfer.importAll(m.data, m.mode),
  'data.importOneTab': m => transfer.importOneTab(m.text),
  'ui.dashboard': m => openDashboard(m.hash || ''),
  'state.bindings': () => ws.bindings(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(result => sendResponse({ ok: true, result }))
    .catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

// ---------- Tab and window events ----------
function changed(windowId) {
  ws.scheduleAutosave(windowId);
  sessions.scheduleLive();
}

chrome.tabs.onCreated.addListener(async tab => {
  dups.noteCreated(tab.id);
  await archive.ready();
  archive.remember(tab);
  memory.touch(tab.id);
  refreshBadge();
  changed(tab.windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await archive.ready();
  archive.remember(tab);
  if (info.url) {
    await dups.check(tab);
    grouping.applyToTab(tab);
  }
  if (info.url || info.title || info.pinned !== undefined || info.groupId !== undefined) changed(tab.windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  refreshBadge();
  memory.forget(tabId);
  if (!removeInfo.isWindowClosing) changed(removeInfo.windowId);
  else sessions.scheduleLive();
  await archive.onRemoved(tabId, removeInfo);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  memory.touch(tabId);
  ws.scheduleAutosave(windowId);
});
chrome.tabs.onMoved.addListener((id, { windowId }) => changed(windowId));
chrome.tabs.onAttached.addListener((id, { newWindowId }) => { changed(newWindowId); refreshBadge(); });
chrome.tabs.onDetached.addListener((id, { oldWindowId }) => changed(oldWindowId));
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  await archive.ready();
  quiet.closing.add(removed);
  try { archive.remember(await chrome.tabs.get(added)); } catch {}
});

if (chrome.tabGroups) {
  chrome.tabGroups.onUpdated.addListener(g => changed(g.windowId));
}

chrome.windows.onRemoved.addListener(windowId => {
  ws.unbindWindow(windowId);
  refreshBadge();
});
chrome.windows.onFocusChanged.addListener(() => refreshBadge());

// ---------- Alarms, commands, menus, notifications ----------
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'session-snapshot') await sessions.snapshot('auto');
  if (a.name === 'memory-sweep') await memory.sweep();
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const w = tab?.windowId > -1 ? tab.windowId : (await lastFocusedNormalWindow())?.id;
  switch (command) {
    case 'open-dashboard': return openDashboard();
    case 'stash-all': return stash.stashTabs({ windowId: w, which: 'all' });
    case 'stash-others': return stash.stashTabs({ windowId: w, which: 'others' });
    case 'suspend-others': return memory.suspendMany({ windowId: w });
    case 'close-duplicates': return dups.closeAllDuplicates('all');
    case 'next-workspace': return ws.switchRelative(1);
    case 'previous-workspace': return ws.switchRelative(-1);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => { runMenu(info.menuItemId, tab).catch(e => console.warn(e)); });

if (chrome.notifications) {
  chrome.notifications.onButtonClicked.addListener((id, i) => { if (id.startsWith('dup:')) dups.onNotificationButton(id, i); });
  chrome.notifications.onClicked.addListener(id => { if (id.startsWith('dup:')) dups.onNotificationButton(id, 0); });
  chrome.notifications.onClosed.addListener(id => { if (id.startsWith('dup:')) dups.onNotificationClosed(id); });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    store.invalidateSettings();
    sessions.ensureAlarm();
    refreshBadge();
  }
});

// ---------- Lifecycle ----------
async function init() {
  await Promise.all([sessions.ensureAlarm(), memory.ensureAlarm(), archive.ready()]);
  refreshBadge();
}

chrome.runtime.onInstalled.addListener(async details => {
  buildMenus();
  await init();
  if (details.reason === 'install') {
    const existing = await store.get('rules', null);
    if (!existing) await store.set('rules', []);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await sessions.promoteLive();
  await ws.rebindAfterRestart();
  await init();
  sessions.scheduleLive();
});

init().catch(e => console.warn('init', e));
