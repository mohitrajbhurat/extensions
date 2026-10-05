// Video Studio service worker: routes messages between pages and content scripts, writes
// notes created from in-page shortcuts, opens the notes panel and performs the
// tab-capture screenshot fallback.
import './lib/defaults.js';
import * as db from './lib/db.js';

const VS = globalThis.VS;
const events = new BroadcastChannel('vs-events');

// ---------- settings ----------
async function getSettings() {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    return VS.normalizeSettings(settings);
  } catch (_) {
    return VS.normalizeSettings({});
  }
}

// ---------- which frame in a tab holds the video ----------
// tabId -> { [frameId]: { seen, play } }. Mirrored to storage.session so it survives
// service worker restarts.
let frames = null;
async function loadFrames() {
  if (frames) return frames;
  try {
    const { vsFrames } = await chrome.storage.session.get('vsFrames');
    frames = vsFrames || {};
  } catch (_) {
    frames = {};
  }
  return frames;
}
let saveTimer = null;
function saveFrames() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { chrome.storage.session.set({ vsFrames: frames }).catch(() => {}); }, 200);
}
async function noteFrame(tabId, frameId, info) {
  await loadFrames();
  const t = frames[tabId] || (frames[tabId] = {});
  if (!info.hasVideo) { delete t[frameId]; saveFrames(); return; }
  const f = t[frameId] || (t[frameId] = { seen: 0, play: 0 });
  f.seen = Date.now();
  if (info.playing) f.play = Date.now();
  saveFrames();
}
async function pickFrame(tabId) {
  await loadFrames();
  const t = frames[tabId];
  if (!t) return 0;
  let best = null;
  for (const [id, f] of Object.entries(t)) {
    const score = [f.play || 0, Number(id) === 0 ? 1 : 0, f.seen || 0];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) {
      best = { id: Number(id), score };
    }
  }
  return best ? best.id : 0;
}
async function forgetFrame(tabId, frameId) {
  await loadFrames();
  if (frames[tabId]) { delete frames[tabId][frameId]; saveFrames(); }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadFrames();
  delete frames[tabId];
  saveFrames();
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && info.url) {
    await loadFrames();
    delete frames[tabId];
    saveFrames();
  }
});

// Send a message to the content script of the frame that holds the video.
async function relay(tabId, msg) {
  const frameId = await pickFrame(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg, { frameId });
    if (res !== undefined) return res;
  } catch (e) {
    if (frameId === 0) return { error: 'no-content-script', message: e.message };
    await forgetFrame(tabId, frameId);
  }
  if (frameId !== 0) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
      if (res !== undefined) return res;
    } catch (e) {
      return { error: 'no-content-script', message: e.message };
    }
  }
  return { error: 'no-response' };
}

// ---------- panels ----------
const panelPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vs-panel') return;
  const entry = { port, tabId: null, windowId: null, embedded: false };
  panelPorts.add(entry);
  port.onMessage.addListener((m) => {
    if (m && m.type === 'hello') Object.assign(entry, { tabId: m.tabId, windowId: m.windowId, embedded: !!m.embedded });
  });
  port.onDisconnect.addListener(() => panelPorts.delete(entry));
});

function panelOpenFor(tab) {
  for (const p of panelPorts) {
    if (p.embedded && p.tabId === tab.id) return true;
    if (!p.embedded && p.windowId === tab.windowId) return true;
  }
  return false;
}

async function openInpagePanel(tabId, mode = 'open') {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'vs-inpage-panel', mode }, { frameId: 0 });
    return { ok: true, where: 'inpage' };
  } catch (e) {
    return { error: 'no-content-script', message: e.message };
  }
}

async function openPanel(tab, opts = {}) {
  const settings = await getSettings();
  if (settings.panelMode !== 'inpage' && chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return { ok: true, where: 'sidepanel' };
    } catch (_) {
      // No user gesture (or unsupported): fall back to the in-page panel.
    }
  }
  return openInpagePanel(tab.id, opts.toggle ? 'toggle' : 'open');
}

// Notes created from the page get focused in the panel once it is ready.
const pendingFocus = new Map(); // tabId -> noteId

// ---------- tab capture fallback ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function captureTab(tab, { rect, vw, maxWidth, quality }) {
  if (!tab || tab.windowId === undefined) return { error: 'no-tab' };
  await chrome.tabs.sendMessage(tab.id, { type: 'vs-capture-hide' }).catch(() => {});
  await sleep(150);
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return { error: 'permission', message: e.message };
  } finally {
    chrome.tabs.sendMessage(tab.id, { type: 'vs-capture-show' }).catch(() => {});
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = vw ? bmp.width / vw : 1;
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.min(bmp.width - sx, Math.round(rect.w * scale));
    const sh = Math.min(bmp.height - sy, Math.round(rect.h * scale));
    if (sw < 8 || sh < 8) return { error: 'offscreen' };
    const ratio = Math.min(1, (maxWidth || 1280) / sw);
    const canvas = new OffscreenCanvas(Math.round(sw * ratio), Math.round(sh * ratio));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality || 0.85 });
    return { ok: true, image: 'data:image/jpeg;base64,' + bufferToBase64(await out.arrayBuffer()) };
  } catch (e) {
    return { error: 'crop', message: e.message };
  }
}

// ---------- notes from the page ----------
async function addNoteFromPage(tab, msg) {
  const video = await db.upsertVideo(Object.assign({}, msg.video, { thumb: msg.thumb || null }));
  const note = await db.addNote({ videoId: video.id, t: msg.t, text: msg.text || '', image: msg.image, imageError: msg.imageError });
  const settings = await getSettings();
  pendingFocus.set(tab.id, note.id);
  events.postMessage({ kind: 'focus-note', tabId: tab.id, videoId: video.id, noteId: note.id });
  let opened = panelOpenFor(tab);
  if (!opened && settings.openPanelOnNote) {
    const r = await openPanel(tab);
    opened = !!r.ok;
  }
  return { ok: true, noteId: note.id, panel: opened };
}

async function addBookmarkFromPage(msg) {
  const video = await db.upsertVideo(Object.assign({}, msg.video, { thumb: msg.thumb || null }));
  const bm = await db.addBookmark(video.id, msg.t, msg.label || `Bookmark at ${VS.formatTime(msg.t)}`);
  return { ok: true, bookmark: bm };
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const handle = async () => {
    switch (msg.type) {
      case 'vs-whoami':
        return { tabId: sender.tab ? sender.tab.id : null, frameId: sender.frameId, windowId: sender.tab ? sender.tab.windowId : null };
      case 'vs-frame-video':
        if (sender.tab) await noteFrame(sender.tab.id, sender.frameId, msg);
        return { ok: true };
      case 'vs-add-note':
        return addNoteFromPage(sender.tab, msg);
      case 'vs-add-bookmark':
        return addBookmarkFromPage(msg);
      case 'vs-capture-tab':
        return captureTab(sender.tab, msg);
      case 'vs-relay':
        return relay(msg.tabId, msg.msg);
      case 'vs-relay-action':
        // A shortcut pressed in a frame without a video: forward it to the video's frame.
        if (!sender.tab) return { error: 'no-tab' };
        return relay(sender.tab.id, { type: 'vs-action', action: msg.action });
      case 'vs-open-panel': {
        const tab = sender.tab || (msg.tabId ? await chrome.tabs.get(msg.tabId) : null);
        if (!tab) return { error: 'no-tab' };
        return openPanel(tab, { toggle: !!msg.toggle });
      }
      case 'vs-open-inpage':
        return openInpagePanel(msg.tabId, msg.mode || 'open');
      case 'vs-pending-focus': {
        const id = pendingFocus.get(msg.tabId) || null;
        pendingFocus.delete(msg.tabId);
        return { noteId: id };
      }
      case 'vs-open-library':
        await chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') + (msg.videoId ? '#video=' + encodeURIComponent(msg.videoId) : '') });
        return { ok: true };
      default:
        return undefined;
    }
  };
  handle().then((r) => sendResponse(r), (e) => sendResponse({ error: 'exception', message: String(e && e.message || e) }));
  return true;
});

// ---------- keyboard commands (bind them at chrome://extensions/shortcuts) ----------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  if (command === 'open-notes') {
    await openPanel(tab, { toggle: true });
  } else if (command === 'add-note') {
    await relay(tab.id, { type: 'vs-action', action: 'addNote' });
  } else if (command === 'add-screenshot-note') {
    await relay(tab.id, { type: 'vs-action', action: 'screenshotNote' });
  } else if (command === 'open-library') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});
