// Request editor: URL bar and the Params / Headers / Body / Auth / Tests / Vars / Settings panels.
import { h, clear, uid, formatBytes } from '../lib/util.js';
import { METHODS, BODY_MODES, AUTH_TYPES, autoName } from '../lib/model.js';
import { paramsFromUrl, urlFromParams, finalizeUrl } from '../lib/urlparams.js';
import { resolve, findVars, DYNAMIC_NAMES } from '../lib/vars.js';
import { ASSERT_TYPES, OPS, NO_EXPECTED, TARGETED } from '../lib/assert.js';
import { fetchOAuthToken, effectiveAuth, isForbidden } from '../lib/send.js';
import { requestOrigins, hasOrigin, refreshPerms } from '../lib/perms.js';
import { putFile, getFile } from '../lib/idb.js';
import { kvTable, rowsToBulk, bulkToRows, selectEl, codeArea, toast, showMenu } from './ui.js';

const COMMON_HEADERS = ['Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-Match',
  'If-None-Match', 'If-Modified-Since', 'Origin', 'Pragma', 'Referer', 'User-Agent', 'X-Api-Key', 'X-Requested-With', 'X-Request-Id'];

const REQ_TABS = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['auth', 'Auth'], ['tests', 'Tests'], ['extract', 'Vars'], ['settings', 'Settings']];

export function renderRequestPane(app, tab) {
  const pane = clear(document.getElementById('reqPane'));
  const req = tab.request;

  /* ----- URL bar ----- */
  const method = selectEl(METHODS.map(m => [m, m]), req.method, v => {
    req.method = v; method.className = 'method-select m-' + v; app.markDirty(tab); app.renderTabs();
  }, { class: 'method-select m-' + req.method, 'aria-label': 'HTTP method' });
  const url = h('input.url-input', { type: 'text', value: req.url, placeholder: 'https://api.example.com/v1/items?limit=10   ({{variables}} allowed)', 'aria-label': 'Request URL', spellcheck: 'false', id: 'urlInput', autocomplete: 'off' });
  url.addEventListener('input', () => {
    req.url = url.value;
    req.params = paramsFromUrl(url.value, req.params);
    app.markDirty(tab); app.renderTabs(); updateVarLine();
    if (tab.ui.reqTab === 'params') renderPanel(true);
  });
  url.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text') || '';
    if (/^\s*curl\s/i.test(text)) { e.preventDefault(); app.importCurlInto(tab, text); }
  });
  const sendBtn = h('button.btn.btn-primary', { type: 'button', id: 'sendBtn', title: 'Send (Ctrl+Enter)', on: { click: () => app.send() } },
    tab.sending ? [h('span.spinner'), 'Cancel'] : 'Send');
  const more = h('button.btn.send-more', {
    type: 'button', 'aria-label': 'More send options', 'aria-haspopup': 'menu', on: {
      click: () => showMenu(more, [
        { label: 'Copy as cURL', onClick: () => app.copyAs(tab, 'curl') },
        { label: 'Copy as fetch()', onClick: () => app.copyAs(tab, 'fetch') },
        { label: 'Show code…', onClick: () => app.showCode(tab) },
        'sep',
        { label: 'Send and download response', onClick: () => app.send({ download: true }) },
      ]),
    },
  }, '▾');
  const saveBtn = h('button.btn', { type: 'button', title: 'Save (Ctrl+S)', on: { click: () => app.saveTab(tab) } }, 'Save');
  const bar = h('div.urlbar', method, h('div.url-wrap', url), h('div.send-split', sendBtn, more), saveBtn);

  const varLine = h('div.perm-banner.hidden', { id: 'varLine' });
  function updateVarLine() {
    const names = new Set(findVars(req.url));
    for (const r of req.headers) if (r.enabled) findVars(r.key + r.value).forEach(n => names.add(n));
    if (!names.size) { varLine.classList.add('hidden'); return; }
    const scope = app.scopeFor(tab);
    const missing = [...names].filter(n => !scope.has(n) && !DYNAMIC_NAMES.includes(n));
    let resolved = '';
    try { resolved = finalizeUrl(resolve(req.url, scope)).href; } catch { resolved = resolve(req.url, scope); }
    clear(varLine);
    varLine.classList.remove('hidden');
    varLine.style.background = missing.length ? '' : 'var(--bg-sunken)';
    varLine.style.color = missing.length ? '' : 'var(--fg-muted)';
    varLine.append(
      missing.length ? h('span', 'Unresolved: ', missing.map((m, i) => [i ? ', ' : '', h('code', `{{${m}}}`)])) : h('span', 'Resolves to'),
      h('code.grow.mono', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: resolved }, resolved),
    );
  }
  updateVarLine();

  let banner = null;
  if (tab.sending === false && tab.permDenied) {
    banner = h('div.perm-banner', h('span.grow', `No host access to ${tab.permDenied}. The request was sent anyway, but CORS may block it.`),
      h('button.btn.btn-sm', { type: 'button', on: { click: () => app.send() } }, 'Grant and retry'));
  }

  /* ----- editor tabs ----- */
  const etabs = h('div.etabs', { role: 'tablist', 'aria-label': 'Request sections' });
  const panel = h('div.epanel', { role: 'tabpanel' });
  function counts(k) {
    const n = list => list.filter(r => r.enabled !== false && r.key).length;
    if (k === 'params') return n(req.params);
    if (k === 'headers') return n(req.headers);
    if (k === 'tests') return req.tests.filter(t => t.enabled).length;
    if (k === 'extract') return req.extract.filter(t => t.enabled && t.variable).length;
    if (k === 'body') return req.body.mode !== 'none' ? '•' : 0;
    if (k === 'auth') return req.auth.type !== 'inherit' && req.auth.type !== 'none' ? '•' : 0;
    return 0;
  }
  function renderTabsBar() {
    clear(etabs);
    for (const [k, l] of REQ_TABS) {
      const c = counts(k);
      etabs.append(h('button.etab', {
        type: 'button', role: 'tab', class: tab.ui.reqTab === k ? 'active' : '', 'aria-selected': String(tab.ui.reqTab === k),
        dataset: { tab: k }, on: { click: () => { tab.ui.reqTab = k; renderTabsBar(); renderPanel(); app.saveTabsSoon(); } },
      }, l, c ? h('span.count', String(c)) : null));
    }
  }
  etabs.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const keys = REQ_TABS.map(t => t[0]);
    const i = keys.indexOf(tab.ui.reqTab);
    tab.ui.reqTab = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
    renderTabsBar(); renderPanel();
    etabs.querySelector('.etab.active')?.focus();
  });
  const changed = structural => { app.markDirty(tab); if (structural) renderTabsBar(); };

  function renderPanel(fromUrl) {
    clear(panel);
    panel.className = 'epanel';
    const k = tab.ui.reqTab;
    if (k === 'params') panel.append(paramsPanel());
    else if (k === 'headers') panel.append(headersPanel());
    else if (k === 'body') panel.append(bodyPanel());
    else if (k === 'auth') panel.append(authEditor(app, req.auth, { allowInherit: true, onChange: () => changed(true), inherited: inheritedAuthNote(app, tab), tab }));
    else if (k === 'tests') panel.append(testsPanel());
    else if (k === 'extract') panel.append(extractPanel());
    else if (k === 'settings') panel.append(settingsPanel());
    if (fromUrl) renderTabsBar();
  }

  function paramsPanel() {
    return bulkWrap(req.params, 'params', '=', rows => {
      req.params = rows; syncUrl();
    }, () => kvTable(req.params, { keyPh: 'Parameter', onChange: s => { syncUrl(); changed(s); } }), 'Query parameters stay in sync with the URL. Values are sent as typed; {{variables}} are resolved at send time.');
  }
  function syncUrl() {
    req.url = urlFromParams(req.url, req.params);
    url.value = req.url; updateVarLine(); app.renderTabs();
  }

  function headersPanel() {
    const dl = h('datalist#hdrList', COMMON_HEADERS.map(x => h('option', { value: x })));
    const wrap = bulkWrap(req.headers, 'headers', ':', rows => { req.headers = rows; }, () => kvTable(req.headers, { keyPh: 'Header', keyList: 'hdrList', onChange: s => { changed(s); noteForbidden(); } }));
    const note = h('div.note', { style: { marginTop: '8px' } });
    function noteForbidden() {
      const bad = req.headers.filter(r => r.enabled && r.key && isForbidden(r.key)).map(r => r.key);
      note.textContent = bad.length
        ? `Browser-controlled headers (${bad.join(', ')}) are applied with a temporary network rule, which needs host access to the target. Host, Content-Length and Connection are always set by the browser.`
        : 'Content-Type is added from the body type, and Authorization from the Auth tab, unless you set them here.';
    }
    noteForbidden();
    return h('div', dl, wrap, note);
  }

  function bulkWrap(list, key, sep, setRows, table, hint) {
    const box = h('div');
    const bulk = !!tab.ui['bulk_' + key];
    const toggle = h('button.btn.btn-sm.btn-ghost', { type: 'button', on: { click: () => { tab.ui['bulk_' + key] = !bulk; renderPanel(); } } }, bulk ? 'Key-value edit' : 'Bulk edit');
    box.append(h('div.kv-toolbar', hint ? h('span.muted.grow', { style: { fontSize: '12px' } }, hint) : h('span.grow'), toggle));
    if (bulk) {
      const ta = codeArea({ value: rowsToBulk(list, sep), placeholder: `key${sep} value\n//disabled${sep} value`, 'aria-label': 'Bulk edit', style: { minHeight: '180px', resize: 'vertical' } });
      ta.addEventListener('input', () => { setRows(bulkToRows(ta.value, list, sep)); list = key === 'params' ? req.params : req.headers; changed(true); });
      box.append(ta);
    } else box.append(table());
    return box;
  }

  function bodyPanel() {
    const b = req.body;
    const box = h('div.code-wrap');
    const modeSel = selectEl(BODY_MODES, b.mode, v => { b.mode = v; changed(true); renderPanel(); }, { 'aria-label': 'Body type' });
    const tools = h('div.code-tools', modeSel);
    box.append(tools);
    if (b.mode === 'none') {
      box.append(h('p.muted', 'This request has no body.'));
      if (req.method === 'GET' || req.method === 'HEAD') box.append(h('p.faint', `${req.method} requests cannot carry a body in the browser.`));
      return box;
    }
    if (['json', 'text', 'xml'].includes(b.mode)) {
      const ta = codeArea({ value: b[b.mode], 'aria-label': 'Request body', placeholder: b.mode === 'json' ? '{\n  "key": "value"\n}' : '' });
      const status = h('div.code-status');
      const validate = () => {
        if (b.mode !== 'json') { status.textContent = `${ta.value.length} characters`; status.className = 'code-status faint'; return; }
        const text = ta.value.trim();
        if (!text) { status.textContent = ''; ta.classList.remove('invalid'); return; }
        // {{vars}} outside strings are allowed: validate with placeholders substituted.
        const probe = text.replace(/\{\{[^{}]+\}\}/g, '0');
        try { JSON.parse(probe); status.textContent = 'Valid JSON'; status.className = 'code-status var-ok'; ta.classList.remove('invalid'); }
        catch (e) { status.textContent = 'Invalid JSON: ' + e.message; status.className = 'code-status var-missing'; ta.classList.add('invalid'); }
      };
      ta.addEventListener('input', () => { b[b.mode] = ta.value; validate(); changed(false); });
      if (b.mode === 'json') {
        const fmt = (indent) => {
          try { ta.value = JSON.stringify(JSON.parse(ta.value), null, indent); b.json = ta.value; validate(); changed(false); }
          catch (e) { toast('Cannot format: ' + e.message, 'bad'); }
        };
        tools.append(h('button.btn.btn-sm', { type: 'button', on: { click: () => fmt(2) } }, 'Beautify'), h('button.btn.btn-sm', { type: 'button', on: { click: () => fmt(0) } }, 'Minify'));
      }
      tools.append(h('span.grow'), status);
      box.append(ta);
      validate();
      if (req.method === 'GET' || req.method === 'HEAD') box.prepend(h('div.note', { style: { marginBottom: '8px' } }, `${req.method} requests cannot carry a body; switch the method to send it.`));
      return box;
    }
    if (b.mode === 'urlencoded') { box.append(kvTable(b.urlencoded, { keyPh: 'Field', onChange: changed })); return box; }
    if (b.mode === 'formdata') {
      box.append(kvTable(b.formdata, { keyPh: 'Field', files: true, onChange: changed }));
      box.append(h('p.faint', { style: { fontSize: '12px' } }, 'Files are kept in this browser (IndexedDB). The multipart boundary and Content-Type are set automatically.'));
      return box;
    }
    if (b.mode === 'binary') {
      const info = h('span.muted', b.binary?.fileName ? b.binary.fileName : 'No file selected');
      if (b.binary?.fileId) getFile(b.binary.fileId).then(rec => { if (rec) info.textContent = `${rec.name} (${formatBytes(rec.blob.size)}, ${rec.type || 'unknown type'})`; else info.textContent = `${b.binary.fileName || 'File'} is missing; choose it again.`; }).catch(() => {});
      const pick = h('button.btn', {
        type: 'button', on: {
          click: () => {
            const inp = h('input', { type: 'file', style: { display: 'none' } });
            inp.addEventListener('change', async () => {
              const f = inp.files[0]; inp.remove(); if (!f) return;
              const id = b.binary?.fileId || uid();
              try { await putFile(id, f); } catch (e) { toast('Could not store file: ' + e.message, 'bad'); return; }
              b.binary = { fileId: id, fileName: f.name };
              changed(true); renderPanel();
            });
            document.body.append(inp); inp.click();
          },
        },
      }, 'Choose file…');
      box.append(h('div.row', pick, info), h('p.faint', { style: { fontSize: '12px' } }, 'The file is sent as the raw request body. Content-Type defaults to the file type.'));
      return box;
    }
    return box;
  }

  function testsPanel() {
    const box = h('div');
    box.append(h('div.kv-toolbar', h('span.muted.grow', { style: { fontSize: '12px' } }, 'Assertions run after every response. JSON paths look like $.data[0].id, $.items.length or $.items[*].name.'),
      h('button.btn.btn-sm', { type: 'button', on: { click: () => { req.tests.push({ id: uid(), enabled: true, type: 'status', target: '', op: 'eq', expected: '200' }); changed(true); renderPanel(); } } }, '+ Add assertion')));
    if (!req.tests.length) {
      box.append(h('div.empty-note', 'No assertions yet. Try "Status code equals 200" or "JSON path $.id exists".'));
      return box;
    }
    const tbody = h('tbody');
    for (const t of req.tests) {
      const tr = h('tr', { class: t.enabled ? '' : 'off' });
      const chk = h('input', { type: 'checkbox', checked: t.enabled, 'aria-label': 'Enabled' });
      chk.addEventListener('change', () => { t.enabled = chk.checked; tr.classList.toggle('off', !t.enabled); changed(true); });
      const target = h('input', { type: 'text', value: t.target, placeholder: t.type === 'json' ? '$.path' : 'Header name', 'aria-label': 'Target', spellcheck: 'false' });
      target.addEventListener('input', () => { t.target = target.value; changed(false); });
      target.disabled = !TARGETED.has(t.type);
      if (!TARGETED.has(t.type)) target.placeholder = '';
      const exp = h('input', { type: 'text', value: t.expected, placeholder: 'Expected', 'aria-label': 'Expected value', spellcheck: 'false' });
      exp.addEventListener('input', () => { t.expected = exp.value; changed(false); });
      exp.disabled = NO_EXPECTED.has(t.op);
      const type = selectEl(ASSERT_TYPES, t.type, v => { t.type = v; changed(false); renderPanel(); }, { 'aria-label': 'Assertion type' });
      const op = selectEl(OPS, t.op, v => { t.op = v; exp.disabled = NO_EXPECTED.has(v); changed(false); }, { 'aria-label': 'Operator' });
      const del = h('button.kv-del', { type: 'button', 'aria-label': 'Delete assertion', on: { click: () => { req.tests.splice(req.tests.indexOf(t), 1); changed(true); renderPanel(); } } }, '✕');
      tr.append(h('td.col-check', chk), h('td', type), h('td', target), h('td', op), h('td', exp), h('td.col-act', del));
      tbody.append(tr);
    }
    box.append(h('table.kvt', h('colgroup', h('col', { style: { width: '28px' } }), h('col', { style: { width: '19%' } }), h('col'), h('col', { style: { width: '17%' } }), h('col'), h('col', { style: { width: '54px' } })),
      h('thead', h('tr', h('th', ''), h('th', 'Check'), h('th', 'Path / header'), h('th', 'Operator'), h('th', 'Expected'), h('th', ''))), tbody));
    return box;
  }

  function extractPanel() {
    const box = h('div');
    box.append(h('div.kv-toolbar', h('span.muted.grow', { style: { fontSize: '12px' } }, 'Save values from the response into variables, for example a token from $.access_token into {{token}}.'),
      h('button.btn.btn-sm', { type: 'button', on: { click: () => { req.extract.push({ id: uid(), enabled: true, source: 'json', path: '', variable: '', scope: 'env' }); changed(true); renderPanel(); } } }, '+ Add rule')));
    if (!req.extract.length) { box.append(h('div.empty-note', 'No extraction rules.')); return box; }
    const tbody = h('tbody');
    for (const r of req.extract) {
      const chk = h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': 'Enabled' });
      chk.addEventListener('change', () => { r.enabled = chk.checked; changed(true); });
      const src = selectEl([['json', 'JSON path'], ['header', 'Header'], ['status', 'Status code'], ['body', 'Whole body']], r.source, v => { r.source = v; changed(false); renderPanel(); }, { 'aria-label': 'Source' });
      const path = h('input', { type: 'text', value: r.path, placeholder: r.source === 'header' ? 'Header name' : '$.path', disabled: r.source === 'status' || r.source === 'body', 'aria-label': 'Path', spellcheck: 'false' });
      path.addEventListener('input', () => { r.path = path.value; changed(false); });
      const name = h('input', { type: 'text', value: r.variable, placeholder: 'variableName', 'aria-label': 'Variable name', spellcheck: 'false' });
      name.addEventListener('input', () => { r.variable = name.value.replace(/[{}\s]/g, ''); changed(false); });
      const scope = selectEl([['env', 'Environment'], ['global', 'Globals']], r.scope, v => { r.scope = v; changed(false); }, { 'aria-label': 'Scope' });
      const del = h('button.kv-del', { type: 'button', 'aria-label': 'Delete rule', on: { click: () => { req.extract.splice(req.extract.indexOf(r), 1); changed(true); renderPanel(); } } }, '✕');
      tbody.append(h('tr', h('td.col-check', chk), h('td', src), h('td', path), h('td', name), h('td', scope), h('td.col-act', del)));
    }
    box.append(h('table.kvt', h('colgroup', h('col', { style: { width: '28px' } }), h('col', { style: { width: '16%' } }), h('col'), h('col', { style: { width: '22%' } }), h('col', { style: { width: '16%' } }), h('col', { style: { width: '54px' } })),
      h('thead', h('tr', h('th', ''), h('th', 'From'), h('th', 'Path / header'), h('th', 'Variable'), h('th', 'Save to'), h('th', ''))), tbody));
    return box;
  }

  function settingsPanel() {
    const s = req.settings;
    const timeout = h('input', { type: 'number', min: '0', step: '1000', value: s.timeout || '', placeholder: `Default (${app.state.settings.timeout} ms)` });
    timeout.addEventListener('input', () => { s.timeout = Math.max(0, Number(timeout.value) || 0); changed(false); });
    const follow = h('input', { type: 'checkbox', checked: s.followRedirects !== false });
    follow.addEventListener('change', () => { s.followRedirects = follow.checked; changed(false); });
    const name = h('input', { type: 'text', value: tab.name || '', placeholder: autoName(req) });
    name.addEventListener('input', () => { tab.name = name.value.trim() || null; changed(false); app.renderTabs(); });
    const desc = h('textarea', { rows: 4, value: req.description, placeholder: 'Notes about this request' });
    desc.addEventListener('input', () => { req.description = desc.value; changed(false); });
    return h('div.form-grid',
      h('label', { for: 'rsName' }, 'Name'), Object.assign(name, { id: 'rsName' }),
      h('label', { for: 'rsTimeout' }, 'Timeout (ms)'), Object.assign(timeout, { id: 'rsTimeout' }),
      h('label', { for: 'rsFollow' }, 'Follow redirects'), h('div', Object.assign(follow, { id: 'rsFollow' })),
      h('label', { for: 'rsDesc' }, 'Description'), Object.assign(desc, { id: 'rsDesc' }),
      h('p.faint.full', { style: { fontSize: '12px', margin: 0 } }, 'With redirects off, the browser hides the redirect response (status 0, "opaque redirect").'));
  }

  renderTabsBar();
  renderPanel();
  pane.append(...[bar, varLine, banner, etabs, panel].filter(Boolean));
}

function inheritedAuthNote(app, tab) {
  const { auth, owner } = effectiveAuth({ auth: { type: 'inherit' } }, app.ancestorsFor(tab));
  if (!owner) return 'No parent collection or folder sets auth, so no auth is sent.';
  const label = AUTH_TYPES.find(a => a[0] === auth.type)?.[1] || auth.type;
  return `Uses ${label} from ${owner.type === 'collection' ? 'collection' : 'folder'} "${owner.name}".`;
}

/** Auth editor shared by requests, folders and collections. */
export function authEditor(app, auth, { allowInherit = true, onChange, inherited, tab } = {}) {
  const box = h('div');
  const types = AUTH_TYPES.filter(t => allowInherit || t[0] !== 'inherit');
  const grid = h('div.form-grid');
  const typeSel = selectEl(types, auth.type, v => { auth.type = v; onChange(); draw(); }, { id: 'authType' });
  box.append(h('div.form-grid', { style: { marginBottom: '12px' } }, h('label', { for: 'authType' }, 'Type'), typeSel), grid);
  const field = (label, obj, key, attrs = {}) => {
    const id = 'f' + uid().slice(0, 8);
    const inp = h('input', { type: 'text', id, value: obj[key] ?? '', spellcheck: 'false', autocomplete: 'off', ...attrs });
    inp.addEventListener('input', () => { obj[key] = inp.value; onChange(); });
    grid.append(h('label', { for: id }, label), inp);
    return inp;
  };
  const secretField = (label, obj, key) => {
    const inp = field(label, obj, key, { type: 'password' });
    const wrap = h('div.row', { style: { gap: '4px' } });
    inp.replaceWith(wrap);
    wrap.append(inp, h('button.btn.btn-sm', { type: 'button', on: { click: e => { inp.type = inp.type === 'password' ? 'text' : 'password'; e.target.textContent = inp.type === 'password' ? 'Show' : 'Hide'; } } }, 'Show'));
    inp.classList.add('grow');
    return inp;
  };
  function draw() {
    clear(grid);
    switch (auth.type) {
      case 'inherit': grid.append(h('p.muted.full', { style: { margin: 0 } }, inherited || 'Uses the auth of the parent folder or collection.')); break;
      case 'none': grid.append(h('p.muted.full', { style: { margin: 0 } }, 'No Authorization header is added.')); break;
      case 'bearer': secretField('Token', auth.bearer, 'token'); field('Prefix', auth.bearer, 'prefix', { placeholder: 'Bearer' }); break;
      case 'basic': field('Username', auth.basic, 'username'); secretField('Password', auth.basic, 'password'); break;
      case 'apikey': {
        field('Key', auth.apikey, 'key', { placeholder: 'X-API-Key' });
        secretField('Value', auth.apikey, 'value');
        const s = selectEl([['header', 'Header'], ['query', 'Query parameter']], auth.apikey.in, v => { auth.apikey.in = v; onChange(); }, { id: 'akIn' });
        grid.append(h('label', { for: 'akIn' }, 'Add to'), s);
        break;
      }
      case 'oauth2': drawOAuth(); break;
      default: break;
    }
    grid.append(h('p.faint.full', { style: { fontSize: '12px', margin: '4px 0 0' } }, 'All fields accept {{variables}}. Values are stored only in this browser.'));
  }
  function drawOAuth() {
    const o = auth.oauth2;
    field('Token URL', o, 'tokenUrl', { placeholder: 'https://auth.example.com/oauth/token' });
    field('Client ID', o, 'clientId');
    secretField('Client secret', o, 'clientSecret');
    field('Scope', o, 'scope', { placeholder: 'read write' });
    field('Audience', o, 'audience', { placeholder: 'Optional' });
    const ca = selectEl([['header', 'Basic auth header'], ['body', 'In request body']], o.clientAuth, v => { o.clientAuth = v; onChange(); }, { id: 'oaCa' });
    grid.append(h('label', { for: 'oaCa' }, 'Client authentication'), ca);
    field('Header prefix', o, 'headerPrefix', { placeholder: 'Bearer' });
    const auto = h('input', { type: 'checkbox', id: 'oaAuto', checked: o.autoRefresh });
    auto.addEventListener('change', () => { o.autoRefresh = auto.checked; onChange(); });
    grid.append(h('label', { for: 'oaAuto' }, 'Auto-fetch token'), h('label.row', auto, h('span.muted', 'Request a new token before sending when it is missing or expired')));
    const status = h('div.grow.mono', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' } });
    const drawStatus = () => {
      clear(status);
      if (!o.accessToken) { status.append(h('span.muted', 'No token yet')); return; }
      const exp = o.expiresAt ? (o.expiresAt > Date.now() ? `expires ${new Date(o.expiresAt).toLocaleTimeString()}` : 'expired') : 'no expiry';
      status.append(h('span', { class: o.expiresAt && o.expiresAt < Date.now() ? 'var-missing' : 'var-ok' }, `${o.tokenType || 'Bearer'} …${o.accessToken.slice(-10)} (${exp})`));
    };
    const get = h('button.btn.btn-sm.btn-primary', {
      type: 'button', on: {
        click: () => {
          const scope = tab ? app.scopeFor(tab) : app.globalScope();
          const R = s => resolve(s, scope);
          let tokenUrl;
          try { tokenUrl = finalizeUrl(R(o.tokenUrl)).href; } catch { toast('Enter a valid token URL', 'bad'); return; }
          const permP = hasOrigin(tokenUrl) ? Promise.resolve(true) : requestOrigins([tokenUrl]); // inside the click gesture
          (async () => {
            get.disabled = true; get.textContent = 'Requesting…';
            try {
              await permP; await refreshPerms();
              const tok = await fetchOAuthToken(o, R);
              Object.assign(o, tok); onChange(); drawStatus(); toast('Access token received', 'good');
            } catch (e) { toast(e.message, 'bad', 6000); }
            finally { get.disabled = false; get.textContent = 'Get new token'; }
          })();
        },
      },
    }, 'Get new token');
    const clr = h('button.btn.btn-sm', { type: 'button', on: { click: () => { o.accessToken = ''; o.expiresAt = 0; onChange(); drawStatus(); } } }, 'Clear');
    grid.append(h('label', 'Access token'), h('div.row', status, get, clr));
    drawStatus();
  }
  draw();
  return box;
}
