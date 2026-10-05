// Settings and user lists in chrome.storage.local. Content scripts read the same keys
// directly (they cannot import modules), so key names here are part of the contract
// with content/consent.js.

import { CATEGORY_IDS } from './trackers.js';

export const COOKIE_MODES = ['reject', 'accept', 'hide', 'off'];

export const DEFAULT_SETTINGS = Object.freeze({
  categories: Object.freeze(Object.fromEntries(CATEGORY_IDS.map((c) => [c, true]))),
  stripParams: true,
  gpc: true,
  cookieMode: 'reject', // reject | accept | hide | off
  learning: true,
  autoBlockLearned: false,
  learnThreshold: 3,
  showBadge: true,
});

export const KEYS = {
  settings: 'settings',
  allowlist: 'allowlist', // string[] of hosts where protection is off
  trusted: 'trustedDomains', // string[] of third-party domains never blocked
  userBlocked: 'userBlocked', // string[] of third-party domains always blocked
  learned: 'learned', // { [domain]: { sites: string[], first: ms, last: ms, blocked?: bool, ignored?: bool } }
  stats: 'stats', // { days: { 'YYYY-MM-DD': DayStats }, since: ms }
  sites: 'sites', // { [host]: SiteRecord }
};

export function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  s.categories = { ...DEFAULT_SETTINGS.categories, ...((stored && stored.categories) || {}) };
  if (!COOKIE_MODES.includes(s.cookieMode)) s.cookieMode = DEFAULT_SETTINGS.cookieMode;
  const t = Number(s.learnThreshold);
  s.learnThreshold = Number.isFinite(t) ? Math.min(10, Math.max(2, Math.round(t))) : DEFAULT_SETTINGS.learnThreshold;
  return s;
}

export async function getSettings() {
  const { [KEYS.settings]: stored } = await chrome.storage.local.get(KEYS.settings);
  return mergeSettings(stored);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    categories: { ...current.categories, ...((patch && patch.categories) || {}) },
  });
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function getList(key) {
  const { [key]: list } = await chrome.storage.local.get(key);
  return Array.isArray(list) ? list : [];
}

export async function setList(key, list) {
  const clean = [...new Set(list.filter(Boolean))].sort();
  await chrome.storage.local.set({ [key]: clean });
  return clean;
}

export function dayKey(time = Date.now()) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
