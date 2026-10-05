// Reading Studio service worker: injects features on demand, relays chrome.tts, handles shortcuts,
// context menus, and keeps the dark-mode content script registered for sites the user granted.
import './common/defaults.js';

const S = globalThis.RS_SETTINGS;

const FULL_FILES = [
  'common/defaults.js', 'content/shared.js', 'content/readability.js', 'content/segmenter.js',
  'content/darkmode.js', 'content/focus.js', 'content/tts.js', 'content/reader.js', 'content/main.js'
];
const DARK_FILES = ['common/defaults.js', 'content/shared.js', 'content/darkmode.js'];
const DARK_SCRIPT_ID = 'rs-dark';

// ------------------------------------------------------------------ injection
function isRestricted(url) {
  if (!url) return true;
  return /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted):/i.test(url) ||
    /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url);
}

async function ensureInjected(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId: 0 });
    if (r && r.full) return;
  } catch (e) { /* not injected yet */ }
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: FULL_FILES });
}

async function runInTab(tabId, action, args) {
  try {
    await ensureInjected(tabId);
    const res = await chrome.tabs.sendMessage(tabId, { action, args: args || {} }, { frameId: 0 });
    return res || { ok: false, error: 'No response from page' };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}

function friendlyError(e) {
  const m = String(e && e.message || e);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission/i.test(m)) return 'Reading Studio cannot run on this page (browser pages and web stores are protected).';
  if (/file:/.test(m)) return 'To use Reading Studio on local files, enable "Allow access to file URLs" for the extension.';
  return m;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ------------------------------------------------------------------ dark mode helpers
async function toggleDarkForTab(tab, forceValue) {
  if (!tab || isRestricted(tab.url)) return { ok: false, error: 'Not available on this page' };
  let host;
  try { host = new URL(tab.url).hostname; } catch (e) { return { ok: false, error: 'Invalid page' }; }
  let active = false;
  const st = await runInTab(tab.id, 'dark-state');
  if (st && st.ok && st.result) active = !!st.result.active;
  const next = typeof forceValue === 'boolean' ? forceValue : !active;
  await S.setSiteRule(host || location.hostname, 'dark', next ? 'on' : 'off');
  // The content script listens to storage changes; nudge it in case it was just injected.
  const res = await runInTab(tab.id, 'dark-evaluate');
  return { ok: true, active: next, state: res && res.result };
}

async function syncDarkRegistration() {
  try {
    const { origins = [] } = await chrome.permissions.getAll();
    const matches = origins.filter((o) => o === '<all_urls>' || /^(\*|https?|file):\/\//.test(o));
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DARK_SCRIPT_ID] }).catch(() => []);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DARK_SCRIPT_ID] });
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts([{
      id: DARK_SCRIPT_ID,
      js: DARK_FILES,
      matches,
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true
    }]);
  } catch (e) {
    console.warn('[Reading Studio] could not register dark mode script', e);
  }
}

// ------------------------------------------------------------------ TTS relay
let activePort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rs-tts') return;
  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'speak') {
      if (activePort && activePort !== port) { try { activePort.postMessage({ type: 'preempted' }); } catch (e) { /* closed */ } }
      activePort = port;
      const o = msg.opts || {};
      const id = msg.id;
      const send = (payload) => { try { port.postMessage(Object.assign({ id }, payload)); } catch (e) { /* port closed */ } };
      const options = {
        rate: o.rate || 1,
        pitch: o.pitch || 1,
        volume: o.volume == null ? 1 : o.volume,
        enqueue: false,
        onEvent: (ev) => send({ event: ev.type, charIndex: ev.charIndex, length: ev.length, error: ev.errorMessage })
      };
      if (o.voiceName) options.voiceName = o.voiceName;
      if (o.lang) options.lang = o.lang;
      try {
        chrome.tts.speak(msg.text, options, () => {
          if (chrome.runtime.lastError) send({ event: 'error', error: chrome.runtime.lastError.message });
        });
      } catch (e) {
        send({ event: 'error', error: String(e && e.message || e) });
      }
    } else if (msg.type === 'stop') {
      if (activePort === port) chrome.tts.stop();
    }
  });
  port.onDisconnect.addListener(() => {
    if (activePort === port) { chrome.tts.stop(); activePort = null; }
  });
});

// ------------------------------------------------------------------ messages from popup/options
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  (async () => {
    switch (msg.type) {
      case 'get-voices': {
        const voices = await new Promise((resolve) => {
          try { chrome.tts.getVoices((v) => resolve(v || [])); } catch (e) { resolve([]); }
        });
        return { voices: voices.map((v) => ({ voiceName: v.voiceName, lang: v.lang, remote: !!v.remote, extensionId: v.extensionId })) };
      }
      case 'tab-action': {
        const tabId = msg.tabId || (await activeTab() || {}).id;
        if (!tabId) return { ok: false, error: 'No tab' };
        return runInTab(tabId, msg.action, msg.args);
      }
      case 'toggle-dark': {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : await activeTab();
        return toggleDarkForTab(tab, msg.value);
      }
      case 'sync-registration':
        await syncDarkRegistration();
        return { ok: true };
      case 'test-preview-tts': {
        chrome.tts.speak(msg.text || 'This is how this voice sounds.', { voiceName: msg.voiceName || undefined, rate: msg.rate || 1, enqueue: false });
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// ------------------------------------------------------------------ commands + context menu
chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || await activeTab();
  if (!tab || isRestricted(tab.url)) return;
  if (command === 'toggle-reader') await runInTab(tab.id, 'reader-toggle');
  else if (command === 'read-aloud') await runInTab(tab.id, 'tts-toggle');
  else if (command === 'toggle-dark') await toggleDarkForTab(tab);
  else if (command === 'toggle-ruler') await runInTab(tab.id, 'ruler-toggle');
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'rs-read-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'rs-read-page', title: 'Read this page aloud', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'rs-reader', title: 'Open in Reader view', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'rs-dark', title: 'Toggle dark mode on this site', contexts: ['page'] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || isRestricted(tab.url)) return;
  if (info.menuItemId === 'rs-read-selection') await runInTab(tab.id, 'tts-start', { source: 'selection' });
  else if (info.menuItemId === 'rs-read-page') await runInTab(tab.id, 'tts-start', { source: 'article' });
  else if (info.menuItemId === 'rs-reader') await runInTab(tab.id, 'reader-open');
  else if (info.menuItemId === 'rs-dark') await toggleDarkForTab(tab);
});

// ------------------------------------------------------------------ lifecycle
chrome.runtime.onInstalled.addListener(async (details) => {
  createMenus();
  await syncDarkRegistration();
  if (details.reason === 'install') {
    // Seed settings so the options page and content scripts agree from the start.
    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings) await chrome.storage.sync.set({ settings: S.clone(S.DEFAULTS) });
  }
});
chrome.runtime.onStartup.addListener(() => { syncDarkRegistration(); });
chrome.permissions.onAdded.addListener(() => syncDarkRegistration());
chrome.permissions.onRemoved.addListener(() => syncDarkRegistration());
