import { icon, esc } from '../lib/icons.js';
import { createTagInput } from '../lib/tag-input.js';
import { getSettings, getMetaMany, setMeta, mergeTags } from '../lib/meta.js';
import { saveForLater, findInReadLater, unreadItems, setRead, archive, peekReadLaterFolders } from '../lib/readlater.js';
import { extractPageInTab, countWords, readingMinutes } from '../lib/extract.js';
import { suggestForPage, getTagVocab } from '../lib/corpus.js';
import { putText } from '../lib/db.js';
import { isHttpUrl, prettyUrl, faviconUrl, hostOf } from '../lib/url.js';

const $ = id => document.getElementById(id);
let tab = null;
let page = { url: '', title: '', text: '' };
let settings;
let vocab = new Map();
let existing = [];        // existing bookmarks for this URL (outside Read Later)
let rlNode = null;        // existing Read Later entry
let tagInput;

$('openManager').innerHTML = icon('external');
$('saveLater').innerHTML = `${icon('clock')}<span>Save for later</span>`;

function setStatus(html, kind = '') {
  const s = $('status');
  s.className = 'status ' + kind;
  const lines = [].concat(html).filter(Boolean);
  s.innerHTML = lines.map(l => `<div class="status-line">${l}</div>`).join('');
  s.hidden = !lines.length;
}

async function folderPaths() {
  const [root] = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (n, path, depth) => {
    for (const c of n.children || []) {
      if (c.url) continue;
      const p = path ? `${path} / ${c.title}` : c.title;
      out.push({ id: c.id, title: c.title, path: p, depth });
      walk(c, p, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

async function pathOf(id) {
  const parts = [];
  let cur = id;
  while (cur && cur !== '0') {
    try { const [n] = await chrome.bookmarks.get(cur); if (n.parentId && n.parentId !== '0') parts.unshift(n.title); cur = n.parentId; } catch { break; }
  }
  return parts.join(' / ');
}

async function loadFolders() {
  const folders = await folderPaths();
  const { lastFolder } = await chrome.storage.local.get('lastFolder');
  const sel = $('folder');
  sel.innerHTML = folders.map(f => `<option value="${f.id}">${' '.repeat(f.depth)}${esc(f.title || '(untitled)')}</option>`).join('');
  sel.value = folders.some(f => f.id === lastFolder) ? lastFolder : (folders[0] && folders[0].id) || '';
}

function renderSuggestions(list) {
  const box = $('suggest');
  const fresh = list.filter(t => !tagInput.has(t));
  if (!fresh.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<span class="lbl">Suggested:</span>` + fresh.map(t => `<button type="button" class="chip suggest" data-tag="${esc(t)}" title="Add tag">+ ${esc(t)}</button>`).join('')
    + (fresh.length > 1 ? `<button type="button" class="btn ghost sm" id="addAllSugg">Add all</button>` : '');
  box.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => { tagInput.add(b.dataset.tag); b.remove(); if (!box.querySelector('[data-tag]')) box.innerHTML = ''; }));
  const all = $('addAllSugg');
  if (all) all.addEventListener('click', () => { fresh.forEach(t => tagInput.add(t)); box.innerHTML = ''; });
}

async function analyze() {
  $('suggest').innerHTML = '<span class="spinner"></span><span>Analyzing page…</span>';
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageInTab });
    if (res && res.result) page = { ...page, ...res.result, url: tab.url, title: page.title };
  } catch {
    // Some pages (web store, PDF viewer, error pages) cannot be scripted.
  }
  const words = countWords(page.text);
  page.words = words;
  const mins = readingMinutes(words, settings.wpm);
  $('readTime').textContent = mins ? `${mins} min read` : '';
  if (!page.text && !page.description) { $('suggest').innerHTML = '<span class="faint">No suggestions for this page.</span>'; return; }
  try {
    const sugg = await suggestForPage(page, 8);
    renderSuggestions(sugg);
  } catch (e) {
    $('suggest').innerHTML = '';
    console.warn('Suggestions failed', e);
  }
}

async function detectExisting() {
  const all = await chrome.bookmarks.search({ url: tab.url }).catch(() => []);
  rlNode = await findInReadLater(tab.url);
  const rl = await peekReadLaterFolders();
  const rlIds = rl ? [rl.rootId, rl.archiveId] : [];
  existing = all.filter(b => !rlIds.includes(b.parentId));
  const ids = [...existing.map(b => b.id), ...(rlNode ? [rlNode.id] : [])];
  const metas = await getMetaMany(ids);
  const tags = mergeTags(...[...metas.values()].map(m => m.tags));
  if (tags.length) tagInput.set(tags);
  const notes = [];
  if (existing.length) {
    const p = await pathOf(existing[0].parentId);
    notes.push(`${icon('bookmark')}<span>Bookmarked in <b>${esc(p || 'root')}</b>${existing.length > 1 ? ` and ${existing.length - 1} more` : ''}</span>`);
    $('bookmarkBtn').textContent = 'Update tags';
    $('folder').value = existing[0].parentId;
  }
  if (rlNode) {
    const m = metas.get(rlNode.id) || {};
    const archived = rl && rlNode.parentId === rl.archiveId;
    notes.push(`${icon('clock')}<span>In Read Later${archived ? ' (archived)' : m.read ? ' (read)' : ''}</span>`);
    $('saveLater').innerHTML = `${icon('clock')}<span>${archived || m.read ? 'Move back to unread' : 'Update Read Later'}</span>`;
  }
  if (notes.length) setStatus(notes, 'ok');
}

async function renderReadLater() {
  const items = await unreadItems();
  items.sort((a, b) => (b.meta.rlAddedAt || b.dateAdded) - (a.meta.rlAddedAt || a.dateAdded));
  const n = items.length;
  $('unreadCount').hidden = !n;
  $('unreadCount').textContent = `${n} unread`;
  $('rlEmpty').hidden = !!n;
  const list = $('rlList');
  list.innerHTML = items.slice(0, 7).map(it => `
    <li class="rl-item" data-id="${it.id}">
      <img class="fav" src="${esc(faviconUrl(it.url, 32))}" alt="">
      <button class="body" data-act="open" title="${esc(it.url)}">
        <div class="t">${esc(it.title || it.url)}</div>
        <div class="m">${esc(hostOf(it.url))}${it.meta.minutes ? ` · ${it.meta.minutes} min` : ''}${(it.meta.tags || []).length ? ' · ' + esc(it.meta.tags.slice(0, 3).map(t => '#' + t).join(' ')) : ''}</div>
      </button>
      <span class="acts">
        <button class="btn ghost icon sm" data-act="read" title="Mark as read" aria-label="Mark as read">${icon('check')}</button>
        <button class="btn ghost icon sm" data-act="archive" title="Archive" aria-label="Archive">${icon('archive')}</button>
      </span>
    </li>`).join('');
  if (n > 7) list.insertAdjacentHTML('beforeend', `<li class="rl-empty">+ ${n - 7} more</li>`);
}

$('rlList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('[data-id]');
  const id = li.dataset.id;
  const act = btn.dataset.act;
  if (act === 'open') {
    const [n] = await chrome.bookmarks.get(id);
    if (settings.openReadLaterMarksRead) await setRead(id, true);
    await chrome.tabs.create({ url: n.url });
    window.close();
  } else if (act === 'read') { await setRead(id, true); renderReadLater(); }
  else if (act === 'archive') { await archive(id, true); renderReadLater(); }
});

async function doSaveLater() {
  if (!isHttpUrl(page.url)) return;
  const btn = $('saveLater');
  btn.disabled = true;
  try {
    const title = $('pageTitle').value.trim() || page.title || page.url;
    const { existed } = await saveForLater({ ...page, title, tags: tagInput.value, saveText: $('saveText').checked });
    btn.innerHTML = `${icon('check')}<span>${existed ? 'Updated in Read Later' : 'Saved for later'}</span>`;
    setStatus(`${icon('check')}<span>${existed ? 'Read Later entry updated.' : 'Saved to Read Later.'}</span>`, 'ok');
    await renderReadLater();
    chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
    setTimeout(() => window.close(), 900);
  } catch (e) {
    setStatus(`${icon('info')}<span>Could not save: ${esc(e.message)}</span>`, 'warn');
    btn.disabled = false;
  }
}

async function doBookmark() {
  if (!isHttpUrl(page.url)) return;
  const btn = $('bookmarkBtn');
  btn.disabled = true;
  try {
    const tags = tagInput.value;
    const title = $('pageTitle').value.trim() || page.title || page.url;
    const parentId = $('folder').value;
    await chrome.storage.local.set({ lastFolder: parentId });
    let targets = existing;
    if (!existing.length) {
      const node = await chrome.bookmarks.create({ parentId, title, url: page.url });
      targets = [node];
    } else {
      for (const b of existing) if (b.title !== title) await chrome.bookmarks.update(b.id, { title });
      if (existing.length === 1 && existing[0].parentId !== parentId) await chrome.bookmarks.move(existing[0].id, { parentId });
    }
    for (const b of targets) {
      const patch = { tags };
      if ($('saveText').checked && page.text) {
        await putText(b.id, page.text, page.words);
        Object.assign(patch, { hasText: true, textAt: Date.now(), words: page.words, minutes: readingMinutes(page.words, settings.wpm) });
      }
      await setMeta(b.id, patch);
    }
    btn.textContent = existing.length ? 'Updated' : 'Bookmarked';
    setStatus(`${icon('check')}<span>${existing.length ? 'Bookmark updated.' : 'Bookmark added.'}</span>`, 'ok');
    setTimeout(() => window.close(), 900);
  } catch (e) {
    setStatus(`${icon('info')}<span>Could not bookmark: ${esc(e.message)}</span>`, 'warn');
    btn.disabled = false;
  }
}

$('saveLater').addEventListener('click', doSaveLater);
$('bookmarkBtn').addEventListener('click', doBookmark);
$('openManager').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'openManager' }).catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') })); window.close(); });
$('viewAll').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'openManager', hash: 'readlater' }).catch(() => {}); window.close(); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSaveLater(); }
});

async function init() {
  settings = await getSettings();
  $('saveText').checked = !!settings.saveTextOnSave;
  vocab = await getTagVocab().catch(() => new Map());
  tagInput = createTagInput({ vocab: () => vocab, placeholder: 'Add tags, press Enter' });
  $('tagsMount').append(tagInput.el);

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  renderReadLater();
  loadFolders().then(() => tab && isHttpUrl(tab.url) && detectExisting());

  if (!tab || !isHttpUrl(tab.url)) {
    $('pageTitle').value = tab && tab.title ? tab.title : 'This page';
    $('pageUrl').textContent = 'Only web pages (http and https) can be saved.';
    $('pageFav').src = '../icons/icon32.png';
    $('pageCard').querySelectorAll('button, input, select').forEach(el => { el.disabled = true; });
    $('suggest').innerHTML = '';
    return;
  }
  page = { url: tab.url, title: tab.title || tab.url, text: '' };
  $('pageTitle').value = page.title;
  $('pageUrl').textContent = prettyUrl(tab.url);
  $('pageUrl').title = tab.url;
  $('pageFav').src = tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? tab.favIconUrl : faviconUrl(tab.url, 32);
  analyze();
  tagInput.focus();
}

init().catch(e => { console.warn(e); setStatus(esc(e.message), 'warn'); });
