// Library: browse, play, rename, trim, download and delete recordings; browse screenshots.
import {
  listRecordings, getRecording, getRecordingBlob, deleteRecording, updateRecording, putRecording,
  listShots, deleteShot, newId,
} from '../lib/db.js';
import { formatBytes, formatDate, formatDuration, safeFilename, downloadBlob, toast } from '../lib/util.js';
import { trimRecording } from './trim.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let tab = params.get('tab') === 'shots' ? 'shots' : 'recordings';
let recordings = [];
let shots = [];
let urls = [];
let current = null; // { meta, blob, url }

const ICONS = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  play: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="rgba(0,0,0,.6)"/><path d="M19 15l14 9-14 9z" fill="#fff"/></svg>',
};

function objUrl(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; }
function revokeAll() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }

async function load() {
  [recordings, shots] = await Promise.all([listRecordings(), listShots()]);
  $('count-recordings').textContent = recordings.length ? `(${recordings.length})` : '';
  $('count-shots').textContent = shots.length ? `(${shots.length})` : '';
  render();
  try {
    const est = await navigator.storage.estimate();
    $('storage').textContent = `Using ${formatBytes(est.usage || 0)} on this device. Nothing is uploaded.`;
  } catch { /* optional */ }
}

function selectTab(next) {
  tab = next;
  document.querySelectorAll('[role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const u = new URL(location.href);
  u.searchParams.set('tab', tab);
  u.searchParams.delete('play');
  history.replaceState(null, '', u);
  render();
}
document.querySelectorAll('[role=tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('search').addEventListener('input', render);

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
}

function render() {
  revokeAll();
  const q = $('search').value.trim().toLowerCase();
  const grid = $('grid');
  grid.innerHTML = '';
  const items = tab === 'recordings'
    ? recordings.filter(r => !q || (r.name || '').toLowerCase().includes(q))
    : shots.filter(s => !q || (s.title || '').toLowerCase().includes(q) || (s.url || '').toLowerCase().includes(q));
  $('empty').hidden = items.length > 0;
  if (!items.length) {
    $('empty-title').textContent = q ? 'Nothing matches your search' : tab === 'recordings' ? 'No recordings yet' : 'No screenshots yet';
    $('empty-text').textContent = q ? 'Try a different search.' : tab === 'recordings'
      ? 'Click the Capture Studio toolbar button and choose Start recording.'
      : 'Click the Capture Studio toolbar button, or press the screenshot shortcut, to capture a page.';
  }
  for (const item of items) grid.appendChild(tab === 'recordings' ? recordingCard(item) : shotCard(item));
}

function recordingCard(r) {
  const thumb = el('button', { class: 'thumb', 'aria-label': `Play ${r.name}`, onclick: () => openPlayer(r.id) }, [
    r.thumb ? el('img', { src: objUrl(r.thumb), alt: '', loading: 'lazy' }) : null,
    el('span', { class: 'kind', text: r.mode === 'tab' ? 'Tab' : r.mode === 'window' ? 'Window' : 'Screen' }),
    el('span', { class: 'badge', text: formatDuration(r.durationMs) }),
    el('span', { class: 'play', html: ICONS.play }),
  ]);
  const body = el('div', { class: 'card-body' }, [
    el('div', { class: 'card-text' }, [
      el('div', { class: 'card-title', text: r.name, title: r.name }),
      el('div', { class: 'card-sub', text: `${formatDate(r.created)} · ${formatBytes(r.size)}` }),
    ]),
    el('div', { class: 'card-actions' }, [
      el('button', { class: 'btn ghost', title: 'Download WebM', 'aria-label': `Download ${r.name}`, html: ICONS.download, onclick: () => downloadRecording(r.id) }),
      el('button', { class: 'btn ghost danger', title: 'Delete', 'aria-label': `Delete ${r.name}`, html: ICONS.trash, onclick: () => removeRecording(r.id) }),
    ]),
  ]);
  return el('article', { class: 'card' }, [thumb, body]);
}

function shotCard(s) {
  const open = () => { location.href = `../editor/editor.html?id=${s.id}`; };
  const kindLabel = { visible: 'Visible', region: 'Region', full: 'Full page', import: 'Imported' }[s.kind] || 'Screenshot';
  const thumb = el('button', { class: 'thumb', 'aria-label': `Edit ${s.title}`, onclick: open }, [
    s.thumb ? el('img', { src: objUrl(s.thumb), alt: '', loading: 'lazy' }) : null,
    el('span', { class: 'kind', text: kindLabel }),
  ]);
  const body = el('div', { class: 'card-body' }, [
    el('div', { class: 'card-text' }, [
      el('div', { class: 'card-title', text: s.title || 'Screenshot', title: s.url || s.title || '' }),
      el('div', { class: 'card-sub', text: `${formatDate(s.created)} · ${s.width} × ${s.height}` }),
    ]),
    el('div', { class: 'card-actions' }, [
      el('button', { class: 'btn ghost', title: 'Open in editor', 'aria-label': `Edit ${s.title}`, html: ICONS.edit, onclick: open }),
      el('button', { class: 'btn ghost danger', title: 'Delete', 'aria-label': `Delete ${s.title}`, html: ICONS.trash, onclick: async () => {
        if (!confirm(`Delete "${s.title}"? This cannot be undone.`)) return;
        await deleteShot(s.id);
        toast('Screenshot deleted');
        load();
      } }),
    ]),
  ]);
  return el('article', { class: 'card' }, [thumb, body]);
}

async function downloadRecording(id) {
  const meta = await getRecording(id);
  const blob = await getRecordingBlob(id);
  if (!blob) { toast('Recording not found', { error: true }); return; }
  downloadBlob(blob, `${safeFilename(meta.name, 'recording')}.webm`);
}

async function removeRecording(id) {
  const meta = recordings.find(r => r.id === id) || await getRecording(id);
  if (!confirm(`Delete "${meta ? meta.name : 'this recording'}"? This cannot be undone.`)) return false;
  await deleteRecording(id);
  toast('Recording deleted');
  await load();
  return true;
}

/* ------------------------------------------------------------------ */
/* Player                                                               */
/* ------------------------------------------------------------------ */
const video = $('video');
const dialog = $('player');

async function openPlayer(id) {
  const meta = await getRecording(id);
  const blob = meta && await getRecordingBlob(id);
  if (!blob) { toast('Recording not found', { error: true }); return; }
  closePlayer(false);
  current = { meta, blob, url: URL.createObjectURL(blob) };
  $('player-name').value = meta.name;
  renderMeta();
  closeTrim();
  video.src = current.url;
  if (!dialog.open) dialog.showModal();
  const u = new URL(location.href);
  u.searchParams.set('play', id);
  history.replaceState(null, '', u);
  video.addEventListener('loadedmetadata', fixInfiniteDuration, { once: true });
  video.play().catch(() => {});
}

function fixInfiniteDuration() {
  // Older files without a Duration element report Infinity until scanned to the end.
  if (video.duration !== Infinity) return;
  const back = () => { video.currentTime = 0; video.removeEventListener('durationchange', back); };
  video.addEventListener('durationchange', back);
  video.currentTime = 1e9;
}

function renderMeta() {
  const m = current.meta;
  const rows = [
    ['Length', formatDuration(m.durationMs)],
    ['Size', formatBytes(m.size)],
    ['Resolution', m.width ? `${m.width} × ${m.height}` : 'Unknown'],
    ['Source', m.mode === 'tab' ? 'Browser tab' : m.mode === 'window' ? 'Window' : m.mode === 'screen' ? 'Entire screen' : 'Trimmed clip'],
    ['Audio', m.hasAudio ? 'Yes' : 'No'],
    ['Created', formatDate(m.created)],
  ];
  const dl = $('player-meta');
  dl.innerHTML = '';
  for (const [k, v] of rows) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); }
}

function closePlayer(updateUrl = true) {
  if (trimAbort) trimAbort.abort();
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  if (updateUrl) {
    const u = new URL(location.href);
    u.searchParams.delete('play');
    history.replaceState(null, '', u);
  }
}

$('player-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => closePlayer());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

$('player-name').addEventListener('change', async e => {
  if (!current) return;
  const name = e.target.value.trim() || current.meta.name;
  e.target.value = name;
  current.meta = await updateRecording(current.meta.id, { name });
  toast('Renamed');
  load();
});
$('player-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('act-download').addEventListener('click', () => current && downloadBlob(current.blob, `${safeFilename(current.meta.name, 'recording')}.webm`));
$('act-delete').addEventListener('click', async () => {
  if (!current) return;
  if (await removeRecording(current.meta.id)) dialog.close();
});

/* ------------------------------------------------------------------ */
/* Trim                                                                 */
/* ------------------------------------------------------------------ */
const trim = { in: 0, out: 0, dur: 0 };
let trimAbort = null;
let previewStop = null;

function duration() {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  return (current?.meta.durationMs || 0) / 1000;
}

function openTrim() {
  trim.dur = duration();
  if (!trim.dur) { toast('Video is still loading, try again in a moment.'); return; }
  trim.in = 0;
  trim.out = trim.dur;
  $('trim').hidden = false;
  $('act-trim').hidden = true;
  $('trim-progress').hidden = true;
  setTrimBusy(false);
  drawTrim();
  $('h-in').focus();
}
function closeTrim() {
  $('trim').hidden = true;
  $('act-trim').hidden = false;
  if (trimAbort) trimAbort.abort();
}
function drawTrim() {
  const pct = t => `${(t / trim.dur) * 100}%`;
  $('h-in').style.left = pct(trim.in);
  $('h-out').style.left = pct(trim.out);
  $('range').style.left = pct(trim.in);
  $('range').style.width = `${((trim.out - trim.in) / trim.dur) * 100}%`;
  $('playhead').style.left = pct(Math.min(trim.dur, video.currentTime || 0));
  const fmt = s => { const ms = Math.round(s * 1000); return `${formatDuration(ms)}.${String(Math.floor((ms % 1000) / 100))}`; };
  $('trim-label').textContent = `${fmt(trim.in)} - ${fmt(trim.out)} (${fmt(trim.out - trim.in)})`;
  $('h-in').setAttribute('aria-valuetext', fmt(trim.in));
  $('h-out').setAttribute('aria-valuetext', fmt(trim.out));
}
function setIn(t) { trim.in = Math.max(0, Math.min(t, trim.out - 0.2)); drawTrim(); }
function setOut(t) { trim.out = Math.min(trim.dur, Math.max(t, trim.in + 0.2)); drawTrim(); }

$('act-trim').addEventListener('click', openTrim);
$('trim-cancel').addEventListener('click', closeTrim);
$('set-in').addEventListener('click', () => setIn(video.currentTime));
$('set-out').addEventListener('click', () => setOut(video.currentTime));
video.addEventListener('timeupdate', () => { if (!$('trim').hidden) drawTrim(); });

const timeline = $('timeline');
function timeAt(e) {
  const r = timeline.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * trim.dur;
}
let dragging = null;
timeline.addEventListener('pointerdown', e => {
  if (e.target.id === 'h-in' || e.target.id === 'h-out') dragging = e.target.id;
  else { video.currentTime = timeAt(e); drawTrim(); return; }
  timeline.setPointerCapture(e.pointerId);
});
timeline.addEventListener('pointermove', e => {
  if (!dragging) return;
  const t = timeAt(e);
  if (dragging === 'h-in') setIn(t); else setOut(t);
  video.currentTime = dragging === 'h-in' ? trim.in : trim.out;
});
timeline.addEventListener('pointerup', () => { dragging = null; });
for (const id of ['h-in', 'h-out']) {
  $(id).addEventListener('keydown', e => {
    const step = e.shiftKey ? 1 : 0.1;
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    if (id === 'h-in') { setIn(trim.in + delta); video.currentTime = trim.in; } else { setOut(trim.out + delta); video.currentTime = trim.out; }
  });
}

$('trim-preview').addEventListener('click', () => {
  if (previewStop) video.removeEventListener('timeupdate', previewStop);
  video.currentTime = trim.in;
  video.play().catch(() => {});
  previewStop = () => { if (video.currentTime >= trim.out) { video.pause(); video.removeEventListener('timeupdate', previewStop); previewStop = null; } };
  video.addEventListener('timeupdate', previewStop);
});

function setTrimBusy(busy) {
  for (const id of ['trim-preview', 'set-in', 'set-out', 'trim-replace', 'h-in', 'h-out', 'act-download', 'act-delete']) $(id).disabled = busy;
  $('trim-go').disabled = busy;
  $('trim-cancel').textContent = busy ? 'Stop' : 'Cancel';
}

$('trim-go').addEventListener('click', async () => {
  if (!current) return;
  if (trim.in <= 0.05 && trim.out >= trim.dur - 0.05) { toast('Move the start or end point first.'); return; }
  const src = current;
  video.pause();
  trimAbort = new AbortController();
  setTrimBusy(true);
  const bar = $('trim-progress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  try {
    const { blob, durationMs } = await trimRecording(src.blob, trim.in, trim.out, {
      hasAudio: src.meta.hasAudio !== false,
      signal: trimAbort.signal,
      onProgress: f => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; },
    });
    const replace = $('trim-replace').checked;
    const id = replace ? src.meta.id : newId('r');
    const meta = {
      ...src.meta, id, durationMs, size: blob.size, mimeType: blob.type,
      name: replace ? src.meta.name : `${src.meta.name} (trimmed)`,
      created: replace ? src.meta.created : Date.now(),
      mode: replace ? src.meta.mode : 'trim',
    };
    await putRecording(meta, blob);
    toast(replace ? 'Recording trimmed' : 'Trimmed copy saved');
    await load();
    await openPlayer(id);
  } catch (e) {
    if (e.name !== 'AbortError') toast('Trim failed: ' + e.message, { error: true });
    setTrimBusy(false);
    bar.hidden = true;
  } finally {
    trimAbort = null;
  }
});

document.addEventListener('keydown', e => {
  if (!dialog.open || $('trim').hidden || e.target.closest('input, textarea, select')) return;
  if (e.key === 'i' || e.key === 'I') { setIn(video.currentTime); }
  else if (e.key === 'o' || e.key === 'O') { setOut(video.currentTime); }
});

/* ------------------------------------------------------------------ */
selectTab(tab);
load().then(() => {
  const play = params.get('play');
  if (play) { selectTab('recordings'); openPlayer(play); }
});
