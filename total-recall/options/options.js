import { getSettings, setSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { getStats, exportPages, upsertPage, getDocByUrl, wipe } from '../lib/db.js';
import { cleanRule, formatBytes, normalizeUrl, isExcluded } from '../lib/util.js';
import { $, el, ICONS } from '../lib/ui.js';

$('#privacyIcon').innerHTML = ICONS.lock;
const send = msg => chrome.runtime.sendMessage(msg);
let savedTimer = null;
function flash(msg) {
  $('#saved').textContent = msg;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('#saved').textContent = ''; }, 3000);
}

function ensureOption(select, value, label) {
  if (![...select.options].some(o => o.value === String(value))) select.append(el('option', { value: String(value), text: label }));
  select.value = String(value);
}

async function render() {
  const s = await getSettings();
  $('#enabled').checked = !s.paused;
  $('#skipSensitive').checked = s.skipSensitive !== false;
  ensureOption($('#maxChars'), s.maxCharsPerPage, `${s.maxCharsPerPage.toLocaleString()} characters`);
  ensureOption($('#minChars'), s.minChars, `${s.minChars.toLocaleString()} characters`);
  ensureOption($('#retention'), s.retentionDays, `${s.retentionDays} days`);
  ensureOption($('#maxStorage'), s.maxStorageMB, `${s.maxStorageMB} MB`);
  renderDomains(s.excludedDomains);
  renderStorage(s);
}

function renderDomains(list) {
  const ul = $('#domainList');
  const sorted = [...list].sort((a, b) => cleanRule(a).localeCompare(cleanRule(b)));
  ul.replaceChildren(...(sorted.length ? sorted.map(d => el('li', {},
    el('span', { text: d }),
    el('button', { type: 'button', title: `Stop excluding ${d}`, 'aria-label': `Stop excluding ${d}`, text: '×', onclick: () => removeDomain(d) })))
    : [el('li', { class: 'empty', text: 'No excluded sites.' })]));
}

async function renderStorage(s) {
  s = s || await getSettings();
  const stats = await getStats();
  const max = s.maxStorageMB * 1024 * 1024;
  const pct = Math.min(100, (stats.bytes / max) * 100);
  $('#meterFill').style.width = pct.toFixed(1) + '%';
  $('#meterFill').classList.toggle('high', pct > 90);
  $('#meter').setAttribute('aria-valuenow', pct.toFixed(0));
  $('#meterText').textContent = `${stats.docs.toLocaleString()} pages · ${formatBytes(stats.bytes)} of ${formatBytes(max)}`;
  const { lastMaintenance } = await chrome.storage.local.get('lastMaintenance');
  $('#maintText').textContent = lastMaintenance
    ? `Last cleanup ${new Date(lastMaintenance.at).toLocaleString()} removed ${lastMaintenance.removed} page${lastMaintenance.removed === 1 ? '' : 's'}. Cleanup also runs automatically every few hours.`
    : 'Cleanup runs automatically every few hours.';
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      $('#meterText').title = `Browser reports ${formatBytes(est.usage || 0)} used by this extension on disk.`;
    } catch { /* ignore */ }
  }
}

// ---- Settings bindings --------------------------------------------------------------------------
const bind = (id, fn) => $(id).addEventListener('change', async e => { await setSettings(fn(e.target)); flash('Saved'); renderStorage(); });
bind('#enabled', t => ({ paused: !t.checked }));
bind('#skipSensitive', t => ({ skipSensitive: t.checked }));
bind('#maxChars', t => ({ maxCharsPerPage: Number(t.value) }));
bind('#minChars', t => ({ minChars: Number(t.value) }));
bind('#retention', t => ({ retentionDays: Number(t.value) }));
bind('#maxStorage', t => ({ maxStorageMB: Number(t.value) }));

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const raw = $('#newDomain').value;
  const rule = cleanRule(raw);
  if (!rule || !/^[a-z0-9.-]+\.[a-z0-9-]+(\/.*)?$|^localhost(\/.*)?$/i.test(rule)) { flash('Enter a domain such as example.com'); $('#newDomain').focus(); return; }
  const s = await getSettings();
  if (s.excludedDomains.map(cleanRule).includes(rule)) { flash(`${rule} is already excluded`); return; }
  await setSettings({ excludedDomains: [...s.excludedDomains, rule] });
  $('#newDomain').value = '';
  let msg = `Excluded ${rule}`;
  if ($('#purgeOnAdd').checked && !rule.includes('/')) {
    const res = await send({ type: 'tr:forgetSite', domain: rule, exclude: false });
    if (res && res.removed) msg += ` and deleted ${res.removed} saved page${res.removed === 1 ? '' : 's'}`;
  }
  flash(msg);
  render();
});

async function removeDomain(d) {
  const s = await getSettings();
  await setSettings({ excludedDomains: s.excludedDomains.filter(x => x !== d) });
  flash(`${d} will be indexed again`);
  render();
}

$('#cleanNow').addEventListener('click', async () => {
  const b = $('#cleanNow');
  b.disabled = true; b.textContent = 'Cleaning…';
  const res = await send({ type: 'tr:maintenance' });
  b.disabled = false; b.textContent = 'Clean up now';
  flash(`Cleanup removed ${res && res.removed || 0} page${res && res.removed === 1 ? '' : 's'}`);
  renderStorage();
});

// ---- Export / import ----------------------------------------------------------------------------
function progress(done, total, label) {
  $('#progress').hidden = false;
  $('#progressFill').style.width = total ? (done / total * 100).toFixed(1) + '%' : '100%';
  $('#progressText').textContent = label;
}

$('#exportBtn').addEventListener('click', async () => {
  const b = $('#exportBtn');
  b.disabled = true;
  try {
    const settings = await getSettings();
    const parts = [`{"format":"total-recall","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"settings":${JSON.stringify(settings)},"pages":[`];
    let first = true;
    const count = await exportPages((batch, done, total) => {
      for (const p of batch) { parts.push((first ? '' : ',') + JSON.stringify(p)); first = false; }
      progress(done, total, `Exporting ${done.toLocaleString()} of ${total.toLocaleString()} pages…`);
    });
    parts.push(']}');
    const blob = new Blob(parts, { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `total-recall-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    progress(1, 1, `Exported ${count.toLocaleString()} pages (${formatBytes(blob.size)}).`);
  } catch (e) {
    progress(0, 1, 'Export failed: ' + e.message);
  } finally { b.disabled = false; }
});

$('#importLabel').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#importFile').click(); } });
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  progress(0, 1, `Reading ${file.name}…`);
  let data;
  try { data = JSON.parse(await file.text()); } catch { progress(0, 1, 'That file is not valid JSON.'); return; }
  if (!data || data.format !== 'total-recall' || !Array.isArray(data.pages)) { progress(0, 1, 'That file is not a Total Recall export.'); return; }
  if ($('#importSettings').checked && data.settings && typeof data.settings === 'object') {
    const clean = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in data.settings && typeof data.settings[k] === typeof DEFAULT_SETTINGS[k]) clean[k] = data.settings[k];
    if (Array.isArray(clean.excludedDomains)) clean.excludedDomains = clean.excludedDomains.map(String).filter(Boolean);
    await setSettings(clean);
  }
  const s = await getSettings();
  let added = 0, skipped = 0;
  const total = data.pages.length;
  for (let i = 0; i < total; i++) {
    const p = data.pages[i] || {};
    const url = normalizeUrl(String(p.url || ''));
    if (!url || isExcluded(url, s.excludedDomains)) { skipped++; continue; }
    const lastVisit = Number(p.lastVisit) || Date.now();
    const existing = await getDocByUrl(url);
    if (existing && existing.lastVisit >= lastVisit) { skipped++; continue; }
    await upsertPage({
      url, title: String(p.title || '').slice(0, 500), text: String(p.text || '').slice(0, s.maxCharsPerPage),
      visitedAt: lastVisit, firstVisit: Number(p.firstVisit) || lastVisit, visits: Math.max(1, Number(p.visits) || 1),
    }, { countVisit: false });
    added++;
    if (i % 20 === 0) progress(i + 1, total, `Importing ${(i + 1).toLocaleString()} of ${total.toLocaleString()} pages…`);
  }
  progress(1, 1, `Imported ${added.toLocaleString()} page${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped.toLocaleString()} (already newer, excluded or invalid)` : ''}.`);
  render();
});

// ---- Wipe ---------------------------------------------------------------------------------------
$('#wipeBtn').addEventListener('click', async () => {
  const stats = await getStats();
  $('#wipeCount').textContent = `${stats.docs.toLocaleString()} saved page${stats.docs === 1 ? '' : 's'} (${formatBytes(stats.bytes)})`;
  $('#wipeConfirm').hidden = false;
  $('#wipeNo').focus();
});
$('#wipeNo').addEventListener('click', () => { $('#wipeConfirm').hidden = true; });
$('#wipeYes').addEventListener('click', async () => {
  await wipe();
  $('#wipeConfirm').hidden = true;
  flash('All saved pages were deleted.');
  renderStorage();
});

chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings) render(); });
render();
