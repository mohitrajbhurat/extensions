// IndexedDB storage for videos, notes and bookmarks. Used by the service worker and
// extension pages (all share the extension origin). Every write is announced on the
// "vs-db" BroadcastChannel so open pages refresh.

const DB_NAME = 'video-studio';
const DB_VERSION = 1;
let dbPromise = null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vs-db') : null;

function announce(detail) {
  try { channel && channel.postMessage(Object.assign({ at: Date.now() }, detail)); } catch (_) { /* closed */ }
}

export function onDbChange(fn) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel('vs-db');
  ch.onmessage = (e) => fn(e.data || {});
  return () => ch.close();
}

export function uid(prefix = 'n') {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + r[0].toString(36) + r[1].toString(36).slice(0, 4);
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('videos')) {
        const v = db.createObjectStore('videos', { keyPath: 'id' });
        v.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('notes')) {
        const n = db.createObjectStore('notes', { keyPath: 'id' });
        n.createIndex('videoId', 'videoId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => reject(new Error('Database is blocked by another open page'));
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch (_) { /* done */ } reject(e); });
  });
}

// ---------- videos ----------

export async function getVideo(id) {
  return tx(['videos'], 'readonly', (t) => reqP(t.objectStore('videos').get(id)));
}

export async function listVideos() {
  return tx(['videos'], 'readonly', (t) => reqP(t.objectStore('videos').getAll()));
}

// Create or refresh a video record from page info { key, title, url, site, duration, thumb }.
export async function upsertVideo(info) {
  if (!info || !info.key) throw new Error('Missing video key');
  const now = Date.now();
  const out = await tx(['videos'], 'readwrite', async (t) => {
    const store = t.objectStore('videos');
    const cur = await reqP(store.get(info.key));
    const v = cur || { id: info.key, createdAt: now, bookmarks: [], title: '', url: '', site: '' };
    if (info.title) v.title = String(info.title).slice(0, 500);
    if (info.url) v.url = info.url;
    if (info.pageUrl) v.pageUrl = info.pageUrl;
    if (info.site) v.site = info.site;
    if (Number.isFinite(info.duration) && info.duration > 0) v.duration = info.duration;
    if (info.thumb && !v.thumb) v.thumb = info.thumb;
    if (!Array.isArray(v.bookmarks)) v.bookmarks = [];
    v.updatedAt = cur ? (cur.updatedAt || now) : now;
    await reqP(store.put(v));
    return v;
  });
  return out;
}

export async function saveVideo(v, opts = {}) {
  if (!opts.keepTime) v.updatedAt = Date.now();
  await tx(['videos'], 'readwrite', (t) => reqP(t.objectStore('videos').put(v)));
  announce({ kind: 'video', videoId: v.id });
  return v;
}

export async function deleteVideo(id) {
  await tx(['videos', 'notes'], 'readwrite', async (t) => {
    t.objectStore('videos').delete(id);
    const idx = t.objectStore('notes').index('videoId');
    const keys = await reqP(idx.getAllKeys(id));
    for (const k of keys) t.objectStore('notes').delete(k);
  });
  announce({ kind: 'video-deleted', videoId: id });
}

async function touchVideo(t, videoId) {
  const store = t.objectStore('videos');
  const v = await reqP(store.get(videoId));
  if (v) { v.updatedAt = Date.now(); store.put(v); }
}

// ---------- bookmarks (chapters), stored on the video record ----------

export async function addBookmark(videoId, t, label) {
  const v = await getVideo(videoId);
  if (!v) throw new Error('Unknown video');
  const bm = { id: uid('b'), t: Math.max(0, Number(t) || 0), label: String(label || '').slice(0, 300), createdAt: Date.now() };
  v.bookmarks = (v.bookmarks || []).concat(bm).sort((a, b) => a.t - b.t);
  await saveVideo(v);
  return bm;
}

export async function updateBookmark(videoId, id, patch) {
  const v = await getVideo(videoId);
  if (!v) return null;
  const bm = (v.bookmarks || []).find((b) => b.id === id);
  if (!bm) return null;
  if (patch.label !== undefined) bm.label = String(patch.label).slice(0, 300);
  if (patch.t !== undefined && Number.isFinite(patch.t)) bm.t = Math.max(0, patch.t);
  v.bookmarks.sort((a, b) => a.t - b.t);
  await saveVideo(v);
  return bm;
}

export async function deleteBookmark(videoId, id) {
  const v = await getVideo(videoId);
  if (!v) return;
  v.bookmarks = (v.bookmarks || []).filter((b) => b.id !== id);
  await saveVideo(v);
}

// ---------- notes ----------

export async function getNotes(videoId) {
  const list = await tx(['notes'], 'readonly', (t) => reqP(t.objectStore('notes').index('videoId').getAll(videoId)));
  return list.sort((a, b) => a.t - b.t || a.createdAt - b.createdAt);
}

export async function getNote(id) {
  return tx(['notes'], 'readonly', (t) => reqP(t.objectStore('notes').get(id)));
}

export async function allNotes() {
  return tx(['notes'], 'readonly', (t) => reqP(t.objectStore('notes').getAll()));
}

export async function countNotesByVideo() {
  const counts = {};
  await tx(['notes'], 'readonly', (t) => new Promise((resolve, reject) => {
    const req = t.objectStore('notes').index('videoId').openKeyCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      counts[c.key] = (counts[c.key] || 0) + 1;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
  return counts;
}

export async function addNote({ videoId, t, text, image, imageError }) {
  const now = Date.now();
  const note = {
    id: uid('n'), videoId, t: Math.max(0, Number(t) || 0), text: String(text || ''),
    image: image || null, imageError: imageError || null, createdAt: now, updatedAt: now,
  };
  await tx(['notes', 'videos'], 'readwrite', async (t2) => {
    t2.objectStore('notes').put(note);
    await touchVideo(t2, videoId);
  });
  announce({ kind: 'note', videoId, noteId: note.id });
  return note;
}

export async function updateNote(id, patch) {
  let out = null;
  await tx(['notes', 'videos'], 'readwrite', async (t) => {
    const store = t.objectStore('notes');
    const n = await reqP(store.get(id));
    if (!n) return;
    for (const k of ['text', 'image', 'imageError']) if (patch[k] !== undefined) n[k] = patch[k];
    if (patch.t !== undefined && Number.isFinite(patch.t)) n.t = Math.max(0, patch.t);
    n.updatedAt = Date.now();
    store.put(n);
    await touchVideo(t, n.videoId);
    out = n;
  });
  if (out) announce({ kind: 'note', videoId: out.videoId, noteId: id });
  return out;
}

export async function deleteNote(id) {
  const n = await getNote(id);
  if (!n) return null;
  await tx(['notes'], 'readwrite', (t) => reqP(t.objectStore('notes').delete(id)));
  announce({ kind: 'note-deleted', videoId: n.videoId, noteId: id });
  return n;
}

export async function restoreNote(note) {
  await tx(['notes'], 'readwrite', (t) => reqP(t.objectStore('notes').put(note)));
  announce({ kind: 'note', videoId: note.videoId, noteId: note.id });
}

// ---------- import / export ----------

export async function exportAll(videoIds) {
  let videos = await listVideos();
  let notes = await allNotes();
  if (videoIds) {
    const set = new Set(videoIds);
    videos = videos.filter((v) => set.has(v.id));
    notes = notes.filter((n) => set.has(n.videoId));
  }
  return { app: 'video-studio', format: 1, exportedAt: new Date().toISOString(), videos, notes };
}

function validString(s, max) { return typeof s === 'string' ? s.slice(0, max) : ''; }
function validImage(s) { return typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(s) ? s : null; }

// Merge an export into the database. Newer records win. Returns counts.
export async function importAll(data) {
  if (!data || data.app !== 'video-studio' || !Array.isArray(data.videos) || !Array.isArray(data.notes)) {
    throw new Error('This file is not a Video Studio export.');
  }
  let videosAdded = 0; let notesAdded = 0; let notesUpdated = 0;
  await tx(['videos', 'notes'], 'readwrite', async (t) => {
    const vs = t.objectStore('videos');
    const ns = t.objectStore('notes');
    for (const raw of data.videos) {
      if (!raw || typeof raw.id !== 'string') continue;
      const cur = await reqP(vs.get(raw.id));
      const bookmarks = (Array.isArray(raw.bookmarks) ? raw.bookmarks : [])
        .filter((b) => b && Number.isFinite(b.t))
        .map((b) => ({ id: typeof b.id === 'string' ? b.id : uid('b'), t: b.t, label: validString(b.label, 300), createdAt: b.createdAt || Date.now() }));
      const v = {
        id: raw.id, title: validString(raw.title, 500), url: validString(raw.url, 4000), pageUrl: validString(raw.pageUrl, 4000),
        site: validString(raw.site, 100), duration: Number.isFinite(raw.duration) ? raw.duration : undefined,
        thumb: validImage(raw.thumb), createdAt: raw.createdAt || Date.now(), updatedAt: raw.updatedAt || Date.now(), bookmarks,
      };
      if (cur) {
        const ids = new Set((cur.bookmarks || []).map((b) => b.id));
        cur.bookmarks = (cur.bookmarks || []).concat(bookmarks.filter((b) => !ids.has(b.id))).sort((a, b) => a.t - b.t);
        if (!cur.title) cur.title = v.title;
        if (!cur.thumb) cur.thumb = v.thumb;
        if (!cur.url) cur.url = v.url;
        cur.updatedAt = Math.max(cur.updatedAt || 0, v.updatedAt);
        vs.put(cur);
      } else {
        vs.put(v);
        videosAdded++;
      }
    }
    for (const raw of data.notes) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.videoId !== 'string') continue;
      const n = {
        id: raw.id, videoId: raw.videoId, t: Number.isFinite(raw.t) ? Math.max(0, raw.t) : 0, text: validString(raw.text, 200000),
        image: validImage(raw.image), imageError: raw.imageError ? validString(raw.imageError, 40) : null,
        createdAt: raw.createdAt || Date.now(), updatedAt: raw.updatedAt || Date.now(),
      };
      const cur = await reqP(ns.get(n.id));
      if (!cur) { ns.put(n); notesAdded++; } else if ((cur.updatedAt || 0) < n.updatedAt) { ns.put(n); notesUpdated++; }
    }
  });
  announce({ kind: 'import' });
  return { videosAdded, notesAdded, notesUpdated };
}

export async function clearAll() {
  await tx(['videos', 'notes'], 'readwrite', (t) => { t.objectStore('videos').clear(); t.objectStore('notes').clear(); });
  announce({ kind: 'import' });
}
