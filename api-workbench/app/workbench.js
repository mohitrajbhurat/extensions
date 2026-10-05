// API Workbench: app shell, tabs, sending, keyboard shortcuts.
import { h, clear, uid, debounce, copyText, download, safeFilename, isMac } from '../lib/util.js';
import { autoName, normalizeRequest, newRequest } from '../lib/model.js';
import { state, load, save, touch, flush, newTab as makeTab, findItem, collectionOf, ancestorsOf, pushHistory, setVariable, activeEnvironment } from '../lib/store.js';
import { buildScope, resolve } from '../lib/vars.js';
import { finalizeUrl, paramsFromUrl } from '../lib/urlparams.js';
import { initPerms, hasOrigin, requestOrigins, refreshPerms, onPermsChange } from '../lib/perms.js';
import { prepare, execute, effectiveAuth, oauthExpired, cookiesFor } from '../lib/send.js';
import { evaluate, extract } from '../lib/assert.js';
import { parseCurl, toCurl, toFetch } from '../lib/curl.js';
import { renderRequestPane } from './editor.js';
import { renderResponsePane } from './response.js';
import { renderSidebar } from './sidebar.js';
import { importDialog, saveAsDialog, editContainerDialog, codeDialog, settingsDialog } from './dialogs.js';
import { toast, showMenu, confirmDialog, prompt } from './ui.js';

const app = { state, ui: { side: 'collections' } };
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } } };

/* ---------------- accessors ---------------- */
app.activeTab = () => state.tabs.find(t => t.id === state.activeTab) || state.tabs[0];
app.tabLabel = t => t.name || autoName(t.request);
app.plainRequest = req => normalizeRequest(JSON.parse(JSON.stringify(req)));
app.saveTabsSoon = () => save('tabs', 'activeTab');
app.saveSettings = () => touch('settings', 'settings');

app.ancestorsFor = tab => {
  if (tab.itemId && findItem(tab.itemId)) return ancestorsOf(tab.itemId);
  const col = tab.collectionId && state.collections.find(c => c.id === tab.collectionId);
  return col ? [col] : [];
};
app.collectionFor = tab => (tab.itemId && collectionOf(tab.itemId)) || state.collections.find(c => c.id === tab.collectionId) || null;
app.scopeFor = tab => buildScope(state.globals, app.collectionFor(tab)?.variables, activeEnvironment()?.variables);
app.globalScope = () => buildScope(state.globals, activeEnvironment()?.variables);

/* ---------------- rendering ---------------- */
app.renderSidebar = () => renderSidebar(app);
app.renderRequest = () => renderRequestPane(app, app.activeTab());
app.renderResponse = () => renderResponsePane(app, app.activeTab());

app.renderTabs = () => {
  const strip = clear(document.getElementById('tabstrip'));
  for (const t of state.tabs) {
    const active = t.id === state.activeTab;
    const close = h('button.rtab-close', { type: 'button', 'aria-label': `Close ${app.tabLabel(t)}`, tabindex: '-1', on: { click: e => { e.stopPropagation(); app.closeTab(t.id); } } }, '✕');
    const el = h('div.rtab', {
      role: 'tab', tabindex: active ? '0' : '-1', 'aria-selected': String(active), class: active ? 'active' : '', title: `${t.request.method} ${t.request.url || ''}`.trim(),
      dataset: { id: t.id },
      on: {
        click: () => app.activate(t.id),
        auxclick: e => { if (e.button === 1) { e.preventDefault(); app.closeTab(t.id); } },
        contextmenu: e => { e.preventDefault(); tabMenu(t, null, e.clientX, e.clientY); },
        keydown: e => {
          const i = state.tabs.indexOf(t);
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const n = state.tabs[(i + (e.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) % state.tabs.length];
            app.activate(n.id); document.querySelector(`.rtab[data-id="${n.id}"]`)?.focus();
          } else if (e.key === 'Delete') { e.preventDefault(); app.closeTab(t.id); }
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.activate(t.id); }
        },
      },
    },
    t.sending ? h('span.spinner', { style: { width: '10px', height: '10px' } }) : h('span.rtab-method', { class: 'm-' + t.request.method }, t.request.method),
    h('span.rtab-name', app.tabLabel(t)),
    t.dirty ? h('span.rtab-dot', { title: 'Unsaved changes' }) : null,
    close);
    strip.append(el);
  }
  strip.append(h('button.tab-add', { type: 'button', title: 'New tab (Alt+T)', 'aria-label': 'New tab', on: { click: () => app.newTab() } }, '+'));
  strip.querySelector('.rtab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
};

function tabMenu(t, anchor, x, y) {
  showMenu(anchor, [
    { label: 'Save', key: isMac() ? '⌘S' : 'Ctrl+S', onClick: () => app.saveTab(t) },
    { label: 'Save as…', onClick: () => saveAs(t) },
    { label: 'Rename tab…', onClick: async () => { const n = await prompt({ title: 'Rename', label: 'Name', value: app.tabLabel(t) }); if (n != null) { t.name = n.trim() || null; app.markDirty(t); app.renderTabs(); } } },
    { label: 'Duplicate', onClick: () => app.openRequestInNewTab(app.plainRequest(t.request), t.name ? `${t.name} copy` : null) },
    'sep',
    { label: 'Close', key: 'Alt+W', onClick: () => app.closeTab(t.id) },
    { label: 'Close other tabs', disabled: state.tabs.length < 2, onClick: async () => { for (const o of [...state.tabs]) if (o.id !== t.id) if (!await app.closeTab(o.id)) break; } },
  ], { x, y });
}

function renderEnvSelect() {
  const sel = document.getElementById('envSelect');
  clear(sel);
  sel.append(h('option', { value: '' }, 'No environment'));
  for (const e of state.environments) sel.append(h('option', { value: e.id }, e.name));
  sel.value = state.activeEnv || '';
}

app.renderAll = () => { renderEnvSelect(); app.renderTabs(); app.renderSidebar(); app.renderRequest(); app.renderResponse(); };

app.onVarsChanged = () => { renderEnvSelect(); app.renderSidebar(); refreshVarLine(); };
const refreshVarLine = debounce(() => {
  // Re-render the request pane only when focus is not inside it (keeps the caret where the user types).
  if (!document.getElementById('reqPane').contains(document.activeElement)) app.renderRequest();
}, 250);
app.onVarsChangedSoon = () => { renderEnvSelect(); refreshVarLine(); };

app.applyLayout = () => {
  const panes = document.getElementById('panes');
  const mode = state.settings.layout;
  panes.classList.toggle('side-by-side', mode === 'auto');
  panes.classList.toggle('force-side', mode === 'side');
};

/* ---------------- tabs ---------------- */
app.markDirty = tab => {
  const was = tab.dirty;
  tab.dirty = true;
  app.saveTabsSoon();
  if (!was) app.renderTabs();
  else updateTabLabel(tab);
};
const updateTabLabel = debounce(tab => {
  const el = document.querySelector(`.rtab[data-id="${tab.id}"] .rtab-name`);
  if (el) el.textContent = app.tabLabel(tab);
}, 120);

app.activate = id => {
  if (state.activeTab === id) return;
  state.activeTab = id;
  app.saveTabsSoon();
  app.renderTabs(); app.renderRequest(); app.renderResponse(); app.renderSidebar();
};

app.newTab = (over = {}) => {
  const t = makeTab(over);
  const i = state.tabs.findIndex(x => x.id === state.activeTab);
  state.tabs.splice(i + 1, 0, t);
  state.activeTab = t.id;
  app.saveTabsSoon();
  app.renderTabs(); app.renderRequest(); app.renderResponse(); app.renderSidebar();
  if (!over.request?.url) document.getElementById('urlInput')?.focus();
  return t;
};

app.closeTab = async id => {
  const t = state.tabs.find(x => x.id === id);
  if (!t) return true;
  if (t.dirty && (t.itemId || t.request.url)) {
    app.activate(id);
    const ok = await confirmDialog({ title: 'Unsaved changes', message: `Close "${app.tabLabel(t)}" without saving?`, okLabel: 'Close without saving' });
    if (!ok) return false;
  }
  t.abort?.abort('cancel');
  const i = state.tabs.indexOf(t);
  state.tabs.splice(i, 1);
  if (!state.tabs.length) state.tabs.push(makeTab());
  if (state.activeTab === id) state.activeTab = (state.tabs[i] || state.tabs[i - 1]).id;
  app.saveTabsSoon();
  app.renderTabs(); app.renderRequest(); app.renderResponse(); app.renderSidebar();
  return true;
};

function isPristine(t) { return !t.itemId && !t.dirty && !t.request.url && !t.result && !t.sending; }

app.openItem = (id, { newTab = false } = {}) => {
  const f = findItem(id);
  if (!f || f.item.type !== 'request') return;
  const existing = state.tabs.find(t => t.itemId === id);
  if (existing) { app.activate(existing.id); return; }
  const it = f.item;
  const over = { name: it.name, itemId: it.id, collectionId: collectionOf(it.id)?.id || null, request: app.plainRequest(it.request) };
  const cur = app.activeTab();
  if (!newTab && cur && isPristine(cur)) {
    Object.assign(cur, { ...over, request: normalizeRequest(over.request), dirty: false, result: null });
    app.saveTabsSoon(); app.renderTabs(); app.renderRequest(); app.renderResponse(); app.renderSidebar();
    return;
  }
  app.newTab(over);
};

app.openRequestInNewTab = (req, name = null) => {
  const cur = app.activeTab();
  if (cur && isPristine(cur)) {
    cur.request = normalizeRequest(req); cur.name = name; cur.dirty = true;
    app.saveTabsSoon(); app.renderTabs(); app.renderRequest(); app.renderResponse();
    return cur;
  }
  const t = app.newTab({ request: req, name });
  t.dirty = true; app.renderTabs();
  return t;
};

app.openHistory = async (e, { save: doSave = false } = {}) => {
  const t = app.openRequestInNewTab(app.plainRequest(e.request || newRequest({ method: e.method, url: e.url })), e.name || null);
  if (doSave) await saveAs(t);
};

app.importCurlInto = (tab, text) => {
  try {
    const req = parseCurl(text);
    tab.request = req; app.markDirty(tab);
    app.renderTabs(); app.renderRequest();
    toast('cURL command imported', 'good');
  } catch (e) { toast(e.message, 'bad'); }
};

async function saveAs(tab) {
  const item = await saveAsDialog(app, tab);
  if (!item) return false;
  tab.itemId = item.id; tab.collectionId = collectionOf(item.id)?.id || null; tab.name = item.name; tab.dirty = false;
  touch('collections', 'collections'); app.saveTabsSoon();
  app.renderTabs(); app.renderSidebar(); app.renderRequest();
  toast(`Saved "${item.name}"`, 'good');
  return true;
}

app.saveTab = async (tab = app.activeTab()) => {
  const f = tab.itemId && findItem(tab.itemId);
  if (!f) return saveAs(tab);
  f.item.request = app.plainRequest(tab.request);
  if (tab.name) f.item.name = tab.name;
  tab.dirty = false;
  touch('collections', 'collections'); app.saveTabsSoon();
  app.renderTabs(); app.renderSidebar();
  toast(`Saved "${f.item.name}"`, 'good', 1800);
  return true;
};

app.editContainer = it => editContainerDialog(app, it);
app.openImport = () => importDialog(app);

/* ---------------- code generation ---------------- */
async function preparedFor(tab) {
  return prepare(tab.request, { scope: app.scopeFor(tab), ancestors: app.ancestorsFor(tab), settings: state.settings, loadFiles: false });
}
app.copyAs = async (tab, kind) => {
  try {
    const p = await preparedFor(tab);
    await copyText(kind === 'curl' ? toCurl(p) : toFetch(p));
    toast(`Copied as ${kind === 'curl' ? 'cURL' : 'fetch()'}`, 'good');
  } catch (e) { toast(e.message, 'bad'); }
};
app.copyItemAs = async (item, kind) => {
  const tmp = { request: normalizeRequest(item.request), itemId: item.id };
  return app.copyAs(tmp, kind);
};
app.showCode = async tab => {
  try { codeDialog(await preparedFor(tab)); } catch (e) { toast(e.message, 'bad'); }
};

/* ---------------- sending ---------------- */
app.send = (opts = {}) => {
  const tab = app.activeTab();
  if (tab.sending) { tab.abort?.abort('cancel'); return; }
  const scope = app.scopeFor(tab);
  const ancestors = app.ancestorsFor(tab);
  // Work out which hosts need access *synchronously*: permissions.request() needs the click's user gesture.
  const urls = [];
  try { urls.push(finalizeUrl(resolve(tab.request.url, scope)).href); } catch { /* reported by prepare() */ }
  const { auth } = effectiveAuth(tab.request, ancestors);
  if (auth.type === 'oauth2' && auth.oauth2.autoRefresh && auth.oauth2.tokenUrl && oauthExpired(auth.oauth2)) {
    try { urls.push(finalizeUrl(resolve(auth.oauth2.tokenUrl, scope)).href); } catch { /* reported later */ }
  }
  const need = urls.filter(u => /^https?:/.test(u) && !hasOrigin(u));
  let permP = Promise.resolve(true);
  if (need.length && chrome.permissions?.request) {
    try { permP = requestOrigins(need); } catch { permP = Promise.resolve(false); }
  }
  run(tab, scope, ancestors, permP, need, opts);
};

async function run(tab, scope, ancestors, permP, need, opts) {
  const ac = new AbortController();
  tab.sending = true; tab.abort = ac; tab.permDenied = null; tab.result = null;
  rerender(tab);
  let prepared = null, response, timer = null;
  try {
    const granted = await permP;
    await refreshPerms();
    if (!granted && need.length) tab.permDenied = [...new Set(need.map(u => new URL(u).host))].join(', ');
    if (ac.signal.aborted) throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
    prepared = await prepare(tab.request, {
      scope, ancestors, settings: state.settings,
      onToken: () => { save('tabs', 'collections'); toast('Fetched a new OAuth 2.0 access token'); },
    });
    if (prepared.missing.length) prepared.warnings.unshift(`Unresolved variables were sent as-is: ${prepared.missing.map(m => `{{${m}}}`).join(', ')}`);
    if (prepared.timeout) timer = setTimeout(() => ac.abort('timeout'), prepared.timeout);
    response = await execute(prepared, { signal: ac.signal, credentials: state.settings.sendCookies ? 'include' : 'omit' });
  } catch (e) {
    response = { ok: false, error: e.name === 'AbortError' ? 'Request cancelled' : e.message, hint: '', time: 0, ts: Date.now(), headers: [], size: 0, status: 0, text: '', kind: 'none' };
  } finally { clearTimeout(timer); }

  let tests = [], extracted = [], cookies = null;
  if (response.ok) {
    const ctx = { status: response.status, time: response.time, size: response.size, headers: response.headers, text: response.text, json: response.json, jsonOk: response.jsonOk };
    tests = evaluate(tab.request.tests, ctx);
    extracted = extract(tab.request.extract, ctx);
    for (const x of extracted) if (!x.missing) setVariable(x.variable, x.value, x.scope);
    if (extracted.some(x => !x.missing)) app.onVarsChangedSoon();
    cookies = await cookiesFor(response.finalUrl);
    if (opts.download) {
      let name = 'response';
      try { name = new URL(response.finalUrl).pathname.split('/').filter(Boolean).pop() || name; } catch { /* default */ }
      download(safeFilename(name), new Blob([response.bytes], { type: response.contentType || 'application/octet-stream' }));
    }
  }
  tab.result = { response, prepared, tests, extracted, cookies, warnings: prepared?.warnings || [] };
  tab.sending = false; tab.abort = null;
  if (prepared && !(response.error === 'Request cancelled')) {
    pushHistory({
      id: uid(), ts: Date.now(), method: prepared.method, url: tab.request.url, resolvedUrl: prepared.url, name: tab.name,
      status: response.status || 0, time: response.time, size: response.size || 0, request: app.plainRequest(tab.request),
    });
  }
  rerender(tab);
  if (app.ui.side === 'history') app.renderSidebar();
}

function rerender(tab) {
  app.renderTabs();
  if (tab.id !== state.activeTab) return;
  // Only rebuild the request pane when focus is not inside it (keeps the caret where the user is typing).
  const pane = document.getElementById('reqPane');
  if (!pane.contains(document.activeElement) || document.activeElement?.id === 'sendBtn') {
    const refocus = document.activeElement?.id === 'sendBtn';
    app.renderRequest();
    if (refocus) document.getElementById('sendBtn')?.focus();
  } else {
    const btn = document.getElementById('sendBtn');
    if (btn) { clear(btn); btn.append(...(tab.sending ? [h('span.spinner'), 'Cancel'] : ['Send'])); }
  }
  app.renderResponse();
}

/* ---------------- splitters ---------------- */
function initSplitters() {
  const root = document.documentElement;
  const sw = LS.get('aw.sidebarW', 268), rh = LS.get('aw.reqH', 46);
  root.style.setProperty('--sidebar-w', sw + 'px');
  root.style.setProperty('--req-h', rh + '%');
  const sideBySide = () => getComputedStyle(document.getElementById('panes')).flexDirection === 'row';
  const setSide = w => { w = Math.max(180, Math.min(560, Math.round(w))); root.style.setProperty('--sidebar-w', w + 'px'); LS.set('aw.sidebarW', w); };
  const setReq = p => { p = Math.max(15, Math.min(85, p)); root.style.setProperty('--req-h', p.toFixed(1) + '%'); LS.set('aw.reqH', +p.toFixed(1)); };
  const drag = (el, onMove) => {
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const move = ev => onMove(ev);
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
  };
  const v = document.getElementById('splitV'), hz = document.getElementById('splitH'), panes = document.getElementById('panes');
  drag(v, e => setSide(e.clientX - document.getElementById('sidebar').getBoundingClientRect().left));
  drag(hz, e => {
    const r = panes.getBoundingClientRect();
    setReq(sideBySide() ? (e.clientX - r.left) / r.width * 100 : (e.clientY - r.top) / r.height * 100);
  });
  v.addEventListener('keydown', e => {
    const cur = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-w'), 10) || 268;
    if (e.key === 'ArrowLeft') setSide(cur - 16); else if (e.key === 'ArrowRight') setSide(cur + 16);
  });
  hz.addEventListener('keydown', e => {
    const cur = parseFloat(getComputedStyle(root).getPropertyValue('--req-h')) || 46;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setReq(cur - 3); else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setReq(cur + 3);
  });
}

/* ---------------- keyboard ---------------- */
function initKeys() {
  document.addEventListener('keydown', e => {
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    if (document.getElementById('modal').open) return;
    if (mod && e.key === 'Enter') { e.preventDefault(); app.send(); return; }
    if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); app.saveTab(); return; }
    if (e.altKey && !mod && !e.shiftKey) {
      const k = e.key.toLowerCase(), code = e.code;
      if (code === 'KeyT') { e.preventDefault(); app.newTab(); return; }
      if (code === 'KeyW') { e.preventDefault(); app.closeTab(state.activeTab); return; }
      if (code === 'KeyL') { e.preventDefault(); const u = document.getElementById('urlInput'); u?.focus(); u?.select(); return; }
      if (/^Digit[1-9]$/.test(code)) { e.preventDefault(); const t = state.tabs[Math.min(state.tabs.length, Number(code.slice(5))) - 1]; if (t) app.activate(t.id); return; }
      void k;
    }
    if (e.key === 'Escape' && app.activeTab().sending) { e.preventDefault(); app.activeTab().abort?.abort('cancel'); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (!typing && e.key === '/' && !mod && !e.altKey) {
      const s = document.getElementById('resSearch');
      if (s) { e.preventDefault(); s.focus(); }
    }
  });
}

/* ---------------- deep links & messages ---------------- */
function openFromParams() {
  const p = new URLSearchParams(location.search);
  const url = p.get('url');
  if (!url) return;
  const req = newRequest({ method: (p.get('method') || 'GET').toUpperCase(), url });
  req.params = paramsFromUrl(url, []);
  app.openRequestInNewTab(req);
  history.replaceState(null, '', location.pathname);
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    await load();
    await initPerms();
  } catch (e) {
    const box = document.getElementById('bootError');
    box.hidden = false; box.textContent = 'API Workbench could not start:\n' + (e.stack || e.message);
    return;
  }
  document.getElementById('app').hidden = false;
  document.querySelectorAll('.side-tab').forEach(b => b.addEventListener('click', () => { app.ui.side = b.dataset.side; LS.set('aw.side', app.ui.side); app.renderSidebar(); }));
  document.querySelector('.side-tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const order = ['collections', 'env', 'history'];
    app.ui.side = order[(order.indexOf(app.ui.side) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    app.renderSidebar(); document.querySelector('.side-tab.active')?.focus();
  });
  app.ui.side = LS.get('aw.side', 'collections');
  document.getElementById('envSelect').addEventListener('change', e => { state.activeEnv = e.target.value || null; touch('env', 'activeEnv'); app.onVarsChanged(); app.renderRequest(); });
  document.getElementById('btnImport').addEventListener('click', () => app.openImport());
  document.getElementById('btnSettings').addEventListener('click', () => settingsDialog(app));
  onPermsChange(() => { /* banner state is recomputed on the next send */ });
  initSplitters();
  initKeys();
  app.applyLayout();
  openFromParams();
  app.renderAll();
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === 'aw-open-url' && msg.url) {
      const req = newRequest({ method: 'GET', url: msg.url });
      req.params = paramsFromUrl(msg.url, []);
      app.openRequestInNewTab(req);
      reply({ ok: true });
    } else if (msg?.type === 'aw-ping') reply({ ok: true });
  });
  window.addEventListener('pagehide', () => { flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

boot();
