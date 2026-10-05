/* Type Kit service worker: storage owner, clipboard history writer, picker command,
 * system clipboard reads (offscreen document, only with the optional clipboardRead permission). */
importScripts('shared/store.js', 'shared/engine.js');

const S = self.TKStore;
const CONTENT_FILES = ['shared/engine.js', 'content/content.js'];
const PRUNE_ALARM = 'tk-prune-clips';

/* ---------- install / startup ---------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  await S.loadAll();                       // seeds starter snippets on first run
  chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
  await injectIntoOpenTabs();
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html#welcome') });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
  S.getClips().catch(() => {});
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === PRUNE_ALARM) S.getClips().catch(() => {});
});

/** Make expansion work in tabs that were open before install/update (best effort). */
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch (e) { return; }
  await Promise.all(tabs.map((t) => chrome.scripting.executeScript({
    target: { tabId: t.id, allFrames: true }, files: CONTENT_FILES,
  }).catch(() => {})));
}

async function ensureContent(tabId) {
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'tk:ping' }, { frameId: 0 }).catch(() => null);
  if (alive && alive.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      return true;
    } catch (err) { return false; }
  }
}

/* ---------- focused frame tracking (for popup inserts) ---------- */

const focusFrames = new Map();
async function rememberFocus(tabId, frameId) {
  focusFrames.set(tabId, frameId);
  try { await chrome.storage.session.set({ ['focus.' + tabId]: frameId }); } catch (e) { /* ignore */ }
}
async function focusedFrame(tabId) {
  if (focusFrames.has(tabId)) return focusFrames.get(tabId);
  try {
    const v = await chrome.storage.session.get('focus.' + tabId);
    return v['focus.' + tabId] || 0;
  } catch (e) { return 0; }
}
chrome.tabs.onRemoved.addListener((tabId) => {
  focusFrames.delete(tabId);
  chrome.storage.session.remove('focus.' + tabId).catch(() => {});
});

/* ---------- commands ---------- */

async function openPicker(tab, filter) {
  if (!tab || tab.id == null) return;
  const msg = { type: 'tk:open-picker', filter };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'tk:ping' }, { frameId: 0 });
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  } catch (e) {
    if (await ensureContent(tab.id)) {
      setTimeout(() => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}), 150);
    } else {
      // Pages extensions cannot script (chrome://, the Web Store): fall back to the popup UI.
      chrome.action.openPopup().catch(() => {});
    }
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-picker') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  openPicker(tab);
});

/* ---------- system clipboard (optional permission) ---------- */

let creatingOffscreen = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen/offscreen.html');
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (ctx.length) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url, reasons: ['CLIPBOARD'], justification: 'Read the clipboard for the {clipboard} snippet placeholder',
    }).catch((e) => { if (!/single offscreen/i.test(String(e && e.message))) throw e; })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function readSystemClipboard() {
  try {
    if (!chrome.offscreen || !(await chrome.permissions.contains({ permissions: ['clipboardRead'] }))) return null;
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'tk-offscreen', type: 'read-clipboard' });
    return res && typeof res.text === 'string' ? res.text : null;
  } catch (e) {
    return null;
  }
}

/* ---------- messages ---------- */

const handlers = {
  async 'tk:get-data'() {
    const { snippets, settings } = await S.loadAll();
    return { ok: true, snippets, settings, clips: await S.getClips() };
  },
  async 'tk:get-clips'() {
    return { ok: true, clips: await S.getClips() };
  },
  async 'tk:add-clip'(msg, sender) {
    if (sender.tab && sender.tab.incognito) return { ok: false, skipped: 'incognito' };
    if (!sender.tab && sender.id !== chrome.runtime.id) return { ok: false };
    return S.addClip({ text: msg.text, url: msg.url || (sender.tab && sender.tab.url) || '', title: msg.title || '' });
  },
  async 'tk:touch-clip'(msg) {
    const clips = await S.getClips();
    const c = clips.find((x) => x.id === msg.id);
    if (!c) return { ok: false };
    await S.updateClip(c.id, { createdAt: S.nowISO(), uses: (c.uses || 0) + 1 });
    return { ok: true };
  },
  async 'tk:update-clip'(msg) {
    const patch = {};
    if (msg.patch && typeof msg.patch.pinned === 'boolean') patch.pinned = msg.patch.pinned;
    return { ok: !!(await S.updateClip(msg.id, patch)) };
  },
  async 'tk:record-use'(msg) {
    await S.recordUse(msg.id, Number(msg.insertedLength) || 0, Number(msg.shortcutLength) || 0);
    return { ok: true };
  },
  async 'tk:read-clipboard'() {
    return { ok: true, text: await readSystemClipboard() };
  },
  async 'tk:focus'(msg, sender) {
    if (sender.tab) await rememberFocus(sender.tab.id, sender.frameId || 0);
    return { ok: true };
  },
  async 'tk:insert-in-tab'(msg) {
    // From the popup: deliver an insert request to the frame that last had a focused field.
    const tabId = msg.tabId;
    if (!(await ensureContent(tabId))) return { ok: false, reason: 'no-access' };
    const payload = { type: 'tk:insert', kind: msg.kind, id: msg.id, text: msg.text };
    const frameId = await focusedFrame(tabId);
    let res = await chrome.tabs.sendMessage(tabId, payload, { frameId }).catch(() => null);
    if ((!res || !res.ok) && frameId !== 0) res = await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }).catch(() => null);
    return res || { ok: false, reason: 'no-field' };
  },
  async 'tk:open-picker-in-tab'(msg) {
    const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
    await openPicker(tab, msg.filter);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'tk-offscreen') return false;
  const fn = handlers[msg.type];
  if (!fn) return false;
  Promise.resolve().then(() => fn(msg, sender)).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});
