// Tags overview, import/export, settings and the welcome page.
import { S, hooks, metaOf, inReadLater } from './state.js';
import { toast, plural, promptDialog, confirmDialog, startTask, download, pickFolder, fmtDate } from './ui.js';
import { renameTag, deleteTag, autoTag, reviewSuggestions, markBulk } from './ops.js';
import { findDuplicates, findEmptyFolders } from './health.js';
import { toNetscapeHtml, parseNetscapeHtml, toJsonBackup, parseJsonBackup, countTree } from '../lib/netscape.js';
import { getAllTexts, clearTexts, kvDelete, putTexts } from '../lib/db.js';
import { saveSettings, getSettings, hasSiteAccess, requestSiteAccess, ALL_SITES, updateMetaMany, mergeTags, DEFAULT_SETTINGS } from '../lib/meta.js';
import { rebuildCorpus } from '../lib/corpus.js';
import { otherBookmarksId } from '../lib/readlater.js';
import { normalizeUrl, isHttpUrl } from '../lib/url.js';
import { icon, esc } from '../lib/icons.js';

// ---------- Tags ----------
let tagFilter = '';
export function renderTags(container) {
  const pending = S.bookmarks.filter(n => (metaOf(n.id).suggested || []).length).length;
  const untagged = S.bookmarks.filter(n => !(metaOf(n.id).tags || []).length && !inReadLater(n)).length;
  container.innerHTML = `<div class="page">
    <section class="card row-card">
      <div><h2>${plural(S.vocab.size, 'tag')}</h2><p class="muted small">Tags are stored on this device, keyed by bookmark. ${untagged ? `${plural(untagged, 'bookmark')} have no tags yet.` : ''}</p></div>
      <span class="spacer"></span>
      ${pending ? `<button class="btn" data-t="review">${icon('sparkles')}Review ${pending} suggestion${pending === 1 ? '' : 's'}</button>` : ''}
      ${untagged ? `<button class="btn primary" data-t="autotag" title="Fetch each untagged page and suggest tags">${icon('sparkles')}Auto-tag untagged</button>` : ''}
    </section>
    <div class="tag-toolbar"><input class="input" type="search" placeholder="Filter tags…" aria-label="Filter tags" value="${esc(tagFilter)}" data-t="filter"></div>
    <div class="card list-card tag-table" id="tagTable"></div>
  </div>`;
  const table = container.querySelector('#tagTable');
  const draw = () => {
    const rows = [...S.vocab].filter(([t]) => !tagFilter || t.includes(tagFilter));
    table.innerHTML = rows.length ? rows.map(([t, n]) => `<div class="tag-row" data-tag="${esc(t)}">
        <a class="chip" href="#tag/${encodeURIComponent(t)}">${esc(t)}</a><span class="muted small">${plural(n, 'bookmark')}</span><span class="spacer"></span>
        <button class="btn ghost sm" data-t="rename">${icon('edit')}Rename</button>
        <button class="btn ghost sm" data-t="merge">${icon('merge')}Merge into…</button>
        <button class="btn ghost icon sm" data-t="delete" aria-label="Delete tag ${esc(t)}" title="Remove this tag from all bookmarks">${icon('trash')}</button>
      </div>`).join('') : `<div class="empty small-empty">${icon('tag')}<p>${S.vocab.size ? 'No tags match.' : 'No tags yet. Select bookmarks and press T, or use Auto-tag.'}</p></div>`;
  };
  draw();
  container.querySelector('[data-t="filter"]').addEventListener('input', e => { tagFilter = e.target.value.trim().toLowerCase(); draw(); });
  container.onclick = async e => {
    const b = e.target.closest('[data-t]');
    if (!b || b.tagName === 'INPUT') return;
    const tag = b.closest('[data-tag]') && b.closest('[data-tag]').dataset.tag;
    switch (b.dataset.t) {
      case 'review': reviewSuggestions(S.bookmarks.map(n => n.id)); break;
      case 'autotag': {
        const ids = S.bookmarks.filter(n => !(metaOf(n.id).tags || []).length && !inReadLater(n) && isHttpUrl(n.url)).map(n => n.id);
        if (ids.length > 50 && !await confirmDialog('Auto-tag', `Fetch ${ids.length.toLocaleString()} pages to suggest tags? This may take a while; you can cancel at any time and review suggestions afterwards.`, 'Start')) return;
        autoTag(ids);
        break;
      }
      case 'rename': {
        const to = await promptDialog('Rename tag', 'New name', tag, 'Rename');
        if (to && to !== tag) { const n = await renameTag(tag, to); toast(`Renamed on ${plural(n, 'bookmark')}`); }
        break;
      }
      case 'merge': {
        const to = await promptDialog(`Merge “${tag}” into`, 'Target tag', '', 'Merge');
        if (to && to !== tag) { const n = await renameTag(tag, to); toast(`Merged into “${to}” on ${plural(n, 'bookmark')}`); }
        break;
      }
      case 'delete': {
        if (!await confirmDialog('Remove tag', `Remove “${esc(tag)}” from ${plural(S.vocab.get(tag) || 0, 'bookmark')}? Bookmarks themselves are kept.`, 'Remove', true)) return;
        const n = await deleteTag(tag);
        toast(`Removed from ${plural(n, 'bookmark')}`);
        break;
      }
    }
  };
}

// ---------- Import / export ----------
function stamp() { return new Date().toISOString().slice(0, 10); }

async function exportHtml() {
  const html = toNetscapeHtml(S.root.children || [], id => S.meta.get(id));
  download(`bookmarks-${stamp()}.html`, html, 'text/html');
  toast(`Exported ${plural(S.bookmarks.length, 'bookmark')} as HTML`);
}

async function exportJson(includeText) {
  let texts = new Map();
  if (includeText) { try { texts = new Map((await getAllTexts()).map(t => [t.id, t.text])); } catch { /* ignore */ } }
  const data = toJsonBackup(S.root.children || [], id => S.meta.get(id), id => texts.get(id) || null, S.rl);
  download(`smart-bookmarks-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast(`Exported ${plural(S.bookmarks.length, 'bookmark')} as JSON`);
}

let importState = null;

async function readImportFile(file) {
  const text = await file.text();
  const isJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text);
  const tree = isJson ? parseJsonBackup(text) : parseNetscapeHtml(text);
  const c = countTree(tree);
  if (!c.links && !c.folders) throw new Error('No bookmarks found in this file.');
  return { tree, counts: c, name: file.name, kind: isJson ? 'JSON' : 'HTML' };
}

async function runImport({ skipExisting, destination }) {
  const { tree } = importState;
  const existing = new Set(S.bookmarks.map(n => n.norm));
  let parentId = destination;
  if (!parentId) {
    const f = await chrome.bookmarks.create({ parentId: await otherBookmarksId(), title: `Imported ${new Date().toLocaleDateString()}` });
    parentId = f.id;
  }
  const total = importState.counts.links + importState.counts.folders;
  const task = startTask('Importing bookmarks', { total });
  let done = 0, added = 0, skipped = 0, failed = 0;
  const metaWrites = [];
  const textRecs = [];
  await markBulk(true);
  const walk = async (nodes, pid) => {
    for (const n of nodes) {
      if (task.cancelled) return;
      if (n.url) {
        done++;
        if (skipExisting && existing.has(normalizeUrl(n.url))) { skipped++; continue; }
        try {
          const created = await chrome.bookmarks.create({ parentId: pid, title: n.title || n.url, url: n.url });
          existing.add(normalizeUrl(n.url));
          added++;
          const m = {};
          if (n.tags && n.tags.length) m.tags = mergeTags(n.tags);
          if (n.note) m.note = n.note;
          if (n.readLater) Object.assign(m, { rl: true, read: !!n.readLater.read, minutes: n.readLater.minutes || undefined, words: n.readLater.words || undefined, rlAddedAt: n.dateAdded || Date.now() });
          if (n.text) { textRecs.push({ id: created.id, text: String(n.text).slice(0, 60000), words: (n.readLater && n.readLater.words) || 0, savedAt: Date.now() }); m.hasText = true; m.textAt = Date.now(); }
          if (Object.keys(m).length) metaWrites.push([created.id, m]);
        } catch { failed++; }
      } else {
        done++;
        let target;
        if (n.role === 'read-later' && S.rl) target = S.rl.rootId;
        else if (n.role === 'read-later-archive' && S.rl) target = S.rl.archiveId;
        else {
          try { target = (await chrome.bookmarks.create({ parentId: pid, title: n.title || 'Folder' })).id; } catch { failed++; continue; }
        }
        await walk(n.children || [], target);
      }
      if (done % 10 === 0) task.update(done);
      if (metaWrites.length >= 200) await updateMetaMany(metaWrites.splice(0));
      if (textRecs.length >= 50) await putTexts(textRecs.splice(0));
    }
  };
  try {
    await walk(tree.children || [], parentId);
    await updateMetaMany(metaWrites);
    await putTexts(textRecs);
  } finally {
    await markBulk(false);
  }
  const cancelled = task.cancelled;
  task.finish();
  importState = null;
  toast(`${cancelled ? 'Import cancelled. ' : ''}Imported ${plural(added, 'bookmark')}${skipped ? ` · ${skipped} already in library` : ''}${failed ? ` · ${failed} failed` : ''}`, { timeout: 9000 });
  await hooks.reload();
  location.hash = '#folder/' + parentId;
}

export function renderBackup(container) {
  container.innerHTML = `<div class="page narrow">
    <section class="card">
      <h2>${icon('download')}Export a backup</h2>
      <p class="muted small">Keep a copy of your ${plural(S.bookmarks.length, 'bookmark')} and ${plural(S.folders.length, 'folder')}. Files are created on this device; nothing is uploaded.</p>
      <div class="export-grid">
        <div class="export-opt">
          <b>HTML (Netscape format)</b>
          <span class="muted small">Opens in every browser and bookmark service. Tags are stored in the TAGS attribute and notes as descriptions.</span>
          <button class="btn" data-b="html">${icon('download')}Export HTML</button>
        </div>
        <div class="export-opt">
          <b>JSON (full backup)</b>
          <span class="muted small">Includes tags, notes and Read later state, for restoring into Smart Bookmarks.</span>
          <label class="check small"><input type="checkbox" data-b="withtext"> Include saved page text</label>
          <button class="btn" data-b="json">${icon('download')}Export JSON</button>
        </div>
      </div>
    </section>
    <section class="card" id="importCard">
      <h2>${icon('upload')}Import bookmarks</h2>
      <p class="muted small">Import an HTML bookmark file from any browser or service (Chrome, Firefox, Safari, Pocket, Raindrop, Pinboard), or a Smart Bookmarks JSON backup.</p>
      <label class="dropzone" id="dropzone">
        <input type="file" accept=".html,.htm,.json,text/html,application/json" data-b="file" class="sr-only">
        ${icon('upload')}<span><b>Choose a file</b> or drop it here</span>
      </label>
      <div id="importPreview"></div>
    </section>
  </div>`;
  const preview = container.querySelector('#importPreview');
  const drawPreview = () => {
    if (!importState) { preview.innerHTML = ''; return; }
    const dest = importState.destination ? S.nodes.get(importState.destination) : null;
    preview.innerHTML = `<div class="import-preview">
      <div class="import-file">${icon('text')}<div><b>${esc(importState.name)}</b><div class="muted small">${importState.kind} · ${plural(importState.counts.links, 'bookmark')} in ${plural(importState.counts.folders, 'folder')}</div></div></div>
      <label class="check"><input type="checkbox" data-b="skip" checked> Skip links that are already in my bookmarks</label>
      <div class="dest-row"><span class="muted small">Import into:</span><b>${dest ? esc(dest.title) : `New folder “Imported ${new Date().toLocaleDateString()}”`}</b><button class="btn ghost sm" data-b="dest">Change…</button></div>
      <div class="row-end"><button class="btn ghost" data-b="cancel">Cancel</button><button class="btn primary" data-b="import">${icon('upload')}Import</button></div>
    </div>`;
  };
  const handleFile = async file => {
    if (!file) return;
    try { importState = await readImportFile(file); drawPreview(); }
    catch (e) { importState = null; drawPreview(); toast('Could not read file: ' + e.message, { kind: 'warn', timeout: 8000 }); }
  };
  container.querySelector('[data-b="file"]').addEventListener('change', e => handleFile(e.target.files[0]));
  const dz = container.querySelector('#dropzone');
  dz.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); } });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  container.onclick = async e => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    switch (b.dataset.b) {
      case 'html': exportHtml(); break;
      case 'json': exportJson(container.querySelector('[data-b="withtext"]').checked); break;
      case 'dest': { const d = await pickFolder({ title: 'Import into folder', okLabel: 'Choose' }); if (d) { importState.destination = d; drawPreview(); } break; }
      case 'cancel': importState = null; drawPreview(); container.querySelector('[data-b="file"]').value = ''; break;
      case 'import': {
        b.disabled = true;
        try { await runImport({ skipExisting: container.querySelector('[data-b="skip"]').checked, destination: importState.destination }); }
        catch (err) { toast('Import failed: ' + err.message, { kind: 'warn' }); b.disabled = false; }
        break;
      }
    }
  };
  drawPreview();
}

// ---------- Settings ----------
export async function renderSettings(container) {
  const s = S.settings;
  const access = await hasSiteAccess();
  let textCount = 0, textBytes = 0;
  try { const all = await getAllTexts(); textCount = all.length; textBytes = all.reduce((a, t) => a + t.text.length * 2, 0); } catch { /* ignore */ }
  let usage = '';
  try { if (navigator.storage && navigator.storage.estimate) { const est = await navigator.storage.estimate(); usage = `${(est.usage / 1048576).toFixed(1)} MB used by page text and reports`; } } catch { /* ignore */ }
  if (S.view.type !== 'settings') return;
  const toggle = (key, label, hint, needsAccess) => `<label class="setting">
    <span class="set-text"><b>${label}</b><span class="muted small">${hint}${needsAccess && !access ? ' <span class="pill warn">needs website access</span>' : ''}</span></span>
    <input type="checkbox" class="switch" data-s="${key}" ${s[key] ? 'checked' : ''} ${needsAccess ? 'data-access="1"' : ''}></label>`;
  const num = (key, label, hint, min, max, step = 1) => `<label class="setting">
    <span class="set-text"><b>${label}</b><span class="muted small">${hint}</span></span>
    <input type="number" class="input num" data-s="${key}" value="${s[key]}" min="${min}" max="${max}" step="${step}"></label>`;
  container.innerHTML = `<div class="page narrow">
    <section class="card">
      <h2>${icon('globe')}Website access</h2>
      <div class="setting"><span class="set-text"><b>${access ? 'Granted' : 'Not granted'}</b>
        <span class="muted small">Needed to fetch pages for link checks, auto-tagging and saving page text of existing bookmarks. Saving the current tab from the toolbar button works without it.</span></span>
        ${access ? `<button class="btn" data-a="revoke">Revoke</button>` : `<button class="btn primary" data-a="grant">Grant access</button>`}</div>
    </section>
    <section class="card">
      <h2>${icon('bookmark')}Saving</h2>
      ${toggle('saveTextOnSave', 'Save page text when saving from the toolbar', 'Makes the page searchable by its content. Default for the checkbox in the popup.')}
      ${toggle('suggestOnCreate', 'Suggest tags for new bookmarks', 'When you bookmark a page anywhere in the browser, fetch it and queue tag suggestions for review.', true)}
      ${toggle('saveTextOnCreate', 'Save page text for new bookmarks', 'Fetch and store the text of every new bookmark for full-text search.', true)}
    </section>
    <section class="card">
      <h2>${icon('clock')}Read later</h2>
      ${toggle('showBadge', 'Show unread count on the toolbar icon', 'The badge shows how many Read later items are unread.')}
      ${toggle('openReadLaterMarksRead', 'Mark as read when opened', 'Opening an item from the reading list marks it read.')}
      ${num('wpm', 'Reading speed', 'Words per minute, used for reading time estimates.', 100, 600, 10)}
    </section>
    <section class="card">
      <h2>${icon('pulse')}Health check</h2>
      ${num('healthConcurrency', 'Parallel requests', 'How many links are checked at once (1–12).', 1, 12)}
      ${num('healthTimeout', 'Timeout (seconds)', 'How long to wait for a site before marking it as timed out.', 5, 60)}
      ${num('healthHostDelay', 'Delay per website (ms)', 'Minimum time between two requests to the same site.', 0, 10000, 100)}
    </section>
    <section class="card">
      <h2>${icon('text')}Data</h2>
      <div class="setting"><span class="set-text"><b>Saved page text</b><span class="muted small">${plural(textCount, 'page')} · ${(textBytes / 1048576).toFixed(1)} MB${usage ? ' · ' + usage : ''}</span></span>
        <button class="btn danger" data-a="clear-text" ${textCount ? '' : 'disabled'}>Delete all</button></div>
      <div class="setting"><span class="set-text"><b>Tag suggestion index</b><span class="muted small">Word statistics across your library used to rank suggested tags. Rebuilt automatically.</span></span>
        <button class="btn" data-a="rebuild">Rebuild now</button></div>
      <div class="setting"><span class="set-text"><b>Health report</b><span class="muted small">${S.health && S.health.finishedAt ? `Last check ${fmtDate(S.health.finishedAt)}` : 'No report yet'}</span></span>
        <button class="btn" data-a="clear-health" ${S.health ? '' : 'disabled'}>Clear report</button></div>
      <div class="setting"><span class="set-text"><b>Reset settings</b><span class="muted small">Restore default settings. Bookmarks and tags are not affected.</span></span>
        <button class="btn" data-a="reset">Reset</button></div>
    </section>
    <section class="card">
      <h2>${icon('info')}Keyboard shortcuts</h2>
      <table class="help-table">
        <tr><td><kbd>/</kbd></td><td>Search</td></tr>
        <tr><td><kbd>↑</kbd> <kbd>↓</kbd> or <kbd>J</kbd> <kbd>K</kbd></td><td>Move between items (hold <kbd>Shift</kbd> to extend selection)</td></tr>
        <tr><td><kbd>Space</kbd></td><td>Toggle selection</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>A</kbd></td><td>Select all</td></tr>
        <tr><td><kbd>Enter</kbd></td><td>Open bookmark or folder (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> in background)</td></tr>
        <tr><td><kbd>M</kbd> / <kbd>T</kbd></td><td>Move / tag selection</td></tr>
        <tr><td><kbd>Del</kbd></td><td>Delete selection (undo available)</td></tr>
        <tr><td><kbd>E</kbd> or <kbd>F2</kbd></td><td>Edit title in the details panel</td></tr>
        <tr><td><kbd>R</kbd></td><td>Toggle read (Read later)</td></tr>
        <tr><td><kbd>N</kbd></td><td>New folder</td></tr>
        <tr><td><kbd>G</kbd> / <kbd>I</kbd></td><td>Toggle grid / details panel</td></tr>
        <tr><td><kbd>Alt</kbd>+<kbd>↑</kbd></td><td>Go to parent folder</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Clear selection or search</td></tr>
      </table>
      <p class="muted small">Browser-wide shortcuts (open popup, save for later, open manager) can be set at <a href="#" data-a="shortcuts">chrome://extensions/shortcuts</a>.</p>
    </section>
  </div>`;
  container.onchange = async e => {
    const el = e.target.closest('[data-s]');
    if (!el) return;
    const key = el.dataset.s;
    let v;
    if (el.type === 'checkbox') {
      v = el.checked;
      if (v && el.dataset.access) {
        const ok = await requestSiteAccess();
        if (!ok) { el.checked = false; toast('Website access was not granted.', { kind: 'warn' }); return; }
      }
    } else {
      v = Math.max(+el.min, Math.min(+el.max, Math.round(+el.value || DEFAULT_SETTINGS[key])));
      el.value = v;
    }
    S.settings = await saveSettings({ [key]: v });
    toast('Settings saved', { timeout: 1500 });
    if (el.dataset.access) renderSettings(container);
  };
  container.onclick = async e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    switch (b.dataset.a) {
      case 'grant': if (await requestSiteAccess()) toast('Website access granted'); renderSettings(container); break;
      case 'revoke':
        await chrome.permissions.remove(ALL_SITES);
        S.settings = await saveSettings({ suggestOnCreate: false, saveTextOnCreate: false });
        toast('Website access revoked');
        renderSettings(container);
        break;
      case 'clear-text':
        if (!await confirmDialog('Delete saved page text', 'Full-text search will only cover titles, URLs, tags and notes until text is saved again.', 'Delete', true)) return;
        await clearTexts();
        await updateMetaMany(S.bookmarks.filter(n => metaOf(n.id).hasText).map(n => [n.id, m => ({ ...m, hasText: undefined, textAt: undefined })]));
        S.texts = new Map();
        toast('Saved page text deleted');
        await hooks.reload({ metaOnly: true });
        break;
      case 'rebuild': { b.disabled = true; const c = await rebuildCorpus({ includeTexts: true }); toast(`Index rebuilt from ${plural(c.N, 'bookmark')}`); b.disabled = false; break; }
      case 'clear-health': await kvDelete('health'); S.health = null; toast('Health report cleared'); hooks.render(); break;
      case 'reset': await chrome.storage.sync.remove('settings'); S.settings = await getSettings(); toast('Settings reset'); renderSettings(container); break;
      case 'shortcuts': e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); break;
    }
  };
}

// ---------- Welcome / overview ----------
export function renderWelcome(container) {
  const dups = findDuplicates().reduce((a, g) => a + g.length - 1, 0);
  const empties = findEmptyFolders().length;
  const untagged = S.bookmarks.filter(n => !(metaOf(n.id).tags || []).length && !inReadLater(n)).length;
  const card = (href, ic, title, text) => `<a class="card welcome-card" href="${href}">${icon(ic)}<b>${title}</b><span class="muted small">${text}</span></a>`;
  container.innerHTML = `<div class="page narrow">
    <section class="hero">
      <img src="../icons/icon128.png" alt="" width="64" height="64">
      <div><h2>Welcome to Smart Bookmarks</h2>
      <p class="muted">You have ${plural(S.bookmarks.length, 'bookmark')} in ${plural(S.folders.length, 'folder')}. Here is where to start.</p></div>
    </section>
    <div class="welcome-grid">
      ${card('#health', 'pulse', 'Check for dead links', 'Find broken and moved links, with one-click cleanup.')}
      ${card('#health/duplicates', 'copy', `${dups ? plural(dups, 'duplicate') : 'No duplicates'}`, 'Duplicates are detected even with tracking parameters or “www.” differences.')}
      ${card('#health/empty', 'folder', `${empties ? plural(empties, 'empty folder') : 'No empty folders'}`, 'Remove folders that contain nothing.')}
      ${card('#untagged', 'sparkles', `${plural(untagged, 'untagged bookmark')}`, 'Select bookmarks and use Auto-tag to get tag suggestions from each page.')}
      ${card('#readlater', 'clock', 'Read later', 'Save pages from the toolbar button, right-click menu or a keyboard shortcut.')}
      ${card('#backup', 'download', 'Back up your bookmarks', 'Export to HTML or JSON, or import from another browser.')}
    </div>
    <p class="muted small center">Tip: press <kbd>/</kbd> to search titles, URLs, tags and saved page text. Try <code>tag:</code>, <code>site:</code> or <code>is:unread</code>.</p>
  </div>`;
}
