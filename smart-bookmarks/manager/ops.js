// Bookmark operations shared by the manager views: delete with undo, move, tagging,
// auto-tag and page-text capture.
import { S, hooks, metaOf, isProtected, isAncestor, rebuildVocab } from './state.js';
import { toast, startTask, runPool, plural, dialog, confirmDialog } from './ui.js';
import { updateMetaMany, getMetaMany, replaceMeta, mergeTags, requestSiteAccess, normalizeTag } from '../lib/meta.js';
import { getText, putText, putTexts, deleteTexts } from '../lib/db.js';
import { fetchAndExtract, countWords, readingMinutes } from '../lib/extract.js';
import { suggestTags } from '../lib/tagger.js';
import { rebuildCorpus } from '../lib/corpus.js';
import { kvGet } from '../lib/db.js';
import { isHttpUrl, hostOf } from '../lib/url.js';
import { icon, esc } from '../lib/icons.js';

export async function markBulk(on) {
  try {
    if (on) await chrome.storage.session.set({ bulkOp: Date.now() });
    else await chrome.storage.session.remove('bulkOp');
  } catch { /* session storage unavailable */ }
}

// ---------- Delete with undo ----------
async function snapshot(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const [sub] = await chrome.bookmarks.getSubTree(id);
      out.push(sub);
    } catch { /* already gone */ }
  }
  const all = [];
  const walk = n => { all.push(n.id); (n.children || []).forEach(walk); };
  out.forEach(walk);
  const metas = await getMetaMany(all);
  const texts = new Map();
  for (const id of all) {
    if (metas.get(id) && metas.get(id).hasText) {
      try { const t = await getText(id); if (t) texts.set(id, t); } catch { /* ignore */ }
    }
  }
  return { trees: out, metas, texts };
}

async function restore(snap) {
  await markBulk(true);
  let count = 0;
  const textRecs = [];
  const metaWrites = [];
  const create = async (n, parentId) => {
    const created = await chrome.bookmarks.create({ parentId, index: n.index, title: n.title, ...(n.url ? { url: n.url } : {}) });
    count++;
    const m = snap.metas.get(n.id);
    if (m && Object.keys(m).length) metaWrites.push([created.id, m]);
    const t = snap.texts.get(n.id);
    if (t) textRecs.push({ ...t, id: created.id });
    for (const c of n.children || []) await create(c, created.id);
  };
  const sorted = [...snap.trees].sort((a, b) => a.index - b.index);
  for (const t of sorted) {
    try { await create(t, t.parentId); } catch {
      // Original parent was deleted too: restore at Other bookmarks.
      await create({ ...t, index: undefined }, S.rl ? S.nodes.get(S.rl.rootId).parentId : '2');
    }
  }
  for (const [id, m] of metaWrites) await replaceMeta(id, m);
  await putTexts(textRecs);
  await markBulk(false);
  return count;
}

export async function deleteItems(ids, { confirmAbove = 0, label } = {}) {
  ids = [...new Set(ids)].filter(id => !isProtected(id));
  // Drop items whose ancestor is also being deleted.
  ids = ids.filter(id => !ids.some(o => o !== id && isAncestor(o, id)));
  if (!ids.length) return false;
  const nodes = ids.map(id => S.nodes.get(id)).filter(Boolean);
  const folderCount = nodes.filter(n => !n.url).length;
  const linkCount = nodes.filter(n => n.url).length + nodes.filter(n => !n.url).reduce((a, n) => a + (n.total || 0), 0);
  if (nodes.some(n => !n.url && n.total > 0) || (confirmAbove > 0 && ids.length > confirmAbove)) {
    const ok = await confirmDialog('Delete?', `This will delete ${folderCount ? plural(folderCount, 'folder') + ' and ' : ''}${plural(linkCount, 'bookmark')}. You can undo right after.`, 'Delete', true);
    if (!ok) return false;
  }
  const snap = await snapshot(ids);
  for (const id of ids) {
    try {
      const n = S.nodes.get(id);
      if (n && !n.url) await chrome.bookmarks.removeTree(id); else await chrome.bookmarks.remove(id);
    } catch (e) { console.warn('Delete failed', id, e); }
  }
  for (const id of ids) S.selection.delete(id);
  toast(label || `Deleted ${plural(ids.length, 'item')}`, {
    timeout: 8000,
    action: { label: 'Undo', icon: 'undo', fn: async () => { const n = await restore(snap); await hooks.reload(); toast(`Restored ${plural(n, 'item')}`); } }
  });
  await hooks.reload();
  return true;
}

// ---------- Move ----------
export async function moveItems(ids, parentId, beforeId) {
  const parent = S.nodes.get(parentId);
  if (!parent || parent.url) return 0;
  let moved = 0;
  for (const id of ids) {
    const n = S.nodes.get(id);
    if (!n || isProtected(id) || id === beforeId) continue;
    if (!n.url && isAncestor(id, parentId)) continue; // can't move a folder into itself
    try {
      const dest = { parentId };
      if (beforeId) {
        // Chrome adjusts the index for same-parent moves, so "index of target" always lands before it.
        const [t] = await chrome.bookmarks.get(beforeId);
        if (t.parentId === parentId) dest.index = t.index;
      }
      await chrome.bookmarks.move(id, dest);
      moved++;
    } catch (e) { console.warn('Move failed', id, e); }
  }
  await hooks.reload();
  return moved;
}

// ---------- Tags ----------
export async function setTags(id, tags) {
  await updateMetaMany([[id, m => ({ ...m, tags: mergeTags(tags), suggested: (m.suggested || []).filter(t => !tags.includes(t)) })]]);
  const m = { ...metaOf(id), tags: mergeTags(tags) };
  S.meta.set(id, m);
  rebuildVocab();
}

export async function addRemoveTags(ids, add = [], remove = []) {
  add = mergeTags(add);
  remove = remove.map(normalizeTag);
  await updateMetaMany(ids.map(id => [id, m => {
    const tags = mergeTags((m.tags || []).filter(t => !remove.includes(t)), add);
    return { ...m, tags, suggested: (m.suggested || []).filter(t => !tags.includes(t)) };
  }]));
  await hooks.reload({ metaOnly: true });
}

export async function renameTag(from, to) {
  to = normalizeTag(to);
  const ids = [...S.meta].filter(([, m]) => (m.tags || []).includes(from)).map(([id]) => id);
  await updateMetaMany(ids.map(id => [id, m => ({ ...m, tags: mergeTags((m.tags || []).map(t => (t === from ? to : t)).filter(Boolean)) })]));
  await hooks.reload({ metaOnly: true });
  return ids.length;
}

export async function deleteTag(tag) {
  const ids = [...S.meta].filter(([, m]) => (m.tags || []).includes(tag)).map(([id]) => id);
  await updateMetaMany(ids.map(id => [id, m => ({ ...m, tags: (m.tags || []).filter(t => t !== tag) })]));
  await hooks.reload({ metaOnly: true });
  return ids.length;
}

// ---------- Fetch-based features ----------
async function ensureAccess() {
  const ok = await requestSiteAccess();
  if (!ok) toast('Website access is needed to fetch pages. Nothing was changed.', { kind: 'warn', timeout: 7000 });
  return ok;
}

// Must be called from a click handler (permission prompt needs a user gesture).
export async function fetchPages(ids, { label, concurrency = 4, onPage }) {
  const targets = ids.map(id => S.nodes.get(id)).filter(n => n && n.url && isHttpUrl(n.url));
  if (!targets.length) { toast('No web links in the selection.'); return null; }
  if (!await ensureAccess()) return null;
  const task = startTask(label, { total: targets.length });
  let failed = 0;
  const perHostBusy = new Map();
  await runPool(targets, async n => {
    // Gentle per-host spacing.
    const h = hostOf(n.url);
    while (perHostBusy.get(h) && Date.now() - perHostBusy.get(h) < 700) await new Promise(r => setTimeout(r, 150));
    perHostBusy.set(h, Date.now());
    try {
      const page = await fetchAndExtract(n.url, { timeout: (S.settings.healthTimeout || 15) * 1000, signal: task.signal });
      page.url = n.url;
      if (!page.title) page.title = n.title;
      await onPage(n, page);
    } catch (e) {
      failed++;
      if (!task.cancelled) console.warn('Fetch failed', n.url, e && e.message);
    }
  }, { concurrency, signal: task.signal, onProgress: d => task.update(d) });
  const cancelled = task.cancelled;
  task.finish();
  return { total: targets.length, failed, cancelled };
}

export async function saveTexts(ids) {
  const records = [];
  const patches = [];
  const res = await fetchPages(ids, {
    label: 'Saving page text',
    onPage: async (n, page) => {
      if (!page.text) throw new Error('empty');
      const words = countWords(page.text);
      records.push({ id: n.id, text: page.text.slice(0, 60000), words, savedAt: Date.now() });
      patches.push([n.id, { hasText: true, textAt: Date.now(), words, minutes: readingMinutes(words, S.settings.wpm) }]);
      if (records.length >= 20) { await putTexts(records.splice(0)); }
    }
  });
  if (!res) return;
  await putTexts(records);
  await updateMetaMany(patches);
  for (const [id] of patches) S.texts.delete(id);
  S.textsLoaded = false;
  await hooks.reload({ metaOnly: true });
  toast(`Saved text for ${plural(patches.length, 'page')}${res.failed ? ` · ${res.failed} failed` : ''}${res.cancelled ? ' · cancelled' : ''}`);
}

export async function removeTexts(ids) {
  await deleteTexts(ids);
  await updateMetaMany(ids.map(id => [id, m => ({ ...m, hasText: undefined, textAt: undefined })]));
  for (const id of ids) S.texts.delete(id);
  await hooks.reload({ metaOnly: true });
}

export async function storeText(id, text) {
  const words = countWords(text);
  await putText(id, text, words);
  await updateMetaMany([[id, { hasText: true, textAt: Date.now(), words, minutes: readingMinutes(words, S.settings.wpm) }]]);
  S.texts.set(id, text.toLowerCase());
}

async function corpusForSuggest() {
  let c = null;
  try { c = await kvGet('corpus'); } catch { /* ignore */ }
  if (!c || Date.now() - c.builtAt > 3600 * 1000) c = await rebuildCorpus({ includeTexts: true });
  return c;
}

// Fetch pages, compute suggestions, then show the review dialog.
export async function autoTag(ids) {
  const corpus = await corpusForSuggest();
  const found = new Map();
  const res = await fetchPages(ids, {
    label: 'Suggesting tags',
    onPage: async (n, page) => {
      const sugg = suggestTags(page, corpus, S.vocab, 8).filter(t => !(metaOf(n.id).tags || []).includes(t));
      found.set(n.id, sugg);
      if (S.settings.saveTextOnSave && page.text && !metaOf(n.id).hasText) await storeText(n.id, page.text);
    }
  });
  if (!res) return;
  if (res.failed) toast(`${plural(res.failed, 'page')} could not be fetched.`, { kind: 'warn' });
  await updateMetaMany([...found].map(([id, s]) => [id, { suggested: s }]));
  await hooks.reload({ metaOnly: true });
  if (found.size) await reviewSuggestions([...found.keys()]);
}

// Suggestions computed locally from title + URL only (no network).
export function quickSuggest(id) {
  const n = S.nodes.get(id);
  return suggestTags({ title: n.title, url: n.url, text: S.texts.get(id) || '' }, { N: S.bookmarks.length, df: {} }, S.vocab, 6);
}

export async function reviewSuggestions(ids) {
  const rows = ids.map(id => S.nodes.get(id)).filter(n => n && (metaOf(n.id).suggested || []).length);
  if (!rows.length) { toast('No pending tag suggestions.'); return; }
  const body = document.createElement('div');
  body.className = 'review';
  body.innerHTML = `<p class="muted small">Click a suggestion to toggle it. Selected suggestions are added when you apply; the rest are dismissed.</p>
    <div class="review-tools"><button type="button" class="btn sm" data-all="1">Select all</button><button type="button" class="btn sm" data-all="0">Select none</button></div>
    <div class="review-list">${rows.map(n => `
      <div class="review-item" data-id="${n.id}">
        <div class="review-title"><img class="fav" src="${esc(chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(n.url) + '&size=32')}" alt=""><span>${esc(n.title || n.url)}</span></div>
        <div class="review-tags">${(metaOf(n.id).tags || []).map(t => `<span class="chip muted">${esc(t)}</span>`).join('')}
          ${(metaOf(n.id).suggested || []).map(t => `<button type="button" class="chip toggle on" data-tag="${esc(t)}" aria-pressed="true">${icon('check')}${esc(t)}</button>`).join('')}</div>
      </div>`).join('')}</div>`;
  body.addEventListener('click', e => {
    const b = e.target.closest('.toggle');
    if (b) { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.querySelector('svg').style.display = on ? '' : 'none'; return; }
    const all = e.target.closest('[data-all]');
    if (all) body.querySelectorAll('.toggle').forEach(t => { const on = all.dataset.all === '1'; t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on)); t.querySelector('svg').style.display = on ? '' : 'none'; });
  });
  const v = await dialog({
    title: `Review tag suggestions (${rows.length})`,
    body,
    wide: true,
    actions: [{ label: 'Later', value: null }, { label: 'Dismiss all', value: 'dismiss' }, { label: 'Apply selected', primary: true, value: 'apply' }]
  });
  if (!v) return;
  const patches = [];
  for (const item of body.querySelectorAll('.review-item')) {
    const id = item.dataset.id;
    const accepted = v === 'apply' ? [...item.querySelectorAll('.toggle.on')].map(b => b.dataset.tag) : [];
    patches.push([id, m => ({ ...m, tags: mergeTags(m.tags, accepted), suggested: undefined })]);
  }
  await updateMetaMany(patches);
  await hooks.reload({ metaOnly: true });
  if (v === 'apply') toast('Tags applied');
}
