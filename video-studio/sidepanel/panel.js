// Notes panel. Runs as the Chrome side panel, or inside an iframe injected into the page
// (?tab=<id>&embedded=1) where the sidePanel API is unavailable.
import * as db from '../lib/db.js';
import { renderMarkdown, escapeHtml } from '../lib/markdown.js';
import { buildMarkdown, downloadFile, safeFilename } from '../lib/export.js';
import { icon, $, $$, toast, lightbox, toTab, getSettings, relTime } from '../lib/ui.js';

const VS = globalThis.VS;
const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1';

let tabId = params.get('tab') ? Number(params.get('tab')) : null;
let windowId = params.get('win') ? Number(params.get('win')) : null;
let settings = VS.normalizeSettings({});
let st = null; // latest state from the content script
let video = null; // DB record or a virtual one for the current key
let notes = [];
let currentKey = null;
let editingId = null;
let tab = 'notes';
let composer = { t: null, image: null, pausedByUs: false };
let pendingFocusId = null;
let port = null;
let pollTimer = null;

// ---------------------------------------------------------------- setup
function setIcons() {
  const set = (id, name, label) => { const el = $(id); el.innerHTML = icon(name) + (label ? `<span>${label}</span>` : ''); };
  set('#btn-library', 'library');
  set('#btn-settings', 'settings');
  set('#btn-close', 'close');
  set('#btn-play', 'play');
  set('#btn-back', 'rewind');
  set('#btn-fwd', 'forward');
  set('#btn-slower', 'minus');
  set('#btn-faster', 'plus');
  set('#btn-loop-toggle', 'loop');
  set('#btn-export', 'download', 'Export');
  set('#btn-shot', 'camera', 'Frame');
  set('#btn-bm-quick', 'bookmark', 'Bookmark');
  set('#shot-remove', 'close');
}

function applySettingsToUi() {
  const b = settings.bindings;
  $('#kbd-note').textContent = VS.bindingLabel(b.addNote);
  $('#kbd-shot').textContent = VS.bindingLabel(b.screenshotNote);
  $('#kbd-bm').textContent = VS.bindingLabel(b.bookmark);
  $('#btn-back').title = `Rewind ${settings.seekSeconds}s`;
  $('#btn-fwd').title = `Advance ${settings.seekSeconds}s`;
}

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'vs-panel' });
    port.onDisconnect.addListener(() => { port = null; setTimeout(connectPort, 1000); });
    sayHello();
  } catch (_) { /* extension reloading */ }
}
function sayHello() {
  if (port) port.postMessage({ type: 'hello', tabId, windowId, embedded });
}

async function init() {
  setIcons();
  settings = await getSettings();
  applySettingsToUi();
  if (embedded) {
    $('#btn-close').hidden = false;
    document.body.classList.add('embedded');
  } else {
    try {
      const w = await chrome.windows.getCurrent();
      windowId = w.id;
      const [t] = await chrome.tabs.query({ active: true, windowId });
      tabId = t ? t.id : null;
    } catch (_) { /* ignore */ }
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId !== windowId) return;
      tabId = info.tabId;
      sayHello();
      resetForTab();
    });
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (id === tabId && info.status === 'complete') poll();
    });
  }
  connectPort();
  bindEvents();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) { settings = VS.normalizeSettings(changes.settings.newValue); applySettingsToUi(); }
  });
  db.onDbChange((m) => {
    if (!currentKey) { if (m.kind !== 'note' || !st || !st.hasVideo) renderRecent(); return; }
    if (!m.videoId || m.videoId === currentKey || m.kind === 'import') loadVideo(currentKey);
  });
  const events = new BroadcastChannel('vs-events');
  events.onmessage = (e) => {
    const m = e.data || {};
    if (m.kind === 'focus-note' && m.tabId === tabId) {
      pendingFocusId = m.noteId;
      focusPendingNote();
    }
  };
  try {
    const r = await chrome.runtime.sendMessage({ type: 'vs-pending-focus', tabId });
    if (r && r.noteId) pendingFocusId = r.noteId;
  } catch (_) { /* ignore */ }
  await poll();
  schedulePoll();
  document.addEventListener('visibilitychange', schedulePoll);
}

function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, document.visibilityState === 'visible' ? 500 : 2500);
}

function resetForTab() {
  st = null;
  currentKey = null;
  video = null;
  notes = [];
  editingId = null;
  composer = { t: null, image: null, pausedByUs: false };
  $('#note-text').value = '';
  renderShot();
  poll();
}

// ---------------------------------------------------------------- state polling
let polling = false;
async function poll() {
  if (polling || tabId == null) { if (tabId == null) showNoVideo('none'); return; }
  polling = true;
  try {
    const r = await toTab(tabId, { type: 'vs-get-state' });
    if (r && r.error && !('hasVideo' in r)) {
      st = null;
      showNoVideo(r.error === 'no-content-script' ? 'no-script' : 'none');
      return;
    }
    st = r;
    if (!st.hasVideo) { showNoVideo(st.childHasVideo ? 'child' : 'none'); return; }
    if (st.key !== currentKey) {
      currentKey = st.key;
      editingId = null;
      await loadVideo(st.key);
    }
    renderPlayer();
  } finally {
    polling = false;
  }
}

async function send(msg) {
  const r = await toTab(tabId, msg);
  if (r && r.hasVideo) { st = r; renderPlayer(); }
  return r;
}

// ---------------------------------------------------------------- data
function virtualVideo() {
  return { id: st.key, title: st.title, url: st.url, pageUrl: st.pageUrl, site: st.site, duration: st.duration, bookmarks: [] };
}

async function loadVideo(key) {
  const [v, n] = await Promise.all([db.getVideo(key), db.getNotes(key)]);
  if (key !== currentKey) return;
  video = v || (st && st.key === key ? virtualVideo() : { id: key, bookmarks: [] });
  notes = n;
  showVideoUi();
  renderHeader();
  renderNotes();
  renderChapters();
  renderMarks();
  focusPendingNote();
}

async function ensureVideo() {
  if (!st || !st.hasVideo) throw new Error('No video');
  const existing = await db.getVideo(st.key);
  let thumb = null;
  if (!existing || !existing.thumb) {
    const r = await toTab(tabId, { type: 'vs-thumb' });
    thumb = r && r.thumb;
  }
  video = await db.upsertVideo({ key: st.key, title: st.title, url: st.url, pageUrl: st.pageUrl, site: st.site, duration: st.duration, thumb });
  return video;
}

// ---------------------------------------------------------------- rendering
function showNoVideo(kind) {
  $('#player').hidden = true;
  $('#tabs').hidden = true;
  $('#composer').hidden = true;
  $('#pane-notes').hidden = true;
  $('#pane-chapters').hidden = true;
  $('#no-video').hidden = false;
  $('#scroll').hidden = true;
  $('#video-title').textContent = 'Video Studio';
  $('.head-thumb').hidden = true;
  const meta = $('#video-meta');
  meta.textContent = st && st.title ? st.title : 'Notes and speed control';
  if (currentKey) { currentKey = null; video = null; notes = []; }
  const reload = $('#btn-reload');
  if (kind === 'no-script') {
    $('#nv-title').textContent = 'Video Studio is not active on this tab';
    $('#nv-text').textContent = 'This page was open before Video Studio was installed or updated, or it is a browser page where extensions cannot run. Reload the page to start.';
    reload.hidden = false;
  } else if (kind === 'child') {
    $('#nv-title').textContent = 'Waiting for the embedded video';
    $('#nv-text').textContent = 'This page has a video inside an embedded player. Press play on it once to connect.';
    reload.hidden = true;
  } else {
    $('#nv-title').textContent = 'No video on this tab';
    $('#nv-text').textContent = 'Open a lecture or tutorial and press play. Notes you take here are saved to that video.';
    reload.hidden = true;
  }
  renderRecent();
}

let recentRendered = 0;
async function renderRecent() {
  if (Date.now() - recentRendered < 3000 && $('#recent-list').childElementCount) return;
  recentRendered = Date.now();
  const [videos, counts] = await Promise.all([db.listVideos(), db.countNotesByVideo()]);
  videos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const list = $('#recent-list');
  const top = videos.slice(0, 8);
  $('.recent').hidden = !top.length;
  list.innerHTML = top.map((v) => `<li><a href="${escapeHtml(VS.timeLink(v, 0) || v.url || '#')}" data-id="${escapeHtml(v.id)}" target="_blank" rel="noopener">
      ${v.thumb ? `<img src="${v.thumb}" alt="">` : '<span class="ph"></span>'}
      <span><span class="t">${escapeHtml(v.title || v.url || 'Untitled video')}</span>
      <span class="m">${escapeHtml(v.site || '')} · ${counts[v.id] || 0} notes · ${relTime(v.updatedAt)}</span></span></a></li>`).join('');
}

function showVideoUi() {
  $('#no-video').hidden = true;
  $('#player').hidden = false;
  $('#tabs').hidden = false;
  $('#scroll').hidden = false;
  $('#composer').hidden = tab !== 'notes';
  $('#pane-notes').hidden = tab !== 'notes';
  $('#pane-chapters').hidden = tab !== 'chapters';
}

function renderHeader() {
  const title = (video && video.title) || (st && st.title) || 'Untitled video';
  $('#video-title').textContent = title;
  $('#video-title').title = title;
  const parts = [];
  if (st && st.site) parts.push(st.site);
  if (st && st.duration) parts.push(VS.formatTime(st.duration));
  if (notes.length) parts.push(`${notes.length} note${notes.length === 1 ? '' : 's'}`);
  $('#video-meta').textContent = parts.join(' · ');
  const img = $('.head-thumb');
  if (video && video.thumb) { img.src = video.thumb; img.hidden = false; } else img.hidden = true;
}

function renderPlayer() {
  if (!st || !st.hasVideo) return;
  $('#btn-play').innerHTML = icon(st.paused ? 'play' : 'pause');
  $('#btn-play').title = st.paused ? 'Play' : 'Pause';
  $('#time').textContent = `${VS.formatTime(st.time)} / ${st.duration ? VS.formatTime(st.duration) : '–:––'}`;
  $('#speed-val').textContent = (Math.round(st.rate * 100) / 100).toFixed(2) + '×';
  const pct = st.duration ? Math.min(100, (st.time / st.duration) * 100) : 0;
  $('#progress-fill').style.width = pct + '%';
  const loop = st.loop || {};
  $('#loop-a').textContent = loop.a != null ? VS.formatTime(loop.a) : '–';
  $('#loop-b').textContent = loop.b != null ? VS.formatTime(loop.b) : '–';
  $('#btn-loop-toggle').classList.toggle('active', !!loop.on);
  $('#btn-loop-toggle').setAttribute('aria-pressed', String(!!loop.on));
  const lp = $('#progress-loop');
  if (st.duration && loop.a != null && loop.b != null) {
    lp.hidden = false;
    lp.style.left = (loop.a / st.duration) * 100 + '%';
    lp.style.width = ((loop.b - loop.a) / st.duration) * 100 + '%';
    lp.style.opacity = loop.on ? '1' : '.4';
  } else lp.hidden = true;
  $('#bm-time').textContent = VS.formatTime(st.time);
  if (composer.t == null) $('#stamp').textContent = VS.formatTime(st.time);
  // Highlight the current note and chapter.
  let cur = null;
  for (const n of notes) if (n.t <= st.time + 0.5) cur = n.id;
  for (const li of $$('#notes > li')) li.classList.toggle('current', li.dataset.id === cur);
  const marks = (video && video.bookmarks) || [];
  let curB = null;
  for (const b of marks) if (b.t <= st.time + 0.5) curB = b.id;
  for (const li of $$('#chapters > li')) li.classList.toggle('current', li.dataset.id === curB);
  if (!$('#progress-marks').childElementCount && (marks.length || notes.length) && st.duration) renderMarks();
  if (st.title && video && !video.createdAt && st.title !== video.title) { video.title = st.title; renderHeader(); }
}

function renderMarks() {
  const host = $('#progress-marks');
  if (!st || !st.duration) { host.innerHTML = ''; return; }
  const d = st.duration;
  const marks = ((video && video.bookmarks) || []).map((b) => `<i style="left:${(b.t / d) * 100}%" title="${escapeHtml(b.label)}"></i>`);
  const ns = notes.map((n) => `<i class="note" style="left:${(n.t / d) * 100}%"></i>`);
  host.innerHTML = marks.join('') + ns.join('');
}

function renderNotes() {
  const list = $('#notes');
  $('#count-notes').textContent = String(notes.length);
  $('#notes-empty').hidden = notes.length > 0;
  list.innerHTML = notes.map((n) => (n.id === editingId ? editHtml(n) : noteHtml(n))).join('');
  renderHeader();
  renderMarks();
  if (editingId) {
    const ta = list.querySelector(`li[data-id="${CSS.escape(editingId)}"] textarea`);
    if (ta && document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function noteHtml(n) {
  const ts = VS.formatTime(n.t);
  let warn = '';
  if (!n.image && n.imageError) {
    const why = n.imageError === 'tainted' ? 'The site blocked frame capture.' : 'Screenshot failed.';
    warn = `<div class="note-warn">${why} <button class="btn small" data-act="tabshot">${icon('camera')}Capture tab at ${ts}</button></div>`;
  }
  return `<li class="note" data-id="${escapeHtml(n.id)}">
    <div class="note-head">
      <button class="ts-btn" data-act="seek" title="Jump to ${ts}">${ts}</button>
      <div class="note-actions">
        <button class="btn ghost small icon" data-act="shot" title="${n.image ? 'Replace screenshot' : 'Add screenshot'} at ${ts}">${icon('camera')}</button>
        <button class="btn ghost small icon" data-act="copy" title="Copy link to this moment">${icon('copy')}</button>
        <button class="btn ghost small icon" data-act="edit" title="Edit">${icon('edit')}</button>
        <button class="btn ghost small icon danger" data-act="delete" title="Delete">${icon('trash')}</button>
      </div>
    </div>
    <div class="md">${renderMarkdown(n.text)}</div>
    ${n.image ? `<img class="note-img" src="${n.image}" alt="Frame at ${ts}" data-act="zoom" loading="lazy">` : ''}
    ${warn}
  </li>`;
}

function editHtml(n) {
  return `<li class="note note-edit" data-id="${escapeHtml(n.id)}">
    <div class="row"><label class="muted small" for="edit-time">Time</label>
      <input class="input time-input" id="edit-time" value="${VS.formatTime(n.t)}" aria-label="Note time">
      <button class="btn ghost small" data-act="settime" title="Use the current video time">Now</button>
    </div>
    <textarea class="input" rows="5" aria-label="Note text">${escapeHtml(n.text)}</textarea>
    ${n.image ? `<div class="row"><img class="note-img" src="${n.image}" alt="" style="max-height:80px;width:auto"><button class="btn small danger" data-act="rmimg">Remove image</button></div>` : ''}
    <div class="row" style="margin-top:8px"><span class="muted small">Ctrl+Enter to save, Esc to cancel</span><span class="spacer"></span>
      <button class="btn small" data-act="cancel">Cancel</button><button class="btn small primary" data-act="save">Save</button></div>
  </li>`;
}

function renderChapters() {
  const marks = ((video && video.bookmarks) || []).slice().sort((a, b) => a.t - b.t);
  $('#count-chapters').textContent = String(marks.length);
  $('#chapters-empty').hidden = marks.length > 0;
  $('#chapters').innerHTML = marks.map((b) => `<li class="chapter" data-id="${escapeHtml(b.id)}">
      <button class="ts-btn" data-act="seek">${VS.formatTime(b.t)}</button>
      <input value="${escapeHtml(b.label)}" aria-label="Bookmark title" maxlength="300">
      <button class="btn ghost small icon" data-act="loop" title="Loop this chapter">${icon('loop')}</button>
      <button class="btn ghost small icon danger" data-act="delete" title="Delete bookmark">${icon('trash')}</button>
    </li>`).join('');
  renderMarks();
}

function renderShot() {
  $('#shot-preview').hidden = !composer.image;
  if (composer.image) $('#shot-img').src = composer.image;
  $('#btn-shot').classList.toggle('active', !!composer.image);
}

function setTab(name) {
  tab = name;
  $('#tab-notes').setAttribute('aria-selected', String(name === 'notes'));
  $('#tab-chapters').setAttribute('aria-selected', String(name === 'chapters'));
  if (st && st.hasVideo) showVideoUi();
}

function focusPendingNote() {
  if (!pendingFocusId) return;
  const n = notes.find((x) => x.id === pendingFocusId);
  if (!n) return;
  pendingFocusId = null;
  setTab('notes');
  editingId = n.id;
  renderNotes();
  const li = $(`#notes li[data-id="${CSS.escape(n.id)}"]`);
  if (li) { li.scrollIntoView({ block: 'center' }); li.classList.add('flash'); }
  if (settings.pauseWhileTyping && st && !st.paused) { send({ type: 'vs-pause' }); composer.pausedByUs = true; }
  window.focus();
}

// ---------------------------------------------------------------- screenshots
function shotErrorText(r) {
  if (r.reason === 'tainted') return 'This site serves the video from another origin without permission to read its pixels, so the frame cannot be copied directly.';
  if (r.reason === 'not-ready') return 'The video has no frame yet. Press play, then try again.';
  if (r.reason === 'hidden') return 'The tab must be visible to capture it.';
  return 'The screenshot failed' + (r.message ? `: ${r.message}` : '.');
}

async function requestTabPermission() {
  try {
    return await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch (e) {
    toast('Could not ask for permission here. Grant "tab capture" in Settings.', { error: true, action: { label: 'Settings', run: () => chrome.runtime.openOptionsPage() } });
    return false;
  }
}

// Tab capture fallback: needs permission to capture the visible tab.
async function captureViaTab(seekTo) {
  const granted = await requestTabPermission();
  if (!granted) return { ok: false, reason: 'denied' };
  const r = await toTab(tabId, { type: 'vs-capture-tab', seekTo });
  if (!r.ok) toast(r.reason === 'permission' ? 'Chrome refused to capture this tab.' : shotErrorText(r), { error: true });
  return r;
}

function showShotWarn(r, onTab) {
  const box = $('#shot-warn');
  if (!r) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div>${escapeHtml(shotErrorText(r))}</div>`;
  if (r.reason === 'tainted') {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.innerHTML = icon('camera') + 'Capture visible tab instead';
    b.addEventListener('click', onTab);
    box.appendChild(b);
  }
}

async function composerShot() {
  if (!st || !st.hasVideo) return;
  if (composer.t == null) composer.t = st.time;
  $('#stamp').textContent = VS.formatTime(composer.t);
  const r = await toTab(tabId, { type: 'vs-capture-frame', allowTab: false });
  if (r.ok) {
    composer.image = r.image;
    showShotWarn(null);
    if (r.warning === 'blank') toast('The frame looks black. The video may be DRM-protected.');
  } else {
    showShotWarn(r, async () => {
      const t = await captureViaTab();
      if (t.ok) { composer.image = t.image; showShotWarn(null); renderShot(); }
    });
  }
  renderShot();
}

async function noteShot(n, viaTab) {
  let r;
  if (viaTab) r = await captureViaTab(n.t);
  else {
    r = await toTab(tabId, { type: 'vs-capture-frame', seekTo: n.t, allowTab: false });
    if (!r.ok && r.reason === 'tainted') {
      toast('This site blocks frame capture.', { action: { label: 'Capture tab', run: () => noteShot(n, true) } });
      await db.updateNote(n.id, { imageError: 'tainted' });
      return;
    }
  }
  if (r.ok) {
    await db.updateNote(n.id, { image: r.image, imageError: null });
    toast('Screenshot saved');
  } else if (!viaTab) toast(shotErrorText(r), { error: true });
}

// ---------------------------------------------------------------- note actions
async function saveComposer() {
  const text = $('#note-text').value.trim();
  if (!text && !composer.image) { $('#note-text').focus(); return; }
  if (!st || !st.hasVideo) { toast('No video to attach the note to', { error: true }); return; }
  const t = composer.t != null ? composer.t : st.time;
  const key = st.key;
  await ensureVideo();
  await db.addNote({ videoId: key, t, text, image: composer.image });
  $('#note-text').value = '';
  composer.t = null;
  composer.image = null;
  renderShot();
  showShotWarn(null);
  if (composer.pausedByUs) { composer.pausedByUs = false; send({ type: 'vs-play' }); }
  await loadVideo(key);
  const last = $('#notes > li:last-child');
  const just = notes.reduce((a, n) => (!a || n.createdAt > a.createdAt ? n : a), null);
  const li = just && $(`#notes li[data-id="${CSS.escape(just.id)}"]`);
  (li || last) && (li || last).scrollIntoView({ block: 'nearest' });
}

async function saveEdit(li) {
  const id = li.dataset.id;
  const text = li.querySelector('textarea').value;
  const t = VS.parseTime(li.querySelector('#edit-time').value);
  editingId = null;
  await db.updateNote(id, { text, t: Number.isFinite(t) ? t : undefined });
  if (composer.pausedByUs) { composer.pausedByUs = false; send({ type: 'vs-play' }); }
  await loadVideo(currentKey);
}

async function deleteNote(id) {
  const n = await db.deleteNote(id);
  if (!n) return;
  if (editingId === id) editingId = null;
  await loadVideo(currentKey);
  toast('Note deleted', { action: { label: 'Undo', run: async () => { await db.restoreNote(n); loadVideo(currentKey); } } });
}

async function addBookmark(label) {
  if (!st || !st.hasVideo) return;
  const t = st.time;
  await ensureVideo();
  await db.addBookmark(st.key, t, label || `Bookmark at ${VS.formatTime(t)}`);
  await loadVideo(st.key);
  toast(`Bookmark added at ${VS.formatTime(t)}`);
}

async function exportMarkdown() {
  const v = (await db.getVideo(currentKey)) || video;
  const md = buildMarkdown(v, notes);
  downloadFile(safeFilename(v.title || 'video-notes', 'md'), md, 'text/markdown');
}

// ---------------------------------------------------------------- events
function bindEvents() {
  $('#btn-library').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'vs-open-library', videoId: currentKey }));
  $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#btn-close').addEventListener('click', () => window.parent.postMessage({ __vs: 1, kind: 'panel-close' }, '*'));
  $('#btn-reload').addEventListener('click', () => { chrome.tabs.reload(tabId); setTimeout(poll, 1500); });
  $('#btn-play').addEventListener('click', () => send({ type: 'vs-toggle-play' }));
  $('#btn-back').addEventListener('click', () => send({ type: 'vs-action', action: 'seekRel', delta: -settings.seekSeconds }));
  $('#btn-fwd').addEventListener('click', () => send({ type: 'vs-action', action: 'seekRel', delta: settings.seekSeconds }));
  $('#btn-slower').addEventListener('click', () => send({ type: 'vs-action', action: 'slower' }));
  $('#btn-faster').addEventListener('click', () => send({ type: 'vs-action', action: 'faster' }));
  $('#speed-val').addEventListener('click', () => send({ type: 'vs-action', action: 'reset' }));
  $('#progress').addEventListener('click', (e) => {
    if (!st || !st.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    send({ type: 'vs-seek', t: ((e.clientX - r.left) / r.width) * st.duration });
  });
  const loopMsg = (a, b, on) => send({ type: 'vs-set-loop', a, b, on });
  $('#btn-loop-a').addEventListener('click', () => {
    const l = st.loop || {};
    const b = l.b != null && l.b > st.time ? l.b : null;
    loopMsg(st.time, b, b != null);
  });
  $('#btn-loop-b').addEventListener('click', () => {
    const l = st.loop || {};
    const a = l.a != null ? l.a : 0;
    if (st.time <= a + 0.2) { toast('Loop end must be after the start (A)', { error: true }); return; }
    loopMsg(a, st.time, true);
  });
  $('#btn-loop-toggle').addEventListener('click', () => {
    const l = st.loop || {};
    if (l.a == null || l.b == null) { toast('Set A and B first'); return; }
    loopMsg(l.a, l.b, !l.on);
  });
  $('#btn-loop-clear').addEventListener('click', () => loopMsg(null, null, false));

  $('#tab-notes').addEventListener('click', () => setTab('notes'));
  $('#tab-chapters').addEventListener('click', () => setTab('chapters'));
  $('#tabs').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      setTab(tab === 'notes' ? 'chapters' : 'notes');
      $(tab === 'notes' ? '#tab-notes' : '#tab-chapters').focus();
    }
  });
  $('#btn-export').addEventListener('click', exportMarkdown);

  // Composer
  const ta = $('#note-text');
  ta.addEventListener('input', () => {
    if (composer.t == null && st && st.hasVideo) {
      composer.t = st.time;
      $('#stamp').textContent = VS.formatTime(composer.t);
      if (settings.pauseWhileTyping && !st.paused) { send({ type: 'vs-pause' }); composer.pausedByUs = true; }
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveComposer(); }
    if (e.key === 'Escape') { ta.blur(); }
  });
  ta.addEventListener('blur', () => {
    if (!ta.value.trim() && !composer.image) {
      composer.t = null;
      if (composer.pausedByUs) { composer.pausedByUs = false; send({ type: 'vs-play' }); }
    }
  });
  $('#stamp').addEventListener('click', () => {
    if (!st || !st.hasVideo) return;
    composer.t = st.time;
    $('#stamp').textContent = VS.formatTime(composer.t);
    ta.focus();
  });
  $('#btn-save').addEventListener('click', saveComposer);
  $('#btn-shot').addEventListener('click', composerShot);
  $('#shot-remove').addEventListener('click', () => { composer.image = null; renderShot(); });
  $('#shot-img').addEventListener('click', () => lightbox(composer.image, 'frame'));
  $('#btn-bm-quick').addEventListener('click', () => addBookmark(''));

  // Notes list (event delegation)
  $('#notes').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const n = notes.find((x) => x.id === li.dataset.id);
    const tsLink = e.target.closest('a.ts');
    if (tsLink) { e.preventDefault(); send({ type: 'vs-seek', t: Number(tsLink.dataset.t) }); return; }
    const actEl = e.target.closest('[data-act]');
    if (!actEl || !n) return;
    switch (actEl.dataset.act) {
      case 'seek': send({ type: 'vs-seek', t: n.t }); break;
      case 'zoom': lightbox(n.image, `frame-${VS.formatTime(n.t).replace(/:/g, '-')}`); break;
      case 'edit': editingId = n.id; renderNotes(); break;
      case 'delete': deleteNote(n.id); break;
      case 'shot': noteShot(n, false); break;
      case 'tabshot': noteShot(n, true); break;
      case 'copy': {
        const link = VS.timeLink(video, n.t);
        try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (_) { toast(link); }
        break;
      }
      case 'cancel': editingId = null; renderNotes(); break;
      case 'save': saveEdit(li); break;
      case 'settime': li.querySelector('#edit-time').value = VS.formatTime(st ? st.time : n.t); break;
      case 'rmimg': await db.updateNote(n.id, { image: null, imageError: null }); break;
      default: break;
    }
  });
  $('#notes').addEventListener('keydown', (e) => {
    const li = e.target.closest('li.note-edit');
    if (!li) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(li); }
    if (e.key === 'Escape') { e.preventDefault(); editingId = null; renderNotes(); }
  });

  // Bookmarks
  $('#bm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('#bm-label').value.trim();
    await addBookmark(label);
    $('#bm-label').value = '';
  });
  $('#chapters').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    const actEl = e.target.closest('[data-act]');
    if (!li || !actEl) return;
    const marks = ((video && video.bookmarks) || []).slice().sort((a, b) => a.t - b.t);
    const i = marks.findIndex((b) => b.id === li.dataset.id);
    const b = marks[i];
    if (!b) return;
    if (actEl.dataset.act === 'seek') send({ type: 'vs-seek', t: b.t });
    if (actEl.dataset.act === 'delete') {
      await db.deleteBookmark(currentKey, b.id);
      toast('Bookmark deleted');
    }
    if (actEl.dataset.act === 'loop') {
      const end = marks[i + 1] ? marks[i + 1].t : (st && st.duration) || b.t + 30;
      await send({ type: 'vs-set-loop', a: b.t, b: end, on: true });
      send({ type: 'vs-seek', t: b.t, play: true });
      toast(`Looping ${VS.formatTime(b.t)} – ${VS.formatTime(end)}`);
    }
  });
  $('#chapters').addEventListener('change', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li && e.target.matches('input')) db.updateBookmark(currentKey, li.dataset.id, { label: e.target.value.trim() });
  });
  $('#chapters').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
  });

  // Panel-level shortcuts mirror the page shortcuts when focus is not in a text field.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    let action = null;
    for (const [a, b] of Object.entries(settings.bindings)) if (VS.bindingMatches(b, e)) { action = a; break; }
    if (!action || !st || !st.hasVideo) return;
    e.preventDefault();
    if (action === 'addNote') { setTab('notes'); $('#note-text').focus(); return; }
    if (action === 'screenshotNote') { setTab('notes'); composerShot().then(() => $('#note-text').focus()); return; }
    if (action === 'bookmark') { addBookmark(''); return; }
    send({ type: 'vs-action', action });
  });
}

init().catch((e) => {
  console.warn('Video Studio panel failed to start', e);
  toast('Video Studio could not start: ' + e.message, { error: true });
});
