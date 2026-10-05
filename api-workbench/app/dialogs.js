// Modal flows: import, save as, collection / folder editor, code export and settings.
import { h, clear, download, readFileText, copyText } from '../lib/util.js';
import { newCollection, newRequestItem, defaultSettings, kv } from '../lib/model.js';
import { state, touch, insertItem, flush, resetAll } from '../lib/store.js';
import { importPostman } from '../lib/postman.js';
import { parseCurl, toCurl, toFetch } from '../lib/curl.js';
import { requestAllUrls, revokeAll, grantedPatterns, hasAllUrls, refreshPerms } from '../lib/perms.js';
import { openModal, toast, seg, kvTable, confirmDialog, codeArea } from './ui.js';
import { authEditor } from './editor.js';
import { expand } from './sidebar.js';

/* ---------------- import ---------------- */
export function importDialog(app) {
  const ta = codeArea({ placeholder: 'Paste a cURL command, a Postman collection (v2.0 / v2.1), a Postman environment, or an API Workbench backup.', 'aria-label': 'Import text', style: { minHeight: '240px', resize: 'vertical' } });
  const fileName = h('span.muted');
  const fileBtn = h('button.btn', {
    type: 'button', on: {
      click: () => {
        const inp = h('input', { type: 'file', accept: '.json,.txt,.sh,application/json,text/plain', style: { display: 'none' } });
        inp.addEventListener('change', async () => {
          const f = inp.files[0]; inp.remove(); if (!f) return;
          if (f.size > 50 * 1024 * 1024) { toast('File is larger than 50 MB', 'bad'); return; }
          ta.value = await readFileText(f); fileName.textContent = f.name;
        });
        document.body.append(inp); inp.click();
      },
    },
  }, 'Choose file…');
  const drop = h('div', ta);
  drop.addEventListener('dragover', e => e.preventDefault());
  drop.addEventListener('drop', async e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) { ta.value = await readFileText(f); fileName.textContent = f.name; }
  });
  openModal({
    title: 'Import', wide: true,
    body: h('div', h('div.row', { style: { marginBottom: '8px' } }, fileBtn, fileName, h('span.grow'), h('span.faint', { style: { fontSize: '12px' } }, 'You can also drop a file on the text box.')), drop),
    actions: [{ label: 'Cancel' }, {
      label: 'Import', primary: true, onClick: () => {
        try { return importText(app, ta.value); } catch (e) { toast(e.message, 'bad', 6000); return false; }
      },
    }],
  });
}

/** Returns true on success. Throws with a readable message otherwise. */
export function importText(app, text) {
  const t = (text || '').trim();
  if (!t) throw new Error('Nothing to import');
  if (/^curl(\.exe)?\s/i.test(t)) {
    const req = parseCurl(t);
    app.openRequestInNewTab(req);
    toast('cURL command imported into a new tab', 'good');
    return true;
  }
  let data;
  try { data = JSON.parse(t); } catch (e) { throw new Error('Not valid JSON or a cURL command: ' + e.message); }
  if (data && data.app === 'api-workbench' && data.backup) {
    restoreBackup(app, data);
    return true;
  }
  const res = importPostman(data);
  if (res.kind === 'environment') {
    const env = { id: crypto.randomUUID(), ...res.value };
    state.environments.push(env);
    if (!state.activeEnv) state.activeEnv = env.id;
    touch('vars', 'environments', 'activeEnv');
    app.onVarsChanged();
    toast(`Environment "${env.name}" imported with ${env.variables.length} variables`, 'good');
    return true;
  }
  state.collections.push(res.value);
  expand(res.value.id);
  touch('collections', 'collections');
  app.ui.side = 'collections';
  app.renderSidebar();
  const s = res.stats;
  const extra = [s.scripts && `${s.scripts} with scripts (not run here; use Tests instead)`, s.files && `${s.files} with files to re-attach`].filter(Boolean).join(', ');
  toast(`Imported "${res.value.name}": ${s.requests} requests, ${s.folders} folders${extra ? '. ' + extra : ''}`, 'good', 6000);
  return true;
}

function restoreBackup(app, data) {
  let n = 0;
  const ids = new Set(state.collections.map(c => c.id));
  for (const c of data.collections || []) { if (ids.has(c.id)) c.id = crypto.randomUUID(); state.collections.push(c); n++; }
  const envIds = new Set(state.environments.map(e => e.id));
  for (const e of data.environments || []) { if (envIds.has(e.id)) e.id = crypto.randomUUID(); state.environments.push(e); }
  for (const g of data.globals || []) if (!state.globals.some(x => x.key === g.key)) state.globals.push(g);
  touch('collections', 'collections', 'environments', 'globals');
  // reload so every record goes through normalisation
  flush().then(() => location.reload());
  toast(`Restored ${n} collections`, 'good');
}

export function exportBackup() {
  const data = {
    app: 'api-workbench', backup: 1, exportedAt: new Date().toISOString(),
    collections: state.collections, environments: state.environments, globals: state.globals,
  };
  download(`api-workbench-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
}

/* ---------------- save as ---------------- */
export function saveAsDialog(app, tab, { name: initial } = {}) {
  return new Promise(resolve => {
    let done = false;
    const name = h('input', { type: 'text', value: initial || tab.name || app.tabLabel(tab), id: 'saveName' });
    const dest = h('select', { id: 'saveDest' });
    const walk = (items, depth) => {
      for (const it of items) if (it.type === 'folder') { dest.append(h('option', { value: it.id }, '  '.repeat(depth) + '└ ' + it.name)); walk(it.items, depth + 1); }
    };
    for (const c of state.collections) { dest.append(h('option', { value: c.id }, c.name)); walk(c.items, 1); }
    dest.append(h('option', { value: '__new' }, '+ New collection…'));
    if (tab.collectionId && state.collections.some(c => c.id === tab.collectionId)) dest.value = tab.collectionId;
    const newName = h('input', { type: 'text', value: 'My collection', id: 'saveNewCol' });
    const newWrap = h('div.field', { class: dest.value === '__new' ? '' : 'hidden' }, h('label', { for: 'saveNewCol' }, 'New collection name'), newName);
    dest.addEventListener('change', () => newWrap.classList.toggle('hidden', dest.value !== '__new'));
    const doSave = () => {
      let parent = dest.value;
      if (parent === '__new' || !parent) {
        const c = newCollection(newName.value.trim() || 'My collection');
        state.collections.push(c); parent = c.id;
      }
      const item = newRequestItem(name.value.trim() || app.tabLabel(tab), structuredClone(app.plainRequest(tab.request)));
      insertItem(item, parent); expand(parent);
      done = true; resolve(item);
    };
    const form = h('form', { on: { submit: e => { e.preventDefault(); doSave(); m.close(); } } },
      h('div.field', h('label', { for: 'saveName' }, 'Request name'), name),
      h('div.field', h('label', { for: 'saveDest' }, 'Save to'), dest), newWrap);
    const m = openModal({
      title: 'Save request', body: form,
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: doSave }],
      onClose: () => { if (!done) resolve(null); },
    });
    name.select();
  });
}

/* ---------------- collection / folder editor ---------------- */
export function editContainerDialog(app, it) {
  const isCol = it.type === 'collection';
  const draft = structuredClone({ name: it.name, description: it.description || '', auth: it.auth, variables: it.variables || [] });
  const name = h('input', { type: 'text', value: draft.name, id: 'ecName' });
  name.addEventListener('input', () => { draft.name = name.value; });
  const desc = h('textarea', { rows: 3, value: draft.description, id: 'ecDesc' });
  desc.addEventListener('input', () => { draft.description = desc.value; });
  const panel = h('div');
  let which = 'auth';
  const draw = () => {
    clear(panel);
    if (which === 'auth') panel.append(h('p.muted', { style: { fontSize: '12px' } }, `Requests inside this ${it.type} that use "Inherit from parent" get this auth.`), authEditor(app, draft.auth, { allowInherit: !isCol, onChange: () => {}, inherited: 'Uses the auth of the parent folder or collection.' }));
    else panel.append(h('p.muted', { style: { fontSize: '12px' } }, 'Collection variables override globals and are overridden by the active environment.'), kvTable(draft.variables, { keyPh: 'Variable', secret: true, desc: false }));
  };
  draw();
  const body = h('div',
    h('div.field', h('label', { for: 'ecName' }, 'Name'), name),
    h('div.field', h('label', { for: 'ecDesc' }, 'Description'), desc),
    isCol ? h('div', { style: { margin: '12px 0' } }, seg([['auth', 'Authorization'], ['vars', 'Variables']], which, v => { which = v; draw(); }, 'Section')) : h('h3', 'Authorization'),
    panel);
  openModal({
    title: isCol ? 'Edit collection' : 'Edit folder', body, wide: true,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: () => {
        it.name = draft.name.trim() || it.name; it.description = draft.description; it.auth = draft.auth;
        if (isCol) it.variables = draft.variables.filter(v => v.key || v.value);
        touch('collections', 'collections');
        app.renderSidebar(); app.onVarsChanged();
      },
    }],
  });
}

/* ---------------- code ---------------- */
export function codeDialog(prepared, initial = 'curl') {
  const out = codeArea({ readOnly: true, 'aria-label': 'Generated code', style: { minHeight: '260px', resize: 'vertical' } });
  let lang = initial;
  const draw = () => { out.value = lang === 'curl' ? toCurl(prepared) : toFetch(prepared); };
  draw();
  const notes = prepared.warnings.length ? h('div.note', { style: { marginTop: '8px' } }, prepared.warnings.map(w => h('div', w))) : null;
  openModal({
    title: 'Code', wide: true,
    body: h('div', h('div', { style: { marginBottom: '8px', maxWidth: '260px' } }, seg([['curl', 'cURL'], ['fetch', 'JavaScript fetch']], lang, v => { lang = v; draw(); }, 'Language')), out, notes,
      h('p.faint', { style: { fontSize: '12px' } }, 'Variables are resolved with the active environment. Secrets are included as plain text.')),
    actions: [{ label: 'Close' }, { label: 'Copy', primary: true, onClick: async () => { await copyText(out.value); toast('Copied to clipboard'); return false; } }],
  });
}

/* ---------------- settings ---------------- */
export function settingsDialog(app) {
  const s = state.settings;
  const save = () => { touch('settings', 'settings'); app.applyLayout(); };
  const num = (label, key, attrs, help) => {
    const id = 'set_' + key;
    const inp = h('input', { type: 'number', id, value: s[key], ...attrs });
    inp.addEventListener('change', () => { s[key] = Math.max(Number(attrs.min) || 0, Number(inp.value) || 0); inp.value = s[key]; save(); if (key === 'historyLimit' && state.history.length > s.historyLimit) { state.history.length = s.historyLimit; touch('history', 'history'); app.renderSidebar(); } });
    return h('div.field', h('label', { for: id }, label), inp, help ? h('small.faint', help) : null);
  };
  const check = (label, help, get, set) => {
    const inp = h('input', { type: 'checkbox', checked: !!get() });
    inp.addEventListener('change', () => set(inp.checked, inp));
    return h('label.checkline', inp, h('span', label, help ? h('small', help) : null));
  };
  const permsList = h('div.mono', { style: { fontSize: '12px', margin: '6px 0' } });
  const drawPerms = () => {
    const p = grantedPatterns();
    clear(permsList).append(p.length ? p.map(x => h('div', x)) : h('span.muted', 'No sites yet. Access is requested per host the first time you send to it.'));
  };
  drawPerms();
  const onPerm = () => refreshPerms().then(drawPerms);

  const viewerCheck = check('Format raw JSON pages', 'Shows a collapsible, highlighted tree when a tab displays a raw JSON document. It runs on sites the extension has access to; grant all sites for it to work everywhere.',
    () => s.jsonViewer.enabled, (v, inp) => {
      s.jsonViewer.enabled = v; save();
      if (v && !hasAllUrls()) requestAllUrls().then(ok => { onPerm(); if (!ok) toast('JSON pages will only be formatted on sites you granted.', 'warn', 5000); });
      void inp;
    });
  const depth = h('select', { id: 'set_depth' }, [1, 2, 3, 4, 5, 99].map(n => h('option', { value: String(n) }, n === 99 ? 'Everything' : `${n} level${n > 1 ? 's' : ''}`)));
  depth.value = String(s.jsonViewer.expandDepth);
  depth.addEventListener('change', () => { s.jsonViewer.expandDepth = Number(depth.value); save(); });
  const defView = h('select', { id: 'set_view' }, h('option', { value: 'tree' }, 'Tree'), h('option', { value: 'raw' }, 'Pretty text'));
  defView.value = s.jsonViewer.defaultView;
  defView.addEventListener('change', () => { s.jsonViewer.defaultView = defView.value; save(); });
  const layout = h('select', { id: 'set_layout' }, h('option', { value: 'auto' }, 'Automatic (side by side on wide screens)'), h('option', { value: 'stacked' }, 'Request above response'), h('option', { value: 'side' }, 'Side by side'));
  layout.value = s.layout;
  layout.addEventListener('change', () => { s.layout = layout.value; save(); });

  const body = h('div',
    h('h3', 'Requests'),
    num('Default timeout (ms, 0 = none)', 'timeout', { min: '0', step: '1000' }),
    num('History entries to keep', 'historyLimit', { min: '0', max: '1000', step: '10' }),
    check('Follow redirects', 'Default for new requests; each request can override it.', () => s.followRedirects, v => { s.followRedirects = v; save(); }),
    check('Send browser cookies', 'Include cookies the browser holds for the target site (credentials: include).', () => s.sendCookies, v => { s.sendCookies = v; save(); }),
    check('Add Content-Type automatically', 'Set it from the body type unless you add the header yourself.', () => s.autoContentType, v => { s.autoContentType = v; save(); }),
    h('h3', 'Layout'),
    h('div.field', h('label', { for: 'set_layout' }, 'Panes'), layout),
    h('h3', 'JSON'),
    viewerCheck,
    h('div.field', h('label', { for: 'set_depth' }, 'Expand tree to'), depth),
    h('div.field', h('label', { for: 'set_view' }, 'Default response view'), defView),
    h('h3', 'Site access'),
    h('p.muted', { style: { fontSize: '12px' } }, 'Host access lets the workbench read responses from APIs without CORS headers, set browser-controlled headers, and show cookies.'),
    permsList,
    h('div.row.wrap',
      h('button.btn', { type: 'button', on: { click: () => requestAllUrls().then(onPerm) } }, 'Allow all sites'),
      h('button.btn.btn-danger', { type: 'button', on: { click: () => revokeAll().then(onPerm) } }, 'Remove all access')),
    h('h3', 'Data'),
    h('p.muted', { style: { fontSize: '12px' } }, 'Everything stays in this browser profile. Back up collections, environments and globals to a JSON file; restore it with Import.'),
    h('div.row.wrap',
      h('button.btn', { type: 'button', on: { click: exportBackup } }, 'Export backup'),
      h('button.btn', {
        type: 'button', on: {
          click: async () => {
            if (!await confirmDialog({ title: 'Reset settings', message: 'Restore default settings? Collections and history are kept.', okLabel: 'Reset', danger: false })) return;
            state.settings = defaultSettings(); touch('settings', 'settings'); app.applyLayout(); settingsDialog(app);
          },
        },
      }, 'Reset settings'),
      h('button.btn.btn-danger', {
        type: 'button', on: {
          click: async () => {
            if (!await confirmDialog({ title: 'Delete all data', message: 'Delete every collection, environment, variable, tab and history entry? Export a backup first if unsure.', okLabel: 'Delete everything' })) return;
            await resetAll(); location.reload();
          },
        },
      }, 'Delete all data')));
  openModal({ title: 'Settings', body });
  void kv;
}
