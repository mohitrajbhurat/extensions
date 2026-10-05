// Persistence: chrome.storage.local for collections/environments/history/tabs/settings.
import { defaultSettings, newCollection, newRequestItem, newRequest, newFolder, normalizeRequest, newAuth, kv } from './model.js';
import { uid } from './util.js';

const KEYS = ['collections', 'environments', 'globals', 'activeEnv', 'history', 'tabs', 'activeTab', 'settings', 'seeded'];

export const state = {
  collections: [], environments: [], globals: [], activeEnv: null,
  history: [], tabs: [], activeTab: null, settings: defaultSettings(), seeded: false,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(what) { for (const fn of subs) fn(what); }

let queue = Object.create(null), timer = null;
export function save(...keys) {
  for (const k of keys) queue[k] = true;
  if (timer) return;
  timer = setTimeout(async () => {
    const keys2 = Object.keys(queue); queue = Object.create(null); timer = null;
    const patch = {};
    for (const k of keys2) patch[k] = serialize(k);
    try { await chrome.storage.local.set(patch); } catch (e) { console.error('save failed', e); }
  }, 180);
}
export async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const keys2 = Object.keys(queue); queue = Object.create(null);
  if (!keys2.length) return;
  const patch = {}; for (const k of keys2) patch[k] = serialize(k);
  await chrome.storage.local.set(patch);
}

// Responses (with raw bytes) and in-flight state live in memory only.
function serialize(k) {
  if (k !== 'tabs') return state[k];
  return state.tabs.map(({ result, sending, abort, ...t }) => t); // eslint-disable-line no-unused-vars
}

export function touch(what, ...keys) { save(...keys); emit(what); }

export async function load() {
  const data = await chrome.storage.local.get(KEYS);
  for (const k of KEYS) if (data[k] !== undefined) state[k] = data[k];
  state.settings = { ...defaultSettings(), ...(state.settings || {}), jsonViewer: { ...defaultSettings().jsonViewer, ...(state.settings?.jsonViewer || {}) } };
  state.collections = (state.collections || []).map(migrateCollection);
  state.environments = (state.environments || []).map(e => ({ id: e.id || uid(), name: e.name || 'Environment', variables: (e.variables || []).map(v => ({ ...kv(), ...v })) }));
  state.globals = (state.globals || []).map(v => ({ ...kv(), ...v }));
  state.tabs = (state.tabs || []).map(t => ({ ...t, request: normalizeRequest(t.request) }));
  if (!state.seeded && !state.collections.length) { seed(); state.seeded = true; save('collections', 'environments', 'activeEnv', 'seeded'); }
  if (!state.tabs.length) { const t = newTab(); state.tabs = [t]; state.activeTab = t.id; save('tabs', 'activeTab'); }
  if (!state.activeTab || !state.tabs.some(t => t.id === state.activeTab)) state.activeTab = state.tabs[0].id;
  return state;
}

function migrateCollection(c) {
  const walk = items => (items || []).map(it => it.type === 'request'
    ? { ...it, id: it.id || uid(), request: normalizeRequest(it.request) }
    : { ...it, id: it.id || uid(), type: 'folder', auth: it.auth || newAuth('inherit'), items: walk(it.items) });
  return { ...newCollection(c.name), ...c, auth: c.auth || newAuth('none'), variables: (c.variables || []).map(v => ({ ...kv(), ...v })), items: walk(c.items) };
}

export function newTab(over = {}) {
  return {
    id: uid(), name: over.name || null, itemId: over.itemId || null, collectionId: over.collectionId || null,
    request: normalizeRequest(over.request || newRequest()), dirty: false,
    ui: { reqTab: 'params', resTab: 'body', resView: 'tree' }, result: null, ...over,
  };
}

/* ---------- tree helpers ---------- */
export function findItem(id, node = { items: state.collections }, trail = []) {
  for (const it of node.items || []) {
    if (it.id === id) return { item: it, parent: node, trail };
    const sub = findItem(id, it, [...trail, it]);
    if (sub) return sub;
  }
  return null;
}
export function collectionOf(id) {
  for (const c of state.collections) {
    if (c.id === id) return c;
    if (findItem(id, c)) return c;
  }
  return null;
}
/** Ancestor folders + collection, nearest first (for auth inheritance). */
export function ancestorsOf(itemId) {
  const col = collectionOf(itemId);
  if (!col) return [];
  const f = findItem(itemId, col);
  if (!f) return [col];
  return [...f.trail].reverse().concat(col);
}
export function removeItem(id) {
  const found = findItem(id);
  if (!found) {
    const i = state.collections.findIndex(c => c.id === id);
    if (i >= 0) { const [c] = state.collections.splice(i, 1); return c; }
    return null;
  }
  const arr = found.parent.items;
  const i = arr.findIndex(x => x.id === id);
  return i >= 0 ? arr.splice(i, 1)[0] : null;
}
export function insertItem(item, parentId, index = -1) {
  const target = parentId
    ? (state.collections.find(c => c.id === parentId) || findItem(parentId)?.item)
    : null;
  const arr = target ? (target.items || (target.items = [])) : null;
  if (!arr) return false;
  if (index < 0 || index > arr.length) arr.push(item); else arr.splice(index, 0, item);
  return true;
}
export function countRequests(node) {
  return (node.items || []).reduce((n, it) => n + (it.type === 'request' ? 1 : countRequests(it)), 0);
}
export function allRequests(node, trail = []) {
  const out = [];
  for (const it of node.items || []) {
    if (it.type === 'request') out.push({ item: it, trail });
    else out.push(...allRequests(it, [...trail, it]));
  }
  return out;
}

/* ---------- history ---------- */
export function pushHistory(entry) {
  state.history.unshift(entry);
  const limit = Number(state.settings.historyLimit) || 100;
  if (state.history.length > limit) state.history.length = limit;
  touch('history', 'history');
}

/* ---------- environments ---------- */
export function activeEnvironment() { return state.environments.find(e => e.id === state.activeEnv) || null; }
export function setVariable(name, value, scope = 'env') {
  const list = scope === 'global' ? state.globals : (activeEnvironment()?.variables || state.globals);
  const row = list.find(v => v.key === name);
  if (row) row.value = value; else list.push(kv(name, value));
  touch('vars', scope === 'global' || !activeEnvironment() ? 'globals' : 'environments');
}

/* ---------- starter content ---------- */
function seed() {
  const col = newCollection('Sample: httpbin');
  col.description = 'A few ready-made requests against httpbin.org so you can try the workbench right away. Grant host access when asked.';
  col.variables = [kv('baseUrl', 'https://httpbin.org')];
  const get = newRequest({ method: 'GET', url: '{{baseUrl}}/get?q=hello' });
  get.params = [kv('q', 'hello')];
  get.headers = [kv('Accept', 'application/json')];
  get.tests = [
    { id: uid(), enabled: true, type: 'status', op: 'eq', expected: '200', target: '' },
    { id: uid(), enabled: true, type: 'json', op: 'eq', target: '$.args.q', expected: 'hello' },
    { id: uid(), enabled: true, type: 'time', op: 'lt', expected: '5000', target: '' },
  ];
  const post = newRequest({ method: 'POST', url: '{{baseUrl}}/post' });
  post.body.mode = 'json';
  post.body.json = '{\n  "name": "workbench",\n  "items": [1, 2, 3]\n}';
  post.tests = [{ id: uid(), enabled: true, type: 'json', op: 'eq', target: '$.json.name', expected: 'workbench' }];
  const folder = newFolder('Status codes');
  folder.items = [
    newRequestItem('404 Not found', newRequest({ url: '{{baseUrl}}/status/404' })),
    newRequestItem('Slow response', newRequest({ url: '{{baseUrl}}/delay/2' })),
  ];
  col.items = [newRequestItem('GET with query', get), newRequestItem('POST JSON', post), folder];
  state.collections = [col];
  const env = { id: uid(), name: 'httpbin (production)', variables: [kv('baseUrl', 'https://httpbin.org'), kv('token', '')] };
  const local = { id: uid(), name: 'Local', variables: [kv('baseUrl', 'http://localhost:3000'), kv('token', '')] };
  state.environments = [env, local];
  state.activeEnv = env.id;
}

export async function resetAll() {
  await chrome.storage.local.clear();
  for (const k of KEYS) delete state[k];
  Object.assign(state, {
    collections: [], environments: [], globals: [], activeEnv: null,
    history: [], tabs: [], activeTab: null, settings: defaultSettings(), seeded: false,
  });
}
