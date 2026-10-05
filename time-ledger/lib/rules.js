// Rules map tracked activity (URL, domain, page title) to projects, and
// domains to screen-time categories. Pure functions.

export const CATEGORIES = ['productive', 'neutral', 'distracting'];

export const CATEGORY_META = {
  productive: { label: 'Productive', color: '#16a34a' },
  neutral: { label: 'Neutral', color: '#64748b' },
  distracting: { label: 'Distracting', color: '#dc2626' },
};

// Sensible defaults; users override any domain in Settings or from the Sites list.
export const DEFAULT_CATEGORY_MAP = {
  'github.com': 'productive', 'gitlab.com': 'productive', 'bitbucket.org': 'productive',
  'stackoverflow.com': 'productive', 'stackexchange.com': 'productive', 'developer.mozilla.org': 'productive',
  'docs.google.com': 'productive', 'sheets.google.com': 'productive', 'slides.google.com': 'productive',
  'drive.google.com': 'productive', 'notion.so': 'productive', 'figma.com': 'productive',
  'linear.app': 'productive', 'atlassian.net': 'productive', 'trello.com': 'productive',
  'asana.com': 'productive', 'overleaf.com': 'productive', 'canvas.instructure.com': 'productive',
  'scholar.google.com': 'productive', 'arxiv.org': 'productive', 'wikipedia.org': 'productive',
  'chatgpt.com': 'productive', 'claude.ai': 'productive', 'localhost': 'productive', 'file': 'productive',
  'mail.google.com': 'neutral', 'outlook.live.com': 'neutral', 'outlook.office.com': 'neutral',
  'calendar.google.com': 'neutral', 'slack.com': 'neutral', 'teams.microsoft.com': 'neutral',
  'google.com': 'neutral', 'bing.com': 'neutral', 'duckduckgo.com': 'neutral',
  'youtube.com': 'distracting', 'facebook.com': 'distracting', 'instagram.com': 'distracting',
  'twitter.com': 'distracting', 'x.com': 'distracting', 'reddit.com': 'distracting',
  'tiktok.com': 'distracting', 'netflix.com': 'distracting', 'twitch.tv': 'distracting',
  'primevideo.com': 'distracting', 'disneyplus.com': 'distracting', '9gag.com': 'distracting',
  'pinterest.com': 'distracting', 'tumblr.com': 'distracting', 'news.ycombinator.com': 'distracting',
};

/** Look up a domain (or any parent domain) in user overrides, then defaults. */
export function categoryFor(domain, userMap = {}) {
  if (!domain) return 'neutral';
  const parts = domain.split('.');
  const candidates = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && i === parts.length - 1) break; // never match a bare TLD
    candidates.push(parts.slice(i).join('.'));
  }
  for (const map of [userMap || {}, DEFAULT_CATEGORY_MAP]) {
    for (const d of candidates) if (CATEGORIES.includes(map[d])) return map[d];
  }
  return 'neutral';
}

/** Escape regex specials except '*', which becomes '.*'. */
function globToRegex(glob) {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}

/** Strip protocol and leading www. so patterns can be written naturally. */
export function bareUrl(url) {
  return String(url || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '');
}

/** Infer the rule kind from a pattern when the user picked "auto". */
export function inferKind(pattern) {
  const p = String(pattern || '').trim();
  if (p.includes('/')) return 'url';
  if (/^[\w*-]+(\.[\w*-]+)+$/.test(p) || p === 'localhost') return 'domain';
  return 'title';
}

/**
 * rule: { pattern, kind: 'auto'|'domain'|'url'|'title', projectId, enabled? }
 * activity: { url, domain, title }
 */
export function matchRule(rule, activity) {
  if (!rule || rule.enabled === false) return false;
  const pattern = String(rule.pattern || '').trim();
  if (!pattern) return false;
  const kind = !rule.kind || rule.kind === 'auto' ? inferKind(pattern) : rule.kind;
  if (kind === 'domain') {
    const p = pattern.toLowerCase().replace(/^www\./, '');
    const domain = String(activity.domain || '').toLowerCase();
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return domain === base || domain.endsWith('.' + base);
    }
    if (p.includes('*')) return globToRegex(p).test(domain);
    return domain === p || domain.endsWith('.' + p);
  }
  if (kind === 'url') {
    const p = bareUrl(pattern.toLowerCase());
    const u = bareUrl(String(activity.url || '').toLowerCase());
    // "github.com/acme" should also match "github.com/acme/repo".
    const re = globToRegex(p.endsWith('*') ? p : p.replace(/\/$/, '') + '*');
    return re.test(u);
  }
  if (kind === 'title') {
    const keywords = pattern.toLowerCase().split(',').map((k) => k.trim()).filter(Boolean);
    const title = String(activity.title || '').toLowerCase();
    return keywords.some((k) => title.includes(k));
  }
  return false;
}

/** First matching rule's project id, or null. Rules are evaluated in order. */
export function projectFor(activity, rules = []) {
  for (const r of rules) if (matchRule(r, activity)) return r.projectId || null;
  return null;
}

/** Effective project for a stored segment: explicit assignment wins over rules. */
export function segmentProject(seg, rules) {
  if (seg.p !== undefined && seg.p !== null) return seg.p === '' ? null : seg.p;
  return projectFor(seg, rules);
}
