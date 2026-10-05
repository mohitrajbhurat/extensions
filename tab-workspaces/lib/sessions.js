// Sessions: periodic and on-close snapshots of every window, for crash recovery.
import * as store from './store.js';
import { uid } from './util.js';
import { captureWindow, openInNewWindow, quiet } from './tabs.js';

const KEY = 'sessions';

export async function captureAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const out = [];
  for (const w of wins) {
    if (w.incognito) continue;
    const snap = await captureWindow(w.id, { includeBlank: false });
    if (snap.tabs.length) out.push({ ...snap, focused: !!w.focused });
  }
  return out;
}

function signature(windows) {
  return windows.map(w => w.tabs.map(t => t.url).join('\n')).join('\n--\n');
}

function count(windows) { return windows.reduce((n, w) => n + w.tabs.length, 0); }

function prune(list, max) {
  const starred = list.filter(s => s.starred);
  const rest = list.filter(s => !s.starred);
  const kept = rest.slice(0, Math.max(1, max));
  const ids = new Set([...starred, ...kept].map(s => s.id));
  return list.filter(s => ids.has(s.id));
}

/** Save a snapshot. Identical consecutive automatic snapshots are folded into one. */
export async function snapshot(kind = 'auto', name = '', windows = null) {
  windows = windows || await captureAll();
  if (!windows.length) return null;
  const sig = signature(windows);
  const s = await store.getSettings();
  let saved = null;
  await store.update(KEY, [], list => {
    const last = list[0];
    if (kind === 'auto' && last && last.sig === sig) { last.confirmedAt = Date.now(); saved = last; return; }
    saved = { id: uid('se_'), kind, name, createdAt: Date.now(), confirmedAt: Date.now(), windows, tabCount: count(windows), sig, starred: false };
    list.unshift(saved);
    return prune(list, s.sessionMaxCount);
  });
  return saved;
}

let liveTimer = null;
/** Keep a rolling copy of the current state so it survives a browser close or crash. */
export function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (quiet.windows.size) { scheduleLive(); return; }
    const windows = await captureAll();
    if (windows.length) await store.set('liveSession', { savedAt: Date.now(), windows, tabCount: count(windows) });
  }, 4000);
}

/** On browser start: turn the last live state into a "previous session" entry. */
export async function promoteLive() {
  const live = await store.get('liveSession', null);
  if (!live || !live.windows?.length) return;
  await snapshot('previous', 'Before browser closed', live.windows);
  await store.update(KEY, [], list => { if (list[0]?.kind === 'previous') list[0].createdAt = live.savedAt; });
  await store.set('liveSession', null);
}

export async function restoreSession(id, { windowIndex = -1 } = {}) {
  const list = await store.get(KEY, []);
  let sess = list.find(x => x.id === id);
  if (!sess && id === 'live') sess = await store.get('liveSession', null);
  if (!sess) throw new Error('Session not found');
  const s = await store.getSettings();
  const wins = windowIndex >= 0 ? [sess.windows[windowIndex]] : sess.windows;
  for (const w of wins) if (w) await openInNewWindow(w, { lazy: s.lazyRestore });
}

export async function deleteSession(id) {
  await store.update(KEY, [], list => list.filter(x => x.id !== id));
}

export async function updateSession(id, patch) {
  await store.update(KEY, [], list => {
    const x = list.find(s => s.id === id);
    if (!x) return;
    if (typeof patch.name === 'string') x.name = patch.name.trim().slice(0, 120);
    if (typeof patch.starred === 'boolean') x.starred = patch.starred;
  });
}

export async function ensureAlarm() {
  const s = await store.getSettings();
  const existing = await chrome.alarms.get('session-snapshot');
  const period = Math.max(1, +s.sessionIntervalMin || 15);
  if (!s.sessionsEnabled) { if (existing) await chrome.alarms.clear('session-snapshot'); return; }
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create('session-snapshot', { periodInMinutes: period, delayInMinutes: period });
  }
}
