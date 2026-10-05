// Toolbar popup: screenshot launcher, recording setup and live recording controls.
import { formatDuration } from '../lib/util.js';

const $ = id => document.getElementById(id);
const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|devtools|view-source|chrome-search|chrome-untrusted):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;
const DEFAULTS = { mode: 'tab', mic: true, tabAudio: true, webcam: false, camSize: 'medium', countdown: 3, micId: '', camId: '' };

let tab = null;
let opts = { ...DEFAULTS };
let rec = null;
let localTimer = null;

function send(msg) { return chrome.runtime.sendMessage(msg); }

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = (await chrome.storage.local.get('recOptions')).recOptions || {};
  opts = { ...DEFAULTS, ...stored };
  applyOptsToUi();

  const restricted = !tab || (tab.url && RESTRICTED.test(tab.url));
  if (restricted) {
    document.querySelectorAll('[data-shot]').forEach(b => { b.disabled = true; });
    $('shot-hint').textContent = 'The browser does not allow capturing this page. Window and screen recording still work.';
  }

  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find(x => x.name === 'capture-screenshot');
    if (c && c.shortcut) $('shortcut').textContent = c.shortcut;
    else $('shot-hint').textContent = restricted ? $('shot-hint').textContent : 'Tip: set a keyboard shortcut under Shortcuts.';
  } catch { /* ignore */ }

  const state = await send({ type: 'rec-get' }).catch(() => null);
  if (state && state.lastError) showError(state.lastError.message);
  setRec(state ? state.rec : null);
  fillDevices();
}

function applyOptsToUi() {
  document.querySelector(`input[name=mode][value="${opts.mode}"]`).checked = true;
  $('opt-mic').checked = !!opts.mic;
  $('opt-audio').checked = !!opts.tabAudio;
  $('opt-cam').checked = !!opts.webcam;
  $('cam-size').value = opts.camSize;
  $('opt-countdown').value = String(opts.countdown);
  syncUi();
}

function syncUi() {
  $('audio-label').textContent = opts.mode === 'tab' ? 'Tab audio' : 'System audio';
  $('cam-sub').hidden = !opts.webcam;
  $('mic-device').hidden = !opts.mic || $('mic-device').options.length < 2;
  const restricted = !tab || (tab.url && RESTRICTED.test(tab.url));
  const blocked = opts.mode === 'tab' && restricted;
  $('start').disabled = blocked;
  $('rec-hint').textContent = blocked
    ? 'This page cannot be recorded as a tab. Choose Window or Full screen.'
    : opts.mode === 'tab'
      ? 'Records this tab. You can keep browsing other tabs while it records.'
      : 'A recorder tab opens where you pick the ' + (opts.mode === 'window' ? 'window' : 'screen') + ' to share.';
}

function saveOpts() {
  chrome.storage.local.set({ recOptions: opts });
  syncUi();
}

async function fillDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const fill = (select, kind, current, fallback) => {
    const list = devices.filter(d => d.kind === kind && d.deviceId);
    select.innerHTML = '';
    const def = new Option(fallback, '');
    select.appendChild(def);
    list.forEach((d, i) => {
      if (d.deviceId === 'default' || d.deviceId === 'communications') return;
      select.appendChild(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId));
    });
    select.value = [...select.options].some(o => o.value === current) ? current : '';
  };
  fill($('mic-device'), 'audioinput', opts.micId, 'Default microphone');
  fill($('cam-device'), 'videoinput', opts.camId, 'Default camera');
  syncUi();
}

/* ---------------- recording state ---------------- */
function setRec(next) {
  rec = next;
  const live = !!rec;
  $('live').hidden = !live;
  $('idle').hidden = live;
  clearInterval(localTimer);
  if (!live) return;
  const dot = $('live-dot');
  dot.className = 'dot';
  $('btn-pause').hidden = false;
  $('btn-stop').hidden = false;
  $('btn-focus').hidden = !rec.recorderTabId;
  $('btn-pause').disabled = !(rec.state === 'recording' || rec.state === 'paused');
  $('btn-stop').disabled = rec.state === 'saving';
  $('btn-pause').textContent = rec.state === 'paused' ? 'Resume' : 'Pause';
  let label = 'Recording';
  let hint = 'Use the toolbar button any time to pause or stop.';
  if (rec.state === 'paused') { label = 'Paused'; dot.classList.add('paused'); }
  else if (rec.state === 'countdown') { label = `Starting in ${rec.n}`; dot.classList.add('waiting'); }
  else if (rec.state === 'saving') { label = 'Saving'; dot.classList.add('waiting'); hint = 'Saving to your library...'; }
  else if (rec.state === 'setup' || rec.state === 'starting') {
    label = 'Waiting to start'; dot.classList.add('waiting');
    hint = rec.mode === 'tab' ? 'Starting the tab recorder...' : 'Choose what to share in the recorder tab.';
    $('btn-pause').hidden = true;
    $('btn-stop').hidden = true;
  }
  $('live-label').textContent = label;
  $('live-hint').textContent = hint;
  if (!discardArmed) $('btn-discard').textContent = rec.state === 'setup' ? 'Cancel' : 'Discard';
  let elapsed = rec.elapsed || 0;
  $('live-timer').textContent = formatDuration(elapsed);
  if (rec.state === 'recording') {
    const base = Date.now();
    localTimer = setInterval(() => { $('live-timer').textContent = formatDuration(elapsed + Date.now() - base); }, 250);
  }
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'rec-state') setRec(msg.rec);
});

/* ---------------- errors ---------------- */
function showError(message) {
  $('error-text').textContent = message;
  $('error').hidden = false;
}
$('error-close').addEventListener('click', () => {
  $('error').hidden = true;
  send({ type: 'clear-error' }).catch(() => {});
});

/* ---------------- actions ---------------- */
document.querySelectorAll('[data-shot]').forEach(btn => btn.addEventListener('click', async () => {
  await send({ type: 'shot', kind: btn.dataset.shot, tabId: tab && tab.id });
  window.close();
}));

document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => { opts.mode = r.value; saveOpts(); }));
$('opt-mic').addEventListener('change', e => { opts.mic = e.target.checked; saveOpts(); });
$('opt-audio').addEventListener('change', e => { opts.tabAudio = e.target.checked; saveOpts(); });
$('opt-cam').addEventListener('change', e => { opts.webcam = e.target.checked; saveOpts(); });
$('cam-size').addEventListener('change', e => { opts.camSize = e.target.value; saveOpts(); });
$('opt-countdown').addEventListener('change', e => { opts.countdown = Number(e.target.value); saveOpts(); });
$('mic-device').addEventListener('change', e => { opts.micId = e.target.value; saveOpts(); });
$('cam-device').addEventListener('change', e => { opts.camId = e.target.value; saveOpts(); });

async function permissionState(name) {
  try { return (await navigator.permissions.query({ name })).state; } catch { return 'prompt'; }
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try {
    if (opts.mode === 'tab') {
      // The offscreen recorder and the in-page bubble cannot show permission prompts.
      const need = [];
      if (opts.mic && (await permissionState('microphone')) !== 'granted') need.push('mic');
      if (opts.webcam && (await permissionState('camera')) !== 'granted') need.push('cam');
      if (need.length) {
        await chrome.tabs.create({ url: chrome.runtime.getURL(`permissions/permissions.html?need=${need.join(',')}`) });
        window.close();
        return;
      }
    }
    const res = await send({ type: 'rec-start', tabId: tab && tab.id, opts });
    if (res && res.error) throw new Error(res.error);
    window.close();
  } catch (e) {
    showError(e.message);
    $('start').disabled = false;
  }
});

async function control(action) {
  const res = await send({ type: 'rec-control', action }).catch(e => ({ error: e.message }));
  if (res && res.error) showError(res.error);
  if (action === 'stop' || action === 'cancel' || action === 'focus') window.close();
}
$('btn-pause').addEventListener('click', () => control(rec && rec.state === 'paused' ? 'resume' : 'pause'));
$('btn-stop').addEventListener('click', () => control('stop'));
let discardArmed = false;
$('btn-discard').addEventListener('click', () => {
  // Two-step confirmation (dialogs are unreliable inside popups).
  if (rec && rec.state !== 'setup' && !discardArmed) {
    discardArmed = true;
    $('btn-discard').textContent = 'Click again to discard';
    setTimeout(() => { discardArmed = false; if (rec) $('btn-discard').textContent = 'Discard'; }, 3000);
    return;
  }
  control('cancel');
});
$('btn-focus').addEventListener('click', () => control('focus'));

const openPage = path => { chrome.tabs.create({ url: chrome.runtime.getURL(path) }); window.close(); };
$('open-library').addEventListener('click', () => openPage('library/library.html'));
$('go-library').addEventListener('click', () => openPage('library/library.html'));
$('go-editor').addEventListener('click', () => openPage('editor/editor.html'));
$('go-shortcuts').addEventListener('click', () => { chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); window.close(); });

init();
