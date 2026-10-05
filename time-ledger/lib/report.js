// Aggregation, billing, timesheets, CSV and entry editing. Pure functions.

import { segmentProject, categoryFor } from './rules.js';
import { daysBetween, addDays, startOfDay, dayKey, uid, HOUR } from './util.js';

export const dur = (it) => Math.max(0, it.end - it.start);

/** Stored auto-tracked segments -> report items. */
export function autoItems(segments, rules = [], categoryMap = {}) {
  return segments.map((seg) => ({
    source: 'auto',
    start: seg.start,
    end: seg.end,
    url: seg.url,
    domain: seg.domain,
    title: seg.title || '',
    desc: seg.title || seg.domain,
    projectId: segmentProject(seg, rules),
    category: categoryFor(seg.domain, categoryMap),
    tags: [],
    billable: true,
    live: !!seg.live,
  }));
}

/** Manual entries (+ running timer) -> report items. */
export function manualItems(entries = [], timer = null, now = Date.now()) {
  const out = entries.map((e) => ({
    source: 'manual',
    id: e.id,
    start: e.start,
    end: e.end,
    desc: e.desc || '',
    projectId: e.projectId || null,
    tags: e.tags || [],
    billable: e.billable !== false,
  }));
  if (timer && timer.start) {
    out.push({
      source: 'manual', id: 'running', start: timer.start, end: Math.max(timer.start, now),
      desc: timer.desc || '', projectId: timer.projectId || null, tags: timer.tags || [],
      billable: timer.billable !== false, live: true,
    });
  }
  return out;
}

/** Keep the part of each item inside [from, to). */
export function clip(items, from, to) {
  const out = [];
  for (const it of items) {
    const s = Math.max(it.start, from);
    const e = Math.min(it.end, to);
    if (e > s) out.push(s === it.start && e === it.end ? it : { ...it, start: s, end: e });
  }
  return out;
}

export function total(items) {
  return items.reduce((a, it) => a + dur(it), 0);
}

/** Sum durations grouped by key. Returns [{ key, ms, count }] sorted by ms desc. */
export function totalsBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    const cur = map.get(k) || { key: k, ms: 0, count: 0 };
    cur.ms += dur(it);
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.ms - a.ms);
}

/** Spread an item's time across the days it touches. Calls fn(dayStart, ms). */
function eachDayPortion(it, fn) {
  let s = it.start;
  while (s < it.end) {
    const next = addDays(startOfDay(s), 1);
    const e = Math.min(it.end, next);
    fn(startOfDay(s), e - s);
    s = e;
  }
}

/**
 * Projects x days grid for [from, to).
 * keyFn chooses the row (defaults to projectId; null = "No project").
 */
export function timesheet(items, from, to, keyFn = (it) => it.projectId || null) {
  const days = daysBetween(from, to);
  const index = new Map(days.map((d, i) => [d, i]));
  const rows = new Map();
  const dayTotals = days.map(() => 0);
  for (const it of clip(items, from, to)) {
    const key = keyFn(it);
    if (!rows.has(key)) rows.set(key, { key, cells: days.map(() => 0), total: 0 });
    const row = rows.get(key);
    eachDayPortion(it, (d, ms) => {
      const i = index.get(d);
      if (i === undefined) return;
      row.cells[i] += ms;
      row.total += ms;
      dayTotals[i] += ms;
    });
  }
  const list = [...rows.values()].sort((a, b) => b.total - a.total);
  return { days, rows: list, dayTotals, total: dayTotals.reduce((a, b) => a + b, 0) };
}

/** 24 hourly buckets (ms) for one day, split by keyFn. Returns { keys, buckets: {key: number[24]} }. */
export function hourly(items, dayStart, keyFn = (it) => it.category || 'neutral') {
  const buckets = {};
  for (const it of clip(items, dayStart, addDays(dayStart, 1))) {
    const k = keyFn(it);
    if (!buckets[k]) buckets[k] = new Array(24).fill(0);
    let s = it.start;
    while (s < it.end) {
      const h = new Date(s).getHours();
      const hourEnd = new Date(s).setMinutes(60, 0, 0);
      const e = Math.min(it.end, hourEnd);
      buckets[k][h] += e - s;
      s = e;
    }
  }
  return buckets;
}

/** Hourly rate: project rate, else client rate, else default. */
export function rateFor(projectId, { projects = [], clients = [], settings = {} } = {}) {
  const p = projects.find((x) => x.id === projectId);
  if (p && p.rate !== '' && p.rate != null && Number.isFinite(+p.rate)) return +p.rate;
  const c = p && clients.find((x) => x.id === p.clientId);
  if (c && c.rate !== '' && c.rate != null && Number.isFinite(+c.rate)) return +c.rate;
  return Number.isFinite(+settings.defaultRate) ? +settings.defaultRate : 0;
}

/** Round a duration up to the next `minutes` increment (0 = no rounding). */
export function roundUp(ms, minutes) {
  if (!minutes) return ms;
  const step = minutes * 60 * 1000;
  return Math.ceil(ms / step) * step;
}

/**
 * Billing summary per project.
 * Returns { rows: [{ projectId, ms, billableMs, rate, amount }], totalMs, billableMs, amount }.
 */
export function billing(items, ctx = {}) {
  const roundMin = +(ctx.settings && ctx.settings.roundMinutes) || 0;
  const map = new Map();
  for (const it of items) {
    const key = it.projectId || null;
    if (!map.has(key)) map.set(key, { projectId: key, ms: 0, billableMs: 0, rate: rateFor(key, ctx), amount: 0 });
    const r = map.get(key);
    const d = dur(it);
    r.ms += d;
    const proj = (ctx.projects || []).find((p) => p.id === key);
    const projBillable = proj ? proj.billable !== false : false;
    if (it.billable !== false && projBillable) r.billableMs += it.source === 'manual' ? roundUp(d, roundMin) : d;
  }
  let totalMs = 0, billableMs = 0, amount = 0;
  const rows = [...map.values()].map((r) => {
    r.amount = Math.round((r.billableMs / HOUR) * r.rate * 100) / 100;
    totalMs += r.ms; billableMs += r.billableMs; amount += r.amount;
    return r;
  }).sort((a, b) => b.ms - a.ms);
  return { rows, totalMs, billableMs, amount: Math.round(amount * 100) / 100 };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV with one line per item. */
export function itemsToCSV(items, ctx = {}) {
  const projects = ctx.projects || [];
  const clients = ctx.clients || [];
  const header = ['Date', 'Start', 'End', 'Duration (h)', 'Duration', 'Source', 'Project', 'Client', 'Description', 'Domain', 'Tags', 'Billable', 'Rate', 'Amount'];
  const lines = [header.join(',')];
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const p = projects.find((x) => x.id === it.projectId);
    const c = p && clients.find((x) => x.id === p.clientId);
    const ms = dur(it);
    const billable = it.billable !== false && p && p.billable !== false;
    const rate = rateFor(it.projectId, ctx);
    const secs = Math.round(ms / 1000);
    lines.push([
      dayKey(it.start), hm(it.start), hm(it.end), (ms / HOUR).toFixed(2),
      `${Math.floor(secs / 3600)}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`,
      it.source, p ? p.name : '', c ? c.name : '', it.desc || '', it.domain || '',
      (it.tags || []).join(' '), billable ? 'yes' : 'no', billable ? rate : '',
      billable ? ((ms / HOUR) * rate).toFixed(2) : '',
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------- Manual entry editing ----------

export function validateEntry(e) {
  const errors = [];
  if (!Number.isFinite(e.start)) errors.push('Start time is invalid.');
  if (!Number.isFinite(e.end)) errors.push('End time is invalid.');
  if (Number.isFinite(e.start) && Number.isFinite(e.end) && e.end <= e.start) errors.push('End must be after start.');
  if (Number.isFinite(e.start) && Number.isFinite(e.end) && e.end - e.start > 7 * 24 * HOUR) errors.push('Entries cannot be longer than 7 days.');
  return errors;
}

/** Split an entry at `at` into two entries. Throws if `at` is outside it. */
export function splitEntry(entry, at) {
  if (!(at > entry.start && at < entry.end)) throw new Error('Split point must be inside the entry.');
  return [
    { ...entry, end: at },
    { ...entry, id: uid('e'), start: at },
  ];
}

/** Merge entries into one spanning them all. Keeps the first entry's id, project and description. */
export function mergeEntries(entries) {
  if (!entries || entries.length < 2) throw new Error('Select at least two entries to merge.');
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  const descs = [...new Set(sorted.map((e) => (e.desc || '').trim()).filter(Boolean))];
  const tags = [...new Set(sorted.flatMap((e) => e.tags || []))];
  return {
    ...first,
    start: first.start,
    end: Math.max(...sorted.map((e) => e.end)),
    desc: descs.join('; '),
    projectId: first.projectId || sorted.find((e) => e.projectId)?.projectId || null,
    tags,
  };
}

/** Pairs of overlapping manual entries (for warnings). */
export function findOverlaps(entries) {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) out.push([sorted[i - 1].id, sorted[i].id]);
  }
  return out;
}

/** Group report items by URL-domain to produce a "sites" list with category. */
export function siteTotals(items, categoryMap = {}) {
  return totalsBy(items.filter((i) => i.source === 'auto'), (i) => i.domain).map((r) => ({
    ...r, domain: r.key, category: categoryFor(r.key, categoryMap),
  }));
}
