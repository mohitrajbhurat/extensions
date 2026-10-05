// Page Watch service worker: scheduling, fetching, extraction, change detection and alerts.
import { addSnapshot, latestSnapshot, pruneSnapshots, deleteSnapshots } from './lib/db.js';
import { evaluateCondition, normalizeText } from './lib/conditions.js';
import { diffWords, diffStats, changeSummary } from './lib/diff.js';
import {
  getMonitors, getSettings, normalizeMonitor, originPattern, hostOf, pickConfig, uid, isWatchableUrl,
} from './lib/store.js';

const ALARM_PREFIX = 'pw:';
const OFFSCREEN_URL = 'offscreen/offscreen.html';
const MAX_HTML = 8 * 1024 * 1024;
const MAX_TEXT = 500 * 1024;
const FETCH_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// Serialized monitor storage (all writes go through here to avoid lost updates)
// ---------------------------------------------------------------------------
let writeChain = Promise.resolve();
function mutate(fn) {
  const run = writeChain.then(async () => {
    const map = await getMonitors();
    const result = await fn(map);
    await chrome.storage.local.set({ monitors: map });
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
}

function patchMonitor(id, patch) {
  return mutate((map) => {
    if (!map[id]) return null;
    map[id] = { ...map[id], ...(typeof patch === 'function' ? patch(map[id]) : patch) };
    return map[id];
  });
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------
async function schedule(m, { reset = true } = {}) {
  const name = ALARM_PREFIX + m.id;
  if (m.paused) { await chrome.alarms.clear(name); return; }
  const existing = await chrome.alarms.get(name);
  if (existing && !reset && existing.periodInMinutes === m.interval) return;
  await chrome.alarms.clear(name);
  await chrome.alarms.create(name, { delayInMinutes: m.interval, periodInMinutes: m.interval });
}

async function syncAlarms() {
  const map = await getMonitors();
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) {
    if (a.name.startsWith(ALARM_PREFIX) && !map[a.name.slice(ALARM_PREFIX.length)]) await chrome.alarms.clear(a.name);
  }
  for (const m of Object.values(map)) {
    // Clear stale "checking" flags left by a worker that was shut down mid-check.
    if (m.checking) await patchMonitor(m.id, { checking: false });
    await schedule(m, { reset: false });
  }
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(() => { syncAlarms(); });
chrome.runtime.onStartup.addListener(() => { syncAlarms(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) runCheck(alarm.name.slice(ALARM_PREFIX.length));
});

// ---------------------------------------------------------------------------
// Offscreen document (DOMParser + sound)
// ---------------------------------------------------------------------------
let creatingOffscreen = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (ctx.length) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER', 'AUDIO_PLAYBACK'],
      justification: 'Parse fetched pages to apply the watched CSS selector, and play the optional alert sound.',
    }).catch((e) => {
      if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function offscreenCall(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res) throw new Error('Parser did not respond');
  if (res.fatal) throw new Error(res.fatal);
  return res;
}

// ---------------------------------------------------------------------------
// Fetching and extraction
// ---------------------------------------------------------------------------
async function hasHostPermission(url) {
  try { return await chrome.permissions.contains({ origins: [originPattern(url)] }); } catch { return false; }
}

class PermissionError extends Error {}

async function fetchHtml(url) {
  let res;
  try {
    res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
    });
  } catch (e) {
    if (!(await hasHostPermission(url))) throw new PermissionError('Site access not granted');
    if (e && e.name === 'TimeoutError') throw new Error('Timed out after 30 s');
    throw new Error('Network error: ' + (e && e.message ? e.message : e));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_HTML) throw new Error('Page is too large (over 8 MB)');
  const html = await res.text();
  return { html: html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html, contentType: res.headers.get('content-type') || '', finalUrl: res.url };
}

async function extractByFetch(url, selector) {
  const { html, contentType } = await fetchHtml(url);
  if (/json|text\/plain/i.test(contentType) && !/html/i.test(contentType)) {
    // Non-HTML documents: watch the raw text (selector does not apply).
    return { text: html, count: 1, title: '' };
  }
  return offscreenCall({ type: 'extract', html, url, selector });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeout);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { cleanup(); resolve('complete'); } };
    const onRemoved = (id) => { if (id === tabId) { cleanup(); reject(new Error('Background tab was closed')); } };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { cleanup(); resolve('complete'); } }).catch(() => {});
  });
}

async function openBackgroundTab(url) {
  try {
    return await chrome.tabs.create({ url, active: false });
  } catch {
    // No normal browser window open: use an unfocused minimized window.
    const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
    return win.tabs[0];
  }
}

/** Render mode: open an inactive tab, wait for scripts to settle, extract, close. */
async function extractByRender(url, selector, waitSeconds) {
  if (!(await hasHostPermission(url))) throw new PermissionError('Site access not granted');
  const tab = await openBackgroundTab(url);
  const tabId = tab.id;
  try {
    chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    await waitForTabComplete(tabId, 45000);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/extract.js'] });
    const read = async () => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => globalThis.PageWatchExtract.extract(document, sel, { live: true }),
        args: [selector || ''],
      });
      return r && r.result;
    };
    // Give scripts the configured time to render, then keep polling briefly if the
    // watched element has not appeared yet (slow single-page apps).
    await sleep(waitSeconds * 1000);
    const deadline = Date.now() + 10000;
    let last = await read();
    while (last && !last.error && (last.count === 0 || !last.text) && Date.now() < deadline) {
      await sleep(1000);
      last = await read();
    }
    return last || { text: '', count: 0, title: '' };
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function extractFor(m) {
  const res = m.mode === 'render'
    ? await extractByRender(m.url, m.selector, m.renderWait || 5)
    : await extractByFetch(m.url, m.selector);
  if (res.error) throw new Error(res.error);
  let text = normalizeText(res.text);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  return { text, count: res.count, title: res.title };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
const inflight = new Map();

function runCheck(id, opts = {}) {
  if (inflight.has(id)) return inflight.get(id);
  const p = doCheck(id, opts).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function doCheck(id, { manual = false } = {}) {
  const map = await getMonitors();
  const m = map[id];
  if (!m) return { error: 'Monitor not found' };
  if (m.paused && !manual) return { skipped: true };
  await patchMonitor(id, { checking: true });
  const now = Date.now();
  try {
    const res = await extractFor(m);
    const settings = await getSettings();
    const prev = await latestSnapshot(id);
    const cond = evaluateCondition(m.condition, res.text);
    const warning = m.selector && res.count === 0 ? 'Selector matched nothing on the page' : '';
    const base = {
      checking: false, status: 'ok', error: '', warning, lastCheck: now, errorCount: 0,
      lastValue: cond.value ?? null, conditionMet: cond.met, pageTitle: res.title || m.pageTitle || '',
    };
    if (!prev) {
      await addSnapshot({ monitorId: id, ts: now, text: res.text, met: cond.met, baseline: true, added: 0, removed: 0 });
      await patchMonitor(id, (cur) => ({ ...base, checks: (cur.checks || 0) + 1 }));
      return { changed: false, baseline: true, text: res.text };
    }
    if (prev.text === res.text) {
      await patchMonitor(id, (cur) => ({ ...base, checks: (cur.checks || 0) + 1 }));
      return { changed: false, text: res.text };
    }
    const ops = diffWords(prev.text, res.text);
    const stats = diffStats(ops);
    await addSnapshot({ monitorId: id, ts: now, text: res.text, met: cond.met, added: stats.added, removed: stats.removed });
    await pruneSnapshots(id, Math.max(2, settings.maxSnapshots || 100));
    const updated = await patchMonitor(id, (cur) => ({
      ...base,
      checks: (cur.checks || 0) + 1,
      changes: (cur.changes || 0) + 1,
      lastChange: now,
      unread: (cur.unread || 0) + (cond.met ? 1 : 0),
      lastAlert: cond.met ? now : cur.lastAlert,
      lastSummary: changeSummary(ops),
    }));
    chrome.runtime.sendMessage({ type: 'snapshots:changed', id }).catch(() => {});
    if (cond.met && updated) await alert(updated, ops, settings);
    return { changed: true, met: cond.met, text: res.text };
  } catch (e) {
    const perm = e instanceof PermissionError;
    await patchMonitor(id, (cur) => ({
      checking: false,
      lastCheck: now,
      status: perm ? 'needs_permission' : 'error',
      error: e && e.message ? e.message : String(e),
      errorCount: (cur.errorCount || 0) + 1,
      checks: (cur.checks || 0) + 1,
    }));
    return { error: e && e.message ? e.message : String(e) };
  } finally {
    await updateBadge();
  }
}

// ---------------------------------------------------------------------------
// Alerts: notification, sound, badge
// ---------------------------------------------------------------------------
async function alert(m, ops, settings) {
  if (settings.notifications && m.notify) {
    const nid = `pw|${m.id}|${Date.now()}`;
    try {
      await chrome.notifications.create(nid, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `${m.name} changed`,
        message: changeSummary(ops, 200),
        contextMessage: hostOf(m.url),
        buttons: [{ title: 'Open page' }, { title: 'View changes' }],
        priority: 1,
      });
    } catch { /* notifications may be disabled at the OS level */ }
  }
  if (m.sound) await playSound(settings).catch(() => {});
}

async function playSound(settings) {
  const s = settings || (await getSettings());
  await offscreenCall({ type: 'play-sound', sound: s.sound || 'chime', volume: s.soundVolume ?? 0.6 });
}

async function updateBadge() {
  const settings = await getSettings();
  const list = Object.values(await getMonitors());
  const unread = list.reduce((n, m) => n + (m.unread || 0), 0);
  const errors = list.filter((m) => !m.paused && (m.status === 'error' || m.status === 'needs_permission')).length;
  let text = '';
  let color = '#0f766e';
  if (settings.showBadge) {
    if (unread) text = unread > 99 ? '99+' : String(unread);
    else if (errors) { text = '!'; color = '#d97706'; }
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
  const title = unread ? `Page Watch: ${unread} unread change${unread === 1 ? '' : 's'}` : errors ? `Page Watch: ${errors} monitor${errors === 1 ? '' : 's'} need attention` : 'Page Watch';
  await chrome.action.setTitle({ title });
}

function parseNid(nid) {
  const [p, id] = String(nid).split('|');
  return p === 'pw' ? id : null;
}

async function openDashboard(hash = '') {
  const url = chrome.runtime.getURL('dashboard/dashboard.html') + (hash ? '#' + hash : '');
  const base = chrome.runtime.getURL('dashboard/dashboard.html');
  const tabs = await chrome.tabs.query({ url: base + '*' }).catch(() => []);
  if (tabs && tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url });
    await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

async function markRead(id) {
  await patchMonitor(id, { unread: 0 });
  await updateBadge();
}

chrome.notifications.onClicked.addListener(async (nid) => {
  const id = parseNid(nid);
  if (!id) return;
  chrome.notifications.clear(nid);
  const m = (await getMonitors())[id];
  if (m) { await chrome.tabs.create({ url: m.url }); await markRead(id); }
});

chrome.notifications.onButtonClicked.addListener(async (nid, index) => {
  const id = parseNid(nid);
  if (!id) return;
  chrome.notifications.clear(nid);
  const m = (await getMonitors())[id];
  if (!m) return;
  if (index === 0) { await chrome.tabs.create({ url: m.url }); await markRead(id); }
  else await openDashboard('m=' + encodeURIComponent(id));
});

// When the user grants site access later, re-check monitors that were waiting for it.
chrome.permissions.onAdded.addListener(async () => {
  const list = Object.values(await getMonitors());
  for (const m of list) {
    if (m.status === 'needs_permission' && (await hasHostPermission(m.url))) runCheck(m.id, { manual: true });
  }
});

// ---------------------------------------------------------------------------
// Picker and commands
// ---------------------------------------------------------------------------
async function startPicker(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/extract.js', 'content/picker.js'] });
}

async function onPickDone(draft, sender) {
  await chrome.storage.local.set({ draft: { ...draft, createdAt: Date.now() } });
  try {
    await chrome.action.openPopup(sender && sender.tab ? { windowId: sender.tab.windowId } : undefined);
  } catch {
    await openDashboard('new');
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-dashboard') return openDashboard();
  if (command === 'pick-element' && tab && tab.id != null && isWatchableUrl(tab.url || '')) {
    try { await startPicker(tab.id); } catch { /* restricted page */ }
  }
});

// ---------------------------------------------------------------------------
// Messages from extension pages and the picker
// ---------------------------------------------------------------------------
async function saveMonitor(input) {
  const settings = await getSettings();
  const existing = input.id ? (await getMonitors())[input.id] : null;
  const m = normalizeMonitor(pickConfig({ ...(existing || {}), ...input }), settings);
  const urlChanged = existing && (existing.url !== m.url || existing.selector !== m.selector || existing.mode !== m.mode);
  const saved = await mutate((map) => {
    map[m.id] = { ...(map[m.id] || { status: 'pending', unread: 0, checks: 0, changes: 0 }), ...m };
    if (urlChanged) Object.assign(map[m.id], { unread: 0, lastChange: null, status: 'pending', error: '' });
    return map[m.id];
  });
  if (urlChanged) await deleteSnapshots(m.id);
  await schedule(saved, { reset: !existing || existing.interval !== saved.interval || existing.paused !== saved.paused });
  if (!existing || urlChanged) runCheck(saved.id, { manual: true });
  return saved;
}

async function deleteMonitor(id) {
  await mutate((map) => { delete map[id]; });
  await chrome.alarms.clear(ALARM_PREFIX + id);
  await deleteSnapshots(id);
  await updateBadge();
}

async function setPaused(id, paused) {
  const m = await patchMonitor(id, { paused, ...(paused ? {} : { status: 'ok' }) });
  if (m) await schedule(m);
  if (m && !paused) runCheck(id);
  await updateBadge();
  return m;
}

async function importMonitors(items) {
  if (!Array.isArray(items)) throw new Error('Expected a list of monitors');
  const settings = await getSettings();
  const map = await getMonitors();
  const existingKeys = new Set(Object.values(map).map((m) => `${m.url}\u0000${m.selector}`));
  const added = [];
  const skipped = [];
  for (const raw of items) {
    try {
      const m = normalizeMonitor(pickConfig({ ...raw, id: undefined }), settings);
      if (raw && raw.id && !map[raw.id]) m.id = String(raw.id);
      else m.id = uid();
      const key = `${m.url}\u0000${m.selector}`;
      if (existingKeys.has(key)) { skipped.push(m.name); continue; }
      existingKeys.add(key);
      added.push(m);
    } catch (e) {
      skipped.push((raw && raw.name) || 'invalid entry');
    }
  }
  await mutate((cur) => {
    for (const m of added) cur[m.id] = { ...m, status: 'pending', unread: 0, checks: 0, changes: 0 };
  });
  for (const m of added) {
    await schedule(m);
    if (!m.paused) runCheck(m.id, { manual: true });
  }
  return { added: added.length, skipped, origins: [...new Set(added.map((m) => originPattern(m.url)))] };
}

async function preview({ url, selector, mode, renderWait }) {
  if (!isWatchableUrl(url)) throw new Error('Enter a valid http(s) URL');
  const res = await extractFor({ url, selector, mode, renderWait: Math.min(60, Math.max(1, Number(renderWait) || 5)) });
  return res;
}

const handlers = {
  'pick:start': async (msg) => { await startPicker(msg.tabId); return { ok: true }; },
  'pick:done': async (msg, sender) => { await onPickDone(msg.draft, sender); return { ok: true }; },
  'monitor:save': async (msg) => ({ monitor: await saveMonitor(msg.monitor) }),
  'monitor:delete': async (msg) => { await deleteMonitor(msg.id); return { ok: true }; },
  'monitor:check': async (msg) => runCheck(msg.id, { manual: true }),
  'monitor:pause': async (msg) => ({ monitor: await setPaused(msg.id, !!msg.paused) }),
  'monitor:markRead': async (msg) => { await markRead(msg.id); return { ok: true }; },
  'monitor:markAllRead': async () => {
    await mutate((map) => { for (const m of Object.values(map)) m.unread = 0; });
    await updateBadge();
    return { ok: true };
  },
  'monitor:checkAll': async () => {
    const list = Object.values(await getMonitors()).filter((m) => !m.paused);
    await Promise.allSettled(list.map((m) => runCheck(m.id, { manual: true })));
    return { checked: list.length };
  },
  'monitor:import': async (msg) => importMonitors(msg.monitors),
  'preview': async (msg) => preview(msg),
  'sound:test': async (msg) => {
    const s = await getSettings();
    await playSound({ ...s, sound: msg.sound || s.sound, soundVolume: msg.volume ?? s.soundVolume });
    return { ok: true };
  },
  'badge:refresh': async () => { await updateBadge(); return { ok: true }; },
  'dashboard:open': async (msg) => { await openDashboard(msg.hash || ''); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  // Only our own extension pages and our injected picker may talk to the worker.
  if (sender.id !== chrome.runtime.id) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((e) => sendResponse({ error: e && e.message ? e.message : String(e) }));
  return true;
});

// Keep the badge in sync when the worker wakes up.
updateBadge().catch(() => {});
