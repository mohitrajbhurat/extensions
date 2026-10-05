// Central in-memory model of the bookmark library for the manager page.
import { getAllMeta, getSettings } from '../lib/meta.js';
import { getReadLaterFolders } from '../lib/readlater.js';
import { getAllTexts, kvGet } from '../lib/db.js';
import { normalizeUrl, hostOf } from '../lib/url.js';

export const S = {
  root: null,
  nodes: new Map(),      // id -> node (with .children for folders)
  bookmarks: [],         // all url nodes
  folders: [],           // all folder nodes except root
  meta: new Map(),       // id -> meta
  texts: new Map(),      // id -> lowercase saved text
  textsLoaded: false,
  rl: null,              // { rootId, archiveId }
  settings: null,
  vocab: new Map(),      // tag -> count
  health: null,          // last health report
  view: { type: 'folder', id: '1' },
  query: '',
  sort: 'manual',
  layout: 'list',
  selection: new Set(),
  anchor: null,
  focusId: null,
  expanded: new Set(),
  inspectorOpen: true
};

export const hooks = { render: () => {}, reload: async () => {}, renderInspector: () => {} };

export const isFolder = n => n && !n.url;
export const isRootLevel = n => !n || !n.parentId || n.parentId === '0';
export const isProtected = id => {
  const n = S.nodes.get(id);
  return !n || isRootLevel(n);
};
export const isReadLaterFolder = id => S.rl && (id === S.rl.rootId || id === S.rl.archiveId);

export async function loadTree() {
  const [tree] = await chrome.bookmarks.getTree();
  const nodes = new Map();
  const bookmarks = [];
  const folders = [];
  const walk = (n, depth, path) => {
    n.depth = depth;
    n.path = path;
    nodes.set(n.id, n);
    if (n.url) {
      bookmarks.push(n);
      n.host = hostOf(n.url);
      n.norm = normalizeUrl(n.url);
    } else {
      if (n.id !== tree.id) folders.push(n);
      const p = n.id === tree.id ? '' : (path ? `${path} / ${n.title}` : n.title);
      let count = 0;
      for (const c of n.children || []) { walk(c, depth + 1, p); count += c.url ? 1 : c.total; }
      n.total = count;
      n.links = (n.children || []).filter(c => c.url).length;
    }
  };
  walk(tree, 0, '');
  S.root = tree;
  S.nodes = nodes;
  S.bookmarks = bookmarks;
  S.folders = folders;
}

export async function loadMeta() {
  S.meta = await getAllMeta();
  rebuildVocab();
}

export function rebuildVocab() {
  const vocab = new Map();
  for (const [id, m] of S.meta) {
    if (!S.nodes.has(id)) continue;
    for (const t of m.tags || []) vocab.set(t, (vocab.get(t) || 0) + 1);
  }
  S.vocab = new Map([...vocab].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export async function loadTexts() {
  try {
    const all = await getAllTexts();
    S.texts = new Map(all.map(t => [t.id, t.text.toLowerCase()]));
  } catch { S.texts = new Map(); }
  S.textsLoaded = true;
}

export async function loadAll() {
  S.settings = await getSettings();
  try { S.rl = await getReadLaterFolders(); } catch { S.rl = null; }
  await Promise.all([loadTree(), loadMeta()]);
  try { S.health = await kvGet('health'); } catch { S.health = null; }
}

export const metaOf = id => S.meta.get(id) || {};
export const tagsOf = id => (S.meta.get(id) || {}).tags || [];

export function folderPath(id) {
  const n = S.nodes.get(id);
  if (!n) return '';
  return n.url ? n.path : (n.path ? `${n.path} / ${n.title}` : n.title);
}

export function descendants(id, out = []) {
  const n = S.nodes.get(id);
  for (const c of (n && n.children) || []) { out.push(c); if (!c.url) descendants(c.id, out); }
  return out;
}

export function isAncestor(ancestorId, id) {
  let n = S.nodes.get(id);
  while (n) { if (n.id === ancestorId) return true; n = S.nodes.get(n.parentId); }
  return false;
}

export function inReadLater(n) {
  return !!(S.rl && n && (n.parentId === S.rl.rootId || n.parentId === S.rl.archiveId));
}

export function healthOf(id) {
  return S.health && S.health.results ? S.health.results[id] : null;
}
