// Pocket Tools selection tooltip. Injected on demand (context menu / shortcut)
// or registered for all sites when the user turns on the automatic tooltip.
// Classic script; conversions are computed by the service worker.
(() => {
  if (window.__pocketToolsTooltip) return;
  window.__pocketToolsTooltip = true;

  const MAX_LEN = 60;
  let host = null;
  let shadow = null;
  let autoEnabled = false;
  let debounce = null;
  let lastText = '';

  const alive = () => {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch { return false; }
  };

  const CSS = `
    :host { all: initial; }
    .tip {
      --bg: #ffffff; --fg: #1b1f24; --muted: #5d6673; --line: #d9dee5; --accent: #0f7b6c; --hover: #eef3f6;
      position: fixed; z-index: 2147483647; max-width: 340px; min-width: 200px;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 8px; box-sizing: border-box;
      animation: pt-in .12s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .tip { --bg: #1f2329; --fg: #e8ecf1; --muted: #a2acb8; --line: #3a414b; --accent: #4fd1b8; --hover: #2a3038; }
    }
    @keyframes pt-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
    .title { flex: 1; font-weight: 600; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .close { all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 6px; text-align: center; line-height: 24px; color: var(--muted); }
    .close:hover, .close:focus-visible { background: var(--hover); color: var(--fg); }
    ul { list-style: none; margin: 0; padding: 0; }
    li button {
      all: unset; box-sizing: border-box; display: flex; justify-content: space-between; gap: 16px; width: 100%;
      padding: 4px 8px; border-radius: 6px; cursor: pointer;
    }
    li button:hover, li button:focus-visible { background: var(--hover); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .label { color: var(--muted); }
    .value { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .empty { color: var(--muted); padding: 4px 8px; }
    .foot { margin-top: 4px; padding: 0 8px; font-size: 11px; color: var(--muted); }
  `;

  function hide() {
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
  }

  function selectionInfo() {
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|tel|email|number)$/i.test(el.type)))) {
      try {
        const text = el.value.substring(el.selectionStart, el.selectionEnd);
        return { text, rect: el.getBoundingClientRect() };
      } catch { /* input type without selection API */ }
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { text: '', rect: null };
    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      const rects = range.getClientRects();
      rect = rects.length ? rects[rects.length - 1] : null;
    }
    return { text: String(sel), rect };
  }

  function position(tip, rect) {
    const margin = 8;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const box = tip.getBoundingClientRect();
    const r = rect || { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3 };
    let top = r.bottom + margin;
    if (top + box.height > vh - margin) top = Math.max(margin, r.top - box.height - margin);
    let left = Math.min(Math.max(margin, r.left), vw - box.width - margin);
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(Math.max(margin, left))}px`;
  }

  async function copy(value, button) {
    try {
      await navigator.clipboard.writeText(value);
      const v = button.querySelector('.value');
      const prev = v.textContent;
      v.textContent = 'Copied';
      setTimeout(() => { if (v.isConnected) v.textContent = prev; }, 900);
    } catch { /* clipboard blocked by the page's permissions policy */ }
  }

  function render(text, result, rect) {
    hide();
    host = document.createElement('pocket-tools-tooltip');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'dialog');
    tip.setAttribute('aria-label', 'Pocket Tools conversion');

    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = result ? result.title : (text ? `“${text.slice(0, 40)}”` : 'Pocket Tools');
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', hide);
    head.append(title, close);
    tip.append(head);

    if (result && result.items && result.items.length) {
      const list = document.createElement('ul');
      for (const item of result.items) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.title = 'Copy';
        const l = document.createElement('span');
        l.className = 'label';
        l.textContent = item.label;
        const v = document.createElement('span');
        v.className = 'value';
        v.textContent = item.value;
        b.append(l, v);
        b.addEventListener('click', () => copy(item.value, b));
        li.append(b);
        list.append(li);
      }
      tip.append(list);
      const foot = document.createElement('div');
      foot.className = 'foot';
      foot.textContent = 'Click a value to copy · Esc to close';
      tip.append(foot);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = text
        ? 'No conversion found. Try a selection like “5 miles”, “72°F” or “3pm PST”.'
        : 'Select a value such as “5 miles”, “72°F” or “3pm PST” first.';
      tip.append(empty);
    }

    shadow.append(style, tip);
    (document.body || document.documentElement).append(host);
    position(tip, rect);
  }

  async function requestAndShow(text, rect, { quiet }) {
    if (!alive()) return;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'convert', text });
    } catch {
      return; // extension reloaded; this orphaned script stays inert
    }
    const result = response && response.result;
    if (!result && quiet) return;
    // The selection may have changed while waiting.
    if (quiet && selectionInfo().text.trim() !== text) return;
    render(text, result, rect);
  }

  function onMouseUp(e) {
    if (!autoEnabled || e.button !== 0) return;
    if (host && e.composedPath().includes(host)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const { text, rect } = selectionInfo();
      const t = text.trim();
      if (!t || t.length > MAX_LEN || !/\d/.test(t) && !/^(noon|midnight)\b/i.test(t)) return;
      if (t === lastText && host) return;
      lastText = t;
      requestAndShow(t, rect, { quiet: true });
    }, 180);
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', e => {
    if (host && !e.composedPath().includes(host)) { hide(); lastText = ''; }
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && host) { hide(); lastText = ''; }
  }, true);
  window.addEventListener('scroll', () => { if (host) hide(); }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (host) hide(); }, { passive: true });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'pt-tooltip:show') {
      const { rect } = selectionInfo();
      lastText = msg.text || '';
      render(msg.text || '', msg.result, rect);
    }
  });

  // The automatic tooltip follows the setting live; on-demand injection
  // (setting off) only shows tooltips when asked.
  function applySettings(settings) {
    autoEnabled = Boolean(settings && settings.tooltip);
    if (!autoEnabled && host) hide();
  }
  try {
    chrome.storage.sync.get('settings').then(r => applySettings(r.settings)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) applySettings(changes.settings.newValue);
    });
  } catch { /* storage unavailable */ }
})();
