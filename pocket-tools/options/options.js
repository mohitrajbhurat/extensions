// Pocket Tools settings page.

import { getSettings, saveSettings, DEFAULTS, HOST_ORIGINS } from '../lib/settings.js';
import { allZones, localZone, isValidZone } from '../lib/timeutil.js';

const $ = s => document.querySelector(s);
let savedTimer = null;

function flashSaved(msg = 'Saved') {
  $('#saved').textContent = msg;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('#saved').textContent = ''), 1600);
}

async function save(patch) {
  await saveSettings(patch);
  flashSaved();
}

async function tooltipStatus(settings) {
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: HOST_ORIGINS }); } catch { /* ignore */ }
  $('#tooltip').checked = Boolean(settings.tooltip && granted);
  $('#tooltip-status').textContent = granted
    ? 'Site access granted.'
    : 'Site access not granted.';
}

async function renderShortcuts() {
  const list = $('#shortcuts');
  list.replaceChildren();
  let commands = [];
  try { commands = await chrome.commands.getAll(); } catch { /* not available */ }
  for (const c of commands) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = c.name === '_execute_action' ? 'Open Pocket Tools' : c.description;
    const key = document.createElement('kbd');
    key.textContent = c.shortcut || 'Not set';
    li.append(name, key);
    list.append(li);
  }
}

async function load() {
  const s = await getSettings();
  $('#clear-seconds').value = String(s.clearSeconds);
  if (!$('#clear-seconds').value) $('#clear-seconds').value = '30';
  $('#home-zone').value = s.homeZone;
  $('#detected-zone').textContent = localZone();
  $('#work-start').value = s.workStart;
  $('#work-end').value = s.workEnd;
  await tooltipStatus(s);
}

async function init() {
  $('#zones').replaceChildren(...allZones().map(z => Object.assign(document.createElement('option'), { value: z })));
  await load();
  renderShortcuts();

  $('#clear-seconds').addEventListener('change', e => save({ clearSeconds: Number(e.target.value) }));

  $('#tooltip').addEventListener('change', async e => {
    if (e.target.checked) {
      let ok = false;
      try { ok = await chrome.permissions.request({ origins: HOST_ORIGINS }); } catch { ok = false; }
      if (!ok) {
        e.target.checked = false;
        flashSaved('Site access was not granted.');
        return;
      }
      await save({ tooltip: true });
    } else {
      await save({ tooltip: false });
      // Hand the site access back when the feature is off.
      try { await chrome.permissions.remove({ origins: HOST_ORIGINS }); } catch { /* ignore */ }
    }
    chrome.runtime.sendMessage({ type: 'tooltip:sync' }).catch(() => {});
    tooltipStatus(await getSettings());
  });

  $('#home-zone').addEventListener('change', e => {
    const v = e.target.value.trim();
    const err = $('#zone-error');
    if (v && !isValidZone(v)) {
      err.textContent = `“${v}” is not a time zone this browser knows. Pick one from the list, e.g. Europe/Paris.`;
      err.classList.remove('hidden');
      return;
    }
    err.classList.add('hidden');
    save({ homeZone: v });
  });

  const hours = () => {
    const start = Math.min(23, Math.max(0, Number($('#work-start').value) || 0));
    const end = Math.min(24, Math.max(start + 1, Number($('#work-end').value) || 17));
    $('#work-start').value = start;
    $('#work-end').value = end;
    save({ workStart: start, workEnd: end });
  };
  $('#work-start').addEventListener('change', hours);
  $('#work-end').addEventListener('change', hours);

  $('#open-shortcuts').addEventListener('click', () => {
    const isEdge = navigator.userAgent.includes('Edg/');
    chrome.tabs.create({ url: isEdge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' });
  });

  $('#reset').addEventListener('click', async () => {
    await chrome.storage.sync.set({ settings: structuredClone(DEFAULTS) });
    chrome.runtime.sendMessage({ type: 'tooltip:sync' }).catch(() => {});
    await load();
    flashSaved('Settings reset');
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderShortcuts(); });
}

init();
