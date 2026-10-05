// Scheduling with chrome.alarms. Each enabled macro schedule gets one alarm "macro:<id>"
// that is re-armed for the next occurrence after it fires.
import { getMacros } from './storage.js';

const PREFIX = 'macro:';

/**
 * schedule = { enabled, kind: 'daily'|'hourly'|'interval', time: 'HH:MM', days: [0..6], minute: 0..59,
 *              every: minutes, useCsv, closeTab }
 */
export function nextOccurrence(schedule, from = Date.now()) {
  if (!schedule || !schedule.enabled) return null;
  const now = new Date(from);
  if (schedule.kind === 'interval') {
    const every = Math.max(1, parseInt(schedule.every, 10) || 60);
    return from + every * 60000;
  }
  if (schedule.kind === 'hourly') {
    const minute = Math.min(59, Math.max(0, parseInt(schedule.minute, 10) || 0));
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMinutes(minute);
    if (d.getTime() <= from + 1000) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  // daily
  const [hh, mm] = String(schedule.time || '09:00').split(':').map(n => parseInt(n, 10) || 0);
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  for (let add = 0; add < 8; add++) {
    const d = new Date(now);
    d.setDate(d.getDate() + add);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() > from + 1000 && days.includes(d.getDay())) return d.getTime();
  }
  return null;
}

export function describeSchedule(s) {
  if (!s || !s.enabled) return 'Not scheduled';
  if (s.kind === 'interval') return `Every ${s.every} min`;
  if (s.kind === 'hourly') return `Hourly at :${String(s.minute || 0).padStart(2, '0')}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = Array.isArray(s.days) && s.days.length && s.days.length < 7 ? ' on ' + s.days.map(d => names[d]).join(', ') : '';
  return `Daily at ${s.time || '09:00'}${days}`;
}

export async function syncAlarms() {
  const macros = await getMacros();
  const alarms = await chrome.alarms.getAll();
  const wanted = new Map();
  for (const m of macros) {
    const when = nextOccurrence(m.schedule);
    if (when) wanted.set(PREFIX + m.id, { when, sig: JSON.stringify(m.schedule) });
  }
  const { alarmSigs = {} } = await chrome.storage.local.get('alarmSigs');
  for (const a of alarms) {
    if (!a.name.startsWith(PREFIX)) continue;
    const w = wanted.get(a.name);
    if (!w) { await chrome.alarms.clear(a.name); delete alarmSigs[a.name]; }
    else if (alarmSigs[a.name] === w.sig) wanted.delete(a.name); // already armed with same schedule
  }
  for (const [name, w] of wanted) {
    await chrome.alarms.create(name, { when: w.when });
    alarmSigs[name] = w.sig;
  }
  await chrome.storage.local.set({ alarmSigs });
}

export async function rearm(macroId, schedule) {
  const when = nextOccurrence(schedule);
  if (when) await chrome.alarms.create(PREFIX + macroId, { when });
}

export function macroIdFromAlarm(name) {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null;
}

export async function alarmTimes() {
  const out = {};
  for (const a of await chrome.alarms.getAll()) if (a.name.startsWith(PREFIX)) out[a.name.slice(PREFIX.length)] = a.scheduledTime;
  return out;
}
