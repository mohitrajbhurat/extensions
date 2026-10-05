// Serialized read-modify-write access to chrome.storage, used only by the service worker.
// UI pages read storage directly and send messages to the worker for every write.
import { DEFAULT_SETTINGS } from './util.js';

const chains = new Map();

/** Run fn exclusively for a given lock name. */
export function withLock(name, fn) {
  const prev = chains.get(name) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(name, next.catch(() => {}));
  return next;
}

export async function get(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}

export function set(key, value) { return chrome.storage.local.set({ [key]: value }); }

/** Atomically update a local storage key. fn receives the current value and returns the new one (or mutates it). */
export function update(key, fallback, fn) {
  return withLock('local:' + key, async () => {
    const cur = await get(key, structuredClone(fallback));
    const res = await fn(cur);
    const value = res === undefined ? cur : res;
    await set(key, value);
    return value;
  });
}

export async function sget(key, fallback) {
  const r = await chrome.storage.session.get(key);
  return r[key] === undefined ? fallback : r[key];
}
export function sset(key, value) { return chrome.storage.session.set({ [key]: value }); }
export function supdate(key, fallback, fn) {
  return withLock('session:' + key, async () => {
    const cur = await sget(key, structuredClone(fallback));
    const res = await fn(cur);
    const value = res === undefined ? cur : res;
    await sset(key, value);
    return value;
  });
}

let settingsCache = null;
export async function getSettings() {
  if (!settingsCache) settingsCache = { ...DEFAULT_SETTINGS, ...(await get('settings', {})) };
  return settingsCache;
}
export function invalidateSettings() { settingsCache = null; }
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settingsCache = null;
});
