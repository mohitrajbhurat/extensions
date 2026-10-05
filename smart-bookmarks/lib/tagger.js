// Tag suggestion via TF-IDF. Document frequencies come from the user's library
// (titles, URLs, tags and saved page text), so terms that appear everywhere in the
// library score low and distinctive terms score high.
import { normalizeTag } from './meta.js';

const STOP = new Set(`a about above across after again against all almost alone along already also although always am among an and another any anybody anyone anything anywhere are aren't around as at back be became because become becomes been before behind being below between both but by can cannot can't could couldn't did didn't do does doesn't doing done don't down during each either else enough etc even ever every everyone everything everywhere few find first for four from full further get gets getting give given go goes going gone got had hadn't has hasn't have haven't having he her here hers herself him himself his how however i if in into is isn't it its it's itself just keep kept know known last least less let like likely made make makes many may me might mine more most mostly much must my myself near need needs neither never new next no nobody none nor not nothing now nowhere of off often on once one only onto or other others otherwise our ours ourselves out over own part per perhaps please put quite rather really said same say says see seem seemed seems several shall she should shouldn't show side since so some somebody someone something sometimes somewhere still such take than that that's the their theirs them themselves then there therefore these they they're thing things think this those though three through thus to together too took toward towards two under until up upon us use used uses using very via want wants was wasn't way we well went were weren't what whatever when whenever where whether which while who whoever whole whom whose why will with within without won't would wouldn't yes yet you your yours yourself yourselves also been being de la le les el en un une des und der die das et il est du al lo los las del por para con que per http https www com org net html htm php aspx index amp nbsp href src img jpg jpeg png gif svg webp pdf utm ref page pages home site website web online official click here read more learn sign login log account accounts register subscribe newsletter cookie cookies privacy policy terms service services menu search share follow contact copyright rights reserved skip content main navigation toggle close open loading javascript enable browser free best top latest today day days week weeks month months year years time times new news post posts article articles blog www2 just via thing know make get got like one two three first second view views video videos image images photo photos comment comments reply com's de's`.split(/\s+/));

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#.]*[\p{L}\p{N}+#]|[\p{L}]/gu;

export function tokenize(text) {
  const out = [];
  const m = String(text || '').toLowerCase().match(WORD_RE);
  if (!m) return out;
  for (let w of m) {
    w = w.replace(/\.+$/, '');
    if (w.length < 3 || w.length > 24) continue;
    if (STOP.has(w)) continue;
    if (/^\d+([.,]\d+)*$/.test(w)) continue;      // numbers
    if (/^[0-9a-f]{8,}$/.test(w)) continue;        // hashes / ids
    if ((w.match(/\d/g) || []).length > w.length / 2) continue;
    if (w.includes('.') && !/^[a-z]+\.(js|net|io)$/.test(w)) continue; // filenames, domains (but keep node.js etc)
    out.push(w);
  }
  return out;
}

export function urlTokens(url) {
  try {
    const u = new URL(url);
    const hostParts = u.hostname.replace(/^www\./, '').split('.');
    const site = hostParts.length > 1 ? hostParts[hostParts.length - 2] : hostParts[0];
    const path = decodeURIComponent(u.pathname).replace(/[-_/.]+/g, ' ');
    return { site, tokens: tokenize(path) };
  } catch { return { site: '', tokens: [] }; }
}

// docs: iterable of strings (one per bookmark). Returns { N, df: {term: count} }.
export function buildCorpus(docs, maxTerms = 30000) {
  const df = new Map();
  let N = 0;
  for (const d of docs) {
    N++;
    for (const t of new Set(tokenize(d))) df.set(t, (df.get(t) || 0) + 1);
  }
  let entries = [...df];
  if (entries.length > maxTerms) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, maxTerms);
  return { N, df: Object.fromEntries(entries), builtAt: Date.now() };
}

const GENERIC_SITES = new Set(['google', 'blogspot', 'wordpress', 'medium', 'substack', 'github', 'gitlab', 'co', 'com', 'org', 'net', 'io']);

// page: { title, description, keywords, text, url }
// corpus: { N, df } ; vocab: Map(tag -> usage count) of tags already in the library
export function suggestTags(page, corpus = { N: 0, df: {} }, vocab = new Map(), limit = 8) {
  const weights = new Map();
  let total = 0;
  const add = (tokens, w) => { for (const t of tokens) { weights.set(t, (weights.get(t) || 0) + w); total += w; } };
  const title = String(page.title || '').replace(/\s[|\-–—:·•]\s[^|\-–—:·•]{1,40}$/, ''); // drop " - Site Name"
  add(tokenize(title), 4);
  add(tokenize(page.description), 2);
  const bodyTokens = tokenize(String(page.text || '').slice(0, 30000));
  add(bodyTokens, 1);
  const { site, tokens: pathTokens } = urlTokens(page.url);
  add(pathTokens, 1.5);

  // Merge simple plurals into singular when both appear.
  for (const t of [...weights.keys()]) {
    if (t.endsWith('s') && !t.endsWith('ss')) {
      const sing = t.slice(0, -1);
      if (weights.has(sing)) { weights.set(sing, weights.get(sing) + weights.get(t)); weights.delete(t); }
    }
  }

  const N = Math.max(1, corpus.N || 0);
  const df = corpus.df || {};
  const scores = new Map();
  const titleSet = new Set(tokenize(title));
  for (const [t, w] of weights) {
    const tf = w / Math.max(1, total);
    const idf = Math.log((N + 1) / ((df[t] || 0) + 1)) + 1;
    let s = tf * idf;
    if (vocab.has(t)) s *= 1.8;                  // prefer tags the user already uses
    if (titleSet.has(t)) s *= 1.3;
    if (w < 2 && !titleSet.has(t)) s *= 0.5;     // single passing mention
    scores.set(t, s);
  }

  // Meta keywords are author-provided tags: strong candidates.
  const maxScore = Math.max(0.0001, ...scores.values());
  const kw = String(page.keywords || '').split(/[,;]/).map(k => k.trim()).filter(k => k && k.length <= 30 && k.split(/\s+/).length <= 3);
  for (const k of kw.slice(0, 12)) {
    const n = normalizeTag(k);
    if (!n || n.length < 2 || STOP.has(n)) continue;
    scores.set(n, Math.max(scores.get(n) || 0, maxScore * (vocab.has(n) ? 1.2 : 0.9)));
  }

  // Existing library tags that appear in the title / description get a strong boost.
  const head = (title + ' ' + (page.description || '')).toLowerCase();
  for (const tag of vocab.keys()) {
    if (tag.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${tag.replace(/[.+#]/g, '\\$&').replace(/-/g, '[- ]')}($|[^\\p{L}\\p{N}])`, 'u').test(head)) {
      scores.set(tag, Math.max(scores.get(tag) || 0, maxScore * 1.1));
    }
  }

  if (site && site.length >= 3 && !GENERIC_SITES.has(site) && !STOP.has(site)) {
    scores.set(site, Math.max(scores.get(site) || 0, maxScore * 0.35));
  }

  return [...scores]
    .filter(([t]) => normalizeTag(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => normalizeTag(t))
    .filter((t, i, a) => a.indexOf(t) === i);
}
