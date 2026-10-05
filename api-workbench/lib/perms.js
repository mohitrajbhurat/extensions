// Host permission bookkeeping. Kept synchronous so Send can call permissions.request()
// as the very first await inside the click handler (it needs a user gesture).
const granted = { all: false, patterns: [] };
const listeners = new Set();

function update(p) {
  const origins = p.origins || [];
  granted.patterns = origins;
  granted.all = origins.some(o => o === '<all_urls>' || o === '*://*/*');
  listeners.forEach(fn => fn(granted));
}

export async function initPerms() {
  if (!chrome.permissions) return;
  update(await chrome.permissions.getAll());
  const reload = async () => update(await chrome.permissions.getAll());
  chrome.permissions.onAdded.addListener(reload);
  chrome.permissions.onRemoved.addListener(reload);
}

export async function refreshPerms() { if (chrome.permissions) update(await chrome.permissions.getAll()); }

export function onPermsChange(fn) { listeners.add(fn); }
export function hasAllUrls() { return granted.all; }

function matches(pattern, u) {
  if (pattern === '<all_urls>') return true;
  const m = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host] = m;
  const proto = u.protocol.slice(0, -1);
  if (scheme === '*' ? !['http', 'https', 'ws', 'wss'].includes(proto) : scheme !== proto) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) { const base = host.slice(2); return u.hostname === base || u.hostname.endsWith('.' + base); }
  return u.hostname === host.replace(/:\d+$/, '');
}

export function hasOrigin(url) {
  if (granted.all) return true;
  try { const u = new URL(url); return granted.patterns.some(p => matches(p, u)); } catch { return false; }
}

export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Must be called synchronously from a user gesture (no await before it). */
export function requestOrigins(urls) {
  const origins = [...new Set(urls.filter(u => !hasOrigin(u)).map(originPattern))];
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins }).catch(() => false);
}

export function requestAllUrls() { return chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false); }
export function revokeAll() { return chrome.permissions.remove({ origins: granted.patterns.length ? granted.patterns : ['<all_urls>'] }).catch(() => false); }
export function grantedPatterns() { return [...granted.patterns]; }
