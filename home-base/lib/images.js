// User background photos, stored as Blobs in IndexedDB (too large for chrome.storage).
const DB = 'home-base';
const STORE = 'images';
const MAX_EDGE = 2560;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Downscale very large photos so storage stays reasonable; returns { blob, thumb }. */
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  let blob = file;
  if (scale < 1 || file.size > 4 * 1024 * 1024) {
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  }
  const ts = 240 / Math.max(bmp.width, bmp.height);
  const tc = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * ts)), Math.max(1, Math.round(bmp.height * ts)));
  tc.getContext('2d').drawImage(bmp, 0, 0, tc.width, tc.height);
  const thumb = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  bmp.close();
  return { blob, thumb };
}

export async function addImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
  const { blob, thumb } = await prepare(file);
  const rec = { id: `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: file.name, added: Date.now(), blob, thumb };
  await tx('readwrite', (s) => s.put(rec));
  return rec;
}

/** List image records without loading full blobs into callers that only need thumbs. */
export async function listImages() {
  return (await tx('readonly', (s) => req2p(s.getAll()))) || [];
}

export async function getImage(id) {
  return tx('readonly', (s) => req2p(s.get(id)));
}

export async function imageIds() {
  const keys = (await tx('readonly', (s) => req2p(s.getAllKeys()))) || [];
  return keys.sort();
}

export async function deleteImage(id) {
  await tx('readwrite', (s) => s.delete(id));
}

export async function clearImages() {
  await tx('readwrite', (s) => s.clear());
}
