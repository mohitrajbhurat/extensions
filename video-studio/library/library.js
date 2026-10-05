// Library: every video with notes, global search, per-video exports, JSON backup.
import * as db from '../lib/db.js';
import { renderMarkdown, escapeHtml, plainText } from '../lib/markdown.js';
import { buildMarkdown, buildHtml, buildChapterList, downloadFile, safeFilename } from '../lib/export.js';
import { icon, $, $$, toast, lightbox, relTime } from '../lib/ui.js';

const VS = globalThis.VS;
let videos = [];
let counts = {};
let selected = null;
let selNotes = [];
let editingId = null;
let query = '';
let allNotesCache = null;

// ---------------------------------------------------------------- loading
async function loadAll() {
  [videos, counts] = await Promise.all([db.listVideos(), db.countNotesByVideo()]);
  allNotesCache = null;
  // Hide empty records (no notes and no bookmarks) left behind by deletes.
  videos = videos.filter((v) => counts[v.id] || (v.bookmarks && v.bookmarks.length));
  renderList();
  if (query && !$('#results').hidden) { await renderResults(); return; }
  if (selected) {
    const still = videos.find((v) => v.id === selected.id);
    if (still) await select(still.id, { keepScroll: true }); else { selected = null; showPane(); }
  } else {
    const m = location.hash.match(/video=([^&]+)/);
    if (m) await select(decodeURIComponent(m[1]));
    else showPane();
  }
}

function sorted() {
  const by = $('#sort').value;
  const list = videos.slice();
  if (by === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (by === 'notes') list.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
  else if (by === 'created') list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}

let matchIds = null; // ids of videos that match the current search
function renderList() {
  const list = sorted().filter((v) => !matchIds || matchIds.has(v.id));
  $('#video-count').textContent = `${list.length} video${list.length === 1 ? '' : 's'}${matchIds ? ' found' : ''}`;
  $('#video-list').innerHTML = list.length ? list.map((v) => `<li role="option" tabindex="0" data-id="${escapeHtml(v.id)}" aria-selected="${selected && selected.id === v.id}">
      ${v.thumb ? `<img src="${v.thumb}" alt="" loading="lazy">` : `<span class="ph">${icon('video')}</span>`}
      <div><div class="vt">${escapeHtml(v.title || v.url || 'Untitled video')}</div>
      <div class="vm">${escapeHtml(v.site || '')}${v.site ? ' · ' : ''}${counts[v.id] || 0} note${counts[v.id] === 1 ? '' : 's'}${v.bookmarks && v.bookmarks.length ? ` · ${v.bookmarks.length} bookmark${v.bookmarks.length === 1 ? '' : 's'}` : ''}</div>
      <div class="vm">${relTime(v.updatedAt)}</div></div></li>`).join('')
    : `<li class="none">${videos.length ? 'No videos match your search.' : 'No videos yet.'}</li>`;
}

function showPane() {
  if (!videos.length) {
    $('#welcome').hidden = false;
    $('#results').hidden = true;
    $('#detail').hidden = true;
    return;
  }
  $('#welcome').hidden = true;
  if (query && !$('#results').hidden) { $('#detail').hidden = true; return; }
  $('#results').hidden = true;
  if (!selected) {
    const first = sorted()[0];
    if (first) { select(first.id); return; }
  }
  $('#detail').hidden = !selected;
}

// ---------------------------------------------------------------- detail
async function select(id, opts = {}) {
  const v = videos.find((x) => x.id === id) || (await db.getVideo(id));
  if (!v) return;
  selected = v;
  selNotes = await db.getNotes(id);
  history.replaceState(null, '', '#video=' + encodeURIComponent(id));
  for (const li of $$('#video-list li[data-id]')) li.setAttribute('aria-selected', String(li.dataset.id === id));
  renderDetail();
  $('#results').hidden = true;
  $('#welcome').hidden = true;
  $('#detail').hidden = false;
  if (!opts.keepScroll) $('#main').scrollTop = 0;
}

function renderDetail() {
  const v = selected;
  $('#d-title').value = v.title || '';
  $('#d-title').placeholder = 'Untitled video';
  const thumb = $('#d-thumb');
  if (v.thumb) { thumb.src = v.thumb; thumb.hidden = false; } else thumb.hidden = true;
  const meta = [];
  if (v.site) meta.push(escapeHtml(v.site));
  if (v.duration) meta.push(VS.formatTime(v.duration));
  meta.push(`added ${new Date(v.createdAt || Date.now()).toLocaleDateString()}`);
  if (v.url) meta.push(`<a href="${escapeHtml(v.url)}" target="_blank" rel="noopener">${escapeHtml(v.url)}</a>`);
  $('#d-meta').innerHTML = meta.join(' · ');
  $('#d-open').href = VS.timeLink(v, 0) || v.url || '#';
  const marks = (v.bookmarks || []).slice().sort((a, b) => a.t - b.t);
  $('#d-chapters-wrap').hidden = !marks.length;
  $('#d-chapters').innerHTML = marks.map((b) => `<li><a class="ts-btn" href="${escapeHtml(VS.timeLink(v, b.t))}" target="_blank" rel="noopener">${VS.formatTime(b.t)}</a><span>${escapeHtml(b.label || 'Bookmark')}</span></li>`).join('');
  $('#d-count').textContent = String(selNotes.length);
  $('#d-empty').hidden = selNotes.length > 0;
  $('#d-notes').innerHTML = selNotes.map((n) => noteHtml(n)).join('');
}

function noteHtml(n) {
  const v = selected;
  const ts = VS.formatTime(n.t);
  if (n.id === editingId) {
    return `<li class="d-note" data-id="${escapeHtml(n.id)}">
      <input class="input" data-f="time" value="${ts}" aria-label="Time" style="font-variant-numeric:tabular-nums">
      <div><textarea class="input" data-f="text" aria-label="Note text">${escapeHtml(n.text)}</textarea>
      <div class="edit-row"><span class="muted" style="margin-right:auto;font-size:12px">Ctrl+Enter to save</span><button class="btn small" data-act="cancel">Cancel</button><button class="btn small primary" data-act="save">Save</button></div></div><span></span></li>`;
  }
  return `<li class="d-note" data-id="${escapeHtml(n.id)}">
    <a class="ts-btn" href="${escapeHtml(VS.timeLink(v, n.t))}" target="_blank" rel="noopener" title="Open the video at ${ts}">${ts}</a>
    <div><div class="md">${renderMarkdown(n.text)}</div>
      ${n.image ? `<img class="shot" src="${n.image}" alt="Frame at ${ts}" data-act="zoom" loading="lazy">` : ''}
      ${!n.image && n.imageError ? '<div class="muted" style="font-size:12px;margin-top:6px">Screenshot was blocked by the site. Open the video and use "Capture tab" in the notes panel.</div>' : ''}
    </div>
    <div class="acts">
      <button class="btn ghost small icon" data-act="edit" title="Edit">${icon('edit')}</button>
      <button class="btn ghost small icon danger" data-act="delete" title="Delete">${icon('trash')}</button>
    </div></li>`;
}

// ---------------------------------------------------------------- search
function terms() {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function highlight(text, ts) {
  let html = escapeHtml(text);
  for (const t of ts) {
    const re = new RegExp(escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

function snippet(text, ts) {
  const plain = plainText(text);
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of ts) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at - 60);
  const s = (start > 0 ? '…' : '') + plain.slice(start, start + 220) + (plain.length > start + 220 ? '…' : '');
  return highlight(s, ts);
}

async function renderResults() {
  const ts = terms();
  if (!ts.length) { matchIds = null; renderList(); showPane(); return; }
  if (!allNotesCache) allNotesCache = await db.allNotes();
  const byId = new Map(videos.map((v) => [v.id, v]));
  const groups = new Map();
  const add = (v, hit) => { if (!groups.has(v.id)) groups.set(v.id, []); groups.get(v.id).push(hit); };
  const matches = (s) => { const l = String(s || '').toLowerCase(); return ts.every((t) => l.includes(t)); };
  for (const v of videos) {
    if (matches(`${v.title} ${v.site} ${v.url}`)) groups.set(v.id, groups.get(v.id) || []);
    for (const b of v.bookmarks || []) if (matches(b.label)) add(v, { kind: 'Bookmark', t: b.t, html: highlight(b.label, ts) });
  }
  for (const n of allNotesCache) {
    const v = byId.get(n.videoId);
    if (v && matches(n.text)) add(v, { kind: 'Note', t: n.t, id: n.id, html: snippet(n.text, ts) });
  }
  matchIds = new Set(groups.keys());
  renderList();
  let total = 0;
  const html = [];
  for (const [id, hits] of groups) {
    const v = byId.get(id);
    total += hits.length;
    hits.sort((a, b) => a.t - b.t);
    html.push(`<div class="r-group"><div class="r-video" data-id="${escapeHtml(id)}">${v.thumb ? `<img src="${v.thumb}" alt="">` : ''}<span>${highlight(v.title || v.url || 'Untitled video', ts)}</span></div>
      ${hits.map((h) => `<div class="r-hit" data-id="${escapeHtml(id)}" ${h.id ? `data-note="${escapeHtml(h.id)}"` : ''}>
        <span class="ts-btn">${VS.formatTime(h.t)}</span><div><div class="kind">${h.kind}</div><div class="snip">${h.html}</div></div></div>`).join('')}</div>`);
  }
  $('#results').innerHTML = `<h2>${total} match${total === 1 ? '' : 'es'} in ${groups.size} video${groups.size === 1 ? '' : 's'} for “${escapeHtml(query)}”</h2>${html.join('') || '<p class="muted">Nothing found. Try fewer words.</p>'}`;
  $('#results').hidden = false;
  $('#detail').hidden = true;
  $('#welcome').hidden = true;
}

// ---------------------------------------------------------------- exports
function fileBase() { return selected.title || 'video-notes'; }

async function exportJson(ids) {
  const data = await db.exportAll(ids);
  const name = ids ? safeFilename(fileBase(), 'json') : `video-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  downloadFile(name, JSON.stringify(data, null, 2), 'application/json');
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch (_) { toast('Copy failed', { error: true }); }
}

async function menuAction(m) {
  $('#d-menu').hidden = true;
  $('#d-more').setAttribute('aria-expanded', 'false');
  if (!selected) return;
  if (m === 'md-images') downloadFile(safeFilename(fileBase(), 'md'), buildMarkdown(selected, selNotes, { embedImages: true }), 'text/markdown');
  if (m === 'json') exportJson([selected.id]);
  if (m === 'copy-md') copyText(buildMarkdown(selected, selNotes), 'Notes copied as Markdown');
  if (m === 'copy-chapters') {
    if (!(selected.bookmarks || []).length) { toast('This video has no bookmarks'); return; }
    copyText(buildChapterList(selected), 'Chapter list copied');
  }
  if (m === 'delete') {
    if (!confirm(`Delete "${selected.title || 'this video'}" with its ${selNotes.length} notes and bookmarks? This cannot be undone.`)) return;
    const id = selected.id;
    selected = null;
    await db.deleteVideo(id);
    history.replaceState(null, '', location.pathname);
    toast('Video deleted');
  }
}

// ---------------------------------------------------------------- events
function bind() {
  $('#search-icon').outerHTML = icon('search');
  $('#btn-import').innerHTML = icon('upload') + 'Import';
  $('#btn-export-all').innerHTML = icon('download') + 'Backup';
  $('#btn-settings').innerHTML = icon('settings');
  $('#d-open').innerHTML = icon('external') + 'Open video';
  $('#d-md').innerHTML = icon('download') + 'Markdown';
  $('#d-html').innerHTML = icon('download') + 'HTML';
  $('#d-print').innerHTML = icon('print') + 'Print or PDF';

  $('#video-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  });
  $('#video-list').addEventListener('keydown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(li.dataset.id); }
    if (e.key === 'ArrowDown' && li.nextElementSibling) { e.preventDefault(); li.nextElementSibling.focus(); }
    if (e.key === 'ArrowUp' && li.previousElementSibling) { e.preventDefault(); li.previousElementSibling.focus(); }
  });
  $('#sort').addEventListener('change', renderList);

  let qTimer = null;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(async () => {
      query = e.target.value.trim();
      if (!query) { matchIds = null; renderList(); $('#results').hidden = true; showPane(); return; }
      await renderResults();
    }, 150);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea')) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && e.target === $('#q') && $('#q').value) { $('#q').value = ''; $('#q').dispatchEvent(new Event('input')); }
  });
  $('#results').addEventListener('click', async (e) => {
    const hit = e.target.closest('[data-id]');
    if (!hit) return;
    const noteId = hit.dataset.note;
    query = '';
    $('#q').value = '';
    matchIds = null;
    renderList();
    $('#results').hidden = true;
    await select(hit.dataset.id, { fromSearch: true });
    if (noteId) {
      const li = $(`#d-notes li[data-id="${CSS.escape(noteId)}"]`);
      if (li) { li.scrollIntoView({ block: 'center' }); li.classList.add('hl'); }
    }
  });

  $('#d-title').addEventListener('change', async (e) => {
    if (!selected) return;
    selected.title = e.target.value.trim();
    await db.saveVideo(selected, { keepTime: true });
    toast('Title saved');
  });
  $('#d-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#d-md').addEventListener('click', () => downloadFile(safeFilename(fileBase(), 'md'), buildMarkdown(selected, selNotes), 'text/markdown'));
  $('#d-html').addEventListener('click', () => downloadFile(safeFilename(fileBase(), 'html'), buildHtml(selected, selNotes), 'text/html'));
  $('#d-print').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('library/print.html') + '?id=' + encodeURIComponent(selected.id) }));
  $('#d-more').addEventListener('click', () => {
    const menu = $('#d-menu');
    menu.hidden = !menu.hidden;
    $('#d-more').setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('button').focus();
  });
  $('#d-menu').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) menuAction(b.dataset.m); });
  $('#d-menu').addEventListener('keydown', (e) => {
    const items = $$('#d-menu button');
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { $('#d-menu').hidden = true; $('#d-more').focus(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.more')) $('#d-menu').hidden = true; });

  $('#d-notes').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    const act = e.target.closest('[data-act]');
    if (!li) return;
    const n = selNotes.find((x) => x.id === li.dataset.id);
    const tsLink = e.target.closest('a.ts');
    if (tsLink && n) {
      e.preventDefault();
      window.open(VS.timeLink(selected, Number(tsLink.dataset.t)), '_blank', 'noopener');
      return;
    }
    if (!act || !n) return;
    if (act.dataset.act === 'zoom') lightbox(n.image, `${fileBase()}-${VS.formatTime(n.t).replace(/:/g, '-')}`);
    if (act.dataset.act === 'edit') { editingId = n.id; renderDetail(); const ta = li.parentNode.querySelector(`li[data-id="${CSS.escape(n.id)}"] textarea`); if (ta) ta.focus(); }
    if (act.dataset.act === 'cancel') { editingId = null; renderDetail(); }
    if (act.dataset.act === 'save') saveEdit(li);
    if (act.dataset.act === 'delete') {
      const removed = await db.deleteNote(n.id);
      toast('Note deleted', { action: { label: 'Undo', run: () => db.restoreNote(removed) } });
    }
  });
  $('#d-notes').addEventListener('keydown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(li); }
    if (li && e.key === 'Escape' && editingId) { editingId = null; renderDetail(); }
  });

  $('#btn-export-all').addEventListener('click', () => exportJson(null));
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await db.importAll(data);
      toast(`Imported ${r.videosAdded} new video${r.videosAdded === 1 ? '' : 's'}, ${r.notesAdded} new note${r.notesAdded === 1 ? '' : 's'}${r.notesUpdated ? `, updated ${r.notesUpdated}` : ''}`);
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, { error: true });
    }
  });

  db.onDbChange(() => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 150); });
}
let reloadTimer = null;

async function saveEdit(li) {
  const text = li.querySelector('[data-f="text"]').value;
  const t = VS.parseTime(li.querySelector('[data-f="time"]').value);
  editingId = null;
  await db.updateNote(li.dataset.id, { text, t: Number.isFinite(t) ? t : undefined });
  toast('Note saved');
}

bind();
loadAll();
