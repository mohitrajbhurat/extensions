// Health check: dead links, redirects, duplicates and empty folders.
import { S, hooks, metaOf, isProtected, isReadLaterFolder, descendants } from './state.js';
import { toast, plural, fmtDate, confirmDialog, pickFolder } from './ui.js';
import { deleteItems, markBulk } from './ops.js';
import { kvSet } from '../lib/db.js';
import { requestSiteAccess, updateMetaMany, mergeTags } from '../lib/meta.js';
import { normalizeUrl, isHttpUrl, prettyUrl, faviconUrl } from '../lib/url.js';
import { icon, esc } from '../lib/icons.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const scan = { running: false, ctrl: null, done: 0, total: 0, current: '', counts: null, started: 0 };
let filter = 'dead';
let resultSel = new Set();
let scopeChoice = 'all';
let scopeFolder = null;

// ---------- Link probing ----------
async function probe(url, method, timeoutMs, signal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { method, redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctrl.signal });
    if (method === 'GET' && res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
    return { code: res.status, finalUrl: res.url || url, redirected: res.redirected };
  } catch (e) {
    if (signal.aborted) return { error: 'cancelled' };
    if (timedOut) return { error: 'timeout' };
    return { error: 'network', message: e && e.message };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

const RETRY_WITH_GET = new Set([400, 401, 403, 404, 405, 406, 409, 410, 429, 500, 501, 502, 503, 999]);

function isLocalHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(h) || !h.includes('.');
  } catch { return false; }
}

export async function checkUrl(url, { timeout = 15000, signal }) {
  if (!isHttpUrl(url)) return { status: 'skipped', label: 'Not a web link', detail: 'Not an http(s) link' };
  if (isLocalHost(url)) return { status: 'skipped', label: 'Local address', detail: 'Local or intranet address' };
  let r = await probe(url, 'HEAD', timeout, signal);
  if (r.error === 'cancelled') return null;
  if (r.error || RETRY_WITH_GET.has(r.code)) {
    // Many servers mishandle HEAD; confirm with GET (body is not downloaded).
    const g = await probe(url, 'GET', timeout, signal);
    if (g.error === 'cancelled') return null;
    if (!g.error || r.error) r = g;
  }
  if (r.error === 'network') {
    await sleep(1500);
    const again = await probe(url, 'GET', timeout, signal);
    if (again.error === 'cancelled') return null;
    r = again;
  }
  return classify(url, r);
}

function classify(url, r) {
  if (r.error === 'timeout') return { status: 'warn', label: 'Timeout', detail: 'No response before the timeout' };
  if (r.error) return { status: 'dead', label: 'Unreachable', detail: 'Could not connect (site down, DNS error or blocked)' };
  const c = r.code;
  if (c === 404 || c === 410) return { status: 'dead', code: c, label: c === 410 ? 'Gone' : 'Not found', detail: `HTTP ${c} ${c === 410 ? 'Gone' : 'Not Found'}` };
  if (c === 401 || c === 403 || c === 407) return { status: 'warn', code: c, label: 'Restricted', detail: `HTTP ${c}: needs sign-in or blocks automated checks` };
  if (c === 429 || c === 999) return { status: 'warn', code: c, label: 'Rate limited', detail: `HTTP ${c}: the site limited requests; recheck later` };
  if (c >= 500) return { status: 'warn', code: c, label: 'Server error', detail: `HTTP ${c}` };
  if (c >= 400) return { status: 'dead', code: c, label: `HTTP ${c}`, detail: `HTTP ${c}` };
  if (r.redirected && r.finalUrl && r.finalUrl !== url) {
    const a = normalizeUrl(url), b = normalizeUrl(r.finalUrl);
    let schemeUpgrade = false, toHome = false, toLogin = false;
    try {
      const u1 = new URL(url), u2 = new URL(r.finalUrl);
      schemeUpgrade = u1.protocol === 'http:' && u2.protocol === 'https:';
      toHome = u1.pathname.length > 1 && (u2.pathname === '/' || u2.pathname === '') && !u2.search;
      toLogin = /\/(login|signin|sign-in|auth|sso|account\/login|session)\b/i.test(u2.pathname) || /accounts\.google\.com|login\.microsoftonline/.test(u2.hostname);
    } catch { /* ignore */ }
    if (toLogin) return { status: 'warn', code: c, label: 'Login page', detail: 'Redirects to a sign-in page', finalUrl: r.finalUrl };
    if (toHome) return { status: 'warn', code: c, label: 'Moved to home', detail: 'Redirects to the site home page; the page may have been removed', finalUrl: r.finalUrl };
    if (a !== b || schemeUpgrade) return { status: 'redirect', code: c, label: schemeUpgrade && a === b ? 'Moved to HTTPS' : 'Moved', detail: `Redirects to ${prettyUrl(r.finalUrl)}`, finalUrl: r.finalUrl };
  }
  return { status: 'ok', code: c, label: 'OK', detail: `HTTP ${c}` };
}

function countResults(results) {
  const c = { dead: 0, redirect: 0, warn: 0, ok: 0, skipped: 0 };
  for (const [id, r] of Object.entries(results || {})) if (S.nodes.has(id) && c[r.status] !== undefined) c[r.status]++;
  return c;
}

let saveTimer = null;
function persist(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => kvSet('health', S.health).catch(() => {});
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 1500);
}

// Run a scan over bookmark ids. Must be invoked from a click (permission prompt).
export async function checkLinks(ids, { label } = {}) {
  if (scan.running) { toast('A link check is already running.'); return; }
  const targets = ids.map(id => S.nodes.get(id)).filter(n => n && n.url);
  if (!targets.length) { toast('No links to check.'); return; }
  if (targets.some(n => isHttpUrl(n.url)) && !await requestSiteAccess()) {
    toast('Website access is required to check links. Nothing was checked.', { kind: 'warn', timeout: 7000 });
    return;
  }
  const settings = S.settings;
  const timeout = (settings.healthTimeout || 15) * 1000;
  const delay = Math.max(0, settings.healthHostDelay ?? 1000);
  const concurrency = Math.max(1, Math.min(12, settings.healthConcurrency || 4));
  if (!S.health) S.health = { results: {} };
  if (!S.health.results) S.health.results = {};
  S.health.startedAt = Date.now();
  Object.assign(scan, { running: true, ctrl: new AbortController(), done: 0, total: targets.length, current: '', started: Date.now(), label: label || `Checking ${plural(targets.length, 'link')}` });
  refreshHealthView();

  const queue = [...targets];
  const hostLast = new Map();
  const hostBusy = new Set();
  const signal = scan.ctrl.signal;

  const worker = async () => {
    while (!signal.aborted) {
      if (!queue.length) return;
      const now = Date.now();
      const i = queue.findIndex(n => !hostBusy.has(n.host) && now - (hostLast.get(n.host) || 0) >= delay);
      if (i < 0) { await sleep(80); continue; }
      const n = queue.splice(i, 1)[0];
      hostBusy.add(n.host);
      scan.current = n.url;
      let r = null;
      try { r = await checkUrl(n.url, { timeout, signal }); } finally {
        hostBusy.delete(n.host);
        hostLast.set(n.host, Date.now());
      }
      if (!r) return; // cancelled
      S.health.results[n.id] = { ...r, url: n.url, at: Date.now() };
      scan.done++;
      persist();
      updateProgress();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const cancelled = signal.aborted;
  scan.running = false;
  S.health.finishedAt = Date.now();
  await persist(true);
  const c = countResults(Object.fromEntries(targets.map(n => [n.id, S.health.results[n.id]]).filter(([, r]) => r)));
  toast(`${cancelled ? 'Check cancelled' : 'Check complete'}: ${plural(scan.done, 'link')} checked · ${c.dead} broken · ${c.redirect} moved · ${c.warn} warnings`, { timeout: 8000, kind: c.dead ? 'warn' : '' , action: S.view.type !== 'health' ? { label: 'View report', fn: () => { location.hash = '#health'; } } : undefined });
  if (c.dead) filter = 'dead'; else if (c.redirect) filter = 'redirect'; else if (c.warn) filter = 'warn';
  hooks.render();
}

function updateProgress() {
  const el = document.getElementById('scanProgress');
  if (!el) return;
  el.querySelector('.progress > div').style.width = `${Math.round(scan.done / Math.max(1, scan.total) * 100)}%`;
  el.querySelector('[data-p="count"]').textContent = `${scan.done.toLocaleString()} of ${scan.total.toLocaleString()} checked`;
  const elapsed = (Date.now() - scan.started) / 1000;
  const rate = scan.done / Math.max(1, elapsed);
  const left = rate > 0 ? Math.round((scan.total - scan.done) / rate) : 0;
  el.querySelector('[data-p="eta"]').textContent = scan.done > 3 && left > 0 ? `about ${left > 90 ? Math.round(left / 60) + ' min' : left + ' s'} left` : '';
  el.querySelector('[data-p="current"]').textContent = prettyUrl(scan.current);
  const c = countResults(S.health.results);
  for (const k of Object.keys(c)) { const s = document.querySelector(`[data-sum="${k}"] b`); if (s) s.textContent = c[k].toLocaleString(); }
}

function refreshHealthView() {
  if (S.view.type === 'health') hooks.render();
}

// ---------- Rendering ----------
export function renderHealth(container, tab = 'links') {
  const dupGroups = findDuplicates();
  const empties = findEmptyFolders();
  const dupCount = dupGroups.reduce((a, g) => a + g.length - 1, 0);
  const tabs = `<div class="tabs" role="tablist">
    <a class="tab${tab === 'links' ? ' active' : ''}" href="#health" role="tab" aria-selected="${tab === 'links'}">${icon('link')}Links<span class="count">${countResults(S.health && S.health.results).dead || ''}</span></a>
    <a class="tab${tab === 'duplicates' ? ' active' : ''}" href="#health/duplicates" role="tab" aria-selected="${tab === 'duplicates'}">${icon('copy')}Duplicates<span class="count">${dupCount || ''}</span></a>
    <a class="tab${tab === 'empty' ? ' active' : ''}" href="#health/empty" role="tab" aria-selected="${tab === 'empty'}">${icon('folder')}Empty folders<span class="count">${empties.length || ''}</span></a>
  </div>`;
  container.innerHTML = `<div class="page">${tabs}<div id="healthBody"></div></div>`;
  const body = container.querySelector('#healthBody');
  if (tab === 'duplicates') renderDuplicates(body, dupGroups);
  else if (tab === 'empty') renderEmpty(body, empties);
  else renderLinks(body);
}

function renderLinks(body) {
  const results = (S.health && S.health.results) || {};
  const c = countResults(results);
  const checked = Object.values(c).reduce((a, b) => a + b, 0);
  const httpCount = S.bookmarks.filter(n => isHttpUrl(n.url)).length;
  const neverChecked = S.bookmarks.filter(n => !results[n.id]).length;
  const problems = Object.entries(results).filter(([id, r]) => S.nodes.has(id) && r.status !== 'ok' && r.status !== 'skipped').length;
  const folder = scopeFolder && S.nodes.get(scopeFolder);

  body.innerHTML = `
    <section class="card scan-card">
      <div class="scan-intro">
        <div>
          <h2>Find broken and moved links</h2>
          <p class="muted small">Each bookmark is requested directly from your browser (HEAD, then GET if needed), a few at a time and at most one request per site per ${((S.settings.healthHostDelay ?? 1000) / 1000).toFixed(1)} s. Nothing is sent anywhere else. You'll be asked once for website access.</p>
        </div>
      </div>
      ${scan.running ? `
        <div id="scanProgress" class="scan-progress" aria-live="polite">
          <div class="scan-row"><span class="spinner"></span><b data-p="count"></b><span class="muted small" data-p="eta"></span><span class="spacer"></span><button class="btn danger" data-h="cancel">${icon('x')}Cancel</button></div>
          <div class="progress"><div></div></div>
          <div class="faint small mono ellipsis" data-p="current"></div>
        </div>` : `
        <div class="scan-row wrap">
          <label class="field inline"><span class="field-label">Scope</span>
            <select class="select" data-h="scope">
              <option value="all">All bookmarks (${httpCount.toLocaleString()})</option>
              <option value="new">Not checked yet (${neverChecked.toLocaleString()})</option>
              <option value="problems">Recheck problems (${problems.toLocaleString()})</option>
              <option value="folder">${folder ? 'Folder: ' + esc(folder.title) : 'Choose a folder…'}</option>
            </select></label>
          <span class="spacer"></span>
          <button class="btn primary" data-h="start">${icon('pulse')}Start check</button>
        </div>`}
      ${S.health && S.health.finishedAt && !scan.running ? `<div class="faint small">Last check ${fmtDate(S.health.finishedAt)} · ${plural(checked, 'link')} in report</div>` : ''}
    </section>
    <div class="summary">
      ${sumCard('dead', 'Broken', 'linkBroken', c.dead, 'bad')}
      ${sumCard('redirect', 'Moved', 'redirect', c.redirect, 'warn')}
      ${sumCard('warn', 'Warnings', 'info', c.warn, 'muted')}
      ${sumCard('ok', 'OK', 'check', c.ok, 'ok')}
      ${sumCard('skipped', 'Skipped', 'x', c.skipped, 'muted')}
    </div>
    <div id="resultList"></div>`;
  const sel = body.querySelector('[data-h="scope"]');
  if (sel) {
    sel.value = scopeChoice;
    sel.addEventListener('change', async () => {
      if (sel.value === 'folder') {
        const f = await pickFolder({ title: 'Check links in folder', okLabel: 'Choose', initial: scopeFolder });
        if (f) { scopeFolder = f; scopeChoice = 'folder'; } else sel.value = scopeChoice;
        renderLinks(body);
        return;
      }
      scopeChoice = sel.value;
    });
  }
  body.onclick = async e => {
    const b = e.target.closest('[data-h]');
    if (!b) return;
    const act = b.dataset.h;
    if (act === 'start') {
      let ids;
      if (scopeChoice === 'new') ids = S.bookmarks.filter(n => !results[n.id]).map(n => n.id);
      else if (scopeChoice === 'problems') ids = Object.entries(results).filter(([id, r]) => S.nodes.has(id) && r.status !== 'ok' && r.status !== 'skipped').map(([id]) => id);
      else if (scopeChoice === 'folder' && scopeFolder) ids = descendants(scopeFolder).filter(n => n.url).map(n => n.id);
      else ids = S.bookmarks.map(n => n.id);
      checkLinks(ids);
    } else if (act === 'cancel') { scan.ctrl && scan.ctrl.abort(); b.disabled = true; b.textContent = 'Cancelling…'; }
    else if (act === 'filter') { filter = b.dataset.f; resultSel.clear(); renderLinks(body); }
    else if (act === 'select-all') { const ids = currentResultIds(); const all = ids.every(id => resultSel.has(id)); ids.forEach(id => all ? resultSel.delete(id) : resultSel.add(id)); renderResultList(body.querySelector('#resultList')); }
    else if (act === 'delete-sel') { const ids = [...resultSel]; if (ids.length && await deleteItems(ids, { confirmAbove: 5, label: `Deleted ${plural(ids.length, 'bookmark')}` })) resultSel.clear(); }
    else if (act === 'update-sel') await updateRedirects([...resultSel]);
    else if (act === 'recheck-sel') checkLinks([...resultSel]);
    else if (act === 'ignore-sel') { for (const id of resultSel) delete S.health.results[id]; resultSel.clear(); await persist(true); hooks.render(); }
    else if (act === 'row-delete') deleteItems([b.closest('[data-id]').dataset.id]);
    else if (act === 'row-update') updateRedirects([b.closest('[data-id]').dataset.id]);
    else if (act === 'row-recheck') checkLinks([b.closest('[data-id]').dataset.id]);
    else if (act === 'row-open') chrome.tabs.create({ url: S.nodes.get(b.closest('[data-id]').dataset.id).url, active: false });
    else if (act === 'row-wayback') chrome.tabs.create({ url: 'https://web.archive.org/web/*/' + S.nodes.get(b.closest('[data-id]').dataset.id).url });
  };
  body.onchange = e => {
    if (e.target.matches('.res-sel')) {
      const id = e.target.closest('[data-id]').dataset.id;
      if (e.target.checked) resultSel.add(id); else resultSel.delete(id);
      renderResultBar(body.querySelector('#resultList'));
    }
  };
  if (scan.running) updateProgress();
  renderResultList(body.querySelector('#resultList'));
}

function sumCard(key, label, ic, n, cls) {
  return `<button class="sum-card ${cls}${filter === key ? ' active' : ''}" data-h="filter" data-f="${key}" data-sum="${key}" aria-pressed="${filter === key}">
    <span class="sum-ic">${icon(ic)}</span><b>${n.toLocaleString()}</b><span>${label}</span></button>`;
}

function currentResultIds() {
  const results = (S.health && S.health.results) || {};
  return Object.entries(results).filter(([id, r]) => S.nodes.has(id) && r.status === filter).map(([id]) => id);
}

function renderResultList(el) {
  if (!el) return;
  const results = (S.health && S.health.results) || {};
  const ids = currentResultIds();
  if (!ids.length) {
    el.innerHTML = `<div class="empty small-empty">${icon(filter === 'dead' ? 'check' : 'inbox')}<p>${checkedAny() ? `No ${({ dead: 'broken links', redirect: 'moved links', warn: 'warnings', ok: 'OK links', skipped: 'skipped links' })[filter]}.` : 'Run a check to see results here.'}</p></div>`;
    return;
  }
  const rows = ids.slice(0, 1000).map(id => {
    const n = S.nodes.get(id);
    const r = results[id];
    const cls = r.status === 'dead' ? 'bad' : r.status === 'redirect' ? 'warn' : r.status === 'ok' ? 'ok' : 'muted';
    return `<div class="res-row" data-id="${id}">
      <input type="checkbox" class="res-sel" ${resultSel.has(id) ? 'checked' : ''} aria-label="Select">
      <img class="fav" src="${esc(faviconUrl(n.url))}" alt="" loading="lazy">
      <div class="body">
        <div class="title ellipsis">${esc(n.title || n.url)}</div>
        <div class="sub"><span class="url ellipsis" title="${esc(n.url)}">${esc(prettyUrl(n.url))}</span><span class="path">${icon('folder')}${esc(n.path)}</span></div>
        ${r.finalUrl && r.status !== 'ok' ? `<div class="sub redirect-to">${icon('redirect')}<span class="ellipsis" title="${esc(r.finalUrl)}">${esc(prettyUrl(r.finalUrl))}</span></div>` : ''}
      </div>
      <span class="pill ${cls}" title="${esc(r.detail || '')}">${esc(r.label || r.status)}</span>
      <div class="row-actions show">
        ${r.finalUrl && r.status !== 'ok' ? `<button class="btn sm" data-h="row-update" title="Replace the bookmark URL with the new address">Update URL</button>` : ''}
        ${r.status === 'dead' ? `<button class="btn ghost icon sm" data-h="row-wayback" title="Look up in the Internet Archive" aria-label="Open in Internet Archive">${icon('history')}</button>` : ''}
        <button class="btn ghost icon sm" data-h="row-open" title="Open" aria-label="Open">${icon('external')}</button>
        <button class="btn ghost icon sm" data-h="row-recheck" title="Check again" aria-label="Check again">${icon('refresh')}</button>
        <button class="btn ghost icon sm" data-h="row-delete" title="Delete bookmark" aria-label="Delete bookmark">${icon('trash')}</button>
      </div>
    </div>`;
  });
  el.innerHTML = `<div class="res-bar" id="resBar"></div><div class="res-list">${rows.join('')}</div>${ids.length > 1000 ? `<p class="muted small">Showing the first 1,000 of ${ids.length.toLocaleString()}.</p>` : ''}`;
  renderResultBar(el);
}

function renderResultBar(el) {
  const bar = el.querySelector('#resBar');
  if (!bar) return;
  const ids = currentResultIds();
  const n = [...resultSel].filter(id => ids.includes(id)).length;
  const hasRedirects = [...resultSel].some(id => S.health.results[id] && S.health.results[id].finalUrl);
  bar.innerHTML = `<button class="btn sm" data-h="select-all">${ids.every(id => resultSel.has(id)) ? 'Select none' : `Select all (${ids.length.toLocaleString()})`}</button>
    <span class="muted small">${n ? `${n} selected` : ''}</span><span class="spacer"></span>
    ${n ? `${hasRedirects ? `<button class="btn sm primary" data-h="update-sel">${icon('redirect')}Update URLs</button>` : ''}
      <button class="btn sm" data-h="recheck-sel">${icon('refresh')}Recheck</button>
      <button class="btn sm" data-h="ignore-sel" title="Remove from this report">Ignore</button>
      <button class="btn sm danger" data-h="delete-sel">${icon('trash')}Delete</button>` : ''}`;
}

function checkedAny() { return S.health && S.health.results && Object.keys(S.health.results).length > 0; }

async function updateRedirects(ids) {
  const list = ids.map(id => [id, S.health.results[id]]).filter(([id, r]) => r && r.finalUrl && S.nodes.has(id));
  if (!list.length) return;
  if (list.length > 1 && !await confirmDialog('Update URLs', `Replace ${plural(list.length, 'bookmark URL')} with the address each one now redirects to?`, 'Update')) return;
  await markBulk(true);
  for (const [id, r] of list) {
    try { await chrome.bookmarks.update(id, { url: r.finalUrl }); S.health.results[id] = { status: 'ok', label: 'OK', detail: 'Updated to new address', url: r.finalUrl, at: Date.now() }; } catch (e) { console.warn('Update failed', id, e); }
  }
  await markBulk(false);
  resultSel.clear();
  await persist(true);
  toast(`Updated ${plural(list.length, 'URL')}`);
  await hooks.reload();
}

// ---------- Duplicates ----------
export function findDuplicates() {
  const groups = new Map();
  for (const n of S.bookmarks) {
    if (!n.url) continue;
    const k = n.norm;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  return [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
}

function preferredKeep(group) {
  // Keep the one with the most tags / a note, outside Read Later, then the oldest.
  const score = n => (metaOf(n.id).tags || []).length * 2 + (metaOf(n.id).note ? 3 : 0) + (metaOf(n.id).hasText ? 1 : 0) - (isReadLaterFolder(n.parentId) ? 5 : 0);
  return [...group].sort((a, b) => score(b) - score(a) || (a.dateAdded || 0) - (b.dateAdded || 0))[0].id;
}

const keepChoice = new Map();

function renderDuplicates(body, groups) {
  if (!groups.length) {
    body.innerHTML = `<div class="empty">${icon('check')}<p>No duplicate bookmarks. URLs are compared after removing tracking parameters, “www.”, trailing slashes and http/https differences.</p></div>`;
    return;
  }
  const extra = groups.reduce((a, g) => a + g.length - 1, 0);
  body.innerHTML = `<section class="card row-card">
      <div><h2>${plural(extra, 'duplicate')} in ${plural(groups.length, 'group')}</h2>
      <p class="muted small">For each group, the selected bookmark is kept. Tags and notes from the others are merged into it. You can undo right after.</p></div>
      <span class="spacer"></span><button class="btn primary" data-d="all">${icon('broom')}Clean up all</button>
    </section>
    <div class="dup-list">${groups.slice(0, 500).map((g, gi) => {
      const keep = keepChoice.get(g[0].norm) || preferredKeep(g);
      return `<div class="dup-group card" data-g="${gi}">
        <div class="dup-head"><span class="mono small ellipsis" title="${esc(g[0].norm)}">${esc(g[0].norm)}</span><span class="pill muted">${g.length}×</span><span class="spacer"></span><button class="btn sm" data-d="group">Keep selected, remove ${g.length - 1}</button></div>
        ${g.map(n => `<label class="dup-row">
          <input type="radio" name="keep-${gi}" value="${n.id}" ${n.id === keep ? 'checked' : ''}>
          <img class="fav" src="${esc(faviconUrl(n.url))}" alt="" loading="lazy">
          <div class="body"><div class="title ellipsis">${esc(n.title || n.url)}</div>
            <div class="sub"><span class="path">${icon('folder')}${esc(n.path)}</span><span>${fmtDate(n.dateAdded)}</span>${(metaOf(n.id).tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
            <div class="sub"><span class="url ellipsis">${esc(n.url)}</span></div></div>
          ${n.id === keep ? '<span class="pill ok">Keep</span>' : '<span class="pill muted">Remove</span>'}
        </label>`).join('')}
      </div>`;
    }).join('')}</div>
    ${groups.length > 500 ? `<p class="muted small">Showing 500 of ${groups.length} groups. Clean up all applies to every group.</p>` : ''}`;
  body.onchange = e => {
    if (e.target.type === 'radio') {
      const gi = +e.target.closest('[data-g]').dataset.g;
      keepChoice.set(groups[gi][0].norm, e.target.value);
      renderDuplicates(body, groups);
    }
  };
  body.onclick = async e => {
    const b = e.target.closest('[data-d]');
    if (!b) return;
    if (b.dataset.d === 'group') {
      const g = groups[+b.closest('[data-g]').dataset.g];
      await dedupe([g]);
    } else if (b.dataset.d === 'all') {
      if (!await confirmDialog('Clean up all duplicates', `Remove ${plural(extra, 'duplicate bookmark')} and keep one of each? Tags and notes are merged into the kept bookmark.`, 'Clean up', true)) return;
      await dedupe(groups);
    }
  };
}

async function dedupe(groups) {
  const remove = [];
  const patches = [];
  for (const g of groups) {
    const keep = keepChoice.get(g[0].norm) || preferredKeep(g);
    const others = g.filter(n => n.id !== keep);
    const tags = mergeTags(...g.map(n => metaOf(n.id).tags));
    const notes = [...new Set(g.map(n => metaOf(n.id).note).filter(Boolean))].join('\n\n');
    patches.push([keep, m => ({ ...m, tags, note: notes || undefined })]);
    remove.push(...others.map(n => n.id));
    keepChoice.delete(g[0].norm);
  }
  await updateMetaMany(patches);
  await deleteItems(remove, { label: `Removed ${plural(remove.length, 'duplicate')}` });
}

// ---------- Empty folders ----------
export function findEmptyFolders() {
  const empties = S.folders.filter(f => !isProtected(f.id) && !isReadLaterFolder(f.id) && (f.total || 0) === 0);
  // Only report the topmost empty folder of each empty subtree.
  const set = new Set(empties.map(f => f.id));
  return empties.filter(f => !set.has(f.parentId));
}

function renderEmpty(body, empties) {
  if (!empties.length) {
    body.innerHTML = `<div class="empty">${icon('check')}<p>No empty folders.</p></div>`;
    return;
  }
  body.innerHTML = `<section class="card row-card">
      <div><h2>${plural(empties.length, 'empty folder')}</h2><p class="muted small">Folders that contain no bookmarks (they may contain other empty folders).</p></div>
      <span class="spacer"></span><button class="btn primary" data-e="delete">${icon('trash')}Delete selected</button>
    </section>
    <div class="card list-card">
      <label class="check empty-row head"><input type="checkbox" data-e="all" checked><b>Select all</b></label>
      ${empties.map(f => `<label class="check empty-row"><input type="checkbox" value="${f.id}" checked>${icon('folder')}<span class="ellipsis">${esc(f.path ? f.path + ' / ' : '')}<b>${esc(f.title || '(untitled)')}</b></span>
        ${(f.children || []).length ? `<span class="faint small">${plural(f.children.length, 'subfolder')}</span>` : ''}</label>`).join('')}
    </div>`;
  body.onchange = e => {
    if (e.target.dataset.e === 'all') body.querySelectorAll('.empty-row:not(.head) input').forEach(i => { i.checked = e.target.checked; });
  };
  body.onclick = async e => {
    if (!e.target.closest('[data-e="delete"]')) return;
    const ids = [...body.querySelectorAll('.empty-row:not(.head) input:checked')].map(i => i.value);
    if (!ids.length) return;
    await deleteItems(ids, { label: `Deleted ${plural(ids.length, 'empty folder')}` });
  };
}
