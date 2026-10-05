// Shared pure helpers for Mindful Gate: defaults, domain matching, schedules, dates.
// Imported by the service worker and by every extension page (ES module).

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const DEFAULT_REASONS = [
  'I want my evenings back for the people I love.',
  'Deep work is how I get better at what I care about.',
  'Scrolling never made me feel rested.',
  'Future me will thank present me for this.',
];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function defaultSettings() {
  return {
    version: 1,
    groups: [
      {
        id: 'social',
        name: 'Social and video',
        sites: ['youtube.com', 'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com', 'reddit.com'],
        mode: 'gate', // 'gate' = mindful prompt, 'block' = only hard blocked during schedules/focus
        blockDuringFocus: true,
        strict: false,
        schedules: [],
      },
      {
        id: 'news',
        name: 'News',
        sites: ['news.ycombinator.com', 'cnn.com'],
        mode: 'gate',
        blockDuringFocus: true,
        strict: false,
        schedules: [{ id: 'workday', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }],
      },
    ],
    gate: {
      passOptions: [5, 10, 15],
      breathBase: 5, // seconds for the first visit of the day
      breathStep: 5, // extra seconds per earlier visit that day
      breathMax: 60,
      minIntention: 3,
      warnBeforeEnd: true,
      extendMinutes: 5,
    },
    pomodoro: {
      work: 25,
      short: 5,
      long: 15,
      cycles: 4,
      autoStartBreaks: true,
      autoStartWork: false,
      strict: false,
      notifications: true,
      sound: true,
      volume: 0.6,
      badge: true,
      dailyGoal: 4, // sessions
    },
    tracking: { enabled: true, idleSeconds: 60 },
    reasons: DEFAULT_REASONS.slice(),
  };
}

/** Merge stored settings over defaults so new keys appear after upgrades. */
export function normalizeSettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  const out = { ...d, ...s };
  out.gate = { ...d.gate, ...(s.gate || {}) };
  out.pomodoro = { ...d.pomodoro, ...(s.pomodoro || {}) };
  out.tracking = { ...d.tracking, ...(s.tracking || {}) };
  out.reasons = Array.isArray(s.reasons) ? s.reasons.filter(r => typeof r === 'string') : d.reasons;
  out.groups = (Array.isArray(s.groups) ? s.groups : d.groups).map(g => ({
    id: g.id || uid(),
    name: String(g.name || 'Untitled group'),
    sites: Array.from(new Set((g.sites || []).map(normalizeDomain).filter(Boolean))),
    mode: g.mode === 'block' ? 'block' : 'gate',
    blockDuringFocus: g.blockDuringFocus !== false,
    strict: !!g.strict,
    schedules: (g.schedules || []).map(sc => ({
      id: sc.id || uid(),
      days: Array.isArray(sc.days) ? sc.days.filter(n => n >= 0 && n <= 6) : [],
      start: validTime(sc.start) ? sc.start : '09:00',
      end: validTime(sc.end) ? sc.end : '17:00',
    })),
  }));
  return out;
}

function validTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

/** Turn "https://www.YouTube.com/watch?v=1" or "youtube.com/" into "youtube.com". */
export function normalizeDomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  try {
    if (!/^[a-z]+:\/\//.test(s)) s = 'http://' + s;
    const u = new URL(s);
    let h = u.hostname.replace(/\.$/, '');
    if (h.startsWith('www.')) h = h.slice(4);
    if (!/^[a-z0-9.-]+$/.test(h) || h.length > 253) return '';
    if (!h.includes('.') && h !== 'localhost') return '';
    return h;
  } catch {
    return '';
  }
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/** All listed domains (across groups) that match a host, shortest first. */
export function matchingDomains(settings, host) {
  if (!host) return [];
  const set = new Set();
  for (const g of settings.groups) for (const d of g.sites) if (hostMatches(host, d)) set.add(d);
  return [...set].sort((a, b) => a.length - b.length);
}

/** The canonical "root" listed domain for a host: the shortest listed match. */
export function rootDomain(settings, host) {
  return matchingDomains(settings, host)[0] || '';
}

export function groupsForHost(settings, host) {
  return settings.groups.filter(g => g.sites.some(d => hostMatches(host, d)));
}

/** Gated domains are listed in a group whose mode is 'gate', minus subdomains of other gated domains. */
export function gatedDomains(settings) {
  const all = new Set();
  for (const g of settings.groups) if (g.mode === 'gate') g.sites.forEach(d => all.add(d));
  return [...all].filter(d => ![...all].some(o => o !== d && hostMatches(d, o)));
}

// ---------- time & schedules ----------

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fmtTime(hhmm) {
  return hhmm;
}

/** Is a schedule active at Date `now`? Handles windows that cross midnight. */
export function scheduleActive(sc, now = new Date()) {
  if (!sc.days || !sc.days.length) return false;
  const s = toMinutes(sc.start), e = toMinutes(sc.end);
  const mins = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  if (s === e) return sc.days.includes(day); // full day
  if (s < e) return sc.days.includes(day) && mins >= s && mins < e;
  // overnight: started today after s, or started yesterday and before e
  const yesterday = (day + 6) % 7;
  return (sc.days.includes(day) && mins >= s) || (sc.days.includes(yesterday) && mins < e);
}

/** When does an active schedule end (timestamp)? */
export function scheduleEndsAt(sc, now = new Date()) {
  const s = toMinutes(sc.start), e = toMinutes(sc.end);
  const end = new Date(now);
  end.setSeconds(0, 0);
  const mins = now.getHours() * 60 + now.getMinutes();
  if (s === e) { end.setHours(24, 0, 0, 0); return end.getTime(); }
  end.setHours(Math.floor(e / 60), e % 60, 0, 0);
  if (s > e && mins >= s) end.setDate(end.getDate() + 1);
  return end.getTime();
}

/** Active schedule info for a group, or null. Returns latest end among active windows. */
export function activeSchedule(group, now = new Date()) {
  let best = null;
  for (const sc of group.schedules || []) {
    if (scheduleActive(sc, now)) {
      const until = scheduleEndsAt(sc, now);
      if (!best || until > best.until) best = { schedule: sc, until };
    }
  }
  return best;
}

export function describeSchedule(sc) {
  const days = sc.days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const key = days.join(',');
  let d;
  if (key === '1,2,3,4,5') d = 'Weekdays';
  else if (key === '6,0') d = 'Weekends';
  else if (days.length === 7) d = 'Every day';
  else d = days.map(n => DAY_NAMES[n]).join(', ') || 'No days';
  const range = sc.start === sc.end ? 'all day' : `${sc.start} to ${sc.end}`;
  return `${d}, ${range}`;
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function lastNDays(n, end = Date.now()) {
  const out = [];
  const d = new Date(end);
  d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(dayKey(x.getTime()));
  }
  return out;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec === 0) return '0m';
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtHourMin(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function breathSeconds(gate, visitsToday) {
  const v = Math.max(0, visitsToday | 0);
  return Math.min(gate.breathMax, gate.breathBase + gate.breathStep * v);
}

export function emptyDay() {
  return { sites: {}, prompts: {}, turnedBack: {}, passes: {}, blockedHits: 0, focusMinutes: 0, focusSessions: 0 };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Send a message to the service worker; resolves with its response. */
export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, res => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}
