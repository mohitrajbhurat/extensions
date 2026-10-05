// Sidebar: collections tree (with drag and drop), variables / environments, and history.
import { h, clear, uid, timeAgo, download, safeFilename } from '../lib/util.js';
import { newCollection, newFolder, newRequestItem, newRequest, cloneFresh, kv } from '../lib/model.js';
import { state, touch, findItem, removeItem, insertItem, countRequests, collectionOf } from '../lib/store.js';
import { exportCollection, exportEnvironment } from '../lib/postman.js';
import { kvTable, showMenu, prompt, confirmDialog, toast, selectEl } from './ui.js';

const EXP_KEY = 'aw.expanded';
let expanded;
try { expanded = new Set(JSON.parse(localStorage.getItem(EXP_KEY) || '[]')); } catch { expanded = new Set(); }
const saveExpanded = () => { try { localStorage.setItem(EXP_KEY, JSON.stringify([...expanded])); } catch { /* private mode */ } };

let filter = '';
let histFilter = '';
let editingEnv = null;
let dragId = null;

export function renderSidebar(app) {
  const side = app.ui.side;
  document.querySelectorAll('.side-tab').forEach(b => {
    const on = b.dataset.side === side;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  });
  const body = clear(document.getElementById('sideBody'));
  if (side === 'env') body.append(varsView(app));
  else if (side === 'history') body.append(historyView(app));
  else body.append(collectionsView(app));
}

export function expand(id) { expanded.add(id); saveExpanded(); }

/* ---------------- collections ---------------- */
function collectionsView(app) {
  const box = h('div');
  const search = h('input.side-search', { type: 'search', placeholder: 'Filter requests', value: filter, 'aria-label': 'Filter requests' });
  search.addEventListener('input', () => {
    filter = search.value;
    const pos = search.selectionStart;
    renderSidebar(app);
    const s = document.querySelector('.side-search'); s.focus(); s.setSelectionRange(pos, pos);
  });
  box.append(h('div.side-actions',
    h('button.btn.btn-sm', { type: 'button', on: { click: () => newCollectionFlow(app) } }, '+ Collection'),
    h('button.btn.btn-sm', { type: 'button', on: { click: () => app.openImport() } }, 'Import')), search);
  if (!state.collections.length) {
    box.append(h('div.empty-note', 'No collections yet. Save a request or import a Postman collection.'));
    return box;
  }
  const activeItem = app.activeTab()?.itemId;
  const q = filter.trim().toLowerCase();
  const matches = it => it.type === 'request'
    ? (it.name + ' ' + it.request.url + ' ' + it.request.method).toLowerCase().includes(q)
    : (it.items || []).some(matches);

  const tree = h('ul.tree', { role: 'tree', 'aria-label': 'Collections' });
  const node = (it, depth) => {
    if (q && !matches(it)) return null;
    const li = h('li', { role: 'treeitem', class: it.type === 'collection' ? 'tree-col' : '' });
    const isOpen = q ? true : expanded.has(it.id);
    if (it.type !== 'request') li.setAttribute('aria-expanded', String(isOpen));
    const kebab = h('button.kebab', { type: 'button', 'aria-label': `Actions for ${it.name}`, tabindex: '-1', on: { click: e => { e.stopPropagation(); itemMenu(app, it, kebab); } } }, '⋯');
    const row = h('button.tree-row', {
      type: 'button', class: it.id === activeItem ? 'active' : '', draggable: it.type !== 'collection' ? 'true' : null,
      title: it.type === 'request' ? `${it.request.method} ${it.request.url}` : it.description || it.name,
      dataset: { id: it.id },
      on: {
        click: () => {
          if (it.type === 'request') app.openItem(it.id);
          else { if (expanded.has(it.id)) expanded.delete(it.id); else expanded.add(it.id); saveExpanded(); renderSidebar(app); }
        },
        dblclick: () => { if (it.type === 'request') app.openItem(it.id, { newTab: true }); },
        contextmenu: e => { e.preventDefault(); itemMenu(app, it, null, e.clientX, e.clientY); },
        keydown: e => {
          if (e.key === 'F2') { e.preventDefault(); renameFlow(app, it); }
          else if (e.key === 'Delete') { e.preventDefault(); deleteFlow(app, it); }
          else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && it.type !== 'request') {
            e.preventDefault();
            if (e.key === 'ArrowRight') expanded.add(it.id); else expanded.delete(it.id);
            saveExpanded(); renderSidebar(app); document.querySelector(`.tree-row[data-id="${it.id}"]`)?.focus();
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const rows = [...document.querySelectorAll('.tree-row')];
            rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); itemMenu(app, it, kebab); }
        },
      },
    },
    it.type === 'request' ? h('span.mini', { class: 'm-' + it.request.method }, it.request.method === 'DELETE' ? 'DEL' : it.request.method === 'OPTIONS' ? 'OPT' : it.request.method)
      : h('span.tw', isOpen ? '▾' : '▸'),
    h('span.label', it.name),
    it.type !== 'request' ? h('span.faint', { style: { fontSize: '11px' } }, String(countRequests(it))) : null,
    kebab);
    dnd(app, row, it);
    li.append(row);
    if (it.type !== 'request' && isOpen) {
      const ul = h('ul', { role: 'group' });
      for (const c of it.items) { const n = node(c, depth + 1); if (n) ul.append(n); }
      if (!it.items.length) ul.append(h('li.faint', { style: { fontSize: '12px', padding: '2px 6px' } }, 'Empty'));
      li.append(ul);
    }
    return li;
  };
  for (const c of state.collections) { const n = node(c, 0); if (n) tree.append(n); }
  if (!tree.children.length) tree.append(h('li.empty-note', 'No matching requests.'));
  box.append(tree);
  return box;
}

function dnd(app, row, it) {
  row.addEventListener('dragstart', e => { dragId = it.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.id); row.classList.add('dragging'); });
  row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); document.querySelectorAll('.drop-into').forEach(n => n.classList.remove('drop-into')); });
  row.addEventListener('dragover', e => {
    if (!dragId || dragId === it.id) return;
    const dragged = findItem(dragId)?.item;
    if (dragged && dragged.type === 'folder' && (findItem(it.id, dragged) || dragged.id === it.id)) return; // no folder into itself
    e.preventDefault();
    row.parentElement.classList.add('drop-into');
  });
  row.addEventListener('dragleave', () => row.parentElement.classList.remove('drop-into'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.parentElement.classList.remove('drop-into');
    const id = dragId; dragId = null;
    if (!id || id === it.id) return;
    const moved = removeItem(id);
    if (!moved) return;
    let ok;
    if (it.type === 'request') {
      const f = findItem(it.id);
      ok = !!f; if (ok) f.parent.items.splice(f.parent.items.indexOf(it), 0, moved);
    } else { ok = insertItem(moved, it.id); expanded.add(it.id); saveExpanded(); }
    if (!ok) { toast('Could not move item', 'bad'); return; }
    syncTabsCollection(app);
    touch('collections', 'collections');
  });
}

function syncTabsCollection(app) {
  for (const t of state.tabs) if (t.itemId) t.collectionId = collectionOf(t.itemId)?.id || null;
  app.saveTabsSoon();
}

async function newCollectionFlow(app) {
  const name = await prompt({ title: 'New collection', label: 'Name', value: 'New collection', okLabel: 'Create' });
  if (name == null) return;
  const c = newCollection(name.trim() || 'New collection');
  state.collections.push(c); expand(c.id);
  touch('collections', 'collections');
  app.renderSidebar();
}

async function renameFlow(app, it) {
  const name = await prompt({ title: 'Rename', label: 'Name', value: it.name, okLabel: 'Rename' });
  if (name == null || !name.trim()) return;
  it.name = name.trim();
  for (const t of state.tabs) if (t.itemId === it.id) t.name = it.name;
  touch('collections', 'collections'); app.saveTabsSoon(); app.renderTabs();
}

async function deleteFlow(app, it) {
  const n = it.type === 'request' ? 0 : countRequests(it);
  const ok = await confirmDialog({ title: `Delete ${it.type}`, message: `Delete "${it.name}"${n ? ` and the ${n} request${n > 1 ? 's' : ''} in it` : ''}? This cannot be undone.` });
  if (!ok) return;
  removeItem(it.id);
  for (const t of state.tabs) if (t.itemId && !findItem(t.itemId)) { t.itemId = null; t.collectionId = null; t.dirty = true; }
  touch('collections', 'collections'); app.saveTabsSoon(); app.renderTabs(); app.renderRequest();
}

function itemMenu(app, it, anchor, x, y) {
  const addRequest = () => {
    const item = newRequestItem('New request', newRequest());
    insertItem(item, it.id); expand(it.id);
    touch('collections', 'collections');
    app.openItem(item.id, { newTab: true });
  };
  const addFolder = async () => {
    const name = await prompt({ title: 'New folder', label: 'Name', value: 'New folder', okLabel: 'Create' });
    if (name == null) return;
    insertItem(newFolder(name.trim() || 'New folder'), it.id); expand(it.id);
    touch('collections', 'collections'); app.renderSidebar();
  };
  const duplicate = () => {
    const copy = cloneFresh(it); copy.name = `${it.name} copy`;
    if (it.type === 'collection') state.collections.splice(state.collections.indexOf(it) + 1, 0, copy);
    else { const f = findItem(it.id); f.parent.items.splice(f.parent.items.indexOf(it) + 1, 0, copy); }
    touch('collections', 'collections'); app.renderSidebar();
  };
  const items = [];
  if (it.type === 'request') {
    items.push({ label: 'Open', onClick: () => app.openItem(it.id) }, { label: 'Open in new tab', onClick: () => app.openItem(it.id, { newTab: true }) },
      'sep', { label: 'Rename', key: 'F2', onClick: () => renameFlow(app, it) }, { label: 'Duplicate', onClick: duplicate },
      { label: 'Copy as cURL', onClick: () => app.copyItemAs(it, 'curl') }, { label: 'Copy as fetch()', onClick: () => app.copyItemAs(it, 'fetch') });
  } else {
    items.push({ label: 'New request', onClick: addRequest }, { label: 'New folder', onClick: addFolder }, 'sep',
      { label: it.type === 'collection' ? 'Edit collection, auth and variables…' : 'Edit folder and auth…', onClick: () => app.editContainer(it) },
      { label: 'Rename', key: 'F2', onClick: () => renameFlow(app, it) }, { label: 'Duplicate', onClick: duplicate });
    if (it.type === 'collection') items.push({ label: 'Export (Postman v2.1)', onClick: () => { download(`${safeFilename(it.name)}.postman_collection.json`, JSON.stringify(exportCollection(it), null, 2)); toast('Collection exported'); } });
  }
  items.push('sep', { label: 'Delete', key: 'Del', danger: true, onClick: () => deleteFlow(app, it) });
  showMenu(anchor, items, anchor ? {} : { x, y });
}

/* ---------------- variables ---------------- */
function varsView(app) {
  const box = h('div');
  const changedEnv = structural => { touch('vars', 'environments'); if (structural) app.onVarsChanged(); else app.onVarsChangedSoon(); };
  if (!editingEnv || !state.environments.some(e => e.id === editingEnv)) editingEnv = state.activeEnv || state.environments[0]?.id || null;
  const env = state.environments.find(e => e.id === editingEnv);

  box.append(h('div.sec-title', 'Environment',
    h('button.btn.btn-sm.btn-ghost', { type: 'button', on: { click: newEnvFlow } }, '+ New')));
  if (!state.environments.length) box.append(h('div.empty-note', 'No environments. Create one to switch between base URLs and keys.'));
  else {
    const sel = selectEl(state.environments.map(e => [e.id, e.name + (e.id === state.activeEnv ? ' (active)' : '')]), editingEnv, v => { editingEnv = v; renderSidebar(app); }, { 'aria-label': 'Environment to edit', class: 'grow' });
    const more = h('button.btn.btn-sm.btn-icon', {
      type: 'button', 'aria-label': 'Environment actions', on: {
        click: () => showMenu(more, [
          { label: 'Make active', disabled: env.id === state.activeEnv, onClick: () => { state.activeEnv = env.id; touch('env', 'activeEnv'); app.onVarsChanged(); } },
          { label: 'Rename', onClick: async () => { const n = await prompt({ title: 'Rename environment', label: 'Name', value: env.name }); if (n?.trim()) { env.name = n.trim(); changedEnv(true); } } },
          { label: 'Duplicate', onClick: () => { const c = cloneFresh(env); c.name += ' copy'; state.environments.push(c); editingEnv = c.id; changedEnv(true); } },
          { label: 'Export (Postman)', onClick: () => download(`${safeFilename(env.name)}.postman_environment.json`, JSON.stringify(exportEnvironment(env), null, 2)) },
          'sep',
          { label: 'Delete', danger: true, onClick: async () => {
            if (!await confirmDialog({ title: 'Delete environment', message: `Delete "${env.name}"?` })) return;
            state.environments.splice(state.environments.indexOf(env), 1);
            if (state.activeEnv === env.id) { state.activeEnv = null; touch('env', 'activeEnv'); }
            editingEnv = null; changedEnv(true);
          } },
        ]),
      },
    }, '⋯');
    box.append(h('div.env-row', sel, more));
    box.append(h('div', { style: { marginTop: '6px' } }, kvTable(env.variables, { keyPh: 'Variable', desc: false, secret: true, onChange: changedEnv })));
  }

  box.append(h('div.sec-title', { style: { marginTop: '18px' } }, 'Globals'));
  box.append(kvTable(state.globals, { keyPh: 'Variable', desc: false, secret: true, onChange: s => { touch('vars', 'globals'); if (s) app.onVarsChanged(); else app.onVarsChangedSoon(); } }));
  box.append(h('p.faint', { style: { fontSize: '11.5px', marginTop: '12px' } },
    'Use {{name}} anywhere in a request. Lookup order: environment, then collection variables (edit them from the collection menu), then globals. ',
    'Built-ins: {{$guid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}, {{$randomEmail}}.'));

  async function newEnvFlow() {
    const name = await prompt({ title: 'New environment', label: 'Name', value: 'New environment', okLabel: 'Create' });
    if (name == null) return;
    const e = { id: uid(), name: name.trim() || 'Environment', variables: [kv('baseUrl', '')] };
    state.environments.push(e); editingEnv = e.id;
    if (!state.activeEnv) { state.activeEnv = e.id; touch('env', 'activeEnv'); }
    changedEnv(true);
  }
  return box;
}

/* ---------------- history ---------------- */
function historyView(app) {
  const box = h('div');
  const search = h('input.side-search', { type: 'search', placeholder: 'Filter history', value: histFilter, 'aria-label': 'Filter history' });
  search.addEventListener('input', () => { histFilter = search.value; renderList(); });
  box.append(h('div.side-actions',
    h('span.grow.faint', { style: { fontSize: '12px', alignSelf: 'center' } }, `${state.history.length} of ${state.settings.historyLimit} kept`),
    h('button.btn.btn-sm', {
      type: 'button', disabled: !state.history.length, on: {
        click: async () => {
          if (!await confirmDialog({ title: 'Clear history', message: 'Remove all history entries?', okLabel: 'Clear' })) return;
          state.history.length = 0; touch('history', 'history'); app.renderSidebar();
        },
      },
    }, 'Clear')), search);
  const list = h('div');
  box.append(list);
  function renderList() {
    clear(list);
    const q = histFilter.trim().toLowerCase();
    const items = state.history.filter(e => !q || `${e.method} ${e.url} ${e.resolvedUrl} ${e.status}`.toLowerCase().includes(q));
    if (!items.length) { list.append(h('div.empty-note', state.history.length ? 'No matches.' : 'Requests you send appear here.')); return; }
    let day = '';
    for (const e of items) {
      const d = new Date(e.ts).toDateString();
      if (d !== day) { day = d; list.append(h('div.hist-day', d === new Date().toDateString() ? 'Today' : new Date(e.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))); }
      const st = e.status ? String(e.status) : 'ERR';
      list.append(h('button.hist-item', {
        type: 'button', title: `${e.method} ${e.resolvedUrl || e.url}\n${timeAgo(e.ts)}${e.time ? `, ${Math.round(e.time)} ms` : ''}`,
        on: {
          click: () => app.openHistory(e),
          contextmenu: ev => {
            ev.preventDefault();
            showMenu(null, [
              { label: 'Open in new tab', onClick: () => app.openHistory(e) },
              { label: 'Save to collection…', onClick: () => app.openHistory(e, { save: true }) },
              'sep',
              { label: 'Remove from history', danger: true, onClick: () => { state.history.splice(state.history.indexOf(e), 1); touch('history', 'history'); renderList(); } },
            ], { x: ev.clientX, y: ev.clientY });
          },
        },
      },
      h('span.mini', { class: 'm-' + e.method, style: { fontSize: '9.5px', fontWeight: 700, width: '34px', flex: 'none' } }, e.method === 'DELETE' ? 'DEL' : e.method === 'OPTIONS' ? 'OPT' : e.method),
      h('span.url', e.url),
      h('span.st', { class: !e.status || e.status >= 400 ? 'var-missing' : 'var-ok' }, st)));
    }
  }
  renderList();
  return box;
}
