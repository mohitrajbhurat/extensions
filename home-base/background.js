// Home Base service worker: toolbar badge, task reminders, pomodoro phase changes, commands.
import * as store from './lib/store.js';
import { counts, reminderTime } from './lib/tasks.js';
import { ymd, formatTime, relativeLabel } from './lib/dates.js';
import * as pomo from './lib/pomodoro.js';
import * as ops from './lib/taskops.js';

const ICON = 'icons/icon128.png';
const SNOOZE_MIN = 10;
const MAX_REMINDERS = 400;
const hasNotifications = () => !!(chrome.notifications && chrome.notifications.create);

// ---------------------------------------------------------------- badge

async function updateBadge() {
  const { tasks, settings } = await store.getMany(['tasks', 'settings']);
  if (!settings.badge) { await chrome.action.setBadgeText({ text: '' }); return; }
  const c = counts(tasks, ymd(new Date()));
  await chrome.action.setBadgeText({ text: c.badge ? String(c.badge > 99 ? '99+' : c.badge) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: c.overdue ? '#d32f2f' : '#4f46e5' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  const parts = [];
  if (c.today) parts.push(`${c.today} due today`);
  if (c.overdue) parts.push(`${c.overdue} overdue`);
  await chrome.action.setTitle({ title: parts.length ? `Home Base: ${parts.join(', ')}` : 'Home Base' });
}

// ---------------------------------------------------------------- reminders

async function scheduleReminders() {
  const { tasks, settings } = await store.getMany(['tasks', 'settings']);
  const existing = (await chrome.alarms.getAll()).filter((a) => a.name.startsWith('rem:'));
  const want = new Map();
  if (settings.reminders) {
    const now = Date.now();
    const upcoming = [];
    for (const t of tasks) {
      const when = reminderTime(t, Number(settings.reminderOffset) || 0);
      if (when && when > now) upcoming.push({ name: `rem:${t.id}:${when}`, when });
    }
    upcoming.sort((a, b) => a.when - b.when);
    for (const u of upcoming.slice(0, MAX_REMINDERS)) want.set(u.name, u.when);
  }
  for (const a of existing) if (!want.has(a.name)) await chrome.alarms.clear(a.name);
  const have = new Set(existing.map((a) => a.name));
  for (const [name, when] of want) if (!have.has(name)) await chrome.alarms.create(name, { when });
}

async function notifyTask(id) {
  if (!hasNotifications()) return;
  const { tasks, settings } = await store.getMany(['tasks', 'settings']);
  const t = tasks.find((x) => x.id === id);
  if (!t || t.done || !settings.reminders) return;
  const when = t.date ? `${relativeLabel(t.date, ymd(new Date()))}${t.time ? ' at ' + formatTime(t.time, settings.h24) : ''}` : '';
  chrome.notifications.create(`task:${id}:${Date.now()}`, {
    type: 'basic',
    iconUrl: ICON,
    title: t.title,
    message: when ? `Due: ${when}` : 'Reminder',
    contextMessage: 'Home Base',
    buttons: [{ title: 'Complete' }, { title: `Snooze ${SNOOZE_MIN} min` }],
    priority: t.priority === 1 ? 2 : 1,
  });
}

// ---------------------------------------------------------------- pomodoro

async function schedulePomodoro() {
  const s = await store.get('pomodoro');
  if (s.running && s.endsAt) await chrome.alarms.create('pomodoro', { when: Math.max(Date.now() + 1000, s.endsAt) });
  else await chrome.alarms.clear('pomodoro');
}

async function checkPomodoro() {
  const settings = await store.get('settings');
  const cfg = settings.pomodoro;
  let finished = null;
  let next = null;
  await store.update('pomodoro', (s) => {
    if (!pomo.isDue(s)) return s;
    finished = s.mode;
    next = pomo.advance(s, cfg, ymd(new Date()));
    return next;
  });
  if (!finished) return;
  if (cfg.notify && hasNotifications()) {
    const msg = finished === 'work'
      ? `Focus session done. Time for a ${next.mode === 'long' ? 'long' : 'short'} break.`
      : 'Break over. Ready for the next focus session?';
    chrome.notifications.create(`pomodoro:${Date.now()}`, {
      type: 'basic', iconUrl: ICON, title: pomo.MODE_NAMES[finished] + ' complete', message: msg, contextMessage: 'Home Base',
    });
  }
}

// ---------------------------------------------------------------- housekeeping

function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 5, 0);
  return d.getTime();
}

async function ensureClockAlarms() {
  const day = await chrome.alarms.get('day');
  if (!day || Math.abs(day.scheduledTime - nextMidnight()) > 60000) await chrome.alarms.create('day', { when: nextMidnight() });
  if (!(await chrome.alarms.get('refresh'))) await chrome.alarms.create('refresh', { periodInMinutes: 60 });
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshAll().catch(console.warn); }, 250);
}

async function refreshAll() {
  await updateBadge();
  await scheduleReminders();
  await ensureClockAlarms();
}

// ---------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(async () => {
  await store.ensureDefaults();
  await refreshAll();
  await schedulePomodoro();
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshAll();
  await checkPomodoro();
  await schedulePomodoro();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tasks || changes.settings) refreshSoon();
  if (changes.pomodoro) schedulePomodoro().catch(console.warn);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const name = alarm.name;
  if (name.startsWith('rem:')) await notifyTask(name.split(':')[1]);
  else if (name.startsWith('snz:')) await notifyTask(name.slice(4));
  else if (name === 'pomodoro') await checkPomodoro();
  else if (name === 'day') { await chrome.alarms.create('day', { when: nextMidnight() }); await refreshAll(); }
  else if (name === 'refresh') await refreshAll();
});

if (hasNotifications()) {
  chrome.notifications.onButtonClicked.addListener(async (nid, index) => {
    chrome.notifications.clear(nid);
    if (!nid.startsWith('task:')) return;
    const id = nid.split(':')[1];
    if (index === 0) {
      const tasks = await store.get('tasks');
      const t = tasks.find((x) => x.id === id);
      if (t && !t.done) await ops.toggle(id);
    } else if (index === 1) {
      await chrome.alarms.create(`snz:${id}`, { when: Date.now() + SNOOZE_MIN * 60000 });
    }
  });
  chrome.notifications.onClicked.addListener(async (nid) => {
    chrome.notifications.clear(nid);
    if (nid.startsWith('task:')) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`tasks/tasks.html?task=${encodeURIComponent(nid.split(':')[1])}`) });
    } else if (nid.startsWith('pomodoro:')) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('newtab/newtab.html') });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'pomodoro:check') {
    checkPomodoro().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'refresh') {
    refreshAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'open-tasks') await chrome.tabs.create({ url: chrome.runtime.getURL('tasks/tasks.html#today') });
    if (command === 'quick-add') await chrome.tabs.create({ url: chrome.runtime.getURL('tasks/tasks.html?add=1#inbox') });
  });
}

// The worker can be restarted at any time; make sure badge and alarms are current.
refreshAll().catch(console.warn);
