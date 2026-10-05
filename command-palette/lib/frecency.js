// Frecency: learns which results the user picks, and for which queries.
// Item score follows the Firefox model: recent picks count more, frequent picks add up.
// A second table remembers query -> picked item so the same query ranks it first next time.

const STORE_KEY = 'frecency';
const MAX_ITEMS = 1500;
const MAX_QUERIES = 600;
const MAX_STAMPS = 10;
const DAY = 86400000;

let data = null;
let loading = null;
let saveTimer = null;

async function ensure() {
  if (data) return data;
  if (!loading) {
    loading = chrome.storage.local.get(STORE_KEY).then(r => {
      data = r[STORE_KEY] || { items: {}, queries: {} };
      if (!data.items) data.items = {};
      if (!data.queries) data.queries = {};
      return data;
    });
  }
  return loading;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORE_KEY]: data }).catch(() => {});
  }, 400);
}

function weightFor(age) {
  if (age < 4 * DAY) return 100;
  if (age < 14 * DAY) return 70;
  if (age < 31 * DAY) return 50;
  if (age < 90 * DAY) return 30;
  return 10;
}

function rawScore(entry, now) {
  if (!entry || !entry.t || !entry.t.length) return 0;
  let sum = 0;
  for (const ts of entry.t) sum += weightFor(now - ts);
  return entry.c * (sum / entry.t.length);
}

function normQuery(q) {
  return (q || '').trim().toLowerCase().slice(0, 40);
}

/** Load into memory; returns a scorer snapshot for one search. */
export async function snapshot() {
  await ensure();
  const now = Date.now();
  return {
    /** Boost (0..~45) for an item key. */
    item(key) {
      const s = rawScore(data.items[key], now);
      return s ? 12 * Math.log(1 + s / 40) : 0;
    },
    /** Boost for (query, key): exact past query or a prefix of it. */
    query(q, key) {
      q = normQuery(q);
      if (!q) return 0;
      let best = 0;
      const exact = data.queries[q];
      if (exact && exact[key]) best = 40 + Math.min(exact[key], 5) * 6;
      return best;
    },
    raw(key) { return rawScore(data.items[key], now); },
  };
}

/** Record that the user picked `key` after typing `query`. */
export async function record(key, query) {
  await ensure();
  const now = Date.now();
  const e = data.items[key] || (data.items[key] = { c: 0, t: [] });
  e.c++;
  e.t.push(now);
  if (e.t.length > MAX_STAMPS) e.t.splice(0, e.t.length - MAX_STAMPS);
  const q = normQuery(query);
  if (q) {
    // Remember for the query and its prefixes of length >= 2 (typing "gm" -> Gmail).
    for (let n = Math.min(q.length, 12); n >= Math.min(2, q.length); n--) {
      const p = q.slice(0, n);
      const row = data.queries[p] || (data.queries[p] = {});
      row[key] = (row[key] || 0) + 1;
      row._t = now;
    }
  }
  prune(now);
  scheduleSave();
}

function prune(now) {
  const keys = Object.keys(data.items);
  if (keys.length > MAX_ITEMS) {
    keys.sort((a, b) => rawScore(data.items[a], now) - rawScore(data.items[b], now));
    for (const k of keys.slice(0, keys.length - MAX_ITEMS)) delete data.items[k];
  }
  const qs = Object.keys(data.queries);
  if (qs.length > MAX_QUERIES) {
    qs.sort((a, b) => (data.queries[a]._t || 0) - (data.queries[b]._t || 0));
    for (const k of qs.slice(0, qs.length - MAX_QUERIES)) delete data.queries[k];
  }
}

/** Keys ordered by frecency, for empty-query suggestions. */
export async function top(n, prefix) {
  await ensure();
  const now = Date.now();
  return Object.keys(data.items)
    .filter(k => !prefix || k.startsWith(prefix))
    .map(k => [k, rawScore(data.items[k], now)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(x => x[0]);
}

export async function clear() {
  data = { items: {}, queries: {} };
  await chrome.storage.local.set({ [STORE_KEY]: data });
}

export async function stats() {
  await ensure();
  return { items: Object.keys(data.items).length, queries: Object.keys(data.queries).length };
}

export function invalidate() { data = null; loading = null; }
