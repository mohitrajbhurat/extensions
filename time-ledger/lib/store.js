// Persistence on chrome.storage.local. Activity is stored per day under
// "act:YYYY-MM-DD" so reads for a date range only touch the days needed.
// The service worker is the only writer of activity, timer and engine keys;
// extension pages ask it via runtime messages (see `send`).

import { splitByDay, mergeInto, trimSegments } from './engine.js';
import { dayKey, daysBetween, addDays, startOfDay, uid } from './util.js';

export const DEFAULT_SETTINGS = {
  trackingEnabled: true,
  idleSeconds: 120,
  countAudible: true,
  stripQuery: true,
  exclude: [],
  weekStart: 1,
  currency: 'USD',
  defaultRate: 0,
  roundMinutes: 0,
  badge: 'timer',          // 'timer' | 'today' | 'off'
  retentionDays: 0,        // 0 = keep forever
  includeAuto: true,       // include automatic time in reports
  notifications: true,
  invoice: { fromName: '', fromDetails: '', notes: 'Thank you for your business.', prefix: 'INV-' },
};

const LISTS = ['projects', 'clients', 'rules', 'goals', 'entries'];
const area = () => chrome.storage.local;

export async function get(keys) {
  return area().get(keys);
}

export async function set(obj) {
  return area().set(obj);
}

export async function getSettings() {
  const { settings } = await get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}), invoice: { ...DEFAULT_SETTINGS.invoice, ...((settings || {}).invoice || {}) } };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await set({ settings: next });
  return next;
}

/** Everything the UI needs except activity. */
export async function getData() {
  const raw = await get(['settings', 'categoryMap', 'timer', 'engine', ...LISTS]);
  const settings = await getSettings();
  const out = { settings, categoryMap: raw.categoryMap || {}, timer: raw.timer || null, engine: raw.engine || null };
  for (const k of LISTS) out[k] = Array.isArray(raw[k]) ? raw[k] : [];
  return out;
}

export function actKey(day) {
  return 'act:' + (typeof day === 'number' ? dayKey(day) : day);
}

/** Segments overlapping [from, to). Each gets _day and _i for later edits. */
export async function loadActivity(from, to) {
  const days = daysBetween(from, to);
  const keys = days.map((d) => actKey(d));
  const res = keys.length ? await get(keys) : {};
  const out = [];
  for (const k of keys) {
    const list = res[k] || [];
    list.forEach((seg, i) => out.push({ ...seg, _day: k, _i: i }));
  }
  return out;
}

/** Append closed segments (worker only). */
export async function appendSegments(segments) {
  if (!segments.length) return;
  const byDay = new Map();
  for (const seg of splitByDay(segments)) {
    const k = actKey(seg.start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(seg);
  }
  const keys = [...byDay.keys()];
  const res = await get(keys);
  const patch = {};
  for (const k of keys) patch[k] = mergeInto(res[k] || [], byDay.get(k));
  await set(patch);
}

/** Cut stored activity after `ts` (the user was idle since then). Worker only. */
export async function trimActivityAfter(ts, now = Date.now()) {
  const keys = daysBetween(ts, Math.max(now, ts + 1)).map((d) => actKey(d));
  const res = await get(keys);
  const patch = {};
  for (const k of keys) {
    const list = res[k];
    if (!list || !list.length) continue;
    const next = trimSegments(list, ts);
    if (next.length !== list.length || next.some((x, i) => x !== list[i])) patch[k] = next;
  }
  if (Object.keys(patch).length) await set(patch);
}

/**
 * Assign a project to automatic segments (worker only).
 * match: { from, to, domain?, url?, onlyUnassigned?, keys?: ["act:day:i", ...] }
 * projectId: string, or '' for "explicitly no project", or null to clear back to rules.
 */
export async function assignSegments(match, projectId, rulesFn = null) {
  const days = daysBetween(match.from, match.to);
  const keys = days.map((d) => actKey(d));
  const res = await get(keys);
  const patch = {};
  const wanted = match.keys ? new Set(match.keys) : null;
  let count = 0;
  for (const k of keys) {
    const list = res[k];
    if (!list || !list.length) continue;
    let changed = false;
    const next = list.map((seg, i) => {
      if (seg.end <= match.from || seg.start >= match.to) return seg;
      if (wanted && !wanted.has(`${k}:${i}`)) return seg;
      if (match.domain && seg.domain !== match.domain) return seg;
      if (match.url && seg.url !== match.url) return seg;
      if (match.onlyUnassigned) {
        const effective = rulesFn ? rulesFn(seg) : (seg.p ?? null);
        if (effective) return seg;
      }
      changed = true;
      count++;
      const copy = { ...seg };
      if (projectId === null) delete copy.p; else copy.p = projectId;
      return copy;
    });
    if (changed) patch[k] = next;
  }
  if (Object.keys(patch).length) await set(patch);
  return count;
}

/** Delete automatic segments for a domain in a range (worker only). */
export async function deleteSegments(match) {
  const days = daysBetween(match.from, match.to);
  const keys = days.map((d) => actKey(d));
  const res = await get(keys);
  const patch = {};
  let count = 0;
  for (const k of keys) {
    const list = res[k];
    if (!list) continue;
    const next = list.filter((seg) => {
      const hit = seg.end > match.from && seg.start < match.to && (!match.domain || seg.domain === match.domain);
      if (hit) count++;
      return !hit;
    });
    if (next.length !== list.length) patch[k] = next;
  }
  if (Object.keys(patch).length) await set(patch);
  return count;
}

// ---------- Timer and entries ----------

export async function startTimer({ desc = '', projectId = null, tags = [], billable = true } = {}, now = Date.now()) {
  await stopTimer(now);
  const timer = { start: now, desc, projectId, tags, billable };
  await set({ timer });
  return timer;
}

/** Stop the running timer and save it as an entry. Returns the entry or null. */
export async function stopTimer(now = Date.now()) {
  const { timer, entries } = await get(['timer', 'entries']);
  if (!timer) return null;
  const list = Array.isArray(entries) ? entries : [];
  let entry = null;
  if (now - timer.start >= 1000) {
    entry = { id: uid('e'), start: timer.start, end: now, desc: timer.desc || '', projectId: timer.projectId || null,
      tags: timer.tags || [], billable: timer.billable !== false };
    list.push(entry);
  }
  await set({ timer: null, entries: list });
  return entry;
}

export async function updateTimer(patch) {
  const { timer } = await get('timer');
  if (!timer) return null;
  const next = { ...timer, ...patch };
  await set({ timer: next });
  return next;
}

export async function getEntries() {
  const { entries } = await get('entries');
  return Array.isArray(entries) ? entries : [];
}

export async function saveEntries(entries) {
  await set({ entries: [...entries].sort((a, b) => a.start - b.start) });
}

export async function upsertEntry(entry) {
  const list = await getEntries();
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0) list[i] = entry; else list.push({ ...entry, id: entry.id || uid('e') });
  await saveEntries(list);
}

export async function deleteEntries(ids) {
  const set_ = new Set(ids);
  const list = await getEntries();
  await saveEntries(list.filter((e) => !set_.has(e.id)));
}

/** Remove activity older than retentionDays (worker only). */
export async function pruneActivity(retentionDays, now = Date.now()) {
  if (!retentionDays) return 0;
  const cutoff = actKey(addDays(startOfDay(now), -retentionDays));
  const all = await get(null);
  const old = Object.keys(all).filter((k) => (k.startsWith('act:') || k.startsWith('notified:')) && k.slice(k.indexOf(':') + 1) < cutoff.slice(4));
  if (old.length) await area().remove(old);
  return old.length;
}

export async function exportAll() {
  const all = await get(null);
  delete all.engine;
  return { app: 'time-ledger', version: 1, exportedAt: new Date().toISOString(), data: all };
}

export async function importAll(payload, { replace = false } = {}) {
  if (!payload || payload.app !== 'time-ledger' || !payload.data) throw new Error('This file is not a Time Ledger backup.');
  if (replace) await area().clear();
  const data = { ...payload.data };
  delete data.engine;
  await set(data);
}

/** Ask the service worker to do something; resolves with its reply. */
export function send(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ cmd, ...payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (res && res.error) return reject(new Error(res.error));
        resolve(res ? res.result : undefined);
      });
    } catch (e) {
      reject(e);
    }
  });
}
