// Library-wide statistics used by the tag suggester: document frequencies (for IDF)
// and the vocabulary of tags already in use.
import { kvGet, kvSet, getAllTexts } from './db.js';
import { buildCorpus, suggestTags } from './tagger.js';
import { getAllMeta } from './meta.js';

const MAX_AGE = 12 * 60 * 60 * 1000;

function flatten(nodes, out = []) {
  for (const n of nodes) { if (n.url) out.push(n); if (n.children) flatten(n.children, out); }
  return out;
}

export async function rebuildCorpus({ includeTexts = true } = {}) {
  const [tree, metas] = await Promise.all([chrome.bookmarks.getTree(), getAllMeta()]);
  const texts = new Map();
  if (includeTexts) { try { for (const t of await getAllTexts()) texts.set(t.id, t.text.slice(0, 20000)); } catch { /* no texts */ } }
  const docs = flatten(tree).map(b => {
    const m = metas.get(b.id) || {};
    let path = '';
    try { path = decodeURIComponent(new URL(b.url).pathname).replace(/[-_/.]+/g, ' '); } catch { /* ignore */ }
    return `${b.title} ${path} ${(m.tags || []).join(' ')} ${texts.get(b.id) || ''}`;
  });
  const corpus = buildCorpus(docs);
  try { await kvSet('corpus', corpus); } catch { /* storage unavailable */ }
  return corpus;
}

export async function getCorpus() {
  try {
    const c = await kvGet('corpus');
    if (c && Date.now() - c.builtAt < MAX_AGE) return c;
  } catch { /* fall through */ }
  return rebuildCorpus({ includeTexts: false });
}

export async function getTagVocab(metas) {
  metas = metas || await getAllMeta();
  const vocab = new Map();
  for (const m of metas.values()) for (const t of m.tags || []) vocab.set(t, (vocab.get(t) || 0) + 1);
  return vocab;
}

export async function suggestForPage(page, limit = 8) {
  const [corpus, vocab] = await Promise.all([getCorpus(), getTagVocab()]);
  return suggestTags(page, corpus, vocab, limit);
}
