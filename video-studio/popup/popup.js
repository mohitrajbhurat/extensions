import { icon, $, toTab, getSettings, saveSettings, toast } from '../lib/ui.js';

const VS = globalThis.VS;
const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4];
const LMIN = Math.log(VS.MIN_RATE);
const LMAX = Math.log(VS.MAX_RATE);

let tab = null;
let st = null;
let settings = VS.normalizeSettings({});

const toSlider = (r) => Math.round(((Math.log(r) - LMIN) / (LMAX - LMIN)) * 1000);
const fromSlider = (p) => {
  const r = Math.exp(LMIN + (p / 1000) * (LMAX - LMIN));
  return r < 1 ? Math.round(r * 100) / 100 : Math.round(r * 20) / 20;
};

function render() {
  const has = st && st.hasVideo;
  $('#video-card').hidden = !has;
  $('#no-video').hidden = !!has;
  $('#btn-shot').disabled = !has;
  if (!has) {
    if (st && st.error === 'no-content-script') {
      $('#nv-title').textContent = 'Not available on this page';
      $('#nv-text').textContent = 'Reload the page to start Video Studio here. Browser pages and extension stores cannot be controlled.';
    } else if (st && st.childHasVideo) {
      $('#nv-text').textContent = 'The video is inside an embedded player. Press play on it once, then reopen this popup.';
    }
  } else {
    $('#v-title').textContent = st.title || 'Untitled video';
    $('#v-meta').textContent = [st.site, `${VS.formatTime(st.time)} / ${st.duration ? VS.formatTime(st.duration) : '–:––'}`].filter(Boolean).join(' · ');
    $('#speed').textContent = st.rate.toFixed(2) + '×';
    if (document.activeElement !== $('#speed-range')) $('#speed-range').value = String(toSlider(st.rate));
    for (const b of document.querySelectorAll('#presets .btn')) b.classList.toggle('active', Math.abs(Number(b.dataset.r) - st.rate) < 0.001);
  }
  if (st && st.host) {
    $('#site-row').hidden = false;
    $('#site-name').textContent = st.host;
    $('#site-toggle').checked = !settings.disabledSites.some((d) => st.host === d || st.host.endsWith('.' + d));
  }
}

async function refresh() {
  if (!tab) return;
  st = await toTab(tab.id, { type: 'vs-get-state' });
  render();
}

async function act(msg) {
  const r = await toTab(tab.id, msg);
  if (r && r.hasVideo) { st = r; render(); }
  return r;
}

function setRate(r) {
  return act({ type: 'vs-set-rate', rate: VS.clampRate(r) });
}

async function init() {
  $('#btn-settings').innerHTML = icon('settings');
  $('#btn-slower').innerHTML = icon('minus');
  $('#btn-faster').innerHTML = icon('plus');
  $('#btn-notes').innerHTML = icon('note') + 'Notes';
  $('#btn-shot').innerHTML = icon('camera') + 'Snapshot';
  $('#btn-shot').title = 'Add a note with a screenshot of the current frame';
  $('#btn-library').innerHTML = icon('library') + 'Library';
  $('#presets').innerHTML = PRESETS.map((r) => `<button class="btn small" data-r="${r}">${r}×</button>`).join('');

  settings = await getSettings();
  const b = settings.bindings;
  const keys = [['slower', 'slower'], ['faster', 'faster'], ['reset', 'reset'], ['rewind', 'back'], ['advance', 'forward'], ['preferred', `${settings.preferredSpeed}×`], ['addNote', 'note'], ['screenshotNote', 'snapshot'], ['bookmark', 'bookmark']];
  $('#keys').innerHTML = keys.filter(([a]) => b[a]).map(([a, label]) => `<span><kbd>${VS.bindingLabel(b[a])}</kbd>${label}</span>`).join('');

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();

  $('#btn-slower').addEventListener('click', () => act({ type: 'vs-action', action: 'slower' }));
  $('#btn-faster').addEventListener('click', () => act({ type: 'vs-action', action: 'faster' }));
  $('#speed').addEventListener('click', () => act({ type: 'vs-action', action: 'reset' }));
  $('#speed-range').addEventListener('input', (e) => {
    const r = fromSlider(Number(e.target.value));
    $('#speed').textContent = r.toFixed(2) + '×';
    setRate(r);
  });
  $('#presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-r]');
    if (btn) setRate(Number(btn.dataset.r));
  });
  $('#speed-custom').addEventListener('change', (e) => {
    const r = Number(e.target.value);
    if (Number.isFinite(r) && r > 0) setRate(r);
  });

  $('#btn-notes').addEventListener('click', () => {
    // sidePanel.open must run synchronously inside the click (user gesture).
    if (chrome.sidePanel && chrome.sidePanel.open && settings.panelMode !== 'inpage') {
      chrome.sidePanel.open({ windowId: tab.windowId }).then(() => window.close(), () => openInpage());
    } else {
      openInpage();
    }
  });
  $('#btn-shot').addEventListener('click', async () => {
    const r = await act({ type: 'vs-action', action: 'screenshotNote', allowTab: true });
    if (r && r.result && r.result.ok) toast('Snapshot note saved');
    else toast('Could not save the snapshot note', { error: true });
  });
  $('#btn-library').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') });
    window.close();
  });
  $('#btn-settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('#site-toggle').addEventListener('change', async (e) => {
    const h = st.host;
    let list = settings.disabledSites.filter((d) => !(h === d || h.endsWith('.' + d)));
    if (!e.target.checked) list = list.concat(h);
    settings = await saveSettings({ disabledSites: list });
    toast(e.target.checked ? `Enabled on ${h}` : `Disabled on ${h}`);
  });
  setInterval(refresh, 1000);
}

async function openInpage() {
  const r = await chrome.runtime.sendMessage({ type: 'vs-open-inpage', tabId: tab.id, mode: 'open' });
  if (r && r.ok) window.close();
  else toast('Cannot open notes on this page. Try reloading it.', { error: true });
}

init();
