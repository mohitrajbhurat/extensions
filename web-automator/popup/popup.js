import { ICONS } from '../shared/icons.js';
import { getMacros, getSettings, saveSettings } from '../lib/storage.js';
import { exportMacros } from '../lib/importexport.js';
import { describeSchedule } from '../lib/scheduler.js';

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
let state = { recording: null, runs: [], siteAccess: false };
let macros = [];
let activeTab = null;

$('openEditor').innerHTML = ICONS.external;
$('recIco').innerHTML = ICONS.record;
$('stopIco').innerHTML = ICONS.stop;

function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2500);
}

async function refreshState() {
  const r = await send({ type: 'wa:getState' });
  if (r && r.ok) state = r;
  renderState();
}

function renderState() {
  $('permCard').hidden = state.siteAccess;
  const rec = state.recording;
  $('recIdle').hidden = !!rec;
  $('recActive').hidden = !rec;
  if (rec) {
    const here = activeTab && activeTab.id === rec.tabId;
    $('recText').textContent = `Recording · ${rec.count} step${rec.count === 1 ? '' : 's'}${here ? '' : ' (in another tab)'}`;
  }
  $('recordBtn').disabled = !state.siteAccess;
  const run = state.runs.find(r => r.status === 'running');
  $('runCard').hidden = !run;
  if (run) renderRun(run);
}

function renderRun(run) {
  $('runName').textContent = run.macroName;
  $('runBadge').textContent = run.paused ? 'Paused' : 'Running';
  $('runBar').style.width = `${Math.round(((run.stepIndex + 1) / Math.max(1, run.total)) * 100)}%`;
  $('runMeta').textContent = `Step ${run.stepIndex + 1} of ${run.total}${run.csvRows ? ` · CSV row ${run.csvRow} of ${run.csvRows}` : ''}${run.extractedCount ? ` · ${run.extractedCount} data rows` : ''}`;
  $('pauseBtn').textContent = run.paused ? 'Resume' : 'Pause';
  $('runSpeed').value = run.speed;
  $('runCard').dataset.runId = run.id;
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('list');
  list.textContent = '';
  const shown = macros.filter(m => !q || m.name.toLowerCase().includes(q));
  $('empty').hidden = macros.length > 0;
  for (const m of shown) {
    const li = document.createElement('li');
    li.className = 'item';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.name;
    name.title = m.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${m.steps.length} steps`;
    if (m.csv) sub.append(' · CSV');
    if (m.schedule && m.schedule.enabled) sub.append(' · ' + describeSchedule(m.schedule));
    meta.append(name, sub);
    const play = document.createElement('button');
    play.className = 'btn sm icon ghost play';
    play.innerHTML = ICONS.play;
    play.title = `Play "${m.name}" in this tab`;
    play.setAttribute('aria-label', play.title);
    play.addEventListener('click', () => playMacro(m, false));
    li.append(meta);
    if (m.csv) {
      const csv = document.createElement('button');
      csv.className = 'btn sm ghost';
      csv.textContent = 'CSV';
      csv.title = 'Play once per CSV row';
      csv.addEventListener('click', () => playMacro(m, true));
      li.append(csv);
    }
    const edit = document.createElement('button');
    edit.className = 'btn sm icon ghost';
    edit.innerHTML = ICONS.edit;
    edit.title = `Edit "${m.name}"`;
    edit.setAttribute('aria-label', edit.title);
    edit.addEventListener('click', () => { send({ type: 'wa:openEditor', query: `?macro=${m.id}` }); window.close(); });
    li.append(play, edit);
    list.append(li);
  }
}

async function playMacro(m, useCsv) {
  if (!state.siteAccess) { toast('Allow site access first', true); return; }
  const r = await send({ type: 'wa:play', macroId: m.id, tabId: activeTab && activeTab.id, useCsv });
  if (!r || !r.ok) toast((r && r.error) || 'Could not start', true);
  else { toast('Running…'); refreshState(); }
}

$('grant').addEventListener('click', async () => {
  try {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (ok) toast('Access granted');
  } catch (e) { toast(e.message, true); }
  refreshState();
});

$('recordBtn').addEventListener('click', async () => {
  await saveSettings({ recordKeystrokes: $('keystrokes').checked });
  const r = await send({ type: 'wa:startRecording', tabId: activeTab && activeTab.id });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not start recording', true); return; }
  window.close();
});

$('stopRecBtn').addEventListener('click', async () => {
  const r = await send({ type: 'wa:stopRecording' });
  if (r && r.ok && r.result) {
    send({ type: 'wa:openEditor', query: `?macro=${r.result.macroId}` });
    window.close();
  } else refreshState();
});

$('keystrokes').addEventListener('change', e => saveSettings({ recordKeystrokes: e.target.checked }));
$('pauseBtn').addEventListener('click', () => {
  const run = state.runs.find(r => r.id === $('runCard').dataset.runId);
  if (run) send({ type: 'wa:control', runId: run.id, action: run.paused ? 'resume' : 'pause' }).then(refreshState);
});
$('stopRunBtn').addEventListener('click', () => send({ type: 'wa:control', runId: $('runCard').dataset.runId, action: 'stop' }).then(refreshState));
$('runSpeed').addEventListener('change', e => send({ type: 'wa:control', runId: $('runCard').dataset.runId, action: 'speed', arg: e.target.value }));
$('search').addEventListener('input', renderList);
$('openEditor').addEventListener('click', () => { send({ type: 'wa:openEditor' }); window.close(); });
$('editorBtn').addEventListener('click', () => { send({ type: 'wa:openEditor' }); window.close(); });
// File pickers close extension popups, so importing happens in the editor.
$('importBtn').addEventListener('click', () => { send({ type: 'wa:openEditor', query: '?import=1' }); window.close(); });
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([exportMacros(macros)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `web-automator-macros-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'wa:recState') { state.recording = msg.rec; renderState(); }
  if (msg.type === 'wa:runEvent' && msg.run) {
    const i = state.runs.findIndex(r => r.id === msg.run.id);
    if (msg.run.status === 'running') { if (i >= 0) state.runs[i] = msg.run; else state.runs.push(msg.run); renderRun(msg.run); renderState(); }
    else { if (i >= 0) state.runs.splice(i, 1); renderState(); if (!msg.entry) toast(`${msg.run.macroName}: ${msg.run.status}`, msg.run.status === 'failed'); }
  }
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.macros) { macros = ch.macros.newValue || []; renderList(); }
});

(async () => {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await getSettings();
  $('keystrokes').checked = settings.recordKeystrokes;
  macros = await getMacros();
  renderList();
  await refreshState();
})();
