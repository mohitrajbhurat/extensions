// Smart Autofill service worker: injects the content scripts on demand (all frames), runs
// preview / fill / undo across frames, aggregates results and persists learned site rules.
import * as S from './shared/store.js';

const CONTENT_FILES = ['content/fields.js', 'content/matcher.js', 'content/filler.js', 'content/ui.js', 'content/main.js'];

function isRestricted(url) {
  return !url || /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i.test(url) ||
    /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url);
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
    return true;
  } catch (e) {
    // A frame we cannot access made the multi-frame call fail; fall back to the top frame only.
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return false;
  }
}

async function call(tabId, method, args = [], frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target,
      func: (m, a) => (globalThis.__SmartAutofill ? globalThis.__SmartAutofill[m](...a) : null),
      args: [method, args],
    });
  } catch (e) {
    if (frameIds) throw e;
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (m, a) => (globalThis.__SmartAutofill ? globalThis.__SmartAutofill[m](...a) : null),
      args: [method, args],
    });
  }
  return results.filter(r => r && r.result != null).map(r => ({ frameId: r.frameId, ...r.result }));
}

async function profileFor(profileId) {
  const data = await S.loadData();
  const id = profileId || data.activeProfileId;
  const profile = data.profiles.find(p => p.id === id) || data.profiles[0];
  if (profileId && profileId !== data.activeProfileId) {
    data.activeProfileId = profile.id;
    await S.saveData(data);
  }
  return profile;
}

function sessionKeyFor(tabId) { return 'tab:' + tabId; }

async function pageToast(tabId, text) {
  try {
    await inject(tabId);
    await call(tabId, 'toast', [text], [0]);
  } catch (e) { /* page not scriptable */ }
}

async function preview(tabId, profileId) {
  const settings = await S.getSettings();
  const profile = await profileFor(profileId);
  await inject(tabId);
  const frames = await call(tabId, 'preview', [profile, settings]);
  const total = frames.reduce((n, f) => n + f.total, 0);
  const ready = frames.reduce((n, f) => n + f.ready, 0);
  const high = frames.reduce((n, f) => n + f.high, 0);
  await chrome.storage.session.set({ [sessionKeyFor(tabId)]: { profileId: profile.id, at: Date.now() } });
  if (total) await call(tabId, 'showPanel', [{ profileName: profile.name, total, ready, high, frames: frames.filter(f => f.total).length }], [0]);
  else await call(tabId, 'toast', ['Smart Autofill found no fillable fields on this page.'], [0]);
  return { ok: true, total, ready, high, frames: frames.length, fields: frames.flatMap(f => f.fields), profileName: profile.name };
}

async function fill(tabId, profileId, usePreview) {
  const settings = await S.getSettings();
  if (!profileId && usePreview) {
    const st = (await chrome.storage.session.get(sessionKeyFor(tabId)))[sessionKeyFor(tabId)];
    if (st) profileId = st.profileId;
  }
  const profile = await profileFor(profileId);
  if (!usePreview) await inject(tabId);
  const frames = await call(tabId, 'fill', [profile, settings, { usePreview: !!usePreview }]);
  const sum = { filled: 0, failed: 0, added: 0, total: 0, failures: [] };
  for (const f of frames) {
    sum.filled += f.filled; sum.failed += f.failed; sum.added += f.added; sum.total += f.total;
    sum.failures.push(...(f.failures || []));
  }
  await chrome.storage.session.set({ [sessionKeyFor(tabId)]: { profileId: profile.id, filledAt: Date.now() } });
  if (sum.filled || sum.failed) await call(tabId, 'showResult', [sum], [0]);
  else await call(tabId, 'toast', [sum.total ? 'Nothing to fill: matched fields are already filled or have no value in this profile.' : 'Smart Autofill found no fillable fields on this page.'], [0]);
  return { ok: true, profileName: profile.name, ...sum };
}

async function undo(tabId) {
  const frames = await call(tabId, 'undo', []);
  const restored = frames.reduce((n, f) => n + (f.restored || 0), 0);
  await call(tabId, 'toast', [restored ? 'Fill undone.' : 'Nothing to undo.'], [0]).catch(() => {});
  return { ok: true, restored };
}

async function detect(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestricted(tab.url)) return { ok: false, restricted: true };
  await inject(tabId);
  const frames = await call(tabId, 'detect', []);
  const canUndo = (await call(tabId, 'canUndo', []).catch(() => [])).length > 0;
  return {
    ok: true,
    controls: frames.reduce((n, f) => n + f.controls, 0),
    matched: frames.reduce((n, f) => n + f.matched, 0),
    frames: frames.filter(f => f.controls).length,
    canUndo,
  };
}

function errorResult(e) {
  if (e && e.locked) return { ok: false, locked: true, error: e.message };
  const msg = e && e.message || String(e);
  if (/Cannot access|cannot be scripted|Missing host permission|The extensions gallery/i.test(msg)) {
    return { ok: false, restricted: true, error: 'This page cannot be filled (browser pages and the web store are off-limits). Click the toolbar button on the page you want to fill.' };
  }
  return { ok: false, error: msg };
}

async function handle(msg, sender) {
  const tabId = msg.tabId || (sender.tab && sender.tab.id);
  switch (msg.type) {
    case 'preview': return preview(tabId, msg.profileId);
    case 'fill': return fill(tabId, msg.profileId, false);
    case 'undo': return undo(tabId);
    case 'detect': return detect(tabId);
    case 'clear': await call(tabId, 'clear', []); return { ok: true };
    case 'panel-fill': return fill(tabId, null, true);
    case 'panel-cancel': await call(tabId, 'clear', []); return { ok: true };
    case 'panel-undo': return undo(tabId);
    case 'save-rule':
      if (!msg.host || !msg.sig || !msg.rule) return { ok: false };
      await S.saveRule(msg.host, msg.sig, msg.rule);
      return { ok: true };
    case 'delete-rule':
      await S.deleteRule(msg.host, msg.sig);
      return { ok: true };
    default: return { ok: false, error: 'Unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  // Content scripts may only use panel and rule messages, for their own tab.
  if (sender.tab && !/^(panel-|save-rule|delete-rule)/.test(msg.type)) return false;
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(sendResponse, e => sendResponse(errorResult(e)));
  return true;
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab || isRestricted(tab.url)) return;
  try {
    if (command === 'fill-page') {
      const s = await S.getSettings();
      if (s.previewFirst) await preview(tab.id); else await fill(tab.id, null, false);
    } else if (command === 'fill-now') await fill(tab.id, null, false);
    else if (command === 'undo-fill') await undo(tab.id);
  } catch (e) {
    const r = errorResult(e);
    if (r.locked) await pageToast(tab.id, 'Smart Autofill is locked. Open the toolbar popup to unlock.');
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await S.getSettings().then(s => chrome.storage.local.set({ settings: s }));
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(sessionKeyFor(tabId)); });

// Handy for debugging from the service worker console and for automated tests.
globalThis.SmartAutofill = { preview, fill: (tabId, profileId, usePreview) => fill(tabId, profileId, usePreview), undo, detect };
