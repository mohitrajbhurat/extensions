// Settings, custom commands and quicklinks. Stored in chrome.storage.sync (small, synced
// across the user's browsers) with a fallback to chrome.storage.local if sync is
// unavailable or over quota.

export const DEFAULT_COMMANDS = [
  { id: 'google', name: 'Google', keyword: 'g', url: 'https://www.google.com/search?q={query}', fallback: true },
  { id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://www.youtube.com/results?search_query={query}', fallback: true },
  { id: 'wikipedia', name: 'Wikipedia', keyword: 'w', url: 'https://en.wikipedia.org/w/index.php?search={query}', fallback: true },
  { id: 'github', name: 'GitHub', keyword: 'gh', url: 'https://github.com/search?q={query}', fallback: true },
  { id: 'duckduckgo', name: 'DuckDuckGo', keyword: 'ddg', url: 'https://duckduckgo.com/?q={query}', fallback: false },
  { id: 'stackoverflow', name: 'Stack Overflow', keyword: 'so', url: 'https://stackoverflow.com/search?q={query}', fallback: false },
  { id: 'mdn', name: 'MDN Web Docs', keyword: 'mdn', url: 'https://developer.mozilla.org/en-US/search?q={query}', fallback: false },
  { id: 'maps', name: 'Google Maps', keyword: 'maps', url: 'https://www.google.com/maps/search/{query}', fallback: false },
  { id: 'translate', name: 'Google Translate', keyword: 'tr', url: 'https://translate.google.com/?sl=auto&tl=en&text={query}', fallback: false },
];

export const DEFAULT_QUICKLINKS = [];

export const DEFAULT_SETTINGS = {
  theme: 'auto',                 // auto | light | dark
  enterOpens: 'current',         // current | new  (Shift+Enter does the opposite)
  preferPopup: false,            // always open the palette in a popup window
  sources: { tabs: true, closed: true, bookmarks: true, history: true, actions: true },
  historyMax: 3000,              // history entries indexed for fuzzy search
  historyDays: 90,
  maxResults: 50,
  learn: true,                   // frecency learning from picks
};

const KEYS = ['settings', 'customCommands', 'quicklinks'];

async function rawGet() {
  let data = {};
  try { data = await chrome.storage.sync.get(KEYS); } catch (e) { /* sync unavailable */ }
  let local = {};
  try { local = await chrome.storage.local.get(KEYS.map(k => 'fallback_' + k)); } catch (e) { /* ignore */ }
  for (const k of KEYS) {
    if (local['fallback_' + k] !== undefined) data[k] = local['fallback_' + k];
  }
  return data;
}

export async function loadAll() {
  const data = await rawGet();
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  settings.sources = { ...DEFAULT_SETTINGS.sources, ...((data.settings && data.settings.sources) || {}) };
  return {
    settings,
    customCommands: Array.isArray(data.customCommands) ? data.customCommands : DEFAULT_COMMANDS.map(c => ({ ...c })),
    quicklinks: Array.isArray(data.quicklinks) ? data.quicklinks : DEFAULT_QUICKLINKS.slice(),
  };
}

/** Save one of 'settings' | 'customCommands' | 'quicklinks'. */
export async function save(key, value) {
  if (!KEYS.includes(key)) throw new Error('Unknown settings key ' + key);
  try {
    await chrome.storage.sync.set({ [key]: value });
    await chrome.storage.local.remove('fallback_' + key);
    return { synced: true };
  } catch (e) {
    await chrome.storage.local.set({ ['fallback_' + key]: value });
    return { synced: false, reason: String(e && e.message || e) };
  }
}

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Fill a URL template. {query} is URL-encoded, {raw} is inserted verbatim. */
export function fillTemplate(template, query) {
  return template
    .replace(/\{query\}/g, encodeURIComponent(query))
    .replace(/%s/g, encodeURIComponent(query))
    .replace(/\{raw\}/g, query);
}

export function templateHasQuery(template) {
  return /\{query\}|\{raw\}|%s/.test(template);
}
