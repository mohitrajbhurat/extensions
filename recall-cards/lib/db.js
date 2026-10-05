// IndexedDB storage for decks, cards and the review log. Shared by the service worker and extension pages.
import { newCardState } from './fsrs.js';
import { clozeNumbers, hasCloze } from './cloze.js';

const DB_NAME = 'recall-cards';
const DB_VERSION = 1;
let dbPromise = null;

export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36).slice(0, 4);
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('deckId', 'deckId');
        s.createIndex('noteId', 'noteId');
        s.createIndex('due', 'due');
      }
      if (!db.objectStoreNames.contains('revlog')) {
        const s = db.createObjectStore('revlog', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
        s.createIndex('cardId', 'cardId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const promisify = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    Promise.resolve(fn(t)).then(r => { result = r; }, e => { try { t.abort(); } catch {} reject(e); });
  });
}

export async function getAll(store) {
  return tx([store], 'readonly', t => promisify(t.objectStore(store).getAll()));
}
export async function get(store, id) {
  return tx([store], 'readonly', t => promisify(t.objectStore(store).get(id)));
}
export async function putMany(store, items) {
  if (!items.length) return;
  return tx([store], 'readwrite', t => { const s = t.objectStore(store); for (const it of items) s.put(it); });
}
export async function deleteMany(store, ids) {
  if (!ids.length) return;
  return tx([store], 'readwrite', t => { const s = t.objectStore(store); for (const id of ids) s.delete(id); });
}

// -------- change notification (pages + service worker refresh badge / views) --------
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('recall-cards') : null;
export function notifyChanged(what = 'cards') {
  try { channel && channel.postMessage({ type: 'changed', what }); } catch {}
  try { chrome.runtime.sendMessage({ type: 'dataChanged', what }).catch(() => {}); } catch {}
}
export function onChanged(fn) {
  if (channel) channel.addEventListener('message', e => { if (e.data?.type === 'changed') fn(e.data.what); });
}

// -------- decks --------
export async function listDecks() {
  const decks = await getAll('decks');
  return decks.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function ensureDefaultDeck() {
  const decks = await listDecks();
  if (decks.length) return decks;
  await putMany('decks', [{ id: 'default', name: 'Default', created: Date.now() }]);
  return listDecks();
}

export async function createDeck(name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw new Error('Deck name is required.');
  const decks = await listDecks();
  const existing = decks.find(d => d.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const deck = { id: uid('d'), name: clean, created: Date.now() };
  await putMany('decks', [deck]);
  notifyChanged('decks');
  return deck;
}

export async function deckByName(name, cache) {
  const clean = String(name || '').trim() || 'Default';
  const key = clean.toLowerCase();
  if (cache && cache.has(key)) return cache.get(key);
  const deck = await createDeck(clean);
  if (cache) cache.set(key, deck);
  return deck;
}

export async function renameDeck(id, name) {
  const deck = await get('decks', id);
  if (!deck) throw new Error('Deck not found.');
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Deck name is required.');
  deck.name = clean.slice(0, 120);
  await putMany('decks', [deck]);
  notifyChanged('decks');
}

export async function deleteDeck(id) {
  const cards = await getAll('cards');
  const ids = cards.filter(c => c.deckId === id).map(c => c.id);
  await deleteMany('cards', ids);
  await deleteMany('decks', [id]);
  await ensureDefaultDeck();
  notifyChanged('decks');
}

// -------- cards --------

/**
 * Creates the cards for one note. Basic notes produce one card; cloze notes one card per cloze number.
 * note: {type?, front, back, deckId, tags, source:{url,title}}
 */
export function cardsFromNote(note, now = Date.now()) {
  const noteId = note.noteId || uid('n');
  const type = note.type === 'cloze' || (note.type !== 'basic' && hasCloze(note.front)) ? 'cloze' : 'basic';
  const base = {
    noteId, deckId: note.deckId || 'default', type,
    front: String(note.front || ''), back: String(note.back || ''),
    tags: Array.isArray(note.tags) ? [...new Set(note.tags.map(String).filter(Boolean))] : [],
    source: note.source && note.source.url ? { url: String(note.source.url), title: String(note.source.title || '') } : null,
    created: now, modified: now, suspended: false,
  };
  if (type === 'cloze') {
    const nums = clozeNumbers(base.front);
    if (!nums.length) throw new Error('Cloze text needs at least one {{c1::…}} deletion.');
    return nums.map((n, i) => ({ ...base, ...newCardState(now), id: uid('c'), clozeIndex: n, created: now + i }));
  }
  if (!base.front.trim()) throw new Error('Front side is empty.');
  return [{ ...base, ...newCardState(now), id: uid('c'), clozeIndex: 0 }];
}

export async function addNote(note) {
  const cards = cardsFromNote(note);
  await putMany('cards', cards);
  notifyChanged('cards');
  return cards;
}

/**
 * Updates the content of a note (all sibling cards). For cloze notes, adds cards for new cloze numbers
 * and removes cards whose number disappeared; scheduling of surviving cards is kept.
 */
export async function updateNote(card, patch) {
  const all = await getAll('cards');
  const siblings = all.filter(c => (card.noteId ? c.noteId === card.noteId : c.id === card.id));
  const now = Date.now();
  const front = patch.front ?? card.front;
  const type = hasCloze(front) ? 'cloze' : 'basic';
  const shared = { front, back: patch.back ?? card.back, deckId: patch.deckId ?? card.deckId, tags: patch.tags ?? card.tags, source: patch.source !== undefined ? patch.source : card.source, modified: now, type };
  const put = [];
  const del = [];
  if (type === 'cloze') {
    const nums = clozeNumbers(front);
    const byNum = new Map(siblings.map(c => [c.type === 'cloze' ? c.clozeIndex : 1, c]));
    for (const n of nums) {
      const existing = byNum.get(n);
      if (existing) put.push({ ...existing, ...shared, clozeIndex: n });
      else put.push({ ...siblings[0], ...shared, ...newCardState(now), id: uid('c'), clozeIndex: n, created: now, suspended: false });
    }
    for (const c of siblings) if (!put.find(p => p.id === c.id)) del.push(c.id);
  } else {
    const keep = siblings.find(c => c.id === card.id) || siblings[0];
    put.push({ ...keep, ...shared, clozeIndex: 0 });
    for (const c of siblings) if (c.id !== keep.id) del.push(c.id);
  }
  await putMany('cards', put);
  await deleteMany('cards', del);
  notifyChanged('cards');
  return put;
}

export async function saveCards(cards) {
  await putMany('cards', cards);
  notifyChanged('cards');
}

export async function deleteCards(ids) {
  await deleteMany('cards', ids);
  notifyChanged('cards');
}

// -------- review log --------
export async function addRevlog(entry) {
  const e = { id: uid('r'), ...entry };
  await putMany('revlog', [e]);
  return e;
}

/** Stores the updated card and its log entry atomically. */
export async function recordReview(card, logEntry) {
  const entry = { id: uid('r'), ...logEntry };
  await tx(['cards', 'revlog'], 'readwrite', t => {
    t.objectStore('cards').put(card);
    t.objectStore('revlog').put(entry);
  });
  notifyChanged('review');
  return entry;
}

/** Restores a card's previous state and removes its log entry (undo). */
export async function undoReview(prevCard, logId) {
  await tx(['cards', 'revlog'], 'readwrite', t => {
    t.objectStore('cards').put(prevCard);
    t.objectStore('revlog').delete(logId);
  });
  notifyChanged('review');
}

export async function revlogSince(ts) {
  return tx(['revlog'], 'readonly', t => promisify(t.objectStore('revlog').index('ts').getAll(IDBKeyRange.lowerBound(ts))));
}

/** Replace or merge a full backup. */
export async function importBackup({ decks, cards, revlog }, replace = false) {
  await tx(['decks', 'cards', 'revlog'], 'readwrite', t => {
    if (replace) { t.objectStore('decks').clear(); t.objectStore('cards').clear(); t.objectStore('revlog').clear(); }
    for (const d of decks) if (d && d.id && d.name) t.objectStore('decks').put(d);
    for (const c of cards) if (c && c.id && typeof c.front === 'string') t.objectStore('cards').put(c);
    for (const r of revlog) if (r && r.id && r.cardId) t.objectStore('revlog').put(r);
  });
  await ensureDefaultDeck();
  notifyChanged('all');
}
