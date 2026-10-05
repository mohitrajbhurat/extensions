// Read Later lives in a real bookmark folder ("Read Later", with an "Archive" subfolder)
// under Other bookmarks, so the list syncs and survives uninstalling the extension.
// Read/unread state, reading time and tags live in per-bookmark meta.
import { getMeta, setMeta, getMetaMany, mergeTags, getSettings } from './meta.js';
import { normalizeUrl } from './url.js';
import { putText } from './db.js';
import { countWords, readingMinutes } from './extract.js';

const RL_TITLE = 'Read Later';
const ARCHIVE_TITLE = 'Archive';
let pending = null;

async function exists(id) {
  if (!id) return null;
  try { const [n] = await chrome.bookmarks.get(String(id)); return n && !n.url ? n : null; } catch { return null; }
}

export async function otherBookmarksId() {
  const [root] = await chrome.bookmarks.getTree();
  const kids = root.children || [];
  const other = kids.find(k => k.id === '2') || kids.find(k => /other|andere|autres|otros|altri/i.test(k.title)) || kids[kids.length - 1];
  return other.id;
}

async function resolveFolders() {
  const { rlFolders } = await chrome.storage.local.get('rlFolders');
  let rootNode = await exists(rlFolders && rlFolders.rootId);
  if (!rootNode) {
    const otherId = await otherBookmarksId();
    const kids = await chrome.bookmarks.getChildren(otherId);
    rootNode = kids.find(k => !k.url && k.title === RL_TITLE) || await chrome.bookmarks.create({ parentId: otherId, title: RL_TITLE });
  }
  let archNode = await exists(rlFolders && rlFolders.archiveId);
  if (!archNode || archNode.parentId !== rootNode.id) {
    const kids = await chrome.bookmarks.getChildren(rootNode.id);
    archNode = kids.find(k => !k.url && k.title === ARCHIVE_TITLE) || await chrome.bookmarks.create({ parentId: rootNode.id, title: ARCHIVE_TITLE });
  }
  const res = { rootId: rootNode.id, archiveId: archNode.id };
  if (!rlFolders || rlFolders.rootId !== res.rootId || rlFolders.archiveId !== res.archiveId) await chrome.storage.local.set({ rlFolders: res });
  return res;
}

// Serialized so popup / service worker / manager never create two folders.
export function getReadLaterFolders() {
  if (!pending) pending = resolveFolders().finally(() => { setTimeout(() => { pending = null; }, 50); });
  return pending;
}

// Non-creating lookup (used for display only).
export async function peekReadLaterFolders() {
  const { rlFolders } = await chrome.storage.local.get('rlFolders');
  if (rlFolders && await exists(rlFolders.rootId)) return rlFolders;
  return null;
}

export async function findInReadLater(url) {
  const f = await peekReadLaterFolders();
  if (!f) return null;
  const key = normalizeUrl(url);
  const kids = [...await chrome.bookmarks.getChildren(f.rootId), ...await chrome.bookmarks.getChildren(f.archiveId)];
  return kids.find(k => k.url && normalizeUrl(k.url) === key) || null;
}

// page: { url, title, tags?, text?, words?, saveText? }
export async function saveForLater(page) {
  const f = await getReadLaterFolders();
  const settings = await getSettings();
  const words = page.words || countWords(page.text);
  const minutes = readingMinutes(words, settings.wpm);
  let node = await findInReadLater(page.url);
  let existed = !!node;
  if (node) {
    if (node.parentId === f.archiveId) await chrome.bookmarks.move(node.id, { parentId: f.rootId, index: 0 });
  } else {
    node = await chrome.bookmarks.create({ parentId: f.rootId, index: 0, title: page.title || page.url, url: page.url });
  }
  const cur = await getMeta(node.id);
  const patch = { rl: true, read: false, readAt: undefined, tags: mergeTags(cur.tags, page.tags), rlAddedAt: Date.now() };
  if (words) { patch.words = words; patch.minutes = minutes; }
  if (page.suggested && page.suggested.length) patch.suggested = page.suggested.filter(t => !patch.tags.includes(t));
  if (page.saveText && page.text) { await putText(node.id, page.text, words); patch.hasText = true; patch.textAt = Date.now(); }
  await setMeta(node.id, patch);
  return { node, existed };
}

export async function setRead(ids, read) {
  const list = [].concat(ids);
  const metas = await getMetaMany(list);
  const set = {};
  for (const id of list) set['m:' + id] = { ...metas.get(String(id)), rl: true, read: !!read, readAt: read ? Date.now() : undefined };
  for (const v of Object.values(set)) if (v.readAt === undefined) delete v.readAt;
  await chrome.storage.local.set(set);
}

export async function archive(ids, toArchive = true) {
  const f = await getReadLaterFolders();
  for (const id of [].concat(ids)) {
    await chrome.bookmarks.move(String(id), { parentId: toArchive ? f.archiveId : f.rootId, ...(toArchive ? {} : { index: 0 }) });
  }
  if (toArchive) await setRead(ids, true);
}

export async function unreadItems() {
  const f = await peekReadLaterFolders();
  if (!f) return [];
  const kids = (await chrome.bookmarks.getChildren(f.rootId)).filter(k => k.url);
  const metas = await getMetaMany(kids.map(k => k.id));
  return kids.filter(k => !metas.get(k.id).read).map(k => ({ ...k, meta: metas.get(k.id) }));
}
