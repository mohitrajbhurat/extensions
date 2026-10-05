// Shared storage helpers for the service worker and extension pages (ES module).
const INDEX_KEY = 'sessionIndex';
const RECIPES_KEY = 'recipes';
export const MAX_SESSIONS = 60;

const local = chrome.storage.local;

export async function listSessions() {
  const { [INDEX_KEY]: idx = [] } = await local.get(INDEX_KEY);
  return idx;
}

export async function getSession(id) {
  const key = 'session:' + id;
  const { [key]: s } = await local.get(key);
  return s || null;
}

function metaOf(s) {
  return {
    id: s.id, title: s.title, url: s.url, host: s.host, recipeName: s.recipeName || '',
    rowCount: s.rows.length, columnCount: s.columns.length, pages: s.pages || 0,
    status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

export async function saveSession(s) {
  s.updatedAt = Date.now();
  const idx = (await listSessions()).filter((m) => m.id !== s.id);
  idx.unshift(metaOf(s));
  const removed = idx.splice(MAX_SESSIONS);
  await local.set({ ['session:' + s.id]: s, [INDEX_KEY]: idx });
  if (removed.length) await local.remove(removed.map((m) => 'session:' + m.id));
}

export async function deleteSession(id) {
  const idx = (await listSessions()).filter((m) => m.id !== id);
  await local.set({ [INDEX_KEY]: idx });
  await local.remove('session:' + id);
}

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function listRecipes() {
  const { [RECIPES_KEY]: r = [] } = await local.get(RECIPES_KEY);
  return r;
}

export async function saveRecipes(list) {
  await local.set({ [RECIPES_KEY]: list });
}

/** Validates and normalizes a recipe object (used on import). Returns null if unusable. */
export function normalizeRecipe(r) {
  if (!r || typeof r !== 'object' || typeof r.itemSelector !== 'string' || !r.itemSelector.trim()) return null;
  if (!Array.isArray(r.columns)) return null;
  const types = new Set(['text', 'href', 'src', 'attr', 'html']);
  const columns = r.columns.filter((c) => c && typeof c === 'object').map((c, i) => ({
    id: typeof c.id === 'string' ? c.id : 'c' + i + Math.random().toString(36).slice(2, 6),
    name: String(c.name || `Column ${i + 1}`).slice(0, 120),
    selector: typeof c.selector === 'string' ? c.selector : '',
    index: Number.isInteger(c.index) && c.index >= 0 ? c.index : 0,
    type: types.has(c.type) ? c.type : 'text',
    attr: typeof c.attr === 'string' ? c.attr : '',
  }));
  const p = r.pagination && typeof r.pagination === 'object' ? r.pagination : {};
  const mode = ['none', 'next', 'scroll'].includes(p.mode) ? p.mode : 'none';
  return {
    id: typeof r.id === 'string' ? r.id : newId('r'),
    name: String(r.name || 'Untitled recipe').slice(0, 120),
    host: String(r.host || '').slice(0, 255),
    url: String(r.url || '').slice(0, 2048),
    itemSelector: r.itemSelector,
    columns,
    pagination: {
      mode,
      next: p.next && typeof p.next === 'object' ? {
        selector: String(p.next.selector || ''), structural: String(p.next.structural || ''),
        text: String(p.next.text || ''), rel: String(p.next.rel || ''), aria: String(p.next.aria || ''),
      } : null,
      maxPages: Math.min(1000, Math.max(1, parseInt(p.maxPages, 10) || 10)),
      delay: Math.min(60, Math.max(0, Number(p.delay) || 1.5)),
    },
    dedupe: r.dedupe !== false,
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}
