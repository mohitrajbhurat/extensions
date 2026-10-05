// Per-bookmark metadata in chrome.storage.local, one key per bookmark ("m:<id>") so that
// concurrent writers (popup, manager, service worker) never clobber each other's records.
// Shape: { tags: string[], suggested?: string[], note?: string, rl?: true, read?: bool,
//          readAt?: number, minutes?: number, words?: number, hasText?: bool }
const PREFIX = 'm:';
export const metaKey = id => PREFIX + id;

function clean(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (v === undefined || v === null || v === false && k !== 'read') continue;
    if (Array.isArray(v) && !v.length) continue;
    if (v === '') continue;
    out[k] = v;
  }
  if (out.read === false && !out.rl) delete out.read;
  return out;
}

export async function getAllMeta() {
  const all = await chrome.storage.local.get(null);
  const map = new Map();
  for (const [k, v] of Object.entries(all)) if (k.startsWith(PREFIX)) map.set(k.slice(PREFIX.length), v);
  return map;
}

export async function getMeta(id) {
  const k = metaKey(id);
  const r = await chrome.storage.local.get(k);
  return r[k] || {};
}

export async function getMetaMany(ids) {
  const keys = ids.map(metaKey);
  const r = keys.length ? await chrome.storage.local.get(keys) : {};
  const map = new Map();
  for (const id of ids) map.set(String(id), r[metaKey(id)] || {});
  return map;
}

export async function setMeta(id, patch) {
  const cur = await getMeta(id);
  const next = clean({ ...cur, ...patch });
  if (Object.keys(next).length) await chrome.storage.local.set({ [metaKey(id)]: next });
  else await chrome.storage.local.remove(metaKey(id));
  return next;
}

// patches: Map|Array<[id, patch | (cur)=>next]>
export async function updateMetaMany(patches) {
  const entries = [...patches];
  if (!entries.length) return;
  const cur = await getMetaMany(entries.map(e => e[0]));
  const set = {}; const remove = [];
  for (const [id, p] of entries) {
    const base = cur.get(String(id)) || {};
    const next = clean(typeof p === 'function' ? p({ ...base }) : { ...base, ...p });
    if (Object.keys(next).length) set[metaKey(id)] = next; else remove.push(metaKey(id));
  }
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (remove.length) await chrome.storage.local.remove(remove);
}

export async function replaceMeta(id, value) {
  const next = clean(value);
  if (Object.keys(next).length) await chrome.storage.local.set({ [metaKey(id)]: next });
  else await chrome.storage.local.remove(metaKey(id));
}

export function deleteMeta(ids) {
  const keys = [].concat(ids).map(metaKey);
  return keys.length ? chrome.storage.local.remove(keys) : Promise.resolve();
}

export function normalizeTag(t) {
  return String(t || '')
    .toLowerCase()
    .trim()
    .replace(/^#+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\-.+#]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function mergeTags(...lists) {
  const out = [];
  for (const l of lists) for (const t of l || []) { const n = normalizeTag(t); if (n && !out.includes(n)) out.push(n); }
  return out;
}

// ---- Settings (chrome.storage.sync) ----
export const DEFAULT_SETTINGS = {
  suggestOnCreate: false,   // fetch + suggest tags for new bookmarks (needs site access)
  saveTextOnSave: true,     // popup default for "save page text"
  saveTextOnCreate: false,  // fetch + store text for new bookmarks (needs site access)
  showBadge: true,
  wpm: 230,
  healthConcurrency: 4,
  healthTimeout: 15,
  healthHostDelay: 1000,
  openReadLaterMarksRead: true
};

export async function getSettings() {
  try {
    const r = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

export const ALL_SITES = { origins: ['http://*/*', 'https://*/*'] };

export async function hasSiteAccess() {
  try { return await chrome.permissions.contains(ALL_SITES); } catch { return false; }
}

// Must be called from a user gesture.
export async function requestSiteAccess() {
  // Call request() synchronously inside the gesture; it resolves true at once when already granted.
  try { return await chrome.permissions.request(ALL_SITES); } catch { return false; }
}
