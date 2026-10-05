// Query parser, BM25 ranking over the inverted index, snippets and text-fragment links.
import { tokenize, termOf, fold, normalizeForPhrase, WORD_RE } from './tokenizer.js';
import { getStats, getAllDocs, getTexts, postingsFor, postingsForPrefix } from './db.js';
import { domainMatches, dateRange, escapeHtml, cleanRule } from './util.js';

const K1 = 1.2, B = 0.75;
const DAY = 86400000;
const OP_RE = /(-?)(site|after|before|date|in):("[^"]*"|\S+)|(-?)"([^"]*)("?)|(-?)(\S+)/gi;

/**
 * Parse a query string.
 *  words          memory leak         (OR with coverage boost, ranked by BM25)
 *  "a phrase"     exact phrase
 *  -word -"x y"   exclude
 *  site:x.com     restrict (−site: excludes)
 *  date:today|yesterday|week|month|year, after:2024-01-31, before:2024-02-28
 */
export function parseQuery(input, { live = false } = {}) {
  const q = {
    raw: input, terms: [], phrases: [], excludeTerms: [], excludePhrases: [],
    sites: [], excludeSites: [], date: null, after: null, before: null, prefix: null, prefixStem: null,
  };
  const bare = [];
  for (const m of String(input || '').matchAll(OP_RE)) {
    if (m[2]) {
      const neg = m[1] === '-', op = m[2].toLowerCase(), val = m[3].replace(/^"|"$/g, '');
      if (op === 'site') (neg ? q.excludeSites : q.sites).push(cleanRule(val));
      else if (op === 'after') { const t = Date.parse(val + (val.length <= 10 ? 'T00:00:00' : '')); if (!isNaN(t)) q.after = t; }
      else if (op === 'before') { const t = Date.parse(val + (val.length <= 10 ? 'T00:00:00' : '')); if (!isNaN(t)) q.before = t; }
      else if (/^(today|yesterday|week|month|year)$/i.test(val)) q.date = val.toLowerCase();
      continue;
    }
    if (m[5] !== undefined) {
      const neg = m[4] === '-', text = m[5].trim();
      if (!text) continue;
      const terms = tokenize(text);
      if (neg) q.excludePhrases.push(normalizeForPhrase(text));
      else q.phrases.push({ raw: text, terms, norm: normalizeForPhrase(text) });
      continue;
    }
    const neg = m[7] === '-', word = m[8];
    const terms = tokenize(word);
    if (neg) { if (terms.length > 1) q.excludePhrases.push(normalizeForPhrase(word)); else q.excludeTerms.push(...terms); continue; }
    if (terms.length > 1) { q.phrases.push({ raw: word, terms, norm: normalizeForPhrase(word), implicit: true }); continue; }
    bare.push({ word, term: terms[0] || null, index: m.index });
  }
  const endsOpen = live && input && !/[\s"]$/.test(input);
  bare.forEach((b, i) => {
    const isLast = i === bare.length - 1 && endsOpen && b.index + b.word.length === input.length;
    const f = fold(b.word).replace(/[^\p{L}\p{N}]/gu, '');
    if (isLast && f.length >= 2 && !/[぀-鿿가-힯]/.test(f)) {
      q.prefix = f; q.prefixStem = b.term || termOf(f) || f;
    } else if (b.term) q.terms.push(b.term);
  });
  q.terms = [...new Set(q.terms)];
  return q;
}

export function isEmptyQuery(q) {
  return !q.terms.length && !q.phrases.length && !q.prefix && !q.sites.length && !q.excludeSites.length &&
    !q.excludeTerms.length && !q.excludePhrases.length && !q.date && !q.after && !q.before;
}

/** Terms used for highlighting. */
export function highlightTerms(q) {
  const set = new Set(q.terms);
  for (const p of q.phrases) for (const t of p.terms) set.add(t);
  return set;
}

export class SearchEngine {
  constructor() { this.docs = new Map(); this.version = -1; this.stats = null; }

  async refresh(force = false) {
    const stats = await getStats();
    if (force || stats.version !== this.version || this.docs.size !== stats.docs) {
      const all = await getAllDocs();
      this.docs = new Map(all.map(d => [d.id, d]));
      this.version = stats.version;
    }
    this.stats = stats;
    return stats;
  }

  /**
   * @param {string|object} input query string or parsed query
   * @param {{live?:boolean, range?:[number,number], sort?:'relevance'|'recent', limit?:number}} opts
   */
  async search(input, opts = {}) {
    const t0 = performance.now();
    const q = typeof input === 'string' ? parseQuery(input, { live: opts.live }) : input;
    await this.refresh();
    const N = Math.max(1, this.docs.size);
    const avgdl = Math.max(1, (this.stats.totalLen || 1) / N);

    // Date window: intersection of UI range and query operators.
    let [from, to] = opts.range || [0, Infinity];
    if (q.date) { const [a, b] = dateRange(q.date); from = Math.max(from, a); to = Math.min(to, b); }
    if (q.after) from = Math.max(from, q.after);
    if (q.before) to = Math.min(to, q.before);

    const passesMeta = d => d && d.lastVisit >= from && d.lastVisit < to &&
      (!q.sites.length || q.sites.some(s => domainMatches(d.domain, s))) &&
      !q.excludeSites.some(s => domainMatches(d.domain, s));

    // Excluded terms.
    const excluded = new Set();
    for (const t of q.excludeTerms) for (const p of await postingsFor(t)) excluded.add(p.d);

    // Positive units: each query term, each phrase term, and the live prefix.
    const units = [];
    const seen = new Set();
    const addTerm = (t, required) => {
      if (seen.has(t)) { if (required) units.find(u => u.key === t).required = true; return; }
      seen.add(t); units.push({ key: t, exact: t, required });
    };
    for (const t of q.terms) addTerm(t, false);
    for (const p of q.phrases) for (const t of p.terms) addTerm(t, true);
    if (q.prefix && !seen.has(q.prefixStem)) units.push({ key: '*' + q.prefix, prefix: q.prefix, exact: q.prefixStem, required: false });

    let scored = [];
    if (units.length) {
      const scores = new Map();     // docId -> score
      const covered = new Map();    // docId -> matched unit count
      const requiredHits = new Map();
      const requiredCount = units.filter(u => u.required).length;
      for (const u of units) {
        let tf = new Map();
        if (u.prefix) {
          const lists = await Promise.all([postingsForPrefix(u.prefix), u.exact && !u.exact.startsWith(u.prefix) ? postingsFor(u.exact) : []]);
          for (const p of lists[0]) tf.set(p.d, (tf.get(p.d) || 0) + p.f * (p.t === u.exact || p.t === u.prefix ? 1 : 0.7));
          for (const p of lists[1]) tf.set(p.d, (tf.get(p.d) || 0) + p.f);
        } else {
          for (const p of await postingsFor(u.exact)) tf.set(p.d, p.f);
        }
        const df = tf.size;
        if (!df) continue;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        for (const [d, f] of tf) {
          const doc = this.docs.get(d);
          if (!doc || excluded.has(d)) continue;
          const s = idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * doc.len / avgdl));
          scores.set(d, (scores.get(d) || 0) + s);
          covered.set(d, (covered.get(d) || 0) + 1);
          if (u.required) requiredHits.set(d, (requiredHits.get(d) || 0) + 1);
        }
      }
      const now = Date.now();
      for (const [d, s] of scores) {
        if (requiredCount && (requiredHits.get(d) || 0) < requiredCount) continue;
        const doc = this.docs.get(d);
        if (!passesMeta(doc)) continue;
        const coverage = covered.get(d) / units.length;
        const ageDays = (now - doc.lastVisit) / DAY;
        const recency = 1 + 0.15 * Math.exp(-ageDays / 14) + 0.05 * Math.log1p(doc.visits || 1);
        scored.push({ doc, score: s * coverage * coverage * recency, matched: covered.get(d), units: units.length });
      }
    } else if (!isEmptyQuery(q) || opts.browse) {
      for (const doc of this.docs.values()) if (passesMeta(doc) && !excluded.has(doc.id)) scored.push({ doc, score: doc.lastVisit / 1e13, matched: 0, units: 0 });
    }

    // Phrase verification against stored text (bounded work).
    if (q.phrases.length || q.excludePhrases.length) {
      scored.sort((a, b) => b.score - a.score);
      scored = scored.slice(0, 4000);
      const verified = [];
      for (let i = 0; i < scored.length; i += 300) {
        const chunk = scored.slice(i, i + 300);
        const texts = await getTexts(chunk.map(r => r.doc.id));
        for (const r of chunk) {
          const norm = normalizeForPhrase(r.doc.title + '\n' + (texts.get(r.doc.id) || ''));
          if (q.phrases.every(p => !p.terms.length || norm.includes(p.norm)) && !q.excludePhrases.some(p => norm.includes(p))) verified.push(r);
        }
      }
      scored = verified;
    }

    if (opts.sort === 'recent' || !units.length) scored.sort((a, b) => b.doc.lastVisit - a.doc.lastVisit);
    else scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const limit = opts.limit || 50;
    return { query: q, results: scored.slice(0, limit), total, tookMs: performance.now() - t0, docCount: this.docs.size };
  }
}

/** Build a highlighted snippet and a text-fragment target for one document. */
export function makeSnippet(text, q, { maxWords = 34, maxScan = 250000 } = {}) {
  text = text || '';
  const termSet = highlightTerms(q);
  const prefix = q.prefix, prefixStem = q.prefixStem;
  const cjkTerms = [...termSet].filter(t => /[぀-鿿가-힯]/.test(t));
  const keyOf = raw => {
    const f = fold(raw);
    if (cjkTerms.length) for (const t of cjkTerms) if (f.includes(t)) return t;
    const t = termOf(raw);
    if (t && termSet.has(t)) return t;
    if (prefix && (f.startsWith(prefix) || (t && prefixStem && t === prefixStem))) return '*';
    return null;
  };
  const words = [];
  const scan = text.length > maxScan ? text.slice(0, maxScan) : text;
  for (const m of scan.matchAll(WORD_RE)) words.push({ s: m.index, e: m.index + m[0].length, k: keyOf(m[0]) });

  if (!words.length) return { html: '', fragment: null };
  // Best window: most distinct terms, then most hits.
  let best = 0, bestScore = -1;
  if (termSet.size || prefix) {
    const counts = new Map();
    let hits = 0;
    for (let j = 0; j < words.length; j++) {
      const k = words[j].k;
      if (k) { counts.set(k, (counts.get(k) || 0) + 1); hits++; }
      const i = j - maxWords + 1;
      if (i >= 0) {
        const sc = counts.size * 100 + hits;
        if (sc > bestScore && words[i].k !== undefined) { bestScore = sc; best = i; }
        const ki = words[i].k;
        if (ki) { hits--; const c = counts.get(ki) - 1; if (c) counts.set(ki, c); else counts.delete(ki); }
      }
    }
    if (bestScore < 0) bestScore = counts.size * 100 + hits; // text shorter than window
    if (bestScore <= 0) best = 0;
    else {
      // Shift so the first hit sits a few words into the window for context.
      let first = best; while (first < words.length && !words[first].k) first++;
      best = Math.max(0, Math.min(first - 4, words.length - maxWords));
    }
  }
  const startW = Math.max(0, best), endW = Math.min(words.length - 1, startW + maxWords - 1);
  let html = '';
  let pos = words[startW].s;
  for (let i = startW; i <= endW; i++) {
    const w = words[i];
    html += escapeHtml(text.slice(pos, w.s).replace(/\s*\n\s*/g, ' · '));
    const piece = escapeHtml(text.slice(w.s, w.e));
    html += w.k ? `<mark>${piece}</mark>` : piece;
    pos = w.e;
  }
  html = (startW > 0 ? '… ' : '') + html + (endW < words.length - 1 ? ' …' : '');

  // Text fragment: an exact phrase if the user gave one, else a short run of words starting at the first hit.
  let fragment = null;
  const phrase = q.phrases.find(p => !p.implicit && p.raw.length > 2);
  if (phrase) fragment = phrase.raw;
  else {
    let i = startW; while (i <= endW && !words[i].k) i++;
    if (i <= endW) {
      let j = i;
      while (j < Math.min(words.length - 1, i + 4) && !/\n/.test(text.slice(words[j].e, words[j + 1].s))) j++;
      fragment = text.slice(words[i].s, words[j].e).replace(/\s+/g, ' ');
    }
  }
  return { html, fragment };
}

export function fragmentUrl(url, fragment) {
  if (!fragment) return url;
  const enc = encodeURIComponent(fragment).replace(/-/g, '%2D');
  return url + (url.includes('#') ? ':~:text=' : '#:~:text=') + enc;
}
