// Injected on demand by the service worker into tabs of a gated site when a pass is
// about to end (toast) or has ended (full-page overlay). Safe to inject repeatedly.
(() => {
  if (window.__mindfulGateRun) { window.__mindfulGateRun(); return; }

  const HOST_ID = 'mindful-gate-overlay-host';
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .scrim { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
      background: rgba(18, 20, 18, .72); backdrop-filter: blur(10px) saturate(.6); -webkit-backdrop-filter: blur(10px) saturate(.6);
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d1c1a; animation: fade .25s ease-out; }
    .panel { width: min(460px, 100%); background: #fff; border-radius: 16px; padding: 32px; display: grid; gap: 16px;
      text-align: center; box-shadow: 0 24px 64px rgba(0,0,0,.35); }
    h2 { margin: 0; font-size: 24px; line-height: 1.25; }
    p { margin: 0; color: #57544d; }
    .intent { background: #f0eee8; border-radius: 10px; padding: 12px 16px; font-style: italic; color: #1d1c1a; }
    .row { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    button { font: 600 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; min-height: 44px; padding: 0 20px;
      border-radius: 10px; border: 1px solid #e2dfd6; background: #fff; color: #1d1c1a; cursor: pointer; }
    button:hover { background: #f0eee8; }
    button:focus-visible { outline: 2px solid #2a78d6; outline-offset: 2px; }
    button.primary { background: #2f6f5e; border-color: #2f6f5e; color: #fff; }
    button.primary:hover { filter: brightness(1.08); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .small { font-size: 12px; color: #8a867c; }
    .err { color: #b3261e; font-size: 13px; }
    .toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(340px, calc(100vw - 32px));
      background: #1d1c1a; color: #f1f0ea; border-radius: 12px; padding: 14px 16px; display: grid; gap: 6px;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 12px 32px rgba(0,0,0,.3); animation: up .25s ease-out; }
    .toast strong { font-size: 14px; }
    .toast .meta { color: #c3c2b7; font-size: 13px; }
    .toast button { min-height: 28px; padding: 0 10px; font-size: 12px; background: transparent; color: #f1f0ea; border-color: #57544d; justify-self: end; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1e201d; color: #f1f0ea; }
      p { color: #c3c2b7; }
      .intent { background: #272a26; color: #f1f0ea; }
      button { background: #1e201d; color: #f1f0ea; border-color: #353832; }
      button:hover { background: #272a26; }
      button.primary { background: #6cc2a6; border-color: #6cc2a6; color: #0d1f19; }
    }
    @keyframes fade { from { opacity: 0; } }
    @keyframes up { from { opacity: 0; transform: translateY(12px); } }
    @media (prefers-reduced-motion: reduce) { .scrim, .toast { animation: none; } }
  `;

  let toastTimer = null;
  let pausedMedia = [];

  function host() {
    let h = document.getElementById(HOST_ID);
    if (!h) {
      h = document.createElement('div');
      h.id = HOST_ID;
      const root = h.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.append(style);
      (document.body || document.documentElement).append(h);
    }
    return h.shadowRoot;
  }

  function clear() {
    const h = document.getElementById(HOST_ID);
    if (h) h.remove();
    clearTimeout(toastTimer);
  }

  function node(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids);
    return n;
  }

  function send(type, extra = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (res && res.error) return reject(new Error(res.error));
          resolve(res);
        });
      } catch (e) { reject(e); }
    });
  }

  function pauseMedia() {
    pausedMedia = [];
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused) { try { m.pause(); pausedMedia.push(m); } catch { /* ignore */ } }
    }
  }

  function showWarn(info) {
    clear();
    const root = host();
    const mins = Math.max(1, Math.round((info.until - Date.now()) / 60000));
    const close = node('button', { type: 'button', textContent: 'Got it' });
    const t = node('div', { className: 'toast', role: 'status' },
      node('strong', { textContent: `About ${mins} minute${mins === 1 ? '' : 's'} left on ${info.domain}` }),
      node('span', { className: 'meta', textContent: info.intention ? `Your intention: ${info.intention}` : 'Start wrapping up.' }),
      close);
    close.addEventListener('click', clear);
    root.append(t);
    toastTimer = setTimeout(clear, 15000);
  }

  function showExpired(info) {
    clear();
    pauseMedia();
    const root = host();
    let waitLeft = Math.max(0, info.pause | 0);
    const leave = node('button', { type: 'button', className: 'primary', textContent: 'Leave site' });
    const extend = node('button', { type: 'button', textContent: `Extend ${info.extendMinutes} min`, disabled: waitLeft > 0 });
    const err = node('p', { className: 'err', hidden: true });
    const panel = node('div', { className: 'panel', role: 'dialog', ariaModal: 'true', ariaLabel: 'Your pass has ended' },
      node('h2', { textContent: 'Your time is up.' }),
      info.intention
        ? node('p', {}, 'You came to ', node('strong', { textContent: info.domain }), ' to:')
        : node('p', { textContent: `Your pass for ${info.domain} has ended.` }),
      ...(info.intention ? [node('div', { className: 'intent', textContent: info.intention })] : []),
      node('p', { textContent: 'Did you do it? Leaving now is the win.' }),
      node('div', { className: 'row' }, leave, extend),
      err,
      node('p', { className: 'small', textContent: 'Extending counts as another visit today.' }));
    const scrim = node('div', { className: 'scrim' }, panel);
    root.append(scrim);
    leave.focus();

    const timer = setInterval(() => {
      waitLeft--;
      if (waitLeft > 0) extend.textContent = `Extend in ${waitLeft}s`;
      else { clearInterval(timer); extend.textContent = `Extend ${info.extendMinutes} min`; extend.disabled = false; }
    }, 1000);
    if (waitLeft > 0) extend.textContent = `Extend in ${waitLeft}s`;

    // Keep the page underneath inert: swallow keyboard shortcuts (e.g. video players).
    const trap = e => { if (!e.composedPath().includes(scrim)) { e.stopPropagation(); if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault(); } };
    window.addEventListener('keydown', trap, true);
    const mediaGuard = setInterval(() => {
      if (!document.getElementById(HOST_ID)) { clearInterval(mediaGuard); return; }
      for (const m of document.querySelectorAll('video, audio')) if (!m.paused) m.pause();
    }, 1000);

    leave.addEventListener('click', async () => {
      leave.disabled = true;
      try { await send('leaveSite'); } catch (e) { err.textContent = e.message; err.hidden = false; leave.disabled = false; }
    });
    extend.addEventListener('click', async () => {
      extend.disabled = true;
      try {
        await send('extendPass', { intention: info.intention ? `${info.intention} (extended)` : 'Extended' });
        window.removeEventListener('keydown', trap, true);
        clearInterval(mediaGuard);
        clear();
        for (const m of pausedMedia) { try { m.play(); } catch { /* ignore */ } }
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
  }

  async function run() {
    let info;
    try { info = await send('overlayInfo'); } catch { return; }
    if (!info || info.mode === 'none') { clear(); return; }
    if (info.mode === 'warn') showWarn(info);
    else if (info.mode === 'expired') showExpired(info);
  }

  window.__mindfulGateRun = run;
  run();
})();
