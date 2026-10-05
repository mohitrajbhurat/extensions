import { createEditor, requestAccess } from '../lib/editor.js';
import {
  getMonitorList, getSettings, send, isWatchableUrl, hostOf, statusOf, STATUS_LABEL, relTime, escapeHtml,
} from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const DRAFT_TTL = 30 * 60 * 1000;

let tab = null;
let editor = null;
let settings = null;

function show(view) {
  for (const v of ['home', 'editor', 'saved']) $(`view-${v}`).hidden = v !== view;
  $('stats').parentElement.hidden = view !== 'home';
}

function sameSite(a, b) {
  try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; }
}

function monItem(m) {
  const st = statusOf(m);
  const li = document.createElement('li');
  const meta = st === 'error' || st === 'needs_permission'
    ? m.error || STATUS_LABEL[st]
    : m.lastChange ? `Changed ${relTime(m.lastChange)}` : `Checked ${relTime(m.lastCheck)}`;
  li.innerHTML = `
    <button class="mon" title="${escapeHtml(m.url)}">
      <span class="name">${escapeHtml(m.name)}</span>
      <span class="side">${m.unread ? `<span class="count-badge" aria-label="${m.unread} unread">${m.unread}</span>` : ''}
        <span class="pill ${st}">${STATUS_LABEL[st]}</span></span>
      <span class="meta">${escapeHtml(meta)}</span>
    </button>`;
  li.querySelector('button').addEventListener('click', () => {
    send('dashboard:open', { hash: 'm=' + encodeURIComponent(m.id) }).then(() => window.close());
  });
  return li;
}

async function renderHome() {
  const list = await getMonitorList();
  const supported = tab && isWatchableUrl(tab.url || '');
  $('cur-host').textContent = supported ? hostOf(tab.url) : (tab && tab.title) || 'Unsupported page';
  $('cur-host').title = (tab && tab.url) || '';
  $('cur-unsupported').hidden = !!supported;
  $('cur-actions').hidden = !supported;

  const site = supported ? list.filter((m) => sameSite(m.url, tab.url)) : [];
  $('site-section').hidden = !site.length;
  $('site-list').replaceChildren(...site.map(monItem));

  const unread = list.filter((m) => m.unread > 0 && !site.includes(m)).sort((a, b) => (b.lastChange || 0) - (a.lastChange || 0)).slice(0, 5);
  $('recent-section').hidden = !list.some((m) => m.unread > 0);
  $('recent-list').replaceChildren(...unread.map(monItem));
  $('empty').hidden = list.length > 0;

  const active = list.filter((m) => !m.paused).length;
  $('stats').textContent = list.length ? `${list.length} monitor${list.length === 1 ? '' : 's'} · ${active} active` : '';
  $('check-all').hidden = !active;
}

function openEditor(draft) {
  show('editor');
  const picked = draft.selector != null && draft.preview != null;
  $('picked').hidden = !picked;
  if (picked) {
    $('picked-label').textContent = draft.selector
      ? `Selected on the page · ${draft.count} match${draft.count === 1 ? '' : 'es'}`
      : 'Whole page';
    $('picked-text').textContent = (draft.preview || '(no text)').slice(0, 1200);
  }
  const canPick = tab && isWatchableUrl(tab.url || '') && sameSite(tab.url, draft.url);
  editor = createEditor($('editor'), {
    url: draft.url,
    name: (draft.title || '').trim().slice(0, 80),
    selector: draft.selector || '',
    interval: settings.defaultInterval,
    notify: true,
    sound: false,
  }, {
    settings,
    showUrl: true,
    onPick: canPick ? () => startPicker() : null,
    pickLabel: 'Re-pick',
  });
  editor.focus();
}

async function clearDraft() {
  await chrome.storage.local.remove('draft');
}

async function startPicker() {
  $('pick-error').hidden = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/extract.js', 'content/picker.js'] });
    window.close();
  } catch (e) {
    show('home');
    $('pick-error').textContent = 'This page cannot be scripted (browser pages and the extension store are protected). ' + (e.message || '');
    $('pick-error').hidden = false;
  }
}

function save() {
  let m;
  try { m = editor.get(); } catch (e) { editor.showError(e.message); return; }
  // Request site access inside the click gesture, and save in parallel so the monitor is
  // kept even if the permission prompt closes this popup.
  const access = requestAccess(m.url);
  const btn = $('editor-save');
  btn.disabled = true;
  const saved = send('monitor:save', { monitor: m });
  Promise.all([access, saved]).then(async ([granted, res]) => {
    await clearDraft();
    show('saved');
    $('saved-text').textContent = granted
      ? `“${res.monitor.name}” is checked ${labelFor(res.monitor.interval)}. You will be alerted when it changes.`
      : `Saved “${res.monitor.name}”, but site access was not granted. Grant it from the dashboard to start background checks.`;
    $('saved-dashboard').onclick = () => send('dashboard:open', { hash: 'm=' + encodeURIComponent(res.monitor.id) }).then(() => window.close());
  }).catch((e) => {
    editor.showError(e.message);
  }).finally(() => { btn.disabled = false; });
}

function labelFor(min) {
  if (min < 60) return min === 1 ? 'every minute' : `every ${min} minutes`;
  if (min === 60) return 'every hour';
  if (min === 1440) return 'once a day';
  return `every ${Math.round(min / 60)} hours`;
}

async function init() {
  settings = await getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $('open-dashboard').addEventListener('click', () => send('dashboard:open').then(() => window.close()));
  $('pick').addEventListener('click', startPicker);
  $('whole').addEventListener('click', () => openEditor({ url: tab.url, title: tab.title, selector: '' }));
  $('editor-back').addEventListener('click', async () => { await clearDraft(); show('home'); renderHome(); });
  $('editor-cancel').addEventListener('click', async () => { await clearDraft(); show('home'); renderHome(); });
  $('editor-save').addEventListener('click', save);
  $('saved-done').addEventListener('click', () => { show('home'); renderHome(); });
  $('mark-all').addEventListener('click', () => send('monitor:markAllRead'));
  $('check-all').addEventListener('click', async () => {
    $('check-all').disabled = true;
    $('check-all').textContent = 'Checking…';
    await send('monitor:checkAll').catch(() => {});
    $('check-all').disabled = false;
    $('check-all').textContent = 'Check all';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('view-editor').hidden) save();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.monitors && !$('view-home').hidden) renderHome();
  });

  const { draft } = await chrome.storage.local.get('draft');
  if (draft && Date.now() - (draft.createdAt || 0) < DRAFT_TTL && isWatchableUrl(draft.url)) {
    openEditor(draft);
  } else {
    show('home');
    await renderHome();
  }
}

init();
