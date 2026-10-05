// Small shared helpers for the service worker modules.

/** URL for display and matching: no scheme, no "www.", no trailing slash. */
export function prettyUrl(url) {
  if (!url) return '';
  let s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (s.endsWith('/') && s.indexOf('/') === s.length - 1) s = s.slice(0, -1);
  return s.length > 300 ? s.slice(0, 300) : s;
}

/** URL key used for deduplication and frecency (ignores hash and trailing slash). */
export function urlKey(url) {
  if (!url) return '';
  return url.replace(/#.*$/, '').replace(/\/$/, '');
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

export function originOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch (e) { return ''; }
}

/** Is this string something we should treat as a URL to open directly? */
export function looksLikeUrl(q) {
  q = q.trim();
  if (!q || /\s/.test(q)) return false;
  if (/^(https?|file|ftp|chrome|edge|brave|about|view-source):/i.test(q)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(q)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(q)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}(:\d+)?(\/\S*)?$/i.test(q);
}

export function normalizeUrl(q) {
  q = q.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(q) && !/^localhost:/i.test(q)) return q;
  return (/^(localhost|\d{1,3}(\.\d{1,3}){3})/i.test(q) ? 'http://' : 'https://') + q;
}

/** Pages extensions can never script (palette falls back to a popup window there). */
export function isRestrictedUrl(url) {
  if (!url) return true;
  if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|devtools|view-source|chrome-search|chrome-untrusted):/i.test(url)) return true;
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url)) return true;
  return false;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60; if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24; if (d < 30) return Math.floor(d) + 'd ago';
  const mo = d / 30; if (mo < 12) return Math.floor(mo) + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}
