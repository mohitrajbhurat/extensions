import { STYLES, formatCitation } from '../lib/formatters.js';
import { getSettings, setSettings, getItems, getProjects, exportAll, importAll, clearAll } from '../lib/storage.js';
import { LOOKUP_ORIGINS, hasLookupPermission } from '../lib/lookup.js';
import { download, toast, applyTheme } from '../lib/dom.js';

const $ = id => document.getElementById(id);

const SAMPLE = {
  type: 'article-journal',
  authors: [{ given: 'Ada', family: 'Lovelace' }, { given: 'Charles', family: 'Babbage' }],
  title: 'Notes on the Analytical Engine and Its Uses in Science',
  container: 'Journal of Computing History', volume: '12', issue: '3', pages: '45-67', date: '2021-03-05',
  doi: '10.1234/jch.2021.0045',
};

let settings;

function renderSample() {
  $('sample').innerHTML = formatCitation(SAMPLE, settings.style, { sentenceCase: settings.sentenceCase }).html;
  $('sample').classList.toggle('hanging', settings.style !== 'ieee');
}

async function renderSummary() {
  const [items, projects] = await Promise.all([getItems(), getProjects()]);
  $('data-summary').textContent = `${items.length} citation${items.length === 1 ? '' : 's'} in ${projects.length} project${projects.length === 1 ? '' : 's'}, stored locally in this browser.`;
}

async function renderOnline() {
  const granted = await hasLookupPermission();
  $('online').checked = settings.onlineLookup && granted;
  $('online-status').textContent = settings.onlineLookup && granted
    ? 'Online lookup is on.'
    : 'Online lookup is off. Everything works offline from page metadata.';
}

async function init() {
  settings = await getSettings();
  applyTheme(settings.theme);
  $('style').replaceChildren(...STYLES.map(s => new Option(s.label, s.id, false, s.id === settings.style)));
  $('sentence-case').checked = settings.sentenceCase;
  $('theme').value = settings.theme || 'auto';
  renderSample();
  await renderOnline();
  await renderSummary();
}

$('style').addEventListener('change', async e => { settings = await setSettings({ style: e.target.value }); renderSample(); toast('Saved'); });
$('sentence-case').addEventListener('change', async e => { settings = await setSettings({ sentenceCase: e.target.checked }); renderSample(); toast('Saved'); });
$('theme').addEventListener('change', async e => { settings = await setSettings({ theme: e.target.value }); applyTheme(settings.theme); });

$('online').addEventListener('change', async e => {
  if (e.target.checked) {
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: LOOKUP_ORIGINS }); } catch { granted = false; }
    settings = await setSettings({ onlineLookup: granted });
    if (!granted) toast('Permission not granted; online lookup stays off', { tone: 'error' });
  } else {
    try { await chrome.permissions.remove({ origins: LOOKUP_ORIGINS }); } catch { /* already removed */ }
    settings = await setSettings({ onlineLookup: false });
  }
  await renderOnline();
});

$('backup').addEventListener('click', async () => {
  const data = await exportAll();
  const d = new Date().toISOString().slice(0, 10);
  download(`citation-builder-backup-${d}.json`, JSON.stringify(data, null, 2), 'application/json');
});

$('restore').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const added = await importAll(data);
    toast(`Restored ${added} citation${added === 1 ? '' : 's'}`);
    renderSummary();
  } catch (err) {
    toast(err.message || 'Could not read that file', { tone: 'error' });
  }
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete every citation and project? Download a backup first if you might need them.')) return;
  await clearAll();
  toast('All citations deleted');
  renderSummary();
});

$('open-manager').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') }));

chrome.storage.onChanged.addListener(() => renderSummary());

init();
