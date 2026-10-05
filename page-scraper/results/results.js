import { getSession, saveSession, listSessions, deleteSession } from '../lib/store.js';
import { toCSV, toTSV, toJSON, excelCSV, download, copyText, safeFileName, compareValues } from '../lib/export.js';

const $ = (id) => document.getElementById(id);
const PAGE = 500;
const params = new URLSearchParams(location.search);
const id = params.get('id');

const V = {
  session: null,
  order: [], // column indexes in display order
  hidden: new Set(),
  sort: { col: -1, dir: 0 },
  filter: '',
  limit: PAGE,
};

let toastTimer = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const IMG_RE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg)(\?\S*)?$/i;
const URL_RE = /^https?:\/\/\S+$/i;

function viewKey() { return 'view:' + id; }

async function loadView() {
  const { [viewKey()]: v } = await chrome.storage.local.get(viewKey());
  const n = V.session.columns.length;
  if (v && Array.isArray(v.order) && v.order.length === n && v.order.every((i) => i >= 0 && i < n)) {
    V.order = v.order; V.hidden = new Set(v.hidden || []); V.sort = v.sort || V.sort;
  } else V.order = [...Array(n).keys()];
}

function saveView() {
  chrome.storage.local.set({ [viewKey()]: { order: V.order, hidden: [...V.hidden], sort: V.sort } });
}

function visibleCols() { return V.order.filter((i) => !V.hidden.has(i)); }

function processedRows() {
  let rows = V.session.rows.map((r, i) => ({ r, i }));
  const q = V.filter.trim().toLowerCase();
  if (q) rows = rows.filter(({ r }) => visibleCols().some((c) => String(r[c] ?? '').toLowerCase().includes(q)));
  if (V.sort.dir && V.sort.col >= 0) {
    const c = V.sort.col; const d = V.sort.dir;
    rows.sort((a, b) => compareValues(a.r[c], b.r[c]) * d || a.i - b.i);
  }
  return rows;
}

function exportData() {
  const cols = visibleCols();
  return { headers: cols.map((c) => V.session.columns[c]), rows: processedRows().map(({ r }) => cols.map((c) => r[c] ?? '')) };
}

function highlight(text, q) {
  const s = String(text);
  const span = document.createDocumentFragment();
  if (!q) { span.append(s); return span; }
  const lower = s.toLowerCase(); let pos = 0;
  for (;;) {
    const k = lower.indexOf(q, pos);
    if (k < 0) { span.append(s.slice(pos)); break; }
    span.append(s.slice(pos, k));
    const m = document.createElement('mark'); m.textContent = s.slice(k, k + q.length); span.append(m);
    pos = k + q.length;
  }
  return span;
}

function renderHead() {
  const tr = document.createElement('tr');
  const num = document.createElement('th'); num.className = 'rownum'; num.textContent = '#'; tr.append(num);
  for (const c of visibleCols()) {
    const th = document.createElement('th');
    th.draggable = true; th.dataset.col = c; th.scope = 'col';
    const sorted = V.sort.col === c && V.sort.dir;
    th.setAttribute('aria-sort', sorted ? (V.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    const b = document.createElement('button');
    b.className = 'h'; b.dataset.col = c;
    b.title = 'Sort by ' + V.session.columns[c];
    const label = document.createElement('span'); label.textContent = V.session.columns[c];
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = sorted ? (V.sort.dir > 0 ? '▲' : '▼') : '';
    b.append(label, arrow); th.append(b); tr.append(th);
  }
  $('thead').replaceChildren(tr);
}

function renderBody() {
  const rows = processedRows();
  const cols = visibleCols();
  const q = V.filter.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  for (const { r, i } of rows.slice(0, V.limit)) {
    const tr = document.createElement('tr');
    const n = document.createElement('td'); n.className = 'rownum'; n.textContent = i + 1; tr.append(n);
    for (const c of cols) {
      const td = document.createElement('td');
      const v = r[c] ?? '';
      if (IMG_RE.test(v)) {
        const img = document.createElement('img'); img.className = 'thumb'; img.loading = 'lazy'; img.alt = ''; img.src = v;
        img.addEventListener('error', () => img.remove());
        td.append(img);
      }
      if (URL_RE.test(v)) {
        const a = document.createElement('a'); a.href = v; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.append(highlight(v, q)); td.append(a);
      } else td.append(highlight(v, q));
      tr.append(td);
    }
    frag.append(tr);
  }
  $('tbody').replaceChildren(frag);
  const more = rows.length - V.limit;
  $('moreBtn').hidden = more <= 0;
  $('moreBtn').textContent = `Show ${Math.min(PAGE, more)} more of ${more} remaining`;
  renderMeta(rows.length);
}

function renderMeta(shown) {
  const s = V.session;
  const meta = $('meta');
  meta.replaceChildren();
  const parts = [];
  const rowsText = shown !== s.rows.length ? `${shown} of ${s.rows.length} rows` : `${s.rows.length} rows`;
  parts.push(`${rowsText} · ${s.columns.length} columns · ${s.pages || 1} page${(s.pages || 1) === 1 ? '' : 's'} · ${fmtDate(s.createdAt)}`);
  meta.append(parts.join(''));
  if (s.status === 'running') { const b = document.createElement('span'); b.className = 'badge ok'; b.textContent = 'Scraping…'; meta.append(' ', b); }
  if (s.url) {
    meta.append(' · ');
    const a = document.createElement('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = s.host || s.url; meta.append(a);
  }
  if (s.note) meta.append(' · ' + s.note);
}

function renderColsMenu() {
  const menu = $('colsMenu');
  menu.replaceChildren();
  V.order.forEach((c, pos) => {
    const row = document.createElement('label'); row.className = 'menu-check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !V.hidden.has(c);
    cb.addEventListener('change', () => { if (cb.checked) V.hidden.delete(c); else V.hidden.add(c); saveView(); renderAll(); });
    const name = document.createElement('span'); name.className = 'grow'; name.textContent = V.session.columns[c];
    const up = document.createElement('button'); up.className = 'small ghost'; up.textContent = '↑'; up.disabled = pos === 0; up.setAttribute('aria-label', 'Move ' + V.session.columns[c] + ' left');
    const down = document.createElement('button'); down.className = 'small ghost'; down.textContent = '↓'; down.disabled = pos === V.order.length - 1; down.setAttribute('aria-label', 'Move ' + V.session.columns[c] + ' right');
    up.addEventListener('click', (e) => { e.preventDefault(); move(c, -1); renderColsMenu(); });
    down.addEventListener('click', (e) => { e.preventDefault(); move(c, 1); renderColsMenu(); });
    row.append(cb, name, up, down); menu.append(row);
  });
  const hr = document.createElement('hr'); menu.append(hr);
  const rename = document.createElement('button'); rename.textContent = 'Reset order and visibility';
  rename.addEventListener('click', () => { V.order = [...V.session.columns.keys()]; V.hidden.clear(); saveView(); renderAll(); renderColsMenu(); });
  menu.append(rename);
}

function move(col, delta) {
  const i = V.order.indexOf(col); const j = i + delta;
  if (i < 0 || j < 0 || j >= V.order.length) return;
  [V.order[i], V.order[j]] = [V.order[j], V.order[i]];
  saveView(); renderAll();
}

function renderAll() { renderHead(); renderBody(); }

// --- header interactions: sort, drag reorder, keyboard reorder
$('thead').addEventListener('click', (e) => {
  const b = e.target.closest('button.h'); if (!b) return;
  const c = +b.dataset.col;
  if (V.sort.col !== c) V.sort = { col: c, dir: 1 };
  else V.sort = { col: c, dir: V.sort.dir === 1 ? -1 : V.sort.dir === -1 ? 0 : 1 };
  saveView(); renderAll();
  const again = $('thead').querySelector(`button.h[data-col="${c}"]`); if (again) again.focus();
});
$('thead').addEventListener('keydown', (e) => {
  const b = e.target.closest('button.h'); if (!b || !e.altKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const c = +b.dataset.col;
  const vis = visibleCols(); const k = vis.indexOf(c);
  const other = vis[k + (e.key === 'ArrowLeft' ? -1 : 1)];
  if (other === undefined) return;
  const i = V.order.indexOf(c); const j = V.order.indexOf(other);
  [V.order[i], V.order[j]] = [V.order[j], V.order[i]];
  saveView(); renderAll();
  $('thead').querySelector(`button.h[data-col="${c}"]`).focus();
});
let dragCol = null;
$('thead').addEventListener('dragstart', (e) => {
  const th = e.target.closest('th[data-col]'); if (!th) return;
  dragCol = +th.dataset.col; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragCol));
});
$('thead').addEventListener('dragover', (e) => {
  const th = e.target.closest('th[data-col]'); if (!th || dragCol === null) return;
  e.preventDefault();
  $('thead').querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  th.classList.add('drag-over');
});
$('thead').addEventListener('dragleave', (e) => { const th = e.target.closest('th'); if (th) th.classList.remove('drag-over'); });
$('thead').addEventListener('drop', (e) => {
  const th = e.target.closest('th[data-col]'); if (!th || dragCol === null) return;
  e.preventDefault();
  const target = +th.dataset.col;
  if (target !== dragCol) {
    V.order.splice(V.order.indexOf(dragCol), 1);
    V.order.splice(V.order.indexOf(target), 0, dragCol);
    saveView();
  }
  dragCol = null; renderAll();
});
$('thead').addEventListener('dragend', () => { dragCol = null; $('thead').querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over')); });

// --- toolbar
let filterTimer = 0;
$('filter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { V.filter = $('filter').value; V.limit = PAGE; renderBody(); }, 150); });
$('moreBtn').addEventListener('click', () => { V.limit += PAGE; renderBody(); });

function setupMenu(btnId, menuId, onOpen) {
  const btn = $(btnId); const menu = $(menuId);
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    if (open) { onOpen && onOpen(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); const f = menu.querySelector('button, input'); if (f) f.focus(); }
    else close();
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  document.addEventListener('click', close);
}
setupMenu('colsBtn', 'colsMenu', renderColsMenu);
setupMenu('exportBtn', 'exportMenu');

function baseName() { return safeFileName(V.session.title, 'scrape') + '-' + new Date(V.session.createdAt).toISOString().slice(0, 10); }

$('exportMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-export]'); if (!b) return;
  const { headers, rows } = exportData();
  const guard = $('guard').checked;
  switch (b.dataset.export) {
    case 'csv': download(baseName() + '.csv', toCSV(headers, rows, { guard }), 'text/csv;charset=utf-8'); break;
    case 'excel': download(baseName() + '-excel.csv', excelCSV(headers, rows), 'text/csv;charset=utf-8'); break;
    case 'tsv': download(baseName() + '.tsv', toTSV(headers, rows, { guard }), 'text/tab-separated-values;charset=utf-8'); break;
    case 'json': download(baseName() + '.json', toJSON(headers, rows), 'application/json'); break;
    case 'copy-csv': await copyText(toCSV(headers, rows, { guard })); toast(`Copied ${rows.length} rows as CSV`); break;
    case 'copy-json': await copyText(toJSON(headers, rows)); toast(`Copied ${rows.length} rows as JSON`); break;
  }
  $('exportMenu').hidden = true; $('exportBtn').setAttribute('aria-expanded', 'false');
});

$('copyTsv').addEventListener('click', async () => {
  const { headers, rows } = exportData();
  const ok = await copyText(toTSV(headers, rows, { guard: $('guard').checked }));
  toast(ok ? `Copied ${rows.length} rows. Paste into Google Sheets or Excel.` : 'Copy failed. Try the TSV download.');
});

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Delete “${V.session.title}” and its ${V.session.rows.length} rows?`)) return;
  await deleteSession(id);
  await chrome.storage.local.remove(viewKey());
  location.href = 'results.html';
});

$('title').addEventListener('change', async () => {
  const s = await getSession(id); if (!s) return;
  s.title = $('title').value.trim() || s.title;
  V.session.title = s.title; document.title = s.title + ' · Scrape results';
  await saveSession(s);
  toast('Renamed');
});

async function renderSessionPicker() {
  const list = await listSessions();
  const sel = $('sessionPick');
  sel.replaceChildren();
  const first = document.createElement('option'); first.value = ''; first.textContent = list.length ? 'Other results…' : 'No saved results';
  sel.append(first);
  for (const m of list) {
    const o = document.createElement('option'); o.value = m.id;
    o.textContent = `${m.title.slice(0, 50)} (${m.rowCount} rows)`;
    if (m.id === id) o.selected = true;
    sel.append(o);
  }
  sel.hidden = !list.length;
}
$('sessionPick').addEventListener('change', () => { const v = $('sessionPick').value; if (v && v !== id) location.search = '?id=' + encodeURIComponent(v); });

async function showHistory() {
  document.title = 'Scrape results';
  $('title').value = 'Scrape results'; $('title').readOnly = true;
  const list = await listSessions();
  $('meta').textContent = list.length ? 'Pick a result to open.' : '';
  const empty = $('emptyState');
  if (!list.length) { empty.textContent = 'No results yet. Open a page, click the toolbar button and choose Detect data.'; return; }
  empty.className = 'history';
  empty.replaceChildren(...list.map((m) => {
    const a = document.createElement('a'); a.href = '?id=' + encodeURIComponent(m.id);
    const t = document.createElement('strong'); t.className = 'grow'; t.textContent = m.title;
    const info = document.createElement('span'); info.className = 'muted'; info.textContent = `${m.rowCount} rows · ${m.host || ''} · ${fmtDate(m.createdAt)}`;
    a.append(t, info); return a;
  }));
}

async function init() {
  await renderSessionPicker();
  if (!id) { await showHistory(); return; }
  const s = await getSession(id);
  if (!s) { $('emptyState').textContent = 'This result no longer exists.'; $('title').value = 'Not found'; return; }
  V.session = s;
  await loadView();
  document.title = s.title + ' · Scrape results';
  $('title').value = s.title;
  $('toolbar').hidden = false;
  if (!s.rows.length) { $('emptyState').textContent = s.status === 'running' ? 'Scraping… rows will appear here.' : 'No rows were scraped.'; renderMeta(0); }
  else { $('emptyState').hidden = true; $('tableWrap').hidden = false; }
  renderAll();
}

// Live updates while a crawl is still writing to this session.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !id || !changes['session:' + id]) return;
  const s = changes['session:' + id].newValue;
  if (!s || !V.session) return;
  const grew = s.columns.length !== V.session.columns.length;
  V.session = s;
  if (grew) V.order = [...s.columns.keys()];
  if (s.rows.length) { $('emptyState').hidden = true; $('tableWrap').hidden = false; }
  renderAll();
});

init();
