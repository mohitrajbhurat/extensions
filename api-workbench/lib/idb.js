// IndexedDB store for files attached to form-data and binary bodies (so they survive reloads).
let dbp;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('api-workbench', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('files', mode);
    const r = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
export const putFile = (id, file) => tx('readwrite', s => s.put({ blob: file, name: file.name || 'file', type: file.type || '' }, id));
export const getFile = id => tx('readonly', s => s.get(id));
export const deleteFile = id => tx('readwrite', s => s.delete(id));
export const listFileKeys = () => tx('readonly', s => s.getAllKeys());
