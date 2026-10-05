// Small IndexedDB wrapper. Stores:
//   texts: { id, text, words, savedAt }   saved page text for full-text search
//   kv:    arbitrary values by key (health report, tag corpus cache)
const DB_NAME = 'smart-bookmarks';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
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

function run(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const r = fn(os);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const kvGet = key => run('kv', 'readonly', os => os.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', os => os.put(value, key));
export const kvDelete = key => run('kv', 'readwrite', os => os.delete(key));

export const getText = id => run('texts', 'readonly', os => os.get(String(id)));
export const getAllTexts = () => run('texts', 'readonly', os => os.getAll());
export const deleteText = id => run('texts', 'readwrite', os => os.delete(String(id)));
export const clearTexts = () => run('texts', 'readwrite', os => os.clear());

export function putText(id, text, words) {
  const rec = { id: String(id), text: String(text || '').slice(0, 60000), words: words || 0, savedAt: Date.now() };
  return run('texts', 'readwrite', os => os.put(rec)).then(() => rec);
}

export function deleteTexts(ids) {
  if (!ids.length) return Promise.resolve();
  return run('texts', 'readwrite', os => { for (const id of ids) os.delete(String(id)); });
}

export function putTexts(records) {
  if (!records.length) return Promise.resolve();
  return run('texts', 'readwrite', os => { for (const r of records) os.put(r); });
}
