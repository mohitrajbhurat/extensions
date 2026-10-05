// Shared, side-effect-free helpers used by the service worker and the UI pages.

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// Hex values that approximate Chrome's tab group colors (used for UI swatches).
export const COLOR_HEX = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#fa903e',
};

export const DEFAULT_SETTINGS = {
  // Workspaces
  keepPinnedOnSwitch: true,
  stashUnsavedOnSwitch: true,
  lazyRestore: true,            // discard background tabs right after restoring
  autosaveWorkspaces: true,
  // Stash
  removeFromStashOnRestore: true,
  stashIncludePinned: false,
  // Sessions
  sessionsEnabled: true,
  sessionIntervalMin: 15,
  sessionMaxCount: 40,
  // Memory saver
  memoryEnabled: true,
  idleMinutes: 30,
  neverDiscardPinned: true,
  protectForms: true,           // only effective once the optional host permission is granted
  whitelist: [],                // domains or URL patterns
  // Duplicates
  duplicateMode: 'notify',      // 'off' | 'notify' | 'auto'
  duplicateScope: 'window',     // 'window' | 'all'
  dupIgnoreHash: true,
  dupIgnoreTracking: true,
  // Auto-grouping
  groupingEnabled: true,
  regroupGrouped: false,
  // Archive
  archiveEnabled: true,
  archiveMax: 5000,
  // Badge
  badgeMode: 'total',           // 'total' | 'window' | 'off'
  badgeWarnAt: 50,
};

export function uid(prefix = '') {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + r[0].toString(36) + r[1].toString(36).slice(0, 4);
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src)$/i;

/** Canonical form of a URL for duplicate detection. Returns '' for URLs that should never be considered. */
export function normalizeUrl(url, { ignoreHash = true, ignoreTracking = true } = {}) {
  if (!url) return '';
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (!/^(https?|file|ftp):$/.test(u.protocol)) return '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (ignoreHash) u.hash = '';
  if (ignoreTracking) {
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  const s = u.toString();
  return s;
}

/** URLs that chrome.tabs.create can open from an extension. */
export function isRestorableUrl(url) {
  if (!url) return false;
  return /^(https?|ftp|file|chrome|edge|brave|about|data|chrome-extension|view-source):/i.test(url) &&
    !/^chrome:\/\/(kill|hang|crash|quit|restart)/i.test(url);
}

/** URLs worth keeping in stashes, archive and sessions (skip blank new tab pages). */
export function isMeaningfulUrl(url) {
  if (!url) return false;
  return !/^(chrome|edge|brave):\/\/(newtab|new-tab-page)\/?$/i.test(url) && url !== 'about:blank' &&
    !/^chrome-search:/i.test(url);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Pattern matching used by grouping rules and the memory saver whitelist. */
export function matchPattern(url, pattern, type = 'auto') {
  if (!url || !pattern) return false;
  pattern = pattern.trim();
  if (type === 'auto') {
    if (/^\/.+\/[a-z]*$/i.test(pattern)) type = 'regex';
    else if (pattern.includes('*')) type = 'wildcard';
    else if (!pattern.includes('/') && pattern.includes('.')) type = 'domain';
    else type = 'contains';
  }
  try {
    switch (type) {
      case 'domain': {
        const h = hostOf(url).toLowerCase();
        const d = pattern.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
        return h === d || h.endsWith('.' + d);
      }
      case 'contains': return url.toLowerCase().includes(pattern.toLowerCase());
      case 'wildcard': {
        const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
        return re.test(url) || re.test(url.replace(/^https?:\/\//, ''));
      }
      case 'regex': {
        const m = pattern.match(/^\/(.+)\/([a-z]*)$/i);
        const re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern, 'i');
        return re.test(url);
      }
    }
  } catch { return false; }
  return false;
}

/**
 * Fuzzy match: every character of the query must appear in order. Returns a score
 * (higher is better) or -1. Rewards contiguous runs, word starts and early matches.
 */
export function fuzzyScore(query, text) {
  if (!query) return 0;
  if (!text) return -1;
  const q = query.toLowerCase(), t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx + (idx === 0 || /\W/.test(t[idx - 1]) ? 200 : 0) + q.length * 10;
  // Subsequence match: after a gap, the next character must start a word (or a camelCase hump),
  // which keeps "gh pr" -> "GitHub pull request" while rejecting scattered letters.
  const orig = String(text);
  const boundary = k => k === 0 || /[\W_]/.test(t[k - 1]) ||
    (orig[k] !== t[k] && orig[k - 1] === t[k - 1] && /[a-z]/.test(orig[k - 1])) || (/\d/.test(t[k]) !== /\d/.test(t[k - 1]));
  let score = 0, ti = 0, run = 0, first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') { run = 0; continue; }
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue;
      if ((k === ti && run > 0) || boundary(k)) { found = k; break; }
    }
    if (found < 0) return -1;
    if (first < 0) first = found;
    if (found === ti && run > 0) { run++; score += 5 * run; } else { run = 1; score += 1; }
    if (boundary(found)) score += 8;
    ti = found + 1;
  }
  return score - Math.min(first, 50) * 0.5 - (t.length - q.length) * 0.01;
}

/** Multi-word fuzzy search over items; fields picks searchable strings. */
export function fuzzyFilter(items, query, fields, limit = Infinity) {
  query = (query || '').trim();
  if (!query) return items.slice(0, limit);
  const words = query.split(/\s+/);
  const out = [];
  for (const it of items) {
    const hay = fields(it);
    let total = 0, ok = true;
    for (const w of words) {
      let best = -1;
      for (const h of hay) best = Math.max(best, fuzzyScore(w, h || ''));
      if (best < 0) { ok = false; break; }
      total += best;
    }
    if (ok) out.push({ it, total });
  }
  out.sort((a, b) => b.total - a.total);
  return out.slice(0, limit).map(o => o.it);
}

/**
 * Parse OneTab export text. Format: one "url | title" per line, blank lines separate
 * groups. Returns [{tabs:[{url,title}]}].
 */
export function parseOneTab(text) {
  const groups = [];
  let cur = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { if (cur.length) { groups.push({ tabs: cur }); cur = []; } continue; }
    const m = line.match(/^(\S+?)\s*\|\s*(.*)$/) || line.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const url = m[1];
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
    cur.push({ url, title: (m[2] || '').trim() || url });
  }
  if (cur.length) groups.push({ tabs: cur });
  return groups;
}

export function toOneTab(stashes) {
  return stashes.map(s => s.tabs.map(t => `${t.url} | ${t.title || t.url}`).join('\n')).join('\n\n') + '\n';
}

export function relTime(ts, now = Date.now()) {
  const d = Math.round((now - ts) / 1000);
  if (d < 45) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  if (d < 86400 * 7) return Math.round(d / 86400) + ' d ago';
  return new Date(ts).toLocaleDateString();
}

export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function plural(n, word, pl = word + 's') { return `${n} ${n === 1 ? word : pl}`; }

/** Favicon URL that works offline in extension pages (Chrome's _favicon API needs the "favicon" permission). */
export function faviconFor(url, size = 16) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`);
    }
  } catch {}
  return '';
}
