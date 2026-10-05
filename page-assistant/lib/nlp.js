// Page Assistant: on-device text analysis used when built-in AI is missing, and to
// support it (retrieval, chunking). Pure functions, no DOM, so it runs in the side
// panel, the service worker and in node:test.

export const STOPWORDS = new Set(`a about above according across actually after afterwards again against all almost alone along already also although always am among amongst an and another any anybody anyhow anyone anything anyway anywhere are aren't around as at back be became because become becomes becoming been before beforehand behind being below beside besides between beyond both but by can can't cannot could couldn't did didn't do does doesn't doing don't done down due during each eg either else elsewhere enough especially etc even ever every everyone everything everywhere few first for former formerly from further get gets getting give given gives go goes going gone got had hadn't has hasn't have haven't having he he'd he'll he's hence her here here's hereby herein hers herself him himself his how how's however i i'd i'll i'm i've ie if in indeed instead into is isn't it it's its itself just last later least less let let's like likely made make makes many may maybe me meanwhile might mine more moreover most mostly much must mustn't my myself namely neither never nevertheless next no nobody none nor not nothing now nowhere of off often on once one ones only onto or other others otherwise ought our ours ourselves out over own per perhaps please put quite rather really said same say says see seem seemed seeming seems seen several shall shan't she she'd she'll she's should shouldn't since so some somehow someone something sometime sometimes somewhere still such than that that's the their theirs them themselves then thence there there's thereafter thereby therefore therein these they they'd they'll they're they've this those though through throughout thru thus to together too toward towards two under until up upon us use used uses using very via was wasn't way we we'd we'll we're we've well were weren't what what's whatever when when's whence whenever where where's whereas whereby wherever whether which while whither who who's whoever whole whom whose why why's will with within without won't would wouldn't yet you you'd you'll you're you've your yours yourself yourselves`.split(/\s+/));

// Words that are frequent in almost any article and make poor keywords.
const GENERIC = new Set(`able area article best better big case change come day days different does end example fact far find good great group help high important including know large lot lots main mean means need new number part people place point possible problem real right second set show small start story thing things think time times today want ways week work world year years`.split(/\s+/));

const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'inc', 'ltd', 'co', 'corp', 'fig', 'figs', 'no', 'nos', 'vol', 'approx', 'dept', 'est', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'a.m', 'p.m', 'cf', 'al', 'ed', 'eds', 'pp', 'gen', 'gov', 'sen', 'rep', 'mt', 'ft', 'op', 'ca', 'resp', 'viz', 'eq', 'ch', 'sec']);

/** Collapse whitespace. */
export const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Split text into sentences. Paragraph breaks (newlines) always end a sentence. */
export function splitSentences(text) {
  const out = [];
  const re = /([.!?…]+)(["'”’)\]]*)\s+(?=["'“‘(\[]?[\p{Lu}\p{N}])/gu;
  for (const para of String(text || '').split(/\n+/)) {
    const p = clean(para);
    if (!p) continue;
    let start = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(p))) {
      const before = p.slice(start, m.index);
      const lastWord = ((before.match(/(\S+)$/) || ['', ''])[1]).toLowerCase().replace(/^[("'“‘[]+/, '');
      if (m[1] === '.' && (ABBREV.has(lastWord) || /^\p{L}$/u.test(lastWord))) continue;
      const end = m.index + m[1].length + m[2].length;
      const s = p.slice(start, end).trim();
      if (s) out.push(s);
      start = end;
    }
    const rest = p.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

/** Lowercased word tokens (letters, digits, inner apostrophes and hyphens). */
export function words(text) {
  return String(text || '').toLowerCase().match(/\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+(?:[.,]\p{N}+)*/gu) || [];
}

export function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

// ---- Porter stemmer (Martin Porter, 1980), memoized ----
const step2 = { ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log' };
const step3 = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };
const cC = '[^aeiou]', vV = '[aeiouy]', CC = cC + '[^aeiouy]*', VV = vV + '[aeiou]*';
const mgr0 = new RegExp('^(' + CC + ')?' + VV + CC);
const meq1 = new RegExp('^(' + CC + ')?' + VV + CC + '(' + VV + ')?$');
const mgr1 = new RegExp('^(' + CC + ')?' + VV + CC + VV + CC);
const sV = new RegExp('^(' + CC + ')?' + vV);
const cvc = new RegExp('^' + CC + vV + '[^aeiouwxy]$');
const stemCache = new Map();

export function stem(word) {
  const w0 = String(word).toLowerCase().replace(/['’]/g, '');
  if (w0.length < 3 || !/^[a-z]+$/.test(w0)) return w0;
  const hit = stemCache.get(w0);
  if (hit) return hit;
  let w = w0;
  let fp, st;
  const firstY = w[0] === 'y';
  if (firstY) w = 'Y' + w.slice(1);
  if (/^(.+?)(ss|i)es$/.test(w)) w = w.replace(/^(.+?)(ss|i)es$/, '$1$2');
  else if (/^(.+?)([^s])s$/.test(w)) w = w.replace(/^(.+?)([^s])s$/, '$1$2');
  if ((fp = /^(.+?)eed$/.exec(w))) {
    if (mgr0.test(fp[1])) w = w.slice(0, -1);
  } else if ((fp = /^(.+?)(ed|ing)$/.exec(w))) {
    st = fp[1];
    if (sV.test(st)) {
      w = st;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (cvc.test(w)) w += 'e';
    }
  }
  if ((fp = /^(.+?)y$/.exec(w)) && sV.test(fp[1])) w = fp[1] + 'i';
  if ((fp = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w)) && mgr0.test(fp[1])) w = fp[1] + step2[fp[2]];
  if ((fp = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w)) && mgr0.test(fp[1])) w = fp[1] + step3[fp[2]];
  if ((fp = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) {
    if (mgr1.test(fp[1])) w = fp[1];
  } else if ((fp = /^(.+?)(s|t)(ion)$/.exec(w))) {
    st = fp[1] + fp[2];
    if (mgr1.test(st)) w = st;
  }
  if ((fp = /^(.+?)e$/.exec(w))) {
    st = fp[1];
    if (mgr1.test(st) || (meq1.test(st) && !cvc.test(st))) w = st;
  }
  if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);
  if (firstY) w = 'y' + w.slice(1);
  if (stemCache.size > 50000) stemCache.clear();
  stemCache.set(w0, w);
  return w;
}

const normWord = (w) => w.replace(/['’]s$/, '').replace(/['’-]+$/, '');

/** Content terms: stemmed, stopwords removed. keepNumbers keeps numeric tokens (useful for Q&A). */
export function terms(text, { keepNumbers = false } = {}) {
  const out = [];
  for (let w of words(text)) {
    w = normWord(w);
    if (STOPWORDS.has(w)) continue;
    if (/^\p{N}/u.test(w)) { if (keepNumbers) out.push(w); continue; }
    if (w.length < 2) continue;
    out.push(stem(w));
  }
  return out;
}

// ---- Readability statistics ----
export function syllables(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

export function readingStats(text, { wpm = 230 } = {}) {
  const sents = splitSentences(text);
  const ws = (String(text || '').match(/\p{L}[\p{L}'’-]*/gu) || []);
  const nWords = ws.length;
  const nSent = Math.max(1, sents.length);
  let syl = 0;
  let complex = 0;
  for (const w of ws) { const s = syllables(w); syl += s; if (s >= 3) complex++; }
  const wps = nWords / nSent;
  const spw = nWords ? syl / nWords : 0;
  const flesch = nWords ? Math.round(Math.max(0, Math.min(100, 206.835 - 1.015 * wps - 84.6 * spw)) * 10) / 10 : 0;
  const grade = nWords ? Math.max(0, Math.round((0.39 * wps + 11.8 * spw - 15.59) * 10) / 10) : 0;
  return {
    words: nWords,
    sentences: sents.length,
    characters: String(text || '').length,
    readingMinutes: nWords ? Math.max(1, Math.round(nWords / wpm)) : 0,
    avgSentenceWords: Math.round(wps * 10) / 10,
    complexWordPct: nWords ? Math.round((complex / nWords) * 1000) / 10 : 0,
    flesch,
    fleschLabel: fleschLabel(flesch),
    grade,
  };
}

export function fleschLabel(score) {
  if (score >= 90) return 'Very easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly easy';
  if (score >= 60) return 'Plain English';
  if (score >= 50) return 'Fairly difficult';
  if (score >= 30) return 'Difficult';
  return 'Very difficult';
}

// ---- Document model helpers ----
/** Normalize input into blocks [{type, text, level?}] whether given a string or blocks. */
export function toBlocks(input) {
  if (Array.isArray(input)) return input.filter((b) => b && clean(b.text));
  return String(input || '').split(/\n\s*\n/).map((t) => ({ type: 'p', text: clean(t) })).filter((b) => b.text);
}

const BOILER = /^(advertisement|sponsored|share( this)?|tweet|subscribe|sign up|log ?in|read more|related( articles)?|comments?|cookie|accept)\b/i;

/** Sentence objects from prose blocks (paragraphs, quotes, long list items). */
export function sentencesFromBlocks(blocks) {
  const out = [];
  blocks.forEach((b, bi) => {
    if (b.type === 'heading' || b.type === 'pre' || b.type === 'code' || b.type === 'table') return;
    if (b.type === 'li' && wordCount(b.text) < 6) return;
    for (const s of splitSentences(b.text)) {
      const wc = wordCount(s);
      if (wc < 4 || BOILER.test(s)) continue;
      out.push({ text: s, block: bi, index: out.length, words: wc, terms: terms(s) });
    }
  });
  return out;
}

/**
 * TextRank (Mihalcea & Tarau 2004) over sentences with the original overlap similarity,
 * computed sparsely through an inverted index. Adds mild lead and length priors.
 */
export function rankSentences(sents, { title = '' } = {}) {
  const n = sents.length;
  if (!n) return [];
  const sets = sents.map((s) => new Set(s.terms));
  const index = new Map();
  sets.forEach((set, i) => { for (const t of set) { let l = index.get(t); if (!l) index.set(t, (l = [])); l.push(i); } });
  // Ignore terms present in a huge share of sentences (they connect everything).
  const maxDf = Math.max(8, n * 0.5);
  const adj = Array.from({ length: n }, () => new Map());
  for (const [, list] of index) {
    if (list.length < 2 || list.length > maxDf) continue;
    for (let a = 0; a < list.length; a++) {
      const i = list[a];
      const row = adj[i];
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b];
        row.set(j, (row.get(j) || 0) + 1);
      }
    }
  }
  const nb = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const [j, overlap] of adj[i]) {
      const w = overlap / (Math.log(sets[i].size + 1) + Math.log(sets[j].size + 1));
      if (w > 0) { nb[i].push([j, w]); nb[j].push([i, w]); }
    }
  }
  const outSum = nb.map((l) => l.reduce((a, [, w]) => a + w, 0));
  let pr = new Float64Array(n).fill(1 / n);
  const d = 0.85;
  for (let it = 0; it < 40; it++) {
    const next = new Float64Array(n).fill((1 - d) / n);
    for (let i = 0; i < n; i++) {
      if (!outSum[i]) continue;
      const share = (d * pr[i]) / outSum[i];
      for (const [j, w] of nb[i]) next[j] += share * w;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - pr[i]);
    pr = next;
    if (delta < 1e-6) break;
  }
  const titleTerms = new Set(terms(title));
  return sents.map((s, i) => {
    const pos = i / n;
    const lead = 1 + 0.25 * Math.max(0, 1 - pos * 4); // first quarter gets a small boost
    const len = s.words < 8 ? 0.6 : s.words > 50 ? 0.7 : 1;
    let titleHit = 0;
    for (const t of sets[i]) if (titleTerms.has(t)) titleHit++;
    const tBoost = 1 + Math.min(0.3, titleHit * 0.1);
    const q = /\?$/.test(s.text) ? 0.8 : 1;
    return { ...s, score: pr[i] * n * lead * len * tBoost * q };
  });
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** Pick k top sentences, avoiding near-duplicates, returned in document order. */
export function selectTop(ranked, k, { redundancy = 0.45 } = {}) {
  const sorted = [...ranked].sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const s of sorted) {
    if (chosen.length >= k) break;
    const set = new Set(s.terms);
    if (chosen.some((c) => jaccard(c._set, set) > redundancy)) continue;
    chosen.push({ ...s, _set: set });
  }
  return chosen.sort((a, b) => a.index - b.index).map(({ _set, ...s }) => s);
}

const COUNTS = {
  'key-points': { short: 3, medium: 5, long: 8 },
  tldr: { short: 1, medium: 3, long: 5 },
  teaser: { short: 1, medium: 2, long: 3 },
};

/**
 * Extractive summary. type: key-points | tldr | headline | teaser; length: short | medium | long.
 * Returns { markdown, sentences } where sentences carry block indexes for "show in page".
 */
export function summarizeExtractive(input, { type = 'key-points', length = 'medium', title = '' } = {}) {
  const blocks = toBlocks(input);
  const sents = sentencesFromBlocks(blocks);
  if (!sents.length) return { markdown: '', sentences: [] };
  const ranked = rankSentences(sents, { title });
  if (type === 'headline') {
    const best = selectTop(ranked, 1)[0];
    return { markdown: makeHeadline(best.text), sentences: [best] };
  }
  const base = (COUNTS[type] || COUNTS['key-points'])[length] || 5;
  // Long documents deserve a few more points.
  const extra = type === 'key-points' ? Math.min(4, Math.floor(sents.length / 120)) : 0;
  const k = Math.min(sents.length, base + extra);
  const top = selectTop(ranked, k);
  const markdown = type === 'key-points'
    ? top.map((s) => '- ' + s.text).join('\n')
    : top.map((s) => s.text).join(' ');
  return { markdown, sentences: top };
}

/** Shorten a sentence into a headline-like line. */
export function makeHeadline(sentence) {
  let s = clean(sentence).replace(/[.!?…]+$/, '');
  const ws = s.split(' ');
  if (ws.length > 16) {
    const cut = s.search(/[,;:—–]\s/);
    if (cut > 0 && wordCount(s.slice(0, cut)) >= 6) s = s.slice(0, cut);
    else s = ws.slice(0, 14).join(' ') + '…';
  }
  return s;
}

// ---- Keywords (C-value weighted n-grams over stopword-delimited candidates) ----
export function extractKeywords(input, { max = 12, title = '' } = {}) {
  const blocks = toBlocks(input);
  const grams = new Map(); // key -> {count, forms: Map, n, words}
  const titleTerms = new Set(terms(title));
  const headingTerms = new Set();
  for (const b of blocks) if (b.type === 'heading') for (const t of terms(b.text)) headingTerms.add(t);
  for (const b of blocks) {
    if (b.type === 'pre' || b.type === 'code') continue;
    const phrases = String(b.text).split(/[.,;:!?()"“”‘’[\]{}|/\\—–]+|\s-\s/);
    for (const ph of phrases) {
      const raw = ph.match(/\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+/gu) || [];
      let run = [];
      const flush = () => {
        for (let n = 1; n <= 3; n++) {
          for (let i = 0; i + n <= run.length; i++) {
            const seg = run.slice(i, i + n);
            const key = seg.map((x) => x.s).join(' ');
            let g = grams.get(key);
            if (!g) grams.set(key, (g = { count: 0, forms: new Map(), n, stems: seg.map((x) => x.s) }));
            g.count++;
            const form = seg.map((x) => x.w).join(' ');
            g.forms.set(form, (g.forms.get(form) || 0) + 1);
          }
        }
        run = [];
      };
      for (const w0 of raw) {
        const w = normWord(w0);
        const lw = w.toLowerCase();
        if (STOPWORDS.has(lw) || lw.length < 3 || /^\p{N}+$/u.test(lw)) { flush(); continue; }
        run.push({ w, s: stem(lw) });
      }
      flush();
    }
  }
  // C-value style: subtract occurrences explained by longer n-grams.
  const entries = [...grams.entries()];
  const nested = new Map();
  for (const [, g] of entries) {
    if (g.n === 1 || g.count < 2) continue;
    for (let n = 1; n < g.n; n++) {
      for (let i = 0; i + n <= g.n; i++) {
        const sub = g.stems.slice(i, i + n).join(' ');
        const arr = nested.get(sub) || [];
        arr.push(g.count);
        nested.set(sub, arr);
      }
    }
  }
  const scored = [];
  for (const [key, g] of entries) {
    if (g.n > 1 && g.count < 2) continue;
    const longer = nested.get(key);
    let f = g.count;
    if (longer && longer.length) f -= longer.reduce((a, b) => a + b, 0) / longer.length;
    if (f <= 0) continue;
    let score = Math.log2(g.n + 1) * f;
    if (g.n === 1 && GENERIC.has(key)) score *= 0.3;
    if (g.stems.some((s) => titleTerms.has(s))) score *= 1.5;
    if (g.stems.some((s) => headingTerms.has(s))) score *= 1.2;
    // Proper nouns / acronyms tend to be meaningful.
    const forms = [...g.forms.entries()].sort((a, b) => b[1] - a[1]);
    const lowerForm = forms.find(([f]) => f === f.toLowerCase());
    const form = lowerForm ? lowerForm[0] : forms[0][0];
    if (!lowerForm && g.count >= 2) score *= 1.15;
    scored.push({ key, text: form, count: g.count, score, n: g.n });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  for (const k of scored) {
    if (out.length >= max) break;
    // Skip if this term is fully contained in an already chosen phrase with similar weight.
    if (out.some((o) => (' ' + o.key + ' ').includes(' ' + k.key + ' ') && (o.score > k.score * 0.5 || k.count <= o.count * 1.3))) continue;
    if (out.some((o) => (' ' + k.key + ' ').includes(' ' + o.key + ' ') && k.score < o.score * 0.6)) continue;
    out.push({ text: k.text, count: k.count, n: k.n, score: Math.round(k.score * 100) / 100 });
  }
  return out;
}

// ---- Outline ----
/** Outline from headings; when a page has none, segment paragraphs and label them. */
export function buildOutline(input, { title = '' } = {}) {
  const blocks = toBlocks(input);
  const heads = [];
  blocks.forEach((b, i) => { if (b.type === 'heading') heads.push({ level: b.level || 2, text: clean(b.text), block: i }); });
  const filtered = heads.filter((h, i) => !(i === 0 && clean(title) && h.text.toLowerCase() === clean(title).toLowerCase() && h.level === 1));
  if (filtered.length >= 2) {
    const minLevel = Math.min(...filtered.map((h) => h.level));
    return { kind: 'headings', items: filtered.map((h) => ({ ...h, depth: Math.min(3, h.level - minLevel) })) };
  }
  const paras = blocks.map((b, i) => ({ ...b, i })).filter((b) => b.type !== 'heading' && wordCount(b.text) >= 12);
  if (paras.length < 4) return { kind: 'none', items: [] };
  const segCount = Math.min(8, Math.max(2, Math.round(paras.length / 4)));
  const size = Math.ceil(paras.length / segCount);
  const items = [];
  for (let s = 0; s < paras.length; s += size) {
    const seg = paras.slice(s, s + size);
    const kws = extractKeywords(seg, { max: 2 });
    const label = kws.length ? kws.map((k) => k.text).join(', ') : makeHeadline(splitSentences(seg[0].text)[0] || seg[0].text);
    items.push({ level: 2, depth: 0, text: label.charAt(0).toUpperCase() + label.slice(1), block: seg[0].i });
  }
  return { kind: 'auto', items };
}

// ---- Passage retrieval (BM25) for Q&A and for grounding the language model ----
export function buildPassages(input, { minWords = 40, maxWords = 160 } = {}) {
  const blocks = toBlocks(input);
  const out = [];
  let heading = '';
  let cur = null;
  const push = () => { if (cur && cur.words) out.push(cur); cur = null; };
  blocks.forEach((b, i) => {
    if (b.type === 'heading') { push(); heading = clean(b.text); return; }
    const wc = wordCount(b.text);
    if (wc > maxWords) {
      push();
      let buf = [];
      let bw = 0;
      for (const s of splitSentences(b.text)) {
        const sw = wordCount(s);
        if (bw + sw > maxWords && bw >= minWords) { out.push({ text: buf.join(' '), blocks: [i], heading, words: bw }); buf = []; bw = 0; }
        buf.push(s); bw += sw;
      }
      if (buf.length) out.push({ text: buf.join(' '), blocks: [i], heading, words: bw });
      return;
    }
    if (!cur) cur = { text: '', blocks: [], heading, words: 0 };
    cur.text += (cur.text ? '\n' : '') + clean(b.text);
    cur.blocks.push(i);
    cur.words += wc;
    if (cur.words >= minWords) push();
  });
  push();
  return out.map((p, idx) => ({ ...p, id: idx, terms: terms(p.text + ' ' + p.heading, { keepNumbers: true }) }));
}

const QWORDS = /^(who|whom|whose|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will|tell|explain|describe|list|give)\b/i;

/** Rank passages for a question with BM25 plus question-type cues. */
export function searchPassages(passages, query, { k = 3 } = {}) {
  const q = clean(query);
  const qTerms = [...new Set(terms(q, { keepNumbers: true }))];
  if (!qTerms.length || !passages.length) return { results: [], terms: qTerms };
  const N = passages.length;
  const df = new Map();
  for (const p of passages) for (const t of new Set(p.terms)) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = passages.reduce((a, p) => a + p.terms.length, 0) / N || 1;
  const k1 = 1.2;
  const b = 0.75;
  const lowerQ = q.toLowerCase().replace(QWORDS, '').replace(/[?.!]+$/, '').trim();
  const wantsTime = /^(when|what year|what date)\b/i.test(q);
  const wantsNumber = /^how (many|much|long|old|far|big)\b/i.test(q);
  const wantsPerson = /^(who|whom|whose)\b/i.test(q);
  const results = passages.map((p) => {
    const tf = new Map();
    for (const t of p.terms) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    let matched = 0;
    for (const t of qTerms) {
      const f = tf.get(t);
      if (!f) continue;
      matched++;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (p.terms.length / avgdl))));
    }
    if (!score) return { passage: p, score: 0 };
    score *= 0.6 + 0.4 * (matched / qTerms.length);
    const lt = p.text.toLowerCase();
    if (lowerQ.length > 6 && lt.includes(lowerQ)) score *= 1.5;
    if (wantsTime && /\b(1[5-9]\d\d|20\d\d)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(p.text)) score *= 1.25;
    if (wantsNumber && /\d/.test(p.text)) score *= 1.2;
    if (wantsPerson && /\b\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+/u.test(p.text)) score *= 1.1;
    return { passage: p, score };
  }).filter((r) => r.score > 0).sort((a, b2) => b2.score - a.score).slice(0, k);
  const qset = new Set(qTerms);
  for (const r of results) r.best = bestSentence(r.passage.text, qset);
  return { results, terms: qTerms };
}

/** The sentence of a passage that covers the most query terms. */
export function bestSentence(text, qset) {
  let best = '';
  let bestScore = -1;
  for (const s of splitSentences(text)) {
    const ts = new Set(terms(s, { keepNumbers: true }));
    let hit = 0;
    for (const t of qset) if (ts.has(t)) hit++;
    const sc = hit - Math.max(0, wordCount(s) - 40) * 0.02;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

// ---- Study material (fallback generators) ----
const DEF_RE = /^(?:the |an? )?([\p{L}\p{N}][\p{L}\p{N}' -]{1,60}?)(?:,[^,]{3,80},)? (is|are|was|were|refers to|means|describes) (?:an?|the|one of the)? ?(.{12,})$/iu;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Flashcards: definitional sentences become Q/A, others become cloze cards on key terms. */
export function makeFlashcards(input, { count = 8, title = '' } = {}) {
  const blocks = toBlocks(input);
  const sents = sentencesFromBlocks(blocks).filter((s) => s.words >= 7 && s.words <= 45);
  if (!sents.length) return [];
  const ranked = rankSentences(sents, { title }).sort((a, b) => b.score - a.score);
  const kws = extractKeywords(blocks, { max: 40, title });
  const cards = [];
  const usedAnswers = new Set();
  const fullText = blocks.map((b) => b.text).join(' ');
  for (const s of ranked) {
    if (cards.length >= count) break;
    const text = s.text.replace(/\s+/g, ' ');
    const m = DEF_RE.exec(text.replace(/[.!]$/, ''));
    if (m && wordCount(m[1]) <= 6 && !/^(it|this|that|these|those|there|he|she|they|we|i|you)$/i.test(m[1].trim())) {
      let subject = m[1].trim();
      const first = subject.split(' ')[0];
      if (/^\p{Lu}\p{Ll}+$/u.test(first) && new RegExp('\\b' + escapeRe(first.toLowerCase()) + '\\b').test(fullText)) subject = first.toLowerCase() + subject.slice(first.length);
      const key = subject.toLowerCase();
      if (!usedAnswers.has(key)) {
        usedAnswers.add(key);
        const verb = m[2].toLowerCase();
        const front = /refers to|means|describes/.test(verb) ? `What does “${subject}” ${verb === 'refers to' ? 'refer to' : verb === 'means' ? 'mean' : 'describe'}?` : `What ${verb} ${subject}?`;
        cards.push({ front, back: text, block: s.block, kind: 'definition' });
        continue;
      }
    }
    const matching = kws.slice(0, 20).filter((k) => !usedAnswers.has(k.text.toLowerCase()) && new RegExp('\\b' + escapeRe(k.text) + '\\b', 'i').test(text));
    // Prefer the longest matching phrase so a cloze never blanks half of a term.
    const lowerText = text.toLowerCase();
    const kw = matching.sort((a, b) => b.text.length - a.text.length).find((k) => !kws.some((o) => o.text.length > k.text.length && o.text.toLowerCase().includes(k.text.toLowerCase()) && lowerText.includes(o.text.toLowerCase())));
    if (!kw) continue;
    usedAnswers.add(kw.text.toLowerCase());
    const re = new RegExp('\\b' + escapeRe(kw.text) + '\\b', 'gi');
    const actual = (text.match(re) || [kw.text])[0];
    cards.push({ front: text.replace(re, '_____'), back: actual, context: text, block: s.block, kind: 'cloze' });
  }
  return cards;
}

/** Seeded shuffle so the same page gives a stable quiz. */
function seededShuffle(arr, seed) {
  const a = [...arr];
  let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Multiple-choice quiz from cloze cards, with distractors drawn from other key terms. */
export function makeQuiz(input, { count = 5, title = '' } = {}) {
  const blocks = toBlocks(input);
  const kws = extractKeywords(blocks, { max: 40, title });
  const cards = makeFlashcards(blocks, { count: count * 3, title }).filter((c) => c.kind === 'cloze');
  const qs = [];
  for (const c of cards) {
    if (qs.length >= count) break;
    const ansWords = wordCount(c.back);
    const pool = kws.map((k) => k.text).filter((t) => t.toLowerCase() !== c.back.toLowerCase() && !c.context.toLowerCase().includes(t.toLowerCase()));
    pool.sort((a, b) => Math.abs(wordCount(a) - ansWords) - Math.abs(wordCount(b) - ansWords));
    const distractors = pool.slice(0, 3);
    if (distractors.length < 2) continue;
    const seed = [...c.front].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) & 0x7fffffff, 7);
    const options = seededShuffle([c.back, ...distractors], seed);
    qs.push({ question: 'Fill in the blank: ' + c.front, options, answer: options.indexOf(c.back), explanation: c.context, block: c.block });
  }
  return qs;
}

// ---- Chunking for map-reduce summarization ----
export function chunkText(text, maxChars = 8000) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const add = (piece) => {
    if (cur && cur.length + piece.length + 2 > maxChars) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + piece;
  };
  for (const p of paras) {
    if (p.length <= maxChars) { add(p); continue; }
    let buf = '';
    for (const s of splitSentences(p)) {
      if (s.length > maxChars) {
        if (buf) { add(buf); buf = ''; }
        for (let i = 0; i < s.length; i += maxChars) add(s.slice(i, i + maxChars));
        continue;
      }
      if (buf && buf.length + s.length + 1 > maxChars) { add(buf); buf = ''; }
      buf += (buf ? ' ' : '') + s;
    }
    if (buf) add(buf);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Compress a long document to its most central sentences, keeping order (for small model contexts). */
export function compressDocument(input, { maxChars = 6000, title = '' } = {}) {
  const blocks = toBlocks(input);
  const full = blocks.map((b) => b.text).join('\n\n');
  if (full.length <= maxChars) return full;
  const sents = sentencesFromBlocks(blocks);
  const ranked = rankSentences(sents, { title }).sort((a, b) => b.score - a.score);
  const keep = new Set();
  let len = 0;
  for (const s of ranked) {
    if (len + s.text.length + 1 > maxChars) continue;
    keep.add(s.index);
    len += s.text.length + 1;
  }
  const out = [];
  let lastBlock = -1;
  for (const s of sents) {
    if (!keep.has(s.index)) continue;
    if (s.block !== lastBlock && out.length) out.push('\n\n');
    else if (out.length) out.push(' ');
    out.push(s.text);
    lastBlock = s.block;
  }
  return out.join('');
}

/** Heuristic simplification for the no-AI fallback: drop asides, split long sentences. */
export function simplifyText(text) {
  const out = [];
  for (const s0 of splitSentences(text)) {
    let s = s0.replace(/\s*\([^)]{0,120}\)/g, '').replace(/\s*\[[^\]]{0,40}\]/g, '').replace(/\s*—[^—]{1,80}—\s*/g, ' ').replace(/\s+([,.;:])/g, '$1');
    if (wordCount(s) > 25) {
      const parts = s.split(/;\s+|,\s+(?=(?:which|while|whereas|although|but|and so)\b)/i);
      s = parts.map((p, i) => {
        let t = p.trim().replace(/^(which|while|whereas|although|but|and so)\s+/i, (m, w) => (w.toLowerCase() === 'which' ? 'This ' : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + ' '));
        t = t.charAt(0).toUpperCase() + t.slice(1);
        if (i < parts.length - 1 && !/[.!?]$/.test(t)) t += '.';
        return t;
      }).join(' ');
    }
    out.push(s);
  }
  return out.join(' ');
}

/** Tokens to highlight for a set of stems (used to mark matching words in output). */
export function highlightTerms(text, stems) {
  const set = stems instanceof Set ? stems : new Set(stems);
  const parts = [];
  const re = /\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+(?:[.,]\p{N}+)*/gu;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const w = normWord(m[0].toLowerCase());
    const st = /^\p{N}/u.test(w) ? w : stem(w);
    if (!STOPWORDS.has(w) && set.has(st)) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index) });
      parts.push({ text: m[0], hit: true });
      last = m.index + m[0].length;
    }
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
