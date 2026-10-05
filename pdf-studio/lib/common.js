// Shared helpers for PDF Studio pages (ES module). No network access, everything local.

/** Trigger a download of bytes or a Blob without the downloads permission. */
export function downloadBlob(data, filename, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** "report.pdf" -> "report" */
export function baseName(name) {
  return String(name || 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'document';
}

export function isPdfBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // %PDF may be preceded by a little junk; search the first 1 KB like most readers do.
  const n = Math.min(u8.length - 4, 1024);
  for (let i = 0; i < n; i++) {
    if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46) return true;
  }
  return false;
}

export function readFile(file) {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

export function isPdfFile(file) {
  return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
}

export function isImageFile(file) {
  return file && (/^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name));
}

let toastHost;
/** Show a transient message. type: '' | 'error' | 'success' */
export function toast(message, type = '', ms = 3200) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
}

let busyEl;
/** Show or hide a modal progress overlay. Pass a string to show, null to hide. */
export function busy(message) {
  if (message == null) {
    busyEl?.remove();
    busyEl = null;
    return;
  }
  if (!busyEl) {
    busyEl = document.createElement('div');
    busyEl.className = 'busy';
    busyEl.innerHTML = '<div class="busy-card" role="alertdialog" aria-live="assertive"><div class="spinner"></div><div class="busy-msg"></div></div>';
    document.body.append(busyEl);
  }
  busyEl.querySelector('.busy-msg').textContent = message;
}

/** Wire a drop target. onFiles(FileList-like array) */
export function makeDropTarget(el, onFiles, { highlightEl = el } = {}) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    highlightEl.classList.add('dragover');
  });
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) highlightEl.classList.remove('dragover');
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    highlightEl.classList.remove('dragover');
    onFiles([...e.dataTransfer.files]);
  });
}

function hasFiles(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

/** Open a file picker and resolve with the chosen files. */
export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...input.files]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

// ---------- Hand-off store (IndexedDB) to pass a document between viewer and tools pages ----------
const DB_NAME = 'pdf-studio';
const STORE = 'handoff';
const DRAFTS = 'drafts';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store a document for another page. Returns a key to put in the URL (?doc=key). */
export async function putHandoff(bytes, name) {
  const db = await openDb();
  const key = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ bytes: new Uint8Array(bytes), name, at: Date.now() }, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return key;
}

/** Read and delete a hand-off entry. Also clears entries older than a day. */
export async function takeHandoff(key) {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let value = null;
    const req = store.get(key);
    req.onsuccess = () => {
      value = req.result || null;
      store.delete(key);
    };
    const cutoff = Date.now() - 86_400_000;
    store.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) return;
      if (cur.value && cur.value.at < cutoff) cur.delete();
      cur.continue();
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return result;
}

// ---------- Drafts: unsaved annotations per document fingerprint ----------
async function draftOp(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFTS, mode);
      const req = fn(tx.objectStore(DRAFTS));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function getDraft(key) {
  return draftOp('readonly', (s) => s.get(key)).catch(() => null);
}

export function putDraft(key, value) {
  return draftOp('readwrite', (s) => s.put({ ...value, at: Date.now() }, key)).catch(() => {});
}

export function deleteDraft(key) {
  return draftOp('readwrite', (s) => s.delete(key)).catch(() => {});
}

/** Open a page of this extension with a document handed over. page: 'viewer' | 'tools' */
export async function openWithDocument(page, bytes, name, extraParams = '') {
  const key = await putHandoff(bytes, name);
  const path = page === 'tools' ? '../tools/tools.html' : '../viewer/viewer.html';
  window.open(`${path}?doc=${encodeURIComponent(key)}${extraParams}`, '_blank');
}

/** Parse "1-3, 5, 8-" into zero-based page index groups. Throws on invalid input. */
export function parseRanges(text, pageCount) {
  const groups = [];
  const parts = String(text).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one page range, like 1-3, 5');
  for (const part of parts) {
    const m = part.match(/^(\d+)?\s*(?:(-|–)\s*(\d+)?)?$/);
    if (!m || (!m[1] && !m[3])) throw new Error(`"${part}" is not a valid range`);
    const start = m[1] ? parseInt(m[1], 10) : 1;
    const end = m[2] ? (m[3] ? parseInt(m[3], 10) : pageCount) : start;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(`"${part}" is outside 1-${pageCount}`);
    }
    const group = [];
    if (start <= end) for (let i = start; i <= end; i++) group.push(i - 1);
    else for (let i = start; i >= end; i--) group.push(i - 1);
    groups.push(group);
  }
  return groups;
}

export const ICONS = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/></svg>'
};
