import { PriceChart } from '../lib/chart.js';
import { PS, send, getSettings, getItems, fmt, hostOf, hasOrigin, requestOrigin, itemSummary, el, safeImage, STATUS_TEXT, relTime, pct, targetLabel, toast } from '../lib/ui.js';

const $ = id => document.getElementById(id);
const DAY = 86400000;
const state = {
  items: {}, settings: null, selectedId: null, rangeDays: 0, checked: new Set(),
  chart: null, showTable: false, rows: [],
};

// ---------------------------------------------------------------------------------------
// Data

async function load() {
  state.items = await getItems();
  const { lastRun } = await chrome.storage.local.get('lastRun');
  $('k-lastrun').textContent = lastRun ? `${relTime(lastRun.at)} · ${lastRun.checked} item${lastRun.checked === 1 ? '' : 's'} checked · every ${state.settings.intervalHours}h` : `Not run yet · every ${state.settings.intervalHours}h`;
  render();
}

function enrich(item) {
  return { item, ...itemSummary(item, state.settings) };
}

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;
  let rows = Object.values(state.items).map(enrich);
  if (q) rows = rows.filter(r => (r.item.title || '').toLowerCase().includes(q) || hostOf(r.item.url).includes(q) || (r.item.notes || '').toLowerCase().includes(q));
  if (f === 'deals') rows = rows.filter(r => r.verdict.level === 'great' || r.verdict.level === 'good');
  if (f === 'target') rows = rows.filter(r => r.atTarget);
  if (f === 'attention') rows = rows.filter(r => r.item.lastStatus && r.item.lastStatus !== 'ok');
  if (f === 'oos') rows = rows.filter(r => r.item.availability === 'out_of_stock');
  if (f === 'paused') rows = rows.filter(r => r.item.paused);
  const rank = { great: 0, good: 1, fair: 2, unknown: 3, high: 4 };
  const sorters = {
    recent: (a, b) => (b.item.lastSeen || b.item.createdAt) - (a.item.lastSeen || a.item.createdAt),
    deal: (a, b) => rank[a.verdict.level] - rank[b.verdict.level] || (a.stats.pctVsAvg ?? 0) - (b.stats.pctVsAvg ?? 0),
    drop: (a, b) => (a.stats.pctVsAvg ?? 999) - (b.stats.pctVsAvg ?? 999),
    'price-asc': (a, b) => (a.stats.current ?? Infinity) - (b.stats.current ?? Infinity),
    'price-desc': (a, b) => (b.stats.current ?? -Infinity) - (a.stats.current ?? -Infinity),
    name: (a, b) => (a.item.title || '').localeCompare(b.item.title || ''),
    added: (a, b) => b.item.createdAt - a.item.createdAt,
  };
  rows.sort(sorters[$('sort').value] || sorters.recent);
  return rows;
}

// ---------------------------------------------------------------------------------------
// Rendering

function render() {
  const all = Object.values(state.items).map(enrich);
  $('k-count').textContent = all.length;
  $('k-deals').textContent = all.filter(r => r.verdict.level === 'great' || r.verdict.level === 'good').length;
  $('k-target').textContent = all.filter(r => r.atTarget).length;
  $('k-attention').textContent = all.filter(r => r.item.lastStatus && r.item.lastStatus !== 'ok').length;
  for (const id of [...state.checked]) if (!state.items[id]) state.checked.delete(id);

  const rows = filtered();
  state.rows = rows;
  $('empty').hidden = all.length > 0;
  $('list').hidden = all.length === 0;
  $('no-match').hidden = !(all.length && !rows.length);
  const tbody = $('rows');
  const focusedId = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id;
  tbody.replaceChildren(...rows.map(rowFor));
  if (focusedId) { const r = tbody.querySelector(`tr[data-id="${CSS.escape(focusedId)}"]`); if (r) r.focus(); }
  updateBulk();
  if (state.selectedId && !state.items[state.selectedId]) closeDetail();
  else if (state.selectedId) renderDetail();
}

function rowFor({ item, stats, verdict, atTarget }) {
  const img = safeImage(item.image) ? el('img', { src: item.image, alt: '', loading: 'lazy' }) : el('span', { class: 'ph' });
  if (img.tagName === 'IMG') img.addEventListener('error', () => img.replaceWith(el('span', { class: 'ph' })));
  const prevDelta = stats.previous != null && stats.current != null ? ((stats.current - stats.previous) / stats.previous) * 100 : null;
  const statusText = item.lastStatus && item.lastStatus !== 'ok' ? STATUS_TEXT[item.lastStatus] : `Checked ${relTime(item.lastChecked)}`;
  const vsAvg = stats.pctVsAvg;
  const cb = el('input', { type: 'checkbox', 'aria-label': 'Select ' + item.title });
  cb.checked = state.checked.has(item.id);
  cb.addEventListener('click', e => e.stopPropagation());
  cb.addEventListener('change', () => { cb.checked ? state.checked.add(item.id) : state.checked.delete(item.id); updateBulk(); });
  const tr = el('tr', { tabindex: '0', 'aria-selected': String(item.id === state.selectedId), dataset: { id: item.id } },
    el('td', { class: 'c-sel' }, cb),
    el('td', {}, el('div', { class: 'cell-item' }, img, el('div', { style: 'min-width:0' },
      el('div', { class: 'name', title: item.title }, item.title),
      el('div', { class: 'meta' }, hostOf(item.url), item.paused ? el('span', { class: 'paused-tag' }, 'Paused') : null, atTarget ? ' · ' : null, atTarget ? el('span', { class: 'pill target' }, 'At target') : null)))),
    el('td', { class: 'c-num' },
      el('span', { class: 'cur' }, fmt(stats.current, item.currency)),
      prevDelta ? el('span', { class: 'delta ' + (prevDelta < 0 ? 'down' : 'up') }, (prevDelta < 0 ? '▼ ' : '▲ ') + Math.abs(prevDelta).toFixed(1) + '%') : null),
    el('td', { class: 'c-num hide-md' }, fmt(stats.min, item.currency)),
    el('td', { class: 'c-num hide-md' }, fmt(stats.max, item.currency)),
    el('td', { class: 'c-num hide-sm' }, fmt(stats.avg, item.currency)),
    el('td', { class: 'c-num ' + (vsAvg == null || Math.abs(vsAvg) < 0.5 ? '' : vsAvg < 0 ? 'down' : 'up') }, stats.count > 1 ? pct(vsAvg, 1) : '—'),
    el('td', {}, el('span', { class: 'pill ' + verdict.level, title: verdict.detail }, verdict.label),
      item.availability === 'out_of_stock' ? el('span', { class: 'pill oos', style: 'margin-left:4px' }, 'Out of stock') : null),
    el('td', { class: 'hide-sm status-cell' }, item.lastStatus && item.lastStatus !== 'ok' ? el('span', { class: 'pill status-' + item.lastStatus, title: item.statusReason || '' }, statusText) : statusText),
  );
  tr.addEventListener('click', () => select(item.id));
  tr.addEventListener('keydown', e => onRowKey(e, item.id));
  return tr;
}

function onRowKey(e, id) {
  const rows = [...$('rows').children];
  const i = rows.findIndex(r => r.dataset.id === id);
  if (e.key === 'ArrowDown' && rows[i + 1]) { e.preventDefault(); rows[i + 1].focus(); }
  else if (e.key === 'ArrowUp' && rows[i - 1]) { e.preventDefault(); rows[i - 1].focus(); }
  else if (e.key === 'Enter' || e.key === ' ') { if (e.target.tagName !== 'INPUT') { e.preventDefault(); select(id); } }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); confirmDelete([id]); }
}

function updateBulk() {
  const n = state.checked.size;
  $('bulk').hidden = n === 0;
  $('bulk-count').textContent = `${n} selected`;
  const total = state.rows.length;
  const sa = $('select-all');
  sa.checked = n > 0 && state.rows.every(r => state.checked.has(r.item.id));
  sa.indeterminate = n > 0 && !sa.checked && total > 0;
}

function select(id) {
  state.selectedId = id;
  history.replaceState(null, '', '#item=' + encodeURIComponent(id));
  for (const tr of $('rows').children) tr.setAttribute('aria-selected', String(tr.dataset.id === id));
  $('detail').hidden = false;
  document.querySelector('.layout').classList.add('with-detail');
  renderDetail(true);
}

function closeDetail() {
  const prev = state.selectedId;
  state.selectedId = null;
  history.replaceState(null, '', location.pathname);
  $('detail').hidden = true;
  document.querySelector('.layout').classList.remove('with-detail');
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  for (const tr of $('rows').children) tr.setAttribute('aria-selected', 'false');
  const row = prev && $('rows').querySelector(`tr[data-id="${CSS.escape(prev)}"]`);
  if (row) row.focus();
}

const EVENT_ICONS = { target: '◎', low: '★', stock: '↺', drop: '▼', rise: '▲', track: '+', status: '!' };

async function renderDetail(fresh) {
  const item = state.items[state.selectedId];
  if (!item) return;
  const { stats, verdict, sale, targetPrice } = enrich(item);
  const img = $('d-image');
  if (safeImage(item.image)) { img.src = item.image; img.hidden = false; img.onerror = () => { img.hidden = true; }; } else img.hidden = true;
  $('d-title').textContent = item.title;
  const link = $('d-link');
  link.href = item.url;
  link.textContent = hostOf(item.url) + ' ↗';
  $('d-price').textContent = fmt(stats.current, item.currency);
  $('d-verdict').className = 'pill ' + verdict.level;
  $('d-verdict').textContent = verdict.label;
  $('d-verdict-detail').textContent = verdict.detail;
  const av = $('d-avail');
  av.hidden = !item.availability || item.availability === 'unknown';
  av.className = 'pill ' + (item.availability === 'out_of_stock' ? 'oos' : 'good');
  av.textContent = item.availability === 'out_of_stock' ? 'Out of stock' : 'In stock';
  $('d-sale').hidden = !sale;
  if (sale) { $('d-sale').textContent = sale.text; $('d-sale').className = 'callout ' + (sale.honest === false ? 'bad' : sale.honest ? 'good' : ''); }
  const hasAccess = await hasOrigin(item.url);
  const st = item.lastStatus && item.lastStatus !== 'ok' ? item.lastStatus : null;
  $('d-status').hidden = !st;
  if (st) $('d-status').textContent = `${STATUS_TEXT[st]}: ${item.statusReason || ''}${st === 'needs_visit' ? ' Opening the page in your browser records the price automatically.' : ''}`;
  $('d-grant').hidden = hasAccess;

  if (!state.chart) state.chart = new PriceChart($('d-chart'), { height: 260, format: n => fmt(n, item.currency) });
  state.chart.opts.format = n => fmt(n, item.currency);
  state.chart.setData({ history: item.history, target: targetPrice, from: state.rangeDays ? Date.now() - state.rangeDays * DAY : null, label: 'Price history for ' + item.title });
  if (state.showTable) renderHistTable(item);

  const dd = (label, value, sub) => el('div', {}, el('dt', {}, label), el('dd', {}, value, sub ? el('small', {}, sub) : null));
  const dateStr = t => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  $('d-stats').replaceChildren(
    dd('Current', fmt(stats.current, item.currency), item.lastSeen ? 'seen ' + relTime(item.lastSeen) : ''),
    dd('Lowest', fmt(stats.min, item.currency), dateStr(stats.minAt)),
    dd('Highest', fmt(stats.max, item.currency), dateStr(stats.maxAt)),
    dd('Average', fmt(stats.avg, item.currency), 'time-weighted'),
    dd('vs average', stats.count > 1 ? pct(stats.pctVsAvg, 1) : '—', stats.count > 1 ? (stats.pctVsAvg < 0 ? 'cheaper than usual' : stats.pctVsAvg > 0 ? 'pricier than usual' : 'typical') : ''),
    dd('Tracking since', dateStr(item.createdAt), `${(item.history || []).length} data points`),
  );

  if (fresh) {
    const t = item.target || { type: 'none' };
    $('d-target-type').value = t.type;
    $('d-target-value').value = t.value != null ? t.value : '';
    $('d-notes').value = item.notes || '';
  }
  updateTargetInput(item);
  $('d-pause').textContent = item.paused ? 'Resume checks' : 'Pause checks';

  const events = (item.events || []).slice().reverse();
  $('d-events').replaceChildren(...(events.length ? events.map(ev => el('li', {},
    el('span', { class: 'ic', 'aria-hidden': 'true' }, EVENT_ICONS[ev.kind] || '•'),
    el('span', {}, ev.text),
    el('time', { datetime: new Date(ev.t).toISOString() }, relTime(ev.t)))) : [el('li', { class: 'muted' }, 'No activity yet.')]));
}

function updateTargetInput(item) {
  const type = $('d-target-type').value;
  const input = $('d-target-value');
  input.hidden = !(type === 'price' || type === 'percent');
  input.setAttribute('aria-label', type === 'price' ? 'Target price' : 'Drop percentage');
  if (type === 'percent' && !input.value) input.value = state.settings.defaultTargetValue || 10;
  if (type === 'price' && !input.value) {
    const cur = PS.computeStats(item.history).current;
    if (cur) input.value = Math.floor(cur * 0.9 * 100) / 100;
  }
  const tp = PS.targetPrice({ type, value: Number(input.value) }, item.baselinePrice);
  $('d-target-hint').textContent = type === 'percent' && tp ? `= ${fmt(tp, item.currency)} (from ${fmt(item.baselinePrice, item.currency)})` : type === 'any' ? `below ${fmt(item.baselinePrice, item.currency)}` : '';
}

function renderHistTable(item) {
  const rows = (item.history || []).slice().reverse();
  const table = el('table', {},
    el('caption', { class: 'sr-only' }, 'Price history for ' + item.title),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Date'), el('th', { scope: 'col' }, 'Price'), el('th', { scope: 'col' }, 'Availability'), el('th', { scope: 'col' }, 'Source'))),
    el('tbody', {}, ...rows.map(h => el('tr', {},
      el('td', {}, new Date(h.t).toLocaleString()),
      el('td', { class: 'num' }, h.p != null ? fmt(h.p, item.currency) : '—'),
      el('td', {}, h.a === 'out_of_stock' ? 'Out of stock' : h.a === 'in_stock' ? 'In stock' : 'Unknown'),
      el('td', {}, { b: 'Background', v: 'Your visit', p: 'Popup', i: 'Picked' }[h.v] || '')))));
  $('hist-table').replaceChildren(table);
}

// ---------------------------------------------------------------------------------------
// Actions

function confirmDialog(title, text, okLabel) {
  const d = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel || 'Delete';
  d.returnValue = '';
  d.showModal();
  return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

async function confirmDelete(ids) {
  if (!ids.length) return;
  const one = ids.length === 1 ? state.items[ids[0]] : null;
  const ok = await confirmDialog(one ? 'Delete this item?' : `Delete ${ids.length} items?`,
    one ? `"${one.title}" and its price history will be removed.` : 'Their price histories will be removed. Export a backup first if you might want them later.');
  if (!ok) return;
  await send('delete', { ids });
  for (const id of ids) state.checked.delete(id);
  toast(ids.length === 1 ? 'Item deleted' : `${ids.length} items deleted`);
}

async function checkIds(ids, btn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Checking…'; }
  let ok = 0;
  try {
    for (const id of ids) {
      const it = await send('check', { id }).catch(() => null);
      if (it && it.lastStatus === 'ok') ok++;
    }
    toast(ids.length === 1 ? (ok ? 'Price updated' : 'Could not read the price. See the status note.') : `Checked ${ids.length} items, ${ok} updated`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
  }
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  const formula = /^[=+\-@\t\r]/.test(s) && isNaN(Number(s)); // spreadsheet formula injection guard
  return formula || /[",\n\r]/.test(s) ? '"' + (formula ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportData(kind) {
  const items = Object.values(state.items);
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'json') {
    download(`price-tracker-backup-${stamp}.json`, JSON.stringify({ app: 'price-tracker', version: 1, exportedAt: new Date().toISOString(), items }, null, 2), 'application/json');
    return;
  }
  const lines = [];
  if (kind === 'summary') {
    lines.push(['title', 'url', 'store', 'currency', 'current', 'lowest', 'highest', 'average', 'pct_vs_average', 'verdict', 'target', 'target_price', 'availability', 'status', 'last_checked', 'tracking_since', 'notes'].join(','));
    for (const it of items) {
      const { stats, verdict, targetPrice } = enrich(it);
      lines.push([it.title, it.url, hostOf(it.url), it.currency, stats.current, stats.min, stats.max, stats.avg,
        stats.pctVsAvg != null ? stats.pctVsAvg.toFixed(2) : '', verdict.label, targetLabel(it), targetPrice,
        it.availability, it.lastStatus, it.lastChecked ? new Date(it.lastChecked).toISOString() : '', new Date(it.createdAt).toISOString(), it.notes || ''].map(csvCell).join(','));
    }
  } else {
    lines.push(['item_id', 'title', 'url', 'currency', 'timestamp', 'price', 'availability'].join(','));
    for (const it of items) for (const h of it.history || []) {
      lines.push([it.id, it.title, it.url, it.currency, new Date(h.t).toISOString(), h.p, h.a].map(csvCell).join(','));
    }
  }
  download(`price-tracker-${kind}-${stamp}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data) ? data : data.items;
    const { added, merged } = await send('import', { items, mode: 'merge' });
    toast(`Imported ${added} new item${added === 1 ? '' : 's'}${merged ? `, merged history into ${merged}` : ''}`);
  } catch (e) {
    toast('Import failed: ' + e.message, 4000);
  }
}

// ---------------------------------------------------------------------------------------
// Wiring

function wire() {
  for (const id of ['search', 'filter', 'sort']) $(id).addEventListener('input', render);
  $('check-all').addEventListener('click', async () => {
    const b = $('check-all');
    b.disabled = true; b.lastChild.textContent = ' Checking…';
    try { const n = await send('check-all'); toast(`Checked ${n} item${n === 1 ? '' : 's'}`); } catch (e) { toast(e.message); }
    finally { b.disabled = false; b.lastChild.textContent = ' Check all'; }
  });
  $('export-menu').addEventListener('click', e => {
    const b = e.target.closest('button[data-export]');
    if (b) { exportData(b.dataset.export); $('export-menu').open = false; }
  });
  $('import-btn').addEventListener('click', () => { $('export-menu').open = false; $('import-file').click(); });
  $('import-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('select-all').addEventListener('change', e => {
    for (const r of state.rows) e.target.checked ? state.checked.add(r.item.id) : state.checked.delete(r.item.id);
    render();
  });
  $('bulk-delete').addEventListener('click', () => confirmDelete([...state.checked]));
  $('bulk-check').addEventListener('click', e => checkIds([...state.checked], e.currentTarget));
  $('bulk-clear').addEventListener('click', () => { state.checked.clear(); render(); });

  $('d-close').addEventListener('click', closeDetail);
  $('range').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.rangeDays = Number(b.dataset.days);
    for (const x of $('range').children) x.setAttribute('aria-pressed', String(x === b));
    renderDetail();
  });
  $('toggle-table').addEventListener('click', () => {
    state.showTable = !state.showTable;
    $('hist-table').hidden = !state.showTable;
    $('toggle-table').setAttribute('aria-expanded', String(state.showTable));
    $('toggle-table').textContent = state.showTable ? 'Hide table' : 'Show as table';
    if (state.showTable) renderHistTable(state.items[state.selectedId]);
  });
  $('d-target-type').addEventListener('change', () => { $('d-target-value').value = ''; updateTargetInput(state.items[state.selectedId]); });
  $('d-target-value').addEventListener('input', () => updateTargetInput(state.items[state.selectedId]));
  $('d-target').addEventListener('submit', async e => {
    e.preventDefault();
    const type = $('d-target-type').value;
    const value = Number($('d-target-value').value);
    if ((type === 'price' || type === 'percent') && !(value > 0 && (type === 'price' || value < 100))) {
      toast(type === 'price' ? 'Enter a target price' : 'Enter a percentage between 1 and 95');
      $('d-target-value').focus();
      return;
    }
    await send('update', { id: state.selectedId, patch: { target: { type, value }, notes: $('d-notes').value } });
    toast('Alert saved');
  });
  $('d-notes').addEventListener('change', () => send('update', { id: state.selectedId, patch: { notes: $('d-notes').value } }));
  $('d-check').addEventListener('click', e => checkIds([state.selectedId], e.currentTarget));
  $('d-open').addEventListener('click', () => chrome.tabs.create({ url: state.items[state.selectedId].url }));
  $('d-pause').addEventListener('click', async () => {
    const it = state.items[state.selectedId];
    await send('update', { id: it.id, patch: { paused: !it.paused } });
    toast(it.paused ? 'Checks resumed' : 'Checks paused');
  });
  $('d-grant').addEventListener('click', async () => {
    const it = state.items[state.selectedId];
    if (await requestOrigin(it.url)) { toast('Access granted'); checkIds([it.id], $('d-check')); }
  });
  $('d-delete').addEventListener('click', () => confirmDelete([state.selectedId]));

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'Escape' && $('export-menu').open) $('export-menu').open = false;
    else if (e.key === 'Escape' && !typing && state.selectedId && !$('confirm').open) closeDetail();
  });
  document.addEventListener('click', e => { if (!e.target.closest('#export-menu')) $('export-menu').open = false; });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.items || changes.lastRun)) load();
    if (area === 'sync' && changes.settings) getSettings().then(s => { state.settings = s; load(); });
  });
}

async function init() {
  state.settings = await getSettings();
  wire();
  await load();
  const m = location.hash.match(/item=([^&]+)/);
  if (m && state.items[decodeURIComponent(m[1])]) select(decodeURIComponent(m[1]));
}

init();
