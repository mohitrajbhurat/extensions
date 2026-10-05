// Shared helpers for extension pages (popup, dashboard, options).
import './price-parse.js';
import './stats.js';

export const PP = globalThis.PriceParse;
export const PS = globalThis.PriceStats;

export const DEFAULT_SETTINGS = {
  intervalHours: 6,
  notifyTarget: true,
  notifyLow: true,
  notifyStock: true,
  goodDealPct: 5,
  recordVisits: true,
  defaultTargetType: 'percent',
  defaultTargetValue: 10,
  maxHistory: 3000,
};

/** Send a message to the service worker; throws on error. */
export async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error || 'Request failed');
  return res.result;
}

export async function getSettings() {
  try {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

export async function getItems() {
  const { items = {} } = await chrome.storage.local.get('items');
  return items;
}

export const fmt = (amount, currency) => PP.formatPrice(amount, currency);

export function originPattern(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.hostname}/*`; } catch (_) { return null; }
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

export async function hasOrigin(url) {
  const p = originPattern(url);
  if (!p) return false;
  try { return await chrome.permissions.contains({ origins: [p] }); } catch (_) { return false; }
}

/** Must be called from a user gesture. */
export async function requestOrigin(url) {
  const p = originPattern(url);
  if (!p) return false;
  try {
    const granted = await chrome.permissions.request({ origins: [p] });
    if (granted) send('permissions-changed').catch(() => {});
    return granted;
  } catch (_) {
    return false;
  }
}

export function relTime(t) {
  if (!t) return 'never';
  const s = (Date.now() - t) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString();
}

export function pct(n, digits = 0) {
  if (n == null || !isFinite(n)) return '—';
  const v = n.toFixed(digits);
  return (n > 0 ? '+' : '') + v + '%';
}

export function targetLabel(item) {
  const t = item.target || { type: 'none' };
  if (t.type === 'price') return `Below ${fmt(t.value, item.currency)}`;
  if (t.type === 'percent') return `${t.value}% drop (${fmt(PS.targetPrice(t, item.baselinePrice), item.currency)})`;
  if (t.type === 'any') return 'Any drop';
  return 'No target';
}

export const STATUS_TEXT = {
  ok: 'OK',
  needs_visit: 'Needs visit',
  error: 'Error',
  no_permission: 'No site access',
};

export function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

export function toast(text, ms = 2600) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = el('div', { class: 'toast' }, text);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Only allow http(s) image URLs (product images come from page content). */
export function safeImage(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

export function itemSummary(item, settings) {
  const stats = PS.computeStats(item.history);
  const v = PS.verdict(stats, { goodDealPct: settings ? settings.goodDealPct : 5 });
  const sale = PS.saleCheck(stats.current, item.listPrice, stats);
  const tp = PS.targetPrice(item.target, item.baselinePrice);
  return { stats, verdict: v, sale, targetPrice: tp, atTarget: tp != null && stats.current != null && stats.current <= tp };
}
