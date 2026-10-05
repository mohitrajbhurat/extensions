// Natural-language parsing for task input: dates, times, recurrence, priority,
// labels and project. Pure functions, no browser APIs, so node:test can drive them.
//
//   parseTask('buy milk tomorrow 5pm p1 #errands @shop')
//     -> { title: 'buy milk', date: '2026-10-06', time: '17:00', priority: 1,
//          project: 'errands', labels: ['shop'], recur: null }
//
import {
  ymd, parseYmd, addDays, addMonths, daysInMonth, weekday, diffDays, weekIndex,
  startOfWeek, pad, WEEKDAY_LONG, MONTH_SHORT, MONTH_LONG, ordinal,
} from './dates.js';

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const WD_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const MON_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const NUMWORD = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, other: 2, a: 1, an: 1,
};
const NUM_RE = `\\d+|${Object.keys(NUMWORD).join('|')}`;
const num = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NUMWORD[s.toLowerCase()] ?? 1);

const NAMED_TIMES = {
  noon: '12:00', midday: '12:00', midnight: '00:00',
  morning: '09:00', afternoon: '14:00', evening: '18:00', tonight: '20:00', night: '20:00',
};

// ---------------------------------------------------------------- recurrence

/** True when `date` is an occurrence of `rule` anchored at `anchor`. */
export function matchesRecur(rule, date, anchor = rule.anchor) {
  if (!rule || !anchor) return false;
  const iv = Math.max(1, rule.interval || 1);
  const d = parseYmd(date);
  switch (rule.kind) {
    case 'daily':
      return diffDays(anchor, date) % iv === 0;
    case 'weekly': {
      const set = rule.weekdays && rule.weekdays.length ? rule.weekdays : [weekday(anchor)];
      if (!set.includes(weekday(date))) return false;
      const w = weekIndex(date) - weekIndex(startOfWeek(anchor, 1));
      return ((w % iv) + iv) % iv === 0;
    }
    case 'monthly': {
      const want = rule.day == null ? parseYmd(anchor).getDate() : rule.day;
      const last = daysInMonth(d.getFullYear(), d.getMonth());
      const target = want === -1 ? last : Math.min(want, last);
      if (d.getDate() !== target) return false;
      const a = parseYmd(anchor);
      const months = (d.getFullYear() - a.getFullYear()) * 12 + (d.getMonth() - a.getMonth());
      return ((months % iv) + iv) % iv === 0;
    }
    case 'yearly': {
      const a = parseYmd(anchor);
      const month = rule.month == null ? a.getMonth() : rule.month;
      const want = rule.day == null ? a.getDate() : rule.day;
      if (d.getMonth() !== month) return false;
      const last = daysInMonth(d.getFullYear(), month);
      if (d.getDate() !== Math.min(want, last)) return false;
      return (d.getFullYear() - a.getFullYear()) % iv === 0;
    }
    default:
      return false;
  }
}

/** First occurrence of `rule` on or after `from`. Returns null if none within ~6 years. */
export function firstOccurrence(rule, from, anchor = rule.anchor || from) {
  if (!rule) return null;
  let d = from;
  for (let i = 0; i < 2200; i++) {
    if (matchesRecur(rule, d, anchor)) return d;
    d = addDays(d, 1);
  }
  return null;
}

/** Next occurrence strictly after `from`. */
export function nextOccurrence(rule, from, anchor = rule.anchor || from) {
  return firstOccurrence(rule, addDays(from, 1), anchor);
}

export function describeRecur(rule) {
  if (!rule) return '';
  const iv = Math.max(1, rule.interval || 1);
  const every = iv === 1 ? 'every' : iv === 2 ? 'every other' : `every ${iv}`;
  switch (rule.kind) {
    case 'daily':
      return iv === 1 ? 'daily' : `${every} day${iv > 2 ? 's' : ''}`;
    case 'weekly': {
      if (rule.weekdays && rule.weekdays.length) {
        const names = rule.weekdays.slice().sort().map((w) => WEEKDAY_LONG[w]);
        if (rule.weekdays.length === 5 && [1, 2, 3, 4, 5].every((w) => rule.weekdays.includes(w))) {
          return `${every} weekday`;
        }
        return `${every} ${names.join(', ')}`;
      }
      return iv === 1 ? 'weekly' : `${every} week${iv > 2 ? 's' : ''}`;
    }
    case 'monthly': {
      const day = rule.day === -1 ? 'last day' : rule.day == null ? null : ordinal(rule.day);
      const base = iv === 1 ? 'monthly' : `${every} month${iv > 2 ? 's' : ''}`;
      return day ? `${base} on the ${day}` : base;
    }
    case 'yearly': {
      const base = iv === 1 ? 'yearly' : `${every} year${iv > 2 ? 's' : ''}`;
      if (rule.month != null && rule.day != null) return `${base} on ${MONTH_SHORT[rule.month]} ${rule.day}`;
      return base;
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------- scanning

/** Collect non-overlapping matches of `re` in `text`, newest wins, left to right. */
function scan(text, re, fn, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (out.some((s) => start < s.end && end > s.start)) continue;
    const res = fn(m);
    if (res) out.push({ start, end, ...res });
  }
}

function resolveWeekday(target, today, mode) {
  if (mode === 'next') {
    const base = addDays(startOfWeek(today, 1), 7);
    return addDays(base, (target - 1 + 7) % 7);
  }
  const delta = (target - weekday(today) + 7) % 7;
  if (mode === 'strict' && delta === 0) return addDays(today, 7);
  return addDays(today, delta);
}

/** Pick the year that puts month/day on or after today, unless a year was given. */
function monthDay(month, day, today, year) {
  if (year != null) {
    const y = year < 100 ? 2000 + year : year;
    return ymd(new Date(y, month, Math.min(day, daysInMonth(y, month))));
  }
  const t = parseYmd(today);
  let y = t.getFullYear();
  let s = ymd(new Date(y, month, Math.min(day, daysInMonth(y, month))));
  if (diffDays(today, s) < 0) s = ymd(new Date(++y, month, Math.min(day, daysInMonth(y, month))));
  return s;
}

function timeFrom(h, m, mer) {
  let hh = h;
  if (mer) {
    hh = h % 12;
    if (/^p/.test(mer)) hh += 12;
  } else if (h > 23) return null;
  if (hh > 23 || m > 59) return null;
  return `${pad(hh)}:${pad(m)}`;
}

/**
 * Parse date, time and recurrence out of free text.
 * @param {string} text
 * @param {Date|string} [now]
 * @returns {{date:string|null,time:string|null,recur:object|null,rest:string,matches:Array}}
 */
export function parseDateText(text, now = new Date()) {
  const today = typeof now === 'string' ? now : ymd(now);
  const nowTime = typeof now === 'string' ? null : now;
  const lower = text.toLowerCase();
  const found = [];

  // --- recurrence (first, so "every monday" is not read as a plain weekday)
  scan(lower, new RegExp(`\\bevery\\s+(?:(${NUM_RE})\\s+)?(day|days|week|weeks|month|months|year|years|weekday|weekdays|weekend|weekends|${WD_RE})((?:\\s*(?:,|and|&)\\s*(?:${WD_RE}))*)\\b`, 'gi'), (m) => {
    const iv = m[1] ? num(m[1]) : 1;
    const unit = m[2].toLowerCase();
    if (/^day/.test(unit)) return { recur: { kind: 'daily', interval: iv } };
    if (/^week$|^weeks$/.test(unit)) return { recur: { kind: 'weekly', interval: iv } };
    if (/^month/.test(unit)) return { recur: { kind: 'monthly', interval: iv } };
    if (/^year/.test(unit)) return { recur: { kind: 'yearly', interval: iv } };
    if (/^weekday/.test(unit)) return { recur: { kind: 'weekly', interval: iv, weekdays: [1, 2, 3, 4, 5] } };
    if (/^weekend/.test(unit)) return { recur: { kind: 'weekly', interval: iv, weekdays: [0, 6] } };
    const days = [WEEKDAYS[unit]];
    if (m[3]) {
      for (const w of m[3].toLowerCase().match(new RegExp(`\\b(?:${WD_RE})\\b`, 'g')) || []) days.push(WEEKDAYS[w]);
    }
    return { recur: { kind: 'weekly', interval: iv, weekdays: [...new Set(days)].sort() } };
  }, found);

  // every 15th / every last day of the month / every jan 5
  scan(lower, /\bevery\s+(?:month\s+on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?:\s+of\s+(?:the\s+)?month)?/gi,
    (m) => ({ recur: { kind: 'monthly', interval: 1, day: Math.min(31, parseInt(m[1], 10)) } }), found);
  scan(lower, /\bevery\s+last\s+day(?:\s+of\s+(?:the\s+)?month)?\b/gi,
    () => ({ recur: { kind: 'monthly', interval: 1, day: -1 } }), found);
  scan(lower, new RegExp(`\\bevery\\s+(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
    (m) => ({ recur: { kind: 'yearly', interval: 1, month: MONTHS[m[1]], day: parseInt(m[2], 10) } }), found);
  scan(lower, /\b(daily|weekly|fortnightly|biweekly|monthly|quarterly|yearly|annually)\b/gi, (m) => {
    const k = m[1].toLowerCase();
    if (k === 'daily') return { recur: { kind: 'daily', interval: 1 } };
    if (k === 'weekly') return { recur: { kind: 'weekly', interval: 1 } };
    if (k === 'fortnightly' || k === 'biweekly') return { recur: { kind: 'weekly', interval: 2 } };
    if (k === 'monthly') return { recur: { kind: 'monthly', interval: 1 } };
    if (k === 'quarterly') return { recur: { kind: 'monthly', interval: 3 } };
    return { recur: { kind: 'yearly', interval: 1 } };
  }, found);

  // --- explicit dates
  scan(lower, /\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (mo > 11 || d < 1 || d > 31) return null;
    return { date: ymd(new Date(y, mo, d)) };
  }, found);
  // 12/10 or 12/10/2027 (month/day, US order)
  scan(lower, /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => {
    const mo = +m[1] - 1, d = +m[2];
    if (mo > 11 || d < 1 || d > 31) return null;
    return { date: monthDay(mo, d, today, m[3] ? +m[3] : null) };
  }, found);
  scan(lower, new RegExp(`\\b(?:on\\s+)?(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    (m) => ({ date: monthDay(MONTHS[m[1]], +m[2], today, m[3] ? +m[3] : null) }), found);
  scan(lower, new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON_RE})\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    (m) => ({ date: monthDay(MONTHS[m[2]], +m[1], today, m[3] ? +m[3] : null) }), found);

  // --- relative dates
  scan(lower, /\b(today|tod|tonight|tomorrow|tomorrowo|tmr|tmrw|tom|yesterday)\b/gi, (m) => {
    const k = m[1].toLowerCase();
    if (k === 'yesterday') return { date: addDays(today, -1) };
    if (k === 'tonight') return { date: today, time: '20:00' };
    if (k === 'today' || k === 'tod') return { date: today };
    return { date: addDays(today, 1) };
  }, found);
  scan(lower, /\bday\s+after\s+tomorrow\b/gi, () => ({ date: addDays(today, 2) }), found);
  scan(lower, new RegExp(`\\bin\\s+(${NUM_RE})\\s+(day|days|week|weeks|month|months|year|years)\\b`, 'gi'), (m) => {
    const n = num(m[1]);
    const u = m[2].toLowerCase();
    if (/^day/.test(u)) return { date: addDays(today, n) };
    if (/^week/.test(u)) return { date: addDays(today, n * 7) };
    if (/^month/.test(u)) return { date: addMonths(today, n) };
    return { date: addMonths(today, n * 12) };
  }, found);
  scan(lower, new RegExp(`\\bin\\s+(${NUM_RE})\\s+(hour|hours|hr|hrs|min|mins|minute|minutes)\\b`, 'gi'), (m) => {
    const n = num(m[1]);
    const base = nowTime ? new Date(nowTime.getTime()) : parseYmd(today);
    base.setMinutes(base.getMinutes() + n * (/^h/.test(m[2]) ? 60 : 1));
    return { date: ymd(base), time: `${pad(base.getHours())}:${pad(base.getMinutes())}` };
  }, found);
  scan(lower, /\b(next|this|end\s+of(?:\s+the)?)\s+(week|month|year|quarter)\b/gi, (m) => {
    const when = m[1].toLowerCase().replace(/\s+/g, ' ');
    const unit = m[2].toLowerCase();
    if (when.startsWith('end of')) {
      if (unit === 'week') return { date: addDays(startOfWeek(today, 1), 6) };
      if (unit === 'month') return { date: addMonths(today, 0, -1) };
      if (unit === 'year') { const y = parseYmd(today).getFullYear(); return { date: `${y}-12-31` }; }
      const q = Math.floor(parseYmd(today).getMonth() / 3);
      return { date: addMonths(`${parseYmd(today).getFullYear()}-${pad(q * 3 + 3)}-01`, 0, -1) };
    }
    if (when === 'this') {
      if (unit === 'week') return { date: addDays(startOfWeek(today, 1), 6) };
      return { date: today };
    }
    if (unit === 'week') return { date: addDays(startOfWeek(today, 1), 7) };
    if (unit === 'month') return { date: addMonths(today, 1) };
    if (unit === 'quarter') return { date: addMonths(today, 3) };
    return { date: addMonths(today, 12) };
  }, found);
  scan(lower, new RegExp(`\\b(next|this(?:\\s+coming)?|coming|on)?\\s*(${WD_RE})\\b`, 'gi'), (m) => {
    const mode = !m[1] ? 'soon' : /next/.test(m[1]) ? 'next' : 'soon';
    return { date: resolveWeekday(WEEKDAYS[m[2].toLowerCase()], today, mode) };
  }, found);

  // --- times
  scan(lower, /\b(?:at\s+|@)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/gi, (m) => {
    const t = timeFrom(+m[1], m[2] ? +m[2] : 0, m[3].replace(/\./g, ''));
    return t ? { time: t } : null;
  }, found);
  scan(lower, /\b(?:at|from)\s+(\d{1,2}):(\d{2})\b/gi, (m) => {
    const t = timeFrom(+m[1], +m[2], null);
    return t ? { time: t } : null;
  }, found);
  scan(lower, /\b(\d{1,2}):(\d{2})\b/g, (m) => {
    const t = timeFrom(+m[1], +m[2], null);
    return t ? { time: t } : null;
  }, found);
  scan(lower, /\bat\s+(\d{1,2})\b/gi, (m) => {
    const h = +m[1];
    if (h > 23) return null;
    // "at 5" with no meridiem: read 1-7 as afternoon, like most task apps do.
    const hh = h >= 1 && h <= 7 ? h + 12 : h;
    return { time: `${pad(hh)}:00` };
  }, found);
  scan(lower, new RegExp(`\\b(?:in\\s+the\\s+|this\\s+|at\\s+)?(${Object.keys(NAMED_TIMES).join('|')})\\b`, 'gi'),
    (m) => ({ time: NAMED_TIMES[m[1].toLowerCase()] }), found);

  found.sort((a, b) => a.start - b.start);
  let date = null, time = null, recur = null;
  for (const f of found) {
    if (f.date && !date) date = f.date;
    if (f.time && !time) time = f.time;
    if (f.recur && !recur) recur = f.recur;
  }

  if (recur) {
    recur.anchor = date || today;
    const first = firstOccurrence(recur, date || today, recur.anchor);
    if (first) { date = first; recur.anchor = first; }
  } else if (time && !date) {
    // bare time: today if still ahead, else tomorrow
    date = today;
    if (nowTime) {
      const [h, mi] = time.split(':').map(Number);
      if (h * 60 + mi <= nowTime.getHours() * 60 + nowTime.getMinutes()) date = addDays(today, 1);
    }
  }

  // Strip matched spans from the text, keeping original case.
  let rest = text;
  for (const f of found.slice().sort((a, b) => b.start - a.start)) {
    rest = rest.slice(0, f.start) + ' ' + rest.slice(f.end);
  }
  rest = rest.replace(/\s*\b(on|at|by|due|starting|from|every|this|next)\b\s*$/i, ' ')
    .replace(/[\s,]+/g, ' ').trim();

  return { date, time, recur, rest, matches: found };
}

/**
 * Full task-input parse: priority (p1..p4 or !!!), #project, @labels, then dates.
 * @returns {{title:string,date:string|null,time:string|null,recur:object|null,priority:number,project:string|null,labels:string[]}}
 */
export function parseTask(text, now = new Date()) {
  let s = String(text || '');
  let priority = 4;
  const labels = [];
  let project = null;

  s = s.replace(/(^|\s)!([1-4])\b/g, (_, a, d) => { priority = +d; return a; });
  s = s.replace(/(^|\s)p([1-4])\b/gi, (_, a, d) => { priority = +d; return a; });
  s = s.replace(/(^|\s)(!{1,3})(?=\s|$)/g, (_, a, b) => { priority = 4 - b.length; return a; });
  s = s.replace(/(^|\s)@([\w-]+)/g, (_, a, l) => { labels.push(l.toLowerCase()); return a; });
  s = s.replace(/(^|\s)#([\w-]+)/g, (_, a, p) => { project = p.toLowerCase(); return a; });

  const r = parseDateText(s, now);
  let title = r.rest.replace(/\s+/g, ' ').trim();
  if (title) title = title[0].toUpperCase() + title.slice(1);
  return { title, date: r.date, time: r.time, recur: r.recur, priority, project, labels };
}

/** Human summary of a parse, for the input hint line. */
export function describeParse(p, today) {
  const bits = [];
  if (p.date) {
    const d = parseYmd(p.date);
    const diff = diffDays(today, p.date);
    bits.push(diff === 0 ? 'today' : diff === 1 ? 'tomorrow'
      : `${MONTH_LONG[d.getMonth()]} ${d.getDate()}`);
  }
  if (p.time) bits.push(`at ${p.time}`);
  if (p.recur) bits.push(describeRecur(p.recur));
  if (p.priority < 4) bits.push(`priority ${p.priority}`);
  if (p.project) bits.push(`#${p.project}`);
  for (const l of p.labels) bits.push(`@${l}`);
  return bits.join(' · ');
}
