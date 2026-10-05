// Netscape bookmark file (the HTML format every browser imports/exports) and our JSON backup.
import { decodeEntities } from './extract.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const secs = ms => (ms ? Math.floor(ms / 1000) : '');

// roots: bookmark tree nodes (children of the root). metaOf(id) -> meta
export function toNetscapeHtml(roots, metaOf = () => ({})) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];
  const walk = (nodes, depth) => {
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      if (n.url) {
        const m = metaOf(n.id) || {};
        const tags = (m.tags || []).join(',');
        lines.push(`${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${secs(n.dateAdded)}"${tags ? ` TAGS="${esc(tags)}"` : ''}>${esc(n.title || n.url)}</A>`);
        if (m.note) lines.push(`${pad}<DD>${esc(m.note).replace(/\n/g, '<br>')}`);
      } else {
        const toolbar = n.folderType === 'bookmarks-bar' || (n.parentId === '0' && n.id === '1');
        lines.push(`${pad}<DT><H3 ADD_DATE="${secs(n.dateAdded)}" LAST_MODIFIED="${secs(n.dateGroupModified)}"${toolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${esc(n.title)}</H3>`);
        lines.push(`${pad}<DL><p>`);
        walk(n.children || [], depth + 1);
        lines.push(`${pad}</DL><p>`);
      }
    }
  };
  walk(roots, 1);
  lines.push('</DL><p>', '');
  return lines.join('\n');
}

function attrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toUpperCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
const textOf = s => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// Tolerant tokenizer-based parser (bookmark files are rarely valid HTML).
// Returns { title, children: [ {title, url?, dateAdded?, tags?, note?, children?} ] }
export function parseNetscapeHtml(html) {
  const root = { title: 'Imported', children: [] };
  const stack = [root];
  let pendingFolder = null;
  let lastLink = null;
  const lower = html.replace(/[A-Z]/g, c => c.toLowerCase()); // ASCII-only: keeps indexes aligned
  const re = /<(\/?)(dl|h3|a|dd|h1)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const top = stack[stack.length - 1];
    if (tag === 'dl') {
      if (closing) { if (stack.length > 1) stack.pop(); }
      else if (pendingFolder) { stack.push(pendingFolder); pendingFolder = null; }
      continue;
    }
    if (closing) continue;
    if (tag === 'h1') { const end = html.indexOf('</', re.lastIndex); root.title = textOf(html.slice(re.lastIndex, end)) || root.title; continue; }
    if (tag === 'h3') {
      const end = lower.indexOf('</h3>', re.lastIndex);
      const title = end < 0 ? '' : textOf(html.slice(re.lastIndex, end));
      const a = attrs(m[3]);
      const folder = { title: title || 'Folder', children: [], dateAdded: a.ADD_DATE ? +a.ADD_DATE * 1000 : undefined, toolbar: a.PERSONAL_TOOLBAR_FOLDER === 'true' };
      top.children.push(folder);
      pendingFolder = folder;
      lastLink = null;
      continue;
    }
    if (tag === 'a') {
      const end = lower.indexOf('</a>', re.lastIndex);
      const title = end < 0 ? '' : textOf(html.slice(re.lastIndex, end));
      const a = attrs(m[3]);
      if (!a.HREF) continue;
      const link = { title: title || a.HREF, url: a.HREF };
      if (a.ADD_DATE && /^\d+$/.test(a.ADD_DATE)) link.dateAdded = +a.ADD_DATE * (a.ADD_DATE.length > 11 ? 1 : 1000);
      const tags = a.TAGS || a.TAG || '';
      if (tags) link.tags = tags.split(/[,]/).map(t => t.trim()).filter(Boolean);
      top.children.push(link);
      lastLink = link;
      continue;
    }
    if (tag === 'dd' && lastLink) {
      const cands = ['<dt', '<dl', '</dl', '<dd'].map(t => lower.indexOf(t, re.lastIndex)).filter(i => i >= 0);
      const end = cands.length ? Math.min(...cands) : html.length;
      const note = decodeEntities(html.slice(re.lastIndex, end).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
      if (note) lastLink.note = note;
    }
  }
  return root;
}

// ---- JSON backup ----
// { format: 'smart-bookmarks', version: 1, exportedAt, roots: [ node ] }
// node: { title, url?, dateAdded?, tags?, note?, readLater?: {read, archived, minutes}, text?, children? }
export function toJsonBackup(roots, metaOf = () => ({}), textOf = () => null, rl = null) {
  const conv = n => {
    const out = { title: n.title };
    if (n.dateAdded) out.dateAdded = n.dateAdded;
    if (n.url) {
      out.url = n.url;
      const m = metaOf(n.id) || {};
      if (m.tags && m.tags.length) out.tags = m.tags;
      if (m.note) out.note = m.note;
      if (m.rl) out.readLater = { read: !!m.read, minutes: m.minutes || 0, words: m.words || 0 };
      const t = textOf(n.id);
      if (t) out.text = t;
    } else {
      if (rl && n.id === rl.rootId) out.role = 'read-later';
      if (rl && n.id === rl.archiveId) out.role = 'read-later-archive';
      out.children = (n.children || []).map(conv);
    }
    return out;
  };
  return { format: 'smart-bookmarks', version: 1, exportedAt: new Date().toISOString(), roots: roots.map(conv) };
}

export function parseJsonBackup(text) {
  const data = JSON.parse(text);
  // Accept our format, or a raw chrome.bookmarks tree (array or single root).
  if (data && data.format === 'smart-bookmarks' && Array.isArray(data.roots)) return { title: 'Imported', children: data.roots };
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 1 && arr[0] && Array.isArray(arr[0].children) && !arr[0].url) return { title: arr[0].title || 'Imported', children: arr[0].children };
  if (arr.every(n => n && typeof n === 'object' && ('url' in n || 'children' in n))) return { title: 'Imported', children: arr };
  throw new Error('Unrecognized JSON: expected a Smart Bookmarks backup or a bookmark tree.');
}

export function countTree(node) {
  let links = 0, folders = 0;
  const walk = n => { for (const c of n.children || []) { if (c.url) links++; else { folders++; walk(c); } } };
  walk(node);
  return { links, folders };
}
