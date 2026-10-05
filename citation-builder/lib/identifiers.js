// DOI, ISBN and arXiv identifier detection and validation.

const DOI_GLOBAL = /10\.\d{4,9}\/[^\s"'<>“”]+/g;

/** Normalize a DOI from a raw string, URL or "doi:" prefixed value. Returns '' if none. */
export function cleanDoi(input) {
  if (!input) return '';
  let t = String(input).trim();
  try { if (/%2F|%3A/i.test(t)) t = decodeURIComponent(t); } catch { /* keep raw */ }
  const m = t.match(/10\.\d{4,9}\/[^\s"'<>“”]+/);
  if (!m) return '';
  return trimDoi(m[0], /^https?:/i.test(t));
}

function trimDoi(d, fromUrl) {
  let out = d;
  if (fromUrl) out = out.replace(/[?#].*$/, '');
  out = out.replace(/\/(?:full|abstract|pdf|epdf|html|fulltext|meta|references)(?:\/.*)?$/i, '');
  out = out.replace(/\.(?:pdf|html?)$/i, '');
  out = out.replace(/[.,;:'"\]>}]+$/, '');
  // Drop unbalanced trailing parentheses: "(see 10.1000/xyz)" -> 10.1000/xyz
  const count = (s, ch) => s.split(ch).length - 1;
  while (out.endsWith(')') && count(out, '(') < count(out, ')')) out = out.slice(0, -1);
  return out;
}

/** All distinct DOIs in a block of text. */
export function findDois(text) {
  const seen = new Map();
  for (const m of String(text || '').matchAll(DOI_GLOBAL)) {
    const d = trimDoi(m[0], false);
    const k = d.toLowerCase();
    if (!seen.has(k)) seen.set(k, d);
  }
  return [...seen.values()];
}

export function doiUrl(doi) {
  return doi ? 'https://doi.org/' + doi : '';
}

// ---------- ISBN ----------

export function isValidIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : +s[i]) * (10 - i);
  return sum % 11 === 0;
}

export function isValidIsbn13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += +s[i] * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

/** Normalize an ISBN (digits only, X allowed) if valid, else ''. */
export function cleanIsbn(input) {
  const t = String(input || '').toUpperCase().replace(/^ISBN(?:-1[03])?:?/, '').replace(/[^0-9X]/g, '');
  if (t.length === 10 && isValidIsbn10(t)) return t;
  if (t.length === 13 && isValidIsbn13(t)) return t;
  return '';
}

export function isbn10to13(s) {
  const base = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +base[i] * (i % 2 ? 3 : 1);
  return base + ((10 - (sum % 10)) % 10);
}

/** First valid ISBN found in text. */
export function findIsbn(text) {
  const re = /(?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx]\b/g;
  for (const m of String(text || '').matchAll(re)) {
    const c = cleanIsbn(m[0]);
    if (c) return c;
  }
  return '';
}

// ---------- arXiv ----------

const ARXIV_NEW = /(?:arxiv[:/]\s*|arxiv\.org\/(?:abs|pdf|html)\/)(\d{4}\.\d{4,5})(v\d+)?/i;
const ARXIV_OLD = /(?:arxiv[:/]\s*|arxiv\.org\/(?:abs|pdf)\/)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

export function findArxiv(text) {
  const s = String(text || '');
  const m = s.match(ARXIV_NEW) || s.match(ARXIV_OLD);
  return m ? m[1] : '';
}

export function cleanArxiv(input) {
  const s = String(input || '').trim();
  const direct = s.match(/^(\d{4}\.\d{4,5})(v\d+)?$/) || s.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i);
  if (direct) return direct[1];
  return findArxiv(s);
}

/** Classify the identifier in a piece of selected text. */
export function detectIdentifier(text) {
  const s = String(text || '');
  const doi = cleanDoi(s);
  if (doi) return { kind: 'doi', value: doi };
  const ax = findArxiv(s);
  if (ax) return { kind: 'arxiv', value: ax };
  const isbn = findIsbn(s);
  if (isbn) return { kind: 'isbn', value: isbn };
  return null;
}
