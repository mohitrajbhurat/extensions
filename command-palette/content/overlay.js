// In-page overlay host. Injected on demand (activeTab + scripting) together with
// ui/palette-ui.js. Running it again toggles the palette.
(function () {
  'use strict';
  if (window.__commandPaletteOverlay) { window.__commandPaletteOverlay.toggle(); return; }

  const UI = globalThis.CommandPaletteUI;
  const ISOLATE_EVENTS = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut',
    'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout', 'wheel', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'contextmenu'];
  let hostEl = null;
  let ui = null;
  let prevFocus = null;
  let toastHost = null;
  let toastTimer = null;

  function makeHost(tag) {
    const h = document.createElement(tag);
    h.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: auto !important;';
    const shadow = h.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI.CSS;
    shadow.appendChild(style);
    return { h, shadow };
  }

  function mountPoint() {
    return document.fullscreenElement || document.documentElement || document.body;
  }

  function isOpen() { return !!(hostEl && hostEl.isConnected); }

  function open() {
    if (isOpen()) { ui.focus(); return; }
    prevFocus = document.activeElement;
    const { h, shadow } = makeHost('command-palette-overlay');
    hostEl = h;
    // Keep keystrokes and clicks inside the palette from reaching page handlers.
    for (const t of ISOLATE_EVENTS) h.addEventListener(t, e => e.stopPropagation());
    mountPoint().appendChild(h);
    ui = UI.mount(shadow, {
      mode: 'overlay',
      ctx: null,
      send: msg => chrome.runtime.sendMessage(msg),
      close,
    });
  }

  function close(result) {
    result = result || {};
    if (ui) { ui.destroy(); ui = null; }
    if (hostEl) { hostEl.remove(); hostEl = null; }
    try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    prevFocus = null;
    if (result.toast) showToast(result.toast);
    if (result.pageOp) setTimeout(() => pageOp(result.pageOp), 60);
  }

  function showToast(msg) {
    if (!toastHost) {
      const { h, shadow } = makeHost('command-palette-toast');
      h.style.setProperty('pointer-events', 'none', 'important');
      h.style.setProperty('inset', 'auto 0 0 0', 'important');
      h.style.setProperty('height', '0', 'important');
      const wrap = document.createElement('div');
      wrap.className = 'cp-root';
      const t = document.createElement('div');
      t.className = 'cp-toast';
      t.setAttribute('role', 'status');
      wrap.appendChild(t);
      shadow.appendChild(wrap);
      toastHost = { h, t };
    }
    if (!toastHost.h.isConnected) mountPoint().appendChild(toastHost.h);
    const t = toastHost.t;
    t.textContent = msg;
    // Restart the transition.
    t.classList.remove('cp-show');
    void t.offsetWidth;
    t.classList.add('cp-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('cp-show');
      setTimeout(() => { if (toastHost && !t.classList.contains('cp-show')) toastHost.h.remove(); }, 250);
    }, 1600);
  }

  function pageOp(op) {
    const el = document.scrollingElement || document.documentElement;
    if (op === 'scrollTop') el.scrollTo({ top: 0, behavior: 'smooth' });
    else if (op === 'scrollBottom') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else if (op === 'print') window.print();
  }

  window.__commandPaletteOverlay = {
    toggle() { if (isOpen()) close({}); else open(); },
    open,
    close,
  };
  open();
})();
