// Monitor model, settings and small helpers shared by every extension context.
import { validateCondition } from './conditions.js';

export const INTERVALS = [
  { min: 1, label: 'Every minute' },
  { min: 5, label: 'Every 5 minutes' },
  { min: 10, label: 'Every 10 minutes' },
  { min: 15, label: 'Every 15 minutes' },
  { min: 30, label: 'Every 30 minutes' },
  { min: 60, label: 'Every hour' },
  { min: 180, label: 'Every 3 hours' },
  { min: 360, label: 'Every 6 hours' },
  { min: 720, label: 'Every 12 hours' },
  { min: 1440, label: 'Once a day' },
];

export const DEFAULT_SETTINGS = {
  defaultInterval: 30,
  maxSnapshots: 100,
  notifications: true,
  soundVolume: 0.6,
  sound: 'chime',
  showBadge: true,
  renderWait: 5,
};

export const MONITOR_FIELDS = ['id', 'name', 'url', 'selector', 'mode', 'renderWait', 'interval', 'condition',
  'notify', 'sound', 'paused', 'createdAt'];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function intervalLabel(min) {
  const hit = INTERVALS.find((i) => i.min === min);
  if (hit) return hit.label;
  if (min < 60) return `Every ${min} min`;
  if (min % 60 === 0) return `Every ${min / 60} h`;
  return `Every ${min} min`;
}

export function clampInterval(min) {
  const n = Math.round(Number(min));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.defaultInterval;
  return Math.min(1440, Math.max(1, n));
}

export function isWatchableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Host permission pattern for a URL, e.g. https://shop.example.com/* */
export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Fill defaults and coerce types. Throws Error with a user-facing message when invalid. */
export function normalizeMonitor(input, settings = DEFAULT_SETTINGS) {
  const m = { ...input };
  m.url = String(m.url || '').trim();
  if (!isWatchableUrl(m.url)) throw new Error('Enter a valid http(s) URL');
  m.id = m.id || uid();
  m.selector = String(m.selector || '').trim();
  m.name = String(m.name || '').trim() || defaultName(m.url, m.selector);
  m.mode = m.mode === 'render' ? 'render' : 'fetch';
  m.renderWait = Math.min(60, Math.max(1, Number(m.renderWait) || settings.renderWait || 5));
  m.interval = clampInterval(m.interval ?? settings.defaultInterval);
  const c = m.condition && typeof m.condition === 'object' ? m.condition : { type: 'any' };
  m.condition = { type: c.type || 'any', value: c.value == null ? '' : String(c.value), caseSensitive: !!c.caseSensitive };
  const err = validateCondition(m.condition);
  if (err) throw new Error(err);
  m.notify = m.notify !== false;
  m.sound = !!m.sound;
  m.paused = !!m.paused;
  m.createdAt = Number(m.createdAt) || Date.now();
  return m;
}

export function defaultName(url, selector) {
  const host = hostOf(url);
  let path = '';
  try { path = new URL(url).pathname.replace(/\/$/, ''); } catch { /* ignore */ }
  const tail = path.split('/').filter(Boolean).pop();
  const base = tail ? `${host} › ${decodeURIComponent(tail).slice(0, 40)}` : host;
  return selector ? base : `${base} (whole page)`;
}

/** Only the user-configurable fields (used for export and for save requests). */
export function pickConfig(m) {
  const out = {};
  for (const k of MONITOR_FIELDS) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

export async function getMonitors() {
  const { monitors } = await chrome.storage.local.get('monitors');
  return monitors && typeof monitors === 'object' ? monitors : {};
}

export async function getMonitorList() {
  const map = await getMonitors();
  return Object.values(map).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (res && res.error) throw new Error(res.error);
    return res;
  });
}

export function relTime(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < -30) {
    const f = -s;
    if (f < 60) return `in ${f}s`;
    if (f < 3600) return `in ${Math.round(f / 60)} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} d`;
  }
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const STATUS_LABEL = {
  ok: 'Watching',
  changed: 'Changed',
  error: 'Error',
  needs_permission: 'Needs access',
  paused: 'Paused',
  pending: 'Pending',
  checking: 'Checking…',
};

/** Effective status for display. */
export function statusOf(m) {
  if (m.checking) return 'checking';
  if (m.paused) return 'paused';
  if (m.status === 'needs_permission') return 'needs_permission';
  if (m.status === 'error') return 'error';
  if (m.unread > 0) return 'changed';
  if (!m.lastCheck) return 'pending';
  return 'ok';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
