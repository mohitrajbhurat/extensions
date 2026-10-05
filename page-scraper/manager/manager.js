import { listRecipes, saveRecipes, normalizeRecipe, listSessions, deleteSession, getSession } from '../lib/store.js';
import { download, excelCSV } from '../lib/export.js';

const $ = (id) => document.getElementById(id);
const selected = new Set();
let toastTimer = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') e[k] = v; else if (v != null) e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

// ---------- tabs
const tabs = [['tabRecipes', 'recipesSec'], ['tabResults', 'resultsSec'], ['tabHelp', 'helpSec']];
function showTab(id) {
  for (const [t, s] of tabs) { $(t).setAttribute('aria-selected', String(t === id)); $(s).hidden = t !== id; }
  history.replaceState(null, '', '#' + id.replace('tab', '').toLowerCase());
}
for (const [t] of tabs) $(t).addEventListener('click', () => showTab(t));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = tabs.findIndex(([t]) => t === document.activeElement.id);
  const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  $(tabs[j][0]).focus(); showTab(tabs[j][0]);
});

// ---------- recipes
function exportFile(recipes, name) {
  const data = { format: 'page-scraper-recipes', version: 1, exportedAt: new Date().toISOString(), recipes };
  download(name, JSON.stringify(data, null, 2), 'application/json');
}

async function renderRecipes() {
  const all = await listRecipes();
  const q = $('recipeFilter').value.trim().toLowerCase();
  const list = q ? all.filter((r) => (r.name + ' ' + r.host).toLowerCase().includes(q)) : all;
  for (const id of [...selected]) if (!all.some((r) => r.id === id)) selected.delete(id);
  const tb = $('recipeRows');
  tb.replaceChildren();
  if (!list.length) {
    tb.append(el('tr', {}, el('td', { colspan: '7', class: 'muted' }, all.length ? 'No recipes match the filter.' : 'No recipes yet. Save one from the scraper panel, or import a JSON file.')));
  }
  for (const r of list) {
    const pg = !r.pagination || r.pagination.mode === 'none' ? 'Single page'
      : r.pagination.mode === 'scroll' ? `Infinite scroll, ${r.pagination.maxPages} max` : `Next button, ${r.pagination.maxPages} pages max`;
    const name = el('input', { class: 'name', value: r.name, 'aria-label': 'Recipe name' });
    name.addEventListener('change', async () => {
      const rs = await listRecipes(); const x = rs.find((y) => y.id === r.id);
      if (x) { x.name = name.value.trim() || x.name; x.updatedAt = Date.now(); await saveRecipes(rs); toast('Renamed'); }
    });
    const cb = el('input', { type: 'checkbox', checked: selected.has(r.id), 'aria-label': 'Select ' + r.name });
    cb.addEventListener('change', () => { if (cb.checked) selected.add(r.id); else selected.delete(r.id); updateSel(all); });
    const siteUrl = r.url && /^https?:/.test(r.url) ? r.url : (r.host ? 'https://' + r.host : '');
    tb.append(el('tr', {},
      el('td', { class: 'chk' }, cb),
      el('td', {}, name),
      el('td', { class: 'site' }, siteUrl ? el('a', { href: siteUrl, target: '_blank', rel: 'noopener noreferrer' }, r.host || siteUrl) : '—'),
      el('td', { title: r.columns.map((c) => c.name).join(', ') }, String(r.columns.length)),
      el('td', {}, pg),
      el('td', {}, fmtDate(r.updatedAt || r.createdAt)),
      el('td', { class: 'acts' },
        el('button', { class: 'small', onclick: () => exportFile([r], `recipe-${(r.name || 'recipe').replace(/[^\w.-]+/g, '_')}.json`) }, 'Export'),
        ' ',
        el('button', { class: 'small', onclick: async () => {
          const rs = await listRecipes();
          const copy = { ...structuredClone(r), id: 'r' + Date.now().toString(36), name: r.name + ' (copy)', createdAt: Date.now(), updatedAt: Date.now() };
          rs.unshift(copy); await saveRecipes(rs); renderRecipes();
        } }, 'Duplicate'),
        ' ',
        el('button', { class: 'small danger', 'aria-label': 'Delete ' + r.name, onclick: async () => {
          if (!confirm(`Delete recipe “${r.name}”?`)) return;
          await saveRecipes((await listRecipes()).filter((x) => x.id !== r.id));
          selected.delete(r.id); renderRecipes();
        } }, 'Delete'),
      ),
    ));
  }
  updateSel(all);
}

function updateSel(all) {
  $('exportSel').disabled = !selected.size;
  $('exportSel').textContent = selected.size ? `Export selected (${selected.size})` : 'Export selected';
  $('selAll').checked = all.length > 0 && selected.size === all.length;
  $('selAll').indeterminate = selected.size > 0 && selected.size < all.length;
}

$('selAll').addEventListener('change', async () => {
  const all = await listRecipes();
  selected.clear();
  if ($('selAll').checked) all.forEach((r) => selected.add(r.id));
  renderRecipes();
});
$('recipeFilter').addEventListener('input', renderRecipes);
$('exportAll').addEventListener('click', async () => {
  const all = await listRecipes();
  if (!all.length) { toast('No recipes to export'); return; }
  exportFile(all, `scraper-recipes-${new Date().toISOString().slice(0, 10)}.json`);
});
$('exportSel').addEventListener('click', async () => {
  const all = (await listRecipes()).filter((r) => selected.has(r.id));
  exportFile(all, `scraper-recipes-${all.length}.json`);
});
$('importLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('importFile').click(); } });
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('That file is too large to be a recipe export.'); return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.'); return; }
  const raw = Array.isArray(data) ? data : Array.isArray(data.recipes) ? data.recipes : [data];
  const incoming = raw.map(normalizeRecipe).filter(Boolean);
  if (!incoming.length) { toast('No valid recipes found in that file.'); return; }
  const rs = await listRecipes();
  let added = 0; let updated = 0;
  for (const r of incoming) {
    const i = rs.findIndex((x) => x.id === r.id);
    if (i >= 0) { rs[i] = r; updated++; } else { rs.unshift(r); added++; }
  }
  await saveRecipes(rs);
  toast(`Imported ${added} new${updated ? `, updated ${updated}` : ''} recipe${added + updated === 1 ? '' : 's'}`);
  renderRecipes();
});

// ---------- results
async function renderResults() {
  const list = await listSessions();
  $('resultsInfo').textContent = `${list.length} saved result${list.length === 1 ? '' : 's'} (the oldest are removed after 60).`;
  $('deleteAll').disabled = !list.length;
  const tb = $('resultRows');
  tb.replaceChildren();
  if (!list.length) tb.append(el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'No results yet.')));
  for (const m of list) {
    const href = chrome.runtime.getURL('results/results.html?id=' + encodeURIComponent(m.id));
    tb.append(el('tr', {},
      el('td', {}, el('a', { href }, m.title || 'Untitled')),
      el('td', {}, m.host || ''),
      el('td', {}, String(m.rowCount)),
      el('td', {}, String(m.pages || 1)),
      el('td', {}, fmtDate(m.createdAt)),
      el('td', { class: 'acts' },
        el('button', { class: 'small', onclick: async () => {
          const s = await getSession(m.id); if (!s) return;
          download((s.title || 'scrape').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + '.csv', excelCSV(s.columns, s.rows), 'text/csv;charset=utf-8');
        } }, 'CSV'),
        ' ',
        el('button', { class: 'small danger', 'aria-label': 'Delete ' + m.title, onclick: async () => {
          if (!confirm(`Delete “${m.title}”?`)) return;
          await deleteSession(m.id); await chrome.storage.local.remove('view:' + m.id); renderResults();
        } }, 'Delete'),
      ),
    ));
  }
}
$('deleteAll').addEventListener('click', async () => {
  const list = await listSessions();
  if (!confirm(`Delete all ${list.length} results? Recipes are kept.`)) return;
  for (const m of list) { await deleteSession(m.id); await chrome.storage.local.remove('view:' + m.id); }
  renderResults();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.recipes) renderRecipes();
  if (changes.sessionIndex) renderResults();
});

const hash = location.hash.slice(1);
if (hash === 'results') showTab('tabResults'); else if (hash === 'help') showTab('tabHelp');
renderRecipes();
renderResults();
