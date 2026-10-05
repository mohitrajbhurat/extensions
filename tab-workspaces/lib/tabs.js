// Low-level helpers for capturing and recreating sets of tabs (with tab groups).
import { isRestorableUrl, isMeaningfulUrl } from './util.js';

/** Tab ids that the extension itself is opening/closing; event handlers ignore them. */
export const quiet = {
  closing: new Set(),     // tabs we close: don't archive
  opening: new Set(),     // tabs we open: skip duplicate guard and auto-grouping
  windows: new Set(),     // windows mid-switch: skip autosave
};

export function tabUrl(t) { return t.url || t.pendingUrl || ''; }

export function serializeTab(t) {
  return {
    url: tabUrl(t),
    title: t.title || tabUrl(t),
    favIconUrl: t.favIconUrl && !t.favIconUrl.startsWith('data:') ? t.favIconUrl : '',
    pinned: !!t.pinned,
  };
}

/** Capture tabs (optionally a subset) of a window, preserving groups. */
export async function captureWindow(windowId, { filter, includeBlank = true } = {}) {
  let tabs = await chrome.tabs.query({ windowId });
  if (filter) tabs = tabs.filter(filter);
  if (!includeBlank) tabs = tabs.filter(t => isMeaningfulUrl(tabUrl(t)));
  const groupIndex = new Map();
  const groups = [];
  if (chrome.tabGroups) {
    for (const t of tabs) {
      if (t.groupId > -1 && !groupIndex.has(t.groupId)) {
        try {
          const g = await chrome.tabGroups.get(t.groupId);
          groupIndex.set(t.groupId, groups.length);
          groups.push({ title: g.title || '', color: g.color, collapsed: !!g.collapsed });
        } catch { groupIndex.set(t.groupId, -1); }
      }
    }
  }
  return {
    tabs: tabs.map(t => ({ ...serializeTab(t), group: t.groupId > -1 ? groupIndex.get(t.groupId) ?? -1 : -1, active: !!t.active })),
    groups,
  };
}

/** Discard a freshly created background tab once it has committed its URL. */
export function discardWhenReady(tabId, timeout = 15000) {
  return new Promise(resolve => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      try {
        const t = await chrome.tabs.get(tabId);
        if (!t.active && !t.discarded && t.url && !t.url.startsWith('chrome')) await chrome.tabs.discard(tabId);
      } catch {}
      resolve();
    };
    const listener = (id, info, tab) => {
      if (id === tabId && tab.url && tab.url !== 'about:blank' && (info.url || info.status)) finish();
    };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t.url && t.url !== 'about:blank' && t.status !== 'unloaded') finish(); }).catch(finish);
  });
}

/**
 * Open a list of saved tabs in a window and recreate their groups.
 * data: {tabs:[{url,title,pinned,group,active}], groups:[{title,color,collapsed}]}
 * Returns the created tab ids.
 */
export async function openTabs(windowId, data, { lazy = false, activate = true, skipPinnedUrls = new Set() } = {}) {
  const created = [];
  const groupMembers = new Map();
  const tabs = (data.tabs || []).filter(t => isRestorableUrl(t.url));
  let activeIdx = tabs.findIndex(t => t.active);
  if (activeIdx < 0) activeIdx = tabs.findIndex(t => !t.pinned);
  if (activeIdx < 0) activeIdx = 0;
  const lazyJobs = [];
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (t.pinned && skipPinnedUrls.has(t.url)) continue;
    let tab;
    try {
      tab = await chrome.tabs.create({ windowId, url: t.url, pinned: !!t.pinned, active: activate && i === activeIdx });
    } catch (e) {
      console.warn('Could not open', t.url, e?.message);
      continue;
    }
    quiet.opening.add(tab.id);
    setTimeout(() => quiet.opening.delete(tab.id), 20000);
    created.push(tab.id);
    if (t.group > -1 && data.groups?.[t.group] && !t.pinned) {
      if (!groupMembers.has(t.group)) groupMembers.set(t.group, []);
      groupMembers.get(t.group).push(tab.id);
    }
    if (lazy && !(activate && i === activeIdx)) lazyJobs.push(discardWhenReady(tab.id));
  }
  if (chrome.tabGroups) {
    for (const [gi, ids] of groupMembers) {
      const g = data.groups[gi];
      try {
        const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed });
      } catch (e) { console.warn('Group restore failed', e?.message); }
    }
  }
  if (lazyJobs.length) Promise.all(lazyJobs).catch(() => {});
  return created;
}

/** Open saved tabs in a brand new window. */
export async function openInNewWindow(data, opts = {}) {
  const win = await chrome.windows.create({ focused: true });
  const [blank] = await chrome.tabs.query({ windowId: win.id });
  const created = await openTabs(win.id, data, opts);
  if (blank && created.length) await closeTabs([blank.id]);
  return win.id;
}

/** Close tabs without archiving them. */
export async function closeTabs(ids) {
  if (!ids.length) return;
  ids.forEach(id => quiet.closing.add(id));
  setTimeout(() => ids.forEach(id => quiet.closing.delete(id)), 10000);
  try { await chrome.tabs.remove(ids); } catch {
    for (const id of ids) { try { await chrome.tabs.remove(id); } catch {} }
  }
}

export async function lastFocusedNormalWindow() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w && w.type === 'normal') return w;
  } catch {}
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return all[0];
}
