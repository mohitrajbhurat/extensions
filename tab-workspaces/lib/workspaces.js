// Workspaces: named, colored sets of tabs (with groups) that can be swapped into a window.
import * as store from './store.js';
import { uid, GROUP_COLORS } from './util.js';
import { captureWindow, openTabs, openInNewWindow, closeTabs, quiet, tabUrl, lastFocusedNormalWindow, isOwnPage } from './tabs.js';
import { createStash } from './stash.js';

const WS = 'workspaces';

export async function bindings() { return store.sget('bindings', {}); }

export async function bind(windowId, wsId) {
  await store.supdate('bindings', {}, b => {
    for (const k of Object.keys(b)) if (b[k] === wsId || +k === windowId) delete b[k];
    if (wsId) b[windowId] = wsId;
  });
}

export async function unbindWindow(windowId) {
  await store.supdate('bindings', {}, b => { delete b[windowId]; });
}

export async function workspaceForWindow(windowId) {
  const b = await bindings();
  return b[windowId] || null;
}

async function windowForWorkspace(wsId) {
  const b = await bindings();
  for (const [w, id] of Object.entries(b)) if (id === wsId) {
    try { await chrome.windows.get(+w); return +w; } catch {}
  }
  return null;
}

function pickColor(list) {
  const used = new Set(list.map(w => w.color));
  return GROUP_COLORS.find(c => !used.has(c) && c !== 'grey') || GROUP_COLORS[list.length % GROUP_COLORS.length];
}

export async function createWorkspace({ name, color, source = 'window', windowId, switchTo = false } = {}) {
  const win = windowId ? { id: windowId } : await lastFocusedNormalWindow();
  let data = { tabs: [], groups: [] };
  if (source === 'window' && win) data = await captureWindow(win.id, { includeBlank: false });
  else if (source === 'selected' && win) data = await captureWindow(win.id, { filter: t => t.highlighted });
  const s = await store.getSettings();
  if (source === 'window' && s.keepPinnedOnSwitch) data = dropPinned(data);
  let ws;
  await store.update(WS, [], list => {
    ws = {
      id: uid('ws_'),
      name: (name || '').trim() || `Workspace ${list.length + 1}`,
      color: color || pickColor(list),
      tabs: data.tabs, groups: data.groups,
      createdAt: Date.now(), updatedAt: Date.now(), lastOpenedAt: source === 'window' ? Date.now() : 0,
    };
    list.push(ws);
  });
  if (source === 'window' && win) await bind(win.id, ws.id);
  else if (switchTo && win) await switchWorkspace(ws.id, { windowId: win.id });
  return ws;
}

function dropPinned(data) {
  // Pinned tabs stay put across workspaces when keepPinnedOnSwitch is on, so they are not stored per workspace.
  return { ...data, tabs: data.tabs.filter(t => !t.pinned) };
}

/** Persist the window's current tabs into its workspace. */
export async function saveWindow(wsId, windowId) {
  let data;
  try { data = await captureWindow(windowId, { includeBlank: false }); } catch { return; }
  const s = await store.getSettings();
  if (s.keepPinnedOnSwitch) data = dropPinned(data);
  await store.update(WS, [], list => {
    const ws = list.find(w => w.id === wsId);
    if (!ws) return;
    ws.tabs = data.tabs; ws.groups = data.groups; ws.updatedAt = Date.now();
  });
}

const timers = new Map();
export function scheduleAutosave(windowId) {
  if (windowId == null || windowId < 0) return;
  clearTimeout(timers.get(windowId));
  timers.set(windowId, setTimeout(async () => {
    timers.delete(windowId);
    if (quiet.windows.has(windowId)) { scheduleAutosave(windowId); return; }
    const s = await store.getSettings();
    if (!s.autosaveWorkspaces) return;
    const wsId = await workspaceForWindow(windowId);
    if (wsId) await saveWindow(wsId, windowId);
  }, 1200));
}

/**
 * Swap the window's tabs for the target workspace. Saves the current workspace first
 * (or stashes an unsaved window) so nothing is lost.
 */
export async function switchWorkspace(wsId, { windowId, newWindow = false } = {}) {
  const list = await store.get(WS, []);
  const target = list.find(w => w.id === wsId);
  if (!target) throw new Error('Workspace not found');
  const s = await store.getSettings();

  const openIn = await windowForWorkspace(wsId);
  if (openIn != null) {
    await chrome.windows.update(openIn, { focused: true });
    return { focused: openIn };
  }

  const touch = () => store.update(WS, [], l => { const w = l.find(x => x.id === wsId); if (w) w.lastOpenedAt = Date.now(); });

  if (newWindow) {
    const winId = await openInNewWindow({ tabs: target.tabs, groups: target.groups }, { lazy: s.lazyRestore });
    await bind(winId, wsId);
    await touch();
    return { windowId: winId };
  }

  const win = windowId ? await chrome.windows.get(windowId) : await lastFocusedNormalWindow();
  if (!win) throw new Error('No browser window');
  const wid = win.id;
  quiet.windows.add(wid);
  try {
    clearTimeout(timers.get(wid));
    const currentId = await workspaceForWindow(wid);
    if (currentId === wsId) return { windowId: wid, unchanged: true };
    if (currentId) {
      await saveWindow(currentId, wid);
    } else if (s.stashUnsavedOnSwitch) {
      const snap = await captureWindow(wid, { filter: t => !(s.keepPinnedOnSwitch && t.pinned), includeBlank: false });
      if (snap.tabs.length) await createStash(snap.tabs, `Window before “${target.name}”`);
    }

    const existing = await chrome.tabs.query({ windowId: wid });
    const keep = existing.filter(t => (s.keepPinnedOnSwitch && t.pinned) || isOwnPage(t));
    const toClose = existing.filter(t => !keep.includes(t)).map(t => t.id);
    const keepUrls = new Set(keep.filter(t => t.pinned).map(tabUrl));

    let created = [];
    if (target.tabs.length) {
      created = await openTabs(wid, { tabs: target.tabs, groups: target.groups }, { lazy: s.lazyRestore, skipPinnedUrls: keepUrls });
    }
    if (!created.length) {
      // Empty workspace: leave a fresh new tab page to start from.
      const t = await chrome.tabs.create({ windowId: wid, active: true });
      quiet.opening.add(t.id);
    }
    await closeTabs(toClose);
    await bind(wid, wsId);
    await touch();
    return { windowId: wid };
  } finally {
    setTimeout(() => quiet.windows.delete(wid), 800);
  }
}

/** Save and close the workspace in its window, leaving a fresh tab. */
export async function closeWorkspace(windowId) {
  const wsId = await workspaceForWindow(windowId);
  if (!wsId) return;
  quiet.windows.add(windowId);
  try {
    await saveWindow(wsId, windowId);
    const s = await store.getSettings();
    const tabs = await chrome.tabs.query({ windowId });
    const toClose = tabs.filter(t => !(s.keepPinnedOnSwitch && t.pinned) && !isOwnPage(t)).map(t => t.id);
    const t = await chrome.tabs.create({ windowId, active: true });
    quiet.opening.add(t.id);
    await closeTabs(toClose);
    await unbindWindow(windowId);
  } finally {
    setTimeout(() => quiet.windows.delete(windowId), 800);
  }
}

export async function updateWorkspace(wsId, patch) {
  const allowed = ['name', 'color', 'tabs', 'groups'];
  await store.update(WS, [], list => {
    const ws = list.find(w => w.id === wsId);
    if (!ws) return;
    for (const k of allowed) if (patch[k] !== undefined) ws[k] = patch[k];
    if (typeof ws.name === 'string') ws.name = ws.name.trim().slice(0, 80) || 'Untitled';
    ws.updatedAt = Date.now();
  });
}

export async function deleteWorkspace(wsId) {
  await store.update(WS, [], list => list.filter(w => w.id !== wsId));
  await store.supdate('bindings', {}, b => { for (const k of Object.keys(b)) if (b[k] === wsId) delete b[k]; });
}

export async function duplicateWorkspace(wsId) {
  await store.update(WS, [], list => {
    const ws = list.find(w => w.id === wsId);
    if (!ws) return;
    list.push({ ...structuredClone(ws), id: uid('ws_'), name: ws.name + ' copy', createdAt: Date.now(), updatedAt: Date.now(), lastOpenedAt: 0 });
  });
}

export async function removeWorkspaceTab(wsId, index) {
  await store.update(WS, [], list => {
    const ws = list.find(w => w.id === wsId);
    if (ws) ws.tabs.splice(index, 1);
  });
}

export async function reorderWorkspaces(ids) {
  await store.update(WS, [], list => {
    const pos = new Map(ids.map((id, i) => [id, i]));
    return list.slice().sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  });
}

/** Add tabs to a workspace without switching (e.g. "add this tab to workspace"). */
export async function addTabsToWorkspace(wsId, tabs) {
  await store.update(WS, [], list => {
    const ws = list.find(w => w.id === wsId);
    if (ws) { ws.tabs.push(...tabs.map(t => ({ ...t, group: -1, active: false }))); ws.updatedAt = Date.now(); }
  });
}

/** Cycle to the next workspace in the current window. */
export async function switchRelative(delta) {
  const list = await store.get(WS, []);
  if (!list.length) return;
  const win = await lastFocusedNormalWindow();
  const cur = await workspaceForWindow(win.id);
  const i = list.findIndex(w => w.id === cur);
  const next = list[(i + delta + list.length) % list.length];
  if (next && next.id !== cur) await switchWorkspace(next.id, { windowId: win.id });
}

/** After a browser restart window ids change; rebind windows whose tabs match a workspace. */
export async function rebindAfterRestart() {
  const list = await store.get(WS, []);
  if (!list.length) return;
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const b = {};
  const used = new Set();
  for (const w of wins) {
    const urls = new Set(w.tabs.filter(t => !t.pinned).map(tabUrl));
    if (!urls.size) continue;
    let best = null, bestScore = 0;
    for (const ws of list) {
      if (used.has(ws.id) || !ws.tabs.length) continue;
      const wsUrls = new Set(ws.tabs.filter(t => !t.pinned).map(t => t.url));
      let inter = 0; for (const u of urls) if (wsUrls.has(u)) inter++;
      const score = inter / Math.max(urls.size, wsUrls.size);
      if (score > bestScore) { bestScore = score; best = ws; }
    }
    if (best && bestScore >= 0.6) { b[w.id] = best.id; used.add(best.id); }
  }
  await store.sset('bindings', b);
}
