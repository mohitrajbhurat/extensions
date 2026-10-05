// Video Studio content script. Runs in every frame. Finds HTML5 videos (including ones in
// shadow DOM and ones added later), adds a speed badge, handles keyboard shortcuts, loops,
// frame capture, and hosts the in-page notes panel fallback (top frame only).
(() => {
  'use strict';
  if (window.__videoStudioContent) return;
  window.__videoStudioContent = true;

  const VS = globalThis.VS;
  const isTop = window === window.top;
  const host = location.hostname || (location.protocol === 'file:' ? 'local-file' : location.protocol.replace(':', ''));

  // An older copy of this script (left behind by an extension reload) tears itself down.
  document.dispatchEvent(new CustomEvent('video-studio-reset'));

  let settings = VS.normalizeSettings({});
  let siteSpeeds = {};
  let overlayHidden = false;
  let captureHidden = false;
  let childHasVideo = false;
  let dead = false;
  const ctrls = new Map(); // HTMLVideoElement -> controller
  let active = null;
  const cleanups = [];

  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  function alive() {
    try { return !dead && !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  async function send(msg) {
    if (!alive()) { teardown(); return { error: 'invalidated' }; }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) teardown();
      return { error: 'send-failed', message: String(e && e.message || e) };
    }
  }

  function siteEnabled() {
    return settings.enabled && !settings.disabledSites.some((d) => d && (host === d || host.endsWith('.' + d)));
  }

  // ---------------------------------------------------------------- settings
  function loadSettings() {
    try {
      chrome.storage.sync.get('settings').then(({ settings: s }) => { settings = VS.normalizeSettings(s); refreshAll(); }, () => {});
      chrome.storage.local.get('siteSpeeds').then(({ siteSpeeds: s }) => {
        siteSpeeds = s || {};
        for (const c of ctrls.values()) if (!c.userSet) applyInitial(c, true);
      }, () => {});
    } catch (_) { /* context gone */ }
  }
  const onStorage = (changes, area) => {
    if (area === 'sync' && changes.settings) { settings = VS.normalizeSettings(changes.settings.newValue); refreshAll(); }
    if (area === 'local' && changes.siteSpeeds) siteSpeeds = changes.siteSpeeds.newValue || {};
  };
  try { chrome.storage.onChanged.addListener(onStorage); cleanups.push(() => chrome.storage.onChanged.removeListener(onStorage)); } catch (_) { /* gone */ }

  function saveSiteSpeed(rate) {
    if (!settings.rememberPerSite) return;
    try {
      chrome.storage.local.get('siteSpeeds').then(({ siteSpeeds: s }) => {
        const next = Object.assign({}, s || {});
        if (Math.abs(rate - settings.defaultSpeed) < 0.001) delete next[host]; else next[host] = rate;
        siteSpeeds = next;
        return chrome.storage.local.set({ siteSpeeds: next });
      }).catch(() => {});
    } catch (_) { /* gone */ }
  }

  // ---------------------------------------------------------------- discovery
  const observedRoots = new WeakSet();
  const shadowRoots = new Set();
  let scanTimer = null;

  let pendingRoots = [];
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && pendingRoots.length < 50) pendingRoots.push(n);
    }
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      // New subtrees may contain shadow roots we are not observing yet.
      const roots = pendingRoots.splice(0);
      for (const n of roots) if (n.isConnected) deepScan(n, 25);
      quickScan();
    }, 250);
  });

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    try { mo.observe(root, { childList: true, subtree: true }); } catch (_) { /* detached */ }
    if (root !== document) {
      shadowRoots.add(root);
      // Media events do not cross shadow boundaries, so listen inside each root too.
      root.addEventListener('play', onMediaEventCapture, true);
      root.addEventListener('loadedmetadata', onMediaEventCapture, true);
    }
  }

  function shadowOf(el) {
    if (el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    if (el.localName.includes('-') && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      try { return chrome.dom.openOrClosedShadowRoot(el); } catch (_) { return null; }
    }
    return null;
  }

  function deepScan(root = document, depth = 0) {
    if (depth > 30 || !root.querySelectorAll) return;
    if (root instanceof HTMLVideoElement) attach(root);
    const own = shadowOf(root);
    if (own) { observeRoot(own); deepScan(own, depth + 1); }
    for (const v of root.querySelectorAll('video')) attach(v);
    for (const el of root.querySelectorAll('*')) {
      const sr = shadowOf(el);
      if (sr) { observeRoot(sr); deepScan(sr, depth + 1); }
    }
  }

  function quickScan() {
    if (dead) return;
    for (const v of document.getElementsByTagName('video')) attach(v);
    for (const r of shadowRoots) {
      if (!r.host || !r.host.isConnected) { shadowRoots.delete(r); continue; }
      for (const v of r.querySelectorAll('video')) attach(v);
    }
    prune();
  }

  function onMediaEventCapture(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (t instanceof HTMLVideoElement && !ctrls.has(t)) attach(t);
  }

  function prune() {
    for (const [v, c] of ctrls) if (!v.isConnected) detach(c);
    reportFrame(false);
  }

  // ---------------------------------------------------------------- controller per video
  function attach(v) {
    if (ctrls.has(v) || dead) return;
    const c = {
      v, badge: null, desired: null, loadTs: performance.now(), applied: false, userSet: false,
      reapply: { start: 0, count: 0 }, loop: { a: null, b: null, on: false }, prevRate: null, prevNonPreferred: 1,
      flashTimer: null, listeners: [],
    };
    const add = (type, fn) => { v.addEventListener(type, fn); c.listeners.push([type, fn]); };
    add('loadstart', () => { c.loadTs = performance.now(); c.applied = false; c.loop = { a: null, b: null, on: false }; updateBadge(c); });
    add('emptied', () => { c.loadTs = performance.now(); c.applied = false; });
    const ready = () => { if (!c.applied) applyInitial(c); applyPendingSeek(c); };
    add('loadedmetadata', ready);
    add('canplay', ready);
    add('play', () => { ready(); active = v; reportFrame(true); });
    add('ratechange', () => onRateChange(c));
    add('timeupdate', () => checkLoop(c));
    add('ended', () => { if (c.loop.on && c.loop.a != null) { v.currentTime = c.loop.a; v.play().catch(() => {}); } });
    ctrls.set(v, c);
    ensureOverlay();
    buildBadge(c);
    if (v.readyState >= 1) ready();
    reportFrame(!v.paused);
    scheduleLayout();
  }

  function detach(c) {
    for (const [type, fn] of c.listeners) c.v.removeEventListener(type, fn);
    if (c.badge) c.badge.remove();
    ctrls.delete(c.v);
    if (active === c.v) active = null;
  }

  function targetRate() {
    const saved = settings.rememberPerSite ? Number(siteSpeeds[host]) : NaN;
    return Number.isFinite(saved) && saved > 0 ? VS.clampRate(saved) : settings.defaultSpeed;
  }

  function applyInitial(c, force) {
    c.applied = true;
    if (!siteEnabled()) { c.desired = c.v.playbackRate; updateBadge(c); return; }
    const r = targetRate();
    if (force || Math.abs(c.v.playbackRate - r) > 0.001) setRate(c, r, { noSave: true, quiet: true });
    else { c.desired = r; updateBadge(c); }
  }

  function setRate(c, rate, opts = {}) {
    const r = VS.clampRate(rate);
    c.desired = r;
    if (!opts.quiet) c.userSet = true;
    try { c.v.playbackRate = r; } catch (_) { /* some players reject */ }
    if (!opts.noSave) saveSiteSpeed(r);
    updateBadge(c, !opts.quiet);
  }

  function onRateChange(c) {
    const r = c.v.playbackRate;
    if (c.desired == null || Math.abs(r - c.desired) < 0.001) { c.desired = r; updateBadge(c); return; }
    // Players often reset the rate while loading a new source; re-apply ours in that window,
    // or always when "force speed" is on. Otherwise accept the player's own speed menu.
    const now = performance.now();
    const fresh = now - c.loadTs < 2500;
    if (siteEnabled() && (settings.forceSpeed || fresh)) {
      if (now - c.reapply.start > 1000) c.reapply = { start: now, count: 0 };
      if (c.reapply.count++ < 6) {
        const want = c.desired;
        setTimeout(() => { try { c.v.playbackRate = want; } catch (_) { /* ignore */ } }, 0);
        return;
      }
    }
    c.desired = r;
    updateBadge(c, true);
  }

  function checkLoop(c) {
    const { a, b, on: looping } = c.loop;
    if (!looping || a == null || b == null) return;
    if (c.v.currentTime >= b - 0.04 || c.v.currentTime < a - 0.75) c.v.currentTime = a;
  }
  // timeupdate fires only ~4 times a second; tighten loop accuracy while a loop is active.
  const loopInterval = setInterval(() => {
    for (const c of ctrls.values()) if (c.loop.on && !c.v.paused) checkLoop(c);
  }, 60);
  cleanups.push(() => clearInterval(loopInterval));

  // ---------------------------------------------------------------- active video
  function isVisible(v) {
    const r = v.getBoundingClientRect();
    return r.width >= 40 && r.height >= 30 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function pickActive() {
    if (active && ctrls.has(active) && active.isConnected) return ctrls.get(active);
    let best = null; let bestScore = -1;
    for (const c of ctrls.values()) {
      const v = c.v;
      if (!v.isConnected) continue;
      const r = v.getBoundingClientRect();
      const area = isVisible(v) ? r.width * r.height : 0;
      const score = (!v.paused ? 4e9 : 0) + (v.readyState > 0 ? 2e9 : 0) + area;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
  }

  let lastReported = null;
  function reportFrame(playing) {
    const hasVideo = ctrls.size > 0;
    if (!playing && lastReported === hasVideo) return;
    lastReported = hasVideo;
    send({ type: 'vs-frame-video', hasVideo, playing: !!playing });
    if (!isTop && hasVideo) {
      try { window.top.postMessage({ __vs: 1, kind: 'child-video' }, '*'); } catch (_) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- info and state
  function pageTitle() {
    let t = (document.title || '').trim();
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      const h = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1');
      if (h && h.textContent.trim()) return h.textContent.trim();
      t = t.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
    }
    if (!t) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content) t = og.content.trim();
    }
    return t || (host + location.pathname);
  }

  function finite(n) { return Number.isFinite(n) && n > 0 ? n : null; }

  function videoInfo(c) {
    const canon = VS.canonicalVideo(location.href);
    return { key: canon.key, url: canon.url, pageUrl: location.href, site: canon.site, title: pageTitle(), duration: finite(c.v.duration) };
  }

  function state(c) {
    if (!c) return { hasVideo: false, top: isTop, title: pageTitle(), host, enabled: siteEnabled(), childHasVideo };
    const v = c.v;
    return Object.assign(videoInfo(c), {
      hasVideo: true, top: isTop, host, enabled: siteEnabled(), time: v.currentTime, paused: v.paused,
      rate: v.playbackRate, loop: Object.assign({}, c.loop), readyState: v.readyState, videoCount: ctrls.size,
      siteSpeed: siteSpeeds[host] || null,
    });
  }

  // ---------------------------------------------------------------- actions
  function step(c, dir) {
    const cur = c.v.playbackRate;
    const s = settings.speedStep;
    // Move to the next point on the step grid (at most one step), so 1.0 -> 1.1 -> 1.2
    // stays tidy and an odd rate like 1.25 goes to 1.3 / 1.2 rather than 1.35 / 1.15.
    const pos = cur / s;
    const next = dir > 0 ? (Math.floor(pos + 1e-6) + 1) * s : (Math.ceil(pos - 1e-6) - 1) * s;
    setRate(c, next);
  }

  async function run(action, c, opts = {}) {
    const v = c.v;
    switch (action) {
      case 'slower': step(c, -1); break;
      case 'faster': step(c, 1); break;
      case 'reset':
        if (Math.abs(v.playbackRate - 1) > 0.001) { c.prevRate = v.playbackRate; setRate(c, 1); } else if (c.prevRate) setRate(c, c.prevRate);
        else updateBadge(c, true);
        break;
      case 'preferred':
        if (Math.abs(v.playbackRate - settings.preferredSpeed) < 0.001) setRate(c, c.prevNonPreferred || 1);
        else { c.prevNonPreferred = v.playbackRate; setRate(c, settings.preferredSpeed); }
        break;
      case 'rewind':
        v.currentTime = Math.max(0, v.currentTime - settings.seekSeconds);
        toast(c, `−${settings.seekSeconds}s · ${VS.formatTime(v.currentTime)}`);
        break;
      case 'advance':
        v.currentTime = Math.min(finite(v.duration) || Infinity, v.currentTime + settings.seekSeconds);
        toast(c, `+${settings.seekSeconds}s · ${VS.formatTime(v.currentTime)}`);
        break;
      case 'toggleOverlay':
        overlayHidden = !overlayHidden;
        refreshAll();
        toast(c, overlayHidden ? 'Speed badge hidden (press again to show)' : 'Speed badge shown');
        break;
      case 'addNote': return noteFromPage(c, false, opts);
      case 'screenshotNote': return noteFromPage(c, true, opts);
      case 'bookmark': return bookmarkFromPage(c);
      case 'loopA': {
        c.loop.a = v.currentTime;
        if (c.loop.b != null && c.loop.b <= c.loop.a) c.loop.b = null;
        c.loop.on = c.loop.b != null;
        toast(c, `Loop start A ${VS.formatTime(c.loop.a)}${c.loop.b == null ? ' · now set B' : ''}`);
        updateBadge(c);
        break;
      }
      case 'loopB': {
        if (c.loop.a == null) c.loop.a = 0;
        if (v.currentTime <= c.loop.a + 0.2) { toast(c, 'Loop end must be after the start (A)'); break; }
        c.loop.b = v.currentTime;
        c.loop.on = true;
        toast(c, `Looping ${VS.formatTime(c.loop.a)} – ${VS.formatTime(c.loop.b)}`);
        updateBadge(c);
        break;
      }
      case 'loopClear':
        if (c.loop.on) { c.loop.on = false; toast(c, 'Loop off'); } else if (c.loop.a != null && c.loop.b != null) {
          c.loop.on = true; toast(c, `Looping ${VS.formatTime(c.loop.a)} – ${VS.formatTime(c.loop.b)}`);
        } else toast(c, 'No loop set. Use [ and ] to set A and B');
        updateBadge(c);
        break;
      case 'openPanel':
        send({ type: 'vs-open-panel', toggle: true });
        break;
      case 'hideBadge':
        overlayHidden = true;
        refreshAll();
        toast(c, `Badge hidden. Press ${VS.bindingLabel(settings.bindings.toggleOverlay)} to show it again`);
        break;
      default: return { error: 'unknown-action' };
    }
    return { ok: true };
  }

  async function makeThumb(c) {
    const r = captureFrame(c, 320, 0.7);
    return r.ok ? r.image : null;
  }

  async function noteFromPage(c, withShot, opts = {}) {
    const v = c.v;
    const t = v.currentTime;
    const info = videoInfo(c);
    let image = null; let imageError = null; let warning = null;
    if (withShot) {
      const r = await captureWithFallback(c, { allowTab: settings.autoTabCapture || opts.allowTab });
      if (r.ok) { image = r.image; warning = r.warning || null; } else imageError = r.reason || 'failed';
    }
    const thumb = await makeThumb(c);
    const res = await send({ type: 'vs-add-note', video: info, t, image, imageError, thumb });
    if (res && res.ok) {
      let msg = `${withShot && image ? 'Screenshot note' : 'Note'} added at ${VS.formatTime(t)}`;
      if (imageError === 'tainted') msg += '. This site blocks frame capture; use "Capture tab" in the notes panel';
      else if (imageError) msg += '. Screenshot failed';
      else if (warning === 'blank') msg += '. The frame looks black (protected video?)';
      toast(c, msg, imageError ? 4000 : 2000);
    } else {
      toast(c, 'Could not save the note. Reload the page and try again.', 4000);
    }
    return res;
  }

  async function bookmarkFromPage(c) {
    const t = c.v.currentTime;
    const res = await send({ type: 'vs-add-bookmark', video: videoInfo(c), t, thumb: await makeThumb(c) });
    toast(c, res && res.ok ? `Bookmark added at ${VS.formatTime(t)}` : 'Could not save the bookmark');
    return res;
  }

  // ---------------------------------------------------------------- frame capture
  function captureFrame(c, maxWidth, quality) {
    const v = c.v;
    if (v.readyState < 2 || !v.videoWidth) return { ok: false, reason: 'not-ready' };
    const ratio = Math.min(1, (maxWidth || settings.screenshotMaxWidth) / v.videoWidth);
    const w = Math.max(1, Math.round(v.videoWidth * ratio));
    const h = Math.max(1, Math.round(v.videoHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    try {
      ctx.drawImage(v, 0, 0, w, h);
      const image = canvas.toDataURL('image/jpeg', quality || settings.screenshotQuality);
      // Protected (DRM) video draws as solid black: warn instead of failing silently.
      let warning = null;
      const probe = document.createElement('canvas');
      probe.width = 8; probe.height = 8;
      const pctx = probe.getContext('2d');
      pctx.drawImage(canvas, 0, 0, 8, 8);
      const px = pctx.getImageData(0, 0, 8, 8).data;
      let max = 0;
      for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
      if (max < 6) warning = 'blank';
      return { ok: true, image, warning, width: w, height: h };
    } catch (e) {
      if (e && e.name === 'SecurityError') return { ok: false, reason: 'tainted' };
      return { ok: false, reason: 'failed', message: String(e && e.message) };
    }
  }

  function waitForFrame(v) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => finish());
      setTimeout(finish, 400);
    });
  }

  function seekAndWait(c, t) {
    const v = c.v;
    if (t == null || !Number.isFinite(t) || Math.abs(v.currentTime - t) < 0.05) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', finish);
        waitForFrame(v).then(resolve);
      };
      v.addEventListener('seeked', finish);
      v.currentTime = t;
      setTimeout(finish, 4000);
    });
  }

  async function captureWithFallback(c, { allowTab, seekTo } = {}) {
    await seekAndWait(c, seekTo);
    const r = captureFrame(c);
    if (r.ok || r.reason !== 'tainted' || !allowTab) return r;
    const t = await captureViaTab(c);
    return t.ok ? t : { ok: false, reason: 'tainted', tabError: t.error || t.reason };
  }

  // Rect of the visible part of the video, in this frame's viewport coordinates.
  function visibleRect(v) {
    const r = v.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x;
    const h = Math.min(innerHeight, r.bottom) - y;
    return { x, y, w, h };
  }

  const pendingRects = new Map();
  function rectInTop(rect) {
    if (isTop) return Promise.resolve({ rect, vw: innerWidth, vh: innerHeight });
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { pendingRects.delete(id); resolve(null); }, 1500);
      pendingRects.set(id, (d) => { clearTimeout(timer); pendingRects.delete(id); resolve(d); });
      try { window.parent.postMessage({ __vs: 1, kind: 'rect-req', id, rect }, '*'); } catch (_) { resolve(null); }
    });
  }

  async function captureViaTab(c, seekTo) {
    await seekAndWait(c, seekTo);
    if (document.visibilityState !== 'visible') return { ok: false, reason: 'hidden' };
    const vr = visibleRect(c.v);
    if (vr.w < 8 || vr.h < 8) {
      c.v.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
    }
    const pos = await rectInTop(visibleRect(c.v));
    if (!pos) return { ok: false, reason: 'frame' };
    const res = await send({ type: 'vs-capture-tab', rect: pos.rect, vw: pos.vw, maxWidth: settings.screenshotMaxWidth, quality: settings.screenshotQuality });
    if (res && res.ok) return { ok: true, image: res.image, via: 'tab' };
    return { ok: false, reason: (res && res.error) || 'failed', message: res && res.message };
  }

  function findFrameElement(source) {
    const lists = [document.querySelectorAll('iframe, frame')];
    for (const r of shadowRoots) lists.push(r.querySelectorAll('iframe, frame'));
    for (const list of lists) for (const f of list) if (f.contentWindow === source) return f;
    return null;
  }

  const onWindowMessage = (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__vs !== 1) return;
    if (d.kind === 'rect-req' && d.rect) {
      const f = findFrameElement(e.source);
      if (!f) return;
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const ox = r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const oy = r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0);
      const rect = { x: d.rect.x + ox, y: d.rect.y + oy, w: d.rect.w, h: d.rect.h };
      rectInTop(rect).then((res) => {
        if (res) e.source.postMessage({ __vs: 1, kind: 'rect-res', id: d.id, rect: res.rect, vw: res.vw, vh: res.vh }, '*');
      });
    } else if (d.kind === 'rect-res' && e.source === window.parent) {
      const fn = pendingRects.get(d.id);
      if (fn) fn(d);
    } else if (d.kind === 'child-video' && isTop) {
      childHasVideo = true;
    } else if (d.kind === 'panel-close' && panel && e.source === panel.frame.contentWindow) {
      closePanel();
    }
  };
  on(window, 'message', onWindowMessage);

  // ---------------------------------------------------------------- #vst=<seconds> deep links
  let pendingSeek = null;
  function readHashSeek() {
    const m = location.href.match(/[#&?]vst=(\d+(?:\.\d+)?)/);
    pendingSeek = m ? Number(m[1]) : null;
  }
  function applyPendingSeek(c) {
    if (pendingSeek == null || !c || c.v.readyState < 1) return;
    const t = pendingSeek;
    pendingSeek = null;
    c.v.currentTime = Math.min(t, finite(c.v.duration) || t);
    toast(c, `Jumped to ${VS.formatTime(t)}`);
  }
  readHashSeek();
  on(window, 'hashchange', () => { readHashSeek(); applyPendingSeek(pickActive()); });

  // ---------------------------------------------------------------- keyboard
  function isEditable(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const el of path) {
      if (!el || el.nodeType !== 1) continue;
      if (el.isContentEditable) return true;
      const tag = el.localName;
      if (tag === 'textarea' || tag === 'select') return true;
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (!['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type)) return true;
      }
      if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
      break; // only the innermost element decides
    }
    return false;
  }

  function actionFor(e) {
    for (const [action, b] of Object.entries(settings.bindings)) if (VS.bindingMatches(b, e)) return action;
    return null;
  }

  const onKeyDown = (e) => {
    if (!alive()) { teardown(); return; }
    if (e.isComposing || !siteEnabled() || isEditable(e)) return;
    const action = actionFor(e);
    if (!action) return;
    const c = pickActive();
    if (!c) {
      if (isTop && childHasVideo) {
        e.preventDefault();
        e.stopImmediatePropagation();
        send({ type: 'vs-relay-action', action });
      }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    run(action, c);
  };
  on(window, 'keydown', onKeyDown, true);
  // Swallow the matching keypress/keyup so players do not react to them either.
  const swallow = (e) => {
    if (!siteEnabled() || isEditable(e) || !actionFor(e)) return;
    if (pickActive() || (isTop && childHasVideo)) e.stopImmediatePropagation();
  };
  on(window, 'keypress', swallow, true);
  on(window, 'keyup', swallow, true);

  // ---------------------------------------------------------------- overlay (speed badge + toast)
  let overlayHost = null; let layer = null; let toastEl = null; let toastTimer = null;

  const ICONS = {
    rewind: '<svg viewBox="0 0 24 24"><path d="M11 6 4 12l7 6V6zm9 0-7 6 7 6V6z"/></svg>',
    advance: '<svg viewBox="0 0 24 24"><path d="m13 6 7 6-7 6V6zM4 6l7 6-7 6V6z"/></svg>',
    slower: '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
    faster: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    addNote: '<svg viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5V4zm9 1.5V9h3.5L14 5.5zM8 12h8v1.6H8V12zm0 3.2h6v1.6H8v-1.6z"/></svg>',
    screenshotNote: '<svg viewBox="0 0 24 24"><path d="M9 4h6l1.6 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.4L9 4zm3 4a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21V3z"/></svg>',
    openPanel: '<svg viewBox="0 0 24 24"><path d="M3 4h18v16H3V4zm2 2v12h9V6H5zm11 0v12h3V6h-3z"/></svg>',
    hideBadge: '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>',
  };

  const OVERLAY_CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; font: 500 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .badge { position: absolute; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px;
      background: rgba(18, 20, 28, 0.78); color: #fff; pointer-events: auto; opacity: var(--vs-op, 0.35);
      transition: opacity .18s ease; box-shadow: 0 2px 10px rgba(0,0,0,.25); user-select: none; -webkit-user-select: none; }
    .badge:hover, .badge:focus-within, .badge.flash { opacity: 1; }
    .badge.mode-onchange:not(:hover):not(.flash):not(:focus-within) { opacity: 0; }
    .rate { min-width: 46px; font-variant-numeric: tabular-nums; font-weight: 650; letter-spacing: .2px; }
    button { all: unset; box-sizing: border-box; cursor: pointer; height: 24px; min-width: 24px; padding: 0 6px; border-radius: 6px;
      display: inline-flex; align-items: center; justify-content: center; color: #fff; font: inherit; }
    button:hover { background: rgba(255,255,255,.16); }
    button:focus-visible { outline: 2px solid #ff8a3d; outline-offset: 1px; }
    button svg { width: 15px; height: 15px; fill: currentColor; }
    .ctl { display: none; align-items: center; gap: 1px; }
    .badge:hover .ctl, .badge:focus-within .ctl { display: inline-flex; }
    .sep { width: 1px; height: 16px; background: rgba(255,255,255,.25); margin: 0 3px; }
    .loop { display: none; padding: 0 6px; height: 20px; align-items: center; border-radius: 5px; background: #ff8a3d; color: #1b1b1b; font-weight: 700; font-size: 11px; }
    .badge.looping .loop { display: inline-flex; }
    .toast { position: absolute; max-width: min(440px, 80vw); padding: 8px 12px; border-radius: 10px; background: rgba(18,20,28,.9); color: #fff;
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; opacity: 0; transform: translate(-50%, -4px);
      transition: opacity .2s ease, transform .2s ease; pointer-events: none; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
  `;

  function overlayParent() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && !(fs instanceof HTMLVideoElement)) return fs;
    return document.documentElement;
  }

  function ensureOverlay() {
    if (overlayHost || dead) return;
    overlayHost = document.createElement('video-studio-overlay');
    overlayHost.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483646 !important; display: block !important;';
    const shadow = overlayHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${OVERLAY_CSS}</style><div class="layer"><div class="toast" role="status" aria-live="polite"></div></div>`;
    layer = shadow.querySelector('.layer');
    toastEl = shadow.querySelector('.toast');
    overlayParent().appendChild(overlayHost);
  }

  function title(action, text) {
    const b = settings.bindings[action];
    return b ? `${text} (${VS.bindingLabel(b)})` : text;
  }

  function buildBadge(c) {
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'badge';
    el.innerHTML = `
      <button class="rate" data-a="reset"></button>
      <span class="loop" title="A-B loop active">A–B</span>
      <span class="ctl">
        <button data-a="rewind"></button><button data-a="slower"></button><button data-a="faster"></button><button data-a="advance"></button>
        <span class="sep"></span>
        <button data-a="addNote"></button><button data-a="screenshotNote"></button><button data-a="bookmark"></button><button data-a="openPanel"></button>
        <span class="sep"></span><button data-a="hideBadge"></button>
      </span>`;
    for (const b of el.querySelectorAll('.ctl button')) b.innerHTML = ICONS[b.dataset.a] || '';
    const stop = (e) => { e.stopPropagation(); };
    el.addEventListener('pointerdown', stop);
    el.addEventListener('mousedown', stop);
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const btn = e.target.closest('button');
      if (btn) { active = c.v; run(btn.dataset.a, c, { allowTab: true }); }
    });
    c.badge = el;
    layer.appendChild(el);
    updateBadgeTitles(c);
    updateBadge(c);
  }

  function updateBadgeTitles(c) {
    if (!c.badge) return;
    const t = {
      reset: title('reset', 'Playback speed. Click to toggle 1x'), rewind: title('rewind', `Rewind ${settings.seekSeconds}s`),
      slower: title('slower', 'Slower'), faster: title('faster', 'Faster'), advance: title('advance', `Advance ${settings.seekSeconds}s`),
      addNote: title('addNote', 'Add note'), screenshotNote: title('screenshotNote', 'Add note with screenshot'),
      bookmark: title('bookmark', 'Add bookmark'), openPanel: 'Open notes panel', hideBadge: title('toggleOverlay', 'Hide badge'),
    };
    for (const b of c.badge.querySelectorAll('button')) {
      b.title = t[b.dataset.a] || '';
      b.setAttribute('aria-label', b.title);
    }
  }

  function formatRate(r) {
    return (Math.round(r * 100) / 100).toFixed(2) + '×';
  }

  function updateBadge(c, flash) {
    if (!c.badge) return;
    const showMode = siteEnabled() && !overlayHidden && settings.overlayMode !== 'never' && !captureHidden;
    c.badge.style.display = showMode && c.visible !== false ? '' : 'none';
    c.badge.classList.toggle('mode-onchange', settings.overlayMode === 'onchange');
    c.badge.classList.toggle('looping', !!c.loop.on);
    c.badge.style.setProperty('--vs-op', String(settings.overlayOpacity));
    c.badge.querySelector('.rate').textContent = formatRate(c.v.playbackRate);
    const loopEl = c.badge.querySelector('.loop');
    if (c.loop.on) loopEl.title = `Looping ${VS.formatTime(c.loop.a)} – ${VS.formatTime(c.loop.b)}`;
    if (flash) {
      c.badge.classList.add('flash');
      clearTimeout(c.flashTimer);
      c.flashTimer = setTimeout(() => c.badge && c.badge.classList.remove('flash'), 1400);
      if (!showMode && siteEnabled() && !captureHidden && settings.overlayMode === 'never') toast(c, formatRate(c.v.playbackRate), 900);
    }
  }

  function layout() {
    if (!overlayHost || dead) return;
    const parent = overlayParent();
    if (overlayHost.parentNode !== parent) parent.appendChild(overlayHost);
    for (const c of ctrls.values()) {
      if (!c.badge) continue;
      const r = c.v.getBoundingClientRect();
      const visible = r.width >= 120 && r.height >= 68 && r.bottom > 24 && r.right > 24 && r.top < innerHeight - 24 && r.left < innerWidth - 24 &&
        (typeof c.v.checkVisibility !== 'function' || c.v.checkVisibility({ visibilityProperty: true, opacityProperty: false }));
      c.visible = visible;
      if (!visible) { c.badge.style.display = 'none'; continue; }
      const top = Math.max(r.top, 0) + 8;
      c.badge.style.top = top + 'px';
      if (settings.overlayPosition === 'top-right') {
        c.badge.style.left = '';
        c.badge.style.right = Math.max(8, innerWidth - Math.min(r.right, innerWidth) + 8) + 'px';
      } else {
        c.badge.style.right = '';
        c.badge.style.left = Math.max(r.left, 0) + 8 + 'px';
      }
      updateBadge(c);
    }
  }
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layout(); });
  }
  on(window, 'scroll', scheduleLayout, { capture: true, passive: true });
  on(window, 'resize', scheduleLayout, { passive: true });
  on(document, 'fullscreenchange', scheduleLayout);
  on(document, 'webkitfullscreenchange', scheduleLayout);
  const layoutInterval = setInterval(() => { if (ctrls.size && document.visibilityState === 'visible') layout(); }, 400);
  cleanups.push(() => clearInterval(layoutInterval));

  function toast(c, text, ms = 1800) {
    ensureOverlay();
    if (!toastEl || captureHidden) return;
    let x = innerWidth / 2; let y = 16;
    if (c && c.v.isConnected) {
      const r = c.v.getBoundingClientRect();
      if (r.width > 0) {
        x = Math.min(innerWidth - 120, Math.max(120, r.left + r.width / 2));
        y = Math.min(innerHeight - 60, Math.max(8, r.top + 44));
      }
    }
    toastEl.style.left = x + 'px';
    toastEl.style.top = y + 'px';
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function refreshAll() {
    for (const c of ctrls.values()) { updateBadgeTitles(c); updateBadge(c); }
    scheduleLayout();
  }

  function setCaptureHidden(hidden) {
    captureHidden = hidden;
    if (overlayHost) overlayHost.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
    if (panel) panel.host.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
  }

  // ---------------------------------------------------------------- in-page notes panel (fallback when sidePanel is unavailable)
  let panel = null;
  const PANEL_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; top: 0; right: 0; bottom: 0; width: var(--w, 380px); max-width: 92vw; display: flex; background: #fff;
      box-shadow: -8px 0 32px rgba(0,0,0,.22); border-left: 1px solid rgba(0,0,0,.12); animation: slide .18s ease-out; }
    @media (prefers-color-scheme: dark) { .wrap { background: #16181f; border-left-color: rgba(255,255,255,.12); } }
    @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
    .grip { width: 6px; cursor: ew-resize; flex: none; background: transparent; }
    .grip:hover, .grip.drag { background: rgba(217, 72, 15, .35); }
    iframe { border: 0; flex: 1; width: 100%; height: 100%; color-scheme: normal; }
    .wrap.dragging iframe { pointer-events: none; }
  `;

  async function openPanel(mode) {
    if (!isTop) return;
    if (panel) {
      if (mode === 'toggle' || mode === 'close') closePanel();
      else panel.frame.focus();
      return;
    }
    if (mode === 'close') return;
    const who = await send({ type: 'vs-whoami' });
    if (!who || who.tabId == null) return;
    let width = 380;
    try { const { inpageWidth } = await chrome.storage.local.get('inpageWidth'); if (inpageWidth) width = inpageWidth; } catch (_) { /* default */ }
    const hostEl = document.createElement('video-studio-panel');
    hostEl.style.cssText = 'all: initial !important; position: fixed !important; z-index: 2147483647 !important; top: 0 !important; right: 0 !important; display: block !important;';
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${PANEL_CSS}</style><div class="wrap" style="--w:${width}px"><div class="grip" title="Drag to resize"></div><iframe title="Video Studio notes" allow="clipboard-write"></iframe></div>`;
    const frame = shadow.querySelector('iframe');
    frame.src = chrome.runtime.getURL('sidepanel/panel.html') + `?tab=${who.tabId}&win=${who.windowId}&embedded=1`;
    const wrap = shadow.querySelector('.wrap');
    const grip = shadow.querySelector('.grip');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('drag');
      wrap.classList.add('dragging');
      const move = (ev) => {
        width = Math.round(Math.min(innerWidth * 0.92, Math.max(300, innerWidth - ev.clientX)));
        wrap.style.setProperty('--w', width + 'px');
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.classList.remove('drag');
        wrap.classList.remove('dragging');
        try { chrome.storage.local.set({ inpageWidth: width }); } catch (_) { /* gone */ }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    document.documentElement.appendChild(hostEl);
    panel = { host: hostEl, frame };
  }

  function closePanel() {
    if (!panel) return;
    panel.host.remove();
    panel = null;
  }

  // ---------------------------------------------------------------- messages from the extension
  async function handle(msg) {
    const c = pickActive();
    switch (msg.type) {
      case 'vs-get-state':
        return state(c);
      case 'vs-action': {
        if (!c) return Object.assign(state(null), { error: 'no-video' });
        if (msg.action === 'seekRel') {
          c.v.currentTime = Math.max(0, c.v.currentTime + Number(msg.delta || 0));
          return state(c);
        }
        const result = await run(msg.action, c, { allowTab: !!msg.allowTab });
        return Object.assign(state(c), { result });
      }
      case 'vs-set-rate':
        if (!c) return state(null);
        setRate(c, msg.rate);
        return state(c);
      case 'vs-seek':
        if (!c) return state(null);
        c.v.currentTime = Math.max(0, Math.min(Number(msg.t) || 0, finite(c.v.duration) || Infinity));
        if (msg.play) c.v.play().catch(() => {});
        return state(c);
      case 'vs-play':
        if (c) await c.v.play().catch(() => {});
        return state(c);
      case 'vs-pause':
        if (c) c.v.pause();
        return state(c);
      case 'vs-toggle-play':
        if (c) { if (c.v.paused) await c.v.play().catch(() => {}); else c.v.pause(); }
        return state(c);
      case 'vs-set-loop':
        if (!c) return state(null);
        c.loop = {
          a: Number.isFinite(msg.a) ? msg.a : null,
          b: Number.isFinite(msg.b) ? msg.b : null,
          on: !!msg.on && Number.isFinite(msg.a) && Number.isFinite(msg.b) && msg.b > msg.a,
        };
        if (c.loop.on && (c.v.currentTime < c.loop.a || c.v.currentTime > c.loop.b)) c.v.currentTime = c.loop.a;
        updateBadge(c, true);
        return state(c);
      case 'vs-capture-frame': {
        if (!c) return { ok: false, reason: 'no-video' };
        const r = await captureWithFallback(c, { allowTab: !!msg.allowTab, seekTo: msg.seekTo });
        return Object.assign(r, { time: c.v.currentTime });
      }
      case 'vs-capture-tab': {
        if (!c) return { ok: false, reason: 'no-video' };
        const r = await captureViaTab(c, msg.seekTo);
        return Object.assign(r, { time: c.v.currentTime });
      }
      case 'vs-thumb':
        return { thumb: c ? await makeThumb(c) : null };
      default:
        return undefined;
    }
  }

  const onMessage = (msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vs-') || sender.id !== chrome.runtime.id) return false;
    if (msg.type === 'vs-capture-hide' || msg.type === 'vs-capture-show') {
      setCaptureHidden(msg.type === 'vs-capture-hide');
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'vs-inpage-panel') {
      if (!isTop) return false;
      openPanel(msg.mode || 'toggle').then(() => sendResponse({ ok: true, open: !!panel }));
      return true;
    }
    handle(msg).then(
      (r) => sendResponse(r === undefined ? { error: 'unknown' } : r),
      (e) => sendResponse({ error: 'exception', message: String(e && e.message || e) }),
    );
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  cleanups.push(() => { try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) { /* gone */ } });

  // ---------------------------------------------------------------- lifecycle
  function teardown() {
    if (dead) return;
    dead = true;
    mo.disconnect();
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) { /* ignore */ } }
    for (const c of Array.from(ctrls.values())) detach(c);
    if (overlayHost) overlayHost.remove();
    closePanel();
    window.__videoStudioContent = false;
  }
  on(document, 'video-studio-reset', teardown);

  observeRoot(document);
  on(document, 'play', onMediaEventCapture, true);
  on(document, 'loadedmetadata', onMediaEventCapture, true);
  on(window, 'pagehide', () => { if (ctrls.size) send({ type: 'vs-frame-video', hasVideo: false }); });
  on(window, 'pageshow', (e) => { if (e.persisted) { lastReported = null; reportFrame(false); } });
  loadSettings();
  deepScan();
  // Re-scan for videos inside shadow roots that appear later (the mutation observer only
  // sees shadow roots it already knows about).
  let deepCount = 0;
  const deepTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    deepCount++;
    if (deepCount <= 6 || deepCount % 4 === 0) deepScan();
    prune();
  }, 2500);
  cleanups.push(() => clearInterval(deepTimer));
})();
