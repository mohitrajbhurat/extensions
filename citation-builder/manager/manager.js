import { createEditor } from '../shared/editor.js';
import {
  STYLES, formatBibliography, formatCitation, formatInText, formatNote,
} from '../lib/formatters.js';
import { toBibtex, toRis, toPlainText, toHtmlDocument } from '../lib/export.js';
import { TYPE_LABELS, blankItem, cleanItem, findDuplicates, duplicateReason } from '../lib/model.js';
import { detectIdentifier } from '../lib/identifiers.js';
import { itemFromIdentifier } from '../lib/normalize.js';
import { todayISO } from '../lib/text.js';
import { fullName } from '../lib/names.js';
import {
  getSettings, setSettings, ensureDefaultProject, getProjects, getItems, createProject, updateProject, deleteProject,
  restoreProject, saveItem, deleteItems, restoreItems, moveItems, copyItems,
} from '../lib/storage.js';
import { hasLookupPermission, lookupIdentifier, mergeLookup } from '../lib/lookup.js';
import { h, copyRich, copyText, download, safeFilename, toast, debounce, applyTheme } from '../lib/dom.js';

const $ = id => document.getElementById(id);
const ALL = '__all__';

const ICON = {
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  quote: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 9.5C3 6.5 4.5 4.8 6.5 4.3M3 9.5h3v3H3zM9 9.5c0-3 1.5-4.7 3.5-5.2M9 9.5h3v3H9z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.8l2.7 2.7L6 12.7 2.8 13.2l.5-3.2z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
};

const state = {
  settings: null,
  projects: [],
  items: [],
  project: ALL,
  query: '',
  dupOnly: false,
  selected: new Set(),
  visible: [],
  entries: new Map(),
  editingId: null,
};

// ---------------------------------------------------------------- data

async function reload() {
  state.projects = await ensureDefaultProject();
  state.projects = await getProjects();
  state.items = await getItems();
  if (state.project !== ALL && !state.projects.some(p => p.id === state.project)) state.project = state.projects[0]?.id || ALL;
  const ids = new Set(state.items.map(i => i.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  render();
}
const reloadSoon = debounce(reload, 120);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.items || changes.projects)) reloadSoon();
  if (changes.settings) getSettings().then(s => { state.settings = s; applyTheme(s.theme); syncControls(); render(); });
});

function projectItems() {
  return state.project === ALL ? state.items : state.items.filter(i => i.projectId === state.project);
}

function projectName(id) {
  if (id === ALL) return 'All citations';
  return state.projects.find(p => p.id === id)?.name || 'Untitled project';
}

function matches(item, q) {
  if (!q) return true;
  const hay = [item.title, item.container, item.publisher, item.doi, item.isbn, item.url, item.date,
    ...(item.authors || []).map(fullName), ...(item.editors || []).map(fullName)].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function fmtOpts() {
  return { sentenceCase: state.settings.sentenceCase, sort: state.settings.managerSort || 'auto' };
}

// ---------------------------------------------------------------- render

function render() {
  renderSidebar();
  const all = projectItems();
  const dups = findDuplicates(all);
  const filtered = all.filter(i => matches(i, state.query) && (!state.dupOnly || dups.has(i.id)));
  const style = state.settings.style;
  const bib = formatBibliography(filtered, style, fmtOpts());
  const byId = new Map(filtered.map(i => [i.id, i]));
  state.visible = bib.entries.map(en => byId.get(en.id));
  state.entries = new Map(bib.entries.map(en => [en.id, en]));

  $('project-title').textContent = projectName(state.project);
  document.title = `${projectName(state.project)} · Citation Builder`;
  $('project-count').textContent = `${all.length} citation${all.length === 1 ? '' : 's'}` + (filtered.length !== all.length ? ` · ${filtered.length} shown` : '');
  const dupCount = dups.size;
  const df = $('dup-filter');
  df.hidden = dupCount === 0 && !state.dupOnly;
  df.textContent = state.dupOnly ? 'Showing possible duplicates · show all' : `${dupCount} possible duplicate${dupCount === 1 ? '' : 's'}`;
  df.setAttribute('aria-pressed', String(state.dupOnly));
  $('project-more').disabled = state.project === ALL;

  const list = $('entries');
  list.replaceChildren(...bib.entries.map(en => entryEl(byId.get(en.id), en, dups.get(en.id), style)));
  const empty = all.length === 0 || filtered.length === 0;
  $('empty').hidden = !empty;
  if (all.length === 0) {
    $('empty-title').textContent = 'No citations yet';
    $('empty-text').innerHTML = 'Open any article, book page or video and click the Citation Builder button, or right-click and choose <b>Cite this page</b>.';
    $('empty-add').hidden = false;
  } else if (filtered.length === 0) {
    $('empty-title').textContent = 'No matches';
    $('empty-text').textContent = 'No citations match your search.';
    $('empty-add').hidden = true;
  }
  renderBulk();
}

function renderSidebar() {
  const counts = new Map();
  for (const i of state.items) counts.set(i.projectId, (counts.get(i.projectId) || 0) + 1);
  const btn = (id, name, n) => h('li', null, h('button', {
    type: 'button', 'aria-current': String(state.project === id), dataset: { project: id }, title: name,
    onclick: () => selectProject(id),
  }, h('span.name', null, name), h('span.n', null, String(n))));
  $('project-list').replaceChildren(
    btn(ALL, 'All citations', state.items.length),
    h('li.divider', { role: 'separator' }),
    ...state.projects.map(p => btn(p.id, p.name, counts.get(p.id) || 0)),
  );
}

function entryEl(item, en, dupList, style) {
  const li = h('li.entry', { dataset: { id: item.id }, class: 'entry' + (state.selected.has(item.id) ? ' selected' : '') });
  const check = h('input.entry-check', { type: 'checkbox', checked: state.selected.has(item.id), 'aria-label': `Select “${item.title || 'Untitled'}”`, dataset: { act: 'select' } });
  const cite = h('div.citation', { class: 'citation' + (style === 'ieee' ? '' : ' hanging'), html: en.html });
  const meta = h('div.entry-meta', null,
    h('span.badge', null, TYPE_LABELS[item.type] || item.type),
    state.project === ALL ? h('span.badge', null, projectName(item.projectId)) : null,
    dupList ? h('button.badge.warn.as-btn', {
      type: 'button', dataset: { act: 'show-dup', target: dupList[0].id }, title: 'Show the other copy',
    }, `Possible duplicate (${dupList[0].reason})`) : null,
    h('span', null, style === 'chicago-nb' ? 'Short note: ' : 'In-text: ', h('span.intext', { html: en.inText.html })),
  );
  const actBtn = (act, icon, label) => h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, dataset: { act }, html: ICON[icon] });
  const menuId = `menu-${item.id}`;
  const actions = h('div.entry-actions', null,
    actBtn('copy', 'copy', 'Copy citation'),
    actBtn('copy-intext', 'quote', style === 'chicago-nb' ? 'Copy short note' : 'Copy in-text citation'),
    actBtn('edit', 'edit', 'Edit'),
    h('div.dropdown', null,
      h('button.icon-btn', { type: 'button', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, dataset: { menu: menuId }, html: ICON.more }),
      h('div.menu', { id: menuId, role: 'menu', hidden: true },
        h('button', { role: 'menuitem', type: 'button', dataset: { act: 'note' } }, 'Copy footnote (Chicago)'),
        h('button', { role: 'menuitem', type: 'button', dataset: { act: 'bibtex' } }, 'Copy BibTeX'),
        h('button', { role: 'menuitem', type: 'button', dataset: { act: 'ris' } }, 'Copy RIS'),
        h('button', { role: 'menuitem', type: 'button', dataset: { act: 'duplicate' } }, 'Duplicate'),
        item.url ? h('button', { role: 'menuitem', type: 'button', dataset: { act: 'open' } }, 'Open source') : null,
        h('button.danger', { role: 'menuitem', type: 'button', dataset: { act: 'delete' } }, 'Delete'),
      ),
    ),
  );
  li.append(check, h('div', null, cite, meta), actions);
  return li;
}

function renderBulk() {
  const n = state.selected.size;
  $('bulk-bar').hidden = n === 0;
  $('bulk-count').textContent = `${n} selected`;
  const visIds = state.visible.map(i => i.id);
  const allSel = visIds.length > 0 && visIds.every(id => state.selected.has(id));
  $('select-all').checked = allSel;
  $('select-all').indeterminate = !allSel && visIds.some(id => state.selected.has(id));
  const mv = $('bulk-move');
  mv.replaceChildren(
    new Option('Move / copy to…', ''),
    ...state.projects.flatMap(p => [new Option(`Move to ${p.name}`, 'move:' + p.id), new Option(`Copy to ${p.name}`, 'copy:' + p.id)]),
  );
}

function syncControls() {
  $('style').value = state.settings.style;
  $('sort').value = state.settings.managerSort || 'auto';
}

function selectProject(id) {
  state.project = id;
  state.selected.clear();
  state.dupOnly = false;
  render();
  const u = new URL(location.href);
  u.searchParams.set('project', id);
  u.searchParams.delete('item');
  history.replaceState(null, '', u);
}

// ---------------------------------------------------------------- entry actions

function itemById(id) { return state.items.find(i => i.id === id); }

$('entries').addEventListener('click', async e => {
  const li = e.target.closest('.entry');
  if (!li) return;
  const id = li.dataset.id;
  const item = itemById(id);
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) { toggleMenu(menuBtn); return; }
  const actEl = e.target.closest('[data-act]');
  if (!actEl || !item) return;
  const act = actEl.dataset.act;
  closeMenus();
  const style = state.settings.style;
  const en = state.entries.get(id);
  switch (act) {
    case 'select':
      if (actEl.checked) state.selected.add(id); else state.selected.delete(id);
      li.classList.toggle('selected', actEl.checked);
      renderBulk();
      return;
    case 'copy': {
      const c = en || formatCitation(item, style, { sentenceCase: state.settings.sentenceCase });
      notifyCopy(await copyRich(c.html, c.text), 'Citation copied');
      return;
    }
    case 'copy-intext': {
      const t = en ? en.inText : formatInText(item, style, { sentenceCase: state.settings.sentenceCase });
      notifyCopy(await copyRich(t.html, t.text), style === 'chicago-nb' ? 'Short note copied' : 'In-text citation copied');
      return;
    }
    case 'note': { const n = formatNote(item, 'chicago-nb'); notifyCopy(await copyRich(n.html, n.text), 'Footnote copied'); return; }
    case 'bibtex': notifyCopy(await copyText(toBibtex([item])), 'BibTeX copied'); return;
    case 'ris': notifyCopy(await copyText(toRis([item])), 'RIS copied'); return;
    case 'edit': openEditor(item); return;
    case 'open': chrome.tabs.create({ url: item.url }); return;
    case 'duplicate': {
      const [copy] = await copyItems([id], item.projectId);
      toast('Duplicated');
      await reload();
      openEditor(copy);
      return;
    }
    case 'delete': await removeItems([id]); return;
    case 'show-dup': flashEntry(actEl.dataset.target); return;
  }
});

function notifyCopy(ok, msg) {
  toast(ok ? msg : 'Copy failed', { tone: ok ? 'info' : 'error' });
}

async function removeItems(ids) {
  const removed = await deleteItems(ids);
  ids.forEach(id => state.selected.delete(id));
  await reload();
  toast(`Deleted ${removed.length} citation${removed.length === 1 ? '' : 's'}`, {
    action: { label: 'Undo', onClick: async () => { await restoreItems(removed); await reload(); } },
  });
}

function flashEntry(id) {
  const el = document.querySelector(`.entry[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------------------------------------------------------------- menus

function toggleMenu(btn) {
  const menu = document.getElementById(btn.getAttribute('aria-controls'));
  const open = menu.hidden;
  closeMenus();
  if (open) {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
  }
}

function closeMenus() {
  document.querySelectorAll('.menu').forEach(m => { m.hidden = true; });
  document.querySelectorAll('[aria-haspopup="menu"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown')) closeMenus();
});
document.addEventListener('keydown', e => {
  const menu = e.target.closest?.('.menu');
  if (menu) {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      const btn = document.querySelector(`[aria-controls="${menu.id}"]`);
      closeMenus();
      btn?.focus();
    }
  }
});

$('export-btn').addEventListener('click', e => toggleMenu(e.currentTarget));
$('project-more').addEventListener('click', e => toggleMenu(e.currentTarget));

// ---------------------------------------------------------------- export / copy all

function exportSet() {
  if (state.selected.size) return state.visible.filter(i => state.selected.has(i.id));
  return state.visible;
}

$('export-menu').addEventListener('click', e => {
  const kind = e.target.closest('[data-export]')?.dataset.export;
  if (!kind) return;
  closeMenus();
  const items = exportSet();
  if (!items.length) { toast('Nothing to export', { tone: 'error' }); return; }
  const name = safeFilename(projectName(state.project));
  const style = state.settings.style;
  const opts = fmtOpts();
  switch (kind) {
    case 'bib': download(`${name}.bib`, toBibtex(items), 'application/x-bibtex'); break;
    case 'ris': download(`${name}.ris`, toRis(items), 'application/x-research-info-systems'); break;
    case 'txt': download(`${name}.txt`, toPlainText(items, style, { ...opts, heading: true }), 'text/plain'); break;
    case 'html': download(`${name}.html`, toHtmlDocument(items, style, { ...opts, title: projectName(state.project) }), 'text/html'); break;
  }
  toast(`Exported ${items.length} citation${items.length === 1 ? '' : 's'}`);
});

$('copy-all').addEventListener('click', async () => {
  const items = exportSet();
  if (!items.length) { toast('Nothing to copy', { tone: 'error' }); return; }
  const bib = formatBibliography(items, state.settings.style, fmtOpts());
  notifyCopy(await copyRich(bib.html, bib.text), `Copied ${items.length} formatted citation${items.length === 1 ? '' : 's'}`);
});

// ---------------------------------------------------------------- bulk

$('select-all').addEventListener('change', e => {
  for (const i of state.visible) { if (e.target.checked) state.selected.add(i.id); else state.selected.delete(i.id); }
  render();
});
$('bulk-clear').addEventListener('click', () => { state.selected.clear(); render(); });
$('bulk-delete').addEventListener('click', () => removeItems([...state.selected]));
$('bulk-copy').addEventListener('click', () => $('copy-all').click());
$('bulk-move').addEventListener('change', async e => {
  const v = e.target.value;
  if (!v) return;
  const [op, pid] = v.split(':');
  const ids = [...state.selected];
  if (op === 'move') await moveItems(ids, pid); else await copyItems(ids, pid);
  toast(`${op === 'move' ? 'Moved' : 'Copied'} ${ids.length} to “${projectName(pid)}”`);
  state.selected.clear();
  await reload();
});

// ---------------------------------------------------------------- projects

async function promptText(title, text, value = '', okLabel = 'OK', withInput = true) {
  const dlg = $('prompt-dialog');
  $('prompt-title').textContent = title;
  $('prompt-text').textContent = text || '';
  $('prompt-text').hidden = !text;
  $('prompt-input').hidden = !withInput;
  $('prompt-input').value = value;
  $('prompt-ok').textContent = okLabel;
  $('prompt-ok').classList.toggle('btn-danger', !withInput);
  dlg.returnValue = '';
  dlg.showModal();
  if (withInput) { $('prompt-input').focus(); $('prompt-input').select(); } else $('prompt-ok').focus();
  return new Promise(resolve => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') resolve(null);
      else resolve(withInput ? $('prompt-input').value.trim() : true);
    }, { once: true });
  });
}

$('new-project').addEventListener('click', async () => {
  const name = await promptText('New project', 'Group citations for a paper, course or thesis.', '', 'Create');
  if (!name) return;
  const p = await createProject(name);
  await reload();
  selectProject(p.id);
  toast(`Created “${p.name}”`);
});

$('project-menu').addEventListener('click', async e => {
  const act = e.target.closest('[data-action]')?.dataset.action;
  if (!act || state.project === ALL) return;
  closeMenus();
  const id = state.project;
  const proj = state.projects.find(p => p.id === id);
  if (act === 'rename') {
    const name = await promptText('Rename project', '', proj.name, 'Rename');
    if (!name) return;
    await updateProject(id, { name });
    await reload();
  } else if (act === 'delete') {
    const n = state.items.filter(i => i.projectId === id).length;
    const ok = await promptText(`Delete “${proj.name}”?`, `This removes the project and its ${n} citation${n === 1 ? '' : 's'}.`, '', 'Delete', false);
    if (!ok) return;
    const removed = await deleteProject(id);
    state.project = ALL;
    await reload();
    toast(`Deleted “${proj.name}”`, { action: { label: 'Undo', onClick: async () => { await restoreProject(proj, removed); await reload(); selectProject(proj.id); } } });
  }
});

// ---------------------------------------------------------------- editor dialog

let editItem = blankItem();
const editor = createEditor($('edit-editor'), {
  idPrefix: 'me',
  onChange: item => { editItem = item; renderEditPreview(); },
});

function renderEditPreview() {
  const style = state.settings.style;
  const c = formatCitation(editItem, style, { sentenceCase: state.settings.sentenceCase });
  $('edit-preview').innerHTML = c.html;
  $('edit-preview').classList.toggle('hanging', style !== 'ieee');
  const pid = $('edit-project').value;
  const cur = cleanItem(editItem);
  const dup = state.items.find(i => i.projectId === pid && i.id !== state.editingId && duplicateReason(i, cur));
  const badge = $('edit-dup');
  badge.hidden = !dup;
  if (dup) badge.textContent = `Possible duplicate in this project (${duplicateReason(dup, cur)})`;
}

function openEditor(item) {
  const isNew = !item;
  state.editingId = item ? item.id : null;
  editItem = item ? { ...item } : blankItem({ accessed: todayISO() });
  $('edit-title').textContent = isNew ? 'Add citation' : 'Edit citation';
  $('quick-add').hidden = !isNew;
  $('quick-id').value = '';
  $('quick-help').textContent = state.settings.onlineLookup
    ? 'Online lookup is on: metadata is fetched from Crossref, Open Library or arXiv.'
    : 'Offline mode: the identifier is filled in and you complete the rest. Turn on online lookup in Options to fetch details.';
  const pid = item?.projectId || (state.project !== ALL ? state.project : (state.settings.lastProjectId || state.projects[0]?.id));
  $('edit-project').replaceChildren(...state.projects.map(p => new Option(p.name, p.id, false, p.id === pid)));
  editor.setItem(editItem);
  renderEditPreview();
  $('edit-save').textContent = isNew ? 'Add to project' : 'Save changes';
  $('edit-dialog').showModal();
  if (isNew) $('quick-id').focus(); else editor.focus();
}

$('edit-project').addEventListener('change', renderEditPreview);

$('edit-save').addEventListener('click', async () => {
  const cur = cleanItem(editItem);
  if (!cur.title && !cur.authors.length && !cur.url && !cur.doi && !cur.isbn) {
    toast('Add at least a title', { tone: 'error' });
    return;
  }
  const pid = $('edit-project').value;
  const stored = await saveItem({ ...cur, id: state.editingId || undefined, projectId: pid });
  $('edit-dialog').close('saved');
  if (state.project !== ALL && state.project !== pid) state.project = pid;
  await reload();
  flashEntry(stored.id);
  toast(state.editingId ? 'Changes saved' : 'Citation added');
});

$('edit-form').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('edit-save').click(); }
});

async function quickFill() {
  const raw = $('quick-id').value.trim();
  const id = detectIdentifier(raw);
  if (!id) { toast('No DOI, ISBN or arXiv ID found', { tone: 'error' }); return; }
  let next = { ...editItem, ...itemFromIdentifier(id), accessed: editItem.accessed || todayISO() };
  if (state.settings.onlineLookup && await hasLookupPermission()) {
    $('quick-go').disabled = true;
    $('quick-go').textContent = 'Looking up…';
    try {
      next = mergeLookup(next, await lookupIdentifier(id));
      toast('Filled from the online record');
    } catch (err) {
      toast(`Lookup failed: ${err.message}`, { tone: 'error' });
    } finally {
      $('quick-go').disabled = false;
      $('quick-go').textContent = 'Fill';
    }
  } else {
    toast(`${id.kind.toUpperCase()} added. Fill in the remaining fields.`);
  }
  editItem = next;
  editor.setItem(editItem);
  renderEditPreview();
}
$('quick-go').addEventListener('click', quickFill);
$('quick-id').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickFill(); } });

$('add').addEventListener('click', () => openEditor(null));
$('empty-add').addEventListener('click', () => openEditor(null));

// ---------------------------------------------------------------- header controls

$('search').addEventListener('input', debounce(e => { state.query = e.target.value.trim(); render(); }, 120));
$('style').addEventListener('change', async e => { state.settings = await setSettings({ style: e.target.value }); render(); });
$('sort').addEventListener('change', async e => { state.settings = await setSettings({ managerSort: e.target.value }); render(); });
$('dup-filter').addEventListener('click', () => { state.dupOnly = !state.dupOnly; render(); });
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (document.querySelector('dialog[open]')) return;
  if (!typing && e.key === '/') { e.preventDefault(); $('search').focus(); }
  else if (!typing && (e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openEditor(null); }
  else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.visible.forEach(i => state.selected.add(i.id));
    render();
  } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) {
    e.preventDefault();
    removeItems([...state.selected]);
  } else if (e.key === 'Escape' && state.selected.size && !e.target.closest?.('.menu')) {
    state.selected.clear();
    render();
  } else if (tag === 'input' && e.target.id === 'search' && e.key === 'Escape') {
    e.target.value = '';
    state.query = '';
    render();
  }
});

// ---------------------------------------------------------------- init

async function init() {
  state.settings = await getSettings();
  applyTheme(state.settings.theme);
  $('style').replaceChildren(...STYLES.map(s => new Option(s.label, s.id)));
  syncControls();
  const params = new URLSearchParams(location.search);
  state.projects = await ensureDefaultProject();
  const wanted = params.get('project');
  state.project = wanted && (wanted === ALL || state.projects.some(p => p.id === wanted)) ? wanted : ALL;
  await reload();
  const focusItem = params.get('item');
  if (focusItem) requestAnimationFrame(() => flashEntry(focusItem));
}

init();
