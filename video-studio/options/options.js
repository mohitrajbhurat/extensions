import * as db from '../lib/db.js';
import { $, toast, getSettings } from '../lib/ui.js';
import { escapeHtml as escapeAttr } from '../lib/markdown.js';

const VS = globalThis.VS;
let settings = VS.normalizeSettings({});
let listening = null; // action whose key is being recorded

const NUMBER_FIELDS = ['defaultSpeed', 'preferredSpeed', 'speedStep', 'seekSeconds', 'screenshotMaxWidth'];
const RANGE_FIELDS = ['overlayOpacity', 'screenshotQuality'];
const CHECK_FIELDS = ['rememberPerSite', 'forceSpeed', 'pauseWhileTyping', 'openPanelOnNote', 'autoTabCapture'];
const SELECT_FIELDS = ['overlayMode', 'overlayPosition', 'panelMode'];

let savedTimer = null;
async function save(patch) {
  const next = Object.assign({}, settings, patch);
  await chrome.storage.sync.set({ settings: next });
  settings = VS.normalizeSettings(next);
  const el = $('#saved');
  el.textContent = 'Saved';
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function fill() {
  for (const f of NUMBER_FIELDS) if (document.activeElement !== $('#' + f)) $('#' + f).value = settings[f];
  for (const f of RANGE_FIELDS) $('#' + f).value = settings[f];
  for (const f of CHECK_FIELDS) $('#' + f).checked = !!settings[f];
  for (const f of SELECT_FIELDS) $('#' + f).value = settings[f];
  $('#opacity-val').textContent = Math.round(settings.overlayOpacity * 100) + '%';
  $('#quality-val').textContent = Math.round(settings.screenshotQuality * 100) + '%';
  if (document.activeElement !== $('#disabledSites')) $('#disabledSites').value = settings.disabledSites.join('\n');
  renderBindings();
}

function conflicts() {
  const seen = new Map();
  const bad = new Set();
  for (const [a, b] of Object.entries(settings.bindings)) {
    if (!b) continue;
    const k = VS.bindingLabel(b);
    if (seen.has(k)) { bad.add(a); bad.add(seen.get(k)); } else seen.set(k, a);
  }
  return bad;
}

function renderBindings() {
  const bad = conflicts();
  let html = '';
  let group = '';
  for (const [action, meta] of Object.entries(VS.ACTIONS)) {
    if (meta.group !== group) { group = meta.group; html += `<div class="bind-group">${group}</div>`; }
    const b = settings.bindings[action];
    const cls = ['btn', 'small', 'key'];
    if (!b) cls.push('unset');
    if (bad.has(action)) cls.push('conflict');
    if (listening === action) cls.push('listening');
    const label = listening === action ? 'Press a key…' : VS.bindingLabel(b);
    html += `<div class="bind"><span>${meta.label}</span>
      <button class="${cls.join(' ')}" data-action="${action}" aria-label="Shortcut for ${escapeAttr(meta.label)}: ${escapeAttr(label)}">${label}</button>
      <button class="btn ghost small" data-clear="${action}" title="Remove shortcut" ${b ? '' : 'disabled'}>Clear</button></div>`;
  }
  $('#bindings').innerHTML = html;
  if (listening) $(`#bindings [data-action="${listening}"]`).focus();
}

async function renderSites() {
  const { siteSpeeds = {} } = await chrome.storage.local.get('siteSpeeds');
  const entries = Object.entries(siteSpeeds).sort((a, b) => a[0].localeCompare(b[0]));
  $('#site-speeds').innerHTML = entries.length
    ? entries.map(([h, r]) => `<li><span>${escapeAttr(h)}</span><span class="rate">${Number(r).toFixed(2)}×</span><button class="btn ghost small" data-forget="${escapeAttr(h)}">Forget</button></li>`).join('')
    : '<li class="none">No sites yet. Change the speed on a site and it is remembered here.</li>';
}

async function renderPermission() {
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('#perm-btn').textContent = has ? 'Revoke' : 'Grant';
  $('#perm-btn').dataset.has = has ? '1' : '';
}

async function renderUsage() {
  try {
    const [videos, counts] = await Promise.all([db.listVideos(), db.countNotesByVideo()]);
    const notes = Object.values(counts).reduce((a, b) => a + b, 0);
    let size = '';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      size = ` using about ${(est.usage / 1048576).toFixed(1)} MB`;
    }
    $('#usage').textContent = `${videos.length} video${videos.length === 1 ? '' : 's'} and ${notes} note${notes === 1 ? '' : 's'}${size}.`;
  } catch (e) {
    $('#usage').textContent = 'Storage information is unavailable.';
  }
}

function bind() {
  for (const f of NUMBER_FIELDS) $('#' + f).addEventListener('change', (e) => save({ [f]: Number(e.target.value) }).then(fill));
  for (const f of RANGE_FIELDS) $('#' + f).addEventListener('input', (e) => save({ [f]: Number(e.target.value) }).then(fill));
  for (const f of CHECK_FIELDS) $('#' + f).addEventListener('change', (e) => save({ [f]: e.target.checked }));
  for (const f of SELECT_FIELDS) $('#' + f).addEventListener('change', (e) => save({ [f]: e.target.value }));
  $('#disabledSites').addEventListener('change', (e) => {
    const list = e.target.value.split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    save({ disabledSites: Array.from(new Set(list)) }).then(fill);
  });

  $('#bindings').addEventListener('click', (e) => {
    const keyBtn = e.target.closest('[data-action]');
    const clearBtn = e.target.closest('[data-clear]');
    if (keyBtn) { listening = listening === keyBtn.dataset.action ? null : keyBtn.dataset.action; renderBindings(); }
    if (clearBtn) {
      const bindings = Object.assign({}, settings.bindings, { [clearBtn.dataset.clear]: null });
      save({ bindings }).then(fill);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!listening) return;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const action = listening;
    listening = null;
    if (e.key === 'Escape') { renderBindings(); return; }
    let b = { code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    if (e.key === 'Backspace' || e.key === 'Delete') b = null;
    const bindings = Object.assign({}, settings.bindings, { [action]: b });
    save({ bindings }).then(() => {
      fill();
      if (conflicts().has(action)) toast(`${VS.bindingLabel(b)} is already used by another action`, { error: true });
    });
  }, true);
  $('#reset-keys').addEventListener('click', () => save({ bindings: VS.defaultBindings() }).then(fill));
  $('#open-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  $('#site-speeds').addEventListener('click', async (e) => {
    const h = e.target.closest('[data-forget]');
    if (!h) return;
    const { siteSpeeds = {} } = await chrome.storage.local.get('siteSpeeds');
    delete siteSpeeds[h.dataset.forget];
    await chrome.storage.local.set({ siteSpeeds });
    renderSites();
  });

  $('#perm-btn').addEventListener('click', async (e) => {
    try {
      if (e.target.dataset.has) {
        await chrome.permissions.remove({ origins: ['<all_urls>'] });
        toast('Tab capture permission removed');
      } else {
        const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
        toast(ok ? 'Tab capture fallback is ready' : 'Permission was not granted', { error: !ok });
      }
    } catch (err) {
      toast(String(err.message || err), { error: true });
    }
    renderPermission();
  });

  $('#clear-data').addEventListener('click', async () => {
    const ok = confirm('Delete every note, screenshot and bookmark for all videos? Export a JSON backup from the library first if you may need them. This cannot be undone.');
    if (!ok) return;
    await db.clearAll();
    toast('All notes deleted');
    renderUsage();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) { settings = VS.normalizeSettings(changes.settings.newValue); fill(); }
    if (area === 'local' && changes.siteSpeeds) renderSites();
  });
}

async function init() {
  settings = await getSettings();
  fill();
  bind();
  renderSites();
  renderPermission();
  renderUsage();
  const sp = !!(chrome.sidePanel && chrome.sidePanel.open);
  $('#sidepanel-support').textContent = sp
    ? 'This browser supports the side panel.'
    : 'This browser has no side panel API, so notes open in a panel inside the page.';
}

init();
