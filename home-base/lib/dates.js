// Pure date helpers. Dates are local calendar days stored as 'YYYY-MM-DD' strings,
// times as 'HH:MM' (24h). No dependencies so it runs in pages, the worker and node:test.

export const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
}

export function hm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function daysInMonth(year, month0) {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Add n months. `day` overrides the day of month (-1 = last day); it is clamped to the month length. */
export function addMonths(s, n, day) {
  const d = parseYmd(s);
  const total = d.getFullYear() * 12 + d.getMonth() + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const want = day == null ? d.getDate() : day;
  const last = daysInMonth(y, m);
  const dd = want === -1 ? last : Math.min(want, last);
  return ymd(new Date(y, m, dd));
}

export function weekday(s) {
  return parseYmd(s).getDay();
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

/** Monday-based week index since an arbitrary epoch, for "every 2 weeks" maths. */
export function weekIndex(s) {
  const days = diffDays('2000-01-03', s); // 2000-01-03 was a Monday
  return Math.floor(days / 7);
}

/** Start of the week containing s. weekStart 0 = Sunday, 1 = Monday. */
export function startOfWeek(s, weekStart = 1) {
  const wd = weekday(s);
  return addDays(s, -((wd - weekStart + 7) % 7));
}

export function toDateTime(date, time) {
  const d = parseYmd(date);
  if (time) {
    const [h, m] = time.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatTime(time, h24) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (h24) return `${pad(h)}:${pad(m)}`;
  const hh = h % 12 || 12;
  return `${hh}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Friendly label for a date relative to today: Today, Tomorrow, Yesterday, Wed, Oct 12, Oct 12 2027. */
export function relativeLabel(date, today) {
  const diff = diffDays(today, date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = parseYmd(date);
  if (diff > 1 && diff < 7) return WEEKDAY_LONG[d.getDay()];
  const base = `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === parseYmd(today).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function longLabel(date) {
  const d = parseYmd(date);
  return `${WEEKDAY_LONG[d.getDay()]}, ${MONTH_LONG[d.getMonth()]} ${d.getDate()}`;
}
