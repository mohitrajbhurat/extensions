// Storage layer. Everything lives in chrome.storage.local under a handful of keys.
// Pages, the popup and the service worker all read and write through here, so
// mutations always re-read the latest value first (read-modify-write) to keep
// concurrent writers from clobbering each other's changes.

export const KEYS = [
  'settings', 'tasks', 'projects', 'focus', 'notes', 'links', 'events',
  'clocks', 'habits', 'pomodoro', 'layout', 'bgShuffle',
];

export const WIDGETS = [
  { id: 'tasks', name: 'Tasks' },
  { id: 'notes', name: 'Notes' },
  { id: 'calendar', name: 'Calendar' },
  { id: 'clocks', name: 'World clocks' },
  { id: 'habits', name: 'Habits' },
  { id: 'pomodoro', name: 'Pomodoro' },
];

export const DEFAULT_SETTINGS = {
  name: '',
  h24: false,
  showSeconds: false,
  theme: 'auto', // auto | light | dark
  weekStart: 1, // 0 Sunday, 1 Monday
  show: { clock: true, greeting: true, focus: true, quote: true, links: true, search: true },
  searchEngine: 'default', // default | google | duckduckgo | bing | brave | ecosia
  background: { mode: 'generated', style: 'auto', dim: 30 }, // mode: generated | photos | mixed
  widgets: {
    tasks: true, notes: false, calendar: false, clocks: false, habits: false, pomodoro: true,
  },
  badge: true,
  reminders: true,
  reminderOffset: 0, // minutes before due time
  pomodoro: { work: 25, short: 5, long: 15, every: 4, autoStart: false, notify: true },
};

export const DEFAULT_PROJECTS = [
  { id: 'inbox', name: 'Inbox', color: '#6b7280', builtin: true },
  { id: 'personal', name: 'Personal', color: '#10b981' },
  { id: 'work', name: 'Work', color: '#3b82f6' },
];

export const DEFAULT_LINKS = [
  { id: 'l1', title: 'Gmail', url: 'https://mail.google.com/' },
  { id: 'l2', title: 'Calendar', url: 'https://calendar.google.com/' },
  { id: 'l3', title: 'GitHub', url: 'https://github.com/' },
  { id: 'l4', title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
];

export const DEFAULT_CLOCKS = [
  { id: 'c1', label: 'London', tz: 'Europe/London' },
  { id: 'c2', label: 'New York', tz: 'America/New_York' },
  { id: 'c3', label: 'Tokyo', tz: 'Asia/Tokyo' },
];

export const DEFAULT_POMODORO = { mode: 'work', running: false, endsAt: 0, remaining: 0, cycle: 0, day: '', doneToday: 0 };

const DEFAULTS = {
  settings: DEFAULT_SETTINGS,
  tasks: [],
  projects: DEFAULT_PROJECTS,
  focus: { date: '', text: '', done: false },
  notes: '# Scratchpad\n\nWrite anything here. **Markdown** works.\n\n- [ ] Try a checklist\n',
  links: DEFAULT_LINKS,
  events: [],
  clocks: DEFAULT_CLOCKS,
  habits: [],
  pomodoro: DEFAULT_POMODORO,
  layout: {},
  bgShuffle: { date: '', n: 0 },
};

export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36).slice(0, 4);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge `value` over `defaults` for plain objects; arrays and scalars replace. */
export function withDefaults(defaults, value) {
  if (!isPlainObject(defaults)) return value === undefined ? clone(defaults) : value;
  const out = {};
  const src = isPlainObject(value) ? value : {};
  for (const k of Object.keys(defaults)) out[k] = withDefaults(defaults[k], src[k]);
  for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k];
  return out;
}

export function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export async function get(key) {
  const r = await chrome.storage.local.get(key);
  return withDefaults(DEFAULTS[key], r[key]);
}

export async function getMany(keys) {
  const r = await chrome.storage.local.get(keys);
  const out = {};
  for (const k of keys) out[k] = withDefaults(DEFAULTS[k], r[k]);
  return out;
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

/** Read the latest value, let `fn` change it (mutate or return a new value), write it back. */
export async function update(key, fn) {
  const cur = await get(key);
  const next = await fn(cur);
  const value = next === undefined ? cur : next;
  await set(key, value);
  return value;
}

/** Subscribe to changes of the given keys. Returns an unsubscribe function. */
export function watch(keys, fn) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const hit = keys.filter((k) => k in changes);
    if (!hit.length) return;
    const vals = {};
    for (const k of hit) vals[k] = withDefaults(DEFAULTS[k], changes[k].newValue);
    fn(vals);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Make sure every key has a value (first install or after an upgrade). */
export async function ensureDefaults() {
  const r = await chrome.storage.local.get(KEYS);
  const patch = {};
  for (const k of KEYS) if (r[k] === undefined) patch[k] = clone(DEFAULTS[k]);
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

// ---------------------------------------------------------------- backup

export const BACKUP_APP = 'home-base';

export async function exportData() {
  const r = await chrome.storage.local.get(KEYS);
  const data = {};
  for (const k of KEYS) if (r[k] !== undefined) data[k] = r[k];
  return { app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(), data };
}

/** Validate a parsed backup. Throws with a readable message when it is not usable. */
export function validateBackup(obj) {
  if (!isPlainObject(obj) || obj.app !== BACKUP_APP || !isPlainObject(obj.data)) {
    throw new Error('This file is not a Home Base backup.');
  }
  const d = obj.data;
  const arrays = ['tasks', 'projects', 'links', 'events', 'clocks', 'habits'];
  for (const k of arrays) {
    if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`Backup field "${k}" is malformed.`);
  }
  if (d.tasks && d.tasks.some((t) => !isPlainObject(t) || typeof t.id !== 'string' || typeof t.title !== 'string')) {
    throw new Error('Backup contains malformed tasks.');
  }
  if (d.notes !== undefined && typeof d.notes !== 'string') throw new Error('Backup notes are malformed.');
  if (d.settings !== undefined && !isPlainObject(d.settings)) throw new Error('Backup settings are malformed.');
  const out = {};
  for (const k of KEYS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

export async function importData(obj) {
  const data = validateBackup(obj);
  if (data.projects && !data.projects.some((p) => p.id === 'inbox')) {
    data.projects.unshift(clone(DEFAULT_PROJECTS[0]));
  }
  await chrome.storage.local.set(data);
  return Object.keys(data);
}

export async function resetAll() {
  await chrome.storage.local.clear();
  await ensureDefaults();
}
