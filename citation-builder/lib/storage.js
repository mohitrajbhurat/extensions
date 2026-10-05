// Persistence: projects and citations in chrome.storage.local, small settings in chrome.storage.sync.
import { uid, cleanItem } from './model.js';

const K_PROJECTS = 'projects';
const K_ITEMS = 'items';
const K_PENDING = 'pending';

export const DEFAULT_SETTINGS = {
  style: 'apa',
  sentenceCase: true,
  onlineLookup: false,
  lastProjectId: '',
  managerSort: 'auto',
  theme: 'auto',
};

const local = () => chrome.storage.local;
const syncArea = () => (chrome.storage.sync || chrome.storage.local);

export async function getSettings() {
  try {
    const got = await syncArea().get('settings');
    return { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
  } catch {
    const got = await local().get('settings');
    return { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
  }
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  try { await syncArea().set({ settings: next }); } catch { await local().set({ settings: next }); }
  return next;
}

// ---------- projects ----------

export async function getProjects() {
  const got = await local().get(K_PROJECTS);
  return Array.isArray(got[K_PROJECTS]) ? got[K_PROJECTS] : [];
}

async function putProjects(list) {
  await local().set({ [K_PROJECTS]: list });
}

export async function ensureDefaultProject() {
  const list = await getProjects();
  if (list.length) return list;
  const p = { id: uid(), name: 'My Bibliography', createdAt: Date.now() };
  await putProjects([p]);
  return [p];
}

export async function createProject(name) {
  const list = await getProjects();
  const clean = String(name || '').trim() || 'Untitled project';
  const p = { id: uid(), name: uniqueName(clean, list), createdAt: Date.now() };
  list.push(p);
  await putProjects(list);
  return p;
}

function uniqueName(name, list) {
  const names = new Set(list.map(p => p.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
}

export async function updateProject(id, patch) {
  const list = await getProjects();
  const p = list.find(x => x.id === id);
  if (!p) return null;
  Object.assign(p, patch);
  await putProjects(list);
  return p;
}

/** Deletes the project and its citations. Returns the removed citations (for undo). */
export async function deleteProject(id) {
  const list = (await getProjects()).filter(p => p.id !== id);
  const items = await getItems();
  const removed = items.filter(i => i.projectId === id);
  await local().set({ [K_PROJECTS]: list, [K_ITEMS]: items.filter(i => i.projectId !== id) });
  return removed;
}

// ---------- items ----------

export async function getItems(projectId) {
  const got = await local().get(K_ITEMS);
  const all = Array.isArray(got[K_ITEMS]) ? got[K_ITEMS] : [];
  return projectId ? all.filter(i => i.projectId === projectId) : all;
}

async function putItems(list) {
  await local().set({ [K_ITEMS]: list });
}

/** Insert or update. Returns the stored item. */
export async function saveItem(item) {
  const all = await getItems();
  const now = Date.now();
  const clean = cleanItem(item);
  if (clean.id) {
    const idx = all.findIndex(i => i.id === clean.id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...clean, updatedAt: now };
      await putItems(all);
      return all[idx];
    }
  }
  const stored = {
    ...clean,
    id: clean.id || uid(),
    projectId: clean.projectId,
    createdAt: clean.createdAt || now,
    updatedAt: now,
    order: all.reduce((mx, i) => Math.max(mx, i.order || 0), 0) + 1,
  };
  all.push(stored);
  await putItems(all);
  return stored;
}

export async function deleteItems(ids) {
  const set = new Set(ids);
  const all = await getItems();
  const removed = all.filter(i => set.has(i.id));
  await putItems(all.filter(i => !set.has(i.id)));
  return removed;
}

/** Put back previously removed items (undo). */
export async function restoreItems(items) {
  const all = await getItems();
  const ids = new Set(all.map(i => i.id));
  await putItems(all.concat(items.filter(i => !ids.has(i.id))));
}

export async function restoreProject(project, items) {
  const list = await getProjects();
  if (!list.some(p => p.id === project.id)) list.push(project);
  await putProjects(list);
  await restoreItems(items);
}

export async function moveItems(ids, projectId) {
  const set = new Set(ids);
  const all = await getItems();
  for (const i of all) if (set.has(i.id)) i.projectId = projectId;
  await putItems(all);
}

export async function copyItems(ids, projectId) {
  const set = new Set(ids);
  const all = await getItems();
  let order = all.reduce((mx, i) => Math.max(mx, i.order || 0), 0);
  const now = Date.now();
  const copies = all.filter(i => set.has(i.id)).map(i => ({ ...i, id: uid(), projectId, createdAt: now, updatedAt: now, order: ++order }));
  await putItems(all.concat(copies));
  return copies;
}

// ---------- backup ----------

export async function exportAll() {
  return { format: 'citation-builder-backup', version: 1, exportedAt: new Date().toISOString(), projects: await getProjects(), items: await getItems() };
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || data.format !== 'citation-builder-backup' || !Array.isArray(data.projects) || !Array.isArray(data.items)) {
    throw new Error('Not a Citation Builder backup file.');
  }
  const projects = replace ? [] : await getProjects();
  const items = replace ? [] : await getItems();
  const pIds = new Set(projects.map(p => p.id));
  const iIds = new Set(items.map(i => i.id));
  for (const p of data.projects) if (p && p.id && !pIds.has(p.id)) projects.push({ id: p.id, name: String(p.name || 'Imported'), createdAt: p.createdAt || Date.now() });
  let added = 0;
  for (const it of data.items) {
    if (!it || !it.id || iIds.has(it.id)) continue;
    items.push({ ...cleanItem(it), id: it.id, projectId: it.projectId, createdAt: it.createdAt || Date.now(), updatedAt: it.updatedAt || Date.now(), order: it.order || 0 });
    added++;
  }
  await local().set({ [K_PROJECTS]: projects, [K_ITEMS]: items });
  return added;
}

export async function clearAll() {
  await local().remove([K_PROJECTS, K_ITEMS, K_PENDING]);
  await ensureDefaultProject();
}

// ---------- pending hand-off (context menu -> popup) ----------

export async function setPending(data) {
  await local().set({ [K_PENDING]: { ...data, at: Date.now() } });
}

/** Read and clear a pending capture younger than maxAge ms. */
export async function takePending(maxAge = 120000) {
  const got = await local().get(K_PENDING);
  const p = got[K_PENDING];
  if (!p) return null;
  await local().remove(K_PENDING);
  return Date.now() - (p.at || 0) <= maxAge ? p : null;
}
