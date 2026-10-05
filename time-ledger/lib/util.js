// Small shared helpers: dates, durations, URLs, ids, escaping.
// Pure functions, no chrome.* APIs, so they run in Node tests too.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day key, e.g. "2026-10-05". */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a day key back to local midnight (ms). */
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Add calendar days (DST safe). */
export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** weekStart: 0 = Sunday, 1 = Monday. */
export function startOfWeek(ts, weekStart = 1) {
  const s = startOfDay(ts);
  const dow = new Date(s).getDay();
  const diff = (dow - weekStart + 7) % 7;
  return addDays(s, -diff);
}

export function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function addMonths(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}

/** List of day starts in [from, to). */
export function daysBetween(from, to) {
  const out = [];
  for (let t = startOfDay(from); t < to; t = addDays(t, 1)) out.push(t);
  return out;
}

/** "1h 05m", "12m", "45s". */
export function fmtDur(ms, { seconds = false } = {}) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return seconds ? `${m}m ${pad(s)}s` : `${m}m`;
  return `${s}s`;
}

/** Clock style "1:05:09". */
export function fmtClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${pad(m)}:${pad(s)}`;
}

/** Decimal hours "1.25". */
export function fmtHours(ms, digits = 2) {
  return (ms / HOUR).toFixed(digits);
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(ts, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(ts).toLocaleDateString(undefined, opts);
}

export function fmtMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Value for <input type="datetime-local">. */
export function toLocalInput(ts) {
  const d = new Date(ts);
  return `${dayKey(ts)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v) {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

export function uid(prefix = '') {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${r}`;
}

export function isTrackableUrl(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

/** Hostname without a leading "www.". File URLs map to "file". */
export function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'file';
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Normalize a URL for storage; optionally drop query and hash for privacy. */
export function normalizeUrl(url, stripQuery = true) {
  try {
    const u = new URL(url);
    u.hash = '';
    if (stripQuery) u.search = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname === '/') s = s.slice(0, -1);
    return s;
  } catch {
    return url || '';
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse "1:30", "1h30m", "90m", "1.5" (hours) into ms. Returns NaN when invalid. */
export function parseDuration(text) {
  const s = String(text).trim().toLowerCase();
  if (!s) return NaN;
  let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return (+m[1] * 3600 + +m[2] * 60 + (+m[3] || 0)) * 1000;
  m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/);
  if (m && (m[1] || m[2])) return ((parseFloat(m[1] || 0) * 60) + (+m[2] || 0)) * MIN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * HOUR;
  return NaN;
}
