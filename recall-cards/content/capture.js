// Recall Cards capture UI: quick-create flashcard dialog (and optional floating "Make flashcard" button).
// Injected on demand via activeTab (context menu, shortcut, popup) or registered on all pages when the
// user enables the floating button (optional host permission). Everything lives in a closed shadow root.
(() => {
  if (window.__recallCards) return;

  const MAX_TEXT = 8000;
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root {
    --bg: #ffffff; --bg2: #f6f5fb; --fg: #1d1b26; --muted: #6b6880; --border: #dddbe8; --accent: #7c3aed; --accent-fg: #fff;
    --accent-soft: #ede9fe; --danger: #dc2626; --focus: 0 0 0 3px rgba(124,58,237,.35); --shadow: 0 24px 64px rgba(20,10,40,.28);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--fg);
  }
  @media (prefers-color-scheme: dark) {
    .root { --bg: #1d1b26; --bg2: #262333; --fg: #ece9f6; --muted: #a29fb5; --border: #3a3650; --accent: #a78bfa; --accent-fg: #160f2a; --accent-soft: #33295a; --shadow: 0 24px 64px rgba(0,0,0,.6); }
  }
  .fab {
    position: fixed; z-index: 2147483647; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--fg); box-shadow: 0 6px 20px rgba(0,0,0,.18);
    font: 600 12px/1 system-ui, sans-serif; cursor: pointer; animation: pop .12s ease-out;
  }
  .fab:hover { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .fab:focus-visible { outline: none; box-shadow: var(--focus); }
  .fab svg { width: 14px; height: 14px; }
  @keyframes pop { from { transform: scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }
  .overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,10,30,.35); display: flex; align-items: flex-start; justify-content: center; padding: 48px 16px; overflow: auto; }
  .panel { width: min(560px, 100%); background: var(--bg); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); animation: pop .14s ease-out; }
  header { display: flex; align-items: center; gap: 8px; padding: 16px 16px 8px 24px; }
  header h2 { margin: 0; font-size: 16px; font-weight: 650; flex: 1; }
  .body { padding: 8px 24px 16px; display: grid; gap: 16px; }
  .tabs { display: inline-flex; padding: 3px; gap: 2px; background: var(--bg2); border-radius: 10px; border: 1px solid var(--border); }
  .tabs button { border: 0; background: transparent; color: var(--muted); padding: 6px 14px; border-radius: 8px; font: 600 13px system-ui, sans-serif; cursor: pointer; }
  .tabs button[aria-selected="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  label.f { display: grid; gap: 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
  textarea, input, select {
    width: 100%; font: 14px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  }
  textarea { resize: vertical; min-height: 64px; }
  textarea:focus, input:focus, select:focus, button:focus-visible { outline: none; box-shadow: var(--focus); border-color: var(--accent); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .tokens { max-height: 200px; overflow: auto; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 8px; background: var(--bg2); line-height: 2; user-select: none; }
  .tok { cursor: pointer; border-radius: 4px; padding: 1px 2px; }
  .tok:hover { background: var(--accent-soft); }
  .tok.on { background: var(--accent); color: var(--accent-fg); }
  .tok:focus-visible { outline: 2px solid var(--accent); }
  .hint { font-size: 12px; color: var(--muted); margin: 0; }
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg); cursor: pointer; }
  .check input { width: auto; }
  .source { font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; min-width: 0; }
  .source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  footer { display: flex; align-items: center; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border); }
  footer .status { flex: 1; font-size: 12px; color: var(--muted); }
  footer .status.err { color: var(--danger); }
  .btn { border: 1px solid var(--border); background: var(--bg); color: var(--fg); padding: 8px 16px; border-radius: 8px; font: 600 13px system-ui, sans-serif; cursor: pointer; }
  .btn:hover { background: var(--bg2); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn:disabled { opacity: .6; cursor: default; }
  .icon-btn { border: 0; background: transparent; color: var(--muted); width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 18px; }
  .icon-btn:hover { background: var(--bg2); color: var(--fg); }
  .kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }
  .hidden { display: none !important; }
  @media (max-width: 520px) { .row { grid-template-columns: 1fr; } }
  `;

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/><path d="M10 9v6M7 12h6"/></svg>';

  let host = null;
  let shadow = null;
  let rootEl = null;
  let fab = null;
  let dialogOpen = false;
  let floatingEnabled = false;
  let lastFocus = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('recall-cards-ui');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    rootEl = document.createElement('div');
    rootEl.className = 'root';
    shadow.append(style, rootEl);
    // Keep page shortcuts from reacting while typing in our UI.
    for (const type of ['keydown', 'keyup', 'keypress']) rootEl.addEventListener(type, e => e.stopPropagation());
    (document.body || document.documentElement).appendChild(host);
  }

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };

  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; resolve(r); });
      } catch (e) { resolve({ error: 'Extension was reloaded. Refresh this page and try again.' }); }
    });
  }

  function currentSelectionText() {
    try {
      const sel = window.getSelection();
      const t = sel ? sel.toString() : '';
      if (t.trim()) return t;
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url)$/i.test(a.type)))) return a.value.slice(a.selectionStart, a.selectionEnd);
    } catch {}
    return '';
  }

  function cleanText(t) {
    return String(t || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  }

  function tokenize(text) {
    const tokens = [];
    const re = /([\p{L}\p{N}][\p{L}\p{N}'’\-_.%$€£]*[\p{L}\p{N}%]|[\p{L}\p{N}])|([^\p{L}\p{N}]+)/gu;
    for (const m of text.matchAll(re)) tokens.push({ text: m[0], word: !!m[1] });
    return tokens;
  }

  function buildCloze(tokens, sel, separate) {
    let out = '', n = 0, i = 0;
    while (i < tokens.length) {
      if (tokens[i].word && sel.has(i)) {
        let j = i;
        while (j + 2 < tokens.length && !tokens[j + 1].word && !/\n/.test(tokens[j + 1].text) && tokens[j + 2].word && sel.has(j + 2)) j += 2;
        n++;
        out += `{{c${separate ? n : 1}::${tokens.slice(i, j + 1).map(t => t.text).join('')}}}`;
        i = j + 1;
      } else { out += tokens[i].text; i++; }
    }
    return out;
  }

  const clozeCount = text => new Set([...String(text).matchAll(CLOZE_RE)].map(m => m[1])).size;

  // ---------------- dialog ----------------
  async function openDialog({ text } = {}) {
    hideFab();
    const selected = cleanText(currentSelectionText() || text || '');
    ensureHost();
    if (dialogOpen) closeDialog();
    dialogOpen = true;
    lastFocus = document.activeElement;
    const ctx = (await send({ type: 'getCaptureContext' })) || {};
    if (ctx.error) { dialogOpen = false; alert('Recall Cards: ' + ctx.error); return; }
    const decks = ctx.decks || [];
    const settings = ctx.settings || {};
    const source = { url: location.href, title: document.title || location.hostname };

    let mode = settings.captureMode === 'cloze' && selected ? 'cloze' : 'basic';
    let separate = settings.clozeSeparate !== false;
    const tokens = tokenize(selected);
    const picked = new Set();
    let clozeEdited = false;

    const tabBasic = h('button', { role: 'tab', type: 'button' }, 'Basic');
    const tabCloze = h('button', { role: 'tab', type: 'button' }, 'Cloze');
    const front = h('textarea', { rows: 2, placeholder: 'Question or prompt, e.g. “What does FSRS stand for?”' });
    const back = h('textarea', { rows: 4, placeholder: 'Answer' });
    back.value = selected;
    const swap = h('button', { class: 'btn', type: 'button', title: 'Swap front and back' }, '⇅ Swap');
    const basicPane = h('div', { class: 'body', style: 'padding:0' },
      h('label', { class: 'f' }, 'Front', front),
      h('label', { class: 'f' }, 'Back', back),
      h('div', {}, swap));

    const tokenBox = h('div', { class: 'tokens', role: 'group', 'aria-label': 'Click words to hide them' });
    tokens.forEach((t, i) => {
      if (!t.word) { tokenBox.append(t.text); return; }
      const span = h('span', { class: 'tok', tabindex: '0', role: 'button', 'aria-pressed': 'false', 'data-i': String(i) }, t.text);
      tokenBox.append(span);
    });
    const clozeText = h('textarea', { rows: 4, placeholder: 'Text with {{c1::hidden words}}' });
    clozeText.value = selected;
    const sepBox = h('input', { type: 'checkbox' });
    sepBox.checked = separate;
    const clozeInfo = h('p', { class: 'hint' });
    const extra = h('textarea', { rows: 2, placeholder: 'Optional notes shown on the back' });
    const clozePane = h('div', { class: 'body', style: 'padding:0' },
      selected ? h('div', { style: 'display:grid;gap:8px' }, h('p', { class: 'hint' }, 'Click words to turn them into cloze deletions. Adjacent words join into one blank.'), tokenBox) : null,
      h('label', { class: 'check' }, sepBox, 'One card per blank (c1, c2, …)'),
      h('label', { class: 'f' }, 'Cloze text', clozeText),
      clozeInfo,
      h('label', { class: 'f' }, 'Extra (back)', extra));

    const deckSel = h('select', {});
    for (const d of decks) deckSel.append(h('option', { value: d.id }, d.name));
    deckSel.append(h('option', { value: '__new' }, '+ New deck…'));
    deckSel.value = decks.find(d => d.id === settings.lastDeckId) ? settings.lastDeckId : (decks[0]?.id || '__new');
    const newDeck = h('input', { type: 'text', placeholder: 'New deck name', class: 'hidden', maxlength: '120' });
    const tags = h('input', { type: 'text', placeholder: 'e.g. psychology memory', autocomplete: 'off' });
    const keepSource = h('input', { type: 'checkbox' });
    keepSource.checked = true;
    const status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save card');
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, '×');

    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New flashcard' },
      h('header', {}, h('h2', {}, 'New flashcard'), h('div', { class: 'tabs', role: 'tablist' }, tabBasic, tabCloze), closeBtn),
      h('div', { class: 'body' },
        basicPane, clozePane,
        h('div', { class: 'row' },
          h('label', { class: 'f' }, 'Deck', deckSel, newDeck),
          h('label', { class: 'f' }, 'Tags', tags)),
        h('label', { class: 'source check' }, keepSource, h('span', { title: source.url }, 'Source: ' + source.title))),
      h('footer', {}, status, cancelBtn, saveBtn));
    const overlay = h('div', { class: 'overlay' }, panel);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeDialog(); });
    rootEl.replaceChildren(overlay);

    function setMode(m) {
      mode = m;
      tabBasic.setAttribute('aria-selected', String(m === 'basic'));
      tabCloze.setAttribute('aria-selected', String(m === 'cloze'));
      basicPane.classList.toggle('hidden', m !== 'basic');
      clozePane.classList.toggle('hidden', m !== 'cloze');
      updateInfo();
      setTimeout(() => (m === 'basic' ? front : (selected ? tokenBox.querySelector('.tok') || clozeText : clozeText)).focus(), 0);
    }
    function regen() {
      if (!picked.size) { if (!clozeEdited) clozeText.value = selected; updateInfo(); return; }
      clozeText.value = buildCloze(tokens, picked, separate);
      clozeEdited = false;
      updateInfo();
    }
    function updateInfo() {
      const n = clozeCount(clozeText.value);
      clozeInfo.textContent = n ? `Creates ${n} card${n === 1 ? '' : 's'}.` : 'No blanks yet. Click words above, or type {{c1::…}} in the text.';
      saveBtn.textContent = mode === 'cloze' && n > 1 ? `Save ${n} cards` : 'Save card';
    }
    function toggleTok(span) {
      const i = Number(span.dataset.i);
      if (picked.has(i)) picked.delete(i); else picked.add(i);
      span.classList.toggle('on', picked.has(i));
      span.setAttribute('aria-pressed', String(picked.has(i)));
      regen();
    }
    tokenBox.addEventListener('click', e => { const s = e.target.closest('.tok'); if (s) toggleTok(s); });
    tokenBox.addEventListener('keydown', e => {
      const s = e.target.closest('.tok');
      if (!s || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTok(s); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const all = [...tokenBox.querySelectorAll('.tok')];
        const k = all.indexOf(s) + (e.key === 'ArrowRight' ? 1 : -1);
        if (all[k]) all[k].focus();
      }
    });
    clozeText.addEventListener('input', () => { clozeEdited = true; updateInfo(); });
    sepBox.addEventListener('change', () => { separate = sepBox.checked; if (picked.size) regen(); });
    tabBasic.addEventListener('click', () => setMode('basic'));
    tabCloze.addEventListener('click', () => setMode('cloze'));
    swap.addEventListener('click', () => { const t = front.value; front.value = back.value; back.value = t; });
    deckSel.addEventListener('change', () => { newDeck.classList.toggle('hidden', deckSel.value !== '__new'); if (deckSel.value === '__new') newDeck.focus(); });
    if (deckSel.value === '__new') newDeck.classList.remove('hidden');
    cancelBtn.addEventListener('click', closeDialog);
    closeBtn.addEventListener('click', closeDialog);
    saveBtn.addEventListener('click', save);
    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      else if (e.key === 'Tab') trapFocus(e, panel);
    });

    async function save() {
      status.className = 'status';
      const note = {
        type: mode,
        front: mode === 'cloze' ? clozeText.value.trim() : front.value.trim(),
        back: mode === 'cloze' ? extra.value.trim() : back.value.trim(),
        deckId: deckSel.value === '__new' ? null : deckSel.value,
        newDeckName: deckSel.value === '__new' ? newDeck.value.trim() : '',
        tags: [...new Set(tags.value.split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean))],
        source: keepSource.checked ? source : null,
        clozeSeparate: separate,
      };
      if (deckSel.value === '__new' && !note.newDeckName) return fail('Enter a name for the new deck.', newDeck);
      if (mode === 'basic' && !note.front) return fail(note.back ? 'Write a question on the front.' : 'The card is empty.', front);
      if (mode === 'cloze' && !clozeCount(note.front)) return fail('Add at least one blank: click a word or type {{c1::…}}.', clozeText);
      saveBtn.disabled = true;
      const r = await send({ type: 'createNote', note });
      saveBtn.disabled = false;
      if (!r || r.error) return fail(r?.error || 'Could not save. Try again.');
      status.textContent = `Saved ${r.count} card${r.count === 1 ? '' : 's'} to ${r.deckName}.`;
      saveBtn.disabled = true;
      setTimeout(closeDialog, 900);
    }
    function fail(msg, el) {
      status.className = 'status err';
      status.textContent = msg;
      if (el) el.focus();
    }

    setMode(mode);
    updateInfo();
  }

  function trapFocus(e, container) {
    const els = [...container.querySelectorAll('button, textarea, input, select, [tabindex="0"]')].filter(el => !el.disabled && el.offsetParent !== null);
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    const active = shadow.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  function closeDialog() {
    dialogOpen = false;
    if (rootEl) rootEl.replaceChildren();
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch {}
  }

  // ---------------- floating button ----------------
  let fabTimer = null;
  function hideFab() { if (fab) { fab.remove(); fab = null; } }

  function inOurUI(node) { return host && (node === host || host.contains(node)); }

  function maybeShowFab() {
    if (!floatingEnabled || dialogOpen) return hideFab();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideFab();
    const text = sel.toString().trim();
    if (text.length < 2) return hideFab();
    const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (anchor && (anchor.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') || inOurUI(anchor))) return hideFab();
    const rects = sel.getRangeAt(0).getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hideFab();
    ensureHost();
    hideFab();
    fab = h('button', { class: 'fab', type: 'button', title: 'Make flashcard from selection', html: ICON + '<span>Make flashcard</span>' });
    fab.addEventListener('mousedown', e => e.preventDefault()); // keep the selection
    fab.addEventListener('click', e => { e.preventDefault(); openDialog({ text }); });
    const top = Math.min(window.innerHeight - 40, rect.bottom + 8);
    const left = Math.min(window.innerWidth - 150, Math.max(8, rect.right - 60));
    fab.style.top = `${Math.max(8, top)}px`;
    fab.style.left = `${left}px`;
    rootEl.appendChild(fab);
  }

  function onSelectionEvent(e) {
    if (e && e.target && inOurUI(e.target)) return;
    clearTimeout(fabTimer);
    fabTimer = setTimeout(maybeShowFab, 180);
  }

  document.addEventListener('mouseup', onSelectionEvent, true);
  document.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'Shift') onSelectionEvent(e); }, true);
  document.addEventListener('selectionchange', () => { const s = window.getSelection(); if (fab && (!s || s.isCollapsed)) hideFab(); });
  window.addEventListener('scroll', hideFab, { passive: true, capture: true });

  function readFloating() {
    try {
      chrome.storage.local.get('settings', ({ settings }) => { void chrome.runtime.lastError; floatingEnabled = !!(settings && settings.floatingButton); if (!floatingEnabled) hideFab(); });
    } catch {}
  }
  readFloating();
  try {
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) readFloating(); });
  } catch {}

  window.__recallCards = { open: openDialog, close: closeDialog };
})();
