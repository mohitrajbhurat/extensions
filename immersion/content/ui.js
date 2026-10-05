/* Language Immersion - in-page UI (hover card, selection pill, toasts).
 * Everything lives in one closed-off shadow root so page styles cannot leak in or out. */
(function () {
  'use strict';
  if (globalThis.LIMUI) return;
  const LIM = globalThis.LIM;
  const esc = LIM.escapeHtml;

  const ICON = {
    speak: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 10v4a1 1 0 0 0 1 1h3l4 4V5L7 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm0 15-5-2.18L7 18V5h10z"/></svg>',
    bookmarked: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>',
    swap: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3z"/></svg>',
    translate: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="m12.87 15.07-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0 auto auto 0; z-index: 2147483647; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --bg: #ffffff; --fg: #10201e; --muted: #5b6b69; --line: #dbe5e3; --accent: #0f766e; --accent-fg: #ffffff;
    --soft: #e7f5f3; --chip: #f1f5f4; --shadow: 0 12px 32px rgba(10, 30, 28, .18), 0 2px 6px rgba(10, 30, 28, .08); --warn: #b45309; }
  @media (prefers-color-scheme: dark) {
    .layer { --bg: #18201f; --fg: #e8f0ee; --muted: #9db0ac; --line: #2c3a38; --accent: #2dd4bf; --accent-fg: #062a26;
      --soft: #12302c; --chip: #222d2b; --shadow: 0 12px 32px rgba(0,0,0,.5); --warn: #fbbf24; }
  }
  .card { position: fixed; width: 300px; max-width: calc(100vw - 16px); background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 16px; opacity: 0;
    transform: translateY(4px); transition: opacity .12s ease, transform .12s ease; pointer-events: auto; }
  .card.show { opacity: 1; transform: none; }
  .head { display: flex; align-items: flex-start; gap: 8px; }
  .tr { font-size: 22px; font-weight: 650; line-height: 1.2; word-break: break-word; flex: 1; }
  .tr .art { font-weight: 450; color: var(--muted); font-size: 16px; margin-right: 4px; }
  .lang { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--accent); background: var(--soft);
    border-radius: 6px; padding: 2px 6px; margin-top: 4px; }
  .meta { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .orig { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .orig .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  .orig .word { font-weight: 600; }
  .ctx { margin-top: 8px; font-size: 12.5px; color: var(--muted); font-style: italic; }
  .row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  button { font: inherit; font-size: 13px; cursor: pointer; border-radius: 8px; border: 1px solid var(--line);
    background: var(--chip); color: var(--fg); padding: 6px 10px; display: inline-flex; align-items: center; gap: 6px; }
  button:hover { border-color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
  button.icon { padding: 6px; background: transparent; border-color: transparent; color: var(--muted); }
  button.icon:hover { color: var(--accent); border-color: var(--line); }
  button.on { background: var(--soft); border-color: var(--accent); color: var(--accent); }
  button[disabled] { opacity: .6; cursor: default; }
  .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 12px; color: var(--muted); }
  .link { background: none; border: none; padding: 0; color: var(--muted); text-decoration: underline; font-size: 12px; }
  .link:hover { color: var(--accent); }
  .state { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.learning { background: #f59e0b; } .dot.known { background: #10b981; } .dot.new { background: #60a5fa; }
  .pill { position: fixed; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px;
    background: var(--accent); color: var(--accent-fg); border: none; box-shadow: var(--shadow); font-weight: 600; pointer-events: auto; }
  .result { font-size: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin-top: 8px; }
  .src { color: var(--muted); font-size: 12.5px; max-height: 4.5em; overflow: hidden; }
  .progress { height: 4px; border-radius: 4px; background: var(--line); overflow: hidden; margin-top: 12px; }
  .progress > i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .2s; }
  .warn { color: var(--warn); font-size: 12.5px; margin-top: 8px; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; display: inline-block; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--fg); color: var(--bg);
    padding: 8px 16px; border-radius: 8px; box-shadow: var(--shadow); font-weight: 500; pointer-events: none; opacity: 0; transition: opacity .2s; }
  .toast.show { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .card, .toast { transition: none; } .spinner { animation: none; } }
  `;

  let host, root, layer, card, pill, toastEl, toastTimer, hideTimer;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('lim-ui');
    host.setAttribute('data-lim-skip', '');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="layer"></div>`;
    layer = root.querySelector('.layer');
    (document.body || document.documentElement).appendChild(host);
    layer.addEventListener('mouseenter', () => clearTimeout(hideTimer), true);
    layer.addEventListener('mouseleave', (e) => { if (card && e.target === card) scheduleHide(); }, true);
  }

  function isOurs(node) { return !!host && (node === host || host.contains(node)); }

  function place(el, rect) {
    const vw = innerWidth, vh = innerHeight, m = 8;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(Math.max(m, rect.left + rect.width / 2 - w / 2), vw - w - m);
    let top = rect.bottom + 8;
    if (top + h > vh - m && rect.top - h - 8 > m) top = rect.top - h - 8;
    top = Math.max(m, Math.min(top, vh - h - m));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function openCard(html, rect, opts) {
    ensure();
    clearTimeout(hideTimer);
    if (!card) {
      card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'dialog');
      card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); if (opts && opts.returnFocus) opts.returnFocus.focus?.(); } });
      layer.appendChild(card);
    }
    card.setAttribute('aria-label', (opts && opts.label) || 'Translation');
    card.innerHTML = html;
    card.classList.remove('show');
    card.style.left = '-9999px';
    card.style.top = '0px';
    requestAnimationFrame(() => {
      if (!card) return;
      place(card, rect);
      card.classList.add('show');
    });
    card._anchor = opts && opts.anchor;
    return card;
  }

  function scheduleHide(delay) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, delay == null ? 280 : delay);
  }
  function cancelHide() { clearTimeout(hideTimer); }

  function hide() {
    clearTimeout(hideTimer);
    if (card) { card.remove(); card = null; }
  }
  function hidePill() { if (pill) { pill.remove(); pill = null; } }
  function cardOpen() { return !!card; }
  function cardAnchor() { return card ? card._anchor : null; }

  /** Word card for a replaced word. d: {tr, display, art, en, pos, g, lang, seen, state, saved, context, source, showingOriginal} */
  function showWordCard(anchorEl, d, actions) {
    const rect = anchorEl.getBoundingClientRect();
    const state = d.state || 'new';
    const stateLabel = { new: 'New', learning: 'Learning', known: 'Known' }[state];
    const posLabel = LIM.POS_LABEL[d.pos] || '';
    const gl = LIM.genderLabel(d.g);
    const meta = [gl, posLabel].filter(Boolean).join(' ');
    const html = `
      <div class="head">
        <div class="tr" lang="${esc(d.lang)}">${d.art ? `<span class="art">${esc(d.art)}</span>` : ''}${esc(d.tr)}</div>
        <span class="lang" title="${esc(LIM.langName(d.lang))}">${esc(d.lang.toUpperCase())}</span>
        <button class="icon" data-act="speak" title="Pronounce (${esc(LIM.langName(d.lang))})" aria-label="Pronounce">${ICON.speak}</button>
      </div>
      ${meta ? `<div class="meta">${esc(meta)}${d.display && d.display !== d.tr ? ` &middot; shown as <b lang="${esc(d.lang)}">${esc(d.display)}</b>` : ''}</div>` : ''}
      <div class="orig"><span class="label">${esc(LIM.langName(d.nativeLang || 'en'))}</span><span class="word">${esc(d.en)}</span></div>
      ${d.context ? `<div class="ctx">${esc(d.context)}</div>` : ''}
      <div class="row">
        <button class="${state === 'known' ? 'on' : 'primary'}" data-act="known">${ICON.check}<span>${state === 'known' ? 'Known' : 'I know this'}</span></button>
        <button class="${d.saved ? 'on' : ''}" data-act="save">${d.saved ? ICON.bookmarked : ICON.bookmark}<span>${d.saved ? 'Saved' : 'Save to review'}</span></button>
      </div>
      <div class="foot">
        <span class="state"><span class="dot ${state}"></span>${stateLabel}${d.seen ? ` &middot; seen ${d.seen}&times;` : ''}</span>
        <button class="link" data-act="toggle">${d.showingOriginal ? 'Show translation' : 'Show original'}</button>
      </div>
      ${d.voiceMissing ? `<div class="warn">No ${esc(LIM.langName(d.lang))} voice installed; pronunciation may be inaccurate.</div>` : ''}`;
    const c = openCard(html, rect, { anchor: anchorEl, label: `Translation of ${d.en}`, returnFocus: anchorEl });
    c.onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      const act = b.dataset.act;
      if (actions[act]) actions[act](b);
    };
    return c;
  }

  function setButton(btn, html, on) {
    if (!btn) return;
    btn.innerHTML = html;
    btn.classList.toggle('on', !!on);
    btn.classList.remove('primary');
  }

  function showPill(rect, onClick) {
    ensure();
    hidePill();
    pill = document.createElement('button');
    pill.className = 'pill';
    pill.innerHTML = `${ICON.translate}<span>Translate</span>`;
    pill.title = 'Translate selection (Language Immersion)';
    pill.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    pill.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const p = pill; hidePill(); onClick(p); });
    layer.appendChild(pill);
    const vw = innerWidth, vh = innerHeight;
    let left = Math.min(rect.right - 20, vw - 130);
    let top = rect.bottom + 8;
    if (top > vh - 48) top = Math.max(8, rect.top - 44);
    pill.style.left = Math.max(8, left) + 'px';
    pill.style.top = top + 'px';
    return pill;
  }

  /** Selection result card; returns an updater. */
  function showSelectionCard(rect, d) {
    const html = `
      <div class="head">
        <div class="meta" style="flex:1;margin:0">${esc(LIM.langName(d.from))} &rarr; ${esc(LIM.langName(d.to))}</div>
        <button class="icon" data-act="close" aria-label="Close">${ICON.close}</button>
      </div>
      <div class="src">${esc(d.text)}</div>
      <div class="body"><div class="result"><span class="spinner"></span> Translating&hellip;</div></div>`;
    const c = openCard(html, rect, { label: 'Selection translation' });
    c.onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.act === 'close') hide();
      else if (d.actions && d.actions[b.dataset.act]) d.actions[b.dataset.act](b);
    };
    return {
      progress(frac) {
        if (!card) return;
        const body = card.querySelector('.body');
        body.innerHTML = `<div class="result" style="font-size:13px">Downloading the on-device language model&hellip; ${Math.round(frac * 100)}%</div><div class="progress"><i style="width:${Math.round(frac * 100)}%"></i></div>`;
      },
      done(result, opts) {
        if (!card) return;
        const body = card.querySelector('.body');
        body.innerHTML = `<div class="result" lang="${esc(d.to)}">${esc(result)}</div>
          <div class="row">
            <button data-act="speak">${ICON.speak}<span>Listen</span></button>
            <button data-act="copy">${ICON.copy}<span>Copy</span></button>
            ${opts && opts.canSave ? `<button data-act="save">${ICON.bookmark}<span>Save to review</span></button>` : ''}
          </div>
          ${opts && opts.note ? `<div class="meta" style="margin-top:8px">${esc(opts.note)}</div>` : ''}`;
        requestAnimationFrame(() => card && place(card, rect));
      },
      error(msg) {
        if (!card) return;
        card.querySelector('.body').innerHTML = `<div class="warn">${esc(msg)}</div>`;
      },
    };
  }

  function toast(msg, ms) {
    ensure();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      layer.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), ms || 2200);
  }

  function hostElement() { return host; }

  globalThis.LIMUI = { ICON, showWordCard, setButton, showPill, hidePill, showSelectionCard, hide, scheduleHide, cancelHide, cardOpen, cardAnchor, toast, isOurs, hostElement };
})();
