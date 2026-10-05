// IndexedDB storage for snapshot history (can be large, so it lives outside chrome.storage).
// Snapshot: { id, monitorId, ts, text, met, added, removed, baseline? }

const DB_NAME = 'page-watch';
const DB_VERSION = 1;
const STORE = 'snapshots';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('monitor_ts', ['monitorId', 'ts']);
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

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function rangeFor(monitorId) {
  return IDBKeyRange.bound([monitorId, -Infinity], [monitorId, Infinity]);
}

export async function addSnapshot(snap) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const req = tx.objectStore(STORE).add(snap);
  await done(tx);
  return { ...snap, id: req.result };
}

/** All snapshots for a monitor, newest first. Pass withText=false to skip large bodies. */
export async function listSnapshots(monitorId, { withText = true, limit = Infinity } = {}) {
  const db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const idx = tx.objectStore(STORE).index('monitor_ts');
  const out = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(rangeFor(monitorId), 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve();
      const v = cur.value;
      out.push(withText ? v : { ...v, text: undefined, length: v.text ? v.text.length : 0 });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function latestSnapshot(monitorId) {
  const [s] = await listSnapshots(monitorId, { limit: 1 });
  return s || null;
}

export async function getSnapshot(id) {
  const db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).get(id);
  await done(tx);
  return req.result || null;
}

/** Keep only the newest `keep` snapshots of a monitor. */
export async function pruneSnapshots(monitorId, keep) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const idx = tx.objectStore(STORE).index('monitor_ts');
  let seen = 0;
  const req = idx.openCursor(rangeFor(monitorId), 'prev');
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    seen++;
    if (seen > keep) cur.delete();
    cur.continue();
  };
  await done(tx);
}

export async function deleteSnapshots(monitorId) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const idx = tx.objectStore(STORE).index('monitor_ts');
  const req = idx.openCursor(rangeFor(monitorId));
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    cur.delete();
    cur.continue();
  };
  await done(tx);
}

export async function countSnapshots() {
  const db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).count();
  await done(tx);
  return req.result;
}
