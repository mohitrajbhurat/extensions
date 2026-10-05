// Capture Studio service worker: screenshot capture (visible, region, full page),
// recording orchestration (tab capture through an offscreen document, window/screen
// through the recorder page) and the toolbar badge.
import { putShot, newId } from './lib/db.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|devtools|view-source|chrome-search|chrome-untrusted):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;
const MAX_FRAMES = 160;            // full-page: hard stop for endless pages
const MAX_CANVAS_SIDE = 32000;     // Chromium canvas limits
const MAX_CANVAS_AREA = 200e6;
const CAPTURE_SPACING_MS = 560;    // captureVisibleTab is limited to 2 calls per second

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Recording state + badge                                             */
/* ------------------------------------------------------------------ */
let rec = null; // { mode, state, elapsed, tabId?, recorderTabId?, n?, title? }
let busyBadge = false;

const ready = (async () => {
  try {
    const { rec: saved } = await chrome.storage.session.get('rec');
    rec = saved || null;
    if (rec && rec.mode === 'tab' && !(await hasOffscreen())) rec = null;
    if (rec && rec.recorderTabId) {
      try { await chrome.tabs.get(rec.recorderTabId); } catch { rec = null; }
    }
    await chrome.storage.session.set({ rec });
    updateBadge();
  } catch (e) { console.warn(e); }
})();

function setRec(next) {
  rec = next;
  chrome.storage.session.set({ rec }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'rec-state', rec }).catch(() => {});
  updateBadge();
}

function badgeTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 6000) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function updateBadge() {
  if (busyBadge) return;
  let text = '';
  let color = '#e5484d';
  let title = 'Capture Studio';
  if (rec) {
    switch (rec.state) {
      case 'countdown': text = String(rec.n || ''); color = '#3b6ef5'; title = 'Recording starts in ' + rec.n; break;
      case 'recording': text = badgeTime(rec.elapsed); title = `Recording ${badgeTime(rec.elapsed)} - click to pause or stop`; break;
      case 'paused': text = 'II'; color = '#c27b00'; title = 'Recording paused - click to resume or stop'; break;
      case 'saving': text = '...'; color = '#5d6475'; title = 'Saving recording'; break;
      default: text = '...'; color = '#5d6475'; title = 'Preparing recording';
    }
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setTitle({ title });
}

async function withBusyBadge(fn) {
  busyBadge = true;
  try { return await fn(text => { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color: '#3b6ef5' }); }); }
  finally { busyBadge = false; updateBadge(); }
}

async function reportError(message) {
  console.warn('Capture Studio:', message);
  await chrome.storage.session.set({ lastError: { message, at: Date.now() } }).catch(() => {});
  if (rec) return;
  busyBadge = true;
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#d0303a' });
  chrome.action.setTitle({ title: 'Capture Studio: ' + message });
  setTimeout(() => { busyBadge = false; updateBadge(); }, 5000);
}

/* ------------------------------------------------------------------ */
/* Screenshot helpers                                                  */
/* ------------------------------------------------------------------ */
let lastCaptureAt = 0;
async function captureTab(windowId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCaptureAt + CAPTURE_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|rate/i.test(e.message || '')) { await sleep(700); continue; }
      throw e;
    }
  }
  throw new Error('The browser rate-limited screen capture. Please try again.');
}

async function bitmapFromDataUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function makeThumbFrom(source, w, h) {
  const scale = Math.min(1, 480 / w);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(Math.min(h, w * 1.5) * scale)); // tall pages: top part only
  const c = new OffscreenCanvas(tw, th);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tw, th);
  ctx.drawImage(source, 0, 0, w, th / scale, 0, 0, tw, th);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

async function saveShotAndOpen({ blob, bitmapOrCanvas, width, height, tab, kind }) {
  const id = newId('s');
  const thumb = await makeThumbFrom(bitmapOrCanvas, width, height);
  await putShot({
    id, created: Date.now(), kind, width, height, thumb,
    title: tab.title || 'Screenshot', url: tab.url || '', doc: null,
  }, blob);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor/editor.html?id=${id}`),
    index: tab.index + 1,
    openerTabId: tab.id,
    windowId: tab.windowId,
  });
  return id;
}

function assertCapturable(tab) {
  if (!tab) throw new Error('No active tab to capture.');
  if (tab.url && RESTRICTED.test(tab.url)) throw new Error('This page is protected by the browser and cannot be captured.');
}

async function captureVisible(tab) {
  assertCapturable(tab);
  const dataUrl = await captureTab(tab.windowId);
  const bmp = await bitmapFromDataUrl(dataUrl);
  const blob = await (await fetch(dataUrl)).blob();
  await saveShotAndOpen({ blob, bitmapOrCanvas: bmp, width: bmp.width, height: bmp.height, tab, kind: 'visible' });
}

async function startRegion(tab) {
  assertCapturable(tab);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/region.js'] });
}

async function captureRegion(tab, rect, viewport) {
  const dataUrl = await captureTab(tab.windowId);
  const bmp = await bitmapFromDataUrl(dataUrl);
  const scale = bmp.width / viewport.width;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(rect.width * scale)));
  const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(rect.height * scale)));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await saveShotAndOpen({ blob, bitmapOrCanvas: canvas, width: sw, height: sh, tab, kind: 'region' });
}

/* ---- full page: functions injected into the page ---- */
function fpPrepare() {
  const docEl = document.scrollingElement || document.documentElement;
  let scroller = docEl;
  let isDoc = true;
  if (docEl.scrollHeight <= window.innerHeight + 2) {
    // Many web apps scroll an inner container instead of the document.
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 40 || el.clientHeight < 100) continue;
      const oy = getComputedStyle(el).overflowY;
      if (!/(auto|scroll|overlay)/.test(oy)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.3) { best = el; bestArea = area; }
    }
    if (best) { scroller = best; isDoc = false; }
  }
  const state = { scroller, isDoc, origTop: isDoc ? window.scrollY : scroller.scrollTop, origLeft: isDoc ? window.scrollX : scroller.scrollLeft, hidden: [], hiddenDone: false };
  const style = document.createElement('style');
  style.setAttribute('data-capture-studio', '');
  style.textContent = 'html,body{scroll-behavior:auto!important;scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}' +
    '[data-cs-scroller]{scroll-behavior:auto!important;scrollbar-width:none!important}[data-cs-scroller]::-webkit-scrollbar{display:none!important}';
  document.documentElement.appendChild(style);
  if (!isDoc) scroller.setAttribute('data-cs-scroller', '');
  state.style = style;
  window.__captureStudioFP = state;
  let rect;
  if (isDoc) rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  else {
    const r = scroller.getBoundingClientRect();
    rect = { left: r.left + scroller.clientLeft, top: r.top + scroller.clientTop, width: scroller.clientWidth, height: scroller.clientHeight };
  }
  // Only capture the visible part horizontally; clamp rect to the viewport.
  rect.left = Math.max(0, rect.left);
  rect.top = Math.max(0, rect.top);
  rect.width = Math.min(rect.width, window.innerWidth - rect.left);
  rect.height = Math.min(rect.height, window.innerHeight - rect.top);
  return { rect, viewW: window.innerWidth, viewH: window.innerHeight, total: scroller.scrollHeight, isDoc };
}

async function fpScroll(y) {
  const s = window.__captureStudioFP;
  if (s.isDoc) window.scrollTo(0, y); else s.scroller.scrollTop = y;
  await new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 300); });
  await new Promise(r => setTimeout(r, 150)); // let lazy content and transitions settle
  return { y: s.isDoc ? window.scrollY : s.scroller.scrollTop, total: s.scroller.scrollHeight };
}

function fpHideFixed() {
  const s = window.__captureStudioFP;
  if (!s || s.hiddenDone) return 0;
  s.hiddenDone = true;
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n;
  let count = 0;
  while ((n = walker.nextNode())) {
    if (++count > 30000) break;
    const pos = getComputedStyle(n).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    if (n === s.scroller || n.contains(s.scroller)) continue;
    s.hidden.push([n, n.style.getPropertyValue('visibility'), n.style.getPropertyPriority('visibility')]);
    n.style.setProperty('visibility', 'hidden', 'important');
  }
  return s.hidden.length;
}

function fpRestore() {
  const s = window.__captureStudioFP;
  if (!s) return;
  for (const [el, value, prio] of s.hidden) {
    if (value) el.style.setProperty('visibility', value, prio); else el.style.removeProperty('visibility');
  }
  s.style.remove();
  if (!s.isDoc) s.scroller.removeAttribute('data-cs-scroller');
  if (s.isDoc) window.scrollTo(s.origLeft, s.origTop); else s.scroller.scrollTop = s.origTop;
  delete window.__captureStudioFP;
}

async function captureFullPage(tab) {
  assertCapturable(tab);
  const tabId = tab.id;
  const exec = async (func, args = []) => (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0]?.result;
  await withBusyBadge(async progress => {
    progress('0%');
    const info = await exec(fpPrepare);
    if (!info) throw new Error('Could not measure the page.');
    await sleep(120);
    let canvas = null;
    let ctx = null;
    let scale = 1; // device px per CSS px in the captured image
    let k = 1;     // extra downscale to respect canvas limits
    const total = info.total;
    let viewH = info.rect.height; // CSS px of the scroller visible per frame
    let step = Math.max(50, viewH);
    try {
      let y = 0;
      let lastY = -1;
      for (let frame = 0; frame < MAX_FRAMES; frame++) {
        const pos = await exec(fpScroll, [y]);
        if (frame > 0 && pos.y <= lastY) break; // could not scroll further
        const current = await chrome.tabs.get(tabId);
        if (!current.active) throw new Error('Full-page capture stopped because the tab was switched.');
        const bmp = await bitmapFromDataUrl(await captureTab(tab.windowId));
        if (!canvas) {
          scale = bmp.width / info.viewW;
          // Trust the captured surface over innerHeight if they ever disagree (zoom, emulation).
          viewH = Math.max(1, Math.min(info.rect.height, bmp.height / scale - info.rect.top));
          step = Math.max(50, Math.floor(viewH));
          const outW = Math.round(info.rect.width * scale);
          const outH = Math.round(total * scale);
          k = Math.min(1, MAX_CANVAS_SIDE / outH, MAX_CANVAS_SIDE / outW, Math.sqrt(MAX_CANVAS_AREA / (outW * outH)));
          canvas = new OffscreenCanvas(Math.max(1, Math.round(outW * k)), Math.max(1, Math.round(outH * k)));
          ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
        }
        const visibleH = Math.min(viewH, total - pos.y);
        if (visibleH > 0) {
          ctx.drawImage(bmp,
            info.rect.left * scale, info.rect.top * scale, info.rect.width * scale, visibleH * scale,
            0, pos.y * scale * k, canvas.width, visibleH * scale * k);
        }
        bmp.close();
        lastY = pos.y;
        progress(`${Math.min(99, Math.round(((pos.y + step) / total) * 100))}%`);
        if (pos.y + viewH >= total - 1) break;
        if (frame === 0) { await exec(fpHideFixed); }
        y = pos.y + step;
      }
    } finally {
      await exec(fpRestore).catch(() => {});
    }
    if (!canvas) throw new Error('Nothing was captured.');
    progress('100%');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await saveShotAndOpen({ blob, bitmapOrCanvas: canvas, width: canvas.width, height: canvas.height, tab, kind: 'full' });
  });
}

async function runShot(kind, tab) {
  try {
    if (rec && rec.state === 'countdown') throw new Error('Wait for the recording countdown to finish.');
    if (kind === 'visible') await captureVisible(tab);
    else if (kind === 'region') await startRegion(tab);
    else if (kind === 'full') await captureFullPage(tab);
  } catch (e) {
    reportError(friendlyError(e));
  }
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission|activeTab/i.test(m)) {
    return 'This page cannot be captured. Open the popup on the page, or use the keyboard shortcut, then try again.';
  }
  return m;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/* ------------------------------------------------------------------ */
/* Recording orchestration                                             */
/* ------------------------------------------------------------------ */
async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Records the current tab (tab capture) mixed with microphone audio.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

function injectCountdown(n) {
  let el = document.getElementById('__capture-studio-countdown');
  if (!el) {
    el = document.createElement('div');
    el.id = '__capture-studio-countdown';
    el.setAttribute('aria-live', 'assertive');
    el.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(10,12,18,.45);pointer-events:none;';
    const num = document.createElement('div');
    num.style.cssText = 'all:initial;font:700 120px/1 system-ui,sans-serif;color:#fff;width:200px;height:200px;border-radius:50%;background:rgba(229,72,77,.92);display:flex;align-items:center;justify-content:center;box-shadow:0 12px 48px rgba(0,0,0,.4);';
    el.appendChild(num);
    (document.body || document.documentElement).appendChild(el);
  }
  el.firstChild.textContent = String(n);
}

async function removeCountdown() {
  document.getElementById('__capture-studio-countdown')?.remove();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function injectBubble(src, sizePx) {
  if (document.getElementById('__capture-studio-cam')) return;
  const wrap = document.createElement('div');
  wrap.id = '__capture-studio-cam';
  const size = sizePx || 200;
  wrap.style.cssText = `all:initial;position:fixed;left:24px;bottom:24px;width:${size}px;height:${size}px;z-index:2147483646;border-radius:50%;overflow:hidden;cursor:grab;box-shadow:0 8px 28px rgba(0,0,0,.35);border:4px solid #fff;background:#111;touch-action:none;`;
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.allow = 'camera';
  frame.title = 'Webcam preview';
  frame.style.cssText = 'all:initial;width:100%;height:100%;border:0;pointer-events:none;display:block;';
  wrap.appendChild(frame);
  let start = null;
  wrap.addEventListener('pointerdown', e => {
    const r = wrap.getBoundingClientRect();
    start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    wrap.setPointerCapture(e.pointerId);
    wrap.style.cursor = 'grabbing';
  });
  wrap.addEventListener('pointermove', e => {
    if (!start) return;
    const x = Math.min(window.innerWidth - size, Math.max(0, e.clientX - start.dx));
    const y = Math.min(window.innerHeight - size, Math.max(0, e.clientY - start.dy));
    wrap.style.left = x + 'px';
    wrap.style.top = y + 'px';
    wrap.style.bottom = 'auto';
  });
  const end = () => { start = null; wrap.style.cursor = 'grab'; };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  (document.body || document.documentElement).appendChild(wrap);
}

function removeBubble() {
  document.getElementById('__capture-studio-cam')?.remove();
  document.getElementById('__capture-studio-countdown')?.remove();
}

async function execInTab(tabId, func, args = []) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r?.result;
  } catch (e) {
    console.warn('Script injection failed', e.message);
    return undefined;
  }
}

async function startRecording(tab, opts) {
  await ready;
  if (rec) throw new Error('A recording is already in progress.');
  await chrome.storage.session.remove('lastError');
  if (opts.mode === 'tab') {
    assertCapturable(tab);
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await ensureOffscreen();
    setRec({ mode: 'tab', state: 'starting', elapsed: 0, tabId: tab.id, title: tab.title || '' });
    if (opts.webcam) {
      const sizes = { small: 150, medium: 200, large: 280 };
      const src = chrome.runtime.getURL(`camera/bubble.html?cam=${encodeURIComponent(opts.camId || '')}`);
      await execInTab(tab.id, injectBubble, [src, sizes[opts.camSize] || 200]);
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, opts, title: tab.title || '' });
    } catch (e) {
      res = { error: e.message };
    }
    if (!res || res.error) {
      await cleanupTabRecording();
      setRec(null);
      throw new Error(res?.error || 'Could not start the recorder.');
    }
  } else {
    const url = chrome.runtime.getURL(`recorder/recorder.html?mode=${opts.mode}`);
    const t = await chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined });
    setRec({ mode: opts.mode, state: 'setup', elapsed: 0, recorderTabId: t.id });
  }
}

async function cleanupTabRecording() {
  const tabId = rec && rec.tabId;
  if (tabId) await execInTab(tabId, removeBubble);
  await closeOffscreen();
}

async function controlRecording(action) {
  await ready;
  if (!rec) return { ok: false };
  if (rec.state === 'setup' && (action === 'cancel' || action === 'stop')) {
    if (rec.recorderTabId) chrome.tabs.remove(rec.recorderTabId).catch(() => {});
    setRec(null);
    return { ok: true };
  }
  if (action === 'focus' && rec.recorderTabId) {
    const t = await chrome.tabs.update(rec.recorderTabId, { active: true });
    chrome.windows.update(t.windowId, { focused: true });
    return { ok: true };
  }
  const target = rec.mode === 'tab' ? 'offscreen' : 'recorder';
  try {
    await chrome.runtime.sendMessage({ target, type: 'control', action });
  } catch (e) {
    // Recorder is gone (crashed or closed): reset so the user is not stuck.
    if (rec.mode === 'tab') await cleanupTabRecording();
    setRec(null);
    return { ok: false, error: 'The recorder is no longer running.' };
  }
  return { ok: true };
}

async function onRecorderStatus(msg, sender) {
  await ready;
  const fromPage = sender.tab && sender.tab.id;
  if (!rec) {
    // A recorder page started on its own (for example the user reloaded it).
    if (msg.mode && msg.mode !== 'tab') rec = { mode: msg.mode, recorderTabId: fromPage };
    else return;
  }
  const next = { ...rec, state: msg.state, elapsed: msg.elapsed ?? rec.elapsed, n: msg.n };
  if (fromPage && rec.mode !== 'tab') next.recorderTabId = fromPage;
  if (rec.mode === 'tab' && msg.state === 'countdown' && rec.tabId) execInTab(rec.tabId, injectCountdown, [msg.n]);
  setRec(next);
}

async function onRecordingSaved(msg) {
  const wasTab = rec && rec.mode === 'tab';
  const tabId = rec && rec.tabId;
  if (wasTab) await cleanupTabRecording();
  setRec(null);
  if (wasTab && msg.id) {
    let index;
    let windowId;
    try { const t = await chrome.tabs.get(tabId); index = t.index + 1; windowId = t.windowId; } catch { /* tab closed */ }
    await chrome.tabs.create({ url: chrome.runtime.getURL(`library/library.html?play=${msg.id}`), index, windowId });
  }
}

async function onRecordingError(msg) {
  if (rec && rec.mode === 'tab') await cleanupTabRecording();
  setRec(null);
  reportError(msg.message || 'Recording failed.');
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target) return false; // messages for offscreen/recorder pages
  const reply = p => { p.then(r => sendResponse(r ?? { ok: true }), e => sendResponse({ error: friendlyError(e) })); return true; };
  switch (msg.type) {
    case 'shot': return reply((async () => {
      const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : await activeTab();
      runShot(msg.kind, tab); // runs after the popup has closed
      return { ok: true };
    })());
    case 'region-result': return reply((async () => {
      const tab = sender.tab;
      if (!tab) return;
      if (msg.switchTo) { await runShot(msg.switchTo, tab); return; }
      if (msg.cancel) return;
      try { await captureRegion(tab, msg.rect, msg.viewport); } catch (e) { reportError(friendlyError(e)); }
    })());
    case 'rec-start': return reply((async () => {
      const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : await activeTab();
      await startRecording(tab, msg.opts || {});
      return { ok: true };
    })());
    case 'rec-control': return reply(controlRecording(msg.action));
    case 'rec-get': return reply(ready.then(async () => ({ rec, lastError: (await chrome.storage.session.get('lastError')).lastError || null })));
    case 'rec-status': return reply(onRecorderStatus(msg, sender));
    case 'rec-countdown-done': return reply((async () => { if (rec && rec.tabId) await execInTab(rec.tabId, removeCountdown); })());
    case 'rec-saved': return reply(onRecordingSaved(msg));
    case 'rec-error': return reply(onRecordingError(msg));
    case 'clear-error': return reply(chrome.storage.session.remove('lastError'));
    default: return false;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || await activeTab();
  if (command === 'capture-screenshot') runShot('region', tab);
  else if (command === 'capture-visible') runShot('visible', tab);
  else if (command === 'capture-full-page') runShot('full', tab);
  else if (command === 'stop-recording') controlRecording('stop');
  else if (command === 'pause-recording') {
    await ready;
    if (rec) controlRecording(rec.state === 'paused' ? 'resume' : 'pause');
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await ready;
  if (!rec) return;
  if (rec.recorderTabId === tabId) setRec(null);
  // In tab mode the captured stream ends with the tab; the offscreen recorder saves what it has.
});

chrome.runtime.onInstalled.addListener(() => updateBadge());
