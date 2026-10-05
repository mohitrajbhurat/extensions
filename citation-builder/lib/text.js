// Text helpers: escaping, casing, dates, punctuation. Pure functions, no DOM.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Last visible character of an HTML fragment (ignores tags and closing quotes). */
function lastChar(html) {
  const t = htmlToText(html).replace(/[\s”’"']+$/, '');
  return t.slice(-1);
}

/** Append punctuation unless the fragment already ends in terminal punctuation. */
export function punct(html, p = '.') {
  if (!html) return html;
  const c = lastChar(html);
  if (p === '.' && /[.?!]/.test(c)) return html;
  if ((p === ',' || p === ':' || p === ';') && /[?!]/.test(c)) return html;
  return html + p;
}

export function italic(html) {
  return html ? `<i>${html}</i>` : '';
}

/** Wrap in quotes, placing the given punctuation inside (American style) unless the title already ends with ?/!. */
export function quoted(html, p = '', open = '“', close = '”') {
  if (!html) return '';
  let inner = html;
  if (p) {
    const c = lastChar(html);
    if (!/[?!]/.test(c) && !(p === '.' && c === '.')) inner += p;
  }
  return `${open}${inner}${close}`;
}

// ---------- casing ----------

const MINOR_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'off', 'on',
  'per', 'to', 'up', 'via', 'vs', 'vs.', 'v.', 'from', 'into', 'onto', 'over', 'with', 'upon', 'than', 'like',
  'near', 'past', 'down', 'out', 'about', 'after', 'among', 'before', 'between', 'during', 'through', 'under',
  'within', 'without', 'against', 'along', 'around', 'behind', 'below', 'beneath', 'beside', 'beyond', 'despite',
  'except', 'inside', 'outside', 'since', 'toward', 'towards', 'until', 'amid', 'across', 'beside', 'en', 'de',
]);

const LEADING = /^[\s"'“‘(\[{¿¡-]*/;

function isAllCaps(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters.length > 3 && letters === letters.toUpperCase();
}

function hasInnerCaps(word) {
  // iPhone, McDonald, eBay, DNA, COVID-19, U.S.
  const core = word.replace(LEADING, '');
  return core.split('-').some(p => /[A-Z]/.test(p.slice(1))) || /\d/.test(core) || /\.[A-Za-z]/.test(core);
}

export function capFirst(word) {
  const lead = word.match(LEADING)[0];
  const rest = word.slice(lead.length);
  return lead + rest.charAt(0).toUpperCase() + rest.slice(1);
}

function splitTokens(title) {
  return String(title).split(/(\s+)/);
}

const BREAK_AFTER = /[:.?!—]["'”’)]*$/;

/** Headline-style title case (Chicago / MLA). Preserves acronyms and words with inner capitals. */
export function titleCase(title) {
  if (!title) return '';
  let src = collapse(title);
  if (isAllCaps(src)) src = src.toLowerCase();
  const tokens = splitTokens(src);
  const wordIdx = [];
  tokens.forEach((t, i) => { if (t.trim()) wordIdx.push(i); });
  wordIdx.forEach((ti, n) => {
    const w = tokens[ti];
    const prev = n > 0 ? tokens[wordIdx[n - 1]] : '';
    const first = n === 0 || BREAK_AFTER.test(prev);
    const last = n === wordIdx.length - 1;
    if (hasInnerCaps(w) || /^https?:/i.test(w)) return;
    const parts = w.split('-');
    tokens[ti] = parts.map((p, pi) => {
      if (!p) return p;
      if (hasInnerCaps(p)) return p;
      const bare = p.replace(LEADING, '').replace(/[^A-Za-z.']+$/, '').toLowerCase();
      const isEdge = (pi === 0 && first) || (pi === parts.length - 1 && last);
      if (MINOR_WORDS.has(bare) && !isEdge) {
        return p.toLowerCase();
      }
      return capFirst(p);
    }).join('-');
  });
  return tokens.join('');
}

/** Heuristic: does the title look like it is already in headline case? */
export function looksTitleCased(title) {
  const words = collapse(title).split(' ').slice(1).filter(w => /^[A-Za-z][a-z]{3,}/.test(w.replace(LEADING, '')));
  if (words.length < 2) {
    const all = collapse(title).split(' ').slice(1).filter(w => /^[A-Za-z]/.test(w) && !MINOR_WORDS.has(w.toLowerCase()));
    return all.length > 0 && all.every(w => /^[A-Z]/.test(w));
  }
  const capped = words.filter(w => /^[A-Z]/.test(w.replace(LEADING, ''))).length;
  return capped / words.length >= 0.6;
}

/**
 * Sentence case (APA). Lower-cases plain Capitalized words except the first word and the first word
 * after a colon; keeps acronyms and words with inner capitals. Only converts titles that look
 * headline-cased so already sentence-cased titles keep their proper nouns.
 */
export function sentenceCase(title, { force = false } = {}) {
  if (!title) return '';
  let src = collapse(title);
  const allCaps = isAllCaps(src);
  if (allCaps) src = src.toLowerCase();
  else if (!force && !looksTitleCased(src)) return capFirst(src);
  const tokens = splitTokens(src);
  let first = true;
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (!w.trim()) continue;
    if (first) {
      tokens[i] = hasInnerCaps(w) ? w : capFirst(w);
    } else if (!hasInnerCaps(w) && w !== 'I' && !/^I'/.test(w)) {
      tokens[i] = w.split('-').map(p => (hasInnerCaps(p) ? p : p.toLowerCase())).join('-');
    }
    first = BREAK_AFTER.test(w);
  }
  return tokens.join('');
}

/**
 * A short title for in-text citations and short notes: the main title (before a colon), at most
 * `max` words, without a leading article or trailing minor words.
 */
export function shortTitle(title, max = 4) {
  const t = collapse(title).split(/[:?!]\s|\.\s/)[0];
  let words = t.split(' ');
  if (words.length > max) {
    if (/^(the|a|an)$/i.test(words[0])) words = words.slice(1);
    words = words.slice(0, max);
    while (words.length > 1 && MINOR_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  }
  return words.join(' ');
}

// ---------- dates ----------

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_LOOKUP = {};
MONTHS.forEach((m, i) => {
  MONTH_LOOKUP[m.toLowerCase()] = i + 1;
  MONTH_LOOKUP[m.slice(0, 3).toLowerCase()] = i + 1;
});
MONTH_LOOKUP.sept = 9;

/** Parse many date shapes into {y, m, d} (m and d optional). Returns null when no year found. */
export function parseDate(input) {
  if (!input) return null;
  const s = collapse(String(input));
  let m;
  // ISO / numeric: 2020-03-05, 2020/03/05, 2020-03, 2020.03.05, 2020-03-05T10:00:00Z
  if ((m = s.match(/^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?:[T\s].*)?$/))) {
    return mk(+m[1], m[2] && +m[2], m[3] && +m[3]);
  }
  // 20200305
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return mk(+m[1], +m[2], +m[3]);
  // March 5, 2020 / Mar. 5 2020 / March 2020
  if ((m = s.match(/^([A-Za-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})\b/))) {
    const mo = MONTH_LOOKUP[m[1].toLowerCase()];
    if (mo) return mk(+m[3], mo, m[2] && +m[2]);
  }
  // 5 March 2020 / 5 Mar. 2020
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})\b/))) {
    const mo = MONTH_LOOKUP[m[2].toLowerCase()];
    if (mo) return mk(+m[3], mo, +m[1]);
  }
  // 03/05/2020 (US) or 05.03.2020 (EU, dot separated)
  if ((m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/))) {
    if (m[2] === '.') return mk(+m[4], +m[3], +m[1]);
    return mk(+m[4], +m[1], +m[3]);
  }
  // Weekday, 05 Mar 2020 10:00:00 GMT (RFC 2822)
  if ((m = s.match(/^[A-Za-z]{3},?\s+(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/))) {
    const mo = MONTH_LOOKUP[m[2].toLowerCase()];
    if (mo) return mk(+m[3], mo, +m[1]);
  }
  // Fallback: any 4-digit year in a plausible range
  if ((m = s.match(/\b(1[5-9]\d{2}|20\d{2})\b/))) return mk(+m[1]);
  return null;
}

function mk(y, m, d) {
  if (!y || y < 1000 || y > 2999) return null;
  const out = { y };
  if (m && m >= 1 && m <= 12) {
    out.m = m;
    if (d && d >= 1 && d <= 31) out.d = d;
  }
  return out;
}

const pad = n => String(n).padStart(2, '0');

/** Normalize to YYYY, YYYY-MM or YYYY-MM-DD. Unparseable input is returned trimmed. */
export function normalizeDate(input) {
  const p = parseDate(input);
  if (!p) return collapse(input || '');
  return p.y + (p.m ? '-' + pad(p.m) + (p.d ? '-' + pad(p.d) : '') : '');
}

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const IEEE_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

/**
 * Format a date for a style.
 *  'apa'   -> 2020, March 5
 *  'mla'   -> 5 Mar. 2020
 *  'us'    -> March 5, 2020
 *  'uk'    -> 5 March 2020
 *  'ieee'  -> Mar. 5, 2020
 */
export function formatDate(input, kind) {
  const p = typeof input === 'object' && input ? input : parseDate(input);
  if (!p) return '';
  const { y, m, d } = p;
  if (!m) return String(y);
  switch (kind) {
    case 'apa': return `${y}, ${MONTHS[m - 1]}${d ? ' ' + d : ''}`;
    case 'mla': return `${d ? d + ' ' : ''}${MLA_MONTHS[m - 1]} ${y}`;
    case 'uk': return `${d ? d + ' ' : ''}${MONTHS[m - 1]} ${y}`;
    case 'ieee': return `${IEEE_MONTHS[m - 1]}${d ? ' ' + d + ',' : ''} ${y}`;
    case 'us':
    default: return `${MONTHS[m - 1]}${d ? ' ' + d + ',' : ''} ${y}`;
  }
}

export function yearOf(input) {
  const p = parseDate(input);
  return p ? String(p.y) : '';
}

// ---------- misc ----------

/** "45-67" -> "45–67" (en dash). */
export function pageRange(pages, dash = '–') {
  return collapse(pages).replace(/\s*(?:-+|–|—)\s*/g, dash);
}

export function ordinal(n) {
  const s = String(n).trim();
  if (!/^\d+$/.test(s)) return s;
  const v = +s % 100;
  const suf = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[+s % 10] || 'th');
  return s + suf;
}

/** Strip protocol for MLA-style URLs. */
export function bareUrl(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export function joinNonEmpty(parts, sep) {
  return parts.filter(Boolean).join(sep);
}
