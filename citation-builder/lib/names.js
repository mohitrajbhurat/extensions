// Personal / organizational name parsing and formatting.
import { collapse } from './text.js';

const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'ter', 'ten', 'bin', 'ibn', 'al', 'el', 'st.', 'zu', "d'", 'op']);
const SUFFIXES = /^(jr\.?|sr\.?|ii|iii|iv|v|phd|ph\.d\.|md|m\.d\.)$/i;
const ORG_WORDS = /\b(university|universit[äé]|college|school|institute|institution|association|organi[sz]ation|society|council|committee|agency|foundation|department|ministry|office|bureau|commission|board|centre|center|corporation|company|inc\.?|ltd\.?|llc|gmbh|group|team|staff|news|press|editors|editorial|network|project|consortium|alliance|federation|union|government|library|museum|hospital|clinic|laboratory|labs?|service|services|authority|administration|nations|world health|wikipedia|contributors)\b/i;
const TITLES = /^(dr|prof|professor|mr|mrs|ms|miss|sir|dame|rev|hon)\.?\s+/i;

/** Heuristic: does this string look like an organization rather than a person? */
export function looksLikeOrg(s) {
  const t = collapse(s);
  if (!t) return false;
  if (ORG_WORDS.test(t)) return true;
  if (/[&@]|\d/.test(t)) return true;
  const words = t.split(' ');
  if (words.length > 5) return true;
  return false;
}

/**
 * Parse a name string into {given, family, suffix?} or {literal} for organizations.
 * Handles "Family, Given", "Given Family", particles ("Ludwig van Beethoven"),
 * suffixes ("Martin Luther King Jr.") and PubMed style ("Smith JA").
 */
export function parseName(input, { allowOrg = true } = {}) {
  if (input && typeof input === 'object') return cleanName(input);
  let s = collapse(String(input || ''))
    .replace(/^by\s+/i, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+(et al\.?)$/i, '')
    .trim();
  s = s.replace(TITLES, '');
  if (!s) return null;
  if (allowOrg && looksLikeOrg(s)) return { literal: s };

  // "Family, Given" or "Family, Given, Jr."
  if (s.includes(',')) {
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // "Martin Luther King, Jr." style: suffix after comma
      if (SUFFIXES.test(parts[1]) && parts.length === 2) {
        const base = parseName(parts[0], { allowOrg: false });
        if (base && !base.literal) return { ...base, suffix: parts[1] };
      }
      const out = { family: parts[0], given: parts[1] };
      if (parts[2] && SUFFIXES.test(parts[2])) out.suffix = parts[2];
      return cleanName(out);
    }
  }

  const words = s.split(' ');
  if (words.length === 1) return { family: words[0], given: '' };

  let suffix = '';
  if (SUFFIXES.test(words[words.length - 1]) && words.length > 2) suffix = words.pop();

  // PubMed / Vancouver style: "Smith JA"
  const lastW = words[words.length - 1];
  if (words.length === 2 && /^[A-Z]{1,3}$/.test(lastW) && /^[A-Z][a-z'-]+/.test(words[0])) {
    return cleanName({ family: words[0], given: lastW.split('').join('. ') + '.', suffix });
  }

  // Family name = last word plus any lowercase particles directly before it.
  let i = words.length - 1;
  while (i - 1 > 0 && PARTICLES.has(words[i - 1].toLowerCase())) i--;
  return cleanName({ given: words.slice(0, i).join(' '), family: words.slice(i).join(' '), suffix });
}

function cleanName(n) {
  if (!n) return null;
  if (n.literal) return { literal: collapse(n.literal) };
  const out = { given: collapse(n.given || ''), family: collapse(n.family || '') };
  if (n.suffix) out.suffix = collapse(n.suffix);
  if (!out.family && !out.given) return null;
  if (!out.family) { out.family = out.given; out.given = ''; }
  // Fix ALL-CAPS family names (common in metadata): SMITH -> Smith
  if (out.family.length > 2 && out.family === out.family.toUpperCase() && /[A-Z]/.test(out.family)) {
    out.family = out.family.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return out;
}

/** Split a string containing several names ("A and B", "A; B", "A, B, and C", "Smith, J., Doe, K."). */
export function splitNames(input) {
  const s = collapse(String(input || '')).replace(/^by\s+/i, '');
  if (!s) return [];
  if (s.includes(';')) return s.split(';').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const part of s.split(/\s*,?\s+(?:and|&)\s+/i)) {
    const cp = part.split(/\s*,\s*/).filter(Boolean);
    if (cp.length < 2) { if (part.trim()) out.push(part.trim()); continue; }
    if (cp.every(x => x.split(' ').length >= 2 || looksLikeOrg(x))) { out.push(...cp); continue; }
    if (cp.length > 2 && cp.length % 2 === 0 && cp.every(x => !x.includes(' ') || /^([A-Z]\.?\s?)+$/.test(x))) {
      for (let i = 0; i < cp.length; i += 2) out.push(cp[i] + ', ' + cp[i + 1]);
      continue;
    }
    out.push(part.trim());
  }
  return out;
}

export function parseNames(input) {
  const list = Array.isArray(input) ? input : splitNames(input);
  const out = [];
  for (const raw of list) {
    const n = parseName(raw);
    if (n && !out.some(o => sameName(o, n))) out.push(n);
  }
  return out;
}

export function sameName(a, b) {
  const k = n => (n.literal ? n.literal : `${n.family}|${(n.given || '').charAt(0)}`).toLowerCase();
  return k(a) === k(b);
}

/**
 * Initials of a given name.
 *   initials('John Ronald Reuel') -> 'J. R. R.'
 *   initials('Jean-Paul') -> 'J.-P.'
 *   initials('J.R.', {space:false}) -> 'J.R.'
 */
export function initials(given, { space = true, period = true } = {}) {
  const g = collapse(given);
  if (!g) return '';
  const dot = period ? '.' : '';
  const parts = g.replace(/\./g, '. ').split(/\s+/).filter(Boolean);
  const out = parts.map(p => {
    if (p.includes('-')) {
      return p.split('-').filter(Boolean).map(x => firstLetter(x) + dot).join('-');
    }
    return firstLetter(p) + dot;
  });
  return out.join(space ? ' ' : '');
}

function firstLetter(s) {
  const m = s.match(/\p{L}/u);
  return m ? m[0].toUpperCase() : '';
}

/** "Given Family Suffix" (natural order). */
export function fullName(n) {
  if (!n) return '';
  if (n.literal) return n.literal;
  return [n.given, n.family].filter(Boolean).join(' ') + (n.suffix ? ', ' + n.suffix : '');
}

/** "Family, Given, Suffix" (inverted). */
export function invertedName(n) {
  if (!n) return '';
  if (n.literal) return n.literal;
  return n.family + (n.given ? ', ' + n.given : '') + (n.suffix ? ', ' + n.suffix : '');
}

export function familyName(n) {
  return n ? (n.literal || n.family || n.given || '') : '';
}
