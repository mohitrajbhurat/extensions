// URL helpers: normalization for duplicate detection, display helpers.
const TRACKING_PREFIX = /^(utm_|mc_|_hs|hsa_|pk_|piwik_|matomo_|oly_|ga_)/i;
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'igshid', 'ref_src', 'ref_url',
  '_ga', '_gl', 'mkt_tok', 'spm', 'vero_id', 'rb_clickid', 's_cid', 'ncid', 'cmpid', 'twclid', 'ttclid',
  'li_fat_id', 'srsltid', 'trk', 'trkcampaign', 'sc_campaign', 'feature', 'si'
]);

export function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || ''));
}

// Returns a comparable key: scheme-less, www-less, no tracking params, sorted query,
// no trailing slash, no default index file, fragment dropped unless it looks like a SPA route.
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(s); } catch { return s.toLowerCase(); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s.toLowerCase();
  let host = u.hostname.toLowerCase().replace(/^www\d*\./, '').replace(/\.$/, '');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) host += ':' + u.port;
  let path = u.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/index\.(html?|php|aspx?)$/i, '/');
  try { path = decodeURI(path); } catch { /* keep encoded */ }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';
  const params = [];
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PREFIX.test(k) || TRACKING_EXACT.has(k.toLowerCase())) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
  const query = params.length ? '?' + params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : '';
  const hash = /^#!?\//.test(u.hash) ? u.hash : '';
  return host + path + query + hash;
}

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function originPattern(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.hostname}/*`; } catch { return null; }
}

export function prettyUrl(u) {
  try {
    const x = new URL(u);
    let p = x.hostname.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname) + x.search;
    return p.length > 90 ? p.slice(0, 87) + '…' : p;
  } catch { return String(u || ''); }
}

export function faviconUrl(pageUrl, size = 32) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}
