// Command Palette UI. A classic script shared by the in-page overlay (inside a shadow
// root) and the extension popup / fallback window. Exposes globalThis.CommandPaletteUI.
// All searching and running happens in the service worker; this file only renders and
// handles input.
(function () {
  'use strict';
  if (globalThis.CommandPaletteUI) return;

  const GLYPHS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>',
    tab: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M8 5v4"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    incognito: '<path d="M3 11h18M6 11l2-6h8l2 6"/><circle cx="7.5" cy="16" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/><path d="M10 16h4"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    pin: '<path d="M12 16v6M8 3h8l-1.5 6L18 13H6l3.5-4z"/>',
    sound: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
    reload: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
    swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    restore: '<path d="M3 12a9 9 0 1 0 2.64-6.36"/><path d="M3 4v5h5"/>',
    move: '<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M11 17h10M17 13l4 4-4 4"/>',
    merge: '<path d="M6 4v4a6 6 0 0 0 12 0V4M12 14v7"/>',
    group: '<rect x="3" y="7" width="13" height="11" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/>',
    sort: '<path d="M4 6h10M4 12h7M4 18h4M17 4v16M14 17l3 3 3-3"/>',
    sleep: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
    star: '<path d="M12 3l2.8 5.8 6.2.8-4.5 4.4 1.1 6.3L12 17.3l-5.6 3 1.1-6.3L3 9.6l6.2-.8z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
    print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21M8 11h6M11 8v6"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21M8 11h6"/>',
    zoomReset: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21M10 9l1.5-1v6"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    puzzle: '<path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  };
  const GROUP_COLORS = { grey: '#8a8f98', blue: '#3b82f6', red: '#ef4444', yellow: '#eab308', green: '#22c55e', pink: '#ec4899', purple: '#a855f7', cyan: '#06b6d4', orange: '#f97316' };

  function svg(name, cls) {
    return '<svg class="' + (cls || 'cp-glyph') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (GLYPHS[name] || GLYPHS.command) + '</svg>';
  }

  const CSS = `
:host { all: initial; }
.cp-root, .cp-root * { box-sizing: border-box; }
.cp-root {
  --cp-bg: #ffffff; --cp-fg: #1b1b1f; --cp-muted: #6b6b76; --cp-faint: #9a9aa5;
  --cp-border: rgba(0,0,0,.09); --cp-sel: #eef0ff; --cp-sel-border: rgba(91,91,214,.28);
  --cp-accent: #5b5bd6; --cp-accent-fg: #ffffff; --cp-mark: #4747c2; --cp-badge: #f1f1f4;
  --cp-backdrop: rgba(17,17,26,.32); --cp-shadow: 0 24px 64px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.08);
  --cp-error: #c2410c; --cp-kbd: #f4f4f6;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px; line-height: 1.4; color: var(--cp-fg); letter-spacing: normal; text-align: left;
  -webkit-font-smoothing: antialiased;
}
.cp-root[data-theme="dark"] {
  --cp-bg: #1d1d22; --cp-fg: #ececf1; --cp-muted: #a0a0ac; --cp-faint: #74747f;
  --cp-border: rgba(255,255,255,.09); --cp-sel: #2b2b3a; --cp-sel-border: rgba(139,139,255,.35);
  --cp-accent: #8b8bff; --cp-accent-fg: #14141a; --cp-mark: #a9a9ff; --cp-badge: #2a2a31;
  --cp-backdrop: rgba(0,0,0,.5); --cp-shadow: 0 24px 64px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.4);
  --cp-error: #fb923c; --cp-kbd: #2a2a31;
}
@media (prefers-color-scheme: dark) {
  .cp-root:not([data-theme="light"]) {
    --cp-bg: #1d1d22; --cp-fg: #ececf1; --cp-muted: #a0a0ac; --cp-faint: #74747f;
    --cp-border: rgba(255,255,255,.09); --cp-sel: #2b2b3a; --cp-sel-border: rgba(139,139,255,.35);
    --cp-accent: #8b8bff; --cp-accent-fg: #14141a; --cp-mark: #a9a9ff; --cp-badge: #2a2a31;
    --cp-backdrop: rgba(0,0,0,.5); --cp-shadow: 0 24px 64px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.4);
    --cp-error: #fb923c; --cp-kbd: #2a2a31;
  }
}
.cp-root[data-mode="overlay"] { position: fixed; inset: 0; z-index: 2147483647; }
.cp-backdrop { position: fixed; inset: 0; background: var(--cp-backdrop); animation: cp-fade .12s ease-out; }
.cp-panel {
  display: flex; flex-direction: column; background: var(--cp-bg); color: var(--cp-fg); overflow: hidden;
}
.cp-root[data-mode="overlay"] .cp-panel {
  position: fixed; left: 50%; top: 14vh; transform: translateX(-50%);
  width: min(680px, calc(100vw - 32px)); max-height: min(560px, 76vh);
  border-radius: 16px; border: 1px solid var(--cp-border); box-shadow: var(--cp-shadow);
  animation: cp-pop .14s cubic-bezier(.2,.9,.3,1.2);
}
.cp-root[data-mode="popup"] .cp-panel { width: 420px; height: 520px; }
.cp-root[data-mode="window"] .cp-panel { width: 100vw; height: 100vh; }
@keyframes cp-fade { from { opacity: 0; } }
@keyframes cp-pop { from { opacity: 0; transform: translateX(-50%) scale(.97); } }
@media (prefers-reduced-motion: reduce) { .cp-backdrop, .cp-root[data-mode="overlay"] .cp-panel { animation: none; } }

.cp-head { display: flex; align-items: center; gap: 8px; padding: 0 16px; height: 56px; border-bottom: 1px solid var(--cp-border); flex: none; }
.cp-head .cp-glyph { width: 20px; height: 20px; color: var(--cp-muted); flex: none; }
.cp-back { all: unset; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; color: var(--cp-muted); cursor: pointer; flex: none; }
.cp-back:hover { background: var(--cp-badge); color: var(--cp-fg); }
.cp-back:focus-visible { outline: 2px solid var(--cp-accent); outline-offset: 1px; }
.cp-back .cp-glyph { width: 18px; height: 18px; }
.cp-chip { flex: none; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: var(--cp-accent); color: var(--cp-accent-fg); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.cp-input {
  all: unset; flex: 1; min-width: 0; height: 100%; font: inherit; font-size: 17px; color: var(--cp-fg);
  caret-color: var(--cp-accent);
}
.cp-input::placeholder { color: var(--cp-faint); }
.cp-kbd { font: 600 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--cp-muted); background: var(--cp-kbd); border: 1px solid var(--cp-border); border-radius: 5px; padding: 3px 6px; white-space: nowrap; }

.cp-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 8px; scroll-padding: 8px; min-height: 0; }
.cp-root[data-mode="overlay"] .cp-list { max-height: 440px; }
.cp-list::-webkit-scrollbar { width: 10px; }
.cp-list::-webkit-scrollbar-thumb { background: var(--cp-border); border-radius: 8px; border: 3px solid var(--cp-bg); }
.cp-section { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--cp-faint); padding: 12px 8px 4px; }
.cp-section:first-child { padding-top: 4px; }
.cp-item {
  display: flex; align-items: center; gap: 12px; padding: 8px; border-radius: 10px; cursor: pointer;
  border: 1px solid transparent; min-height: 48px; position: relative;
}
.cp-item[aria-selected="true"] { background: var(--cp-sel); border-color: var(--cp-sel-border); }
.cp-icon { width: 32px; height: 32px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--cp-badge); color: var(--cp-muted); }
.cp-icon img { width: 16px; height: 16px; display: block; }
.cp-icon .cp-glyph { width: 18px; height: 18px; }
.cp-item[aria-selected="true"] .cp-icon { color: var(--cp-accent); }
.cp-text { flex: 1; min-width: 0; }
.cp-title, .cp-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cp-title { font-size: 14px; font-weight: 500; }
.cp-sub { font-size: 12px; color: var(--cp-muted); margin-top: 1px; }
.cp-title mark, .cp-sub mark { background: none; color: var(--cp-mark); font-weight: 700; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.cp-meta { flex: none; font-size: 12px; color: var(--cp-faint); max-width: 30%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cp-badge { flex: none; font-size: 11px; font-weight: 600; color: var(--cp-muted); background: var(--cp-badge); padding: 2px 8px; border-radius: 999px; }
.cp-item[aria-selected="true"] .cp-badge { background: var(--cp-bg); }
.cp-close { all: unset; display: none; width: 24px; height: 24px; border-radius: 6px; align-items: center; justify-content: center; color: var(--cp-muted); flex: none; cursor: pointer; }
.cp-close .cp-glyph { width: 14px; height: 14px; }
.cp-item:hover .cp-close, .cp-item[aria-selected="true"] .cp-close { display: inline-flex; }
.cp-close:hover { background: var(--cp-bg); color: var(--cp-error); }
.cp-root[data-mode="popup"] .cp-meta { display: none; }
.cp-empty { padding: 32px 16px; text-align: center; color: var(--cp-muted); }
.cp-empty b { color: var(--cp-fg); }

.cp-foot { display: flex; align-items: center; gap: 16px; padding: 8px 16px; border-top: 1px solid var(--cp-border); font-size: 12px; color: var(--cp-muted); flex: none; min-height: 40px; }
.cp-foot .cp-hints { display: flex; gap: 12px; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; }
.cp-foot .cp-hints span { display: inline-flex; align-items: center; gap: 4px; }
.cp-foot .cp-kbd { padding: 2px 5px; }
.cp-foot .cp-count { flex: none; }
.cp-root[data-mode="popup"] .cp-hint-extra { display: none !important; }
.cp-foot .cp-prefix-help { color: var(--cp-faint); }

.cp-toast {
  position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%) translateY(8px); opacity: 0;
  background: var(--cp-fg); color: var(--cp-bg); font-size: 13px; font-weight: 500; padding: 8px 16px; border-radius: 10px;
  box-shadow: var(--cp-shadow); pointer-events: none; transition: opacity .15s, transform .15s; z-index: 2147483647; max-width: calc(100vw - 32px);
}
.cp-toast.cp-show { opacity: 1; transform: translateX(-50%) translateY(0); }
.cp-toast.cp-error { background: var(--cp-error); color: #fff; }
`;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /** Render text with highlighted character indices into `parent` (no innerHTML). */
  function highlight(parent, text, indices) {
    parent.textContent = '';
    text = text || '';
    if (!indices || !indices.length) { parent.textContent = text; return; }
    const set = new Set(indices);
    let buf = '';
    let inMark = false;
    const flush = () => {
      if (!buf) return;
      if (inMark) { const m = document.createElement('mark'); m.textContent = buf; parent.appendChild(m); }
      else parent.appendChild(document.createTextNode(buf));
      buf = '';
    };
    for (let i = 0; i < text.length; i++) {
      const hit = set.has(i);
      if (hit !== inMark) { flush(); inMark = hit; }
      buf += text[i];
    }
    flush();
  }

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /**
   * Mount the palette.
   * host: { mode: 'overlay'|'popup'|'window', ctx, send(msg) -> Promise, close(result), pageOp(op) }
   */
  function mount(container, host) {
    const root = el('div', 'cp-root');
    root.dataset.mode = host.mode;
    root.innerHTML =
      (host.mode === 'overlay' ? '<div class="cp-backdrop"></div>' : '') +
      '<div class="cp-panel" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<div class="cp-head">' +
          '<button class="cp-back" type="button" title="Back (Esc)" aria-label="Back" hidden>' + svg('back') + '</button>' +
          '<span class="cp-search-icon">' + svg('search') + '</span>' +
          '<span class="cp-chip" hidden></span>' +
          '<input class="cp-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cp-list" spellcheck="false" autocomplete="off">' +
          '<span class="cp-kbd cp-esc">esc</span>' +
        '</div>' +
        '<div class="cp-list" id="cp-list" role="listbox" aria-label="Results"></div>' +
        '<div class="cp-foot">' +
          '<div class="cp-hints">' +
            '<span><span class="cp-kbd">↑↓</span> navigate</span>' +
            '<span><span class="cp-kbd">↵</span> <span class="cp-enter-label">open</span></span>' +
            '<span class="cp-hint-extra"><span class="cp-kbd">⇧↵</span> <span class="cp-shift-label">new tab</span></span>' +
            '<span class="cp-hint-extra cp-prefix-help">/ actions · &gt; tabs · # bookmarks · @ history</span>' +
          '</div>' +
          '<span class="cp-count"></span>' +
        '</div>' +
      '</div>' +
      '<div class="cp-toast" role="status" aria-live="polite"></div>';
    container.appendChild(root);

    const $ = s => root.querySelector(s);
    const input = $('.cp-input');
    const list = $('.cp-list');
    const chip = $('.cp-chip');
    const back = $('.cp-back');
    const searchIcon = $('.cp-search-icon');
    const count = $('.cp-count');
    const toastEl = $('.cp-toast');
    const DEFAULT_PLACEHOLDER = 'Search tabs, bookmarks, history and actions…';
    input.placeholder = DEFAULT_PLACEHOLDER;

    let items = [];
    let sel = 0;
    let seq = 0;
    let shownSeq = 0;
    let listStack = []; // [{ id, title, placeholder, savedQuery }]
    let busy = false;
    let settings = { enterOpens: 'current' };
    let lastMouse = { x: -1, y: -1 };
    let toastTimer = null;
    let destroyed = false;

    function toast(msg, isError) {
      clearTimeout(toastTimer);
      toastEl.textContent = msg;
      toastEl.classList.toggle('cp-error', !!isError);
      toastEl.classList.add('cp-show');
      toastTimer = setTimeout(() => toastEl.classList.remove('cp-show'), isError ? 3200 : 1600);
    }

    function currentList() { return listStack[listStack.length - 1] || null; }

    function updateHead(res) {
      const l = currentList();
      back.hidden = !l;
      searchIcon.hidden = !!l;
      if (l) {
        chip.hidden = false; chip.textContent = l.title;
        input.placeholder = l.placeholder || 'Filter…';
      } else {
        const label = res && res.modeLabel;
        chip.hidden = !label;
        chip.textContent = label || '';
        input.placeholder = DEFAULT_PLACEHOLDER;
      }
    }

    function iconFor(it) {
      const box = el('div', 'cp-icon');
      const ic = it.icon || {};
      if (ic.color && GROUP_COLORS[ic.color]) { box.style.color = GROUP_COLORS[ic.color]; }
      if (ic.fav) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => { box.innerHTML = svg(ic.glyph || 'globe'); }, { once: true });
        img.src = ic.fav;
        box.appendChild(img);
      } else {
        box.innerHTML = svg(ic.glyph || 'command');
      }
      return box;
    }

    function render() {
      list.textContent = '';
      if (!items.length) {
        const q = input.value.trim();
        const empty = el('div', 'cp-empty');
        if (q) { empty.textContent = 'No results for '; const b = document.createElement('b'); b.textContent = '“' + q + '”'; empty.appendChild(b); }
        else empty.textContent = currentList() ? 'Nothing here.' : 'Start typing to search.';
        list.appendChild(empty);
        input.removeAttribute('aria-activedescendant');
        count.textContent = '';
        return;
      }
      const frag = document.createDocumentFragment();
      items.forEach((it, i) => {
        if (it.section) frag.appendChild(el('div', 'cp-section')).textContent = it.section;
        const row = el('div', 'cp-item');
        row.id = 'cp-opt-' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
        row.dataset.index = i;
        row.appendChild(iconFor(it));
        const text = el('div', 'cp-text');
        const t = el('div', 'cp-title'); highlight(t, it.title, it.hl && it.hl.title);
        text.appendChild(t);
        if (it.sub) { const s = el('div', 'cp-sub'); highlight(s, it.sub, it.hl && it.hl.sub); text.appendChild(s); }
        row.appendChild(text);
        if (it.meta) { const m = el('div', 'cp-meta'); m.textContent = it.meta; m.title = it.meta; row.appendChild(m); }
        if (it.badge) { const b = el('span', 'cp-badge'); b.textContent = it.badge; row.appendChild(b); }
        if (it.closable) {
          const c = el('button', 'cp-close', svg('x'));
          c.type = 'button'; c.title = 'Close tab (Shift+Delete)'; c.setAttribute('aria-label', 'Close tab');
          c.tabIndex = -1;
          c.addEventListener('click', e => { e.stopPropagation(); closeTabAt(i); });
          row.appendChild(c);
        }
        frag.appendChild(row);
      });
      list.appendChild(frag);
      count.textContent = items.length + (items.length === 1 ? ' result' : ' results');
      updateSelection(true);
    }

    function updateSelection(scroll) {
      const prev = list.querySelector('[aria-selected="true"]');
      if (prev) prev.setAttribute('aria-selected', 'false');
      const row = list.querySelector('#cp-opt-' + sel);
      if (!row) return;
      row.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', row.id);
      if (scroll) {
        if (sel === 0) list.scrollTop = 0;
        else row.scrollIntoView({ block: 'nearest' });
      }
      const it = items[sel];
      const enterLbl = $('.cp-enter-label');
      const shiftLbl = $('.cp-shift-label');
      if (!it) return;
      if (it.kind === 'tab') { enterLbl.textContent = 'switch'; shiftLbl.textContent = 'switch'; }
      else if (it.ref && it.ref.url) {
        const newFirst = settings.enterOpens === 'new';
        enterLbl.textContent = newFirst ? 'new tab' : 'open';
        shiftLbl.textContent = newFirst ? 'this tab' : 'new tab';
      } else if (it.ref && it.ref.setQuery !== undefined) { enterLbl.textContent = 'select'; shiftLbl.textContent = 'select'; }
      else { enterLbl.textContent = it.kind === 'action' ? 'run' : 'open'; shiftLbl.textContent = 'new tab'; }
    }

    function move(delta) {
      if (!items.length) return;
      sel = (sel + delta + items.length) % items.length;
      updateSelection(true);
    }
    function moveClamp(delta) {
      if (!items.length) return;
      sel = Math.max(0, Math.min(items.length - 1, sel + delta));
      updateSelection(true);
    }

    async function refresh(keepSelection) {
      const my = ++seq;
      const l = currentList();
      let res;
      try {
        res = await host.send({ type: 'search', query: input.value, list: l ? l.id : null, ctx: host.ctx });
      } catch (e) {
        if (my === seq) toast('Search failed: ' + (e && e.message || e), true);
        return;
      }
      if (destroyed || my !== seq || my < shownSeq) return;
      shownSeq = my;
      if (!res || res.error) { toast(res ? res.error : 'No response', true); return; }
      const prevId = keepSelection && items[sel] ? items[sel].id : null;
      items = res.items || [];
      sel = 0;
      if (prevId) { const j = items.findIndex(x => x.id === prevId); if (j >= 0) sel = j; }
      updateHead(res);
      render();
    }

    async function closeTabAt(i) {
      const it = items[i];
      if (!it || it.kind !== 'tab') return;
      const r = await host.send({ type: 'closeTab', tabId: it.ref.tabId });
      if (r && r.error) { toast(r.error, true); return; }
      if (host.ctx && host.ctx.tabId === it.ref.tabId) return; // closed ourselves
      sel = Math.min(i, items.length - 2);
      await refresh(false);
      sel = Math.max(0, Math.min(i, items.length - 1));
      updateSelection(true);
    }

    function enterList(l) {
      listStack.push({ id: l.id, title: l.title, placeholder: l.placeholder, savedQuery: input.value });
      input.value = '';
      refresh();
    }
    function leaveList() {
      const l = listStack.pop();
      input.value = l ? l.savedQuery : '';
      refresh();
    }

    async function runItem(i, mods) {
      const it = items[i];
      if (!it || busy) return;
      if (it.ref && it.ref.setQuery !== undefined) {
        input.value = it.ref.setQuery;
        input.setSelectionRange(input.value.length, input.value.length);
        refresh();
        return;
      }
      busy = true;
      let r;
      try {
        r = await host.send({ type: 'exec', item: it, query: input.value, mods, ctx: host.ctx });
      } catch (e) {
        r = { error: e && e.message || String(e) };
      }
      busy = false;
      if (destroyed) return;
      r = r || {};
      if (r.error) { toast(r.error, true); return; }
      if (r.setQuery !== undefined) {
        input.value = r.setQuery;
        refresh();
        return;
      }
      if (r.list) { enterList(r.list); return; }
      if (r.clipboard !== undefined) {
        const ok = await copyText(r.clipboard);
        if (!ok) { toast('Could not copy to the clipboard', true); return; }
      }
      host.close({ toast: r.toast, pageOp: r.pageOp });
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* fall through to execCommand */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
        root.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        input.focus();
        return ok;
      } catch (e) { return false; }
    }

    // ---- events ----
    input.addEventListener('input', () => refresh());
    input.addEventListener('keydown', e => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key;
      if (e.isComposing) return;
      if (k === 'ArrowDown' || (e.ctrlKey && (k === 'n' || k === 'j'))) { e.preventDefault(); move(1); }
      else if (k === 'ArrowUp' || (e.ctrlKey && (k === 'p'))) { e.preventDefault(); move(-1); }
      else if (k === 'PageDown') { e.preventDefault(); moveClamp(8); }
      else if (k === 'PageUp') { e.preventDefault(); moveClamp(-8); }
      else if (k === 'Enter') { e.preventDefault(); runItem(sel, { shift: e.shiftKey, mod }); }
      else if (k === 'Escape') {
        e.preventDefault();
        if (currentList()) leaveList();
        else host.close({});
      }
      else if (k === 'Backspace' && !input.value && currentList()) { e.preventDefault(); leaveList(); }
      else if (k === 'Tab') {
        e.preventDefault();
        const it = items[sel];
        if (!e.shiftKey && it && it.ref && it.ref.setQuery !== undefined) runItem(sel, {});
        else move(e.shiftKey ? -1 : 1);
      }
      else if (k === 'Delete' && e.shiftKey) {
        const it = items[sel];
        if (it && it.kind === 'tab') { e.preventDefault(); closeTabAt(sel); }
      }
    });
    list.addEventListener('mousemove', e => {
      if (e.clientX === lastMouse.x && e.clientY === lastMouse.y) return;
      lastMouse = { x: e.clientX, y: e.clientY };
      const row = e.target.closest('.cp-item');
      if (!row) return;
      const i = Number(row.dataset.index);
      if (i !== sel) { sel = i; updateSelection(false); }
    });
    list.addEventListener('mousedown', e => { if (e.target.closest('.cp-item')) e.preventDefault(); });
    list.addEventListener('click', e => {
      const row = e.target.closest('.cp-item');
      if (!row) return;
      runItem(Number(row.dataset.index), { shift: e.shiftKey, mod: isMac ? e.metaKey : e.ctrlKey });
    });
    list.addEventListener('auxclick', e => {
      const row = e.target.closest('.cp-item');
      if (!row || e.button !== 1) return;
      e.preventDefault();
      runItem(Number(row.dataset.index), { mod: true });
    });
    back.addEventListener('click', () => { leaveList(); input.focus(); });
    const backdrop = root.querySelector('.cp-backdrop');
    if (backdrop) {
      backdrop.addEventListener('mousedown', e => { e.preventDefault(); host.close({}); });
      backdrop.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    }
    $('.cp-panel').addEventListener('mousedown', e => {
      // Keep focus in the input when clicking non-interactive parts of the panel.
      if (e.target !== input && !e.target.closest('button')) { e.preventDefault(); input.focus(); }
    });

    // ---- init ----
    host.send({ type: 'config' }).then(cfg => {
      if (!cfg || destroyed) return;
      settings = cfg.settings || settings;
      if (settings.theme && settings.theme !== 'auto') root.dataset.theme = settings.theme;
      const esc = root.querySelector('.cp-esc');
      if (cfg.shortcut && host.mode === 'overlay') esc.title = 'Close (Esc or ' + cfg.shortcut + ')';
      updateSelection(false);
    }).catch(() => {});
    input.focus();
    refresh();

    return {
      root,
      focus() { input.focus(); },
      toast,
      setQuery(q) { input.value = q; refresh(); },
      destroy() { destroyed = true; clearTimeout(toastTimer); root.remove(); },
    };
  }

  globalThis.CommandPaletteUI = { mount, CSS, svg };
})();
