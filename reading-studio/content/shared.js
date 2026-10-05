// Reading Studio content runtime: namespace, live settings, message routing, small DOM helpers.
(function () {
  if (globalThis.RS) return;
  const S = globalThis.RS_SETTINGS;

  const RS = {
    settings: S ? S.clone(S.DEFAULTS) : {},
    sites: {},
    handlers: {},          // action -> async fn(args) ; filled by feature modules
    listeners: new Set(),  // fn(settings, changedSections)
    isTop: window === window.top,
    host: location.hostname || '',
    ready: null
  };
  globalThis.RS = RS;

  // Top-level host for per-site rules (subframes inherit the tab's site).
  RS.siteHost = (() => {
    if (RS.isTop) return RS.host;
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname;
    } catch (e) { /* ignore */ }
    return RS.host;
  })();

  RS.ready = (async () => {
    try {
      RS.settings = S ? await S.load() : RS.settings;
      RS.sites = S ? await S.getSites() : {};
    } catch (e) { /* storage unavailable */ }
  })();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      const changed = new Set();
      if (area === 'sync' && changes.settings) {
        const next = S.merge(S.DEFAULTS, changes.settings.newValue);
        for (const k of Object.keys(next)) {
          if (JSON.stringify(next[k]) !== JSON.stringify(RS.settings[k])) changed.add(k);
        }
        RS.settings = next;
      }
      if (area === 'local' && changes.sites) {
        RS.sites = changes.sites.newValue || {};
        changed.add('sites');
      }
      if (changed.size) for (const fn of RS.listeners) { try { fn(RS.settings, changed); } catch (e) { console.warn('[Reading Studio]', e); } }
    });
  } catch (e) { /* not in extension context */ }

  RS.onSettings = (fn) => RS.listeners.add(fn);

  RS.saveSettings = (patch) => S.update(patch).catch(() => {});

  // Message router: background and popup talk to the top frame through { action, args }.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.action) return false;
      if (msg.action === 'ping') {
        sendResponse({ ok: true, full: !!RS.fullLoaded, top: RS.isTop });
        return false;
      }
      if (!RS.isTop && !msg.allFrames) return false;
      const h = RS.handlers[msg.action];
      if (!h) return false;
      Promise.resolve()
        .then(() => RS.ready)
        .then(() => h(msg.args || {}))
        .then((res) => sendResponse({ ok: true, result: res }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    });
  } catch (e) { /* ignore */ }

  // ---- DOM helpers -------------------------------------------------------
  RS.h = function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // only used with extension-authored static markup
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  };

  // A UI host element with an open shadow root, isolated from page CSS.
  RS.createHost = function (id, zIndex) {
    let host = document.getElementById(id);
    if (host) host.remove();
    host = document.createElement('rs-ui');
    host.id = id;
    host.setAttribute('data-rs-ui', '');
    host.style.cssText = `all:initial !important; position:fixed !important; z-index:${zIndex} !important; inset:auto !important; display:block !important;`;
    const root = host.attachShadow({ mode: 'open' });
    (document.documentElement || document).appendChild(host);
    return { host, root };
  };

  RS.isOurUI = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-rs-ui]'));
  };

  RS.prefersDark = () => {
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  };

  RS.pageKey = () => location.origin + location.pathname + location.search;

  RS.toast = function (text, ms = 2200) {
    const { host, root } = RS.createHost('rs-toast', 2147483647);
    host.style.setProperty('left', '50%', 'important');
    host.style.setProperty('top', '16px', 'important');
    host.style.setProperty('transform', 'translateX(-50%)', 'important');
    root.innerHTML = `<style>
      div{font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;background:rgba(28,28,34,.94);
      padding:8px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:70vw;animation:in .18s ease-out}
      @keyframes in{from{opacity:0;transform:translateY(-6px)}}</style><div role="status"></div>`;
    root.querySelector('div').textContent = text;
    clearTimeout(RS._toastT);
    RS._toastT = setTimeout(() => host.remove(), ms);
  };

  // Shared icons (static SVG markup authored by the extension).
  RS.icons = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6v12l-9-6z" fill="currentColor"/><rect x="6" y="6" width="2" height="12" rx="1" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6v12l9-6z" fill="currentColor"/><rect x="16" y="6" width="2" height="12" rx="1" fill="currentColor"/></svg>',
    paraPrev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12l-8-6zM20 6v12l-8-6z" fill="currentColor"/></svg>',
    paraNext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12l8-6zM12 6v12l8-6z" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19l5-14h1.5l5 14M5 14h7.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 12.5c.6-1 1.6-1.5 2.8-1.5 1.8 0 2.7 1 2.7 2.7V19m0-3.6c-.6-.4-1.5-.6-2.6-.6-1.7 0-2.9.8-2.9 2.2 0 1.2.9 2 2.3 2 1.5 0 2.6-.8 3.2-2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    headphones: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="3" y="14" width="5" height="7" rx="2" fill="currentColor"/><rect x="16" y="14" width="5" height="7" rx="2" fill="currentColor"/></svg>',
    ruler: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="9" width="20" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3 5h18M3 19h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".45"/></svg>',
    bold: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="1.4" fill="currentColor"/><circle cx="15" cy="7" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="17" r="1.4" fill="currentColor"/><circle cx="15" cy="17" r="1.4" fill="currentColor"/></svg>'
  };
})();
