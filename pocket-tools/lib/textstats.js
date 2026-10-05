// Text statistics, readability and case conversion. Pure functions.

const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu;

export const READING_WPM = 238;
export const SPEAKING_WPM = 150;

// Latin-script text is tokenised with a regex that keeps contractions ("don't")
// and hyphenated words ("e-mail") whole, matching how people count words.
// Other scripts (CJK, Thai...) use Intl.Segmenter's dictionary-based word breaks.
export function words(text) {
  if (!text) return [];
  const latin = /^[\p{Script=Latin}\p{Script=Common}\p{M}\s]*$/u.test(text);
  if (latin || !hasSegmenter) return text.match(WORD_RE) || [];
  const out = [];
  for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (s.isWordLike) out.push(s.segment);
  }
  return out;
}

export function graphemeCount(text) {
  if (!text) return 0;
  if (hasSegmenter) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return [...text].length;
}

export function sentences(text) {
  if (!text || !text.trim()) return [];
  let parts;
  if (hasSegmenter) {
    parts = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(s => s.segment);
  } else {
    parts = text.split(/(?<=[.!?…])\s+/);
  }
  return parts.map(s => s.trim()).filter(s => /[\p{L}\p{N}]/u.test(s));
}

export function paragraphs(text) {
  if (!text) return [];
  return text.split(/\n+/).map(p => p.trim()).filter(p => /[\p{L}\p{N}]/u.test(p));
}

// English syllable estimate (vowel groups with common silent-e adjustments).
export function syllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouydt]ed|[^laeiouy]e)$/, '');
  w = w.replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from
further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd
i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other
ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their
theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very
was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with
won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also just can will one get got like may might
must shall us via etc`.split(/\s+/));

export function keywords(text, limit = 10) {
  const counts = new Map();
  const list = words(text);
  for (const raw of list) {
    const w = raw.toLowerCase().replace(/’/g, "'").replace(/^'+|'+$/g, '');
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count, density: list.length ? count / list.length : 0 }));
}

export function analyze(text = '') {
  const w = words(text);
  const s = sentences(text);
  const chars = graphemeCount(text);
  const charsNoSpaces = graphemeCount(text.replace(/\s+/g, ''));
  const syl = w.reduce((n, x) => n + syllables(x), 0);
  const wc = w.length;
  const sc = Math.max(1, s.length);
  let ease = null;
  let grade = null;
  if (wc > 0) {
    ease = 206.835 - 1.015 * (wc / sc) - 84.6 * (syl / wc);
    grade = 0.39 * (wc / sc) + 11.8 * (syl / wc) - 15.59;
  }
  const longest = w.reduce((a, b) => (b.length > a.length ? b : a), '');
  return {
    words: wc,
    characters: chars,
    charactersNoSpaces: charsNoSpaces,
    sentences: s.length,
    paragraphs: paragraphs(text).length,
    syllables: syl,
    readingSeconds: Math.round((wc / READING_WPM) * 60),
    speakingSeconds: Math.round((wc / SPEAKING_WPM) * 60),
    fleschEase: ease,
    fleschGrade: grade,
    avgWordLength: wc ? w.reduce((n, x) => n + x.length, 0) / wc : 0,
    avgSentenceLength: s.length ? wc / s.length : 0,
    longestWord: longest,
    keywords: keywords(text),
  };
}

export function easeLabel(score) {
  if (score === null || score === undefined) return '';
  if (score >= 90) return 'Very easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly easy';
  if (score >= 60) return 'Plain English';
  if (score >= 50) return 'Fairly difficult';
  if (score >= 30) return 'Difficult';
  return 'Very difficult';
}

export function formatDuration(seconds) {
  if (!seconds) return '0 sec';
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m} min ${s} sec` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

// ------------------------------------------------------------- case convert

const SMALL_WORDS = new Set('a an and as at but by en for if in nor of on or per the to v vs via'.split(' '));

// Splits identifiers and prose into lowercase word parts: "fooBar_baz-qux" -> [foo, bar, baz, qux].
export function splitWords(text) {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

const cap = w => (w ? w[0].toUpperCase() + w.slice(1) : w);

export function toTitleCase(text) {
  return text.replace(/\S+/g, (word, offset) => {
    const lower = word.toLowerCase();
    const isFirst = offset === 0 || /[.:!?]\s*$/.test(text.slice(0, offset));
    const isLast = offset + word.length >= text.trimEnd().length;
    if (!isFirst && !isLast && SMALL_WORDS.has(lower.replace(/[^a-z]/g, ''))) return lower;
    // Keep words that already have inner capitals (iPhone, NASA) as they are.
    if (/\p{Lu}/u.test(word.slice(1)) ) return word[0].toUpperCase() + word.slice(1);
    return lower.replace(/\p{L}/u, ch => ch.toUpperCase());
  });
}

export function toSentenceCase(text) {
  let start = true;
  return text.toLowerCase().replace(/[\p{L}]|[.!?]+(\s|$)|\n/gu, m => {
    if (/[.!?\n]/.test(m[0])) { start = true; return m; }
    if (start) { start = false; return m.toUpperCase(); }
    return m;
  }).replace(/\bi\b/g, 'I');
}

export const CASES = {
  upper: { label: 'UPPER', fn: t => t.toUpperCase() },
  lower: { label: 'lower', fn: t => t.toLowerCase() },
  title: { label: 'Title Case', fn: toTitleCase },
  sentence: { label: 'Sentence case', fn: toSentenceCase },
  camel: { label: 'camelCase', fn: t => splitWords(t).map((w, i) => (i ? cap(w) : w)).join('') },
  pascal: { label: 'PascalCase', fn: t => splitWords(t).map(cap).join('') },
  snake: { label: 'snake_case', fn: t => splitWords(t).join('_') },
  kebab: { label: 'kebab-case', fn: t => splitWords(t).join('-') },
  constant: { label: 'CONSTANT_CASE', fn: t => splitWords(t).join('_').toUpperCase() },
};

export function convertCase(text, kind) {
  const c = CASES[kind];
  if (!c) throw new Error('Unknown case: ' + kind);
  return c.fn(text);
}
