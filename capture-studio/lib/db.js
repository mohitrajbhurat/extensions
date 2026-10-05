// IndexedDB storage shared by the service worker and every extension page.
// Stores:
//   shots          { id, created, title, url, width, height, kind, thumb (Blob), doc (annotations) }
//   shotBlobs      { id, blob }  original screenshot image
//   recordings     { id, created, name, durationMs, size, mimeType, width, height, mode, hasAudio, thumb (Blob) }
//   recordingBlobs { id, blob }  the WebM video
const DB_NAME = 'capture-studio';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['shots', 'shotBlobs', 'recordings', 'recordingBlobs']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
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
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function newId(prefix = '') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rand[0].toString(36) + rand[1].toString(36);
}

async function putPair(metaStore, blobStore, meta, blob) {
  const db = await openDb();
  const tx = db.transaction([metaStore, blobStore], 'readwrite');
  tx.objectStore(metaStore).put(meta);
  if (blob) tx.objectStore(blobStore).put({ id: meta.id, blob });
  await done(tx);
  return meta;
}

async function getOne(store, id) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).get(id));
}

async function getAll(store) {
  const db = await openDb();
  const rows = await request(db.transaction(store).objectStore(store).getAll());
  return rows.sort((a, b) => b.created - a.created);
}

async function deletePair(metaStore, blobStore, id) {
  const db = await openDb();
  const tx = db.transaction([metaStore, blobStore], 'readwrite');
  tx.objectStore(metaStore).delete(id);
  tx.objectStore(blobStore).delete(id);
  await done(tx);
}

async function patch(store, id, changes) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  const cur = await request(os.get(id));
  if (!cur) throw new Error('Not found');
  const next = { ...cur, ...changes };
  os.put(next);
  await done(tx);
  return next;
}

// Screenshots
export const putShot = (meta, blob) => putPair('shots', 'shotBlobs', meta, blob);
export const getShot = id => getOne('shots', id);
export const getShotBlob = async id => (await getOne('shotBlobs', id))?.blob || null;
export const listShots = () => getAll('shots');
export const deleteShot = id => deletePair('shots', 'shotBlobs', id);
export const updateShot = (id, changes) => patch('shots', id, changes);

// Recordings
export const putRecording = (meta, blob) => putPair('recordings', 'recordingBlobs', meta, blob);
export const getRecording = id => getOne('recordings', id);
export const getRecordingBlob = async id => (await getOne('recordingBlobs', id))?.blob || null;
export const listRecordings = () => getAll('recordings');
export const deleteRecording = id => deletePair('recordings', 'recordingBlobs', id);
export const updateRecording = (id, changes) => patch('recordings', id, changes);
