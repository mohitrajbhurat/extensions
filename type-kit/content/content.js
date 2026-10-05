/* Type Kit content script.
 * - Expands snippet shortcuts in inputs, textareas and contenteditable editors.
 * - Backspace right after an expansion restores the typed shortcut.
 * - Fill-in dialog for {input:...}/{select:...} placeholders.
 * - Alt+Shift+V picker (opened by the background command) for snippets and clipboard items.
 * - Records copy/cut events into the clipboard history (never password fields,
 *   incognito windows or excluded sites).
 * Runs in every frame. Depends on shared/engine.js (TKEngine).
 */
(function () {
  'use strict';

  if (window.__typeKitInstance) {
    try { window.__typeKitInstance.destroy(); } catch (e) { /* orphaned instance */ }
  }

  const E = self.TKEngine;
  if (!E) return;

  const KEYS = { snippets: 'tk.snippets', settings: 'tk.settings', clips: 'tk.clips' };
  const HOST_TAG = 'type-kit-ui';
  const RICH_CURSOR = '⁣';          // invisible separator used to locate {cursor} in rich inserts
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', '']);
  const SENSITIVE_AUTOCOMPLETE = /\b(cc-number|cc-csc|cc-exp|one-time-code|current-password|new-password)\b/i;
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
    'TD', 'TH', 'SECTION', 'ARTICLE', 'DD', 'DT', 'FIGCAPTION']);

  const state = {
    ready: false,
    snippets: [],
    settings: {},
    clips: [],
    busy: false,               // an expansion is in progress
    inserting: false,          // we are dispatching our own edits
    lastExpansion: null,       // for Backspace undo
    lastTarget: null,          // last focused editable { el, start, end, range }
    pickerOpen: false,
    dialogOpen: false,
  };

  const cleanups = [];
  let destroyed = false;

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  function alive() {
    try { return !destroyed && !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function send(msg) {
    return new Promise((resolve) => {
      if (!alive()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res); });
      } catch (e) { resolve(null); }
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /* ---------------- settings / data ---------------- */

  function hostMatches(host, pattern) {
    host = String(host || '').toLowerCase();
    pattern = String(pattern || '').trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    if (pattern.includes('*')) {
      const rx = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return rx.test(host);
    }
    return host === pattern || host.endsWith('.' + pattern);
  }

  function pageHost() {
    try {
      if (location.hostname) return location.hostname;
      return window.top === window ? '' : (document.referrer ? new URL(document.referrer).hostname : '');
    } catch (e) { return ''; }
  }

  function expansionAllowed() {
    const s = state.settings;
    if (!state.ready || !s.expanderEnabled) return false;
    return !(s.expanderExcludedSites || []).some((p) => hostMatches(pageHost(), p));
  }

  function historyAllowed() {
    const s = state.settings;
    if (!state.ready || !s.historyEnabled) return false;
    try { if (chrome.extension && chrome.extension.inIncognitoContext) return false; } catch (e) { return false; }
    return !(s.excludedSites || []).some((p) => hostMatches(pageHost(), p));
  }

  function liveClips() {
    const days = Number(state.settings.historyExpiryDays) || 0;
    if (!days) return state.clips;
    const cutoff = Date.now() - days * 86400000;
    return state.clips.filter((c) => c.pinned || new Date(c.createdAt).getTime() >= cutoff);
  }

  async function loadData() {
    const res = await send({ type: 'tk:get-data' });
    if (!res || !res.ok) return;
    state.snippets = res.snippets || [];
    state.settings = res.settings || {};
    state.clips = res.clips || [];
    state.ready = true;
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !alive()) return;
    if (changes[KEYS.snippets]) state.snippets = changes[KEYS.snippets].newValue || [];
    if (changes[KEYS.clips]) state.clips = changes[KEYS.clips].newValue || [];
    if (changes[KEYS.settings]) loadData();       // re-merge with defaults
  }

  /* ---------------- DOM helpers ---------------- */

  function isOurs(node) {
    return !!(node && node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === HOST_TAG);
  }

  function eventFromOurUI(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.some(isOurs);
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isTextInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
  }

  function editingHost(el) {
    if (!el || el.nodeType !== 1 || !el.isContentEditable) return null;
    let root = el;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  }

  /** The editable that should receive text: an <input>/<textarea> element or a contenteditable host. */
  function editableOf(el) {
    if (!el || isOurs(el)) return null;
    if (isTextInput(el)) return el;
    if (el.nodeType === 1 && el.isContentEditable) return editingHost(el);
    return null;
  }

  function isSensitiveField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return true;
    return /pass(word|wd|code)|\bpin\b|\bcvv\b|\bcvc\b/i.test((el.name || '') + ' ' + (el.id || ''));
  }

  function selectionFor(node) {
    const rn = node && node.getRootNode ? node.getRootNode() : document;
    if (rn && rn !== document && typeof rn.getSelection === 'function') return rn.getSelection();
    return window.getSelection();
  }

  function blockAncestor(node, root) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== root && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el && root.contains(el) ? el : root;
  }

  /** Text before the caret (current block only) in a contenteditable host. */
  function ceTextBefore(root) {
    const sel = selectionFor(root);
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!root.contains(r.endContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(blockAncestor(r.endContainer, root));
    try { pre.setEnd(r.endContainer, r.endOffset); } catch (e) { return null; }
    return pre.toString().slice(-256).replace(/ /g, ' ');
  }

  function textBeforeCaret(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      let s, e;
      try { s = el.selectionStart; e = el.selectionEnd; } catch (err) { return null; }
      if (s == null || s !== e) return null;
      return el.value.slice(Math.max(0, s - 256), s);
    }
    return ceTextBefore(el);
  }

  /** Snapshot where text would be inserted in an editable. */
  function captureTarget(el) {
    if (!el) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      let start = el.value.length, end = el.value.length;
      try { start = el.selectionStart; end = el.selectionEnd; } catch (e) { /* ignore */ }
      return { el, start, end };
    }
    const sel = selectionFor(el);
    let range = null;
    if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) range = sel.getRangeAt(0).cloneRange();
    return { el, range };
  }

  /** Put focus and the caret back where captureTarget recorded them. */
  function restoreTarget(t) {
    if (!t || !t.el || !t.el.isConnected) return false;
    try { t.el.focus({ preventScroll: true }); } catch (e) { t.el.focus(); }
    if (t.el.tagName === 'INPUT' || t.el.tagName === 'TEXTAREA') {
      try { t.el.setSelectionRange(t.start, t.end); } catch (e) { /* ignore */ }
      return true;
    }
    const sel = selectionFor(t.el);
    if (t.range && sel) {
      try { sel.removeAllRanges(); sel.addRange(t.range); } catch (e) { /* ignore */ }
    }
    return true;
  }

  function nativeValueSetter(el) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, 'value').set;
  }

  /** Plain-text projection of rich HTML (no trimming, so lengths stay comparable). */
  function htmlPlain(html) {
    return String(html)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote|pre)\s*>(?!\s*$)/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&');
  }

  /* ---------------- low-level insertion ---------------- */

  function insertIntoInput(el, start, end, text) {
    state.inserting = true;
    try {
      el.focus();
      try { el.setSelectionRange(start, end); } catch (e) { /* ignore */ }
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        // Fallback that React/Vue controlled inputs still notice: native setter + input event.
        const v = el.value;
        nativeValueSetter(el).call(el, v.slice(0, start) + text + v.slice(end));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) { /* ignore */ }
      }
    } finally {
      state.inserting = false;
    }
  }

  function moveCaret(root, dir, count, extend) {
    const sel = selectionFor(root);
    if (!sel || typeof sel.modify !== 'function') return false;
    for (let i = 0; i < count; i++) sel.modify(extend ? 'extend' : 'move', dir, 'character');
    return true;
  }

  function dispatchPaste(target, plain, html) {
    let dt;
    try { dt = new DataTransfer(); } catch (e) { return false; }
    dt.setData('text/plain', plain);
    if (html) dt.setData('text/html', html);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  function manualInsert(root, plain, html) {
    const sel = selectionFor(root);
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tpl = document.createElement('template');
    if (html) tpl.innerHTML = html;
    else plain.split('\n').forEach((line, i) => {
      if (i) tpl.content.appendChild(document.createElement('br'));
      tpl.content.appendChild(document.createTextNode(line));
    });
    const frag = tpl.content;
    const last = frag.lastChild;
    r.insertNode(frag);
    if (last) { r.setStartAfter(last); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: plain }));
  }

  /** Replace the current selection in a contenteditable with text or HTML. Returns 'sync'|'paste'. */
  function insertIntoCE(root, plain, html) {
    state.inserting = true;
    try {
      const sel = selectionFor(root);
      const anchor = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : root;
      const multiline = /\n/.test(plain);
      if (!html && !multiline) {
        let ok = false;
        try { ok = document.execCommand('insertText', false, plain); } catch (e) { ok = false; }
        if (ok) return 'sync';
        if (dispatchPaste(anchor || root, plain, null)) return 'paste';
        manualInsert(root, plain, null);
        return 'sync';
      }
      // Rich or multi-line: editors such as Slack, Notion, Gmail and LinkedIn handle paste best.
      if (dispatchPaste(anchor || root, plain, html)) return 'paste';
      let ok = false;
      try { ok = html ? document.execCommand('insertHTML', false, html) : document.execCommand('insertText', false, plain); } catch (e) { ok = false; }
      if (!ok) manualInsert(root, plain, html);
      return 'sync';
    } finally {
      state.inserting = false;
    }
  }

  /** Find the rich cursor marker inside root, put the caret there and delete it. */
  function consumeRichCursor(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.data.indexOf(RICH_CURSOR);
      if (i === -1) continue;
      const sel = selectionFor(root);
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 1);
      sel.removeAllRanges(); sel.addRange(r);
      state.inserting = true;
      let ok = false;
      try { ok = document.execCommand('delete', false); } catch (e) { ok = false; }
      state.inserting = false;
      if (!ok && n.isConnected && n.data.indexOf(RICH_CURSOR) !== -1) {
        n.deleteData(n.data.indexOf(RICH_CURSOR), 1);
        r.setStart(n, i); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
      }
      return true;
    }
    return false;
  }

  /* ---------------- rendering ---------------- */

  function bodyNeedsClipboard(snippet, depth, seen) {
    depth = depth || 0; seen = seen || new Set();
    if (!snippet || depth > 6 || seen.has(snippet.id)) return false;
    seen.add(snippet.id);
    for (const tok of E.scan(snippet.body)) {
      if (tok.type !== 'placeholder') continue;
      if (tok.name === 'clipboard' || tok.name === 'clip' || tok.name === 'paste') return true;
      if (tok.name === 'snippet' || tok.name === 's') {
        const child = E.snippetByShortcut({ snippets: state.snippets }, tok.rest.join(':'));
        if (child && bodyNeedsClipboard(child, depth + 1, seen)) return true;
      }
    }
    return false;
  }

  async function clipsForRender(snippet) {
    const clips = liveClips().slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!bodyNeedsClipboard(snippet)) return clips;
    const res = await send({ type: 'tk:read-clipboard' });
    if (res && typeof res.text === 'string' && res.text) {
      if (!clips.length || clips[0].text !== res.text) return [{ text: res.text }].concat(clips);
    }
    return clips;
  }

  /**
   * Render a snippet for a given destination.
   * Returns { plain, html, cursorFromEnd, insertedPlainLength } or null if cancelled.
   */
  async function renderSnippet(snippet, toRichEditor, trailing) {
    const ctx = {
      snippets: state.snippets,
      clips: await clipsForRender(snippet),
      settings: state.settings,
      pageUrl: location.href,
      pageTitle: document.title,
      pageHost: location.hostname,
    };
    const fields = E.collectFields(snippet.body, ctx);
    let values = {};
    if (fields.length) {
      values = await fillInDialog(snippet, fields, ctx);
      if (!values) return null;
    }
    const isRich = snippet.format === 'rich';
    const r = E.render(snippet.body, Object.assign({}, ctx, { values, rich: isRich }));
    trailing = trailing || '';

    if (isRich && toRichEditor) {
      const withMarker = r.cursor >= 0 ? r.text.slice(0, r.cursor) + RICH_CURSOR + r.text.slice(r.cursor) : r.text;
      const html = E.sanitizeHTML(withMarker, document) + E.escapeHTML(trailing);
      const plain = htmlPlain(r.text) + trailing;
      return { plain, html, richCursor: r.cursor >= 0, cursorFromEnd: -1, insertedPlainLength: plain.length };
    }
    let plain, cursorIdx;
    if (isRich) {
      plain = htmlPlain(r.text);
      cursorIdx = r.cursor >= 0 ? htmlPlain(r.text.slice(0, r.cursor)).length : -1;
    } else {
      plain = r.text;
      cursorIdx = r.cursor;
    }
    plain = plain.replace(/\r\n?/g, '\n');
    const full = plain + trailing;
    return {
      plain: full, html: null, richCursor: false,
      cursorFromEnd: cursorIdx >= 0 ? full.length - cursorIdx : -1,
      insertedPlainLength: full.length,
    };
  }

  /**
   * Insert a snippet or text at a target, replacing `typed` characters before the caret.
   * opts: { snippet, text, typed, trailing, target }
   */
  async function performInsert(opts) {
    const target = opts.target;
    const el = target.el;
    const typed = opts.typed || '';
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';

    let rendered;
    if (opts.snippet) {
      rendered = await renderSnippet(opts.snippet, !isInput, opts.trailing);
      if (!rendered) { restoreTarget(target); return false; }
    } else {
      const t = String(opts.text || '');
      rendered = { plain: t, html: null, richCursor: false, cursorFromEnd: -1, insertedPlainLength: t.length };
    }

    if (!restoreTarget(target)) return false;
    if (isInput && el.tagName === 'INPUT') rendered.plain = rendered.plain.replace(/\n+/g, ' ');

    if (isInput) {
      let start = target.start, end = target.end;
      if (typed) {
        const caret = target.end;
        if (el.value.slice(caret - typed.length, caret) !== typed) return false;   // user changed it meanwhile
        start = caret - typed.length; end = caret;
      }
      insertIntoInput(el, start, end, rendered.plain);
      const endPos = start + rendered.plain.length;
      let caret = endPos;
      if (rendered.cursorFromEnd >= 0) {
        caret = endPos - rendered.cursorFromEnd;
        try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
      }
      if (typed) {
        state.lastExpansion = { el, kind: 'input', start, inserted: rendered.plain, typed, value: el.value, caret };
      }
    } else {
      if (typed) {
        const before = ceTextBefore(el);
        if (before == null || !before.endsWith(typed.replace(/ /g, ' '))) return false;
        moveCaret(el, 'backward', typed.length, true);
        await nextFrame();               // let editors observe the new selection before we edit
        const sel = selectionFor(el);
        const selected = sel ? sel.toString().replace(/ /g, ' ') : '';
        if (selected && selected !== typed) return false;
      }
      const mode = insertIntoCE(el, rendered.plain, rendered.html);
      if (mode === 'paste') await nextFrame();
      if (rendered.richCursor) {
        if (mode === 'paste') await nextFrame();
        consumeRichCursor(el);
      } else if (rendered.cursorFromEnd > 0) {
        moveCaret(el, 'backward', rendered.cursorFromEnd, false);
      }
      if (typed) {
        const sel = selectionFor(el);
        state.lastExpansion = {
          el, kind: 'ce', typed, inserted: rendered.plain,
          insertedLength: rendered.insertedPlainLength,
          cursorFromEnd: rendered.richCursor ? -1 : Math.max(0, rendered.cursorFromEnd),
          node: sel && sel.focusNode, offset: sel && sel.focusOffset,
        };
      }
    }
    return { insertedLength: rendered.insertedPlainLength };
  }

  /* ---------------- expansion ---------------- */

  function findMatch(text) {
    const s = state.settings;
    let m = E.findShortcut(text, state.snippets, s);
    if (m) return m;
    // Instant mode waits when a longer shortcut shares this prefix; a delimiter settles it.
    if (s.triggerMode !== 'space' && /[\s.,;:!?)]$/.test(text)) {
      m = E.findShortcut(text.slice(0, -1), state.snippets, s, { force: true });
      if (m) m.trailing = text.slice(-1);
    }
    return m;
  }

  function onInput(e) {
    if (state.inserting || state.busy || destroyed) return;
    if (eventFromOurUI(e)) return;
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    const el = editableOf(target && target.nodeType === 1 ? target : deepActiveElement());
    if (!el) return;
    if (state.lastExpansion && e.inputType === 'insertText') state.lastExpansion = null;
    if (!expansionAllowed()) return;
    if (e.isComposing) return;
    const t = e.inputType || 'insertText';
    if (t !== 'insertText' && t !== 'insertLineBreak' && t !== 'insertCompositionText') return;
    if (el.tagName === 'INPUT' && isSensitiveField(el)) return;
    const text = textBeforeCaret(el);
    if (!text) return;
    const m = findMatch(text);
    if (!m) return;
    expand(el, m, text);
  }

  function onCompositionEnd(e) {
    // IME users: check after the composition commits.
    setTimeout(() => onInput({ inputType: 'insertText', composedPath: () => e.composedPath(), target: e.target }), 0);
  }

  async function expand(el, m, text) {
    state.busy = true;
    try {
      const typed = text.slice(m.start);
      const trailing = text.slice(m.end);
      const target = captureTarget(el);
      const res = await performInsert({ snippet: m.snippet, typed, trailing, target });
      if (res) {
        send({ type: 'tk:record-use', id: m.snippet.id, insertedLength: res.insertedLength, shortcutLength: typed.length });
        if (state.settings.showToast) toast('Expanded ' + m.shortcut + ' · Backspace to undo');
      }
    } catch (err) {
      console.warn('[Type Kit] expansion failed', err);
    } finally {
      state.busy = false;
    }
  }

  /** Backspace right after an expansion puts the typed shortcut back. */
  function tryUndo(e) {
    const x = state.lastExpansion;
    if (!x) return false;
    const el = editableOf(deepActiveElement());
    if (!el || el !== x.el) { state.lastExpansion = null; return false; }
    if (x.kind === 'input') {
      let s, en;
      try { s = el.selectionStart; en = el.selectionEnd; } catch (err) { return false; }
      if (el.value !== x.value || s !== x.caret || en !== x.caret) { state.lastExpansion = null; return false; }
      e.preventDefault();
      insertIntoInput(el, x.start, x.start + x.inserted.length, x.typed);
    } else {
      const sel = selectionFor(el);
      if (!sel || !sel.isCollapsed || sel.focusNode !== x.node || sel.focusOffset !== x.offset) { state.lastExpansion = null; return false; }
      e.preventDefault();
      if (x.cursorFromEnd > 0) moveCaret(el, 'forward', x.cursorFromEnd, false);
      moveCaret(el, 'backward', x.insertedLength, true);
      state.inserting = true;
      try {
        if (!document.execCommand('insertText', false, x.typed)) manualInsert(el, x.typed, null);
      } finally { state.inserting = false; }
    }
    state.lastExpansion = null;
    if (state.settings.showToast) toast('Restored ' + x.typed.trim());
    return true;
  }

  function onKeyDown(e) {
    if (destroyed || eventFromOurUI(e)) return;
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (tryUndo(e)) return;
    }
    if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key) && e.key !== 'Backspace') {
      // Any other key ends the undo window (the input handler also clears it on typing).
      if (e.key !== 'Unidentified') state.lastExpansion = null;
    }
  }

  function onPointerDown(e) {
    if (eventFromOurUI(e)) return;
    state.lastExpansion = null;
  }

  function onFocusIn(e) {
    if (eventFromOurUI(e)) return;
    const el = editableOf(deepActiveElement());
    if (!el) return;
    state.lastTarget = { el };
    send({ type: 'tk:focus' });
  }

  /* ---------------- clipboard capture ---------------- */

  let pendingCopy = null;

  function selectedTextNow() {
    const a = deepActiveElement();
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      try {
        if (a.selectionStart != null && a.selectionEnd > a.selectionStart) return { text: a.value.slice(a.selectionStart, a.selectionEnd), el: a };
      } catch (e) { /* types without selection API */ }
    }
    const sel = window.getSelection();
    return { text: sel ? sel.toString() : '', el: a };
  }

  function onCopyCapture(e) {
    pendingCopy = null;
    if (!historyAllowed() || eventFromOurUI(e)) return;
    const { text, el } = selectedTextNow();
    if (el && el.tagName === 'INPUT' && isSensitiveField(el)) { pendingCopy = { blocked: true }; return; }
    pendingCopy = { text };
  }

  function onCopyBubble(e) {
    const p = pendingCopy;
    pendingCopy = null;
    if (!p || p.blocked || !historyAllowed()) return;
    let text = p.text;
    if (e.defaultPrevented && e.clipboardData) {
      // The page wrote its own clipboard data (copy buttons, editors); record what it wrote.
      try { const t = e.clipboardData.getData('text/plain'); if (t) text = t; } catch (err) { /* ignore */ }
    }
    if (!text || !text.trim()) return;
    send({ type: 'tk:add-clip', text, url: location.href, title: document.title });
  }

  /* ---------------- UI host (shadow DOM) ---------------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .tk { --bg:#ffffff; --fg:#1d1d24; --muted:#6b6b78; --line:#e4e4ea; --soft:#f4f4f7; --accent:#db2777; --accent-fg:#fff; --sel:#fde7f1; --shadow:0 18px 48px rgba(20,10,30,.28);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif; color: var(--fg); }
    @media (prefers-color-scheme: dark) {
      .tk { --bg:#1f1d24; --fg:#ececf1; --muted:#a2a0ad; --line:#38353f; --soft:#2a2730; --accent:#f472b6; --accent-fg:#1a0a12; --sel:#4a2338; --shadow:0 18px 48px rgba(0,0,0,.6); }
    }
    .backdrop { position: fixed; inset: 0; background: rgba(15,10,20,.28); z-index: 2147483646; }
    .panel { position: fixed; left: 50%; top: 12vh; transform: translateX(-50%); width: min(560px, calc(100vw - 32px));
      max-height: 72vh; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line);
      border-radius: 14px; box-shadow: var(--shadow); z-index: 2147483647; overflow: hidden; }
    .head { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
    .title { font-weight: 600; font-size: 15px; }
    .sub { color: var(--muted); font-size: 12px; }
    input.search, .field input, .field textarea, .field select {
      width: 100%; font: inherit; color: var(--fg); background: var(--soft); border: 1px solid var(--line);
      border-radius: 8px; padding: 8px 12px; outline: none; }
    input.search { font-size: 16px; padding: 10px 12px; }
    input:focus, textarea:focus, select:focus, button:focus-visible, .item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .chips { display: flex; gap: 8px; }
    .chip { font: inherit; font-size: 12px; border: 1px solid var(--line); background: transparent; color: var(--muted);
      border-radius: 999px; padding: 2px 10px; cursor: pointer; }
    .chip[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .list { overflow: auto; padding: 8px; flex: 1; min-height: 64px; }
    .section { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 8px 8px 4px; }
    .item { display: flex; gap: 8px; align-items: flex-start; padding: 8px; border-radius: 8px; cursor: pointer; }
    .item[aria-selected="true"] { background: var(--sel); }
    .item .main { flex: 1; min-width: 0; }
    .item .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item .prev { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kbd { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); border: 1px solid var(--line);
      border-radius: 6px; padding: 1px 6px; color: var(--fg); white-space: nowrap; }
    .pin { color: var(--accent); font-size: 12px; }
    mark { background: transparent; color: var(--accent); font-weight: 700; }
    .empty { color: var(--muted); padding: 16px; text-align: center; }
    .foot { border-top: 1px solid var(--line); padding: 8px 16px; color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px 16px; }
    .form { padding: 16px; display: flex; flex-direction: column; gap: 16px; overflow: auto; }
    .field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
    .field textarea { min-height: 72px; resize: vertical; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
    button.btn { font: inherit; border-radius: 8px; padding: 8px 16px; cursor: pointer; border: 1px solid var(--line); background: var(--soft); color: var(--fg); }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
    .preview { white-space: pre-wrap; background: var(--soft); border-radius: 8px; padding: 8px 12px; font-size: 13px; max-height: 140px; overflow: auto; color: var(--muted); }
    .toast { position: fixed; right: 16px; bottom: 16px; background: var(--fg); color: var(--bg); padding: 8px 16px; border-radius: 8px;
      font-size: 13px; box-shadow: var(--shadow); z-index: 2147483647; opacity: 0; transform: translateY(8px); transition: opacity .15s, transform .15s; pointer-events: none; }
    .toast.show { opacity: 1; transform: none; }
  `;

  let uiHost = null, uiRoot = null;
  function ui() {
    if (uiHost && uiHost.isConnected) return uiRoot;
    uiHost = document.createElement(HOST_TAG);
    uiHost.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    uiRoot = uiHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'tk';
    uiRoot.append(style, wrap);
    // Keep our typing away from page keyboard shortcuts.
    for (const t of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut']) uiHost.addEventListener(t, (e) => e.stopPropagation());
    (document.body || document.documentElement).appendChild(uiHost);
    return uiRoot;
  }
  function uiWrap() { return ui().querySelector('.tk'); }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  let toastTimer = null;
  function toast(msg) {
    if (window.top !== window && !document.hasFocus()) return;
    const wrap = uiWrap();
    let t = wrap.querySelector('.toast');
    if (!t) { t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); wrap.append(t); }
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function trapFocus(panel, e) {
    if (e.key !== 'Tab') return;
    const items = Array.from(panel.querySelectorAll('input, textarea, select, button')).filter((x) => !x.disabled);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = uiRoot.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------------- fill-in dialog ---------------- */

  function fillInDialog(snippet, fields, ctx) {
    return new Promise((resolve) => {
      state.dialogOpen = true;
      const wrap = uiWrap();
      const inputs = new Map();
      const preview = h('div', { class: 'preview', 'aria-label': 'Preview' });
      const current = () => {
        const v = {};
        for (const [key, el] of inputs) v[key] = el.value;
        return v;
      };
      const updatePreview = () => {
        const r = E.render(snippet.body, Object.assign({}, ctx, { values: current(), rich: snippet.format === 'rich' }));
        preview.textContent = snippet.format === 'rich' ? E.htmlToText(r.text) : r.text;
      };
      const formEls = fields.map((f, i) => {
        const id = 'tkf' + i;
        let ctl;
        if (f.type === 'select') {
          ctl = h('select', { id }, f.options.map((o) => h('option', { value: o, text: o })));
          ctl.value = f.default || f.options[0];
        } else if (f.multiline) {
          ctl = h('textarea', { id });
          ctl.value = f.default || '';
        } else {
          ctl = h('input', { id, type: 'text', autocomplete: 'off' });
          ctl.value = f.default || '';
        }
        ctl.addEventListener('input', updatePreview);
        ctl.addEventListener('change', updatePreview);
        inputs.set(f.key, ctl);
        return h('div', { class: 'field' }, h('label', { for: id, text: f.label }), ctl);
      });
      const finish = (ok) => {
        const values = ok ? current() : null;
        backdrop.remove(); panel.remove();
        state.dialogOpen = false;
        resolve(values);
      };
      const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { e.preventDefault(); finish(false); } });
      const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tk-dlg-title' },
        h('div', { class: 'head' },
          h('div', { class: 'title', id: 'tk-dlg-title', text: snippet.name || 'Fill in snippet' }),
          h('div', { class: 'sub', text: (snippet.shortcut ? snippet.shortcut + ' · ' : '') + 'Fill in the fields, then press Enter' })),
        h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); finish(true); } },
          formEls, h('div', {}, h('div', { class: 'section', text: 'Preview' }), preview),
          h('button', { type: 'submit', hidden: true, tabindex: '-1' })),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => finish(false) }),
          h('button', { class: 'btn primary', type: 'button', text: 'Insert', onclick: () => finish(true) })));
      panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); return; }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); finish(true); return; }
        trapFocus(panel, e);
      });
      wrap.append(backdrop, panel);
      updatePreview();
      const first = panel.querySelector('input, textarea, select');
      setTimeout(() => { first.focus(); if (first.select) first.select(); }, 0);
    });
  }

  /* ---------------- picker ---------------- */

  let picker = null;

  function relTime(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function highlight(text, positions) {
    const frag = document.createDocumentFragment();
    const set = new Set(positions || []);
    let buf = '';
    for (let i = 0; i < text.length; i++) {
      if (set.has(i)) {
        if (buf) { frag.append(buf); buf = ''; }
        frag.append(h('mark', { text: text[i] }));
      } else buf += text[i];
    }
    if (buf) frag.append(buf);
    return frag;
  }

  function oneLine(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function closePicker(restore) {
    if (!picker) return;
    const p = picker;
    picker = null;
    state.pickerOpen = false;
    p.backdrop.remove(); p.panel.remove();
    if (restore && p.target) restoreTarget(p.target);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
    ta.value = text;
    uiWrap().append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  async function choose(entry, mode) {
    const p = picker;
    if (!p) return;
    const target = p.target;
    closePicker(false);
    if (entry.kind === 'clip') send({ type: 'tk:touch-clip', id: entry.item.id });
    if (mode === 'copy' || !target) {
      let text = entry.kind === 'clip' ? entry.item.text : null;
      if (entry.kind === 'snippet') {
        const r = await renderSnippet(entry.item, false, '');
        if (!r) return;
        text = r.plain;
        send({ type: 'tk:record-use', id: entry.item.id, insertedLength: text.length, shortcutLength: 0 });
      }
      if (target) restoreTarget(target);
      const ok = await copyText(text);
      toast(ok ? 'Copied to clipboard' : 'Could not copy');
      return;
    }
    if (entry.kind === 'snippet') {
      const res = await performInsert({ snippet: entry.item, target });
      if (res) send({ type: 'tk:record-use', id: entry.item.id, insertedLength: res.insertedLength, shortcutLength: 0 });
    } else {
      await performInsert({ text: entry.item.text, target });
    }
  }

  function buildEntries(query, filter) {
    const out = [];
    const snippets = state.snippets.filter((s) => s.enabled !== false);
    const clips = liveClips();
    if (filter !== 'clips') {
      const ranked = query
        ? E.search(query, snippets, (s) => [s.shortcut, s.name, E.preview(s, { snippets: state.snippets, clips }).slice(0, 300)])
        : snippets.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0) || String(a.name).localeCompare(b.name)).map((item) => ({ item, positions: [], field: 1 }));
      for (const r of ranked.slice(0, filter === 'snippets' ? 100 : 30)) out.push({ kind: 'snippet', item: r.item, positions: r.positions, field: r.field });
    }
    if (filter !== 'snippets') {
      const sorted = clips.slice().sort((a, b) => (b.pinned - a.pinned) || (new Date(b.createdAt) - new Date(a.createdAt)));
      const ranked = query ? E.search(query, sorted, (c) => [c.text.slice(0, 2000), c.title, c.host]) : sorted.map((item) => ({ item, positions: [], field: 0 }));
      for (const r of ranked.slice(0, filter === 'clips' ? 200 : 30)) out.push({ kind: 'clip', item: r.item, positions: r.positions, field: r.field });
    }
    return out;
  }

  function renderPickerList() {
    const p = picker;
    if (!p) return;
    p.entries = buildEntries(p.input.value, p.filter);
    if (p.index >= p.entries.length) p.index = Math.max(0, p.entries.length - 1);
    p.list.textContent = '';
    if (!p.entries.length) {
      p.list.append(h('div', { class: 'empty', text: p.input.value ? 'No matches' : 'Nothing here yet. Create snippets in the manager, or copy some text.' }));
      p.input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastKind = null;
    p.entries.forEach((en, i) => {
      if (en.kind !== lastKind) {
        p.list.append(h('div', { class: 'section', role: 'presentation', text: en.kind === 'snippet' ? 'Snippets' : 'Clipboard' }));
        lastKind = en.kind;
      }
      let main;
      if (en.kind === 'snippet') {
        const s = en.item;
        const prev = oneLine(E.preview(s, { snippets: state.snippets, clips: liveClips() }), 120);
        main = h('div', { class: 'main' },
          h('div', { class: 'name' }, en.field === 1 ? highlight(s.name, en.positions) : s.name),
          h('div', { class: 'prev', text: prev }));
        const right = s.shortcut ? h('span', { class: 'kbd' }, en.field === 0 ? highlight(s.shortcut, en.positions) : s.shortcut) : null;
        p.list.append(h('div', { class: 'item', role: 'option', id: 'tk-opt-' + i, 'aria-selected': String(i === p.index), 'data-i': i }, main, right));
      } else {
        const c = en.item;
        const line = oneLine(c.text, 140);
        main = h('div', { class: 'main' },
          h('div', { class: 'name' }, en.field === 0 && c.text.length <= 140 && !/\s{2,}|\n/.test(c.text) ? highlight(line, en.positions) : line),
          h('div', { class: 'prev', text: [c.host, relTime(c.createdAt), c.text.length > 140 ? c.text.length + ' chars' : ''].filter(Boolean).join(' · ') }));
        p.list.append(h('div', { class: 'item', role: 'option', id: 'tk-opt-' + i, 'aria-selected': String(i === p.index), 'data-i': i },
          main, c.pinned ? h('span', { class: 'pin', title: 'Pinned', text: '● pinned' }) : null));
      }
    });
    p.input.setAttribute('aria-activedescendant', 'tk-opt-' + p.index);
    const sel = p.list.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function setSelected(i) {
    const p = picker;
    if (!p || !p.entries.length) return;
    p.index = (i + p.entries.length) % p.entries.length;
    p.list.querySelectorAll('.item').forEach((el) => el.setAttribute('aria-selected', String(Number(el.dataset.i) === p.index)));
    p.input.setAttribute('aria-activedescendant', 'tk-opt-' + p.index);
    const sel = p.list.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  async function openPicker(initialFilter) {
    if (picker) { closePicker(true); return; }
    if (state.dialogOpen) return;
    if (!state.ready) await loadData();
    const fresh = await send({ type: 'tk:get-clips' });
    if (fresh && fresh.ok) state.clips = fresh.clips;
    const active = editableOf(deepActiveElement());
    const target = active ? captureTarget(active) : null;
    state.pickerOpen = true;
    const wrap = uiWrap();
    const filters = [['all', 'All'], ['snippets', 'Snippets'], ['clips', 'Clipboard']];
    const input = h('input', {
      class: 'search', type: 'text', placeholder: target ? 'Search snippets and clipboard…' : 'Search… (no text field focused: Enter copies)',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'tk-list', 'aria-label': 'Search snippets and clipboard', autocomplete: 'off', spellcheck: 'false',
    });
    const chips = filters.map(([k, label]) => h('button', {
      class: 'chip', type: 'button', 'data-k': k, 'aria-pressed': String(k === (initialFilter || 'all')), text: label,
      onclick: () => { setFilter(k); input.focus(); },
    }));
    const list = h('div', { class: 'list', id: 'tk-list', role: 'listbox', 'aria-label': 'Results' });
    const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { e.preventDefault(); closePicker(true); } });
    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Type Kit picker' },
      h('div', { class: 'head' }, input, h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' }, chips)),
      list,
      h('div', { class: 'foot' },
        h('span', {}, h('span', { class: 'kbd', text: 'Enter' }), target ? ' insert' : ' copy'),
        h('span', {}, h('span', { class: 'kbd', text: 'Shift+Enter' }), ' copy'),
        h('span', {}, h('span', { class: 'kbd', text: 'Tab' }), ' filter'),
        h('span', {}, h('span', { class: 'kbd', text: 'Alt+P' }), ' pin clip'),
        h('span', {}, h('span', { class: 'kbd', text: 'Esc' }), ' close')));
    picker = { backdrop, panel, input, list, chips, target, filter: initialFilter || 'all', index: 0, entries: [] };

    function setFilter(k) {
      picker.filter = k; picker.index = 0;
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.k === k)));
      renderPickerList();
    }

    input.addEventListener('input', () => { picker.index = 0; renderPickerList(); });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.item');
      if (!it || !picker) return;
      const en = picker.entries[Number(it.dataset.i)];
      if (en) choose(en, e.shiftKey ? 'copy' : 'insert');
    });
    list.addEventListener('mousemove', (e) => {
      const it = e.target.closest('.item');
      if (it && picker && Number(it.dataset.i) !== picker.index) setSelected(Number(it.dataset.i));
    });
    panel.addEventListener('keydown', async (e) => {
      if (!picker) return;
      const p = picker;
      if (e.key === 'Escape') { e.preventDefault(); closePicker(true); return; }
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setSelected(p.index + 1); return; }
      if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setSelected(p.index - 1); return; }
      if (e.key === 'PageDown') { e.preventDefault(); setSelected(Math.min(p.entries.length - 1, p.index + 8)); return; }
      if (e.key === 'PageUp') { e.preventDefault(); setSelected(Math.max(0, p.index - 8)); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const i = filters.findIndex(([k]) => k === p.filter);
        setFilter(filters[(i + (e.shiftKey ? filters.length - 1 : 1)) % filters.length][0]);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const en = p.entries[p.index];
        if (en) choose(en, e.shiftKey ? 'copy' : 'insert');
        return;
      }
      if (e.altKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) {
        e.preventDefault();
        const en = p.entries[p.index];
        if (en && en.kind === 'clip') {
          const pinned = !en.item.pinned;
          en.item.pinned = pinned;
          await send({ type: 'tk:update-clip', id: en.item.id, patch: { pinned } });
          renderPickerList();
        }
      }
    });
    wrap.append(backdrop, panel);
    renderPickerList();
    setTimeout(() => input.focus(), 0);
  }

  /** Decide whether this frame should show the picker (the focused frame, or the top frame). */
  function shouldHandlePicker() {
    const focused = document.hasFocus();
    const a = document.activeElement;
    const delegating = a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME');
    if (window.top === window) return !(focused && delegating);
    return focused && !delegating;
  }

  /* ---------------- messages ---------------- */

  async function waitForFocus(ms) {
    const until = Date.now() + ms;
    while (!document.hasFocus() && Date.now() < until) await sleep(40);
  }

  function onMessage(msg, sender, sendResponse) {
    if (!alive() || !msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'tk:open-picker') {
      if (shouldHandlePicker()) openPicker(msg.filter);
      return false;
    }
    if (msg.type === 'tk:ping') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'tk:insert') {
      // From the popup: insert a snippet or clipboard item into the last focused field.
      const el = editableOf(deepActiveElement()) || (state.lastTarget && state.lastTarget.el && state.lastTarget.el.isConnected ? state.lastTarget.el : null);
      if (!el) { sendResponse({ ok: false, reason: 'no-field' }); return false; }
      const target = captureTarget(el);
      sendResponse({ ok: true });
      (async () => {
        if (!state.ready) await loadData();
        await waitForFocus(1500);
        if (msg.kind === 'snippet') {
          const snip = state.snippets.find((s) => s.id === msg.id);
          if (!snip) return;
          const res = await performInsert({ snippet: snip, target });
          if (res) send({ type: 'tk:record-use', id: snip.id, insertedLength: res.insertedLength, shortcutLength: 0 });
        } else if (typeof msg.text === 'string') {
          await performInsert({ text: msg.text, target });
        }
      })().catch((err) => console.warn('[Type Kit] insert failed', err));
      return false;
    }
    return false;
  }

  /* ---------------- wiring ---------------- */

  function destroy() {
    destroyed = true;
    closePicker(false);
    for (const c of cleanups.splice(0)) { try { c(); } catch (e) { /* ignore */ } }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* ignore */ }
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) { /* ignore */ }
    if (uiHost) uiHost.remove();
  }

  window.__typeKitInstance = { destroy };

  on(window, 'input', onInput, true);
  on(window, 'compositionend', onCompositionEnd, true);
  on(window, 'keydown', onKeyDown, true);
  on(window, 'pointerdown', onPointerDown, true);
  on(window, 'focusin', onFocusIn, true);
  on(window, 'copy', onCopyCapture, true);
  on(window, 'cut', onCopyCapture, true);
  on(window, 'copy', onCopyBubble, false);
  on(window, 'cut', onCopyBubble, false);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onMessage);
  loadData();
})();
