// Research Canvas side panel (also used as popup and full-tab app).
import { COLORS, COLOR_HEX, PROJECT_COLORS, parseSnapshot, normalizeUrl, cleanTags, exportJSON } from '../lib/store.js';
import {
  renderMarkdown, extractWikilinks, escapeHtml, safeFilename, noteTitle, firstLine,
  noteToMarkdown, clipToMarkdown, projectToMarkdown, pageToMarkdown,
} from '../lib/markdown.js';

const MODE = new URLSearchParams(location.search).get('mode') || 'panel';
document.body.dataset.mode = MODE;
const HOST_ORIGINS = ['http://*/*', 'https://*/*'];

// ---------- icons ----------
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  highlight: '<path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/>',
  page: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  tab: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  sticky: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/>',
  bold: '<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4L9 20"/>',
  heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5H3v7h4M14 21c3 0 7-1 7-8V5h-7v7h4"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  wiki: '<path d="M8 4H5v16h3M16 4h3v16h-3"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
};
const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
const TYPE_ICON = { text: 'text', highlight: 'highlight', image: 'image', link: 'link', note: 'note', page: 'page' };
const TYPE_LABEL = { text: 'Text', highlight: 'Highlight', image: 'Image', link: 'Link', note: 'Note', page: 'Page' };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

async function api(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r || !r.ok) throw new Error((r && r.error) || 'Something went wrong');
  return r;
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}

function plain(md) {
  return String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, b, c) => c || a).replace(/[#>*_`~=]+/g, '').replace(/\s+/g, ' ').trim();
}

let toastTimer;
function toast(text, action) {
  const t = $('#toast');
  t.replaceChildren(el('span', { text }));
  if (action) t.append(el('button', { text: action.label, onclick: () => { t.hidden = true; action.run(); } }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
}
const fail = e => { console.error(e); toast(e.message || String(e)); };

// ---------- state ----------
const state = {
  snap: { projects: [], clips: [], pages: [], settings: {} },
  view: 'clips',
  query: '',
  typeFilter: 'all',
  tagFilter: '',
  noteId: null,
  noteScope: 'project',
  noteMode: 'write',
  tab: null, // { id, url, title, ok }
  ready: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('rc-ui') || '{}');
  if (saved.view) state.view = saved.view;
  if (saved.noteMode) state.noteMode = saved.noteMode;
  if (saved.noteScope) state.noteScope = saved.noteScope;
} catch { /* ignore */ }
function persistUi() {
  try { localStorage.setItem('rc-ui', JSON.stringify({ view: state.view, noteMode: state.noteMode, noteScope: state.noteScope })); } catch { /* ignore */ }
}

const activeProject = () => state.snap.projects.find(p => p.id === state.snap.settings.activeProjectId) || state.snap.projects[0];
const projectById = id => state.snap.projects.find(p => p.id === id);
const clipById = id => state.snap.clips.find(c => c.id === id);
const notes = () => state.snap.clips.filter(c => c.type === 'note');
const findNoteByTitle = title => {
  const t = String(title).trim().toLowerCase();
  return notes().filter(n => noteTitle(n).trim().toLowerCase() === t).sort((a, b) => b.updatedAt - a.updatedAt)[0];
};
const allTags = () => [...new Set(state.snap.clips.flatMap(c => c.tags || []))].sort();

async function loadSnapshot() {
  state.snap = parseSnapshot(await chrome.storage.local.get(null));
}

// ---------- header ----------
function renderHeader() {
  const sel = $('#projectSelect');
  const ap = activeProject();
  sel.replaceChildren(...state.snap.projects.map(p => {
    const n = state.snap.clips.filter(c => c.projectId === p.id).length;
    return el('option', { value: p.id, selected: ap && p.id === ap.id }, `${p.name}  (${n})`);
  }));
  $('#projectDot').style.background = ap ? ap.color : 'var(--accent)';
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(!state.query && t.dataset.view === state.view));
    t.tabIndex = t.dataset.view === state.view ? 0 : -1;
  }
}

$('#newProjectBtn').innerHTML = icon('plus');
$('#menuBtn').innerHTML = icon('more');
$('.search-icon').innerHTML = icon('search');

$('#projectSelect').addEventListener('change', async e => {
  await api('settings:set', { patch: { activeProjectId: e.target.value } }).catch(fail);
  state.tagFilter = '';
  if (state.view === 'notes' && state.noteScope === 'project') state.noteId = null;
});
$('#newProjectBtn').addEventListener('click', () => newProject());

async function newProject() {
  const name = await promptDialog('New project', { label: 'Project name', placeholder: 'e.g. Thesis literature review', ok: 'Create' });
  if (!name) return;
  try {
    await api('project:create', { name, activate: true });
    toast(`Created “${name}”`);
  } catch (e) { fail(e); }
}

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (!b) return;
  setView(b.dataset.view);
});
document.querySelector('.tabs').addEventListener('keydown', e => {
  const tabs = [...document.querySelectorAll('.tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
  if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
  if (j == null) return;
  e.preventDefault();
  tabs[j].focus();
  setView(tabs[j].dataset.view);
});

function setView(view) {
  state.view = view;
  if (state.query) { state.query = ''; $('#searchInput').value = ''; }
  persistUi();
  render();
  if (view === 'page') refreshTab();
}

let searchTimer;
$('#searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); render(); }, 120);
});
$('#searchInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; state.query = ''; render(); }
  if (e.key === 'Enter') { const r = $('.result'); if (r) r.click(); }
});
document.addEventListener('keydown', e => {
  const t = e.target;
  const typing = t.matches && t.matches('input, textarea, select, [contenteditable]');
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('#searchInput').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); }
});

// ---------- menu ----------
function buildMenu() {
  const m = $('#menu');
  const item = (ic, label, run) => el('button', { role: 'menuitem', onclick: () => { closeMenu(); run(); } }, el('span', { html: icon(ic) }), label);
  const ap = activeProject();
  m.replaceChildren(
    item('note', 'New note', () => createNote()),
    item('folder', 'Manage projects…', manageProjects),
    el('hr'),
    el('div', { class: 'label', text: `Export “${ap ? ap.name : 'project'}”` }),
    item('download', 'Markdown – one file per note', () => exportMarkdownFiles(ap.id).catch(fail)),
    item('download', 'Markdown – single file', () => exportMarkdownSingle(ap.id).catch(fail)),
    item('download', 'JSON', () => exportJsonFile(ap.id).catch(fail)),
    el('div', { class: 'label', text: 'Export everything' }),
    item('download', 'Markdown – one file per note', () => exportMarkdownFiles(null).catch(fail)),
    item('download', 'Markdown – single file', () => exportMarkdownSingle(null).catch(fail)),
    item('download', 'JSON (full backup)', () => exportJsonFile(null).catch(fail)),
    item('upload', 'Import JSON…', () => $('#importFile').click()),
    el('hr'),
    item('gear', 'Settings…', openSettings),
    item('keyboard', 'Keyboard shortcuts…', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })),
    MODE !== 'tab' ? item('tab', 'Open in a full tab', () => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html?mode=tab') })) : null,
  );
}
function openMenu() {
  buildMenu();
  $('#menu').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('#menu button').focus();
}
function closeMenu() {
  $('#menu').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}
$('#menuBtn').addEventListener('click', e => { e.stopPropagation(); $('#menu').hidden ? openMenu() : closeMenu(); });
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
$('#menu').addEventListener('keydown', e => {
  const items = [...$('#menu').querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { closeMenu(); $('#menuBtn').focus(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

// ---------- dialogs ----------
let dialogToken = 0;
function openDialog({ title, body, actions = [], onClose, wide }) {
  const d = $('#dialog');
  const token = ++dialogToken;
  if (d.open) d.close();
  d.style.width = wide ? 'min(640px, calc(100vw - 24px))' : '';
  return new Promise(resolve => {
    let result;
    const form = el('form', { method: 'dialog' });
    const footer = el('footer');
    for (const a of actions) {
      footer.append(el('button', {
        class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
        type: a.primary ? 'submit' : 'button',
        value: a.value || '',
        onclick: async ev => {
          if (a.primary) return; // handled by submit
          ev.preventDefault();
          result = a.run ? await a.run() : a.value;
          if (result !== false) d.close();
        },
      }, a.label));
    }
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const a = actions.find(x => x.primary);
      result = a && a.run ? await a.run() : (a ? a.value : undefined);
      if (result !== false) d.close();
    });
    form.append(el('header', { text: title }), el('div', { class: 'content' }, body), footer);
    d.replaceChildren(form);
    const handler = () => {
      if (token === dialogToken && d.open) return; // stale close event from a dialog this one replaced
      d.removeEventListener('close', handler);
      if (onClose) onClose();
      resolve(token === dialogToken ? result : undefined);
    };
    d.addEventListener('close', handler);
    d.showModal();
    const f = form.querySelector('[autofocus]') || form.querySelector('input, textarea, select');
    if (f) { f.focus(); if (f.select) f.select(); }
  });
}

async function promptDialog(title, { label = '', value = '', placeholder = '', ok = 'Save' } = {}) {
  const input = el('input', { class: 'input', value, placeholder, 'aria-label': label || title, autofocus: true, maxlength: 120 });
  const r = await openDialog({
    title,
    body: el('label', { class: 'field' }, label ? el('span', { text: label }) : null, input),
    actions: [{ label: 'Cancel', value: null }, { label: ok, primary: true, run: () => input.value.trim() || false }],
  });
  return r || null;
}

async function confirmDialog(title, message, { ok = 'Delete', danger = true } = {}) {
  const r = await openDialog({
    title,
    body: el('p', { style: { margin: 0, color: 'var(--muted)' }, text: message }),
    actions: [{ label: 'Cancel', value: false }, { label: ok, primary: true, danger, run: () => true }],
  });
  return r === true;
}

function tagEditor(initial = []) {
  let tags = [...initial];
  const input = el('input', { placeholder: 'Add tag and press Enter', list: 'tag-suggestions', 'aria-label': 'Add tag' });
  const wrap = el('div', { class: 'tag-editor' });
  const list = el('datalist', { id: 'tag-suggestions' }, ...allTags().map(t => el('option', { value: t })));
  const draw = () => {
    wrap.replaceChildren(...tags.map(t => el('span', { class: 'tag' }, '#' + t,
      el('button', { type: 'button', 'aria-label': `Remove tag ${t}`, onclick: () => { tags = tags.filter(x => x !== t); draw(); input.focus(); } }, '×'))), input, list);
  };
  const commit = () => {
    const v = input.value.split(/[,\s]+/).filter(Boolean);
    if (v.length) { tags = cleanTags([...tags, ...v]); input.value = ''; draw(); input.focus(); }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { if (input.value.trim()) { e.preventDefault(); commit(); } }
    if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); input.focus(); }
  });
  input.addEventListener('change', commit);
  draw();
  return { node: wrap, get: () => { commit(); return tags; } };
}

// ---------- clip editing ----------
async function editClip(clip) {
  const fields = [];
  const title = el('input', { class: 'input', value: clip.title || '', placeholder: 'Optional title' });
  const content = el('textarea', { class: 'input', rows: 6 });
  content.value = clip.content || '';
  const comment = el('textarea', { class: 'input', rows: 3, placeholder: 'Your thoughts…' });
  comment.value = clip.comment || '';
  const tags = tagEditor(clip.tags);
  const project = el('select', { class: 'input' }, ...state.snap.projects.map(p => el('option', { value: p.id, selected: p.id === clip.projectId }, p.name)));
  let color = clip.color;
  const sw = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Highlight color' });
  const drawSw = () => sw.replaceChildren(...COLORS.map(c => el('button', {
    type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(color === c.id), 'aria-label': c.name, title: c.name,
    style: { background: c.hex }, onclick: () => { color = c.id; drawSw(); },
  })));
  drawSw();

  if (clip.type !== 'highlight') fields.push(el('label', { class: 'field' }, el('span', { text: 'Title' }), title));
  if (clip.type === 'highlight') {
    fields.push(el('div', { class: 'field' }, el('span', { text: 'Highlighted text' }), el('div', { class: 'quote', style: { '--qc': COLOR_HEX[color] } }, el('span', { class: 'qtext', text: clip.content }))));
    fields.push(el('div', { class: 'field' }, el('span', { text: 'Color' }), sw));
  } else if (clip.type === 'image' || clip.type === 'link') {
    fields.push(el('label', { class: 'field' }, el('span', { text: clip.type === 'image' ? 'Image URL' : 'Link URL' }), Object.assign(content, { rows: 2 })));
  } else if (clip.type !== 'page') {
    fields.push(el('label', { class: 'field' }, el('span', { text: 'Content (Markdown)' }), content));
  }
  if (clip.type !== 'note') fields.push(el('label', { class: 'field' }, el('span', { text: 'Comment' }), comment));
  fields.push(el('div', { class: 'field' }, el('span', { text: 'Tags' }), tags.node));
  fields.push(el('label', { class: 'field' }, el('span', { text: 'Project' }), project));

  await openDialog({
    title: `Edit ${TYPE_LABEL[clip.type].toLowerCase()}`,
    body: el('div', { style: { display: 'contents' } }, ...fields),
    wide: true,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', primary: true, run: async () => {
          const patch = { tags: tags.get(), projectId: project.value };
          if (clip.type !== 'highlight') patch.title = title.value.trim();
          if (!['highlight', 'page'].includes(clip.type)) patch.content = content.value;
          if (clip.type !== 'note') patch.comment = comment.value.trim();
          if (clip.type === 'highlight') patch.color = color;
          try {
            await api('clip:update', { id: clip.id, patch });
            if (patch.projectId !== clip.projectId) toast(`Moved to ${projectById(patch.projectId).name}`);
          } catch (e) { fail(e); return false; }
          return true;
        },
      },
    ],
  });
}

async function deleteClip(clip, skipConfirm) {
  const what = clip.type === 'highlight' ? 'This also removes the highlight from the page.' : 'This cannot be undone.';
  if (!skipConfirm && !(await confirmDialog(`Delete ${TYPE_LABEL[clip.type].toLowerCase()}?`, what))) return;
  try {
    await api('clip:delete', { id: clip.id });
    if (state.noteId === clip.id) state.noteId = null;
    const backup = { ...clip };
    toast(`${TYPE_LABEL[clip.type]} deleted`, clip.type === 'highlight' ? null : {
      label: 'Undo',
      run: () => api('clip:add', { clip: backup }).catch(fail),
    });
  } catch (e) { fail(e); }
}

// ---------- clips view ----------
function clipCard(c) {
  const li = el('li', { class: 'card', tabindex: '0', draggable: 'true', dataset: { id: c.id }, 'aria-label': `${TYPE_LABEL[c.type]}: ${plain(c.title || c.content).slice(0, 80)}` });
  const actions = el('div', { class: 'actions' });
  if (c.url) actions.append(el('button', { class: 'icon-btn sm', title: 'Open source', 'aria-label': 'Open source page', html: icon('external'), onclick: () => openSource(c) }));
  actions.append(
    el('button', { class: 'icon-btn sm', title: 'Copy as Markdown', 'aria-label': 'Copy as Markdown', html: icon('copy'), onclick: () => copyText(clipToMarkdown(c)) }),
    el('button', { class: 'icon-btn sm', title: 'Edit', 'aria-label': 'Edit', html: icon('edit'), onclick: () => (c.type === 'note' ? openNote(c.id) : editClip(c)) }),
    el('button', { class: 'icon-btn sm danger', title: 'Delete', 'aria-label': 'Delete', html: icon('trash'), onclick: () => deleteClip(c) }),
  );
  const head = el('div', { class: 'card-head' },
    el('span', { class: 'grip', html: icon('grip'), title: 'Drag to reorder (or Alt+↑/↓)' }),
    el('span', { class: 'type', html: icon(TYPE_ICON[c.type]) + TYPE_LABEL[c.type] }),
    el('span', { text: '· ' + timeAgo(c.createdAt), title: new Date(c.createdAt).toLocaleString() }),
    actions);
  li.append(head);

  const body = el('div', { class: 'card-body' });
  let clampable = false;
  switch (c.type) {
    case 'highlight':
      body.append(el('div', { class: 'quote', style: { '--qc': COLOR_HEX[c.color] || COLOR_HEX.yellow } }, el('span', { class: 'qtext', text: c.content })));
      clampable = c.content.length > 400;
      break;
    case 'text':
      if (c.title) body.append(el('div', { class: 'note-title', text: c.title }));
      body.append(el('div', { class: 'md', html: renderMarkdown(c.content, { wikiExists: t => !!findNoteByTitle(t) }) }));
      clampable = c.content.length > 300 || c.content.split('\n').length > 6;
      break;
    case 'image':
      if (c.title) body.append(el('div', { class: 'note-title', text: c.title }));
      body.append(el('img', { class: 'thumb', src: c.content, alt: c.title || 'Clipped image', loading: 'lazy', referrerpolicy: 'no-referrer' }));
      break;
    case 'link':
      body.append(el('div', { class: 'linkline' }, el('span', { html: icon('link') }),
        el('a', { href: c.content, target: '_blank', rel: 'noopener', text: c.title || c.content })));
      if (c.title) body.append(el('div', { class: 'meta', text: host(c.content) }));
      break;
    case 'page':
      body.append(el('div', { class: 'linkline' }, el('span', { html: icon('page') }),
        el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.title || c.url })));
      if (c.content) body.append(el('div', { class: 'md', html: renderMarkdown(c.content) }));
      break;
    case 'note':
      body.append(el('button', { class: 'note-item', style: { padding: 0 }, onclick: () => openNote(c.id) },
        el('div', { class: 'note-title', text: noteTitle(c) }),
        el('div', { class: 'snippet', text: plain(c.content).slice(0, 300) || 'Empty note' })));
      break;
  }
  if (c.comment) body.append(el('div', { class: 'comment' }, el('span', { html: icon('comment') }), el('span', { text: c.comment })));
  li.append(body);
  if (clampable) {
    body.classList.add('clamp');
    li.append(el('button', {
      class: 'more', text: 'Show more', onclick: e => {
        const on = body.classList.toggle('clamp');
        e.target.textContent = on ? 'Show more' : 'Show less';
      },
    }));
  }
  const foot = el('div', { class: 'card-foot' });
  if (c.url && c.type !== 'page') {
    foot.append(el('a', { class: 'source', href: c.url, title: c.url, onclick: e => { e.preventDefault(); openSource(c); } },
      el('span', { html: icon('page') }), el('span', { text: c.pageTitle || host(c.url) || c.url })));
  }
  for (const t of c.tags || []) foot.append(el('button', { class: 'tag', title: `Filter by #${t}`, onclick: () => { state.tagFilter = t; render(); } }, '#' + t));
  if (foot.childNodes.length) li.append(foot);

  li.addEventListener('dblclick', e => { if (!e.target.closest('a,button')) (c.type === 'note' ? openNote(c.id) : editClip(c)); });
  li.addEventListener('keydown', e => {
    if (e.target !== li) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveClipBy(c.id, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling && li.nextElementSibling.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); li.previousElementSibling && li.previousElementSibling.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); c.type === 'note' ? openNote(c.id) : editClip(c); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteClip(c); }
  });
  return li;
}

function visibleClips() {
  const ap = activeProject();
  if (!ap) return [];
  return state.snap.clips.filter(c => c.projectId === ap.id &&
    (state.typeFilter === 'all' || c.type === state.typeFilter) &&
    (!state.tagFilter || (c.tags || []).includes(state.tagFilter)));
}

function renderClips(main) {
  const ap = activeProject();
  const projectClips = state.snap.clips.filter(c => c.projectId === (ap && ap.id));
  const counts = {};
  for (const c of projectClips) counts[c.type] = (counts[c.type] || 0) + 1;
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by type' },
    ...['all', 'text', 'highlight', 'note', 'image', 'link', 'page'].filter(t => t === 'all' || counts[t] || state.typeFilter === t).map(t =>
      el('button', {
        class: 'chip', 'aria-pressed': String(state.typeFilter === t),
        onclick: () => { state.typeFilter = t; render(); },
      }, t === 'all' ? `All ${projectClips.length}` : `${TYPE_LABEL[t]} ${counts[t] || 0}`)));
  const tags = [...new Set(projectClips.flatMap(c => c.tags || []))].sort();
  const toolbar = el('div', { class: 'toolbar' }, chips);
  if (tags.length || state.tagFilter) {
    toolbar.append(el('select', {
      class: 'input', style: { width: 'auto', maxWidth: '140px' }, 'aria-label': 'Filter by tag',
      onchange: e => { state.tagFilter = e.target.value; render(); },
    }, el('option', { value: '' }, 'All tags'), ...tags.map(t => el('option', { value: t, selected: t === state.tagFilter }, '#' + t))));
  }
  main.append(toolbar);

  // Quick composer
  const ta = el('textarea', { class: 'input', placeholder: 'Quick clip… Markdown supported (Ctrl+Enter)', 'aria-label': 'Quick clip text' });
  const save = async () => {
    const v = ta.value.trim();
    if (!v) return;
    try { await api('clip:add', { clip: { type: 'text', content: v, projectId: ap.id } }); ta.value = ''; toast('Added'); } catch (e) { fail(e); }
  };
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
  main.append(el('div', { class: 'composer' }, ta,
    el('button', { class: 'btn primary', title: 'Add clip', onclick: save, html: icon('plus') + 'Add' }),
    el('button', { class: 'btn', title: 'New note', 'aria-label': 'New note', onclick: () => createNote(), html: icon('note') })));

  const clips = visibleClips();
  if (!clips.length) {
    main.append(projectClips.length
      ? el('div', { class: 'empty' }, el('h3', { text: 'Nothing matches these filters' }),
        el('button', { class: 'btn', onclick: () => { state.typeFilter = 'all'; state.tagFilter = ''; render(); } }, 'Clear filters'))
      : el('div', { class: 'empty', html: `${icon('highlight', 'i big')}<h3>This project is empty</h3>
        <p>Select text on any page and pick a color in the floating toolbar, or right-click a selection, image or link and choose <b>Research Canvas → Clip … to project</b>.</p>
        <p>Use the box above for quick notes.</p>` }));
    return;
  }
  if (state.tagFilter) {
    main.append(el('div', { class: 'toolbar' }, el('span', { class: 'meta', text: `Showing clips tagged #${state.tagFilter}` }),
      el('button', { class: 'btn sm', onclick: () => { state.tagFilter = ''; render(); } }, 'Clear')));
  }
  const ul = el('ul', { class: 'cards', 'aria-label': 'Clips. Drag or press Alt+Up/Down to reorder.' }, ...clips.map(clipCard));
  setupDnD(ul);
  main.append(ul);
}

async function setOrderBetween(id, prev, next) {
  let order;
  if (prev && next) order = (prev.order + next.order) / 2;
  else if (prev) order = prev.order + 1000;
  else if (next) order = next.order - 1000;
  else return;
  // Guard against precision exhaustion: renumber the project if neighbours are too close.
  if (prev && next && Math.abs(next.order - prev.order) < 1e-6) {
    const all = visibleClips().filter(c => c.id !== id);
    const idx = all.findIndex(c => c.id === next.id);
    all.splice(idx, 0, clipById(id));
    await Promise.all(all.map((c, i) => api('clip:update', { id: c.id, patch: { order: i * 1000 } })));
    return;
  }
  await api('clip:update', { id, patch: { order } });
}

async function moveClipBy(id, delta) {
  const list = visibleClips();
  const i = list.findIndex(c => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  const rest = list.filter(c => c.id !== id);
  const prev = rest[j - 1];
  const next = rest[j];
  pendingFocus = id;
  await setOrderBetween(id, prev, next).catch(fail);
}
let pendingFocus = null;

let dragId = null;
function setupDnD(ul) {
  const clear = () => ul.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
  ul.addEventListener('dragstart', e => {
    const li = e.target.closest && e.target.closest('.card');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', clipToMarkdown(clipById(dragId)));
  });
  ul.addEventListener('dragend', e => {
    const li = e.target.closest && e.target.closest('.card');
    if (li) li.classList.remove('dragging');
    clear();
    setTimeout(() => { dragId = null; }, 0);
  });
  ul.addEventListener('dragover', e => {
    if (!dragId) return;
    const li = e.target.closest('.card');
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clear();
    if (!li || li.dataset.id === dragId) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  ul.addEventListener('drop', e => {
    if (!dragId) return;
    e.preventDefault();
    const li = ul.querySelector('.drop-before,.drop-after');
    const before = !!li && li.classList.contains('drop-before');
    clear();
    const id = dragId;
    dragId = null;
    if (!li) return;
    const rest = visibleClips().filter(c => c.id !== id);
    const idx = rest.findIndex(c => c.id === li.dataset.id);
    const insertAt = before ? idx : idx + 1;
    pendingFocus = id;
    setOrderBetween(id, rest[insertAt - 1], rest[insertAt]).catch(fail);
  });
}

async function openSource(c) {
  try {
    if (c.type === 'highlight' && c.highlightId) await api('open:highlight', { url: c.url, id: c.highlightId, tabId: await tabIdForUrl(c.url) });
    else await chrome.tabs.create({ url: c.url });
  } catch (e) { fail(e); }
}

async function tabIdForUrl(url) {
  // Only the current tab can be matched (no "tabs" permission needed).
  if (state.tab && state.tab.url && normalizeUrl(state.tab.url) === normalizeUrl(url)) return state.tab.id;
  return null;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch (e) { fail(e); }
}

// ---------- notes ----------
async function createNote(title = '', { open = true, projectId } = {}) {
  try {
    const pid = projectId || activeProject().id;
    const r = await api('clip:add', { clip: { type: 'note', title, content: '', projectId: pid } });
    state.snap.clips.push(r.clip);
    if (open) openNote(r.clip.id, { focusTitle: !title });
    return r.clip;
  } catch (e) { fail(e); return null; }
}

function openNote(id, { focusTitle } = {}) {
  const n = clipById(id);
  if (!n) return;
  if (n.projectId !== activeProject().id && state.noteScope === 'project') state.noteScope = 'all';
  flushEditor();
  state.noteId = id;
  state.view = 'notes';
  state.query = '';
  $('#searchInput').value = '';
  editor = null;
  persistUi();
  render();
  requestAnimationFrame(() => {
    if (!editor) return;
    if (focusTitle) editor.title.focus();
    else if (state.noteMode !== 'preview') editor.ta.focus();
  });
}

async function followWikilink(title) {
  const n = findNoteByTitle(title);
  if (n) openNote(n.id);
  else {
    const c = await createNote(title.trim(), { open: false });
    if (c) { openNote(c.id); toast(`Created note “${title.trim()}”`); }
  }
}

function backlinksFor(note) {
  const t = noteTitle(note).trim().toLowerCase();
  if (!t) return [];
  const out = [];
  for (const c of state.snap.clips) {
    if (c.id === note.id) continue;
    const text = c.type === 'note' ? c.content : `${c.content}\n${c.comment || ''}`;
    const links = extractWikilinks(text);
    if (!links.some(l => l.toLowerCase() === t)) continue;
    const line = String(text).split('\n').find(l => l.toLowerCase().includes('[[' + t)) || '';
    out.push({ clip: c, ctx: plain(line).slice(0, 140) });
  }
  return out;
}

let editor = null; // { id, title, ta, preview, area, links, saveTimer, lastTitle }
function flushEditor() { if (editor && editor.dirty && editor.flush) editor.flush(); }

function renderNotes(main) {
  const ap = activeProject();
  const list = notes().filter(n => state.noteScope === 'all' || n.projectId === ap.id).sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.noteId && !clipById(state.noteId)) state.noteId = null;
  const wrap = el('div', { class: 'notes' + (state.noteId ? ' has-note' : '') });
  const side = el('div', { class: 'side' },
    el('div', { class: 'toolbar' },
      el('div', { class: 'chips' },
        el('button', { class: 'chip', 'aria-pressed': String(state.noteScope === 'project'), onclick: () => { state.noteScope = 'project'; persistUi(); render(); } }, 'This project'),
        el('button', { class: 'chip', 'aria-pressed': String(state.noteScope === 'all'), onclick: () => { state.noteScope = 'all'; persistUi(); render(); } }, 'All')),
      el('button', { class: 'btn sm primary', onclick: () => createNote(), html: icon('plus') + 'New' })));
  if (!list.length) {
    side.append(el('div', { class: 'empty', html: `${icon('note', 'i big')}<h3>No notes yet</h3><p>Write Markdown notes and connect them with <code>[[wikilinks]]</code>. Backlinks appear automatically.</p>` }));
  } else {
    side.append(el('ul', { class: 'note-list' }, ...list.map(n => el('li', {}, el('button', {
      class: 'note-item', 'aria-current': String(n.id === state.noteId), onclick: () => openNote(n.id),
    }, el('div', { class: 't', text: noteTitle(n) }),
      el('div', { class: 's', text: (state.noteScope === 'all' ? (projectById(n.projectId) || {}).name + ' · ' : '') + timeAgo(n.updatedAt) + ' · ' + (plain(n.content).slice(0, 80) || 'Empty') }))))));
  }
  wrap.append(side);
  if (state.noteId) wrap.append(renderEditor(clipById(state.noteId)));
  else if (list.length && matchMedia('(min-width: 720px)').matches) {
    wrap.append(el('div', { class: 'editor' }, el('div', { class: 'empty', html: '<h3>Select a note</h3><p>or create a new one.</p>' })));
  }
  main.append(wrap);
}

function renderEditor(note) {
  // Reuse the live editor so typing is never interrupted by storage updates.
  if (editor && editor.id === note.id && editor.root.isConnected === false) {
    if (document.activeElement !== editor.title && editor.title.value !== (note.title || '') && !editor.dirty) editor.title.value = note.title || '';
    if (document.activeElement !== editor.ta && editor.ta.value !== note.content && !editor.dirty) editor.ta.value = note.content;
    updatePreview();
    updateLinks();
    return editor.root;
  }
  const title = el('input', { class: 'title-input', value: note.title || '', placeholder: 'Untitled note', 'aria-label': 'Note title', maxlength: 200 });
  const ta = el('textarea', { 'aria-label': 'Note body (Markdown)', spellcheck: 'true', placeholder: 'Write in Markdown. Link notes with [[Note title]].' });
  ta.value = note.content || '';
  const preview = el('div', { class: 'preview md', 'aria-label': 'Preview' });
  const area = el('div', { class: 'edit-area' }, ta, preview);
  const suggest = el('div', { class: 'suggest', role: 'listbox', hidden: true });
  area.append(suggest);
  const links = el('div', { class: 'links-section' });
  const fmtBtn = (ic, label, fn) => el('button', { class: 'icon-btn sm', type: 'button', title: label, 'aria-label': label, html: icon(ic), onclick: () => { fn(); ta.focus(); } });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Editor mode' });
  const modes = matchMedia('(min-width: 720px)').matches ? ['write', 'split', 'preview'] : ['write', 'preview'];
  if (!modes.includes(state.noteMode)) state.noteMode = 'write';
  const drawSeg = () => seg.replaceChildren(...modes.map(m => el('button', {
    type: 'button', 'aria-pressed': String(state.noteMode === m),
    onclick: () => { state.noteMode = m; persistUi(); applyMode(); drawSeg(); },
  }, m[0].toUpperCase() + m.slice(1))));
  drawSeg();
  const proj = projectById(note.projectId);
  const root = el('section', { class: 'editor', 'aria-label': 'Note editor' },
    el('div', { class: 'editor-top' },
      el('button', { class: 'icon-btn back-btn', title: 'Back to notes', 'aria-label': 'Back to notes', html: icon('back'), onclick: () => { flushEditor(); state.noteId = null; editor = null; render(); } }),
      title,
      el('button', { class: 'icon-btn sm', title: 'Tags & project', 'aria-label': 'Tags and project', html: icon('edit'), onclick: () => editClip(clipById(note.id)) }),
      el('button', { class: 'icon-btn sm', title: 'Download as .md', 'aria-label': 'Download as Markdown file', html: icon('download'), onclick: () => downloadText(`${safeFilename(noteTitle(clipById(note.id)))}.md`, noteToMarkdown(clipById(note.id), projectById(note.projectId))) }),
      el('button', { class: 'icon-btn sm danger', title: 'Delete note', 'aria-label': 'Delete note', html: icon('trash'), onclick: () => deleteClip(clipById(note.id)) })),
    el('div', { class: 'meta', id: 'noteMeta' }),
    el('div', { class: 'fmt', role: 'toolbar', 'aria-label': 'Formatting' },
      fmtBtn('bold', 'Bold (Ctrl+B)', () => wrapSel('**', '**')),
      fmtBtn('italic', 'Italic (Ctrl+I)', () => wrapSel('*', '*')),
      fmtBtn('heading', 'Heading', () => prefixLines('## ')),
      fmtBtn('list', 'Bulleted list', () => prefixLines('- ')),
      fmtBtn('check', 'Checklist', () => prefixLines('- [ ] ')),
      fmtBtn('quote', 'Quote', () => prefixLines('> ')),
      fmtBtn('code', 'Code', () => wrapSel('`', '`')),
      fmtBtn('link', 'Link (Ctrl+K)', () => wrapSel('[', '](https://)')),
      fmtBtn('wiki', 'Wikilink ([[)', () => { wrapSel('[[', ']]'); onInput(); }),
      seg),
    area,
    links);

  const ed = { id: note.id, root, title, ta, preview, area, links, suggest, saveTimer: null, dirty: false, lastTitle: noteTitle(note), proj };
  editor = ed;

  function wrapSel(a, b) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    ta.setRangeText(a + v.slice(s, e) + b, s, e, 'end');
    if (s === e) ta.setSelectionRange(s + a.length, s + a.length);
    onInput();
  }
  function prefixLines(p) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const block = v.slice(ls, e);
    const out = block.split('\n').map(l => (l.startsWith(p) ? l.slice(p.length) : p + l)).join('\n');
    ta.setRangeText(out, ls, e, 'end');
    onInput();
  }

  function scheduleSave() {
    ed.dirty = true;
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(save, 450);
  }
  async function save() {
    clearTimeout(ed.saveTimer);
    const cur = clipById(note.id);
    if (!cur) return;
    const patch = { title: title.value.trim(), content: ta.value };
    if (cur.title === patch.title && cur.content === patch.content) { ed.dirty = false; return; }
    try {
      ed.dirty = false;
      await api('clip:update', { id: note.id, patch });
    } catch (e) { ed.dirty = true; fail(e); }
  }
  ed.flush = save;

  function onInput() {
    scheduleSave();
    updatePreview();
    updateSuggest();
  }
  ta.addEventListener('input', onInput);
  title.addEventListener('input', scheduleSave);
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ta.focus(); } });
  title.addEventListener('change', async () => {
    await save();
    const newTitle = title.value.trim() || noteTitle({ content: ta.value });
    const oldTitle = ed.lastTitle;
    ed.lastTitle = newTitle;
    if (!oldTitle || oldTitle.toLowerCase() === newTitle.toLowerCase()) return;
    // Rename: update [[Old]] links in other notes.
    const re = new RegExp('\\[\\[\\s*' + oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\|[^\\]]*)?\\]\\]', 'gi');
    const affected = state.snap.clips.filter(c => c.id !== note.id && c.type === 'note' && re.test(c.content));
    if (!affected.length) return;
    for (const c of affected) {
      re.lastIndex = 0;
      await api('clip:update', { id: c.id, patch: { content: c.content.replace(re, (m, alias) => `[[${newTitle}${alias || ''}]]`) } }).catch(fail);
    }
    toast(`Updated links in ${affected.length} note${affected.length > 1 ? 's' : ''}`);
  });
  ta.addEventListener('keydown', e => {
    if (!suggest.hidden) {
      const items = [...suggest.querySelectorAll('button')];
      let i = items.findIndex(b => b.getAttribute('aria-selected') === 'true');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items.forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
        items[i].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); items[Math.max(0, i)].click(); return; }
      if (e.key === 'Escape') { e.preventDefault(); suggest.hidden = true; return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSel('**', '**'); }
    else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSel('*', '*'); }
    else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); wrapSel('[', '](https://)'); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); toast('Saved'); }
    else if (e.key === 'Tab' && !e.shiftKey && /^\s*([-*+]|\d+\.)\s/.test(ta.value.slice(ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1))) {
      e.preventDefault();
      const ls = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const pos = ta.selectionStart;
      ta.setRangeText('  ', ls, ls, 'preserve');
      ta.setSelectionRange(pos + 2, pos + 2);
      onInput();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Continue lists.
      const ls = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const line = ta.value.slice(ls, ta.selectionStart);
      const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?\s+/);
      if (m) {
        e.preventDefault();
        if (line.trim() === m[0].trim()) { ta.setRangeText('', ls, ta.selectionStart, 'end'); onInput(); return; }
        let bullet = m[2];
        if (/\d/.test(bullet)) bullet = (parseInt(bullet, 10) + 1) + bullet.slice(-1);
        ta.setRangeText('\n' + m[1] + bullet + (m[3] ? ' [ ]' : '') + ' ', ta.selectionStart, ta.selectionEnd, 'end');
        onInput();
      }
    }
  });
  ta.addEventListener('blur', () => { setTimeout(() => { suggest.hidden = true; }, 150); save(); });
  title.addEventListener('blur', save);
  preview.addEventListener('click', e => {
    const a = e.target.closest('a.wikilink');
    if (a) { e.preventDefault(); followWikilink(a.dataset.wikilink); }
  });
  preview.addEventListener('dblclick', e => { if (!e.target.closest('a') && state.noteMode === 'preview') { state.noteMode = 'write'; drawSeg(); applyMode(); ta.focus(); } });

  function applyMode() {
    ta.hidden = state.noteMode === 'preview';
    preview.hidden = state.noteMode === 'write';
    area.classList.toggle('split', state.noteMode === 'split');
    updatePreview();
  }

  function updateSuggest() {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/\[\[([^\[\]\n|]*)$/);
    if (!m) { suggest.hidden = true; return; }
    const q = m[1].toLowerCase();
    const titles = [...new Set(notes().filter(n => n.id !== note.id).map(noteTitle))]
      .filter(t => t.toLowerCase().includes(q)).sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q)).slice(0, 8);
    const items = titles.map(t => ({ t, label: t }));
    if (m[1].trim() && !titles.some(t => t.toLowerCase() === q.trim())) items.push({ t: m[1].trim(), label: `Create “${m[1].trim()}”`, isNew: true });
    if (!items.length) { suggest.hidden = true; return; }
    suggest.replaceChildren(...items.map((it, i) => el('button', {
      type: 'button', role: 'option', class: it.isNew ? 'new' : '', 'aria-selected': String(i === 0),
      onmousedown: e => e.preventDefault(),
      onclick: () => {
        const start = ta.selectionStart - m[1].length;
        const after = ta.value.slice(ta.selectionStart);
        const close = after.startsWith(']]') ? '' : ']]';
        ta.setRangeText(it.t + close, start, ta.selectionStart, 'end');
        if (!close) ta.setSelectionRange(ta.selectionStart + 2, ta.selectionStart + 2);
        suggest.hidden = true;
        onInput();
        ta.focus();
      },
    }, it.label)));
    // Position near the caret line.
    const lines = before.split('\n').length;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21;
    suggest.style.top = Math.min(ta.clientHeight - 40, 12 + lines * lh - ta.scrollTop) + 'px';
    suggest.hidden = false;
  }

  applyMode();
  updateLinks();
  return root;
}

function updatePreview() {
  if (!editor || editor.preview.hidden) return;
  editor.preview.innerHTML = renderMarkdown(editor.ta.value, { wikiExists: t => !!findNoteByTitle(t) }) ||
    '<p class="meta">Nothing to preview yet.</p>';
}

function updateLinks() {
  if (!editor) return;
  const note = clipById(editor.id);
  if (!note) return;
  const meta = editor.root.querySelector('#noteMeta');
  const proj = projectById(note.projectId);
  meta.textContent = `${proj ? proj.name : ''} · edited ${timeAgo(note.updatedAt)}${note.tags && note.tags.length ? ' · ' + note.tags.map(t => '#' + t).join(' ') : ''}${note.url ? ' · from ' + host(note.url) : ''}`;
  const back = backlinksFor(note);
  const out = extractWikilinks(editor.ta.value);
  const sec = [];
  sec.push(el('h4', { text: `Backlinks (${back.length})` }));
  sec.push(back.length
    ? el('ul', {}, ...back.map(b => el('li', {}, el('button', {
      class: 'backlink', onclick: () => (b.clip.type === 'note' ? openNote(b.clip.id) : jumpToClip(b.clip)),
    }, el('span', { class: 't', text: b.clip.type === 'note' ? noteTitle(b.clip) : (b.clip.title || TYPE_LABEL[b.clip.type]) }),
      el('span', { class: 'ctx', text: b.ctx }))))) : el('p', { class: 'meta', text: 'No notes link here yet. Link to this note with [[' + noteTitle(note) + ']].' }));
  if (out.length) {
    sec.push(el('h4', { text: `Links (${out.length})`, style: { marginTop: '12px' } }));
    sec.push(el('div', { class: 'chips' }, ...out.map(t => el('button', {
      class: 'chip', title: findNoteByTitle(t) ? 'Open note' : 'Create note',
      onclick: () => followWikilink(t),
    }, (findNoteByTitle(t) ? '' : '+ ') + t))));
  }
  editor.links.replaceChildren(...sec);
}

// ---------- current tab ("This page") ----------
async function refreshTab() {
  if (MODE === 'tab') { state.tab = null; if (state.view === 'page') render(); return; }
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (MODE === 'popup' || !tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { tab = null; }
  if (!tab) { state.tab = null; if (state.view === 'page') render(); return; }
  const info = { id: tab.id, url: tab.url || '', title: tab.title || '', ok: false, orphans: [] };
  try {
    const inj = await api('inject', { tabId: tab.id });
    if (inj.injected) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'rc:ping' });
      if (r && r.ok) Object.assign(info, { url: r.url, title: r.title, ok: true, orphans: r.orphans || [] });
    }
  } catch { /* restricted page or no access */ }
  state.tab = info;
  if (state.view === 'page' && !state.query) render();
}

chrome.tabs.onActivated.addListener(() => refreshTab());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (state.tab && id === state.tab.id && info.status === 'complete') setTimeout(refreshTab, 300);
});
if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener(w => { if (w !== chrome.windows.WINDOW_ID_NONE && MODE === 'panel') refreshTab(); });

function annotationItem(page, h, { orphan, tabId } = {}) {
  return el('div', { class: 'ann' },
    el('div', {
      class: 'body', tabindex: '0', role: 'button', title: 'Show on page',
      onclick: () => api('open:highlight', { url: page.url, id: h.id, tabId }).catch(fail),
      onkeydown: e => { if (e.key === 'Enter') e.currentTarget.click(); },
    },
    el('div', { class: 'quote', style: { '--qc': COLOR_HEX[h.color] || COLOR_HEX.yellow, margin: 0 } }, el('span', { class: 'qtext', text: h.quote.exact.length > 400 ? h.quote.exact.slice(0, 400) + '…' : h.quote.exact })),
    h.comment ? el('div', { class: 'comment' }, el('span', { html: icon('comment') }), el('span', { text: h.comment })) : null,
    orphan ? el('div', { class: 'warn', text: 'Not found on the page right now (content may have changed).' }) : null),
    el('button', {
      class: 'icon-btn sm danger', title: 'Delete highlight', 'aria-label': 'Delete highlight', html: icon('trash'),
      onclick: async () => { await api('hl:delete', { url: page.url, id: h.id }).catch(fail); },
    }));
}

const STICKY_HEX = { yellow: '#fff3bf', green: '#d3f9d8', blue: '#d0ebff', pink: '#ffdeeb', purple: '#e5dbff' };
function stickyItem(page, s, { tabId } = {}) {
  return el('div', { class: 'ann' },
    el('span', { class: 'sticky-chip', style: { background: STICKY_HEX[s.color] || STICKY_HEX.yellow } }),
    el('div', {
      class: 'body', tabindex: '0', role: 'button', title: 'Show on page',
      onclick: () => api('open:highlight', { url: page.url, id: s.id, tabId }).catch(fail),
      onkeydown: e => { if (e.key === 'Enter') e.currentTarget.click(); },
    }, el('div', { class: 'md', html: renderMarkdown(s.text || '_Empty sticky note_') })),
    el('button', {
      class: 'icon-btn sm', title: 'Send to project as a note', 'aria-label': 'Send to project as a note', html: icon('note'),
      onclick: async () => {
        const t = firstLine(s.text.replace(/^>\s*/gm, '')) || 'Sticky note';
        await api('clip:add', { clip: { type: 'note', title: t.slice(0, 80), content: s.text, url: page.url, pageTitle: page.title } }).then(() => toast('Sent to project')).catch(fail);
      },
    }),
    el('button', {
      class: 'icon-btn sm danger', title: 'Delete sticky note', 'aria-label': 'Delete sticky note', html: icon('trash'),
      onclick: () => api('sticky:delete', { url: page.url, id: s.id }).catch(fail),
    }));
}

function renderPage(main) {
  if (MODE === 'tab') {
    main.append(el('div', { class: 'empty', html: `${icon('page', 'i big')}<h3>Open the side panel on a page</h3><p>This view shows the highlights and sticky notes of the tab you are looking at. Use the <b>Pages</b> tab to browse every annotated page.</p>` }));
    return;
  }
  const t = state.tab;
  if (!t) { main.append(el('div', { class: 'empty', text: 'Loading…' })); refreshTab(); return; }
  const url = t.url ? normalizeUrl(t.url) : '';
  const page = state.snap.pages.find(p => p.url === url) || { url, title: t.title, highlights: [], stickies: [] };
  const send = async msg => {
    try {
      const r = await api('tab:send', { tabId: t.id, msg });
      if (r && r.ok === false && r.error) toast(r.error);
    } catch (e) { fail(e); }
  };
  const head = el('div', { class: 'page-head' },
    el('div', { class: 't', text: t.title || page.title || 'Current tab' }),
    el('div', { class: 'u', text: url || 'This page' }));
  if (t.ok) {
    head.append(el('div', { class: 'acts' },
      el('button', { class: 'btn sm', html: icon('highlight') + 'Highlight selection', onclick: () => send({ type: 'rc:highlight', color: state.snap.settings.defaultColor }) }),
      el('button', { class: 'btn sm', html: icon('sticky') + 'Sticky note', onclick: () => send({ type: 'rc:addSticky' }) }),
      el('button', {
        class: 'btn sm', html: icon('page') + 'Clip page', onclick: () => api('clip:add', { clip: { type: 'page', title: t.title, url, pageTitle: t.title } }).then(r => toast(`Clipped to ${r.projectName}`)).catch(fail),
      }),
      page.highlights.length || page.stickies.length ? el('button', { class: 'btn sm', html: icon('copy') + 'Copy Markdown', onclick: () => copyText(pageToMarkdown(page)) }) : null));
  } else {
    head.append(el('p', { class: 'meta', style: { margin: '8px 0 0' } },
      /^(https?|file):/.test(t.url || 'http:') ? 'Research Canvas has no access to this tab yet. Click the Research Canvas toolbar button (or press Ctrl+Shift+E) while on the page, or turn on automatic restore.'
        : 'Research Canvas cannot run on browser pages like this one.'));
    const acts = el('div', { class: 'acts' }, el('button', { class: 'btn sm', html: icon('refresh') + 'Retry', onclick: refreshTab }));
    if (!state.snap.settings.autoRestore) acts.append(el('button', { class: 'btn sm primary', text: 'Enable automatic restore', onclick: enableAutoRestore }));
    head.append(acts);
  }
  main.append(head);
  const hl = [...page.highlights].sort((a, b) => (a.position?.start || 0) - (b.position?.start || 0));
  main.append(el('div', { class: 'section-title', text: `Highlights (${hl.length})` }));
  if (hl.length) for (const h of hl) main.append(annotationItem(page, h, { orphan: t.ok && t.orphans.includes(h.id), tabId: t.id }));
  else main.append(el('p', { class: 'meta', text: 'Select text on the page and choose a color from the floating toolbar or the right-click menu.' }));
  main.append(el('div', { class: 'section-title', text: `Sticky notes (${page.stickies.length})` }));
  if (page.stickies.length) for (const s of page.stickies) main.append(stickyItem(page, s, { tabId: t.id }));
  else main.append(el('p', { class: 'meta', text: 'Add a sticky note from the button above or the right-click menu. Notes are draggable, resizable and collapsible.' }));
  const related = state.snap.clips.filter(c => c.url === url && c.type !== 'highlight');
  if (related.length) {
    main.append(el('div', { class: 'section-title', text: `Clips from this page (${related.length})` }));
    main.append(el('ul', { class: 'cards' }, ...related.map(c => { const li = clipCard(c); li.draggable = false; return li; })));
  }
}

function renderPages(main) {
  const pages = state.snap.pages;
  if (!pages.length) {
    main.append(el('div', { class: 'empty', html: `${icon('page', 'i big')}<h3>No annotated pages yet</h3><p>Pages you highlight or add sticky notes to show up here.</p>` }));
    return;
  }
  main.append(el('div', { class: 'toolbar' }, el('span', { class: 'meta', text: `${pages.length} annotated page${pages.length > 1 ? 's' : ''}` }), el('span', { class: 'spacer' }),
    el('button', { class: 'btn sm', html: icon('copy') + 'Copy all', onclick: () => copyText(pages.map(pageToMarkdown).join('\n')) })));
  for (const p of pages) {
    const det = el('details', { class: 'page-row' });
    det.append(el('summary', {},
      el('div', { class: 'info' },
        el('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: p.title || p.url }),
        el('div', { class: 'meta', text: `${host(p.url)} · ${p.highlights.length} highlight${p.highlights.length === 1 ? '' : 's'} · ${p.stickies.length} note${p.stickies.length === 1 ? '' : 's'} · ${timeAgo(p.updatedAt)}` })),
      el('button', { class: 'icon-btn sm', title: 'Open page', 'aria-label': 'Open page', html: icon('external'), onclick: e => { e.preventDefault(); chrome.tabs.create({ url: p.url }); } }),
      el('button', {
        class: 'icon-btn sm danger', title: 'Delete all annotations on this page', 'aria-label': 'Delete all annotations on this page', html: icon('trash'),
        onclick: async e => {
          e.preventDefault();
          if (await confirmDialog('Delete page annotations?', `Removes ${p.highlights.length} highlights and ${p.stickies.length} sticky notes from “${p.title || p.url}”.`)) api('page:delete', { url: p.url }).catch(fail);
        },
      })));
    const inner = el('div', { class: 'inner' });
    det.addEventListener('toggle', () => {
      if (!det.open || inner.childNodes.length) return;
      for (const h of p.highlights) inner.append(annotationItem(p, h));
      for (const s of p.stickies) inner.append(stickyItem(p, s));
    });
    det.append(inner);
    main.append(det);
  }
}

// ---------- search ----------
function parseQuery(q) {
  const out = { words: [], tags: [], types: [] };
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('#') && tok.length > 1) out.tags.push(tok.slice(1));
    else if (tok.startsWith('type:')) out.types.push(tok.slice(5));
    else out.words.push(tok);
  }
  return out;
}

function snippetHtml(text, words, len = 180) {
  const t = plain(text);
  const lower = t.toLowerCase();
  let i = words.length ? Math.max(0, ...words.map(w => lower.indexOf(w)).filter(x => x >= 0).slice(0, 1)) : 0;
  const start = Math.max(0, i - 50);
  let s = (start ? '…' : '') + t.slice(start, start + len) + (start + len < t.length ? '…' : '');
  s = escapeHtml(s);
  for (const w of words) {
    if (!w) continue;
    s = s.replace(new RegExp(escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  }
  return s;
}

function renderSearch(main) {
  const q = parseQuery(state.query);
  const match = (hay, tags = [], type) =>
    q.words.every(w => hay.includes(w)) && q.tags.every(t => tags.some(x => x.startsWith(t))) && (!q.types.length || q.types.some(t => (type || '').startsWith(t)));
  const clips = state.snap.clips.filter(c => match(
    [c.title, c.content, c.comment, c.pageTitle, c.url, (c.tags || []).join(' '), (projectById(c.projectId) || {}).name].join(' ').toLowerCase(), c.tags, c.type,
  )).sort((a, b) => b.updatedAt - a.updatedAt);
  const anns = [];
  if (!q.tags.length) {
    for (const p of state.snap.pages) {
      for (const h of p.highlights) {
        if (h.clipId && clipById(h.clipId)) continue; // already covered as a clip
        if (match([h.quote.exact, h.comment, p.title, p.url].join(' ').toLowerCase(), [], 'highlight')) anns.push({ p, h, kind: 'highlight' });
      }
      for (const s of p.stickies) if (match([s.text, p.title, p.url].join(' ').toLowerCase(), [], 'sticky')) anns.push({ p, s, kind: 'sticky' });
    }
  }
  const total = clips.length + anns.length;
  main.append(el('div', { class: 'toolbar' }, el('span', { class: 'meta', text: `${total} result${total === 1 ? '' : 's'} across all projects` }), el('span', { class: 'spacer' }),
    el('button', { class: 'btn sm', onclick: () => { state.query = ''; $('#searchInput').value = ''; render(); } }, 'Clear')));
  if (!total) {
    main.append(el('div', { class: 'empty', html: `${icon('search', 'i big')}<h3>No matches</h3><p>Try fewer words. Filter with <code>#tag</code> or <code>type:note</code>, <code>type:highlight</code>, <code>type:sticky</code>.</p>` }));
    return;
  }
  if (clips.length) {
    const g = el('div', { class: 'result-group' }, el('div', { class: 'section-title', text: `Clips & notes (${clips.length})` }));
    for (const c of clips.slice(0, 200)) {
      const p = projectById(c.projectId);
      g.append(el('button', { class: 'result', onclick: () => (c.type === 'note' ? openNote(c.id) : jumpToClip(c)) },
        el('div', { class: 'rt', html: icon(TYPE_ICON[c.type]) + snippetHtml(c.type === 'note' ? noteTitle(c) : (c.title || c.pageTitle || TYPE_LABEL[c.type]), q.words, 80) }),
        el('div', { class: 'rs', html: snippetHtml(`${c.content} ${c.comment || ''}`, q.words) }),
        el('div', { class: 'rm' },
          p ? el('span', { class: 'pill' }, el('span', { class: 'pd', style: { background: p.color } }), p.name) : null,
          el('span', { text: TYPE_LABEL[c.type] }), el('span', { text: '· ' + timeAgo(c.updatedAt) }),
          ...(c.tags || []).map(t => el('span', { class: 'tag', text: '#' + t })))));
    }
    main.append(g);
  }
  if (anns.length) {
    const g = el('div', { class: 'result-group' }, el('div', { class: 'section-title', text: `Page annotations (${anns.length})` }));
    for (const a of anns.slice(0, 200)) {
      const id = a.kind === 'highlight' ? a.h.id : a.s.id;
      const text = a.kind === 'highlight' ? `${a.h.quote.exact} ${a.h.comment || ''}` : a.s.text;
      g.append(el('button', { class: 'result', onclick: () => api('open:highlight', { url: a.p.url, id, tabId: null }).catch(fail) },
        el('div', { class: 'rt', html: icon(a.kind === 'highlight' ? 'highlight' : 'sticky') + escapeHtml(a.p.title || host(a.p.url)) }),
        el('div', { class: 'rs', html: snippetHtml(text, q.words) }),
        el('div', { class: 'rm', text: a.kind === 'highlight' ? 'Highlight' : 'Sticky note' })));
    }
    main.append(g);
  }
}

async function jumpToClip(c) {
  if (c.projectId !== activeProject().id) await api('settings:set', { patch: { activeProjectId: c.projectId } }).catch(fail);
  state.query = '';
  $('#searchInput').value = '';
  state.view = 'clips';
  state.typeFilter = 'all';
  state.tagFilter = '';
  state.snap.settings.activeProjectId = c.projectId;
  render();
  requestAnimationFrame(() => {
    const li = document.querySelector(`.card[data-id="${CSS.escape(c.id)}"]`);
    if (li) { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); li.classList.add('flash'); li.focus({ preventScroll: true }); }
  });
}

// ---------- settings & projects ----------
async function enableAutoRestore() {
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: HOST_ORIGINS }); } catch (e) { fail(e); }
  if (!granted) { toast('Permission not granted. Highlights restore when you open the panel on a page.'); return false; }
  await api('settings:set', { patch: { autoRestore: true } });
  await api('autoRestore:sync');
  toast('Highlights and notes will now restore automatically on every visit');
  refreshTab();
  return true;
}

async function openSettings() {
  const s = state.snap.settings;
  const cb = (checked, label, help) => {
    const input = el('input', { type: 'checkbox', checked });
    return { input, node: el('label', { class: 'check' }, input, el('span', {}, label, help ? el('small', { text: help }) : null)) };
  };
  const auto = cb(s.autoRestore, 'Restore highlights and sticky notes automatically', 'Re-applies your annotations whenever you revisit a page. Requires permission to read pages on all sites; data still never leaves your device.');
  const toolbarCb = cb(s.showToolbar, 'Show the floating toolbar when selecting text');
  const toProject = cb(s.highlightsToProject, 'Also add new highlights to the current project as clips');
  let color = s.defaultColor;
  const sw = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Default highlight color' });
  const drawSw = () => sw.replaceChildren(...COLORS.map(c => el('button', {
    type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(color === c.id), title: c.name, 'aria-label': c.name,
    style: { background: c.hex }, onclick: () => { color = c.id; drawSw(); },
  })));
  drawSw();
  let usage = '';
  try { usage = `${(await chrome.storage.local.getBytesInUse(null) / 1024).toFixed(1)} KB used · ${state.snap.projects.length} projects · ${state.snap.clips.length} clips · ${state.snap.pages.length} annotated pages`; } catch { /* ignore */ }
  const wipe = el('button', {
    type: 'button', class: 'btn danger sm', text: 'Delete all data…',
    onclick: async () => {
      const word = await promptDialog('Delete everything?', { label: 'Type DELETE to remove all projects, clips, notes, highlights and sticky notes', ok: 'Delete everything' });
      if (word !== 'DELETE') { if (word) toast('Nothing deleted'); return; }
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(k => /^(project|clip|page):/.test(k)));
      await api('project:create', { name: 'Inbox', activate: true });
      toast('All data deleted');
    },
  });
  await openDialog({
    title: 'Settings',
    body: el('div', { style: { display: 'contents' } },
      auto.node, toolbarCb.node, toProject.node,
      el('div', { class: 'field' }, el('span', { text: 'Default highlight color' }), sw),
      el('div', { class: 'field' }, el('span', { text: 'Keyboard shortcuts' }),
        el('div', { class: 'note-hint', html: '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> opens this panel. Shortcuts for highlighting, clipping and sticky notes can be assigned at <a href="#" id="kbLink">chrome://extensions/shortcuts</a>.' })),
      el('div', { class: 'field' }, el('span', { text: 'Storage' }), el('div', { class: 'note-hint', text: usage || 'Stored locally on this device.' }), el('div', {}, wipe))),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', primary: true, run: async () => {
          try {
            if (auto.input.checked && !s.autoRestore) { if (!(await enableAutoRestore())) auto.input.checked = false; }
            const patch = { showToolbar: toolbarCb.input.checked, highlightsToProject: toProject.input.checked, defaultColor: color };
            if (!auto.input.checked && s.autoRestore) {
              patch.autoRestore = false;
              await chrome.permissions.remove({ origins: HOST_ORIGINS }).catch(() => {});
            }
            await api('settings:set', { patch });
            if ('autoRestore' in patch) await api('autoRestore:sync');
            toast('Settings saved');
          } catch (e) { fail(e); return false; }
          return true;
        },
      },
    ],
  });
}
document.addEventListener('click', e => { if (e.target.id === 'kbLink') { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); } });

async function manageProjects() {
  const body = el('div', { style: { display: 'contents' } });
  const draw = () => {
    body.replaceChildren(...state.snap.projects.map(p => {
      const n = state.snap.clips.filter(c => c.projectId === p.id).length;
      const name = el('input', { class: 'input', value: p.name, 'aria-label': 'Project name' });
      name.addEventListener('change', () => api('project:update', { id: p.id, patch: { name: name.value } }).catch(fail));
      const color = el('input', { type: 'color', value: p.color || PROJECT_COLORS[0], 'aria-label': 'Project color', title: 'Color' });
      color.addEventListener('change', () => api('project:update', { id: p.id, patch: { color: color.value } }).catch(fail));
      return el('div', { class: 'proj-row' }, color, name, el('span', { class: 'n', text: `${n} item${n === 1 ? '' : 's'}` }),
        el('button', {
          type: 'button', class: 'icon-btn sm danger', title: 'Delete project', 'aria-label': `Delete project ${p.name}`, html: icon('trash'),
          disabled: state.snap.projects.length <= 1,
          onclick: async () => {
            const others = state.snap.projects.filter(x => x.id !== p.id);
            const target = el('select', { class: 'input' }, ...others.map(o => el('option', { value: o.id }, o.name)));
            const r = await openDialog({
              title: `Delete “${p.name}”?`,
              body: el('div', { style: { display: 'contents' } },
                el('p', { style: { margin: 0, color: 'var(--muted)' }, text: n ? `It contains ${n} item${n === 1 ? '' : 's'}. Move them to another project or delete them.` : 'The project is empty.' }),
                n ? el('label', { class: 'field' }, el('span', { text: 'Move items to' }), target) : null),
              actions: [
                { label: 'Cancel', value: null },
                n ? { label: 'Delete items too', danger: true, value: 'delete' } : null,
                { label: n ? 'Move & delete project' : 'Delete project', primary: true, danger: !n, run: () => 'move' },
              ].filter(Boolean),
            });
            if (!r) return manageProjects();
            try {
              await api('project:delete', { id: p.id, moveTo: r === 'move' ? target.value : null });
              toast(`Deleted “${p.name}”`);
            } catch (e) { fail(e); }
            await loadSnapshot();
            manageProjects();
          },
        }));
    }), el('button', { type: 'button', class: 'btn', html: icon('plus') + 'New project', onclick: async () => { $('#dialog').close(); await newProject(); } }));
  };
  draw();
  await openDialog({ title: 'Projects', body, actions: [{ label: 'Done', primary: true, run: () => true }] });
}

// ---------- export / import ----------
function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
}

const stamp = () => new Date().toISOString().slice(0, 10);

async function exportMarkdownFiles(projectId) {
  const projects = projectId ? [projectById(projectId)] : state.snap.projects;
  let count = 0;
  for (const p of projects) {
    const clips = state.snap.clips.filter(c => c.projectId === p.id);
    if (!clips.length) continue;
    const dir = `Research Canvas/${safeFilename(p.name, 'Project')}`;
    const used = new Set();
    const uniq = base => {
      let name = base;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
      used.add(name.toLowerCase());
      return name;
    };
    for (const n of clips.filter(c => c.type === 'note')) {
      await downloadText(`${dir}/${uniq(safeFilename(noteTitle(n)))}.md`, noteToMarkdown(n, p));
      count++;
    }
    const others = clips.filter(c => c.type !== 'note');
    if (others.length) {
      await downloadText(`${dir}/${uniq('_Clips')}.md`, `# ${p.name} – Clips\n\n` + others.map(c => clipToMarkdown(c, { headingLevel: 2 })).join('\n---\n\n'));
      count++;
    }
  }
  if (!projectId && state.snap.pages.length) {
    await downloadText('Research Canvas/_Page annotations.md', '# Page annotations\n\n' + state.snap.pages.map(pageToMarkdown).join('\n'));
    count++;
  }
  toast(count ? `Exported ${count} file${count === 1 ? '' : 's'} to Downloads/Research Canvas` : 'Nothing to export yet');
}

async function exportMarkdownSingle(projectId) {
  const projects = projectId ? [projectById(projectId)] : state.snap.projects;
  let md = projects.map(p => projectToMarkdown(p, state.snap.clips.filter(c => c.projectId === p.id))).join('\n\n');
  if (!projectId && state.snap.pages.length) md += '\n\n# Page annotations\n\n' + state.snap.pages.map(pageToMarkdown).join('\n');
  const name = projectId ? safeFilename(projects[0].name) : 'Research Canvas';
  await downloadText(`${name} ${stamp()}.md`, md);
  toast('Markdown exported');
}

async function exportJsonFile(projectId) {
  const data = await exportJSON(projectId);
  const name = projectId ? safeFilename(projectById(projectId).name) : 'research-canvas-backup';
  await downloadText(`${name} ${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('JSON exported');
}

$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const { stats } = await api('import', { data });
    toast(`Imported ${stats.projects} projects, ${stats.clips} clips, ${stats.highlights} highlights, ${stats.stickies} sticky notes`);
  } catch (err) {
    fail(err instanceof SyntaxError ? new Error('That file is not valid JSON.') : err);
  }
});

// ---------- render loop ----------
function render() {
  if (!state.ready) return;
  renderHeader();
  const main = $('#main');
  const scroll = main.scrollTop;
  const focusedId = pendingFocus || (document.activeElement && document.activeElement.closest && document.activeElement.closest('.card') && document.activeElement.closest('.card').dataset.id);
  main.replaceChildren();
  if (state.query) renderSearch(main);
  else if (state.view === 'clips') renderClips(main);
  else if (state.view === 'notes') renderNotes(main);
  else if (state.view === 'page') renderPage(main);
  else if (state.view === 'pages') renderPages(main);
  main.scrollTop = scroll;
  if (focusedId && state.view === 'clips') {
    const li = main.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`);
    if (li && (pendingFocus || !document.activeElement || document.activeElement === document.body)) li.focus({ preventScroll: !pendingFocus });
  }
  pendingFocus = null;
}

let reloadTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    await loadSnapshot();
    // While typing in the note editor, update only the parts around it.
    const typing = editor && editor.root.isConnected && (document.activeElement === editor.ta || document.activeElement === editor.title);
    if (typing && state.view === 'notes' && !state.query && clipById(editor.id)) {
      renderHeader();
      updateLinks();
      return;
    }
    if (document.querySelector('#dialog[open]') || document.querySelector('.composer textarea:focus') || dragId) { renderHeader(); return; }
    if (editor && editor.root.isConnected) editor.root.remove();
    render();
  }, 80);
});

// Flush the note being edited when the panel closes.
addEventListener('pagehide', flushEditor);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushEditor(); });

(async function init() {
  try {
    await loadSnapshot();
    if (!state.snap.projects.length) {
      await api('project:create', { name: 'Inbox', activate: true }).catch(() => {});
      await loadSnapshot();
    }
  } catch (e) { console.error(e); }
  state.ready = true;
  render();
  refreshTab();
})();
