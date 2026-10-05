// IndexedDB storage with a hand-rolled inverted index.
//
// Stores
//   docs      {id, url, title, domain, firstVisit, lastVisit, visits, len, bytes, hash}  (small, cached for ranking)
//   texts     {id, text}                                                             (page text, loaded on demand)
//   postings  key [term, docId] -> {t, d, f}                                         (term frequency per doc)
//   meta      'stats' -> {docs, totalLen, bytes, version}
import { tokenize, hash as hashText } from './tokenizer.js';
import { hostOf } from './util.js';

const DB_NAME = 'total-recall';
const DB_VERSION = 1;
const TITLE_WEIGHT = 3;
const URL_WEIGHT = 2;
const MAX_UNIQUE_TERMS = 6000;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const docs = db.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
      docs.createIndex('url', 'url', { unique: true });
      docs.createIndex('lastVisit', 'lastVisit');
      docs.createIndex('domain', 'domain');
      db.createObjectStore('texts', { keyPath: 'id' });
      const postings = db.createObjectStore('postings', { keyPath: ['t', 'd'] });
      postings.createIndex('d', 'd');
      db.createObjectStore('meta');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('Total Recall: database upgrade blocked by another tab');
  });
  return dbPromise;
}

export const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });

const EMPTY_STATS = { docs: 0, totalLen: 0, bytes: 0, version: 0 };

export async function getStats() {
  const db = await openDb();
  const s = await req(db.transaction('meta').objectStore('meta').get('stats'));
  return { ...EMPTY_STATS, ...(s || {}) };
}

/** Build weighted term frequencies for a page. */
function termFrequencies(page) {
  const tf = new Map();
  const add = (terms, w) => { for (const t of terms) tf.set(t, (tf.get(t) || 0) + w); };
  add(tokenize(page.title || ''), TITLE_WEIGHT);
  let urlText = '';
  try { const u = new URL(page.url); urlText = u.hostname.replace(/^www\./, '') + ' ' + decodeURIComponent(u.pathname); } catch { /* ignore */ }
  add(tokenize(urlText.replace(/[-_./]+/g, ' ')), URL_WEIGHT);
  const bodyTerms = tokenize(page.text || '');
  add(bodyTerms, 1);
  let entries = [...tf.entries()];
  if (entries.length > MAX_UNIQUE_TERMS) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_UNIQUE_TERMS);
  let len = 0;
  for (const [, f] of entries) len += f;
  return { entries, len };
}

function estimateBytes(page, termCount) {
  return (page.text || '').length * 2 + (page.title || '').length * 2 + page.url.length * 2 + termCount * 24 + 200;
}

function deletePostingsFor(postings, id) {
  return new Promise((resolve, reject) => {
    const r = postings.index('d').openKeyCursor(IDBKeyRange.only(id));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve();
      postings.delete(c.primaryKey);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

/**
 * Insert or update a page. page = {url, title, text, visitedAt?, firstVisit?, visits?}
 * Returns {status: 'added'|'updated'|'touched', id}.
 */
export async function upsertPage(page, { countVisit = true } = {}) {
  const now = page.visitedAt || Date.now();
  const text = page.text || '';
  const h = hashText((page.title || '') + '\n' + text);
  const { entries, len } = termFrequencies(page);
  const db = await openDb();
  const tx = db.transaction(['docs', 'texts', 'postings', 'meta'], 'readwrite');
  const docs = tx.objectStore('docs'), texts = tx.objectStore('texts'), postings = tx.objectStore('postings'), meta = tx.objectStore('meta');
  const stats = { ...EMPTY_STATS, ...((await req(meta.get('stats'))) || {}) };
  const existing = await req(docs.index('url').get(page.url));
  let status, id;
  if (existing && existing.hash === h) {
    existing.lastVisit = Math.max(existing.lastVisit, now);
    if (page.firstVisit) existing.firstVisit = Math.min(existing.firstVisit, page.firstVisit);
    if (countVisit && now - (existing.lastVisitCounted || 0) > 30 * 60000) { existing.visits++; existing.lastVisitCounted = now; }
    if (page.visits) existing.visits = Math.max(existing.visits, page.visits);
    docs.put(existing);
    id = existing.id; status = 'touched';
  } else {
    const bytes = estimateBytes(page, entries.length);
    const doc = {
      url: page.url,
      title: (page.title || '').slice(0, 500),
      domain: hostOf(page.url),
      firstVisit: existing ? existing.firstVisit : (page.firstVisit || now),
      lastVisit: existing ? Math.max(existing.lastVisit, now) : now,
      lastVisitCounted: now,
      visits: existing ? existing.visits + (countVisit && now - (existing.lastVisitCounted || 0) > 30 * 60000 ? 1 : 0) : (page.visits || 1),
      len, bytes, hash: h,
    };
    if (existing) {
      doc.id = existing.id;
      await deletePostingsFor(postings, existing.id);
      stats.totalLen -= existing.len; stats.bytes -= existing.bytes;
      status = 'updated';
    } else {
      stats.docs += 1;
      status = 'added';
    }
    id = await req(docs.put(doc));
    texts.put({ id, text });
    for (const [t, f] of entries) postings.put({ t, d: id, f });
    stats.totalLen += len; stats.bytes += bytes;
  }
  stats.version = (stats.version || 0) + 1;
  meta.put(stats, 'stats');
  await done(tx);
  return { status, id };
}

/** Delete documents by id. */
export async function deleteDocs(ids) {
  if (!ids.length) return 0;
  const db = await openDb();
  const tx = db.transaction(['docs', 'texts', 'postings', 'meta'], 'readwrite');
  const docs = tx.objectStore('docs'), texts = tx.objectStore('texts'), postings = tx.objectStore('postings'), meta = tx.objectStore('meta');
  const stats = { ...EMPTY_STATS, ...((await req(meta.get('stats'))) || {}) };
  let n = 0;
  for (const id of ids) {
    const doc = await req(docs.get(id));
    if (!doc) continue;
    docs.delete(id); texts.delete(id);
    await deletePostingsFor(postings, id);
    stats.docs -= 1; stats.totalLen -= doc.len; stats.bytes -= doc.bytes;
    n++;
  }
  stats.docs = Math.max(0, stats.docs); stats.totalLen = Math.max(0, stats.totalLen); stats.bytes = Math.max(0, stats.bytes);
  stats.version = (stats.version || 0) + 1;
  meta.put(stats, 'stats');
  await done(tx);
  return n;
}

export async function getAllDocs() {
  const db = await openDb();
  return req(db.transaction('docs').objectStore('docs').getAll());
}

export async function getDocByUrl(url) {
  const db = await openDb();
  return req(db.transaction('docs').objectStore('docs').index('url').get(url));
}

export async function getTexts(ids) {
  const db = await openDb();
  const store = db.transaction('texts').objectStore('texts');
  const out = new Map();
  await Promise.all(ids.map(id => req(store.get(id)).then(r => { if (r) out.set(id, r.text); })));
  return out;
}

/** Postings for an exact term: [{d, f}] */
export async function postingsFor(term) {
  const db = await openDb();
  return req(db.transaction('postings').objectStore('postings').getAll(IDBKeyRange.bound([term, -Infinity], [term, Infinity])));
}

/** Postings for all terms that start with prefix (capped). */
export async function postingsForPrefix(prefix, cap = 20000) {
  const db = await openDb();
  return req(db.transaction('postings').objectStore('postings').getAll(IDBKeyRange.bound([prefix, -Infinity], [prefix + '￿', Infinity]), cap));
}

/** Ids of docs whose domain equals or is a subdomain of `site`. */
export async function idsForDomain(site) {
  const db = await openDb();
  const idx = db.transaction('docs').objectStore('docs').index('domain');
  const ids = [];
  await new Promise((resolve, reject) => {
    const r = idx.openKeyCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve();
      if (c.key === site || String(c.key).endsWith('.' + site)) ids.push(c.primaryKey);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
  return ids;
}

/** Ids of docs last visited before `t`. */
export async function idsOlderThan(t) {
  const db = await openDb();
  return req(db.transaction('docs').objectStore('docs').index('lastVisit').getAllKeys(IDBKeyRange.upperBound(t, true)));
}

/** Oldest-first doc ids with their byte estimates, for storage-cap pruning. */
export async function oldestDocs(limit) {
  const db = await openDb();
  const idx = db.transaction('docs').objectStore('docs').index('lastVisit');
  const out = [];
  await new Promise((resolve, reject) => {
    const r = idx.openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c || out.length >= limit) return resolve();
      out.push({ id: c.value.id, bytes: c.value.bytes });
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
  return out;
}

export async function wipe() {
  const db = await openDb();
  const tx = db.transaction(['docs', 'texts', 'postings', 'meta'], 'readwrite');
  for (const s of ['docs', 'texts', 'postings', 'meta']) tx.objectStore(s).clear();
  tx.objectStore('meta').put({ ...EMPTY_STATS, version: Date.now() }, 'stats');
  await done(tx);
}

/** Iterate every page with its text in batches, for export. */
export async function exportPages(onBatch, batchSize = 200) {
  const docs = (await getAllDocs()).sort((a, b) => a.lastVisit - b.lastVisit);
  for (let i = 0; i < docs.length; i += batchSize) {
    const slice = docs.slice(i, i + batchSize);
    const texts = await getTexts(slice.map(d => d.id));
    onBatch(slice.map(d => ({
      url: d.url, title: d.title, text: texts.get(d.id) || '',
      firstVisit: d.firstVisit, lastVisit: d.lastVisit, visits: d.visits,
    })), i + slice.length, docs.length);
  }
  return docs.length;
}
