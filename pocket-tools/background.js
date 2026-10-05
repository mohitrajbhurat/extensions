// Pocket Tools service worker: context menus, keyboard commands, the
// selection-conversion tooltip registration and clipboard auto-clear.

import { getSettings, saveSettings, HOST_ORIGINS } from './lib/settings.js';
import { convertText } from './lib/convert.js';
import { generatePassword, generatePronounceable, generatePassphrase } from './lib/password.js';
import { WORDS } from './lib/wordlist.js';

const TOOLTIP_SCRIPT_ID = 'pocket-tools-tooltip';
const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// ------------------------------------------------------------- context menus

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = props => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
    add({ id: 'convert-selection', title: 'Convert “%s”', contexts: ['selection'] });
    add({ id: 'qr-selection', title: 'QR code for selected text', contexts: ['selection'] });
    add({ id: 'count-selection', title: 'Count words in selection', contexts: ['selection'] });
    add({ id: 'qr-link', title: 'QR code for this link', contexts: ['link'] });
    add({ id: 'qr-page', title: 'QR code for this page', contexts: ['page', 'frame'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  syncTooltipRegistration();
});
chrome.runtime.onStartup.addListener(() => syncTooltipRegistration());

// Reads the live selection (keeps line breaks, which info.selectionText collapses).
function pageSelection() {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|tel|email)$/i.test(el.type)))) {
    try { return el.value.substring(el.selectionStart, el.selectionEnd); } catch { /* unsupported input */ }
  }
  return String(window.getSelection() || '');
}

async function readSelection(tabId, frameId, fallback) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      func: pageSelection,
    });
    if (res && typeof res.result === 'string' && res.result.trim()) return res.result;
  } catch { /* restricted page */ }
  return fallback || '';
}

// Hands state to the popup and opens it (as a small window where
// action.openPopup is unavailable, e.g. older Chromium builds).
async function openPopupWith(pending) {
  await chrome.storage.session.set({ pending: { ...pending, at: Date.now() } });
  try {
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      return;
    }
  } catch { /* no focused window or not allowed here */ }
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup/popup.html?window=1'),
    type: 'popup',
    width: 420,
    height: 680,
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab && tab.id;
  switch (info.menuItemId) {
    case 'convert-selection':
      await showConversion(tab, info.frameId, info.selectionText);
      break;
    case 'qr-selection': {
      const text = tabId ? await readSelection(tabId, info.frameId, info.selectionText) : info.selectionText;
      await openPopupWith({ tab: 'qr', qr: { mode: 'text', text } });
      break;
    }
    case 'count-selection': {
      const text = tabId ? await readSelection(tabId, info.frameId, info.selectionText) : info.selectionText;
      await openPopupWith({ tab: 'text', text });
      break;
    }
    case 'qr-link':
      await openPopupWith({ tab: 'qr', qr: { mode: 'text', text: info.linkUrl } });
      break;
    case 'qr-page':
      await openPopupWith({ tab: 'qr', qr: { mode: 'text', text: info.frameUrl || info.pageUrl || (tab && tab.url) || '' } });
      break;
  }
});

// ---------------------------------------------------------------- converting

async function convertWithSettings(text) {
  const s = await getSettings();
  return convertText(text, { zones: s.cities, homeZone: s.homeZone || undefined });
}

// Injects the tooltip (activeTab grant) and shows conversions for the selection.
async function showConversion(tab, frameId = 0, fallbackText = '') {
  if (!tab || tab.id === undefined) return;
  const text = (await readSelection(tab.id, frameId, fallbackText)).trim();
  const result = await convertWithSettings(text);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ['content/tooltip.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'pt-tooltip:show', text, result }, { frameId });
  } catch {
    // Restricted page (store, chrome://, PDF viewer): use the popup instead.
    await openPopupWith({ tab: 'convert', text });
  }
}

// ------------------------------------------------------------------ commands

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'convert-selection') {
    const [active] = tab ? [tab] : await chrome.tabs.query({ active: true, currentWindow: true });
    await showConversion(active, 0, '');
  } else if (command === 'copy-password') {
    const s = await getSettings();
    const g = s.generator;
    let value;
    try {
      if (g.type === 'passphrase') value = generatePassphrase(g, WORDS).value;
      else if (g.type === 'pronounceable') value = generatePronounceable(g).value;
      else value = generatePassword(g).value;
    } catch {
      value = generatePassword({}).value;
    }
    await copyViaOffscreen(value, s.clearSeconds);
  } else if (command === 'qr-page') {
    const [active] = tab ? [tab] : await chrome.tabs.query({ active: true, currentWindow: true });
    await openPopupWith({ tab: 'qr', qr: { mode: 'page', text: active && active.url ? active.url : '' } });
  }
});

// --------------------------------------------------------- clipboard (offscreen)

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (existing.length) return true;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['CLIPBOARD'],
      justification: 'Copy generated passwords and clear them from the clipboard after a delay.',
    }).catch(err => {
      if (!/single offscreen/i.test(String(err && err.message))) throw err;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
  return true;
}

async function copyViaOffscreen(text, clearSeconds) {
  if (!(await ensureOffscreen())) return false;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text, clearAfterMs: clearSeconds > 0 ? clearSeconds * 1000 : 0 });
  return true;
}

async function scheduleClear(clearSeconds) {
  if (!(clearSeconds > 0)) return false;
  if (!(await ensureOffscreen())) return false;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'schedule-clear', clearAfterMs: clearSeconds * 1000 });
  return true;
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const respond = p => p.then(sendResponse, err => sendResponse({ error: String(err && err.message || err) }));
  switch (msg.type) {
    case 'convert':
      respond(convertWithSettings(String(msg.text || '').slice(0, 200)).then(result => ({ result })));
      return true;
    case 'clipboard:schedule-clear':
      respond(getSettings().then(s => scheduleClear(msg.seconds ?? s.clearSeconds)).then(ok => ({ ok })));
      return true;
    case 'clipboard:copy':
      respond(getSettings().then(s => copyViaOffscreen(String(msg.text || ''), msg.seconds ?? s.clearSeconds)).then(ok => ({ ok })));
      return true;
    case 'offscreen:idle':
      closeOffscreen();
      return false;
    case 'tooltip:sync':
      respond(syncTooltipRegistration().then(enabled => ({ enabled })));
      return true;
    default:
      return false;
  }
});

// ------------------------------------------------- auto tooltip registration

// Serialised: permission and storage events can fire together.
let syncChain = Promise.resolve(false);
function syncTooltipRegistration() {
  syncChain = syncChain.catch(() => false).then(doSyncTooltip);
  return syncChain;
}

async function doSyncTooltip() {
  if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return false;
  const settings = await getSettings();
  const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS }).catch(() => false);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [TOOLTIP_SCRIPT_ID] }).catch(() => []);
  const want = settings.tooltip && granted;
  if (want && !existing.length) {
    await chrome.scripting.registerContentScripts([{
      id: TOOLTIP_SCRIPT_ID,
      js: ['content/tooltip.js'],
      matches: HOST_ORIGINS,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
    // Make it work in already-open tabs without a reload.
    const tabs = await chrome.tabs.query({ url: HOST_ORIGINS });
    await Promise.all(tabs.map(t => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/tooltip.js'] }).catch(() => {})));
  } else if (!want && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [TOOLTIP_SCRIPT_ID] });
  }
  if (settings.tooltip && !granted) await saveSettings({ tooltip: false });
  return want;
}

chrome.permissions.onAdded.addListener(() => syncTooltipRegistration());
chrome.permissions.onRemoved.addListener(() => syncTooltipRegistration());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    const before = changes.settings.oldValue && changes.settings.oldValue.tooltip;
    const after = changes.settings.newValue && changes.settings.newValue.tooltip;
    if (before !== after) syncTooltipRegistration();
  }
});
