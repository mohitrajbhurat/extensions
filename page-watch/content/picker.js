// Point-and-click element picker, injected on demand (activeTab + scripting).
// Hover highlights, click selects, Parent/Child expand or narrow, Enter confirms, Esc cancels.
(function () {
  if (window.__pageWatchPicker) { window.__pageWatchPicker.focus(); return; }

  const extract = globalThis.PageWatchExtract;
  const HOST_ID = 'page-watch-picker-host';

  // ---------------------------------------------------------------- selectors
  const GENERATED = /(^|[-_])(css|sc|jsx|emotion|styled|svelte|ng|tw)-|(?=[0-9a-f]*\d)[0-9a-f]{6,}|\d{4,}|^_|__[a-z0-9]{5,}$/i;
  const stableToken = (s) => s && s.length <= 40 && !GENERATED.test(s) && /^[A-Za-z_-][\w-]*$/.test(s);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));

  function isUnique(sel, el) {
    try {
      const found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch { return false; }
  }

  function partFor(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && stableToken(el.id) && isUnique('#' + esc(el.id), el)) return { part: '#' + esc(el.id), anchor: true };
    let part = tag;
    const classes = Array.from(el.classList).filter(stableToken).slice(0, 2);
    if (classes.length) part += '.' + classes.map(esc).join('.');
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (same.length > 1) {
        let matching;
        try { matching = Array.from(parent.children).filter((c) => c.matches(part)); } catch { matching = same; }
        if (matching.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
    }
    return { part, anchor: false };
  }

  /** Shortest unique CSS path for an element. */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.body || el === document.documentElement) return 'body';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const { part, anchor } = partFor(cur);
      parts.unshift(part);
      if (anchor) break;
      if (cur === document.body) break;
      cur = cur.parentElement;
    }
    // Try the shortest suffix that still uniquely identifies the element.
    for (let i = parts.length - 1; i >= 0; i--) {
      const sel = parts.slice(i).join(' > ');
      if (isUnique(sel, el)) return sel;
    }
    return parts.join(' > ');
  }

  // ---------------------------------------------------------------- UI
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .box { position: fixed; pointer-events: none; border-radius: 4px; transition: all 60ms ease-out; display: none; }
  .hover { border: 2px dashed #14b8a6; background: rgba(20,184,166,.10); }
  .sel { border: 2px solid #0f766e; background: rgba(15,118,110,.16); box-shadow: 0 0 0 4000px rgba(15,23,42,.18); }
  .match { border: 2px solid #f59e0b; background: rgba(245,158,11,.10); }
  .tag { position: fixed; pointer-events: none; display: none; background: #0f766e; color: #fff; font-size: 11px; line-height: 1;
    padding: 4px 6px; border-radius: 4px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .bar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; width: min(760px, calc(100vw - 32px));
    pointer-events: auto; background: #ffffff; color: #0f172a; border: 1px solid #cbd5e1; border-radius: 12px;
    box-shadow: 0 12px 40px rgba(15,23,42,.28); padding: 12px; display: grid; gap: 8px; font-size: 13px; }
  .bar.top { bottom: auto; top: 16px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .brand { font-weight: 700; color: #0f766e; display: flex; align-items: center; gap: 6px; }
  .brand i { width: 10px; height: 10px; border-radius: 50%; background: #14b8a6; display: inline-block; box-shadow: 0 0 0 3px rgba(20,184,166,.25); }
  .hint { color: #475569; flex: 1; min-width: 160px; }
  kbd { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; background: #f1f5f9; border: 1px solid #cbd5e1; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }
  input { flex: 1; min-width: 200px; font: 12px ui-monospace, Menlo, Consolas, monospace; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; color: inherit; background: #f8fafc; }
  input:focus { outline: 2px solid #14b8a6; outline-offset: 1px; }
  button { font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; color: inherit; cursor: pointer; }
  button:hover { background: #f1f5f9; }
  button:focus-visible { outline: 2px solid #14b8a6; outline-offset: 1px; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #0f766e; color: #fff; border-color: #0f766e; font-weight: 600; }
  button.primary:hover { background: #115e59; }
  .count { font-size: 12px; color: #0f766e; font-weight: 600; white-space: nowrap; }
  .count.bad { color: #b45309; }
  .preview { font-size: 12px; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 8px;
    max-height: 64px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .preview:empty { display: none; }
  .hidden { display: none !important; }
  @media (prefers-color-scheme: dark) {
    .bar { background: #0f172a; color: #e2e8f0; border-color: #334155; }
    .hint { color: #94a3b8; }
    input, .preview { background: #1e293b; border-color: #334155; color: #e2e8f0; }
    button { background: #1e293b; border-color: #334155; }
    button:hover { background: #273449; }
    kbd { background: #1e293b; border-color: #475569; }
    .brand, .count { color: #5eead4; }
  }
</style>
<div class="box hover" part="hover"></div>
<div class="box sel"></div>
<div class="matches"></div>
<div class="tag"></div>
<div class="bar" role="dialog" aria-label="Page Watch element picker">
  <div class="row">
    <span class="brand"><i></i>Page Watch</span>
    <span class="hint">Hover and <b>click</b> the part of the page to watch. <kbd>Esc</kbd> to cancel.</span>
    <button class="move" title="Move toolbar to the other edge">⇅</button>
    <button class="cancel">Cancel</button>
  </div>
  <div class="row picked hidden">
    <input class="selector" spellcheck="false" aria-label="CSS selector">
    <span class="count"></span>
  </div>
  <div class="preview" aria-live="polite"></div>
  <div class="row picked hidden">
    <button class="parent" title="Select the parent element (↑)">↑ Parent</button>
    <button class="child" title="Go back to the narrower element (↓)">↓ Child</button>
    <button class="repick" title="Pick a different element">Re-pick</button>
    <button class="whole" title="Watch all text on the page">Whole page</button>
    <span style="flex:1"></span>
    <button class="primary confirm" title="Create a monitor for this selection (Enter)">Watch this ✓</button>
  </div>
</div>`;
  const $ = (s) => root.querySelector(s);
  const hoverBox = $('.box.hover');
  const selBox = $('.box.sel');
  const matchesEl = $('.matches');
  const tagEl = $('.tag');
  const bar = $('.bar');
  const input = $('.selector');
  const countEl = $('.count');
  const previewEl = $('.preview');
  const hintEl = $('.hint');

  let hovered = null;
  let selected = null;
  let history = []; // elements we expanded from, for "Child"
  let selector = '';
  let picking = true;
  let raf = 0;

  document.documentElement.appendChild(host);

  function place(box, el) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
  }

  function label(el) {
    const r = el.getBoundingClientRect();
    let t = el.tagName.toLowerCase();
    if (el.id) t += '#' + el.id;
    const cls = Array.from(el.classList).slice(0, 2);
    if (cls.length) t += '.' + cls.join('.');
    return `${t}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function placeTag(el) {
    if (!el) { tagEl.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    tagEl.textContent = label(el);
    tagEl.style.display = 'block';
    const top = r.top > 24 ? r.top - 22 : r.bottom + 4;
    tagEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 240)) + 'px';
    tagEl.style.top = Math.max(4, top) + 'px';
  }

  function matchedElements() {
    if (!selector) return [];
    try { return extract.resolve(document, selector).filter((n) => n && n.nodeType === 1); } catch { return []; }
  }

  function redraw() {
    raf = 0;
    place(hoverBox, picking ? hovered : (hovered && hovered !== selected ? hovered : null));
    if (picking) placeTag(hovered); else placeTag(selected);
    place(selBox, picking ? null : selected);
    matchesEl.textContent = '';
    if (!picking) {
      const els = matchedElements().filter((e) => e !== selected).slice(0, 50);
      for (const e of els) {
        const b = document.createElement('div');
        b.className = 'box match';
        matchesEl.appendChild(b);
        place(b, e);
      }
    }
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(redraw); };

  function refreshInfo() {
    const res = extract.extract(document, selector, { live: true });
    if (res.error) {
      countEl.textContent = 'Invalid selector';
      countEl.classList.add('bad');
      previewEl.textContent = res.error;
    } else {
      countEl.textContent = selector ? `${res.count} match${res.count === 1 ? '' : 'es'}` : 'Whole page';
      countEl.classList.toggle('bad', res.count === 0);
      const t = res.text || '(no text)';
      previewEl.textContent = t.length > 600 ? t.slice(0, 600) + '…' : t;
    }
    root.querySelector('.confirm').disabled = !!res.error || (selector && res.count === 0);
    root.querySelector('.parent').disabled = !selected || !selected.parentElement || selected === document.body;
    root.querySelector('.child').disabled = !history.length;
    schedule();
  }

  function select(el, { keepHistory = false } = {}) {
    if (!keepHistory) history = [];
    selected = el;
    selector = el ? selectorFor(el) : '';
    picking = false;
    input.value = selector;
    root.querySelectorAll('.picked').forEach((n) => n.classList.remove('hidden'));
    hintEl.innerHTML = 'Adjust with <kbd>↑</kbd> parent / <kbd>↓</kbd> child or edit the selector. <kbd>Enter</kbd> to watch.';
    refreshInfo();
  }

  function repick() {
    picking = true;
    selected = null;
    selector = '';
    history = [];
    previewEl.textContent = '';
    root.querySelectorAll('.picked').forEach((n) => n.classList.add('hidden'));
    hintEl.innerHTML = 'Hover and <b>click</b> the part of the page to watch. <kbd>Esc</kbd> to cancel.';
    schedule();
  }

  function parent() {
    if (!selected || !selected.parentElement || selected === document.body) return;
    history.push(selected);
    select(selected.parentElement, { keepHistory: true });
  }

  function child() {
    if (!history.length) return;
    select(history.pop(), { keepHistory: true });
  }

  function wholePage() {
    history = [];
    selected = document.body;
    selector = '';
    picking = false;
    input.value = '';
    root.querySelectorAll('.picked').forEach((n) => n.classList.remove('hidden'));
    refreshInfo();
  }

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseover', onMove, true);
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick']) window.removeEventListener(t, block, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule, true);
    host.remove();
    delete window.__pageWatchPicker;
  }

  async function confirm() {
    const res = extract.extract(document, selector, { live: true });
    if (res.error || (selector && res.count === 0)) return;
    const btn = root.querySelector('.confirm');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      await chrome.runtime.sendMessage({
        type: 'pick:done',
        draft: {
          url: location.href,
          title: document.title,
          selector,
          preview: (res.text || '').slice(0, 4000),
          count: res.count,
        },
      });
    } catch (e) {
      btn.textContent = 'Extension was reloaded; refresh the page';
      return;
    }
    cleanup();
  }

  // ---------------------------------------------------------------- events
  const inUi = (e) => e.composedPath().includes(host);

  function onMove(e) {
    if (inUi(e)) return;
    const t = e.target;
    if (!t || t.nodeType !== 1 || t === host) return;
    if (t !== hovered) { hovered = t; schedule(); }
  }

  function block(e) {
    if (inUi(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.button === 0) {
      const t = e.target;
      if (t && t.nodeType === 1 && t !== host) select(t === document.documentElement ? document.body : t);
    }
  }

  function onKey(e) {
    const fromInput = inUi(e) && e.composedPath()[0] === input;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); return; }
    if (fromInput) {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      e.stopPropagation();
      return;
    }
    if (picking) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); parent(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); child(); }
    else if (e.key === 'Enter' && !inUi(e)) { e.preventDefault(); e.stopPropagation(); confirm(); }
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseover', onMove, true);
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick']) window.addEventListener(t, block, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule, true);

  $('.cancel').addEventListener('click', cleanup);
  $('.move').addEventListener('click', () => bar.classList.toggle('top'));
  $('.parent').addEventListener('click', parent);
  $('.child').addEventListener('click', child);
  $('.repick').addEventListener('click', repick);
  $('.whole').addEventListener('click', wholePage);
  $('.confirm').addEventListener('click', confirm);
  let inputTimer = 0;
  input.addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      selector = input.value.trim();
      const els = matchedElements();
      selected = els[0] || null;
      history = [];
      refreshInfo();
    }, 150);
  });

  window.__pageWatchPicker = { focus: () => bar.querySelector('button').focus(), cleanup, selectorFor };
})();
