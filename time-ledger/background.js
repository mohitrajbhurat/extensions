// Time Ledger service worker: automatic tracking, timer commands, badge,
// daily goals/limits notifications. All engine state is persisted after each
// event so the worker can be stopped and restarted at any time.

import { reduce, initialState, liveSegment } from './lib/engine.js';
import * as store from './lib/store.js';
import { segmentProject } from './lib/rules.js';
import { autoItems, manualItems, clip, total } from './lib/report.js';
import { evaluateGoals, pendingNotifications } from './lib/goals.js';
import { dayKey, startOfDay, addDays, fmtDur } from './lib/util.js';

const ALARM = 'tl-heartbeat';
const PERIOD_MIN = 0.5; // 30 s, the MV3 minimum
const MAX_GAP_MS = 3 * 60 * 1000;

// ---------- serial queue: every state mutation runs one at a time ----------
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.warn('[Time Ledger]', e));
  return p;
}

function engineOptions(settings) {
  return {
    idleSeconds: Math.max(15, +settings.idleSeconds || 120),
    countAudible: settings.countAudible !== false,
    stripQuery: settings.stripQuery !== false,
    exclude: settings.exclude || [],
    maxGapMs: MAX_GAP_MS,
  };
}

async function activeTab() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (!win) return { tab: null, focused: false };
    const t = (win.tabs || []).find((x) => x.active);
    return {
      tab: t ? { url: t.url || t.pendingUrl || '', title: t.title || '', audible: !!t.audible } : null,
      focused: !!win.focused,
    };
  } catch {
    return { tab: null, focused: false };
  }
}

async function snapshot(settings) {
  const { tab, focused } = await activeTab();
  let idle = 'active';
  try { idle = await chrome.idle.queryState(Math.max(15, +settings.idleSeconds || 120)); } catch { /* keep active */ }
  return { tab, focused, idle };
}

/** Feed one event to the engine and persist results. */
function dispatch(makeEvent) {
  return serial(async () => {
    const settings = await store.getSettings();
    const event = typeof makeEvent === 'function' ? await makeEvent(settings) : makeEvent;
    const { engine } = await store.get('engine');
    const prev = engine || { ...initialState(), enabled: settings.trackingEnabled !== false };
    const now = Date.now();
    const { state, segments, trimAfter } = reduce(prev, event, now, engineOptions(settings));
    await store.set({ engine: state });
    if (trimAfter != null) await store.trimActivityAfter(trimAfter, now);
    await store.appendSegments(segments);
    return state;
  });
}

const syncNow = () => dispatch(async (settings) => ({ type: 'sync', ...(await snapshot(settings)) }));
const tabChanged = () => dispatch(async () => {
  const { tab } = await activeTab();
  return { type: 'tab', tab };
});

// ---------- browser events ----------
chrome.tabs.onActivated.addListener(() => tabChanged());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (!tab.active) return;
  if ('url' in info || 'title' in info || 'audible' in info || info.status === 'complete') tabChanged();
});
chrome.tabs.onRemoved.addListener(() => tabChanged());
chrome.tabs.onReplaced.addListener(() => tabChanged());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) dispatch({ type: 'focus', focused: false });
  else dispatch(async () => ({ type: 'sync', focused: true, tab: (await activeTab()).tab }));
});
chrome.idle.onStateChanged.addListener((idle) => dispatch({ type: 'idle', idle }));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  await syncNow();
  await afterCheckpoint();
});

async function ensureSetup() {
  const settings = await store.getSettings();
  try { chrome.idle.setDetectionInterval(Math.max(15, +settings.idleSeconds || 120)); } catch { /* ignore */ }
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN, delayInMinutes: PERIOD_MIN });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureSetup();
  if (details.reason === 'install') await seedDefaults();
  await syncNow();
  await updateBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureSetup();
  await syncNow();
  await updateBadge();
});

// Runs every time the worker boots (including after being stopped while idle).
ensureSetup().then(syncNow).then(updateBadge).catch((e) => console.warn('[Time Ledger] boot', e));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.timer) updateBadge();
  if (changes.settings) {
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (before.idleSeconds !== after.idleSeconds) {
      try { chrome.idle.setDetectionInterval(Math.max(15, +after.idleSeconds || 120)); } catch { /* ignore */ }
    }
    if ((before.trackingEnabled !== false) !== (after.trackingEnabled !== false)) {
      dispatch({ type: 'enabled', enabled: after.trackingEnabled !== false }).then(updateBadge);
    }
    if (before.badge !== after.badge) updateBadge();
  }
});

async function seedDefaults() {
  const { projects, goals } = await store.get(['projects', 'goals']);
  const patch = {};
  if (!Array.isArray(projects)) patch.projects = [];
  if (!Array.isArray(goals)) {
    patch.goals = [
      { id: 'g-distracting', kind: 'limit', scope: 'category', target: 'distracting', minutes: 60, enabled: true, notify: true },
      { id: 'g-productive', kind: 'goal', scope: 'category', target: 'productive', minutes: 240, enabled: true, notify: true },
    ];
  }
  if (Object.keys(patch).length) await store.set(patch);
}

// ---------- badge ----------
async function updateBadge() {
  try {
    const { settings, timer, engine } = await store.getData();
    let text = '';
    let color = '#2563eb';
    if (settings.trackingEnabled === false && !timer) {
      text = 'off';
      color = '#64748b';
    } else if (settings.badge === 'timer' && timer) {
      const mins = Math.floor((Date.now() - timer.start) / 60000);
      text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
    } else if (settings.badge === 'today') {
      const ms = await todayAutoTotal(engine);
      const mins = Math.floor(ms / 60000);
      text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
      color = '#0f766e';
    }
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    const title = timer ? `Time Ledger: timer running ${fmtDur(Date.now() - timer.start)}` : 'Time Ledger';
    await chrome.action.setTitle({ title });
  } catch (e) {
    console.warn('[Time Ledger] badge', e);
  }
}

async function todayAutoTotal(engine) {
  const from = startOfDay(Date.now());
  const segs = await store.loadActivity(from, addDays(from, 1));
  const live = liveSegment(engine, Date.now(), MAX_GAP_MS);
  return total(clip([...segs, ...(live ? [live] : [])], from, addDays(from, 1)));
}

// ---------- goals, limits, housekeeping ----------
async function afterCheckpoint() {
  await updateBadge();
  try {
    const data = await store.getData();
    const now = Date.now();
    const from = startOfDay(now);
    const to = addDays(from, 1);
    const segs = await store.loadActivity(from, to);
    const live = liveSegment(data.engine, now, MAX_GAP_MS);
    const items = clip([
      ...autoItems([...segs, ...(live ? [live] : [])], data.rules, data.categoryMap),
      ...manualItems(data.entries, data.timer, now),
    ], from, to);
    const results = evaluateGoals(data.goals, items);
    const nKey = 'notified:' + dayKey(now);
    const { [nKey]: notified = {} } = await store.get(nKey);
    const pending = data.settings.notifications === false ? [] : pendingNotifications(results, notified, data.projects);
    if (pending.length) {
      for (const n of pending) {
        notified[n.key] = now;
        chrome.notifications.create(`tl-${n.key}-${now}`, {
          type: 'basic', iconUrl: 'icons/icon128.png', title: n.title, message: n.message, priority: 1,
        });
      }
      await store.set({ [nKey]: notified });
    }
    // Housekeeping once per day.
    const { lastPrune } = await store.get('lastPrune');
    if (lastPrune !== dayKey(now)) {
      await serial(() => store.pruneActivity(+data.settings.retentionDays || 0, now));
      await store.set({ lastPrune: dayKey(now) });
    }
  } catch (e) {
    console.warn('[Time Ledger] goals', e);
  }
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html#dashboard') });
  chrome.notifications.clear(id);
});

// ---------- timer ----------
async function toggleTimer() {
  const { timer, entries } = await store.get(['timer', 'entries']);
  if (timer) return { stopped: await serial(() => store.stopTimer()) };
  const last = Array.isArray(entries) && entries.length ? [...entries].sort((a, b) => b.end - a.end)[0] : null;
  return {
    started: await serial(() => store.startTimer(last ? { desc: last.desc, projectId: last.projectId, tags: last.tags, billable: last.billable } : {})),
  };
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-timer') await toggleTimer();
  if (command === 'toggle-tracking') {
    const s = await store.getSettings();
    await store.saveSettings({ trackingEnabled: !s.trackingEnabled });
  }
  await updateBadge();
});

// ---------- messages from extension pages ----------
const handlers = {
  async 'timer.start'(m) { return serial(() => store.startTimer({ desc: m.desc, projectId: m.projectId, tags: m.tags, billable: m.billable })); },
  async 'timer.stop'() { return serial(() => store.stopTimer()); },
  async 'timer.update'(m) { return serial(() => store.updateTimer(m.patch || {})); },
  async 'timer.toggle'() { return toggleTimer(); },
  async flush() { await syncNow(); return true; },
  async assign(m) {
    const { rules } = await store.get('rules');
    const rulesFn = (seg) => segmentProject(seg, Array.isArray(rules) ? rules : []);
    await syncNow();
    return serial(() => store.assignSegments(m.match, m.projectId, rulesFn));
  },
  async deleteActivity(m) { await syncNow(); return serial(() => store.deleteSegments(m.match)); },
  async import(m) {
    return serial(async () => {
      await store.importAll(m.payload, { replace: !!m.replace });
      await store.set({ engine: { ...initialState(), lastBeat: Date.now() } });
      return true;
    });
  },
  async clearAll() {
    return serial(async () => {
      const keep = await store.get(['settings', 'projects', 'clients', 'rules', 'goals', 'categoryMap']);
      await chrome.storage.local.clear();
      await store.set(keepDefined(keep));
      return true;
    });
  },
  async prune() {
    const s = await store.getSettings();
    return serial(() => store.pruneActivity(+s.retentionDays || 0));
  },
};

function keepDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.cmd];
  if (!h) return false;
  Promise.resolve(h(msg))
    .then((result) => { sendResponse({ result }); updateBadge(); })
    .catch((e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});
