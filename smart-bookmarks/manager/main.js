// Smart Bookmarks manager: layout, navigation, tree, list/grid, search, selection,
// drag and drop, inspector and bulk actions.
import { S, hooks, loadAll, loadTree, loadMeta, loadTexts, isFolder, isProtected, isReadLaterFolder, metaOf, tagsOf, isAncestor, inReadLater, healthOf } from './state.js';
import { toast, dialog, promptDialog, confirmDialog, pickFolder, fmtDate, plural } from './ui.js';
import { deleteItems, moveItems, setTags, addRemoveTags, autoTag, saveTexts, removeTexts, reviewSuggestions, quickSuggest, markBulk } from './ops.js';
import { renderHealth, checkLinks } from './health.js';
import { renderTags, renderBackup, renderSettings, renderWelcome } from './tools.js';
import { icon, esc } from '../lib/icons.js';
import { createTagInput } from '../lib/tag-input.js';
import { updateMetaMany, getSettings } from '../lib/meta.js';
import { setRead, archive } from '../lib/readlater.js';
import { getText } from '../lib/db.js';
import { faviconUrl, prettyUrl, isHttpUrl } from '../lib/url.js';

const $ = id => document.getElementById(id);
const LIST_VIEWS = new Set(['folder', 'all', 'recent', 'untagged', 'tag', 'readlater', 'suggestions', 'search']);
const CHUNK = 200;

// ---------- Preferences (per-viewer conveniences only) ----------
const pref = {
  get(k, d) { try { const v = localStorage.getItem('sb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sb.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
};

// ---------- Routing ----------
function viewFromHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [type, ...rest] = h.split('/');
  const arg = rest.join('/');
  switch (type) {
    case 'folder': return S.nodes.has(arg) && isFolder(S.nodes.get(arg)) ? { type, id: arg } : defaultView();
    case 'tag': return arg ? { type, tag: arg } : { type: 'tags' };
    case 'readlater': return { type, tab: ['read', 'archived'].includes(arg) ? arg : 'unread' };
    case 'health': return { type, tab: ['duplicates', 'empty'].includes(arg) ? arg : 'links' };
    case 'all': case 'recent': case 'untagged': case 'tags': case 'backup': case 'settings': case 'welcome': case 'suggestions':
      return { type };
    default: return defaultView();
  }
}
function defaultView() {
  const bar = S.root && S.root.children && S.root.children[0];
  return { type: 'folder', id: bar ? bar.id : '1' };
}
function hashFor(v) {
  switch (v.type) {
    case 'folder': return `folder/${v.id}`;
    case 'tag': return `tag/${encodeURIComponent(v.tag)}`;
    case 'readlater': return v.tab && v.tab !== 'unread' ? `readlater/${v.tab}` : 'readlater';
    case 'health': return v.tab && v.tab !== 'links' ? `health/${v.tab}` : 'health';
    default: return v.type;
  }
}
export function go(v, { keepQuery = false } = {}) {
  if (!keepQuery && S.query) { S.query = ''; $('search').value = ''; }
  const h = '#' + hashFor(v);
  if (location.hash !== h) location.hash = h; // hashchange → route()
  else route();
}
function route() {
  const v = viewFromHash();
  const changed = JSON.stringify(v) !== JSON.stringify(S.view);
  S.view = v;
  if (changed) { S.selection.clear(); S.anchor = null; S.focusId = null; }
  if (v.type === 'folder') expandTo(v.id);
  closeSidebar();
  render();
  if (changed) $('content').scrollTop = 0;
}

// ---------- Data refresh ----------
let reloadTimer = null;
let reloading = null;
async function reload({ metaOnly = false } = {}) {
  if (!metaOnly) await loadTree();
  await loadMeta();
  S.settings = await getSettings();
  for (const id of [...S.selection]) if (!S.nodes.has(id)) S.selection.delete(id);
  if (S.view.type === 'folder' && !S.nodes.has(S.view.id)) { S.view = defaultView(); history.replaceState(null, '', '#' + hashFor(S.view)); }
  render();
}
hooks.reload = opts => { reloading = reload(opts); return reloading; };
function scheduleReload(metaOnly = false) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload({ metaOnly }), metaOnly ? 120 : 200);
}

// ---------- Search ----------
function parseQuery(q) {
  const out = { terms: [], neg: [], tags: [], notTags: [], sites: [], is: [], has: [], folders: [] };
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(q))) {
    const neg = m[1] === '-';
    const key = (m[2] || '').toLowerCase();
    const val = (m[3] ?? m[4] ?? '').toLowerCase();
    if (!val) continue;
    if (key === 'tag' || key === '#') (neg ? out.notTags : out.tags).push(val.replace(/^#/, ''));
    else if (key === 'site' || key === 'domain') out.sites.push(val);
    else if (key === 'is') out.is.push(val);
    else if (key === 'has') out.has.push(val);
    else if (key === 'in' || key === 'folder') out.folders.push(val);
    else if (!key && val.startsWith('#') && val.length > 1) (neg ? out.notTags : out.tags).push(val.slice(1));
    else (neg ? out.neg : out.terms).push(m[2] && !['tag', 'site', 'domain', 'is', 'has', 'in', 'folder'].includes(key) ? `${key}:${val}` : val);
  }
  return out;
}

function searchBookmarks(q) {
  const p = parseQuery(q);
  const res = [];
  const dupKeys = p.is.includes('duplicate') ? dupSet() : null;
  for (const n of S.bookmarks) {
    const m = metaOf(n.id);
    const tags = m.tags || [];
    if (p.tags.length && !p.tags.every(t => tags.some(x => x === t || x.startsWith(t + '/')))) continue;
    if (p.notTags.some(t => tags.includes(t))) continue;
    if (p.sites.length && !p.sites.some(s => n.host === s || n.host.endsWith('.' + s) || n.host.includes(s))) continue;
    if (p.folders.length && !p.folders.every(f => n.path.toLowerCase().includes(f))) continue;
    let okIs = true;
    for (const i of p.is) {
      if (i === 'unread' && !(m.rl && !m.read)) okIs = false;
      else if (i === 'read' && !(m.rl && m.read)) okIs = false;
      else if ((i === 'readlater' || i === 'later') && !m.rl) okIs = false;
      else if (i === 'untagged' && tags.length) okIs = false;
      else if (i === 'tagged' && !tags.length) okIs = false;
      else if ((i === 'dead' || i === 'broken') && !(healthOf(n.id) && healthOf(n.id).status === 'dead')) okIs = false;
      else if (i === 'redirect' && !(healthOf(n.id) && healthOf(n.id).status === 'redirect')) okIs = false;
      else if (i === 'duplicate' && !(dupKeys && dupKeys.has(n.norm))) okIs = false;
    }
    if (!okIs) continue;
    if (p.has.includes('text') && !m.hasText) continue;
    if (p.has.includes('note') && !m.note) continue;
    if (p.has.includes('suggestions') && !(m.suggested || []).length) continue;
    const title = (n.title || '').toLowerCase();
    const url = n.url.toLowerCase();
    const tagStr = tags.join(' ');
    const note = (m.note || '').toLowerCase();
    const text = S.texts.get(n.id) || '';
    let score = 0;
    let textHit = null;
    let all = true;
    for (const t of p.terms) {
      let s = 0;
      if (title.includes(t)) s += title.startsWith(t) || title.includes(' ' + t) ? 6 : 4;
      if (tags.includes(t)) s += 6; else if (tagStr.includes(t)) s += 3;
      if (url.includes(t)) s += n.host.includes(t) ? 3 : 2;
      if (note.includes(t)) s += 2;
      if (!s && text) { const i = text.indexOf(t); if (i >= 0) { s += 1; if (textHit === null) textHit = { i, t }; } }
      if (!s) { all = false; break; }
      score += s;
    }
    if (!all) continue;
    if (p.neg.some(t => title.includes(t) || url.includes(t) || tagStr.includes(t) || note.includes(t) || text.includes(t))) continue;
    res.push({ n, score, textHit });
  }
  return { results: res, terms: p.terms };
}

function dupSet() {
  const seen = new Map();
  for (const n of S.bookmarks) seen.set(n.norm, (seen.get(n.norm) || 0) + 1);
  return new Set([...seen].filter(([, c]) => c > 1).map(([k]) => k));
}

function highlight(text, terms) {
  let s = esc(text);
  const ts = terms.filter(t => t.length > 1).map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ts.length) return s;
  return s.replace(new RegExp(`(${ts.join('|')})`, 'gi'), '<mark>$1</mark>');
}

function snippet(id, hit, terms) {
  if (!hit) return '';
  const text = S.texts.get(id) || '';
  const start = Math.max(0, hit.i - 70);
  const raw = text.slice(start, hit.i + 110).replace(/\s+/g, ' ');
  return (start ? '…' : '') + highlight(raw, terms) + '…';
}

// ---------- Items for current view ----------
const SORTS = {
  manual: { label: 'Manual order' },
  relevance: { label: 'Relevance' },
  newest: { label: 'Newest first', fn: (a, b) => (b.dateAdded || 0) - (a.dateAdded || 0) },
  oldest: { label: 'Oldest first', fn: (a, b) => (a.dateAdded || 0) - (b.dateAdded || 0) },
  title: { label: 'Title A–Z', fn: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true }) },
  domain: { label: 'Website', fn: (a, b) => (a.host || '').localeCompare(b.host || '') || (a.title || '').localeCompare(b.title || '') },
  shortest: { label: 'Shortest read', fn: (a, b) => (metaOf(a.id).minutes || 999) - (metaOf(b.id).minutes || 999) },
  longest: { label: 'Longest read', fn: (a, b) => (metaOf(b.id).minutes || 0) - (metaOf(a.id).minutes || 0) }
};
function sortOptionsFor(v) {
  if (S.query) return ['relevance', 'newest', 'oldest', 'title', 'domain'];
  if (v.type === 'folder') return ['manual', 'newest', 'oldest', 'title', 'domain'];
  if (v.type === 'readlater') return ['newest', 'oldest', 'shortest', 'longest', 'title'];
  return ['newest', 'oldest', 'title', 'domain'];
}
function currentSort() {
  const opts = sortOptionsFor(S.view);
  const key = S.query ? 'search' : S.view.type;
  const saved = pref.get('sort.' + key, null);
  return opts.includes(saved) ? saved : opts[0];
}

let searchCache = null;
function computeItems() {
  const v = S.view;
  const sort = currentSort();
  let folders = [];
  let links = [];
  let extra = new Map();
  let terms = [];
  if (S.query) {
    const { results, terms: t } = searchBookmarks(S.query);
    terms = t;
    if (sort === 'relevance') results.sort((a, b) => b.score - a.score || (b.n.dateAdded || 0) - (a.n.dateAdded || 0));
    links = results.map(r => r.n);
    for (const r of results) if (r.textHit) extra.set(r.n.id, r.textHit);
    // Folder name matches.
    const q = S.query.toLowerCase().trim();
    if (q && !/:/.test(q)) folders = S.folders.filter(f => (f.title || '').toLowerCase().includes(q)).slice(0, 20);
  } else if (v.type === 'folder') {
    const f = S.nodes.get(v.id);
    const kids = (f && f.children) || [];
    folders = kids.filter(isFolder);
    links = kids.filter(k => k.url);
  } else if (v.type === 'all') links = [...S.bookmarks];
  else if (v.type === 'recent') links = [...S.bookmarks].sort(SORTS.newest.fn).slice(0, 300);
  else if (v.type === 'untagged') links = S.bookmarks.filter(n => !tagsOf(n.id).length && !inReadLater(n));
  else if (v.type === 'tag') links = S.bookmarks.filter(n => tagsOf(n.id).includes(v.tag));
  else if (v.type === 'suggestions') links = S.bookmarks.filter(n => (metaOf(n.id).suggested || []).length);
  else if (v.type === 'readlater' && S.rl) {
    const root = S.nodes.get(S.rl.rootId);
    const arch = S.nodes.get(S.rl.archiveId);
    if (v.tab === 'archived') links = ((arch && arch.children) || []).filter(k => k.url);
    else links = ((root && root.children) || []).filter(k => k.url && (v.tab === 'read' ? metaOf(k.id).read : !metaOf(k.id).read));
  }
  if (SORTS[sort] && SORTS[sort].fn && !(v.type === 'recent' && sort === 'newest')) {
    links = [...links].sort(SORTS[sort].fn);
    if (sort === 'title') folders = [...folders].sort(SORTS.title.fn);
  }
  if (v.type === 'readlater' && sort === 'newest') links.sort((a, b) => (metaOf(b.id).rlAddedAt || b.dateAdded) - (metaOf(a.id).rlAddedAt || a.dateAdded));
  searchCache = { terms, extra };
  return { folders, links, sort };
}

// ---------- Rendering ----------
function render() {
  renderNav();
  renderTree();
  renderSideTags();
  renderMain();
  renderBulkbar();
  renderInspector();
}
hooks.render = render;
hooks.renderInspector = () => renderInspector(true);

function counts() {
  let unread = 0, pending = 0, untagged = 0;
  const rlRoot = S.rl && S.nodes.get(S.rl.rootId);
  for (const c of (rlRoot && rlRoot.children) || []) if (c.url && !metaOf(c.id).read) unread++;
  for (const n of S.bookmarks) {
    const m = metaOf(n.id);
    if ((m.suggested || []).length) pending++;
    if (!(m.tags || []).length && !inReadLater(n)) untagged++;
  }
  const broken = S.health && S.health.results ? Object.entries(S.health.results).filter(([id, r]) => r.status === 'dead' && S.nodes.has(id)).length : 0;
  return { unread, pending, untagged, broken };
}

function renderNav() {
  const c = counts();
  const v = S.view;
  const item = (type, ic, label, count, extraCls = '', drop = '') => `
    <a href="#${type}" class="nav-item${v.type === type && !S.query ? ' active' : ''} ${extraCls}" ${drop} ${v.type === type && !S.query ? 'aria-current="page"' : ''}>
      ${icon(ic)}<span class="nl">${label}</span>${count ? `<span class="count">${count.toLocaleString()}</span>` : ''}</a>`;
  $('nav').innerHTML = [
    item('all', 'bookmarks', 'All bookmarks', S.bookmarks.length),
    item('readlater', 'clock', 'Read later', c.unread, 'accent-count', S.rl ? `data-drop-folder="${S.rl.rootId}"` : ''),
    item('recent', 'history', 'Recently added', 0),
    item('untagged', 'tag', 'Untagged', c.untagged),
    c.pending ? item('suggestions', 'sparkles', 'Tag suggestions', c.pending, 'accent-count') : '',
    item('tags', 'tag', 'Tags', S.vocab.size),
    item('health', 'pulse', 'Health check', c.broken, c.broken ? 'bad-count' : ''),
    item('backup', 'download', 'Import & export', 0),
    item('settings', 'settings', 'Settings', 0)
  ].join('');
}

function expandTo(id) {
  let n = S.nodes.get(id);
  while (n && n.parentId) { S.expanded.add(n.parentId); n = S.nodes.get(n.parentId); }
}

function renderTree() {
  const out = [];
  const walk = (node, depth) => {
    for (const f of node.children || []) {
      if (f.url) continue;
      const sub = (f.children || []).some(isFolder);
      const open = S.expanded.has(f.id);
      const active = S.view.type === 'folder' && S.view.id === f.id && !S.query;
      out.push(`<div class="tree-item${active ? ' active' : ''}" role="treeitem" aria-level="${depth + 1}" ${sub ? `aria-expanded="${open}"` : ''} aria-selected="${active}"
        data-id="${f.id}" data-drop-folder="${f.id}" tabindex="${active ? 0 : -1}" draggable="${!isProtected(f.id)}" style="--d:${depth}">
        <button class="twisty" tabindex="-1" aria-hidden="true" ${sub ? '' : 'disabled'}>${sub ? icon('chevron') : ''}</button>
        ${icon(isReadLaterFolder(f.id) ? 'clock' : open ? 'folderOpen' : 'folder', 'fi')}<span class="tl">${esc(f.title || '(untitled)')}</span>
        ${f.total ? `<span class="tc">${f.total.toLocaleString()}</span>` : ''}</div>`);
      if (sub && open) walk(f, depth + 1);
    }
  };
  if (S.root) walk(S.root, 0);
  $('tree').innerHTML = out.join('');
  if (!$('tree').querySelector('[tabindex="0"]')) { const f = $('tree').querySelector('.tree-item'); if (f) f.tabIndex = 0; }
}

function renderSideTags() {
  const top = [...S.vocab].slice(0, 14);
  $('sideTags').innerHTML = top.length
    ? top.map(([t, n]) => `<a class="side-tag${S.view.type === 'tag' && S.view.tag === t ? ' active' : ''}" href="#tag/${encodeURIComponent(t)}"><span>#${esc(t)}</span><span class="tc">${n}</span></a>`).join('')
    : '<div class="faint small side-empty">No tags yet. Select bookmarks and press <kbd>T</kbd> or use Auto-tag.</div>';
}

function viewTitle() {
  const v = S.view;
  if (S.query) return { title: 'Search results', icon: 'search' };
  switch (v.type) {
    case 'folder': return { title: S.nodes.get(v.id) ? S.nodes.get(v.id).title || '(untitled)' : 'Folder', icon: 'folder' };
    case 'all': return { title: 'All bookmarks', icon: 'bookmarks' };
    case 'recent': return { title: 'Recently added', icon: 'history' };
    case 'untagged': return { title: 'Untagged bookmarks', icon: 'tag' };
    case 'tag': return { title: '#' + v.tag, icon: 'tag' };
    case 'suggestions': return { title: 'Tag suggestions', icon: 'sparkles' };
    case 'readlater': return { title: 'Read later', icon: 'clock' };
    case 'tags': return { title: 'Tags', icon: 'tag' };
    case 'health': return { title: 'Health check', icon: 'pulse' };
    case 'backup': return { title: 'Import & export', icon: 'download' };
    case 'settings': return { title: 'Settings', icon: 'settings' };
    case 'welcome': return { title: 'Welcome', icon: 'bookmark' };
    default: return { title: '', icon: 'bookmark' };
  }
}

function renderCrumbs() {
  const v = S.view;
  const el = $('crumbs');
  if (v.type === 'folder' && !S.query) {
    const parts = [];
    let n = S.nodes.get(v.id);
    while (n && n.parentId) { parts.unshift(n); n = S.nodes.get(n.parentId); }
    el.innerHTML = parts.map((p, i) => i === parts.length - 1
      ? `<h1 class="crumb current" data-drop-folder="${p.id}">${esc(p.title || '(untitled)')}</h1>`
      : `<a class="crumb" href="#folder/${p.id}" data-drop-folder="${p.id}">${esc(p.title || '(untitled)')}</a><span class="sep">${icon('chevron')}</span>`).join('');
  } else {
    const t = viewTitle();
    el.innerHTML = `<h1 class="crumb current">${icon(t.icon)}<span>${esc(t.title)}</span></h1>`;
  }
}

function renderMain() {
  renderCrumbs();
  const isList = LIST_VIEWS.has(S.view.type) || S.query;
  $('listControls').hidden = !isList;
  const content = $('content');
  content.classList.toggle('grid-mode', isList && S.layout === 'grid');
  if (!isList) {
    S.visible = [];
    $('viewActions').innerHTML = '';
    const t = S.view.type;
    if (t === 'health') renderHealth(content, S.view.tab);
    else if (t === 'tags') renderTags(content);
    else if (t === 'backup') renderBackup(content);
    else if (t === 'settings') renderSettings(content);
    else if (t === 'welcome') renderWelcome(content);
    return;
  }
  const { folders, links, sort } = computeItems();
  const sel = $('sort');
  sel.innerHTML = sortOptionsFor(S.view).map(k => `<option value="${k}">${SORTS[k].label}</option>`).join('');
  sel.value = sort;
  $('layoutList').setAttribute('aria-pressed', String(S.layout === 'list'));
  $('layoutGrid').setAttribute('aria-pressed', String(S.layout === 'grid'));
  renderViewActions(links);
  S.visible = [...folders.map(f => f.id), ...links.map(l => l.id)];
  S.manualDrop = S.view.type === 'folder' && !S.query && sort === 'manual';

  let head = '';
  if (S.view.type === 'readlater') head = readLaterHeader();
  else if (S.query) head = `<div class="view-head"><span class="muted">${plural(links.length, 'bookmark')}${folders.length ? ` and ${plural(folders.length, 'folder')}` : ''} matching <b>${esc(S.query)}</b></span>
    ${!S.textsLoaded ? '<span class="faint small">· loading saved page text…</span>' : ''}<span class="spacer"></span><button class="btn ghost sm" data-act="search-help">${icon('info')}Search tips</button></div>`;
  else if (S.view.type === 'suggestions') head = `<div class="view-head"><span class="muted">Tags suggested automatically. Review to accept or dismiss them.</span><span class="spacer"></span><button class="btn primary sm" data-act="review-all">${icon('sparkles')}Review all</button></div>`;
  else if (S.view.type === 'folder' || S.view.type === 'all' || S.view.type === 'tag' || S.view.type === 'untagged' || S.view.type === 'recent') {
    head = `<div class="view-head"><span class="muted small">${folders.length ? plural(folders.length, 'folder') + ' · ' : ''}${plural(links.length, 'bookmark')}</span></div>`;
  }

  if (!folders.length && !links.length) {
    S.renderMore = null;
    content.innerHTML = head + emptyState();
    return;
  }
  content.innerHTML = head + `<div class="items ${S.layout}" role="listbox" aria-multiselectable="true" aria-label="Bookmarks" id="items"></div>`;
  const itemsEl = $('items');
  const all = [...folders, ...links];
  let shown = 0;
  const more = () => {
    if (shown >= all.length) return false;
    const slice = all.slice(shown, shown + CHUNK);
    itemsEl.insertAdjacentHTML('beforeend', slice.map(n => (n.url ? rowHtml(n) : folderRowHtml(n))).join(''));
    shown += slice.length;
    const old = itemsEl.querySelector('.sentinel');
    if (old) old.remove();
    if (shown < all.length) {
      itemsEl.insertAdjacentHTML('beforeend', `<div class="sentinel">${icon('more')} Loading more (${(all.length - shown).toLocaleString()} left)</div>`);
      const s = itemsEl.querySelector('.sentinel');
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); more(); } }, { root: content, rootMargin: '600px' });
      io.observe(s);
    }
    return true;
  };
  S.renderMore = more;
  more();
  if (S.focusId) {
    const f = itemsEl.querySelector(`[data-id="${CSS.escape(S.focusId)}"]`);
    if (f) f.tabIndex = 0;
  } else {
    const f = itemsEl.querySelector('.item');
    if (f) f.tabIndex = 0;
  }
}

function emptyState() {
  const v = S.view;
  let msg = 'Nothing here.';
  let ic = 'inbox';
  if (S.query) { msg = `No bookmarks match “${esc(S.query)}”.<br><span class="small">Try fewer words, or search tips like <code>tag:</code>, <code>site:</code>, <code>is:unread</code>.</span>`; ic = 'search'; }
  else if (v.type === 'folder') msg = 'This folder is empty. Drag bookmarks here, or drop a link from another tab.';
  else if (v.type === 'readlater') { ic = 'clock'; msg = v.tab === 'unread' ? 'You are all caught up.<br><span class="small">Use the toolbar button or right-click a page and choose <b>Save page for later</b>.</span>' : v.tab === 'read' ? 'No read items yet.' : 'The archive is empty.'; }
  else if (v.type === 'untagged') { ic = 'check'; msg = 'Every bookmark has at least one tag.'; }
  else if (v.type === 'suggestions') { ic = 'sparkles'; msg = 'No pending suggestions. Select bookmarks and choose <b>Auto-tag</b> to get some.'; }
  return `<div class="empty">${icon(ic)}<p>${msg}</p></div>`;
}

function readLaterHeader() {
  const root = S.rl && S.nodes.get(S.rl.rootId);
  const arch = S.rl && S.nodes.get(S.rl.archiveId);
  const kids = ((root && root.children) || []).filter(k => k.url);
  const unread = kids.filter(k => !metaOf(k.id).read);
  const read = kids.length - unread.length;
  const archived = ((arch && arch.children) || []).filter(k => k.url).length;
  const mins = unread.reduce((a, k) => a + (metaOf(k.id).minutes || 0), 0);
  const tab = (key, label, n) => `<a href="#readlater${key === 'unread' ? '' : '/' + key}" class="tab${S.view.tab === key ? ' active' : ''}" role="tab" aria-selected="${S.view.tab === key}">${label}<span class="count">${n}</span></a>`;
  return `<div class="view-head rl-head">
    <div class="tabs" role="tablist">${tab('unread', 'Unread', unread.length)}${tab('read', 'Read', read)}${tab('archived', 'Archived', archived)}</div>
    <span class="spacer"></span>
    ${S.view.tab === 'unread' && mins ? `<span class="muted small">${icon('clock')} about ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} of reading</span>` : ''}
    ${S.view.tab === 'read' && read ? `<button class="btn sm" data-act="archive-read">${icon('archive')}Archive all read</button>` : ''}
  </div>`;
}

function renderViewActions() {
  const v = S.view;
  const el = $('viewActions');
  if (S.query) { el.innerHTML = ''; return; }
  if (v.type === 'folder') {
    el.innerHTML = `<button class="btn ghost sm" data-act="new-folder" title="New folder (N)">${icon('folderPlus')}<span class="hide-sm">New folder</span></button>
      <button class="btn ghost icon sm" data-act="folder-more" title="Folder actions" aria-label="Folder actions">${icon('more')}</button>`;
  } else if (v.type === 'tag') {
    el.innerHTML = `<button class="btn ghost sm" data-act="rename-tag">${icon('edit')}<span class="hide-sm">Rename tag</span></button>`;
  } else el.innerHTML = '';
}

function healthPill(id) {
  const h = healthOf(id);
  if (!h) return '';
  if (h.status === 'dead') return `<span class="pill bad" title="${esc(h.detail || '')}">${icon('linkBroken')}Broken</span>`;
  if (h.status === 'redirect') return `<span class="pill warn" title="Redirects to ${esc(h.finalUrl || '')}">${icon('redirect')}Moved</span>`;
  if (h.status === 'warn') return `<span class="pill muted" title="${esc(h.detail || '')}">${esc(h.label || 'Warning')}</span>`;
  return '';
}

function rowHtml(n) {
  const m = metaOf(n.id);
  const sel = S.selection.has(n.id);
  const terms = searchCache ? searchCache.terms : [];
  const title = n.title || n.url;
  const tags = (m.tags || []);
  const showPath = S.query || ['all', 'recent', 'untagged', 'tag', 'suggestions'].includes(S.view.type);
  const hit = searchCache && searchCache.extra.get(n.id);
  const rl = inReadLater(n);
  const archived = S.rl && n.parentId === S.rl.archiveId;
  const unread = rl && !archived && !m.read;
  const badges = [
    healthPill(n.id),
    m.minutes ? `<span class="pill muted" title="Estimated reading time">${icon('clock')}${m.minutes} min</span>` : '',
    m.hasText ? `<span class="pill muted" title="Page text saved for full-text search">${icon('text')}</span>` : '',
    (m.suggested || []).length ? `<button class="pill info" data-act="review" title="Review suggested tags">${icon('sparkles')}${m.suggested.length}</button>` : ''
  ].join('');
  return `<div class="item link${sel ? ' selected' : ''}${unread ? ' unread' : ''}" role="option" aria-selected="${sel}" data-id="${n.id}" draggable="true" tabindex="-1">
    <input type="checkbox" class="sel" ${sel ? 'checked' : ''} tabindex="-1" aria-label="Select">
    <img class="fav" src="${esc(faviconUrl(n.url, 32))}" alt="" loading="lazy">
    <div class="body">
      <a class="title" href="${esc(n.url)}" data-act="open" title="${esc(title)}" tabindex="-1">${unread ? '<span class="dot" title="Unread"></span>' : ''}${highlight(title, terms)}</a>
      <div class="sub"><span class="url" title="${esc(n.url)}">${highlight(prettyUrl(n.url), terms)}</span>${showPath ? `<span class="path" title="${esc(n.path)}">${icon('folder')}${esc(n.path.split(' / ').slice(-2).join(' / '))}</span>` : ''}<span class="date">${fmtDate(rl ? m.rlAddedAt || n.dateAdded : n.dateAdded)}</span></div>
      ${hit ? `<div class="snippet">${snippet(n.id, hit, terms)}</div>` : ''}
      ${tags.length ? `<div class="tags">${tags.map(t => `<a class="chip" href="#tag/${encodeURIComponent(t)}" tabindex="-1">${highlight(t, terms)}</a>`).join('')}</div>` : ''}
    </div>
    <div class="badges">${badges}</div>
    <div class="row-actions">
      ${rl && !archived ? `<button class="btn ghost icon sm" data-act="${m.read ? 'unread' : 'read'}" title="${m.read ? 'Mark unread' : 'Mark read'}" aria-label="${m.read ? 'Mark unread' : 'Mark read'}">${icon(m.read ? 'inbox' : 'check')}</button>
        <button class="btn ghost icon sm" data-act="archive" title="Archive" aria-label="Archive">${icon('archive')}</button>` : ''}
      ${archived ? `<button class="btn ghost icon sm" data-act="unarchive" title="Move back to Read later" aria-label="Unarchive">${icon('inbox')}</button>` : ''}
      <button class="btn ghost icon sm" data-act="open-new" title="Open in new tab" aria-label="Open in new tab">${icon('external')}</button>
      <button class="btn ghost icon sm" data-act="delete" title="Delete (Del)" aria-label="Delete">${icon('trash')}</button>
    </div>
  </div>`;
}

function folderRowHtml(f) {
  const sel = S.selection.has(f.id);
  const subs = (f.children || []).filter(isFolder).length;
  return `<div class="item folder${sel ? ' selected' : ''}" role="option" aria-selected="${sel}" data-id="${f.id}" data-drop-folder="${f.id}" draggable="${!isProtected(f.id)}" tabindex="-1">
    <input type="checkbox" class="sel" ${sel ? 'checked' : ''} tabindex="-1" aria-label="Select">
    <span class="folder-ic">${icon(isReadLaterFolder(f.id) ? 'clock' : 'folder')}</span>
    <div class="body">
      <a class="title" href="#folder/${f.id}" data-act="open-folder" tabindex="-1">${highlight(f.title || '(untitled)', searchCache ? searchCache.terms : [])}</a>
      <div class="sub">${S.query ? `<span class="path">${esc(f.path || '')}</span>` : ''}<span>${plural(f.total || 0, 'bookmark')}${subs ? ` · ${plural(subs, 'folder')}` : ''}</span></div>
    </div>
    <div class="badges"></div>
    <div class="row-actions">${isProtected(f.id) ? '' : `<button class="btn ghost icon sm" data-act="delete" title="Delete folder" aria-label="Delete folder">${icon('trash')}</button>`}</div>
  </div>`;
}

// ---------- Bulk bar ----------
function renderBulkbar() {
  const bar = $('bulkbar');
  const n = S.selection.size;
  bar.hidden = !n;
  if (!n) return;
  const ids = [...S.selection];
  const nodes = ids.map(id => S.nodes.get(id)).filter(Boolean);
  const links = nodes.filter(x => x.url);
  const anyRl = links.some(inReadLater);
  bar.innerHTML = `<span class="bulk-count"><b>${n}</b> selected</span>
    <button class="btn ghost sm" data-bulk="select-all">Select all ${S.visible.length > n ? `(${S.visible.length.toLocaleString()})` : ''}</button>
    <span class="spacer"></span>
    <button class="btn sm" data-bulk="move" title="Move (M)">${icon('move')}<span class="hide-sm">Move</span></button>
    ${links.length ? `<button class="btn sm" data-bulk="tag" title="Tag (T)">${icon('tag')}<span class="hide-sm">Tag</span></button>
    <button class="btn sm" data-bulk="autotag" title="Fetch pages and suggest tags">${icon('sparkles')}<span class="hide-sm">Auto-tag</span></button>
    <button class="btn sm" data-bulk="savetext" title="Save page text for full-text search">${icon('text')}<span class="hide-sm">Save text</span></button>
    <button class="btn sm" data-bulk="check" title="Check these links">${icon('pulse')}<span class="hide-sm">Check</span></button>
    ${anyRl ? `<button class="btn sm" data-bulk="read">${icon('check')}<span class="hide-sm">Mark read</span></button>` : `<button class="btn sm" data-bulk="later">${icon('clock')}<span class="hide-sm">Read later</span></button>`}
    <button class="btn sm" data-bulk="openall" title="Open in new tabs">${icon('external')}<span class="hide-sm">Open</span></button>` : ''}
    <button class="btn sm danger" data-bulk="delete" title="Delete (Del)">${icon('trash')}<span class="hide-sm">Delete</span></button>
    <button class="btn ghost icon sm" data-bulk="clear" title="Clear selection (Esc)" aria-label="Clear selection">${icon('x')}</button>`;
}

async function bulk(action) {
  const ids = [...S.selection];
  const linkIds = ids.filter(id => S.nodes.get(id) && S.nodes.get(id).url);
  switch (action) {
    case 'select-all': S.visible.forEach(id => S.selection.add(id)); refreshSelection(); break;
    case 'clear': clearSelection(); break;
    case 'move': {
      const dest = await pickFolder({ title: `Move ${plural(ids.length, 'item')}`, exclude: new Set(ids.filter(id => !S.nodes.get(id).url)) });
      if (dest) {
        const n = await moveItems(ids, dest);
        if (isReadLaterFolder(dest)) await updateMetaMany(linkIds.map(id => [id, m => ({ ...m, rl: true, read: dest === S.rl.archiveId, rlAddedAt: Date.now() })]));
        toast(`Moved ${plural(n, 'item')} to ${S.nodes.get(dest) ? S.nodes.get(dest).title : 'folder'}`);
      }
      break;
    }
    case 'tag': await tagDialog(linkIds); break;
    case 'autotag': await autoTag(linkIds); break;
    case 'savetext': await saveTexts(linkIds); break;
    case 'check': await checkLinks(linkIds); break;
    case 'read': await setRead(linkIds.filter(id => inReadLater(S.nodes.get(id))), true); await reload({ metaOnly: true }); break;
    case 'later': {
      if (!S.rl) break;
      await moveItems(linkIds, S.rl.rootId);
      await updateMetaMany(linkIds.map(id => [id, m => ({ ...m, rl: true, read: false, rlAddedAt: Date.now() })]));
      toast(`Added ${plural(linkIds.length, 'bookmark')} to Read later`, { action: { label: 'View', fn: () => go({ type: 'readlater', tab: 'unread' }) } });
      break;
    }
    case 'openall': {
      if (linkIds.length > 15 && !await confirmDialog('Open many tabs?', `Open ${linkIds.length} tabs?`, 'Open')) break;
      for (const id of linkIds) openBookmark(id, false);
      break;
    }
    case 'delete': await deleteItems(ids, { confirmAbove: 25 }); break;
  }
}

async function tagDialog(ids) {
  if (!ids.length) return;
  const present = new Map();
  for (const id of ids) for (const t of tagsOf(id)) present.set(t, (present.get(t) || 0) + 1);
  const body = document.createElement('div');
  body.className = 'tag-dlg';
  const input = createTagInput({ vocab: () => S.vocab, placeholder: 'Tags to add…' });
  body.innerHTML = `<div class="field-label">Add tags</div>`;
  body.append(input.el);
  const quick = new Map();
  for (const id of ids.slice(0, 50)) for (const t of quickSuggest(id)) quick.set(t, (quick.get(t) || 0) + 1);
  const quickList = [...quick].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter(t => !present.has(t)).slice(0, 10);
  if (quickList.length) {
    const s = document.createElement('div');
    s.className = 'suggest-row';
    s.innerHTML = `<span class="muted small">From titles:</span>${quickList.map(t => `<button type="button" class="chip suggest" data-t="${esc(t)}">+ ${esc(t)}</button>`).join('')}`;
    s.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { input.add(b.dataset.t); b.remove(); } });
    body.append(s);
  }
  if (present.size) {
    const r = document.createElement('div');
    r.innerHTML = `<div class="field-label" style="margin-top:16px">Remove tags</div><div class="remove-tags">${[...present].sort((a, b) => b[1] - a[1]).map(([t, n]) => `<label class="check chip muted"><input type="checkbox" value="${esc(t)}">${esc(t)} <span class="faint">${n}</span></label>`).join('')}</div>`;
    body.append(r);
  }
  const v = await dialog({ title: `Tag ${plural(ids.length, 'bookmark')}`, body, actions: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: true }] });
  if (!v) return;
  const remove = [...body.querySelectorAll('.remove-tags input:checked')].map(i => i.value);
  const add = input.value;
  if (!add.length && !remove.length) return;
  await addRemoveTags(ids, add, remove);
  toast(`Updated tags on ${plural(ids.length, 'bookmark')}`);
}

// ---------- Selection ----------
function setFocus(id, scroll = true) {
  S.focusId = id;
  const items = $('content').querySelectorAll('.item');
  let target = null;
  items.forEach(el => { const on = el.dataset.id === id; el.tabIndex = on ? 0 : -1; if (on) target = el; });
  if (target) { target.focus({ preventScroll: !scroll }); if (scroll) target.scrollIntoView({ block: 'nearest' }); }
}
function refreshSelection() {
  $('content').querySelectorAll('.item').forEach(el => {
    const on = S.selection.has(el.dataset.id);
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', String(on));
    const cb = el.querySelector('.sel');
    if (cb) cb.checked = on;
  });
  renderBulkbar();
  renderInspector();
}
function clearSelection() { S.selection.clear(); S.anchor = null; refreshSelection(); }
function selectRange(toId) {
  const a = S.visible.indexOf(S.anchor || toId);
  const b = S.visible.indexOf(toId);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) S.selection.add(S.visible[i]);
}
function clickSelect(id, e) {
  if (e.shiftKey) { if (!(e.ctrlKey || e.metaKey)) S.selection.clear(); selectRange(id); }
  else if (e.ctrlKey || e.metaKey) { if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id); S.anchor = id; }
  else { S.selection.clear(); S.selection.add(id); S.anchor = id; }
  setFocus(id, false);
  refreshSelection();
}

async function openBookmark(id, active = true) {
  const n = S.nodes.get(id);
  if (!n || !n.url) return;
  if (!/^(https?|ftp|file|chrome|edge|brave|about):/i.test(n.url)) { toast('This bookmark cannot be opened from here (bookmarklet or special URL).'); return; }
  try { await chrome.tabs.create({ url: n.url, active }); } catch (e) { toast('Could not open: ' + e.message, { kind: 'warn' }); return; }
  if (inReadLater(n) && S.settings.openReadLaterMarksRead && !metaOf(id).read && n.parentId === S.rl.rootId) {
    await setRead(id, true);
  }
}

// ---------- Content events ----------
function bindContent() {
  const content = $('content');
  content.addEventListener('click', async e => {
    const actEl = e.target.closest('[data-act]');
    const item = e.target.closest('.item');
    const id = item && item.dataset.id;
    if (actEl) {
      const act = actEl.dataset.act;
      if (['open', 'open-folder'].includes(act) && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); if (id) clickSelect(id, e); return; }
      e.preventDefault();
      e.stopPropagation();
      switch (act) {
        case 'open': openBookmark(id, true); return;
        case 'open-new': openBookmark(id, false); return;
        case 'open-folder': go({ type: 'folder', id }); return;
        case 'delete': deleteItems(S.selection.has(id) && S.selection.size > 1 ? [...S.selection] : [id], { confirmAbove: 25 }); return;
        case 'read': await setRead(id, true); return;
        case 'unread': await setRead(id, false); return;
        case 'archive': await archive(id, true); toast('Archived', { action: { label: 'Undo', fn: () => archive(id, false) } }); return;
        case 'unarchive': await archive(id, false); await setRead(id, false); return;
        case 'review': reviewSuggestions([id]); return;
        case 'review-all': reviewSuggestions(S.visible); return;
        case 'archive-read': {
          const root = S.nodes.get(S.rl.rootId);
          const ids = (root.children || []).filter(k => k.url && metaOf(k.id).read).map(k => k.id);
          await archive(ids, true);
          toast(`Archived ${plural(ids.length, 'item')}`);
          return;
        }
        case 'search-help': searchHelp(); return;
      }
      if (actEl.tagName === 'A' && actEl.getAttribute('href')) location.hash = actEl.getAttribute('href');
      return;
    }
    if (e.target.closest('.chip[href]')) return; // tag link navigates
    if (!item) { if (e.target === content || e.target.id === 'items') clearSelection(); return; }
    if (e.target.classList.contains('sel')) {
      if (e.shiftKey) selectRange(id);
      else if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id);
      S.anchor = id;
      setFocus(id, false);
      refreshSelection();
      return;
    }
    clickSelect(id, e);
  });
  content.addEventListener('dblclick', e => {
    const item = e.target.closest('.item');
    if (!item || e.target.closest('button, input')) return;
    const n = S.nodes.get(item.dataset.id);
    if (n && n.url) openBookmark(n.id); else if (n) go({ type: 'folder', id: n.id });
  });
  content.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    const a = e.target.closest('[data-act="open"]');
    if (a) { e.preventDefault(); openBookmark(a.closest('.item').dataset.id, false); }
  });
  content.addEventListener('focusin', e => {
    const item = e.target.closest('.item');
    if (item) S.focusId = item.dataset.id;
  });
}

function searchHelp() {
  dialog({
    title: 'Search tips',
    body: `<table class="help-table">
      <tr><td><code>react hooks</code></td><td>All words must match title, URL, tags, note or saved page text</td></tr>
      <tr><td><code>"exact phrase"</code></td><td>Match a phrase</td></tr>
      <tr><td><code>-word</code></td><td>Exclude a word</td></tr>
      <tr><td><code>tag:recipes</code> or <code>#recipes</code></td><td>Has tag (use <code>-tag:x</code> to exclude)</td></tr>
      <tr><td><code>site:github.com</code></td><td>From a website</td></tr>
      <tr><td><code>in:work</code></td><td>Inside a folder whose path contains “work”</td></tr>
      <tr><td><code>is:unread</code> <code>is:read</code> <code>is:readlater</code></td><td>Read later state</td></tr>
      <tr><td><code>is:untagged</code> <code>is:duplicate</code></td><td>Organization</td></tr>
      <tr><td><code>is:broken</code> <code>is:redirect</code></td><td>From the last health check</td></tr>
      <tr><td><code>has:text</code> <code>has:note</code> <code>has:suggestions</code></td><td>Has saved page text, a note, or pending tag suggestions</td></tr>
    </table>`,
    actions: [{ label: 'Close', value: true, primary: true }]
  });
}

// ---------- Keyboard ----------
function bindKeyboard() {
  document.addEventListener('keydown', async e => {
    if (document.querySelector('dialog[open]')) return;
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); $('search').select(); return; }
    if (mod && e.key.toLowerCase() === 'f' && !typing) { e.preventDefault(); $('search').focus(); return; }
    if (typing) return;
    if (e.target.closest && e.target.closest('#tree')) return; // tree handles its own keys
    const listView = LIST_VIEWS.has(S.view.type) || S.query;
    if (e.key === 'Escape') {
      if (S.selection.size) { clearSelection(); return; }
      if (S.query) { $('search').value = ''; setQuery(''); return; }
      return;
    }
    if (!listView) return;
    const vis = S.visible;
    const idx = vis.indexOf(S.focusId);
    const moveTo = i => {
      if (!vis.length) return;
      i = Math.max(0, Math.min(vis.length - 1, i));
      const id = vis[i];
      ensureRendered(id);
      if (e.shiftKey) { if (!S.anchor) S.anchor = S.focusId || id; S.selection.clear(); selectRange(id); }
      else if (!mod) { S.selection.clear(); S.selection.add(id); S.anchor = id; }
      setFocus(id);
      refreshSelection();
    };
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); moveTo(idx < 0 ? 0 : idx + (S.layout === 'grid' && e.key === 'ArrowDown' ? gridCols() : 1)); return;
      case 'ArrowUp': case 'k': e.preventDefault(); moveTo(idx < 0 ? 0 : idx - (S.layout === 'grid' && e.key === 'ArrowUp' ? gridCols() : 1)); return;
      case 'ArrowRight': if (S.layout === 'grid') { e.preventDefault(); moveTo(idx + 1); } return;
      case 'ArrowLeft': if (S.layout === 'grid') { e.preventDefault(); moveTo(idx - 1); } return;
      case 'Home': e.preventDefault(); moveTo(0); return;
      case 'End': e.preventDefault(); moveTo(vis.length - 1); return;
      case ' ':
        if (S.focusId) { e.preventDefault(); if (S.selection.has(S.focusId)) S.selection.delete(S.focusId); else S.selection.add(S.focusId); S.anchor = S.focusId; refreshSelection(); }
        return;
      case 'Enter': {
        if (!S.focusId) return;
        e.preventDefault();
        const n = S.nodes.get(S.focusId);
        if (n && n.url) openBookmark(n.id, !mod); else if (n) go({ type: 'folder', id: n.id });
        return;
      }
      case 'Delete': case 'Backspace':
        if (S.selection.size) { e.preventDefault(); deleteItems([...S.selection], { confirmAbove: 25 }); }
        return;
    }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); vis.forEach(id => S.selection.add(id)); refreshSelection(); return; }
    if (mod || e.altKey) {
      if (e.altKey && e.key === 'ArrowUp' && S.view.type === 'folder') {
        const n = S.nodes.get(S.view.id);
        if (n && n.parentId && n.parentId !== '0') go({ type: 'folder', id: n.parentId });
      }
      return;
    }
    switch (e.key.toLowerCase()) {
      case 'm': if (S.selection.size) bulk('move'); break;
      case 't': if (S.selection.size) bulk('tag'); break;
      case 'g': setLayout(S.layout === 'grid' ? 'list' : 'grid'); break;
      case 'i': S.inspectorOpen = !S.inspectorOpen; pref.set('inspector', S.inspectorOpen); renderInspector(true); break;
      case 'n': if (S.view.type === 'folder') newFolder(S.view.id); break;
      case 'r': if (S.focusId && S.view.type === 'readlater') { const m = metaOf(S.focusId); setRead(S.focusId, !m.read); } break;
      case 'e': case 'f2': { const t = $('inspector').querySelector('[data-f="title"]'); if (t) { S.inspectorOpen = true; t.focus(); t.select(); } break; }
    }
  });
}
function gridCols() {
  const items = $('content').querySelectorAll('.item');
  if (items.length < 2) return 1;
  const top = items[0].offsetTop;
  let c = 0;
  for (const it of items) { if (it.offsetTop !== top) break; c++; }
  return Math.max(1, c);
}
function ensureRendered(id) {
  let guard = 0;
  while (!$('content').querySelector(`.item[data-id="${CSS.escape(id)}"]`) && S.renderMore && guard++ < 500) {
    if (!S.renderMore()) break;
  }
}

function setLayout(l) {
  S.layout = l;
  pref.set('layout', l);
  render();
}

// ---------- Tree events ----------
function bindTree() {
  const tree = $('tree');
  tree.addEventListener('click', e => {
    const it = e.target.closest('.tree-item');
    if (!it) return;
    const id = it.dataset.id;
    if (e.target.closest('.twisty')) { toggleExpand(id); return; }
    go({ type: 'folder', id });
  });
  tree.addEventListener('dblclick', e => { const it = e.target.closest('.tree-item'); if (it && !e.target.closest('.twisty')) toggleExpand(it.dataset.id); });
  tree.addEventListener('keydown', e => {
    const it = e.target.closest('.tree-item');
    if (!it) return;
    const items = [...tree.querySelectorAll('.tree-item')];
    const i = items.indexOf(it);
    const focus = el => { if (!el) return; items.forEach(x => { x.tabIndex = -1; }); el.tabIndex = 0; el.focus(); };
    const id = it.dataset.id;
    const expanded = it.getAttribute('aria-expanded');
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focus(items[i + 1]); break;
      case 'ArrowUp': e.preventDefault(); focus(items[i - 1]); break;
      case 'ArrowRight': e.preventDefault(); if (expanded === 'false') toggleExpand(id, true); else if (expanded === 'true') focus(items[i + 1]); break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (expanded === 'true') toggleExpand(id, true);
        else { const p = S.nodes.get(id).parentId; focus(tree.querySelector(`[data-id="${CSS.escape(p)}"]`)); }
        break;
      }
      case 'Enter': case ' ': e.preventDefault(); go({ type: 'folder', id }); break;
      case 'Home': e.preventDefault(); focus(items[0]); break;
      case 'End': e.preventDefault(); focus(items[items.length - 1]); break;
      case 'F2': e.preventDefault(); renameFolder(id); break;
      case 'Delete': e.preventDefault(); deleteItems([id]); break;
    }
  });
}
function toggleExpand(id, keepFocus) {
  if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
  pref.set('expanded', [...S.expanded]);
  renderTree();
  if (keepFocus) { const el = $('tree').querySelector(`[data-id="${CSS.escape(id)}"]`); if (el) { $('tree').querySelectorAll('.tree-item').forEach(x => { x.tabIndex = -1; }); el.tabIndex = 0; el.focus(); } }
}

async function newFolder(parentId) {
  const name = await promptDialog('New folder', 'Folder name', '', 'Create');
  if (!name) return;
  const f = await chrome.bookmarks.create({ parentId, title: name });
  S.expanded.add(parentId);
  await reload();
  toast(`Created “${f.title}”`);
}
async function renameFolder(id) {
  if (isProtected(id)) { toast('Built-in folders cannot be renamed.'); return; }
  const n = S.nodes.get(id);
  const name = await promptDialog('Rename folder', 'Folder name', n.title, 'Rename');
  if (name && name !== n.title) await chrome.bookmarks.update(id, { title: name });
}
async function sortFolder(id, by) {
  const f = S.nodes.get(id);
  const kids = [...(f.children || [])];
  const cmp = by === 'date' ? SORTS.newest.fn : by === 'domain' ? SORTS.domain.fn : SORTS.title.fn;
  const sorted = [...kids.filter(isFolder).sort(SORTS.title.fn), ...kids.filter(k => k.url).sort(cmp)];
  await markBulk(true);
  for (let i = 0; i < sorted.length; i++) {
    try { await chrome.bookmarks.move(sorted[i].id, { parentId: id, index: i }); } catch { /* ignore */ }
  }
  await markBulk(false);
  toast(`Sorted “${f.title}”`);
}
// ---------- Drag & drop ----------
let dragIds = null;
function bindDnd() {
  document.addEventListener('dragstart', e => {
    const it = e.target.closest && e.target.closest('.item, .tree-item');
    if (!it) return;
    const id = it.dataset.id;
    if (isProtected(id)) { e.preventDefault(); return; }
    dragIds = it.classList.contains('item') && S.selection.has(id) ? [...S.selection] : [id];
    dragIds = dragIds.filter(x => !isProtected(x));
    const urls = dragIds.map(x => S.nodes.get(x)).filter(n => n && n.url).map(n => n.url);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('application/x-smart-bookmarks', JSON.stringify(dragIds));
    if (urls.length) { e.dataTransfer.setData('text/uri-list', urls.join('\r\n')); e.dataTransfer.setData('text/plain', urls.join('\n')); }
    const ghost = $('dragGhost');
    ghost.textContent = dragIds.length > 1 ? `${dragIds.length} items` : (S.nodes.get(id).title || S.nodes.get(id).url || '').slice(0, 60);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    document.body.classList.add('dragging');
    requestAnimationFrame(() => dragIds && dragIds.forEach(x => document.querySelectorAll(`[data-id="${CSS.escape(x)}"]`).forEach(el => el.classList.add('drag-src'))));
  });
  document.addEventListener('dragend', () => {
    dragIds = null;
    document.body.classList.remove('dragging');
    document.querySelectorAll('.drag-src, .drop-into, .drop-before').forEach(el => el.classList.remove('drag-src', 'drop-into', 'drop-before'));
  });
  const targetOf = e => {
    const folderEl = e.target.closest && e.target.closest('[data-drop-folder]');
    const rowEl = e.target.closest && e.target.closest('.item.link');
    if (folderEl) return { el: folderEl, parentId: folderEl.dataset.dropFolder, mode: 'into' };
    if (rowEl && S.manualDrop) return { el: rowEl, parentId: S.view.id, beforeId: rowEl.dataset.id, mode: 'before' };
    if (e.target.closest && e.target.closest('#content') && S.view.type === 'folder' && !S.query) return { el: null, parentId: S.view.id, mode: 'into' };
    return null;
  };
  const valid = t => {
    if (!t) return false;
    if (!dragIds) return true; // external drop
    if (t.beforeId && dragIds.includes(t.beforeId)) return false;
    return !dragIds.some(id => { const n = S.nodes.get(id); return !n || (!n.url && isAncestor(id, t.parentId)); });
  };
  document.addEventListener('dragover', e => {
    const external = !dragIds && e.dataTransfer.types.includes('text/uri-list');
    if (!dragIds && !external) return;
    const t = targetOf(e);
    document.querySelectorAll('.drop-into, .drop-before').forEach(el => el.classList.remove('drop-into', 'drop-before'));
    if (!valid(t)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = external ? 'copy' : 'move';
    if (t.el) t.el.classList.add(t.mode === 'before' ? 'drop-before' : 'drop-into');
  });
  document.addEventListener('dragleave', e => {
    if (e.target.classList) e.target.classList.remove('drop-into', 'drop-before');
  });
  document.addEventListener('drop', async e => {
    const t = targetOf(e);
    if (!valid(t)) return;
    e.preventDefault();
    document.querySelectorAll('.drop-into, .drop-before').forEach(el => el.classList.remove('drop-into', 'drop-before'));
    let ids = dragIds;
    if (!ids) {
      const raw = e.dataTransfer.getData('application/x-smart-bookmarks');
      if (raw) { try { ids = JSON.parse(raw); } catch { ids = null; } }
    }
    if (ids && ids.length) {
      const n = await moveItems(ids, t.parentId, t.beforeId);
      if (isReadLaterFolder(t.parentId)) {
        const linkIds = ids.filter(id => S.nodes.get(id) && S.nodes.get(id).url);
        await updateMetaMany(linkIds.map(id => [id, m => ({ ...m, rl: true, read: t.parentId === S.rl.archiveId, rlAddedAt: m.rlAddedAt || Date.now() })]));
      }
      if (t.mode === 'into' && t.parentId !== S.view.id) toast(`Moved ${plural(n, 'item')} to ${S.nodes.get(t.parentId) ? S.nodes.get(t.parentId).title : 'folder'}`);
      return;
    }
    // External links dropped from a page or the address bar.
    const list = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#') && isHttpUrl(s));
    if (!list.length) return;
    for (const url of list) await chrome.bookmarks.create({ parentId: t.parentId, url, title: url, ...(t.beforeId ? { index: S.nodes.get(t.beforeId).index } : {}) });
    toast(`Added ${plural(list.length, 'bookmark')}`);
  });
}

// ---------- Inspector ----------
let inspectorFor = null;
let noteTimer = null;
function renderInspector(force = false) {
  const el = $('inspector');
  const ids = [...S.selection];
  const listView = LIST_VIEWS.has(S.view.type) || S.query;
  const show = S.inspectorOpen && listView && ids.length > 0;
  $('inspectorToggle').setAttribute('aria-pressed', String(S.inspectorOpen));
  el.hidden = !show;
  document.body.classList.toggle('with-inspector', show);
  if (!show) { inspectorFor = null; return; }
  const key = ids.length === 1 ? ids[0] : 'multi:' + ids.length;
  if (!force && key === inspectorFor && el.contains(document.activeElement)) return;
  inspectorFor = key;
  if (ids.length > 1) { renderMultiInspector(el, ids); return; }
  const n = S.nodes.get(ids[0]);
  if (!n) { el.hidden = true; return; }
  if (!n.url) { renderFolderInspector(el, n); return; }
  renderLinkInspector(el, n);
}

function inspHead(title, ic) {
  return `<header class="insp-head">${ic}<h2>${esc(title)}</h2><button class="btn ghost icon sm" data-i="close" aria-label="Close details (I)" title="Close (I)">${icon('x')}</button></header>`;
}

function renderLinkInspector(el, n) {
  const m = metaOf(n.id);
  const h = healthOf(n.id);
  const rl = inReadLater(n);
  const archived = S.rl && n.parentId === S.rl.archiveId;
  el.dataset.id = n.id;
  el.innerHTML = `${inspHead('Details', `<img class="fav lg" src="${esc(faviconUrl(n.url, 64))}" alt="">`)}
    <div class="insp-body">
      <label class="field"><span class="field-label">Title</span><input class="input" data-f="title" value="${esc(n.title)}"></label>
      <label class="field"><span class="field-label">URL</span><input class="input mono" data-f="url" value="${esc(n.url)}" spellcheck="false"></label>
      <div class="field"><span class="field-label">Folder</span>
        <div class="folder-line"><a href="#folder/${n.parentId}" class="folder-link">${icon('folder')}<span>${esc(n.path || '')}</span></a><button class="btn sm" data-i="move">Move</button></div></div>
      <div class="field"><span class="field-label">Tags</span><div data-mount="tags"></div>
        <div class="suggest-row" data-mount="sugg"></div></div>
      <label class="field"><span class="field-label">Note</span><textarea class="textarea" data-f="note" rows="3" placeholder="Add a note…">${esc(m.note || '')}</textarea></label>

      <section class="insp-sec">
        <div class="sec-head">${icon('clock')}<span>Read later</span></div>
        ${rl ? `<div class="sec-row"><span class="pill ${archived ? 'muted' : m.read ? 'ok' : 'info'}">${archived ? 'Archived' : m.read ? 'Read' : 'Unread'}</span>
          ${m.minutes ? `<span class="muted small">${m.minutes} min read</span>` : ''}<span class="spacer"></span>
          ${archived ? `<button class="btn sm" data-i="unarchive">Unarchive</button>` : `<button class="btn sm" data-i="toggle-read">Mark ${m.read ? 'unread' : 'read'}</button><button class="btn sm" data-i="archive">Archive</button>`}</div>`
        : `<div class="sec-row"><span class="muted small">Not in your reading list.</span><span class="spacer"></span><button class="btn sm" data-i="later">Add to Read later</button></div>`}
      </section>

      <section class="insp-sec">
        <div class="sec-head">${icon('text')}<span>Saved page text</span></div>
        ${m.hasText ? `<div class="sec-row"><span class="muted small">${(m.words || 0).toLocaleString()} words · saved ${fmtDate(m.textAt)}</span><span class="spacer"></span>
          <button class="btn sm" data-i="savetext">Refresh</button><button class="btn sm ghost" data-i="rmtext">Remove</button></div>
          <div class="text-preview" data-mount="preview"><span class="spinner"></span></div>`
        : `<div class="sec-row"><span class="muted small">Save the page text to find this bookmark by its content.</span><span class="spacer"></span><button class="btn sm" data-i="savetext">Save text</button></div>`}
      </section>

      <section class="insp-sec">
        <div class="sec-head">${icon('pulse')}<span>Link health</span></div>
        <div class="sec-row">${h ? `${healthPill(n.id) || '<span class="pill ok">OK</span>'}<span class="muted small">${esc(h.detail || '')} · ${fmtDate(h.at)}</span>` : '<span class="muted small">Not checked yet.</span>'}
          <span class="spacer"></span><button class="btn sm" data-i="check">Check now</button></div>
        ${h && h.status === 'redirect' && h.finalUrl ? `<div class="sec-row redirect"><span class="small">Now at <a href="${esc(h.finalUrl)}" target="_blank" rel="noreferrer">${esc(prettyUrl(h.finalUrl))}</a></span><button class="btn sm primary" data-i="use-final">Update URL</button></div>` : ''}
      </section>
      <div class="insp-meta faint small">Added ${n.dateAdded ? new Date(n.dateAdded).toLocaleString() : 'unknown'}</div>
    </div>
    <footer class="insp-foot">
      <button class="btn primary" data-i="open">${icon('external')}Open</button>
      <button class="btn danger" data-i="delete">${icon('trash')}Delete</button>
    </footer>`;

  const tagInput = createTagInput({ value: m.tags || [], vocab: () => S.vocab, onChange: tags => setTags(n.id, tags).then(() => { renderSideTags(); renderNav(); patchRow(n.id); }) });
  el.querySelector('[data-mount="tags"]').append(tagInput.el);
  renderInspectorSuggestions(el, n, tagInput);

  if (m.hasText) {
    getText(n.id).then(t => {
      const p = el.querySelector('[data-mount="preview"]');
      if (p) p.textContent = t ? t.text.slice(0, 600) + (t.text.length > 600 ? '…' : '') : 'Text not found.';
    }).catch(() => {});
  }

  el.querySelector('[data-f="title"]').addEventListener('change', e => chrome.bookmarks.update(n.id, { title: e.target.value.trim() }));
  el.querySelector('[data-f="url"]').addEventListener('change', async e => {
    const url = e.target.value.trim();
    try { new URL(url); await chrome.bookmarks.update(n.id, { url }); toast('URL updated'); }
    catch { toast('That does not look like a valid URL.', { kind: 'warn' }); e.target.value = n.url; }
  });
  el.querySelector('[data-f="note"]').addEventListener('input', e => {
    clearTimeout(noteTimer);
    const v = e.target.value;
    noteTimer = setTimeout(() => updateMetaMany([[n.id, { note: v.trim() || undefined }]]), 400);
  });
}

function renderInspectorSuggestions(el, n, tagInput) {
  const mount = el.querySelector('[data-mount="sugg"]');
  const m = metaOf(n.id);
  const pending = (m.suggested || []).filter(t => !(m.tags || []).includes(t));
  const quick = pending.length ? [] : quickSuggest(n.id).filter(t => !(m.tags || []).includes(t)).slice(0, 5);
  const list = pending.length ? pending : quick;
  mount.innerHTML = `${list.length ? `<span class="muted small">${pending.length ? 'Suggested:' : 'Ideas:'}</span>` : ''}
    ${list.map(t => `<button type="button" class="chip suggest" data-t="${esc(t)}">+ ${esc(t)}</button>`).join('')}
    ${pending.length ? `<button type="button" class="btn ghost sm" data-s="accept">Accept all</button><button type="button" class="btn ghost sm" data-s="dismiss">Dismiss</button>` : ''}
    <button type="button" class="btn ghost sm" data-s="fetch" title="Fetch the page and suggest tags">${icon('sparkles')}Suggest from page</button>`;
  mount.onclick = async e => {
    const c = e.target.closest('[data-t]');
    if (c) { tagInput.add(c.dataset.t); c.remove(); return; }
    const s = e.target.closest('[data-s]');
    if (!s) return;
    if (s.dataset.s === 'accept') { pending.forEach(t => tagInput.add(t)); await updateMetaMany([[n.id, { suggested: undefined }]]); }
    if (s.dataset.s === 'dismiss') { await updateMetaMany([[n.id, { suggested: undefined }]]); }
    if (s.dataset.s === 'fetch') { await autoTag([n.id]); }
    await reload({ metaOnly: true });
    renderInspector(true);
  };
}

function renderFolderInspector(el, f) {
  const prot = isProtected(f.id);
  const subs = (f.children || []).filter(isFolder).length;
  el.dataset.id = f.id;
  el.innerHTML = `${inspHead('Folder', `<span class="folder-ic lg">${icon('folder')}</span>`)}
    <div class="insp-body">
      <label class="field"><span class="field-label">Name</span><input class="input" data-f="title" value="${esc(f.title)}" ${prot ? 'disabled' : ''}></label>
      <div class="field"><span class="field-label">Location</span><span class="small">${esc(f.path || 'Top level')}</span></div>
      <div class="stat-grid"><div><b>${(f.total || 0).toLocaleString()}</b><span>bookmarks</span></div><div><b>${subs}</b><span>subfolders</span></div><div><b>${f.links || 0}</b><span>direct links</span></div></div>
      ${prot ? '<p class="muted small">This is a built-in browser folder. It cannot be renamed, moved or deleted.</p>' : ''}
    </div>
    <footer class="insp-foot"><button class="btn primary" data-i="open-folder">${icon('folderOpen')}Open</button>${prot ? '' : `<button class="btn danger" data-i="delete">${icon('trash')}Delete</button>`}</footer>`;
  const t = el.querySelector('[data-f="title"]');
  t.addEventListener('change', () => { if (t.value.trim()) chrome.bookmarks.update(f.id, { title: t.value.trim() }); });
}

function renderMultiInspector(el, ids) {
  const nodes = ids.map(id => S.nodes.get(id)).filter(Boolean);
  const links = nodes.filter(n => n.url);
  const tagCounts = new Map();
  for (const n of links) for (const t of tagsOf(n.id)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const hosts = new Map();
  for (const n of links) hosts.set(n.host, (hosts.get(n.host) || 0) + 1);
  el.dataset.id = '';
  el.innerHTML = `${inspHead(`${ids.length} selected`, `<span class="folder-ic lg">${icon('bookmarks')}</span>`)}
    <div class="insp-body">
      <div class="stat-grid"><div><b>${links.length}</b><span>bookmarks</span></div><div><b>${nodes.length - links.length}</b><span>folders</span></div><div><b>${hosts.size}</b><span>websites</span></div></div>
      ${tagCounts.size ? `<div class="field"><span class="field-label">Tags in selection</span><div class="tags">${[...tagCounts].sort((a, b) => b[1] - a[1]).map(([t, c]) => `<span class="chip">${esc(t)} <span class="faint">${c}</span></span>`).join('')}</div></div>` : ''}
      <div class="field"><span class="field-label">Top websites</span><div class="host-list">${[...hosts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, c]) => `<div><span>${esc(h)}</span><span class="faint">${c}</span></div>`).join('')}</div></div>
      <p class="muted small">Use the action bar above, or keyboard: <kbd>M</kbd> move, <kbd>T</kbd> tag, <kbd>Del</kbd> delete.</p>
    </div>`;
}

function bindInspector() {
  $('inspector').addEventListener('click', async e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const id = $('inspector').dataset.id;
    const n = S.nodes.get(id);
    switch (b.dataset.i) {
      case 'close': S.inspectorOpen = false; pref.set('inspector', false); renderInspector(true); break;
      case 'open': openBookmark(id); break;
      case 'open-folder': go({ type: 'folder', id }); break;
      case 'delete': deleteItems([id]); break;
      case 'move': { const d = await pickFolder({ initial: n.parentId }); if (d) await moveItems([id], d); break; }
      case 'toggle-read': await setRead(id, !metaOf(id).read); break;
      case 'archive': await archive(id, true); break;
      case 'unarchive': await archive(id, false); await setRead(id, false); break;
      case 'later': await moveItems([id], S.rl.rootId); await updateMetaMany([[id, m => ({ ...m, rl: true, read: false, rlAddedAt: Date.now() })]]); break;
      case 'savetext': await saveTexts([id]); renderInspector(true); break;
      case 'rmtext': await removeTexts([id]); renderInspector(true); break;
      case 'check': await checkLinks([id]); renderInspector(true); break;
      case 'use-final': {
        const h = healthOf(id);
        await chrome.bookmarks.update(id, { url: h.finalUrl });
        delete S.health.results[id];
        toast('URL updated');
        break;
      }
    }
  });
}

function patchRow(id) {
  const el = $('content').querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  const n = S.nodes.get(id);
  if (!el || !n || !n.url) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = rowHtml(n);
  const fresh = tmp.firstElementChild;
  fresh.tabIndex = el.tabIndex;
  el.replaceWith(fresh);
}

// ---------- Sidebar / toolbar ----------
let searchTimer = null;
function setQuery(q) {
  S.query = q.trim();
  S.selection.clear();
  S.focusId = null;
  if (S.query && !S.textsLoaded) loadTexts().then(() => { if (S.query) renderMain(); });
  render();
}
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

function bindChrome() {
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery($('search').value), 120);
  });
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { if ($('search').value) { e.preventDefault(); $('search').value = ''; setQuery(''); } else $('search').blur(); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      const first = S.visible[0];
      if (first) { S.selection.clear(); S.selection.add(first); S.anchor = first; refreshSelection(); setFocus(first); }
    }
  });
  $('sort').addEventListener('change', e => { pref.set('sort.' + (S.query ? 'search' : S.view.type), e.target.value); renderMain(); });
  $('layoutList').addEventListener('click', () => setLayout('list'));
  $('layoutGrid').addEventListener('click', () => setLayout('grid'));
  $('inspectorToggle').addEventListener('click', () => { S.inspectorOpen = !S.inspectorOpen; pref.set('inspector', S.inspectorOpen); renderInspector(true); });
  $('menuBtn').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('scrim').addEventListener('click', closeSidebar);
  $('newFolderSide').addEventListener('click', () => newFolder(S.view.type === 'folder' ? S.view.id : (S.root.children[0] || {}).id));
  $('bulkbar').addEventListener('click', e => { const b = e.target.closest('[data-bulk]'); if (b) bulk(b.dataset.bulk); });
  $('viewActions').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'new-folder') newFolder(S.view.id);
    if (b.dataset.act === 'folder-more') runFolderMenu();
    if (b.dataset.act === 'rename-tag') {
      const { renameTag } = await import('./ops.js');
      const to = await promptDialog('Rename tag', 'New name', S.view.tag, 'Rename');
      if (to && to !== S.view.tag) { const c = await renameTag(S.view.tag, to); toast(`Renamed on ${plural(c, 'bookmark')}`); go({ type: 'tag', tag: to }); }
    }
  });
  $('nav').addEventListener('click', e => { if (e.target.closest('a')) closeSidebar(); });
}

async function runFolderMenu() {
  const id = S.view.id;
  const n = S.nodes.get(id);
  const prot = isProtected(id);
  let choice = null;
  await dialog({
    title: n.title || 'Folder',
    body: `<div class="menu-list">
      <button type="button" class="menu-item" data-v="new">${icon('folderPlus')}New subfolder</button>
      ${prot ? '' : `<button type="button" class="menu-item" data-v="rename">${icon('edit')}Rename</button>`}
      <button type="button" class="menu-item" data-v="sort-title">${icon('sort')}Sort permanently by title</button>
      <button type="button" class="menu-item" data-v="sort-date">${icon('sort')}Sort permanently by date added</button>
      <button type="button" class="menu-item" data-v="sort-domain">${icon('sort')}Sort permanently by website</button>
      <button type="button" class="menu-item" data-v="check">${icon('pulse')}Check links in this folder</button>
      <button type="button" class="menu-item" data-v="autotag">${icon('sparkles')}Auto-tag untagged bookmarks here</button>
      <button type="button" class="menu-item" data-v="savetext">${icon('text')}Save page text for all bookmarks here</button>
      ${prot ? '' : `<button type="button" class="menu-item danger" data-v="delete">${icon('trash')}Delete folder</button>`}
    </div>`,
    actions: [{ label: 'Close', value: null }],
    onOpen: d => d.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { choice = b.dataset.v; d.querySelector('[data-close]').click(); }))
  });
  const links = () => (S.nodes.get(id).children || []).filter(k => k.url).map(k => k.id);
  switch (choice) {
    case 'new': newFolder(id); break;
    case 'rename': renameFolder(id); break;
    case 'sort-title': sortFolder(id, 'title'); break;
    case 'sort-date': sortFolder(id, 'date'); break;
    case 'sort-domain': sortFolder(id, 'domain'); break;
    case 'check': checkLinks(links()); break;
    case 'autotag': autoTag(links().filter(x => !tagsOf(x).length)); break;
    case 'savetext': saveTexts(links().filter(x => !metaOf(x).hasText)); break;
    case 'delete': deleteItems([id]); break;
  }
}

// ---------- Live updates ----------
function bindLive() {
  const ev = chrome.bookmarks;
  [ev.onCreated, ev.onRemoved, ev.onChanged, ev.onMoved, ev.onChildrenReordered, ev.onImportEnded].forEach(e => e && e.addListener(() => scheduleReload(false)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => k.startsWith('m:'))) scheduleReload(true);
    if (area === 'sync' && changes.settings) getSettings().then(s => { S.settings = s; });
  });
}

// ---------- Init ----------
async function init() {
  S.layout = pref.get('layout', 'list');
  S.inspectorOpen = pref.get('inspector', true);
  S.expanded = new Set(pref.get('expanded', ['1', '2']));
  await loadAll();
  if (!location.hash) history.replaceState(null, '', '#' + hashFor(defaultView()));
  S.view = viewFromHash();
  if (S.view.type === 'folder') expandTo(S.view.id);
  bindContent();
  bindKeyboard();
  bindTree();
  bindDnd();
  bindInspector();
  bindChrome();
  bindLive();
  window.addEventListener('hashchange', route);
  render();
  document.body.classList.remove('loading');
  // Load saved texts in the background so full-text search is instant later.
  setTimeout(() => loadTexts().then(() => { if (S.query) renderMain(); }), 300);
}

export { render, reload };
init().catch(e => {
  console.warn('Manager failed to start', e);
  $('content').innerHTML = `<div class="empty">${icon('info')}<p>Could not load bookmarks: ${esc(e.message)}</p></div>`;
});
