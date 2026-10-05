import { SearchEngine, makeSnippet, fragmentUrl } from '../lib/search.js';
import { getStats, getDocByUrl, getTexts } from '../lib/db.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { normalizeUrl, isExcluded, hostOf, formatBytes, relativeTime, startOfDay } from '../lib/util.js';
import { $, el, favicon, ICONS } from '../lib/ui.js';

const engine = new SearchEngine();
const qInput = $('#q'), quick = $('#quick'), allBtn = $('#allResults');
let tab = null;
let results = [];
let selected = -1;
let seq = 0;

$('#searchIcon').innerHTML = ICONS.search;
$('#settingsBtn').innerHTML = ICONS.gear;
$('#privacy').innerHTML = `${ICONS.lock}<span>Everything stays on this device.</span>`;

const send = msg => chrome.runtime.sendMessage(msg);
const openSearch = q => { send({ type: 'tr:openSearch', q }); window.close(); };

// ---- Quick search -------------------------------------------------------------------------------
let timer = null;
qInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(quickSearch, 80); });

async function quickSearch() {
  const my = ++seq;
  const q = qInput.value.trim();
  if (!q) { quick.hidden = true; allBtn.hidden = true; results = []; return; }
  const res = await engine.search(qInput.value, { live: true, limit: 5 });
  if (my !== seq) return;
  results = res.results;
  selected = -1;
  const texts = await getTexts(results.map(r => r.doc.id));
  if (my !== seq) return;
  quick.replaceChildren(...(results.length ? results.map((r, i) => {
    const { html, fragment } = makeSnippet(texts.get(r.doc.id) || '', res.query, { maxWords: 20 });
    const li = el('li', { role: 'option', id: 'qr' + i, 'aria-selected': 'false', title: r.doc.url },
      favicon(r.doc.url, r.doc.domain),
      el('div', { class: 't', text: r.doc.title || r.doc.url }),
      html ? el('div', { class: 's', html }) : null,
      el('div', { class: 'd', text: `${r.doc.domain} · ${relativeTime(r.doc.lastVisit)}` }));
    li._href = fragmentUrl(r.doc.url, fragment);
    li.addEventListener('click', e => openResult(i, e.ctrlKey || e.metaKey));
    return li;
  }) : [el('li', { class: 'none', text: 'No matching pages yet.' })]));
  quick.hidden = false;
  allBtn.hidden = !res.total;
  allBtn.textContent = res.total > results.length ? `See all ${res.total.toLocaleString()} results →` : 'Open in full search →';
}

function openResult(i, background = false) {
  const li = quick.querySelectorAll('li[role="option"]')[i];
  if (!li) return;
  chrome.tabs.create({ url: li._href, active: !background });
  if (!background) window.close();
}

function select(i) {
  const items = quick.querySelectorAll('li[role="option"]');
  if (!items.length) return;
  items[selected]?.setAttribute('aria-selected', 'false');
  selected = (i + items.length) % items.length;
  items[selected].setAttribute('aria-selected', 'true');
  qInput.setAttribute('aria-activedescendant', items[selected].id);
}

qInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
});
$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  if (selected >= 0) openResult(selected);
  else openSearch(qInput.value.trim());
});
allBtn.addEventListener('click', () => openSearch(qInput.value.trim()));
$('#openApp').addEventListener('click', () => openSearch(qInput.value.trim()));

// ---- Current page -------------------------------------------------------------------------------
const REASONS = {
  paused: 'Indexing is paused.',
  excluded: 'This site is on your excluded list.',
  sensitive: 'Skipped: looks like a login, payment or banking page.',
  incognito: 'Private windows are never indexed.',
  unsupported: 'Browser pages cannot be indexed.',
  'too-short': 'Not enough readable text on this page.',
  empty: 'No readable text found.',
  blocked: 'The browser does not allow reading this page.',
  context: 'Reload the page and try again.',
};

async function renderCurrent() {
  const s = await getSettings();
  const curState = $('#curState');
  const indexBtn = $('#indexNow'), forgetBtn = $('#forgetSite');
  curState.className = 'current-state';
  if (!tab) { $('#current').hidden = true; return; }
  const url = normalizeUrl(tab.url || '');
  $('#curTitle').textContent = tab.title || tab.url || 'Current page';
  $('#curFavicon').replaceChildren(url ? favicon(tab.url, hostOf(tab.url)) : el('span'));
  if (tab.incognito || !url) {
    curState.textContent = tab.incognito ? REASONS.incognito : REASONS.unsupported;
    indexBtn.disabled = forgetBtn.disabled = true;
    return;
  }
  forgetBtn.disabled = false;
  if (isExcluded(url, s.excludedDomains)) {
    curState.textContent = REASONS.excluded;
    curState.classList.add('warn');
    indexBtn.disabled = true;
    return;
  }
  indexBtn.disabled = false;
  const doc = await getDocByUrl(url);
  if (doc) {
    curState.textContent = `Indexed ${relativeTime(doc.lastVisit)}${doc.visits > 1 ? ` · ${doc.visits} visits` : ''}`;
    curState.classList.add('ok');
    indexBtn.textContent = 'Re-index this page';
  } else {
    curState.textContent = s.paused ? 'Not indexed (indexing is paused).' : 'Not indexed yet.';
    indexBtn.textContent = 'Index this page now';
  }
}

$('#indexNow').addEventListener('click', async () => {
  const b = $('#indexNow');
  b.disabled = true; b.textContent = 'Indexing…';
  const res = await send({ type: 'tr:indexTab', tabId: tab.id }).catch(() => ({ ok: false, reason: 'context' }));
  await renderCurrent();
  if (!res || !res.ok) {
    $('#curState').textContent = REASONS[res && res.reason] || 'Could not index this page.';
    $('#curState').className = 'current-state warn';
  } else {
    $('#curState').textContent = res.status === 'touched' ? 'Already up to date in your index.' : 'Saved to your index.';
  }
  b.disabled = false;
  renderStats();
});

$('#forgetSite').addEventListener('click', () => {
  const domain = hostOf(tab.url);
  $('#forgetText').textContent = `Delete every saved page from ${domain} and stop indexing it? You can undo the exclusion in Settings.`;
  $('#forgetConfirm').hidden = false;
  $('#forgetYes').focus();
});
$('#forgetNo').addEventListener('click', () => { $('#forgetConfirm').hidden = true; });
$('#forgetYes').addEventListener('click', async () => {
  const domain = hostOf(tab.url);
  const res = await send({ type: 'tr:forgetSite', domain, exclude: true });
  $('#forgetConfirm').hidden = true;
  await renderCurrent();
  $('#curState').textContent = `Forgot ${res && res.removed || 0} page${res && res.removed === 1 ? '' : 's'} from ${domain}. Site excluded.`;
  renderStats();
});

// ---- Pause toggle & stats -----------------------------------------------------------------------
async function renderToggle() {
  const s = await getSettings();
  $('#enabled').checked = !s.paused;
  const st = $('#status');
  st.textContent = s.paused ? 'Paused' : 'Recording';
  st.classList.toggle('paused', !!s.paused);
  $('#pauseSub').textContent = s.paused ? 'Paused. Nothing new is saved until you resume.' : 'Readable text is saved a moment after a page loads.';
}
$('#enabled').addEventListener('change', async e => { await setSettings({ paused: !e.target.checked }); renderToggle(); renderCurrent(); });

async function renderStats() {
  const [stats, s] = await Promise.all([getStats(), getSettings()]);
  $('#statPages').textContent = stats.docs.toLocaleString();
  $('#statSize').textContent = formatBytes(stats.bytes);
  $('#statSizeLabel').textContent = `of ${s.maxStorageMB >= 1024 ? (s.maxStorageMB / 1024).toFixed(1) + ' GB' : s.maxStorageMB + ' MB'} used`;
  await engine.refresh();
  const today = startOfDay();
  let n = 0;
  for (const d of engine.docs.values()) if (d.lastVisit >= today) n++;
  $('#statToday').textContent = n.toLocaleString();
}

(async () => {
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { tab = null; }
  renderToggle();
  renderCurrent();
  renderStats();
  qInput.focus();
})();
