// Small shared helpers (no DOM dependencies, usable in the service worker).

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src|si)$/i;

/** Canonical form of a URL used as the page identity: drops tracking params and non-route hashes. */
export function normalizeUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  // Keep hash routes used by single page apps (#/path or #!/path), drop plain anchors.
  if (!/^#!?\//.test(u.hash)) u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (s.endsWith('?')) s = s.slice(0, -1);
  return s;
}

export function hostOf(href) {
  try { return new URL(href).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/** Normalize a user supplied exclusion rule: "https://www.Foo.com/bar/" -> "foo.com/bar". */
export function cleanRule(rule) {
  let r = String(rule || '').trim().toLowerCase();
  if (!r) return '';
  r = r.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\/+$/, '');
  return r;
}

/** True when url matches any rule ("domain.com" covers subdomains, "domain.com/path" a path prefix). */
export function isExcluded(href, rules) {
  if (!rules || !rules.length) return false;
  let u;
  try { u = new URL(href); } catch { return false; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname.toLowerCase();
  for (const raw of rules) {
    const r = cleanRule(raw);
    if (!r) continue;
    const slash = r.indexOf('/');
    const d = slash === -1 ? r : r.slice(0, slash);
    const p = slash === -1 ? '' : r.slice(slash);
    if (host === d || host.endsWith('.' + d)) {
      if (!p || path.startsWith(p)) return true;
    }
  }
  return false;
}

export function domainMatches(domain, site) {
  site = cleanRule(site).split('/')[0];
  return domain === site || domain.endsWith('.' + site);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

export function startOfDay(t = Date.now()) {
  const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime();
}

const DAY = 86400000;

/** Resolve a named range to [from, to] epoch ms (to exclusive). */
export function dateRange(name, custom) {
  const today = startOfDay();
  switch (name) {
    case 'today': return [today, Infinity];
    case 'yesterday': return [today - DAY, today];
    case 'week': return [today - 6 * DAY, Infinity];
    case 'month': return [today - 29 * DAY, Infinity];
    case 'year': return [today - 364 * DAY, Infinity];
    case 'custom': {
      const from = custom && custom.from ? new Date(custom.from + 'T00:00:00').getTime() : 0;
      const to = custom && custom.to ? new Date(custom.to + 'T00:00:00').getTime() + DAY : Infinity;
      return [isNaN(from) ? 0 : from, isNaN(to) ? Infinity : to];
    }
    default: return [0, Infinity];
  }
}

export function dayLabel(t) {
  const d0 = startOfDay(t), today = startOfDay();
  if (d0 === today) return 'Today';
  if (d0 === today - DAY) return 'Yesterday';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function timeLabel(t) {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function relativeTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < DAY / 1000) return Math.floor(s / 3600) + ' h ago';
  const days = Math.floor(s / 86400);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  return new Date(t).toLocaleDateString();
}

export function faviconUrl(pageUrl, size = 32) {
  try {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', pageUrl);
    u.searchParams.set('size', String(size));
    return u.toString();
  } catch { return ''; }
}
