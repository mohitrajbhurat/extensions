import { SearchEngine, makeSnippet, fragmentUrl, parseQuery, isEmptyQuery } from '../lib/search.js';
import { getTexts, deleteDocs, upsertPage, getStats } from '../lib/db.js';
import { dateRange, dayLabel, timeLabel, startOfDay, formatBytes } from '../lib/util.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { $, el, favicon, toast, ICONS } from '../lib/ui.js';

const PAGE_SIZE = 40;
const MAX_RESULTS = 1000;
const engine = new SearchEngine();

const state = {
  q: '', range: 'all', from: '', to: '', sort: 'relevance',
  results: [], total: 0, shown: 0, query: null, selected: -1, seq: 0, tookMs: 0,
};
const texts = new Map(); // docId -> text (render cache)

const qInput = $('#q'), resultsEl = $('#results'), summaryEl = $('#summary'), moreBtn = $('#moreBtn'), emptyEl = $('#empty');

// ---- Init ---------------------------------------------------------------------------------------
$('#searchIcon').innerHTML = ICONS.search;
$('#helpBtn').innerHTML = ICONS.help;
$('#settingsLink').innerHTML = ICONS.gear;
$('#privacyNote').innerHTML = `${ICONS.lock}<span>Private: your index is stored only on this device and never uploaded.</span>`;

const params = new URLSearchParams(location.search);
state.q = params.get('q') || '';
state.range = params.get('range') || 'all';
state.from = params.get('from') || '';
state.to = params.get('to') || '';
state.sort = params.get('sort') === 'recent' ? 'recent' : 'relevance';
qInput.value = state.q;
$('#sort').value = state.sort;
$('#fromDate').value = state.from;
$('#toDate').value = state.to;
syncChips();

new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px')).observe($('.topbar'));

// ---- Search -------------------------------------------------------------------------------------
let debounce = null;
function scheduleSearch(delay = 90) {
  clearTimeout(debounce);
  debounce = setTimeout(runSearch, delay);
}

async function runSearch() {
  const seq = ++state.seq;
  const range = dateRange(state.range, { from: state.from, to: state.to });
  const res = await engine.search(state.q, { live: true, range, sort: state.sort, limit: MAX_RESULTS, browse: true });
  if (seq !== state.seq) return;
  state.results = res.results;
  state.total = res.total;
  state.query = res.query;
  state.tookMs = res.tookMs;
  state.shown = 0;
  state.selected = -1;
  resultsEl.replaceChildren();
  await renderMore(seq);
  updateUrl();
}

function updateUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.range !== 'all') p.set('range', state.range);
  if (state.range === 'custom') { if (state.from) p.set('from', state.from); if (state.to) p.set('to', state.to); }
  if (state.sort !== 'relevance') p.set('sort', state.sort);
  const s = p.toString();
  history.replaceState(null, '', s ? '?' + s : location.pathname);
  document.title = state.q ? `${state.q} – Total Recall` : 'Total Recall';
}

/** Order results into day groups. In relevance mode groups follow their best hit; in recent mode, chronology. */
function groupByDay(list) {
  const groups = new Map();
  for (const r of list) {
    const k = startOfDay(r.doc.lastVisit);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([day, items]) => ({ day, items }));
}

async function renderMore(seq = state.seq) {
  const next = state.results.slice(state.shown, state.shown + PAGE_SIZE);
  const need = next.map(r => r.doc.id).filter(id => !texts.has(id));
  if (need.length) for (const [id, t] of await getTexts(need)) texts.set(id, t);
  if (seq !== state.seq) return;

  // Re-group everything shown so far so day headers stay correct while paging.
  state.shown += next.length;
  const visible = state.results.slice(0, state.shown);
  const groups = groupByDay(visible);
  const frag = document.createDocumentFragment();
  let index = 0;
  const order = [];
  for (const g of groups) {
    const section = el('section', { class: 'day', 'aria-label': dayLabel(g.day) },
      el('h2', { class: 'day-head' }, dayLabel(g.day), el('span', { class: 'count', text: `${g.items.length} page${g.items.length === 1 ? '' : 's'}` })));
    for (const r of g.items) { section.append(renderResult(r, index++)); order.push(r); }
    frag.append(section);
  }
  // Keyboard order follows the visual order.
  const selectedId = state.results[state.selected]?.doc.id;
  state.results.splice(0, visible.length, ...order);
  resultsEl.replaceChildren(frag);
  if (selectedId != null) select(state.results.findIndex(r => r.doc.id === selectedId), false);
  moreBtn.hidden = state.shown >= state.results.length;
  await renderSummary();
}

function renderResult(r, i) {
  const d = r.doc;
  const { html, fragment } = makeSnippet(texts.get(d.id) || '', state.query || parseQuery(''));
  const href = fragmentUrl(d.url, fragment);
  let display = d.url.replace(/^https?:\/\/(www\.)?/, '');
  try { display = decodeURI(display); } catch { /* keep */ }
  const title = el('a', { class: 'result-title', href, target: '_blank', rel: 'noopener', tabindex: '-1', text: d.title || d.url });
  title.innerHTML = highlightTitle(d.title || d.url);
  const node = el('div', {
    class: 'result', role: 'option', id: 'r' + d.id, 'aria-selected': 'false', 'data-index': i,
  },
  favicon(d.url, d.domain),
  el('div', { class: 'result-main' },
    title,
    el('div', { class: 'result-meta' },
      el('span', { class: 'result-url', title: d.url, text: display }),
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('time', { datetime: new Date(d.lastVisit).toISOString(), title: new Date(d.lastVisit).toLocaleString(), text: timeLabel(d.lastVisit) }),
      d.visits > 1 ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
      d.visits > 1 ? el('span', { class: 'visits', text: `${d.visits} visits` }) : null),
    html ? el('p', { class: 'snippet', html }) : null),
  el('div', { class: 'result-actions' },
    el('button', { class: 'btn ghost', type: 'button', title: 'Copy link (c)', 'aria-label': 'Copy link', html: ICONS.copy, onclick: e => { e.stopPropagation(); copyLink(r); } }),
    el('button', { class: 'btn ghost', type: 'button', title: 'Forget this page (Delete)', 'aria-label': 'Forget this page', html: ICONS.trash, onclick: e => { e.stopPropagation(); forget(r); } })));
  node._href = href;
  node.addEventListener('click', e => {
    if (e.target.closest('a, button')) return;
    select(i, false);
    openResult(i, e.ctrlKey || e.metaKey ? 'background' : e.shiftKey ? 'current' : 'foreground');
  });
  node.addEventListener('mousemove', () => { if (state.selected !== i) select(i, false); });
  return node;
}

function highlightTitle(title) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!state.query) return esc(title);
  const { html } = makeSnippet(title, state.query, { maxWords: 1000 });
  return html || esc(title);
}

async function renderSummary() {
  const stats = await getStats();
  const q = state.query;
  const browsing = !q || isEmptyQuery(q);
  emptyEl.hidden = true;
  if (!stats.docs) {
    summaryEl.textContent = '';
    showEmpty('onboarding');
    return;
  }
  if (!state.results.length) {
    summaryEl.textContent = browsing ? 'Nothing visited in this period.' : 'No matches.';
    showEmpty(browsing ? 'no-period' : 'no-results');
    return;
  }
  const n = state.total;
  const ms = state.tookMs < 1 ? '<1' : Math.round(state.tookMs);
  summaryEl.textContent = browsing
    ? `Recently read · ${n.toLocaleString()} page${n === 1 ? '' : 's'} · ${stats.docs.toLocaleString()} indexed (${formatBytes(stats.bytes)})`
    : `${n >= MAX_RESULTS ? MAX_RESULTS.toLocaleString() + '+' : n.toLocaleString()} result${n === 1 ? '' : 's'} in ${ms} ms · searching ${stats.docs.toLocaleString()} pages`;
}

function showEmpty(kind) {
  emptyEl.hidden = false;
  if (kind === 'onboarding') {
    emptyEl.innerHTML = `
      <img class="big-icon" src="../icons/icon128.png" alt="">
      <h2>Your browsing memory starts now</h2>
      <p>Total Recall quietly saves the readable text of pages you visit so you can find them later, even if you only remember a few words.</p>
      <div class="tips">
        <div class="tip"><strong>Just browse</strong><p>Articles, docs and posts are indexed automatically a moment after they load.</p></div>
        <div class="tip"><strong>Search anything</strong><p>Use quotes for phrases, <code>-word</code> to exclude, <code>site:</code> and dates to narrow down.</p></div>
        <div class="tip"><strong>Stays on this device</strong><p>No account, no cloud, no tracking. Passwords, banking and excluded sites are skipped.</p></div>
      </div>
      <div class="actions"><a class="btn" href="../options/options.html">Privacy settings</a></div>`;
  } else if (kind === 'no-results') {
    const q = state.query;
    const hints = [];
    if (q.phrases.length) hints.push('remove the quotes to match words anywhere on the page');
    if (state.range !== 'all' || q.date || q.after || q.before) hints.push('widen the date range');
    if (q.sites.length) hints.push('drop the <code>site:</code> filter');
    hints.push('try fewer or different words');
    emptyEl.innerHTML = `<h2>No pages match</h2><p>Try to ${hints.join(', ')}.</p>`;
  } else {
    emptyEl.innerHTML = '<h2>No pages in this period</h2><p>Pick a wider date range.</p>';
  }
}

// ---- Selection & actions ------------------------------------------------------------------------
function select(i, scroll = true) {
  const nodes = resultsEl.querySelectorAll('.result');
  if (!nodes.length) { state.selected = -1; return; }
  i = Math.max(0, Math.min(i, nodes.length - 1));
  nodes[state.selected]?.setAttribute('aria-selected', 'false');
  state.selected = i;
  const n = nodes[i];
  n.setAttribute('aria-selected', 'true');
  qInput.setAttribute('aria-activedescendant', n.id);
  if (scroll) n.scrollIntoView({ block: 'nearest' });
}

function openResult(i, how = 'foreground') {
  const node = resultsEl.querySelectorAll('.result')[i];
  if (!node) return;
  const url = node._href;
  if (how === 'current') location.href = url;
  else chrome.tabs.create({ url, active: how !== 'background' });
}

async function copyLink(r) {
  try { await navigator.clipboard.writeText(r.doc.url); toast('Link copied'); } catch { toast('Could not copy link'); }
}

async function forget(r) {
  const text = texts.get(r.doc.id) ?? (await getTexts([r.doc.id])).get(r.doc.id) ?? '';
  const saved = { url: r.doc.url, title: r.doc.title, text, visitedAt: r.doc.lastVisit, firstVisit: r.doc.firstVisit, visits: r.doc.visits };
  await deleteDocs([r.doc.id]);
  const keep = state.selected;
  await runSearch();
  if (keep >= 0) select(keep);
  toast('Page forgotten', { label: 'Undo', run: async () => { await upsertPage(saved, { countVisit: false }); runSearch(); } });
}

// ---- Events -------------------------------------------------------------------------------------
qInput.addEventListener('input', () => { state.q = qInput.value; scheduleSearch(); });
moreBtn.addEventListener('click', () => renderMore());
$('#sort').addEventListener('change', e => { state.sort = e.target.value; runSearch(); });
$('#rangeChips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.range = b.dataset.range;
  syncChips();
  runSearch();
  if (state.range === 'custom' && !state.from) $('#fromDate').focus();
});
$('#rangeChips').addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const chips = [...document.querySelectorAll('.chip')];
  const i = chips.indexOf(document.activeElement);
  if (i < 0) return;
  const n = chips[(i + (e.key === 'ArrowRight' ? 1 : chips.length - 1)) % chips.length];
  n.focus(); n.click();
  e.preventDefault();
});
for (const id of ['fromDate', 'toDate']) $('#' + id).addEventListener('change', () => { state.from = $('#fromDate').value; state.to = $('#toDate').value; runSearch(); });

function syncChips() {
  for (const c of document.querySelectorAll('.chip')) {
    const on = c.dataset.range === state.range;
    c.setAttribute('aria-checked', String(on));
    c.tabIndex = on ? 0 : -1;
  }
  $('#customRange').hidden = state.range !== 'custom';
}

const helpEl = $('#help'), helpBtn = $('#helpBtn');
function toggleHelp(force) {
  const show = force ?? helpEl.hidden;
  helpEl.hidden = !show;
  helpBtn.setAttribute('aria-expanded', String(show));
}
helpBtn.addEventListener('click', () => toggleHelp());

document.addEventListener('keydown', e => {
  const inInput = e.target === qInput;
  const typing = !inInput && e.target.closest('input, select, textarea');
  if (typing) return;
  const count = resultsEl.querySelectorAll('.result').length;
  if (e.key === 'ArrowDown' || (!inInput && e.key === 'j')) {
    e.preventDefault();
    if (state.selected >= count - 1 && !moreBtn.hidden) renderMore().then(() => select(state.selected + 1));
    else select(state.selected + 1);
  } else if (e.key === 'ArrowUp' || (!inInput && e.key === 'k')) {
    e.preventDefault();
    if (state.selected <= 0) { state.selected = -1; resultsEl.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false'); qInput.focus(); window.scrollTo({ top: 0 }); }
    else select(state.selected - 1);
  } else if (e.key === 'Enter' && count) {
    if (e.target.closest('a, button') && !inInput) return;
    e.preventDefault();
    openResult(Math.max(0, state.selected), e.ctrlKey || e.metaKey ? 'background' : e.shiftKey ? 'current' : 'foreground');
  } else if (e.key === '/' && !inInput) {
    e.preventDefault(); qInput.focus(); qInput.select();
  } else if (e.key === 'Escape') {
    if (!helpEl.hidden) toggleHelp(false);
    else if (qInput.value) { qInput.value = ''; state.q = ''; runSearch(); qInput.focus(); }
    else qInput.blur();
  } else if (e.key === '?' && !inInput) {
    e.preventDefault(); toggleHelp();
  } else if (!inInput && state.selected >= 0 && e.key === 'Delete') {
    e.preventDefault(); forget(state.results[state.selected]);
  } else if (!inInput && state.selected >= 0 && e.key === 'c' && !e.ctrlKey && !e.metaKey) {
    copyLink(state.results[state.selected]);
  }
});

// Infinite scroll: load the next page when the button approaches the viewport.
new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting) && !moreBtn.hidden) renderMore(); }, { rootMargin: '400px' }).observe(moreBtn);

// Refresh when the index changes elsewhere (new pages, pruning) and the user isn't mid-navigation.
let lastVersion = null;
setInterval(async () => {
  if (document.hidden) return;
  const s = await getStats();
  if (lastVersion !== null && s.version !== lastVersion && state.selected < 0 && document.activeElement === qInput) runSearch();
  lastVersion = s.version;
}, 4000);

// Paused banner.
async function renderPaused() {
  const s = await getSettings();
  document.querySelector('.paused-banner')?.remove();
  if (!s.paused) return;
  const banner = el('div', { class: 'paused-banner', role: 'status' },
    el('span', { text: 'Indexing is paused. New pages are not being saved.' }),
    el('button', { class: 'btn', type: 'button', text: 'Resume', onclick: () => setSettings({ paused: false }) }));
  $('.summary-row').after(banner);
}
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings) renderPaused(); });
renderPaused();

qInput.focus();
runSearch();
