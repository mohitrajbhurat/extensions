// Web Automator page agent: records user actions, executes macro steps, highlights and picks elements.
// Injected on demand with chrome.scripting.executeScript. Safe to inject more than once.
(() => {
  if (window.__webAutomatorAgent) return;
  window.__webAutomatorAgent = true;

  // ------------------------------------------------------------------ utils
  const norm = s => String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const cssStr = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];
  const CLICKABLE = 'a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],[role=radio],[role=treeitem],summary,label,input,select,textarea,[onclick],[tabindex]';

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
    return el.isContentEditable;
  }
  function isToggle(el) {
    return el && el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type);
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) { if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false; }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function stableId(id) {
    if (!id || id.length > 64) return false;
    if (/^\d/.test(id)) return false;
    if (/\d{4,}/.test(id)) return false;
    if (/[0-9a-f]{8,}/i.test(id) && /\d/.test(id)) return false;
    if (/^(:r|ember\d|ext-|yui_|gwt-|react-select-\d|mui-\d|headlessui-|radix-|__)/i.test(id)) return false;
    if (/[:]/.test(id) && /\d/.test(id)) return false;
    return true;
  }
  function stableClass(c) {
    return c && c.length < 40 && !/\d{3,}|^(css|sc|jsx|svelte|emotion)-|__[a-z0-9]{5,}$|^_[a-z0-9]{5,}$|[A-Z0-9]{6,}|^(active|focus|hover|selected|open|show|is-|has-|ng-)/.test(c);
  }

  // ------------------------------------------------------------------ selector resolution
  function parseSelector(sel) {
    sel = String(sel || '').trim();
    const m = /^(id|name|css|xpath|text|testid|aria|label|link|placeholder)=([\s\S]*)$/.exec(sel);
    if (m) return { kind: m[1] === 'link' ? 'text' : m[1], v: m[2] };
    if (/^(\/|\(|\.\/)/.test(sel)) return { kind: 'xpath', v: sel };
    return { kind: 'css', v: sel };
  }
  function textMatches(actual, expected) {
    const re = /^\/(.+)\/([gimsuy]*)$/.exec(expected);
    if (re) { try { return new RegExp(re[1], re[2]).test(actual); } catch { return false; } }
    return norm(actual) === norm(expected);
  }
  function byText(v) {
    const want = norm(v);
    if (!want) return [];
    const isRe = /^\/.+\/[gimsuy]*$/.test(want);
    const found = new Set();
    // buttons by value
    for (const b of document.querySelectorAll('input[type=submit],input[type=button],input[type=reset]')) {
      if (textMatches(b.value, want)) found.add(b);
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = norm(n.data);
      if (!t) continue;
      if (!isRe && !want.includes(t)) continue;
      // climb to the deepest element whose whole text equals the wanted text
      let el = n.parentElement, best = null;
      while (el && el !== document.documentElement) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) break;
        const txt = norm(el.innerText !== undefined && el.offsetParent !== null ? el.innerText : el.textContent);
        if (textMatches(txt, want)) { best = el; break; }
        if (!isRe && txt.length > want.length) break;
        el = el.parentElement;
      }
      if (best) found.add(best.closest('a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],summary,label') || best);
    }
    // remove ancestors of other matches (keep the most specific)
    const arr = [...found];
    return arr.filter(a => !arr.some(b => b !== a && a.contains(b) && !a.matches('a,button,[role=button],[role=link]')));
  }
  function byLabel(v) {
    const want = norm(v);
    const out = [];
    for (const lab of document.querySelectorAll('label')) {
      if (textMatches(lab.innerText || lab.textContent, want)) {
        const c = lab.control || lab.querySelector('input,select,textarea');
        if (c) out.push(c);
      }
    }
    for (const el of document.querySelectorAll('[aria-labelledby]')) {
      const txt = el.getAttribute('aria-labelledby').split(/\s+/).map(id => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
      if (textMatches(txt, want)) out.push(el);
    }
    return [...new Set(out)];
  }
  function queryAll(sel) {
    const { kind, v } = parseSelector(sel);
    switch (kind) {
      case 'id': { const el = document.getElementById(v); return el ? [el] : []; }
      case 'name': return [...document.getElementsByName(v)];
      case 'testid': return [...document.querySelectorAll(TEST_ATTRS.map(a => `[${a}="${cssStr(v)}"]`).join(','))];
      case 'aria': return [...document.querySelectorAll(`[aria-label="${cssStr(v)}"]`)];
      case 'placeholder': return [...document.querySelectorAll(`[placeholder="${cssStr(v)}"]`)];
      case 'label': return byLabel(v);
      case 'text': return byText(v);
      case 'xpath': {
        const res = document.evaluate(v, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < res.snapshotLength; i++) { const n = res.snapshotItem(i); if (n.nodeType === 1) out.push(n); }
        return out;
      }
      default: return [...document.querySelectorAll(v)];
    }
  }
  function resolveOne(sel) {
    const all = queryAll(sel);
    if (!all.length) return null;
    return all.find(isVisible) || all[0];
  }

  // ------------------------------------------------------------------ selector generation
  function isUnique(sel, el) {
    try { const r = queryAll(sel); return r.length === 1 && r[0] === el; } catch { return false; }
  }
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id && stableId(cur.id) && document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter(stableClass).slice(0, 2);
      if (cls.length) part += cls.map(c => '.' + CSS.escape(c)).join('');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (same.length > 1) {
          const sameCls = cls.length ? same.filter(c => c.matches(part)) : same;
          if (sameCls.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch { /* keep going */ }
      cur = parent;
    }
    return parts.join(' > ');
  }
  function xpathOf(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.id && stableId(cur.id) && cur !== el) { parts.unshift(`//*[@id="${cur.id}"]`); return parts.join('/'); }
      let i = 1;
      for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === cur.tagName) i++;
      const tag = cur.tagName.toLowerCase();
      parts.unshift(cur.namespaceURI === 'http://www.w3.org/1999/xhtml' ? `${tag}[${i}]` : `*[name()="${tag}"][${i}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }
  function generateSelectors(el) {
    const out = [];
    const add = s => { if (s && !out.includes(s) && isUnique(s, el)) out.push(s); };
    const tag = el.tagName.toLowerCase();
    if (el.id && stableId(el.id)) add('id=' + el.id);
    for (const a of TEST_ATTRS) { const v = el.getAttribute(a); if (v) add(`css=[${a}="${cssStr(v)}"]`); }
    const name = el.getAttribute('name');
    if (name) {
      add('name=' + name);
      if (isToggle(el)) add(`css=${tag}[name="${cssStr(name)}"][value="${cssStr(el.value)}"]`);
      add(`css=${tag}[name="${cssStr(name)}"]`);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 100) { add('aria=' + aria); add(`css=${tag}[aria-label="${cssStr(aria)}"]`); }
    if (el.labels && el.labels.length) {
      const lt = norm(el.labels[0].innerText || el.labels[0].textContent);
      if (lt && lt.length <= 80) add('label=' + lt);
    }
    const ph = el.getAttribute('placeholder');
    if (ph) add('placeholder=' + ph);
    if (!isTextField(el) && tag !== 'select') {
      const txt = norm(el.innerText || el.value || '');
      if (txt && txt.length <= 80 && !txt.includes('\n')) add('text=' + txt);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && href.length < 150 && !/^javascript:/i.test(href)) add(`css=a[href="${cssStr(href)}"]`);
    }
    try { add('css=' + cssPath(el)); } catch { /* ignore */ }
    try { add('xpath=' + xpathOf(el)); } catch { /* ignore */ }
    if (!out.length) out.push('xpath=' + xpathOf(el));
    return out.slice(0, 6);
  }

  // ------------------------------------------------------------------ overlay (shadow DOM)
  let host, shadow, hlBox, hlLabel, recPill, recCount;
  function ensureOverlay() {
    if (host && host.isConnected) return;
    host = document.createElement('web-automator-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .hl{position:fixed;border:2px solid #f97316;background:rgba(249,115,22,.12);border-radius:4px;box-shadow:0 0 0 4px rgba(249,115,22,.25);transition:all .12s ease;display:none;pointer-events:none}
      .hl.pick{border-color:#2563eb;background:rgba(37,99,235,.12);box-shadow:0 0 0 4px rgba(37,99,235,.25)}
      .hl.fail{border-color:#dc2626;background:rgba(220,38,38,.12)}
      .lbl{position:absolute;left:-2px;top:-24px;background:#f97316;color:#fff;font:600 11px/1 system-ui,sans-serif;padding:5px 8px;border-radius:4px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
      .pick .lbl{background:#2563eb}.fail .lbl{background:#dc2626}
      .pill{position:fixed;right:16px;bottom:16px;display:none;align-items:center;gap:8px;background:#111827;color:#fff;font:500 13px/1 system-ui,sans-serif;padding:8px 8px 8px 12px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:auto}
      .dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:p 1.2s infinite}
      @keyframes p{50%{opacity:.35}}
      button{all:unset;cursor:pointer;background:#ef4444;color:#fff;font:600 12px/1 system-ui,sans-serif;padding:6px 10px;border-radius:999px}
      button:focus-visible{outline:2px solid #fff;outline-offset:2px}
      .banner{position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#2563eb;color:#fff;font:500 13px system-ui,sans-serif;padding:8px 14px;border-radius:8px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.25)}
    </style>
    <div class="hl"><div class="lbl"></div></div>
    <div class="pill" role="status"><span class="dot"></span><span class="cnt">Recording</span><button type="button" class="stop">Stop</button></div>
    <div class="banner">Click an element to pick it. Press Esc to cancel.</div>`;
    hlBox = shadow.querySelector('.hl');
    hlLabel = shadow.querySelector('.lbl');
    recPill = shadow.querySelector('.pill');
    recCount = shadow.querySelector('.cnt');
    shadow.querySelector('.stop').addEventListener('click', e => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'wa:stopRecording' }).catch(() => {});
    });
    (document.body || document.documentElement).appendChild(host);
  }
  let hlTimer;
  function highlight(el, label, cls = '', ms = 1500) {
    ensureOverlay();
    const r = el.getBoundingClientRect();
    hlBox.className = 'hl ' + cls;
    hlBox.style.display = 'block';
    hlBox.style.left = r.left - 3 + 'px';
    hlBox.style.top = r.top - 3 + 'px';
    hlBox.style.width = r.width + 2 + 'px';
    hlBox.style.height = r.height + 2 + 'px';
    hlLabel.textContent = label || '';
    hlLabel.style.display = label ? 'block' : 'none';
    hlLabel.style.top = r.top < 30 ? (r.height + 6) + 'px' : '-24px';
    clearTimeout(hlTimer);
    if (ms) hlTimer = setTimeout(() => { hlBox.style.display = 'none'; }, ms);
  }
  function isOwn(e) { return host && e.composedPath().includes(host); }

  // ------------------------------------------------------------------ recorder
  const rec = { on: false, keystrokes: false, scroll: true, lastValues: new WeakMap(), pending: new Set(), scrollTimer: 0, startedAt: 0, lastActionAt: 0 };

  function send(step) {
    rec.lastActionAt = Date.now();
    chrome.runtime.sendMessage({ type: 'wa:recordStep', step, url: location.href }).then(res => {
      if (res && typeof res.count === 'number') updatePill(res.count);
    }).catch(() => {});
  }
  function stepFor(command, el, value = '') {
    const targets = el ? generateSelectors(el) : [];
    return { command, target: targets[0] || '', targets, value: String(value) };
  }
  function fieldValue(el) { return el.isContentEditable && !('value' in el) ? el.innerText : el.value; }
  function flushField(el) {
    if (!el || !rec.on) return;
    rec.pending.delete(el);
    const v = fieldValue(el);
    if (rec.lastValues.get(el) === v) return;
    rec.lastValues.set(el, v);
    if (el.type === 'password') {
      // Never store the typed password. Replay fills it from a ${password} variable
      // (a "Set variable" step or a CSV "password" column via ${row.password}).
      const step = stepFor('type', el, '${password}');
      step.comment = 'Password not recorded: add a "Set variable" step named password before this one, or use ${row.password} with CSV';
      send(step);
      return;
    }
    send(stepFor(rec.keystrokes ? 'typeKeys' : 'type', el, v));
  }
  function flushAll() { for (const el of [...rec.pending]) flushField(el); }
  function updatePill(n) {
    if (!rec.on) return;
    ensureOverlay();
    recPill.style.display = 'flex';
    recCount.textContent = `Recording · ${n} step${n === 1 ? '' : 's'}`;
  }

  function onClick(e) {
    if (!rec.on || !e.isTrusted || isOwn(e) || e.button !== 0) return;
    const raw = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    if (!raw) return;
    const el = raw.closest(CLICKABLE) || raw;
    if (isTextField(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION' || isToggle(el)) return;
    if (el.tagName === 'INPUT' && el.type === 'file') return;
    if (el.tagName === 'LABEL') {
      const c = el.control;
      if (c && (isToggle(c) || isTextField(c) || c.tagName === 'SELECT')) return;
    }
    // Enter in a form field triggers a synthetic click on the default button (implicit submission);
    // the pressKey step already replays that, so skip the click.
    if (e.detail === 0 && rec.lastEnter && Date.now() - rec.lastEnter.t < 500 && el.form && el.form === rec.lastEnter.form) return;
    flushAll();
    send(stepFor('click', el));
  }
  function onDblClick(e) {
    if (!rec.on || !e.isTrusted || isOwn(e)) return;
    const raw = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    if (!raw || isTextField(raw)) return;
    send(stepFor('doubleClick', raw.closest(CLICKABLE) || raw));
  }
  function onInput(e) {
    if (!rec.on || !e.isTrusted) return;
    const el = e.composedPath()[0];
    if (isTextField(el)) rec.pending.add(el);
  }
  function onChange(e) {
    if (!rec.on || !e.isTrusted) return;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1) return;
    if (isTextField(el)) { flushField(el); return; }
    if (el.tagName === 'SELECT') {
      flushAll();
      const opt = el.options[el.selectedIndex];
      send(stepFor('select', el, opt ? 'label=' + norm(opt.text) : ''));
      return;
    }
    if (isToggle(el)) {
      flushAll();
      send(stepFor(el.type === 'radio' || el.checked ? 'check' : 'uncheck', el));
    }
  }
  function onFocusOut(e) {
    if (!rec.on) return;
    const el = e.composedPath()[0];
    if (rec.pending.has(el)) flushField(el);
  }
  const SPECIAL_KEYS = new Set(['Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete']);
  function onKeyDown(e) {
    if (!rec.on || !e.isTrusted || isOwn(e)) return;
    const el = e.composedPath()[0];
    if (e.key === 'Enter' && !e.isComposing && el && el.tagName !== 'TEXTAREA' && !el.isContentEditable && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
      if (el.tagName === 'INPUT' && isTextField(el)) flushField(el);
      rec.lastEnter = { form: el.form || null, t: Date.now() };
      send(stepFor('pressKey', el, 'Enter'));
      return;
    }
    if (rec.keystrokes && SPECIAL_KEYS.has(e.key) && !(e.key === 'Backspace' || e.key === 'Delete') ) {
      if (isTextField(el)) flushField(el);
      send(stepFor('pressKey', el && el !== document.body ? el : null, e.key));
    }
  }
  function onScroll() {
    if (!rec.on || !rec.scroll) return;
    if (Date.now() - rec.startedAt < 800) return;
    clearTimeout(rec.scrollTimer);
    rec.scrollTimer = setTimeout(() => {
      send({ command: 'scroll', target: '', targets: [], value: `${Math.round(scrollX)},${Math.round(scrollY)}` });
    }, 700);
  }
  function onPageHide() { flushAll(); }

  function startRecording(opts = {}) {
    rec.keystrokes = !!opts.keystrokes;
    rec.scroll = opts.recordScroll !== false;
    rec.startedAt = Date.now();
    if (rec.on) { updatePill(opts.count || 0); return; }
    rec.on = true;
    window.addEventListener('click', onClick, true);
    window.addEventListener('dblclick', onDblClick, true);
    window.addEventListener('input', onInput, true);
    window.addEventListener('change', onChange, true);
    window.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('pagehide', onPageHide, true);
    updatePill(opts.count || 0);
  }
  function stopRecording() {
    if (!rec.on) return;
    flushAll();
    rec.on = false;
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('dblclick', onDblClick, true);
    window.removeEventListener('input', onInput, true);
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', onPageHide, true);
    if (recPill) recPill.style.display = 'none';
  }

  // ------------------------------------------------------------------ executor
  async function findElement(targets, timeout, { wantVisible = true } = {}) {
    const deadline = Date.now() + Math.max(0, timeout);
    const errors = new Map();
    let fallback = null;
    for (;;) {
      for (let i = 0; i < targets.length; i++) {
        const sel = targets[i];
        if (!sel) continue;
        try {
          const all = queryAll(sel);
          if (all.length) {
            const vis = all.find(isVisible);
            if (vis || !wantVisible) return { el: vis || all[0], selector: sel, index: i, count: all.length };
            if (!fallback) fallback = { el: all[0], selector: sel, index: i, count: all.length, hidden: true };
          }
        } catch (err) {
          errors.set(sel, err.message.split('\n')[0]);
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(150, Math.max(10, deadline - Date.now())));
      fallback = null;
    }
    if (fallback) return fallback;
    const detail = targets.filter(Boolean).map(t => errors.has(t) ? `${t} (invalid: ${errors.get(t)})` : t).join(' | ');
    const e = new Error(`Element not found after ${timeout} ms: ${detail || '(no target)'}`);
    e.notFound = true;
    throw e;
  }

  function setNativeValue(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  }
  function fire(el, type, init = {}) {
    const Ctor = /^(key)/.test(type) ? KeyboardEvent : /^(pointer)/.test(type) ? PointerEvent : /^(mouse|click|dblclick|contextmenu)/.test(type) ? MouseEvent : /^(input|beforeinput)$/.test(type) ? InputEvent : /^focus|blur/.test(type) ? FocusEvent : Event;
    const ev = new Ctor(type, { bubbles: !/^(focus|blur|mouseenter|mouseleave|pointerenter|pointerleave)$/.test(type), cancelable: true, composed: true, view: window, ...init });
    return el.dispatchEvent(ev);
  }
  function pointerInit(el) {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  }
  function doClick(el, count = 1) {
    const init = pointerInit(el);
    fire(el, 'pointerover', init); fire(el, 'mouseover', init);
    fire(el, 'pointerdown', init); fire(el, 'mousedown', init);
    if (el.focus) try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    fire(el, 'pointerup', { ...init, buttons: 0 }); fire(el, 'mouseup', { ...init, buttons: 0 });
    if (el instanceof HTMLElement) el.click(); else fire(el, 'click', { ...init, buttons: 0, detail: 1 });
    if (count === 2) {
      if (el instanceof HTMLElement) el.click(); else fire(el, 'click', { ...init, detail: 2 });
      fire(el, 'dblclick', { ...init, detail: 2 });
    }
  }
  function focusEl(el) {
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    fire(el, 'focusin');
  }
  async function waitEnabled(el, timeout) {
    const end = Date.now() + timeout;
    while ((el.disabled || el.getAttribute('aria-disabled') === 'true') && Date.now() < end) await sleep(100);
  }
  async function typeValue(el, v) {
    focusEl(el);
    if (el.isContentEditable && !('value' in el)) {
      document.execCommand('selectAll', false, null);
      if (!document.execCommand('insertText', false, v)) el.textContent = v;
    } else {
      setNativeValue(el, v);
      fire(el, 'input', { inputType: 'insertText', data: v });
    }
    fire(el, 'change');
  }
  const KEYS = {
    Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'], ' ': [32, 'Space'],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
    PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Home: [36, 'Home'], End: [35, 'End'],
  };
  function keyInit(key) {
    const k = KEYS[key];
    if (k) return { key: key === 'Space' ? ' ' : key, code: k[1], keyCode: k[0], which: k[0] };
    const ch = key;
    const upper = ch.toUpperCase();
    return { key: ch, code: /^[a-z]$/i.test(ch) ? 'Key' + upper : /^\d$/.test(ch) ? 'Digit' + ch : '', keyCode: ch.length === 1 ? upper.charCodeAt(0) : 0, which: ch.length === 1 ? upper.charCodeAt(0) : 0, charCode: ch.length === 1 ? ch.charCodeAt(0) : 0 };
  }
  async function typeKeys(el, v, delay = 25) {
    focusEl(el);
    const editable = el.isContentEditable && !('value' in el);
    if (editable) { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
    else { setNativeValue(el, ''); fire(el, 'input', { inputType: 'deleteContentBackward' }); }
    for (const ch of [...v]) {
      const init = keyInit(ch);
      const ok = fire(el, 'keydown', init);
      fire(el, 'keypress', init);
      if (ok) {
        const inserted = document.activeElement === el && document.execCommand('insertText', false, ch);
        if (!inserted) {
          if (editable) el.textContent += ch;
          else { setNativeValue(el, (el.value || '') + ch); fire(el, 'input', { inputType: 'insertText', data: ch }); }
        }
      }
      fire(el, 'keyup', init);
      if (delay) await sleep(delay);
    }
    fire(el, 'change');
  }
  function tabbables() {
    return [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(e => !e.disabled && e.tabIndex >= 0 && isVisible(e));
  }
  function pressKey(el, key) {
    const target = el || document.activeElement || document.body;
    const init = keyInit(key);
    const notCanceled = fire(target, 'keydown', init);
    if (key.length === 1 || key === 'Enter') fire(target, 'keypress', { ...init, charCode: key === 'Enter' ? 13 : init.charCode });
    if (notCanceled) {
      if (key === 'Enter' && target.tagName === 'INPUT' && target.form && !/^(button|submit|reset|checkbox|radio|file)$/i.test(target.type)) {
        const form = target.form;
        const btn = [...form.elements].find(x => (x.tagName === 'BUTTON' && (x.type || 'submit') === 'submit') || (x.tagName === 'INPUT' && /^(submit|image)$/i.test(x.type)));
        if (btn) { if (!btn.disabled) btn.click(); }
        else if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      } else if (key === 'Enter' && (target.tagName === 'A' || target.tagName === 'BUTTON')) {
        target.click();
      } else if (key === 'Tab') {
        const list = tabbables();
        const i = list.indexOf(target);
        const next = list[(i + 1) % list.length];
        if (next) next.focus();
      } else if (key.length === 1 && isTextField(target)) {
        document.execCommand('insertText', false, key);
      }
    }
    fire(target, 'keyup', init);
  }
  function selectOption(el, spec) {
    if (el.tagName !== 'SELECT') {
      // custom listbox: click option by text
      throw new Error('Target is not a <select> element. Use click steps for custom dropdowns.');
    }
    const opts = [...el.options];
    let opt;
    const m = /^(label|value|index|text)=([\s\S]*)$/.exec(spec);
    if (m) {
      const [, kind, v] = m;
      if (kind === 'index') opt = opts[parseInt(v, 10)];
      else if (kind === 'value') opt = opts.find(o => o.value === v);
      else opt = opts.find(o => textMatches(o.text, v)) || opts.find(o => norm(o.text).toLowerCase().includes(norm(v).toLowerCase()));
    } else {
      opt = opts.find(o => textMatches(o.text, spec)) || opts.find(o => o.value === spec) || opts.find(o => norm(o.text).toLowerCase().includes(norm(spec).toLowerCase()));
    }
    if (!opt) throw new Error(`No option matching "${spec}". Options: ${opts.slice(0, 15).map(o => norm(o.text)).join(', ')}`);
    focusEl(el);
    setNativeValue(el, opt.value);
    opt.selected = true;
    fire(el, 'input');
    fire(el, 'change');
    return norm(opt.text);
  }
  function readText(el) {
    if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return o ? norm(o.text) : ''; }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
    return norm(el.innerText !== undefined ? el.innerText : el.textContent);
  }
  function readValue(el, attr) {
    if (!attr) return readText(el);
    if (attr === 'text') return readText(el);
    if (attr === 'html') return el.innerHTML;
    if (['href', 'src', 'value', 'checked'].includes(attr) && attr in el) return String(el[attr]);
    const v = el.getAttribute(attr);
    return v == null ? '' : v;
  }
  function splitVar(value) {
    const at = value.lastIndexOf('@');
    if (at > 0) return { name: value.slice(0, at).trim(), attr: value.slice(at + 1).trim() };
    return { name: value.trim(), attr: '' };
  }

  async function exec(msg) {
    const { step, timeout = 10000, highlight: hl = true } = msg;
    const { command, value = '' } = step;
    const targets = (step.targets || []).filter(Boolean);
    const label = `${command}${value && !/^(type|typeKeys)$/.test(command) ? ' · ' + value : ''}`;
    const show = (el, cls) => { if (hl) highlight(el, label, cls); };
    const prep = el => { try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch { el.scrollIntoView(); } };

    if (command === 'exists') {
      try { const f = await findElement(targets, timeout, { wantVisible: false }); show(f.el); return { ok: true, data: true, selector: f.selector }; }
      catch (e) { if (e.notFound) return { ok: true, data: false }; throw e; }
    }
    if (command === 'waitForGone') {
      const end = Date.now() + timeout;
      for (;;) {
        let present = false;
        for (const t of targets) { try { if (queryAll(t).some(isVisible)) { present = true; break; } } catch { /* ignore */ } }
        if (!present) return { ok: true };
        if (Date.now() > end) return { ok: false, error: `Element still present after ${timeout} ms` };
        await sleep(150);
      }
    }
    if (command === 'pressKey' && !targets.length) {
      pressKey(null, value || 'Enter');
      return { ok: true };
    }
    if (command === 'scroll' && !targets.length) {
      const v = value.trim().toLowerCase();
      if (v === 'top') window.scrollTo(0, 0);
      else if (v === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else { const [x, y] = v.split(/[,\s]+/).map(n => parseFloat(n) || 0); window.scrollTo(x, y); }
      return { ok: true };
    }
    if (!targets.length) return { ok: false, error: 'This command needs a target selector.', fatal: true };

    const wantVisible = !/^(extract|extractAll|assertExists|waitForElement)$/.test(command);
    const found = await findElement(targets, timeout, { wantVisible });
    const el = found.el;
    const res = { ok: true, selector: found.selector, fallback: found.index > 0, hidden: !!found.hidden, matches: found.count };
    if (/^(click|doubleClick|type|typeKeys|select|check|uncheck|hover|scroll|pressKey|submit)$/.test(command)) prep(el);
    show(el);

    switch (command) {
      case 'click': await waitEnabled(el, timeout); doClick(el, 1); break;
      case 'doubleClick': await waitEnabled(el, timeout); doClick(el, 2); break;
      case 'hover': { const init = pointerInit(el); fire(el, 'pointerover', init); fire(el, 'mouseover', init); fire(el, 'mouseenter', init); fire(el, 'mousemove', init); break; }
      case 'type': await waitEnabled(el, timeout); await typeValue(el, value); break;
      case 'typeKeys': await waitEnabled(el, timeout); await typeKeys(el, value); break;
      case 'pressKey': focusEl(el); pressKey(el, value || 'Enter'); break;
      case 'select': await waitEnabled(el, timeout); res.data = selectOption(el, value); break;
      case 'check':
      case 'uncheck': {
        const want = command === 'check';
        const isNative = el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type);
        const cur = isNative ? el.checked : el.getAttribute('aria-checked') === 'true';
        if (cur !== want) { doClick(el); if (isNative && el.checked !== want) { el.checked = want; fire(el, 'input'); fire(el, 'change'); } }
        break;
      }
      case 'submit': {
        const form = el.tagName === 'FORM' ? el : (el.form || el.closest('form'));
        if (!form) return { ok: false, error: 'No form found for target', fatal: true };
        form.requestSubmit ? form.requestSubmit() : form.submit();
        break;
      }
      case 'scroll': break;
      case 'waitForElement': case 'waitForVisible': case 'assertExists': break;
      case 'assertText': {
        const end = Date.now() + timeout;
        let actual = readText(el);
        while (!textContains(actual, value) && Date.now() < end) { await sleep(200); const f = await findElement(targets, 0, { wantVisible: false }).catch(() => null); if (f) actual = readText(f.el); }
        if (!textContains(actual, value)) { if (hl) highlight(el, 'assert failed', 'fail', 3000); return { ok: false, fatal: true, error: `Assertion failed: expected text containing "${value}" but found "${actual.slice(0, 200)}"` }; }
        res.data = actual.slice(0, 500);
        break;
      }
      case 'extract': { const { attr } = splitVar(value); res.data = readValue(el, attr); break; }
      case 'extractAll': {
        const { attr } = splitVar(value);
        const all = queryAll(found.selector);
        res.data = all.map(e => readValue(e, attr));
        break;
      }
      default: return { ok: false, error: `Unknown command "${command}"`, fatal: true };
    }
    return res;
  }
  function textContains(actual, expected) {
    const re = /^\/(.+)\/([gimsuy]*)$/.exec(expected || '');
    if (re) { try { return new RegExp(re[1], re[2]).test(actual); } catch { return false; } }
    return norm(actual).includes(norm(expected));
  }

  // ------------------------------------------------------------------ picker
  let picking = null;
  function startPick() {
    if (picking) return;
    ensureOverlay();
    const banner = shadow.querySelector('.banner');
    banner.style.display = 'block';
    let last = null;
    const move = e => {
      if (isOwn(e)) return;
      const el = e.composedPath()[0];
      if (el && el.nodeType === 1 && el !== last) { last = el; highlight(el, el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), 'pick', 0); }
    };
    const block = e => { if (!isOwn(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };
    const click = e => {
      if (isOwn(e)) return;
      block(e);
      const el = e.composedPath()[0];
      finish(el && el.nodeType === 1 ? generateSelectors(el) : null);
    };
    const key = e => { if (e.key === 'Escape') { block(e); finish(null); } };
    function finish(selectors) {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('mousedown', block, true);
      window.removeEventListener('mouseup', block, true);
      window.removeEventListener('pointerdown', block, true);
      window.removeEventListener('keydown', key, true);
      banner.style.display = 'none';
      hlBox.style.display = 'none';
      picking = null;
      chrome.runtime.sendMessage({ type: 'wa:picked', selectors, url: location.href }).catch(() => {});
    }
    window.addEventListener('mousemove', move, true);
    window.addEventListener('click', click, true);
    window.addEventListener('mousedown', block, true);
    window.addEventListener('mouseup', block, true);
    window.addEventListener('pointerdown', block, true);
    window.addEventListener('keydown', key, true);
    picking = { finish };
  }

  // ------------------------------------------------------------------ messaging
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return;
    switch (msg.type) {
      case 'wa:ping': sendResponse({ ok: true, recording: rec.on, url: location.href, ready: document.readyState }); return;
      case 'wa:startRecording': startRecording(msg.opts); sendResponse({ ok: true }); return;
      case 'wa:stopRecording': stopRecording(); sendResponse({ ok: true }); return;
      case 'wa:recCount': updatePill(msg.count); sendResponse({ ok: true }); return;
      case 'wa:pick': startPick(); sendResponse({ ok: true }); return;
      case 'wa:cancelPick': if (picking) picking.finish(null); sendResponse({ ok: true }); return;
      case 'wa:highlight': {
        const targets = (msg.targets || []).filter(Boolean);
        findElement(targets, msg.timeout || 0, { wantVisible: false }).then(f => {
          try { f.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
          setTimeout(() => highlight(f.el, `${f.selector}${f.count > 1 ? ` (1 of ${f.count})` : ''}`, 'pick', 2500), 250);
          sendResponse({ ok: true, selector: f.selector, count: f.count, index: f.index });
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      case 'wa:exec':
        exec(msg).then(sendResponse, e => sendResponse({ ok: false, error: e.message || String(e), notFound: !!e.notFound }));
        return true;
    }
  });
})();
