// Time zones (via Intl), "3pm PST" parsing, a meeting planner, unix
// timestamps and number bases. Pure functions; `now` can be injected for tests.

// Common abbreviations. Fixed offsets in minutes, or an IANA zone for generic
// names whose offset depends on the date (ET, PT...).
export const TZ_ABBREVIATIONS = {
  UTC: 0, GMT: 0, Z: 0, WET: 0, WEST: 60, BST: 60, IST: 330, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  PST: -480, PDT: -420, MST: -420, MDT: -360, CST: -360, CDT: -300, EST: -300, EDT: -240,
  AKST: -540, AKDT: -480, HST: -600, AST: -240, ADT: -180, NST: -210, NDT: -150,
  JST: 540, KST: 540, HKT: 480, SGT: 480, AWST: 480, ACST: 570, ACDT: 630, AEST: 600, AEDT: 660,
  NZST: 720, NZDT: 780, PHT: 480, WIB: 420, ICT: 420, PKT: 300, GST: 240, SAST: 120, CAT: 120, EAT: 180, WAT: 60, BRT: -180, ART: -180,
  ET: 'America/New_York', PT: 'America/Los_Angeles', CT: 'America/Chicago', MT: 'America/Denver',
};

export const POPULAR_CITIES = [
  ['Honolulu', 'Pacific/Honolulu'], ['Anchorage', 'America/Anchorage'], ['Los Angeles', 'America/Los_Angeles'],
  ['San Francisco', 'America/Los_Angeles'], ['Seattle', 'America/Los_Angeles'], ['Vancouver', 'America/Vancouver'],
  ['Denver', 'America/Denver'], ['Phoenix', 'America/Phoenix'], ['Chicago', 'America/Chicago'], ['Mexico City', 'America/Mexico_City'],
  ['Houston', 'America/Chicago'], ['New York', 'America/New_York'], ['Toronto', 'America/Toronto'], ['Miami', 'America/New_York'],
  ['Bogotá', 'America/Bogota'], ['Lima', 'America/Lima'], ['Santiago', 'America/Santiago'], ['São Paulo', 'America/Sao_Paulo'],
  ['Buenos Aires', 'America/Argentina/Buenos_Aires'], ['Reykjavík', 'Atlantic/Reykjavik'], ['London', 'Europe/London'],
  ['Dublin', 'Europe/Dublin'], ['Lisbon', 'Europe/Lisbon'], ['Paris', 'Europe/Paris'], ['Berlin', 'Europe/Berlin'],
  ['Madrid', 'Europe/Madrid'], ['Rome', 'Europe/Rome'], ['Amsterdam', 'Europe/Amsterdam'], ['Stockholm', 'Europe/Stockholm'],
  ['Warsaw', 'Europe/Warsaw'], ['Athens', 'Europe/Athens'], ['Helsinki', 'Europe/Helsinki'], ['Kyiv', 'Europe/Kyiv'],
  ['Istanbul', 'Europe/Istanbul'], ['Moscow', 'Europe/Moscow'], ['Cairo', 'Africa/Cairo'], ['Lagos', 'Africa/Lagos'],
  ['Johannesburg', 'Africa/Johannesburg'], ['Nairobi', 'Africa/Nairobi'], ['Dubai', 'Asia/Dubai'], ['Tehran', 'Asia/Tehran'],
  ['Karachi', 'Asia/Karachi'], ['Mumbai', 'Asia/Kolkata'], ['Delhi', 'Asia/Kolkata'], ['Bengaluru', 'Asia/Kolkata'],
  ['Kathmandu', 'Asia/Kathmandu'], ['Dhaka', 'Asia/Dhaka'], ['Bangkok', 'Asia/Bangkok'], ['Jakarta', 'Asia/Jakarta'],
  ['Singapore', 'Asia/Singapore'], ['Hong Kong', 'Asia/Hong_Kong'], ['Shanghai', 'Asia/Shanghai'], ['Beijing', 'Asia/Shanghai'],
  ['Taipei', 'Asia/Taipei'], ['Manila', 'Asia/Manila'], ['Seoul', 'Asia/Seoul'], ['Tokyo', 'Asia/Tokyo'], ['Perth', 'Australia/Perth'],
  ['Adelaide', 'Australia/Adelaide'], ['Brisbane', 'Australia/Brisbane'], ['Sydney', 'Australia/Sydney'], ['Melbourne', 'Australia/Melbourne'],
  ['Auckland', 'Pacific/Auckland'], ['UTC', 'UTC'],
].map(([name, zone]) => ({ name, zone }));

export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function isValidZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

export function allZones() {
  try { if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone'); } catch { /* old engine */ }
  return [...new Set(POPULAR_CITIES.map(c => c.zone))].sort();
}

export function cityLabel(zone) {
  const known = POPULAR_CITIES.find(c => c.zone === zone);
  if (known) return known.name;
  const last = zone.split('/').pop();
  return last.replace(/_/g, ' ');
}

const partsCache = new Map();
function partsFormatter(zone) {
  if (!partsCache.has(zone)) {
    partsCache.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsCache.get(zone);
}

// Wall-clock fields of an instant in a zone.
export function zonedParts(ms, zone) {
  const out = {};
  for (const p of partsFormatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

// Offset of `zone` from UTC at instant `ms`, in minutes (east positive).
export function zoneOffset(ms, zone) {
  const p = zonedParts(ms, zone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

// Instant (ms) for a wall-clock time in a zone. Handles DST transitions by
// re-checking the offset at the candidate instant.
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - zoneOffset(naive, zone) * 60000;
  const second = naive - zoneOffset(guess, zone) * 60000;
  if (second !== guess) guess = second;
  return guess;
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

export function formatInZone(ms, zone, opts = {}) {
  return new Intl.DateTimeFormat(opts.locale, {
    timeZone: zone, hour: 'numeric', minute: '2-digit',
    ...(opts.withDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
  }).format(new Date(ms));
}

// Parse a zone token: abbreviation, UTC±h[:mm], or an IANA name.
export function parseZone(token) {
  if (!token) return null;
  const t = token.trim();
  const up = t.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TZ_ABBREVIATIONS, up)) {
    const v = TZ_ABBREVIATIONS[up];
    return typeof v === 'number' ? { offset: v, label: up } : { zone: v, label: up };
  }
  const off = up.match(/^(?:UTC|GMT)\s*([+-−])\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (off) {
    const mins = Number(off[2]) * 60 + Number(off[3] || 0);
    if (mins > 14 * 60) return null;
    return { offset: off[1] === '+' ? mins : -mins, label: formatOffset(off[1] === '+' ? mins : -mins) };
  }
  if (t.includes('/') && isValidZone(t)) return { zone: t, label: t };
  const city = POPULAR_CITIES.find(c => c.name.toLowerCase() === t.toLowerCase());
  if (city) return { zone: city.zone, label: city.name };
  return null;
}

/**
 * Parse "3pm PST", "15:30 CET", "9:15 a.m. ET", "noon UTC" into an instant on
 * the current day (in the source zone). Returns { ms, source } or null.
 */
export function parseTimeWithZone(text, now = Date.now()) {
  if (!text) return null;
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (s.length > 40) return null;
  const m = s.match(/^(?:(noon|midnight)|(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?)\s*(?:in\s+)?([A-Za-z][A-Za-z_/ ]*?|(?:UTC|GMT)\s*[+-−]\s*\d{1,2}(?::?\d{2})?)$/i);
  if (!m) return null;
  let hour;
  let minute = 0;
  if (m[1]) hour = m[1].toLowerCase() === 'noon' ? 12 : 0;
  else {
    hour = Number(m[2]);
    minute = Number(m[3] || 0);
    const ampm = m[4] ? m[4].toLowerCase().replace(/\./g, '') : '';
    if (!ampm && !m[3]) return null; // "5 m" etc. must not look like a time
    if (minute > 59) return null;
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      if (ampm === 'pm' && hour !== 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
    } else if (hour > 23) return null;
  }
  const zone = parseZone(m[5]);
  if (!zone) return null;
  let ms;
  if (zone.zone) {
    const today = zonedParts(now, zone.zone);
    ms = zonedTimeToUtc({ year: today.year, month: today.month, day: today.day, hour, minute }, zone.zone);
  } else {
    const shifted = new Date(now + zone.offset * 60000);
    ms = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute) - zone.offset * 60000;
  }
  return { ms, source: zone, hour, minute };
}

/**
 * Meeting planner: for each hour of `date` (YYYY-MM-DD) in the first zone,
 * the local hour in every zone, flagged when inside working hours.
 */
export function meetingPlanner(zones, date, { start = 9, end = 17 } = {}) {
  if (!zones.length) return [];
  const [year, month, day] = date.split('-').map(Number);
  const base = zones[0];
  const rows = [];
  for (let h = 0; h < 24; h++) {
    const ms = zonedTimeToUtc({ year, month, day, hour: h, minute: 0 }, base);
    const cells = zones.map(zone => {
      const p = zonedParts(ms, zone);
      const working = p.hour >= start && p.hour < end;
      const awake = p.hour >= 7 && p.hour < 22;
      let dayShift = 0;
      const bp = zonedParts(ms, base);
      const a = Date.UTC(p.year, p.month - 1, p.day);
      const b = Date.UTC(bp.year, bp.month - 1, bp.day);
      dayShift = Math.round((a - b) / 86400000);
      return { zone, hour: p.hour, minute: p.minute, working, awake, dayShift };
    });
    rows.push({ ms, cells, allWorking: cells.every(c => c.working), allAwake: cells.every(c => c.awake) });
  }
  // A DST "spring forward" day repeats an hour; drop duplicates.
  return rows.filter((r, i) => i === 0 || r.ms !== rows[i - 1].ms);
}

// ---------------------------------------------------------------- timestamps

/**
 * Interpret a numeric unix timestamp, guessing the unit from its magnitude.
 * Returns { ms, unit } or null.
 */
export function parseUnixTimestamp(input) {
  const s = String(input).trim().replace(/[_,\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  let ms, unit;
  if (abs < 1e11) { ms = n * 1000; unit = 'seconds'; }
  else if (abs < 1e14) { ms = n; unit = 'milliseconds'; }
  else if (abs < 1e17) { ms = n / 1000; unit = 'microseconds'; }
  else { ms = n / 1e6; unit = 'nanoseconds'; }
  if (Math.abs(ms) > 8.64e15) return null;
  return { ms, unit };
}

export function relativeTime(ms, now = Date.now(), locale) {
  const diff = (ms - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  const steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400], [2629746, 'week', 604800], [31556952, 'month', 2629746], [Infinity, 'year', 31556952]];
  for (const [limit, unit, size] of steps) {
    if (abs < limit) return rtf.format(Math.round(diff / size), unit);
  }
  return '';
}

// ------------------------------------------------------------- number bases

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

export function parseInBase(input, base) {
  let s = String(input).trim().toLowerCase().replace(/[_\s]/g, '');
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  const prefixes = { 16: '0x', 2: '0b', 8: '0o' };
  if (prefixes[base] && s.startsWith(prefixes[base])) s = s.slice(2);
  if (!s) return null;
  let value = 0n;
  const B = BigInt(base);
  for (const ch of s) {
    const d = DIGITS.indexOf(ch);
    if (d < 0 || d >= base) return null;
    value = value * B + BigInt(d);
  }
  return negative ? -value : value;
}

export function toBase(value, base) {
  const big = BigInt(value);
  const neg = big < 0n;
  return (neg ? '-' : '') + (neg ? -big : big).toString(base);
}

// Detect "0xFF", "0b1010", "0o17" literals.
export function parsePrefixedInteger(text) {
  const m = String(text).trim().match(/^(-?)0([xbo])([0-9a-f_]+)$/i);
  if (!m) return null;
  const base = { x: 16, b: 2, o: 8 }[m[2].toLowerCase()];
  const v = parseInBase(m[3], base);
  if (v === null) return null;
  return { value: m[1] ? -v : v, base };
}

export function groupDigits(str, size, sep = ' ') {
  const neg = str.startsWith('-');
  const s = neg ? str.slice(1) : str;
  const out = [];
  for (let i = s.length; i > 0; i -= size) out.unshift(s.slice(Math.max(0, i - size), i));
  return (neg ? '-' : '') + out.join(sep);
}
