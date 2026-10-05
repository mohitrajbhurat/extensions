// Tokenizer, light stemmer and stopwords shared by indexer and query engine.
// Everything here must be deterministic: the same function runs at index time and query time.

export const STOPWORDS = new Set((
  'a about above after again against all am an and any are aren as at be because been before being below ' +
  'between both but by can cannot could couldn did didn do does doesn doing don down during each few for from ' +
  'further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is isn ' +
  'it its itself just let me more most mustn my myself no nor not of off on once only or other ought our ours ' +
  'ourselves out over own same shan she should shouldn so some such than that the their theirs them themselves ' +
  'then there these they this those through to too under until up very was wasn we were weren what when where ' +
  'which while who whom why will with won would wouldn you your yours yourself yourselves also via www http https com ' +
  'll re ve'
).split(/\s+/));

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
export const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

const VOWEL_RE = /[aeiouy]/;

/** Fold case and strip diacritics. */
export function fold(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');
}

/** Light English stemmer (Porter step 1 flavoured). Non-latin words are returned unchanged. */
export function stem(w) {
  if (w.length < 4 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) { /* keep */ }
  else if (w.endsWith('s') && !w.endsWith('ous')) w = w.slice(0, -1);

  if (w.endsWith('eed')) { if (w.length > 4) w = w.slice(0, -1); }
  else if (w.endsWith('ed') && w.length > 4 && VOWEL_RE.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
  else if (w.endsWith('ing') && w.length > 5 && VOWEL_RE.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));

  if (w.endsWith('ly') && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith('ment') && w.length > 7) w = w.slice(0, -4);
  if (w.endsWith('e') && w.length >= 4) w = w.slice(0, -1);
  return w;
}

function undouble(s) {
  const n = s.length;
  if (n >= 3 && s[n - 1] === s[n - 2] && !'lsz'.includes(s[n - 1]) && !VOWEL_RE.test(s[n - 1])) return s.slice(0, -1);
  return s;
}

/** Emit CJK character bigrams (unigram for single chars) so CJK text is searchable without a dictionary. */
function cjkGrams(word, out) {
  if (word.length === 1) { out.push(word); return; }
  for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
}

/** Normalize one raw word to an index term, or '' if it should be dropped. */
export function termOf(raw) {
  const w = fold(raw);
  if (w.length < 2 || w.length > 40 || STOPWORDS.has(w)) return '';
  if (/^\d+$/.test(w) && w.length > 12) return '';
  return stem(w);
}

/** Tokenize text into index terms (with repetition, in order). */
export function tokenize(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0];
    if (CJK_RE.test(raw)) {
      // Split mixed runs into CJK and non-CJK segments.
      for (const seg of raw.match(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+|[^぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g)) {
        if (CJK_RE.test(seg)) cjkGrams(seg, out);
        else { const t = termOf(seg); if (t) out.push(t); }
      }
      continue;
    }
    const t = termOf(raw);
    if (t) out.push(t);
  }
  return out;
}

/** Lowercase, diacritic-free, punctuation-collapsed string for phrase matching. */
export function normalizeForPhrase(text) {
  return ' ' + fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
}

/** Cheap 32-bit FNV-1a hash used to detect unchanged page text. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length;
}
