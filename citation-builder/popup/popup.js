import { createEditor } from '../shared/editor.js';
import { STYLES, STYLE_LABELS, formatCitation, formatInText, formatNote } from '../lib/formatters.js';
import { toBibtex, toRis } from '../lib/export.js';
import { collectPageData } from '../lib/extract-page.js';
import { normalizePage, itemFromIdentifier } from '../lib/normalize.js';
import { blankItem, cleanItem, duplicateReason } from '../lib/model.js';
import { detectIdentifier } from '../lib/identifiers.js';
import { todayISO } from '../lib/text.js';
import {
  getSettings, setSettings, ensureDefaultProject, getProjects, createProject, getItems, saveItem, takePending,
} from '../lib/storage.js';
import { hasLookupPermission, lookupIdentifier, mergeLookup } from '../lib/lookup.js';
import { copyRich, copyText, toast, debounce, applyTheme } from '../lib/dom.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('window') === '1') document.body.classList.add('windowed');

let settings;
let current = blankItem();
let savedId = null; // after saving, further edits update the same stored citation
let projects = [];

const editor = createEditor($('editor'), {
  idPrefix: 'pf',
  onChange: item => {
    current = item;
    renderPreviewSoon();
    updateLookupBar();
    checkDuplicateSoon();
  },
});

function status(msg, tone = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'notice' + (tone ? ' ' + tone : '');
  el.hidden = !msg;
}

function renderPreview() {
  const style = settings.style;
  const opts = { sentenceCase: settings.sentenceCase };
  const c = formatCitation(current, style, opts);
  const t = formatInText(current, style, opts);
  $('preview').innerHTML = c.html;
  $('preview').classList.toggle('hanging', style !== 'ieee');
  $('intext').innerHTML = t.html;
  $('intext-label').textContent = style === 'chicago-nb' ? 'Short note' : 'In-text';
  $('style-name').textContent = STYLE_LABELS[style];
}
const renderPreviewSoon = debounce(renderPreview, 60);

// ---------- style select ----------
function fillStyles() {
  const sel = $('style');
  sel.replaceChildren(...STYLES.map(s => new Option(s.short, s.id, false, s.id === settings.style)));
  sel.addEventListener('change', async () => {
    settings = await setSettings({ style: sel.value });
    renderPreview();
  });
}

// ---------- projects ----------
async function fillProjects(selectId) {
  projects = await ensureDefaultProject();
  projects = await getProjects();
  const sel = $('project');
  const chosen = selectId || settings.lastProjectId;
  const opts = projects.map(p => new Option(p.name, p.id, false, p.id === chosen));
  opts.push(new Option('+ New project…', '__new__'));
  sel.replaceChildren(...opts);
  if (!projects.some(p => p.id === chosen) && projects[0]) sel.value = projects[0].id;
}

$('project').addEventListener('change', async e => {
  if (e.target.value === '__new__') {
    $('new-project').hidden = false;
    $('new-project-name').focus();
    return;
  }
  settings = await setSettings({ lastProjectId: e.target.value });
  savedId = null;
  checkDuplicate();
});

async function createProjectFromInput() {
  const name = $('new-project-name').value.trim();
  if (!name) { $('new-project-name').focus(); return; }
  const p = await createProject(name);
  settings = await setSettings({ lastProjectId: p.id });
  $('new-project').hidden = true;
  $('new-project-name').value = '';
  await fillProjects(p.id);
  savedId = null;
  checkDuplicate();
  toast(`Created “${p.name}”`);
}
$('new-project-ok').addEventListener('click', createProjectFromInput);
$('new-project-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); createProjectFromInput(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelNewProject(); }
});
function cancelNewProject() {
  $('new-project').hidden = true;
  $('project').value = settings.lastProjectId && projects.some(p => p.id === settings.lastProjectId) ? settings.lastProjectId : (projects[0]?.id || '');
}
$('new-project-cancel').addEventListener('click', cancelNewProject);

// ---------- duplicates ----------
async function checkDuplicate() {
  const projectId = $('project').value;
  const box = $('dup-warning');
  if (!projectId || projectId === '__new__') { box.hidden = true; return; }
  const items = await getItems(projectId);
  const cur = cleanItem(current);
  const dup = items.find(i => i.id !== savedId && duplicateReason(i, cur));
  if (!dup) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(
    document.createTextNode(`Already in this project (${duplicateReason(dup, cur)}): “${(dup.title || 'Untitled').slice(0, 60)}”`),
  );
  const view = document.createElement('button');
  view.className = 'btn btn-sm btn-ghost';
  view.type = 'button';
  view.textContent = 'View';
  view.addEventListener('click', () => openManager(projectId, dup.id));
  box.appendChild(view);
}
const checkDuplicateSoon = debounce(checkDuplicate, 250);

// ---------- save ----------
async function save() {
  let projectId = $('project').value;
  if (projectId === '__new__') { $('new-project-name').focus(); return; }
  const cur = cleanItem(current);
  if (!cur.title && !cur.authors.length && !cur.url && !cur.doi) {
    toast('Add at least a title before saving', { tone: 'error' });
    return;
  }
  const stored = await saveItem({ ...cur, id: savedId || undefined, projectId });
  const wasUpdate = savedId === stored.id;
  savedId = stored.id;
  settings = await setSettings({ lastProjectId: projectId });
  const pname = projects.find(p => p.id === projectId)?.name || 'project';
  $('save').textContent = 'Update';
  status(wasUpdate ? `Updated in “${pname}”.` : `Saved to “${pname}”. Edit and press Update to change it.`, 'ok');
  toast(wasUpdate ? 'Citation updated' : 'Saved', { action: { label: 'Open bibliography', onClick: () => openManager(projectId, stored.id) } });
  checkDuplicate();
}
$('save').addEventListener('click', save);

// ---------- copy ----------
function opts() { return { sentenceCase: settings.sentenceCase }; }

$('copy').addEventListener('click', async () => {
  const c = formatCitation(current, settings.style, opts());
  const ok = await copyRich(c.html, c.text);
  toast(ok ? 'Citation copied with formatting' : 'Copy failed', { tone: ok ? 'info' : 'error' });
});
$('copy-intext').addEventListener('click', async () => {
  const t = formatInText(current, settings.style, opts());
  const ok = await copyRich(t.html, t.text);
  toast(ok ? 'In-text citation copied' : 'Copy failed', { tone: ok ? 'info' : 'error' });
});

const moreBtn = $('more-btn');
const menu = $('more-menu');
function toggleMenu(open) {
  menu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('button').focus();
}
moreBtn.addEventListener('click', () => toggleMenu(menu.hidden));
menu.addEventListener('keydown', e => {
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { e.preventDefault(); toggleMenu(false); moreBtn.focus(); }
});
document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.more')) toggleMenu(false); });
menu.addEventListener('click', async e => {
  const kind = e.target.closest('button')?.dataset.copy;
  if (!kind) return;
  toggleMenu(false);
  const cur = cleanItem(current);
  let ok = true;
  if (kind === 'plain') ok = await copyText(formatCitation(cur, settings.style, opts()).text);
  else if (kind === 'note') { const n = formatNote(cur, 'chicago-nb'); ok = await copyRich(n.html, n.text); }
  else if (kind === 'bibtex') ok = await copyText(toBibtex([cur]));
  else if (kind === 'ris') ok = await copyText(toRis([cur]));
  else if (kind === 'reextract') { savedId = null; $('save').textContent = 'Save'; await extractFromActiveTab(); return; }
  toast(ok ? 'Copied' : 'Copy failed', { tone: ok ? 'info' : 'error' });
});

// ---------- online lookup (optional) ----------
async function updateLookupBar() {
  const bar = $('lookup-bar');
  const id = identifierOf(current);
  if (!settings.onlineLookup || !id) { bar.hidden = true; return; }
  bar.hidden = false;
  $('lookup-text').textContent = `${id.kind.toUpperCase()} ${id.value}`;
}

function identifierOf(item) {
  if (item.doi && !/^10\.48550\//i.test(item.doi)) return { kind: 'doi', value: item.doi };
  if (item.number && /^arXiv:/i.test(item.number)) return { kind: 'arxiv', value: item.number.replace(/^arXiv:/i, '') };
  if (item.isbn) return { kind: 'isbn', value: item.isbn };
  if (item.doi) return { kind: 'doi', value: item.doi };
  return null;
}

$('lookup-btn').addEventListener('click', async () => {
  const id = identifierOf(current);
  if (!id) return;
  if (!(await hasLookupPermission())) {
    toast('Online lookup permission was removed. Re-enable it in Options.', { tone: 'error' });
    return;
  }
  const btn = $('lookup-btn');
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  try {
    const found = await lookupIdentifier(id);
    current = mergeLookup(current, found);
    editor.setItem(current);
    renderPreview();
    status('Filled from the online record. Review the fields before saving.', 'ok');
  } catch (err) {
    toast(err.message || 'Lookup failed', { tone: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fill from online record';
  }
});

// ---------- navigation ----------
function openManager(projectId, itemId) {
  const q = new URLSearchParams();
  if (projectId) q.set('project', projectId);
  if (itemId) q.set('item', itemId);
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') + (q.toString() ? '?' + q : '') });
}
$('open-manager').addEventListener('click', () => openManager($('project').value !== '__new__' ? $('project').value : ''));
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
});

// ---------- extraction ----------
function load(item, msg, tone) {
  current = item;
  editor.setItem(item);
  renderPreview();
  updateLookupBar();
  checkDuplicate();
  status(msg, tone);
}

async function extractFromActiveTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { tab = null; }
  const url = tab?.url || '';
  if (!tab || !/^(https?|file):/i.test(url)) {
    load(blankItem({ accessed: todayISO(), title: '' }), 'This page can’t be read. Fill in the fields to build a citation by hand.', 'warn');
    return;
  }
  status('Reading page…');
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageData });
    const raw = res?.result;
    if (!raw) throw new Error('No data');
    const sel = detectIdentifier(raw.selection || '');
    const { item, sources } = normalizePage(raw);
    if (sel && sel.kind === 'doi' && !item.doi) item.doi = sel.value;
    load(item, sources.length ? `Found: ${sources.join(', ')}. Check the fields below.` : 'Little metadata found. Check the fields below.', sources.length ? '' : 'warn');
  } catch {
    // Restricted pages (Web Store, PDFs in the built-in viewer, other extensions) cannot be scripted.
    const item = blankItem({ type: 'webpage', title: tab.title || '', url, accessed: todayISO() });
    const id = detectIdentifier(url);
    if (id) Object.assign(item, itemFromIdentifier(id), { title: tab.title || '', url });
    if (/\.pdf($|[?#])/i.test(url)) item.type = id ? item.type : 'report';
    load(cleanItem(item), 'Couldn’t read this page’s metadata, so only the title and URL were filled in.', 'warn');
  }
}

async function init() {
  settings = await getSettings();
  applyTheme(settings.theme);
  fillStyles();
  await fillProjects();
  const pending = await takePending();
  if (pending && pending.item) {
    load(pending.item, pending.message || (pending.sources?.length ? `Found: ${pending.sources.join(', ')}.` : 'Check the fields below.'), pending.tone || '');
  } else {
    await extractFromActiveTab();
  }
}

init();
