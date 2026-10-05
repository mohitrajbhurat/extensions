// Reading Studio read-aloud: speech engines, sentence highlighting, auto-scroll, resume and the mini player.
(function () {
  const RS = globalThis.RS;
  if (!RS || RS.tts) return;

  const HL_SENT = 'rs-tts-sentence';
  const HL_WORD = 'rs-tts-word';
  const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  // ================================================================ engines
  class ChromeEngine {
    constructor() { this.port = null; this.handlers = new Map(); this.seq = 0; this.onPreempt = null; }
    connect() {
      if (this.port) return this.port;
      this.port = chrome.runtime.connect({ name: 'rs-tts' });
      this.port.onMessage.addListener((msg) => {
        if (msg.type === 'preempted') { if (this.onPreempt) this.onPreempt(); return; }
        const h = this.handlers.get(msg.id);
        if (!h) return;
        if (msg.event === 'word' && h.onWord) h.onWord(msg.charIndex, msg.length);
        else if (msg.event === 'start' && h.onStart) h.onStart();
        else if (msg.event === 'end') { this.handlers.delete(msg.id); h.onEnd && h.onEnd(); }
        else if (msg.event === 'error') { this.handlers.delete(msg.id); h.onError && h.onError(msg.error || 'Speech error'); }
        else if (msg.event === 'interrupted' || msg.event === 'cancelled') this.handlers.delete(msg.id);
      });
      this.port.onDisconnect.addListener(() => {
        this.port = null;
        // Service worker restarted mid-utterance: report so the controller can retry the sentence.
        const pending = Array.from(this.handlers.values());
        this.handlers.clear();
        for (const h of pending) h.onError && h.onError('disconnected');
      });
      return this.port;
    }
    speak(text, opts, h) {
      const id = ++this.seq;
      this.handlers.set(id, h);
      try { this.connect().postMessage({ type: 'speak', id, text, opts }); } catch (e) {
        this.port = null;
        try { this.connect().postMessage({ type: 'speak', id, text, opts }); } catch (e2) { this.handlers.delete(id); h.onError && h.onError('Extension connection lost. Reload the page.'); }
      }
    }
    stop() {
      this.handlers.clear();
      try { if (this.port) this.port.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
    }
    release() { try { if (this.port) this.port.disconnect(); } catch (e) { /* ignore */ } this.port = null; }
  }

  class WebEngine {
    constructor() { this.utter = null; this.onPreempt = null; }
    speak(text, opts, h) {
      const ss = window.speechSynthesis;
      if (!ss) { h.onError && h.onError('Speech synthesis is not available'); return; }
      ss.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = opts.rate; u.pitch = opts.pitch; u.volume = opts.volume;
      if (opts.lang) u.lang = opts.lang;
      if (opts.voiceName) { const v = ss.getVoices().find((x) => x.name === opts.voiceName); if (v) u.voice = v; }
      let done = false;
      u.onboundary = (e) => { if (this.utter === u && e.name !== 'sentence' && h.onWord) h.onWord(e.charIndex, e.charLength); };
      u.onstart = () => { if (this.utter === u && h.onStart) h.onStart(); };
      u.onend = () => { if (this.utter === u && !done) { done = true; this.utter = null; h.onEnd && h.onEnd(); } };
      u.onerror = (e) => {
        if (this.utter !== u || done) return;
        done = true; this.utter = null;
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        h.onError && h.onError(e.error || 'Speech error');
      };
      this.utter = u; // keep a reference: Chrome drops events of garbage-collected utterances
      ss.speak(u);
    }
    stop() { this.utter = null; try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    release() { this.stop(); }
  }

  // Silent engine that simulates word timing. Only selectable through storage (used by automated tests).
  class MockEngine {
    constructor() { this.timer = 0; this.onPreempt = null; }
    speak(text, opts, h) {
      this.stop();
      const words = []; const re = /\S+/g; let m;
      while ((m = re.exec(text))) words.push([m.index, m[0].length]);
      let i = 0;
      const step = Math.max(5, 40 / (opts.rate || 1));
      const tick = () => {
        if (i < words.length) { h.onWord && h.onWord(words[i][0], words[i][1]); i++; this.timer = setTimeout(tick, step); }
        else { this.timer = 0; h.onEnd && h.onEnd(); }
      };
      h.onStart && h.onStart();
      this.timer = setTimeout(tick, step);
    }
    stop() { clearTimeout(this.timer); this.timer = 0; }
    release() { this.stop(); }
  }

  function makeEngine(kind) {
    if (kind === 'mock') return new MockEngine();
    if (kind === 'web' || !chrome.runtime || !chrome.runtime.connect) return new WebEngine();
    return new ChromeEngine();
  }

  // ================================================================ controller
  const T = {
    session: null,
    engine: null,
    engineKind: null,
    token: 0,
    ui: null,
    userScrollUntil: 0,
    saveTimer: 0,
    errorRetry: 0
  };

  function engine() {
    const kind = RS.settings.tts.engine || 'chrome';
    const keepFallback = T.engineKind === 'web-fallback' && kind === 'chrome';
    if (!T.engine || (T.engineKind !== kind && !keepFallback)) {
      if (T.engine) T.engine.release();
      T.engine = makeEngine(kind);
      T.engineKind = kind;
      T.engine.onPreempt = () => { if (T.session && T.session.playing) pause('Playback moved to another tab'); };
    }
    return T.engine;
  }

  function speakOpts() {
    const t = RS.settings.tts;
    return {
      rate: Math.max(0.5, Math.min(3, +t.rate || 1)),
      pitch: Math.max(0.5, Math.min(2, +t.pitch || 1)),
      volume: Math.max(0, Math.min(1, t.volume == null ? 1 : +t.volume)),
      voiceName: t.voice || undefined,
      lang: (!t.voice && T.session && T.session.lang) || undefined
    };
  }

  // ---------------------------------------------------------------- building sessions
  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!r.toString().trim() || RS.isOurUI(r.commonAncestorContainer)) return null;
    return r;
  }

  function resolveSource(src) {
    if (src && src !== 'auto') return src;
    if (RS.reader && RS.reader.isOpen()) return 'reader';
    if (selectionRange()) return 'selection';
    return 'article';
  }

  function build(source) {
    const lang = (document.documentElement.lang || navigator.language || 'en').trim();
    if (source === 'reader') {
      const r = RS.reader && RS.reader.readTarget();
      if (!r) return null;
      const { segments, paragraphs } = RS.seg.buildSegments(r.roots, { lang: r.lang || lang });
      return { source, roots: r.roots, segments, paragraphs, scroller: r.scroller, styleRoot: r.styleRoot, lang: r.lang || lang, key: RS.pageKey() };
    }
    if (source === 'selection') {
      const range = selectionRange();
      if (!range) return null;
      let root = range.commonAncestorContainer;
      if (root.nodeType !== 1) root = root.parentElement;
      const { segments, paragraphs } = RS.seg.buildSegments([root], { lang, range: range.cloneRange(), checkVisibility: true });
      return { source, roots: [root], segments, paragraphs, scroller: null, styleRoot: null, lang, key: null };
    }
    let roots = null;
    if (source === 'article') {
      try {
        const art = RS.extract(document);
        if (art.isProbablyArticle) {
          roots = art.sourceRoots.slice();
          const h1 = document.querySelector('h1');
          if (h1 && !roots.some((r) => r.contains(h1)) && (h1.compareDocumentPosition(roots[0]) & Node.DOCUMENT_POSITION_FOLLOWING)) roots.unshift(h1);
        }
      } catch (e) { console.warn('[Reading Studio] extraction failed', e); }
      if (!roots) source = 'page';
    }
    if (source === 'page') roots = [document.body];
    const { segments, paragraphs } = RS.seg.buildSegments(roots, {
      lang, checkVisibility: true,
      skipSelector: source === 'page' ? 'nav,[role="navigation"],[role="dialog"],[aria-modal="true"]' : 'nav,[role="navigation"],figure figcaption + *'
    });
    return { source, roots, segments, paragraphs, scroller: null, styleRoot: null, lang, key: RS.pageKey() };
  }

  async function start(args) {
    args = args || {};
    await RS.ready;
    const source = resolveSource(args.source || RS.settings.tts.source);
    // Opening read-aloud for the article while reader view is open reads the reader copy.
    stop({ keepUi: true, silent: true });
    const s = build(source === 'article' && RS.reader && RS.reader.isOpen() ? 'reader' : source);
    if (!s || !s.segments.length) {
      removeUi();
      RS.toast(source === 'selection' ? 'Select some text first.' : 'Nothing readable found on this page.');
      return { ok: false };
    }
    s.index = 0;
    s.playing = false;
    s.resumed = false;
    T.session = s;
    ensureHighlightStyle(s);
    if (typeof args.index === 'number') s.index = Math.max(0, Math.min(s.segments.length - 1, args.index));
    else if (s.key && !args.fromStart) {
      const r = await loadResume(s);
      if (r != null && r > 0) { s.index = r; s.resumed = true; }
    }
    renderUi();
    play();
    return { ok: true, source: s.source, total: s.segments.length, index: s.index };
  }

  // ---------------------------------------------------------------- playback
  function play() {
    const s = T.session;
    if (!s) return;
    s.playing = true;
    T.errorRetry = 0;
    speakCurrent();
  }

  function pause(message) {
    const s = T.session;
    if (!s) return;
    s.playing = false;
    T.token++;
    engine().stop();
    saveResume(true);
    updateUi(message);
  }

  function toggle() { if (!T.session) return start({}); if (T.session.playing) pause(); else play(); return { playing: T.session.playing }; }

  function stop(opts) {
    opts = opts || {};
    const s = T.session;
    T.token++;
    if (T.engine) T.engine.stop();
    if (s) { saveResume(true); s.playing = false; }
    clearHighlights();
    T.session = null;
    if (!opts.keepUi) removeUi();
    document.dispatchEvent(new CustomEvent('rs:tts-change'));
  }

  function speakCurrent() {
    const s = T.session;
    if (!s) return;
    const seg = s.segments[s.index];
    if (!seg) { finish(); return; }
    const token = ++T.token;
    highlightSentence(seg);
    updateUi();
    saveResume(false);
    engine().speak(seg.text, speakOpts(), {
      onWord: (ci, len) => { if (token === T.token && RS.settings.tts.highlightWord) highlightWord(seg, ci, len); },
      onEnd: () => {
        if (token !== T.token || !T.session || !T.session.playing) return;
        T.errorRetry = 0;
        s.index++;
        if (s.index >= s.segments.length) finish(); else speakCurrent();
      },
      onError: (err) => {
        if (token !== T.token || !T.session) return;
        if (err === 'disconnected' && T.errorRetry < 2) { T.errorRetry++; setTimeout(() => { if (token === T.token && T.session && T.session.playing) speakCurrent(); }, 150); return; }
        // chrome.tts failed entirely (no voices / engine missing): fall back to the Web Speech API once.
        if (T.engineKind === 'chrome' && T.errorRetry < 3 && window.speechSynthesis) {
          T.errorRetry = 3;
          T.engine.release();
          T.engine = new WebEngine();
          T.engineKind = 'web-fallback';
          T.engine.onPreempt = null;
          speakCurrent();
          return;
        }
        pause('Could not speak: ' + err + '. Try another voice in settings.');
      }
    });
    document.dispatchEvent(new CustomEvent('rs:tts-change'));
  }

  function finish() {
    const s = T.session;
    if (!s) return;
    s.playing = false;
    s.index = s.segments.length - 1;
    clearResume(s);
    clearHighlights();
    updateUi('Finished');
    s.finished = true;
    document.dispatchEvent(new CustomEvent('rs:tts-change'));
  }

  function jumpTo(i, autoplay) {
    const s = T.session;
    if (!s) return;
    s.index = Math.max(0, Math.min(s.segments.length - 1, i));
    s.finished = false;
    T.userScrollUntil = 0;
    if (autoplay || s.playing) { s.playing = true; speakCurrent(); }
    else { T.token++; highlightSentence(s.segments[s.index]); updateUi(); saveResume(false); }
  }
  const next = () => T.session && jumpTo(T.session.index + 1);
  const prev = () => T.session && jumpTo(T.session.index - 1);
  function nextPara() {
    const s = T.session; if (!s) return;
    const p = s.segments[s.index].para;
    let i = s.index; while (i < s.segments.length && s.segments[i].para === p) i++;
    if (i < s.segments.length) jumpTo(i);
  }
  function prevPara() {
    const s = T.session; if (!s) return;
    const p = s.segments[s.index].para;
    let i = s.index;
    while (i > 0 && s.segments[i - 1].para === p) i--;
    if (i === s.index && i > 0) { const pp = s.segments[i - 1].para; i--; while (i > 0 && s.segments[i - 1].para === pp) i--; }
    jumpTo(i);
  }

  function setRate(r) {
    r = Math.round(Math.max(0.5, Math.min(3, r)) * 100) / 100;
    RS.settings.tts.rate = r;
    RS.saveSettings({ tts: { rate: r } });
    if (T.session && T.session.playing) speakCurrent();
    updateUi();
  }

  // Rebuild after the DOM changed under us (bionic toggle, reader re-render); keeps position.
  function rebuild() {
    const s = T.session;
    if (!s || s.source === 'selection') { if (s) stop(); return; }
    const wasPlaying = s.playing;
    const idx = s.index;
    const n = build(s.source);
    if (!n || !n.segments.length) { stop(); return; }
    Object.assign(s, n, { index: Math.min(idx, n.segments.length - 1) });
    ensureHighlightStyle(s);
    if (wasPlaying) speakCurrent(); else { highlightSentence(s.segments[s.index]); updateUi(); }
  }

  // ---------------------------------------------------------------- highlight + scroll
  function ensureHighlightStyle(s) {
    if (s.styleRoot) return; // reader view ships its own highlight styles
    if (document.getElementById('rs-tts-style')) return;
    const st = document.createElement('style');
    st.id = 'rs-tts-style';
    st.setAttribute('data-rs-ui-style', '');
    st.textContent = `::highlight(${HL_SENT}){background-color:rgba(255,206,64,.38);color:inherit}
::highlight(${HL_WORD}){background-color:rgba(255,145,0,.55);color:inherit;text-decoration:underline 2px rgba(200,90,0,.9)}`;
    (document.head || document.documentElement).appendChild(st);
  }

  function clearHighlights() {
    if (!hasHighlights) return;
    CSS.highlights.delete(HL_SENT);
    CSS.highlights.delete(HL_WORD);
  }

  function highlightSentence(seg) {
    const r = RS.seg.sentenceRange(seg);
    if (hasHighlights) {
      CSS.highlights.delete(HL_WORD);
      if (r) CSS.highlights.set(HL_SENT, new Highlight(r)); else CSS.highlights.delete(HL_SENT);
    }
    if (r && RS.settings.tts.autoScroll) scrollToRange(r);
  }

  function highlightWord(seg, ci, len) {
    if (!hasHighlights) return;
    const r = RS.seg.wordRange(seg, ci, len);
    if (r) CSS.highlights.set(HL_WORD, new Highlight(r));
  }

  function scrollParent(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return null;
  }

  function scrollToRange(r) {
    if (Date.now() < T.userScrollUntil) return;
    const rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const s = T.session;
    const sc = (s && s.scroller) || scrollParent(r.startContainer);
    let top = 0, h = innerHeight;
    if (sc) { const cr = sc.getBoundingClientRect(); top = Math.max(0, cr.top); h = Math.min(innerHeight, cr.bottom) - top; }
    const relTop = rect.top - top, relBottom = rect.bottom - top;
    if (relTop >= h * 0.12 && relBottom <= h * 0.72) return;
    const delta = relTop - h * 0.3;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    T.programmaticScroll = Date.now();
    if (sc) sc.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
    else window.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
  }

  // Manual scrolling pauses auto-scroll for a few seconds.
  const markUserScroll = () => { if (T.session && T.session.playing) T.userScrollUntil = Date.now() + 6000; };
  addEventListener('wheel', markUserScroll, { passive: true, capture: true });
  addEventListener('touchmove', markUserScroll, { passive: true, capture: true });
  addEventListener('keydown', (e) => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key) && !RS.isOurUI(e.target)) markUserScroll(); }, true);

  // ---------------------------------------------------------------- click to jump
  function segmentAtPoint(target, x, y) {
    const s = T.session;
    if (!s) return -1;
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < s.segments.length; i++) {
      const seg = s.segments[i];
      if (!(seg.block === target || seg.block.contains(target) || target.contains(seg.block))) continue;
      const r = RS.seg.sentenceRange(seg);
      if (!r) continue;
      for (const rc of r.getClientRects()) {
        if (x >= rc.left - 2 && x <= rc.right + 2 && y >= rc.top - 2 && y <= rc.bottom + 2) return i;
        const dy = y < rc.top ? rc.top - y : y > rc.bottom ? y - rc.bottom : 0;
        const dx = x < rc.left ? rc.left - x : x > rc.right ? x - rc.right : 0;
        const d = dy * 3 + dx;
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    return bestDist < 60 ? best : -1;
  }

  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[contenteditable=""],[contenteditable="true"],[role="button"],[role="link"],video,audio';

  // Called by page clicks and by the reader (which passes its shadow-DOM target).
  function handleClick(e, target) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return false;
    target = target || e.target;
    if (!target || target.nodeType !== 1 || target.closest(INTERACTIVE)) return false;
    const sel = (target.getRootNode && target.getRootNode().getSelection) ? target.getRootNode().getSelection() : window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return false;
    if (!T.session) return false;
    const i = segmentAtPoint(target, e.clientX, e.clientY);
    if (i < 0) return false;
    jumpTo(i, true);
    return true;
  }

  document.addEventListener('click', (e) => {
    if (!T.session || T.session.source === 'reader') return;
    if (RS.isOurUI(e.target)) return;
    handleClick(e);
  }, true);

  // Alt+click on page text starts reading from there.
  document.addEventListener('click', async (e) => {
    if (!e.altKey || T.session || RS.isOurUI(e.target) || e.target.closest(INTERACTIVE)) return;
    if (!RS.fullLoaded) return;
    e.preventDefault();
    const res = await start({ source: 'article', index: 0 });
    if (!res.ok) return;
    let i = segmentAtPoint(e.target, e.clientX, e.clientY);
    if (i < 0) { await stop(); await start({ source: 'page', index: 0 }); i = segmentAtPoint(e.target, e.clientX, e.clientY); }
    if (i >= 0) jumpTo(i, true);
  }, true);

  // ---------------------------------------------------------------- resume
  async function loadResume(s) {
    try {
      const { resume } = await chrome.storage.local.get('resume');
      const r = resume && resume[s.key];
      if (!r || r.src !== s.source) return null;
      // Match by sentence signature near the saved index (content may have shifted a bit).
      const sig = (t) => t.slice(0, 48);
      for (let d = 0; d <= 20; d++) {
        for (const i of [r.i + d, r.i - d]) {
          if (i >= 0 && i < s.segments.length && sig(s.segments[i].text) === r.sig) return i;
        }
      }
      return null;
    } catch (e) { return null; }
  }

  function saveResume(now) {
    const s = T.session;
    if (!s || !s.key || s.source === 'selection') return;
    clearTimeout(T.saveTimer);
    const write = async () => {
      try {
        const { resume = {} } = await chrome.storage.local.get('resume');
        const seg = s.segments[s.index];
        if (!seg) return;
        if (s.index === 0) delete resume[s.key];
        else resume[s.key] = { i: s.index, n: s.segments.length, sig: seg.text.slice(0, 48), src: s.source, t: Date.now(), title: document.title.slice(0, 120) };
        const keys = Object.keys(resume);
        if (keys.length > 300) keys.sort((a, b) => resume[a].t - resume[b].t).slice(0, keys.length - 300).forEach((k) => delete resume[k]);
        await chrome.storage.local.set({ resume });
      } catch (e) { /* storage unavailable */ }
    };
    if (now) write(); else T.saveTimer = setTimeout(write, 1500);
  }

  async function clearResume(s) {
    if (!s.key) return;
    try { const { resume = {} } = await chrome.storage.local.get('resume'); delete resume[s.key]; await chrome.storage.local.set({ resume }); } catch (e) { /* ignore */ }
  }

  // ================================================================ mini player
  function playerCss() {
    return `
:host{all:initial}
*{box-sizing:border-box}
.p{--bg:rgba(250,250,252,.97);--fg:#1c1c22;--muted:#5d6070;--line:rgba(0,0,0,.1);--btn:rgba(0,0,0,.05);--btn-h:rgba(0,0,0,.1);--acc:#5b4bdb;--acc-fg:#fff;--track:rgba(0,0,0,.12);
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--fg);background:var(--bg);
  border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.1);
  width:min(392px,calc(100vw - 24px));padding:8px 10px 10px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);user-select:none}
@media (prefers-color-scheme:dark){.p{--bg:rgba(32,33,40,.97);--fg:#eceef4;--muted:#a3a7b7;--line:rgba(255,255,255,.12);--btn:rgba(255,255,255,.07);--btn-h:rgba(255,255,255,.14);--acc:#8c7dff;--acc-fg:#14121f;--track:rgba(255,255,255,.16)}}
.row{display:flex;align-items:center;gap:4px}
.grip{width:18px;height:32px;display:grid;place-items:center;color:var(--muted);cursor:grab;flex:none;border-radius:6px}
.grip:active{cursor:grabbing}
.grip svg{width:16px;height:16px}
button{all:unset;box-sizing:border-box;display:inline-grid;place-items:center;height:32px;min-width:32px;padding:0 6px;border-radius:9px;color:var(--fg);cursor:pointer;font:inherit;background:transparent}
button:hover{background:var(--btn-h)}
button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
button svg{width:18px;height:18px}
.play{width:40px;height:40px;border-radius:50%;background:var(--acc);color:var(--acc-fg);margin:0 2px}
.play:hover{background:var(--acc);filter:brightness(1.08)}
.play svg{width:20px;height:20px}
.speed{font-weight:650;font-variant-numeric:tabular-nums;min-width:48px;background:var(--btn)}
.spacer{flex:1}
.close svg,.gear svg{width:16px;height:16px}
.info{display:flex;justify-content:space-between;color:var(--muted);font-size:11.5px;margin:6px 2px 4px;font-variant-numeric:tabular-nums;gap:8px}
.info .src{text-transform:capitalize}
.bar{position:relative;height:6px;border-radius:3px;background:var(--track);cursor:pointer;margin:0 2px}
.bar .fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--acc);width:0}
.bar:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.msg{margin-top:8px;padding:6px 8px;border-radius:8px;background:var(--btn);color:var(--fg);font-size:12px;display:flex;align-items:center;gap:8px}
.msg[hidden]{display:none}
.msg button{height:24px;padding:0 8px;font-weight:600;color:var(--acc);background:transparent}
.pop{margin-top:8px;padding:10px;border-radius:10px;background:var(--btn);display:grid;gap:10px}
.pop[hidden]{display:none}
.pop label{display:grid;gap:4px;font-size:12px;color:var(--muted)}
.pop .inline{display:flex;align-items:center;gap:8px;color:var(--fg)}
select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;width:100%}
select:focus-visible,input:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
input[type=range]{width:100%;accent-color:var(--acc)}
.presets{display:flex;gap:4px;flex-wrap:wrap}
.presets button{height:26px;font-size:12px;background:var(--bg);border:1px solid var(--line)}
.presets button[aria-pressed=true]{background:var(--acc);color:var(--acc-fg);border-color:transparent}
.hint{font-size:11px;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.p{animation:pin .2s ease-out}@keyframes pin{from{opacity:0;transform:translateY(8px)}}}
`;
  }

  function renderUi() {
    if (T.ui && T.ui.host.isConnected) { updateUi(); return; }
    const { host, root } = RS.createHost('rs-player', 2147483646);
    const pos = RS.settings.player || {};
    placeHost(host, pos.x, pos.y);
    const I = RS.icons;
    root.innerHTML = `<style>${playerCss()}</style>
<div class="p" role="region" aria-label="Reading Studio player">
  <div class="row">
    <div class="grip" title="Drag to move">${I.grip}</div>
    <button class="pprev" title="Previous paragraph" aria-label="Previous paragraph">${I.paraPrev}</button>
    <button class="prev" title="Previous sentence" aria-label="Previous sentence">${I.prev}</button>
    <button class="play" title="Play" aria-label="Play">${I.play}</button>
    <button class="next" title="Next sentence" aria-label="Next sentence">${I.next}</button>
    <button class="pnext" title="Next paragraph" aria-label="Next paragraph">${I.paraNext}</button>
    <span class="spacer"></span>
    <button class="speed" title="Speed" aria-label="Playback speed" aria-expanded="false">1×</button>
    <button class="gear" title="Voice and options" aria-label="Voice and options" aria-expanded="false">${I.gear}</button>
    <button class="close" title="Stop and close" aria-label="Stop and close">${I.close}</button>
  </div>
  <div class="info"><span class="pos">–</span><span class="src"></span><span class="left"></span></div>
  <div class="bar" role="slider" tabindex="0" aria-label="Position" aria-valuemin="1"><div class="fill"></div></div>
  <div class="msg" hidden><span class="mtext"></span><span class="spacer"></span><button class="restart" hidden>Start over</button></div>
  <div class="pop speedpop" hidden>
    <label>Speed <span class="inline"><input type="range" class="rate" min="0.5" max="3" step="0.05" aria-label="Speed"><b class="rateval"></b></span></label>
    <div class="presets"></div>
  </div>
  <div class="pop gearpop" hidden>
    <label>Voice <select class="voice" aria-label="Voice"><option value="">Browser default</option></select></label>
    <label class="inline"><input type="checkbox" class="word"> Highlight each word</label>
    <label class="inline"><input type="checkbox" class="scroll"> Auto-scroll to the spoken sentence</label>
    <div class="hint">Click any sentence to jump there. Alt+click page text to start reading from it.</div>
  </div>
</div>`;
    const $ = (s) => root.querySelector(s);
    T.ui = { host, root, $ };
    $('.play').addEventListener('click', () => { if (T.session && T.session.finished) jumpTo(0, true); else toggle(); });
    $('.prev').addEventListener('click', prev);
    $('.next').addEventListener('click', next);
    $('.pprev').addEventListener('click', prevPara);
    $('.pnext').addEventListener('click', nextPara);
    $('.close').addEventListener('click', () => stop());
    $('.restart').addEventListener('click', () => { if (T.session) { T.session.resumed = false; jumpTo(0, true); } });
    const togglePop = (btn, pop) => {
      const open = pop.hidden;
      for (const p of root.querySelectorAll('.pop')) p.hidden = true;
      for (const b of root.querySelectorAll('[aria-expanded]')) b.setAttribute('aria-expanded', 'false');
      pop.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      if (open && pop.classList.contains('gearpop')) loadVoices();
    };
    $('.speed').addEventListener('click', () => togglePop($('.speed'), $('.speedpop')));
    $('.gear').addEventListener('click', () => togglePop($('.gear'), $('.gearpop')));
    const presets = $('.presets');
    for (const v of [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const b = document.createElement('button'); b.textContent = v + '×'; b.dataset.v = v;
      b.addEventListener('click', () => setRate(v)); presets.appendChild(b);
    }
    $('.rate').addEventListener('input', (e) => { $('.rateval').textContent = (+e.target.value).toFixed(2).replace(/0$/, '') + '×'; });
    $('.rate').addEventListener('change', (e) => setRate(+e.target.value));
    $('.voice').addEventListener('change', (e) => { RS.settings.tts.voice = e.target.value; RS.saveSettings({ tts: { voice: e.target.value } }); if (T.session && T.session.playing) speakCurrent(); });
    $('.word').addEventListener('change', (e) => { RS.saveSettings({ tts: { highlightWord: e.target.checked } }); if (!e.target.checked && hasHighlights) CSS.highlights.delete(HL_WORD); });
    $('.scroll').addEventListener('change', (e) => RS.saveSettings({ tts: { autoScroll: e.target.checked } }));
    const bar = $('.bar');
    bar.addEventListener('click', (e) => {
      if (!T.session) return;
      const r = bar.getBoundingClientRect();
      jumpTo(Math.floor(((e.clientX - r.left) / r.width) * T.session.segments.length));
    });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { for (const p of root.querySelectorAll('.pop')) p.hidden = true; }
      else if (e.key === ' ' && e.target === bar) { toggle(); e.preventDefault(); }
    });
    makeDraggable(host, $('.grip'));
    updateUi();
  }

  function placeHost(host, x, y) {
    const set = (k, v) => host.style.setProperty(k, v, 'important');
    if (typeof x === 'number' && typeof y === 'number') {
      set('left', Math.max(4, Math.min(innerWidth - 120, x)) + 'px');
      set('top', Math.max(4, Math.min(innerHeight - 60, y)) + 'px');
      set('right', 'auto'); set('bottom', 'auto');
    } else { set('right', '16px'); set('bottom', '16px'); set('left', 'auto'); set('top', 'auto'); }
  }

  function makeDraggable(host, grip) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    grip.addEventListener('pointerdown', (e) => {
      dragging = true; grip.setPointerCapture(e.pointerId);
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => { if (dragging) placeHost(host, ox + e.clientX - sx, oy + e.clientY - sy); });
    grip.addEventListener('pointerup', () => {
      if (!dragging) return; dragging = false;
      const r = host.getBoundingClientRect();
      RS.saveSettings({ player: { x: Math.round(r.left), y: Math.round(r.top) } });
    });
    grip.addEventListener('dblclick', () => { placeHost(host, null, null); RS.saveSettings({ player: { x: null, y: null } }); });
  }

  async function loadVoices() {
    if (!T.ui) return;
    const sel = T.ui.$('.voice');
    let voices = [];
    try {
      if (T.engineKind === 'web' || T.engineKind === 'web-fallback') voices = (speechSynthesis.getVoices() || []).map((v) => ({ voiceName: v.name, lang: v.lang, remote: !v.localService }));
      else { const res = await chrome.runtime.sendMessage({ type: 'get-voices' }); voices = (res && res.voices) || []; }
    } catch (e) { /* ignore */ }
    const cur = RS.settings.tts.voice || '';
    sel.textContent = '';
    sel.appendChild(new Option('Browser default', ''));
    const lang = ((T.session && T.session.lang) || navigator.language || 'en').slice(0, 2).toLowerCase();
    voices.sort((a, b) => {
      const am = (a.lang || '').toLowerCase().startsWith(lang) ? 0 : 1, bm = (b.lang || '').toLowerCase().startsWith(lang) ? 0 : 1;
      return am - bm || String(a.voiceName).localeCompare(String(b.voiceName));
    });
    for (const v of voices) {
      const o = new Option(`${v.voiceName}${v.lang ? ' (' + v.lang + ')' : ''}${v.remote ? ' · online' : ''}`, v.voiceName);
      sel.appendChild(o);
    }
    sel.value = cur;
  }

  function fmtLeft(s) {
    let chars = 0;
    for (let i = s.index; i < s.segments.length; i++) chars += s.segments[i].text.length;
    const secs = chars / (14.5 * (RS.settings.tts.rate || 1));
    if (secs < 60) return `${Math.max(1, Math.round(secs))} sec left`;
    return `${Math.round(secs / 60)} min left`;
  }

  function updateUi(message) {
    if (!T.ui) return;
    const { $ } = T.ui;
    const s = T.session;
    const playing = !!(s && s.playing);
    const pb = $('.play');
    pb.innerHTML = playing ? RS.icons.pause : RS.icons.play;
    pb.title = playing ? 'Pause' : 'Play'; pb.setAttribute('aria-label', pb.title);
    const rate = RS.settings.tts.rate || 1;
    $('.speed').textContent = (Math.round(rate * 100) / 100) + '×';
    $('.rate').value = rate; $('.rateval').textContent = (Math.round(rate * 100) / 100) + '×';
    for (const b of T.ui.root.querySelectorAll('.presets button')) b.setAttribute('aria-pressed', String(+b.dataset.v === +rate));
    $('.word').checked = !!RS.settings.tts.highlightWord;
    $('.scroll').checked = !!RS.settings.tts.autoScroll;
    if (s) {
      const n = s.segments.length;
      $('.pos').textContent = `${Math.min(s.index + 1, n)} / ${n}`;
      $('.src').textContent = s.source === 'reader' ? 'Reader' : s.source;
      $('.left').textContent = s.finished ? 'Done' : fmtLeft(s);
      $('.fill').style.width = (n ? ((s.finished ? n : s.index) / n) * 100 : 0) + '%';
      const bar = $('.bar'); bar.setAttribute('aria-valuemax', String(n)); bar.setAttribute('aria-valuenow', String(s.index + 1));
    }
    const msg = $('.msg');
    if (message) { msg.hidden = false; $('.mtext').textContent = message; $('.restart').hidden = message !== 'Finished'; if (message === 'Finished') $('.restart').textContent = 'Play again'; }
    else if (s && s.resumed && s.index > 0) { msg.hidden = false; $('.mtext').textContent = 'Resumed where you left off.'; $('.restart').hidden = false; $('.restart').textContent = 'Start over'; }
    else msg.hidden = true;
  }

  function removeUi() { if (T.ui) T.ui.host.remove(); T.ui = null; }

  RS.onSettings((s, changed) => {
    if (changed.has('tts') && T.engine && T.engineKind !== (s.tts.engine || 'chrome') && T.engineKind !== 'web-fallback') {
      const wasPlaying = T.session && T.session.playing;
      if (wasPlaying) { T.token++; T.engine.stop(); }
      engine();
      if (wasPlaying) speakCurrent();
    }
    if (changed.has('tts')) updateUi();
  });

  document.addEventListener('rs:bionic-change', () => { if (T.session) rebuild(); });
  addEventListener('pagehide', () => { if (T.session) saveResume(true); if (T.engine) T.engine.stop(); });

  // ================================================================ API
  function state() {
    const s = T.session;
    return s ? { active: true, playing: !!s.playing, index: s.index, total: s.segments.length, source: s.source, finished: !!s.finished } : { active: false, playing: false };
  }

  RS.tts = { start, play, pause, toggle, stop, next, prev, nextPara, prevPara, jumpTo, setRate, rebuild, state, handleClick, get session() { return T.session; } };

  RS.handlers['tts-start'] = (a) => start(a);
  RS.handlers['tts-toggle'] = async (a) => { if (T.session && !T.session.finished) { toggle(); return state(); } if (T.session) { jumpTo(0, true); return state(); } await start(a || {}); return state(); };
  RS.handlers['tts-stop'] = async () => { stop(); return state(); };
  RS.handlers['tts-state'] = async () => state();
  RS.handlers['tts-control'] = async (a) => {
    const fn = { next, prev, nextPara, prevPara, play, pause }[a.cmd];
    if (fn) fn();
    if (a.cmd === 'rate' && typeof a.value === 'number') setRate(a.value);
    if (a.cmd === 'jump' && typeof a.index === 'number') jumpTo(a.index, true);
    return state();
  };
})();
