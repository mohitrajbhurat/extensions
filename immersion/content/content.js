/* Language Immersion - content script orchestration.
 * Decides whether to run on this page, picks a translation engine (Chrome's on-device
 * Translator API or the bundled dictionary), swaps words in, tracks sightings, and wires
 * up the hover card and selection translation. */
(function () {
  'use strict';
  if (window.top !== window || window.__limLoaded) return;
  window.__limLoaded = true;

  const LIM = globalThis.LIM, ENG = globalThis.LIMEngine, UI = globalThis.LIMUI;
  const HOST = location.hostname.replace(/^www\./, '');

  const S = {
    settings: { ...LIM.DEFAULT_SETTINGS },
    vocab: {},
    lex: null,
    dict: null,             // { en, target }
    engine: null,           // 'translator' | 'dictionary' | null
    reason: '',             // why not active
    translator: null,
    detector: null,
    spans: new Map(),       // key -> Set<span>
    perKey: new Map(),
    used: 0,
    budget: 0,
    maxTotal: 0,
    ratio: 0.02,
    seenKeys: new Set(),
    seenQueue: [],
    groups: new WeakMap(),  // original text node -> inserted nodes (for framework text updates)
    running: false,
    generation: 0,
  };
  let mo = null, io = null, pendingRoots = new Set(), mutTimer = 0, seenTimer = 0, applying = false;

  // ---------- helpers ----------
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); }
  });
  const baseLang = (l) => String(l || '').toLowerCase().split(/[-_]/)[0];

  async function loadSettings() {
    const { settings } = await chrome.storage.sync.get('settings');
    S.settings = { ...LIM.DEFAULT_SETTINGS, ...(settings || {}) };
  }
  async function loadVocab() {
    const { vocab } = await chrome.storage.local.get('vocab');
    S.vocab = vocab || {};
  }

  // English stop words used to sanity-check page language when nothing better is available.
  const EN_STOP = new Set('the of and to in is that it for was on are with as be by this have from or at not but they you his her we an were which their has had will would there what all can been one if more when'.split(' '));
  async function pageInNativeLanguage() {
    const native = S.settings.nativeLang;
    const declared = baseLang(document.documentElement.getAttribute('lang') || document.querySelector('meta[http-equiv="content-language" i]')?.content);
    const sample = (document.body ? document.body.innerText : '').slice(0, 4000);
    if (sample.trim().length < 40) return { ok: false, lang: declared, why: 'Not enough text on this page' };
    if ('LanguageDetector' in self) {
      try {
        if ((await self.LanguageDetector.availability()) === 'available') {
          S.detector = S.detector || await self.LanguageDetector.create();
          const [top] = await S.detector.detect(sample.slice(0, 2000));
          if (top && top.confidence > 0.5) return { ok: baseLang(top.detectedLanguage) === native, lang: baseLang(top.detectedLanguage), why: 'Page language does not match your native language' };
        }
      } catch (e) { /* fall through */ }
    }
    if (native === 'en') {
      const words = sample.toLowerCase().match(/[a-z]+/g) || [];
      const all = sample.match(/\p{L}+/gu) || [];
      const stop = words.filter((w) => EN_STOP.has(w)).length;
      const isEn = all.length > 0 && stop / all.length > 0.12;
      if (declared && declared !== 'en' && !isEn) return { ok: false, lang: declared, why: 'Page is not in English' };
      return { ok: isEn, lang: isEn ? 'en' : declared, why: 'Page does not look like English' };
    }
    if (declared) return { ok: declared === native, lang: declared, why: 'Page language does not match your native language' };
    return { ok: true, lang: native };
  }

  async function pickEngine() {
    const { nativeLang: src, targetLang: tgt, engine } = S.settings;
    if (src === tgt) return { engine: null, why: 'Target language is the same as your native language' };
    if (engine !== 'dictionary' && 'Translator' in self) {
      try {
        const av = await self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
        if (av === 'available') {
          S.translator = await self.Translator.create({ sourceLanguage: src, targetLanguage: tgt });
          return { engine: 'translator' };
        }
      } catch (e) { /* fall back */ }
    }
    if (src === 'en' && LIM.DICTIONARY_LANGS.includes(tgt)) return { engine: 'dictionary' };
    return { engine: null, why: `${LIM.langName(tgt)} needs Chrome's on-device translator (not available here). Bundled dictionaries cover Spanish, French and German.` };
  }

  // ---------- translation cache (Translator mode) ----------
  const memCache = new Map();
  let cacheLoaded = null, cacheDirty = false, cacheTimer = 0;
  async function cacheLoad() {
    if (!cacheLoaded) cacheLoaded = chrome.storage.local.get('translationCache').then(({ translationCache }) => {
      for (const [k, v] of Object.entries(translationCache || {})) memCache.set(k, v);
    });
    return cacheLoaded;
  }
  function cacheSave() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(async () => {
      if (!cacheDirty) return;
      cacheDirty = false;
      const { translationCache = {} } = await chrome.storage.local.get('translationCache');
      for (const [k, v] of memCache) translationCache[k] = v;
      const keys = Object.keys(translationCache);
      for (let i = 0; i < keys.length - 4000; i++) delete translationCache[keys[i]];
      chrome.storage.local.set({ translationCache });
    }, 1500);
  }
  async function translateText(text) {
    const { nativeLang: s, targetLang: t } = S.settings;
    const k = `${s}>${t}:${text}`;
    if (memCache.has(k)) return memCache.get(k);
    const out = (await S.translator.translate(text)).trim();
    memCache.set(k, out);
    cacheDirty = true;
    cacheSave();
    return out;
  }

  // ---------- learner weighting ----------
  function learnerWeight(c) {
    const e = S.vocab[LIM.wordKey(S.settings.targetLang, c.en)];
    if (!e) return 1;
    if (e.state === 'known') return S.settings.showKnown ? Math.max(0.08, 0.3 - (e.seen || 0) * 0.01) : 0;
    if (e.state === 'learning') return e.saved ? 3.2 : 2.6;
    return 1.4; // seen before, still new: reinforce
  }

  // ---------- replacement ----------
  function contextSentence(text, s, e) {
    const before = text.slice(0, s), after = text.slice(e);
    const a = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '));
    const startIdx = a >= 0 ? a + 2 : Math.max(0, s - 90);
    const m = after.search(/[.!?](\s|$)/);
    const endIdx = e + (m >= 0 ? m + 1 : Math.min(after.length, 90));
    let sent = text.slice(startIdx, endIdx).replace(/\s+/g, ' ').trim();
    if (sent.length > 220) sent = sent.slice(0, 220) + '…';
    return sent;
  }

  async function resolveTranslations(chosen) {
    if (S.engine !== 'translator') return chosen.filter((c) => c.tr);
    await cacheLoad();
    const out = [];
    const unique = new Map();
    for (const c of chosen) {
      const lemma = c.pos === 'phrase' ? c.en : c.en;
      const surface = c.plural ? c.surface.toLowerCase() : lemma;
      unique.set(lemma, null);
      unique.set(surface, null);
    }
    const keys = [...unique.keys()];
    let i = 0;
    const worker = async () => {
      while (i < keys.length) {
        const k = keys[i++];
        try { unique.set(k, await translateText(k)); } catch (e) { unique.set(k, null); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const dictTarget = S.dict && S.dict.target;
    for (const c of chosen) {
      const lemmaTr = unique.get(c.en);
      const shown = c.plural ? unique.get(c.surface.toLowerCase()) : lemmaTr;
      if (!lemmaTr || !shown) continue;
      // Skip when the "translation" is identical to the source (names, loanwords).
      if (shown.toLowerCase() === c.surface.toLowerCase()) continue;
      c.tr = lemmaTr;
      c.shown = shown;
      if (dictTarget && dictTarget.words[c.en] && Array.isArray(dictTarget.words[c.en]) && dictTarget.words[c.en][0].toLowerCase() === lemmaTr.toLowerCase()) c.g = dictTarget.words[c.en][1];
      c.source = 'ai';
      out.push(c);
    }
    return out;
  }

  function applyReplacements(chosen) {
    const lang = S.settings.targetLang;
    const byNode = new Map();
    for (const c of chosen) {
      if (!c.node.isConnected) continue;
      if (!byNode.has(c.node)) byNode.set(c.node, []);
      byNode.get(c.node).push(c);
    }
    applying = true;
    let n = 0;
    for (const [node, list] of byNode) {
      list.sort((a, b) => b.s - a.s);
      const text = node.data;
      const inserted = S.groups.get(node) || [];
      for (const c of list) {
        if (c.e > node.data.length || node.data.slice(c.s, c.e) !== c.surface) continue;
        const after = node.splitText(c.e);
        const mid = node.splitText(c.s);
        const key = LIM.wordKey(lang, c.en);
        let display = c.shown || ENG.surfaceTranslation(c, c.tr, lang);
        if (c.shown && c.upperFirst && c.sentenceStart) display = display.charAt(0).toUpperCase() + display.slice(1);
        const span = document.createElement('span');
        span.className = 'lim-w';
        span.textContent = display;
        span.setAttribute('lang', lang);
        span.setAttribute('translate', 'no');
        span.dataset.limKey = key;
        span.dataset.limOrig = c.surface;
        span.dataset.limTr = c.tr;
        span.dataset.limPos = c.pos;
        if (c.g) span.dataset.limG = c.g;
        if (c.plural) span.dataset.limPl = '1';
        span.dataset.limSrc = c.source || 'dict';
        span.dataset.limCtx = contextSentence(text, c.s, c.e);
        const e = S.vocab[key];
        span.dataset.limState = e ? e.state : 'new';
        mid.replaceWith(span);
        inserted.push(span, after);
        if (!S.spans.has(key)) S.spans.set(key, new Set());
        S.spans.get(key).add(span);
        if (io) io.observe(span);
        n++;
      }
      if (inserted.length) S.groups.set(node, inserted);
    }
    if (mo) mo.takeRecords();
    applying = false;
    S.used += n;
    return n;
  }

  async function processRoots(roots, budget) {
    const gen = S.generation;
    let nodes = [];
    for (const r of roots) nodes = nodes.concat(ENG.collectTextNodes(r));
    if (!nodes.length) return { words: 0, replaced: 0 };
    const { cands, totalWords } = ENG.findCandidates(nodes, S.lex, {
      difficulty: S.settings.difficulty, nativeLang: S.settings.nativeLang, translator: S.engine === 'translator',
    });
    if (budget == null) {
      // A small share of the page: the density setting, but never more than ~8% of words.
      budget = Math.min(S.settings.density, Math.max(2, Math.round(totalWords * 0.08)));
      S.ratio = Math.max(budget / Math.max(totalWords, 1), Math.min(0.08, S.settings.density / 1500));
    }
    let chosen = ENG.choose(cands, budget, learnerWeight, { perKey: S.perKey, maxPerKey: 2 });
    chosen = await resolveTranslations(chosen);
    if (gen !== S.generation) return { words: totalWords, replaced: 0 };
    return { words: totalWords, replaced: applyReplacements(chosen) };
  }

  // ---------- sightings ----------
  function onVisible(entries) {
    for (const ent of entries) {
      if (!ent.isIntersecting) continue;
      const span = ent.target;
      io.unobserve(span);
      const key = span.dataset.limKey;
      if (S.seenKeys.has(key)) continue;
      S.seenKeys.add(key);
      S.seenQueue.push({
        key, lang: S.settings.targetLang, en: key.slice(key.indexOf(':') + 1), tr: span.dataset.limTr,
        pos: span.dataset.limPos, g: span.dataset.limG || '', context: span.dataset.limCtx, url: location.href, source: span.dataset.limSrc,
      });
    }
    clearTimeout(seenTimer);
    if (S.seenQueue.length) seenTimer = setTimeout(flushSeen, 1500);
  }
  function flushSeen() {
    if (!S.seenQueue.length) return;
    const items = S.seenQueue.splice(0);
    send({ type: 'recordSeen', items });
  }
  addEventListener('pagehide', flushSeen);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSeen(); });

  // ---------- mutation handling (SPAs, infinite scroll, framework text updates) ----------
  function onMutations(records) {
    if (applying) return;
    for (const r of records) {
      if (r.type === 'characterData') {
        const group = S.groups.get(r.target);
        if (group) {
          // The page rewrote a text node we split: drop our inserted pieces so its text stays correct.
          applying = true;
          for (const el of group) {
            if (el.classList && el.classList.contains('lim-w')) S.spans.get(el.dataset.limKey)?.delete(el);
            el.remove();
          }
          applying = false;
          S.groups.delete(r.target);
        }
        pendingRoots.add(r.target);
      } else {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.classList.contains('lim-w') || UI.isOurs(n))) continue;
          if (n.nodeType === 1 || n.nodeType === 3) pendingRoots.add(n);
        }
      }
    }
    if (pendingRoots.size) {
      clearTimeout(mutTimer);
      mutTimer = setTimeout(processPending, 700);
    }
  }
  async function processPending() {
    const roots = [...pendingRoots].filter((n) => n.isConnected);
    pendingRoots = new Set();
    // Drop roots nested inside other roots.
    const top = roots.filter((r) => !roots.some((o) => o !== r && o.contains && o.contains(r)));
    if (!top.length || !S.running) return;
    const remaining = S.maxTotal - S.used;
    if (remaining <= 0) return;
    let words = 0;
    for (const r of top) words += ((r.textContent || '').match(/\p{L}+/gu) || []).length;
    const budget = Math.min(remaining, Math.round(words * S.ratio));
    if (budget < 1) return;
    await processRoots(top, budget);
  }

  // ---------- lifecycle ----------
  function revertAll() {
    S.generation++;
    applying = true;
    document.querySelectorAll('span.lim-w').forEach((span) => {
      const t = document.createTextNode(span.dataset.limOrig || span.textContent);
      span.replaceWith(t);
    });
    applying = false;
    if (mo) mo.takeRecords();
    S.spans.clear();
    S.perKey.clear();
    S.groups = new WeakMap();
    S.used = 0;
    S.running = false;
    UI.hide();
  }

  async function start() {
    const gen = ++S.generation;
    S.engine = null;
    S.reason = '';
    document.documentElement.dataset.limStyle = S.settings.highlight;
    if (!LIM.hostAllowed(S.settings, location.hostname)) { S.reason = S.settings.enabled ? 'Paused on this site' : 'Immersion is turned off'; return; }
    const pl = await pageInNativeLanguage();
    if (gen !== S.generation) return;
    if (!pl.ok) { S.reason = pl.why; return; }
    const pick = await pickEngine();
    if (gen !== S.generation) return;
    if (!pick.engine) { S.reason = pick.why; return; }
    S.engine = pick.engine;
    const dict = await send({ type: 'getDictionary', lang: S.settings.targetLang });
    if (gen !== S.generation) return;
    if (!dict || dict.error || !dict.en) { S.reason = 'Could not load dictionary'; S.engine = null; return; }
    S.dict = dict;
    S.lex = ENG.buildLexicon(dict.en, S.engine === 'dictionary' ? dict.target : null, S.settings.targetLang);
    await loadVocab();
    if (!io) io = new IntersectionObserver(onVisible, { threshold: 0.6 });
    S.running = true;
    const res = await processRoots([document.body], null);
    S.budget = res.replaced;
    S.maxTotal = Math.max(S.settings.density * 3, S.settings.density + 10);
    if (!mo) {
      mo = new MutationObserver(onMutations);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  async function restart() { revertAll(); await start(); }

  // ---------- hover card ----------
  let hoverTimer = 0, hoverSpan = null;
  function spanData(span) {
    const key = span.dataset.limKey;
    const e = S.vocab[key] || {};
    const lang = S.settings.targetLang;
    const tr = span.dataset.limTr;
    const plural = span.dataset.limPl === '1';
    const g = span.dataset.limG || '';
    const art = LIM.article(lang, g, tr, false);
    const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
    return {
      key, tr, art, display: plural ? span.textContent : '', en: key.slice(key.indexOf(':') + 1), pos: span.dataset.limPos, g, lang,
      nativeLang: S.settings.nativeLang, seen: e.seen || 0, state: e.state || 'new', saved: !!e.saved,
      context: span.dataset.limCtx, showingOriginal: span.classList.contains('lim-w--orig'),
      voiceMissing: voices.length > 0 && !LIM.pickVoice(lang),
    };
  }
  function itemFromSpan(span) {
    const d = spanData(span);
    return { key: d.key, lang: d.lang, en: d.en, tr: d.tr, pos: d.pos, g: d.g, context: d.context, url: location.href, source: span.dataset.limSrc };
  }
  function openWordCard(span) {
    hoverSpan = span;
    const d = spanData(span);
    UI.showWordCard(span, d, {
      speak: () => LIM.speak(span.classList.contains('lim-w--orig') ? d.tr : (span.textContent || d.tr), d.lang, S.settings.speechRate),
      known: async (btn) => {
        const r = await send({ type: 'setWordState', item: itemFromSpan(span), state: 'known' });
        if (r && r.entry) S.vocab[d.key] = r.entry;
        markSpans(d.key, 'known');
        UI.setButton(btn, `${UI.ICON.check}<span>Known</span>`, true);
        UI.toast(`Marked "${d.tr}" as known`);
      },
      save: async (btn) => {
        const r = await send({ type: 'setWordState', item: itemFromSpan(span), state: 'learning' });
        if (r && r.entry) S.vocab[d.key] = r.entry;
        markSpans(d.key, 'learning');
        UI.setButton(btn, `${UI.ICON.bookmarked}<span>Saved</span>`, true);
      },
      toggle: (btn) => {
        const orig = span.classList.toggle('lim-w--orig');
        if (orig) { span.dataset.limShown = span.textContent; span.textContent = span.dataset.limOrig; span.setAttribute('lang', S.settings.nativeLang); }
        else { span.textContent = span.dataset.limShown || d.tr; span.setAttribute('lang', d.lang); }
        btn.textContent = orig ? 'Show translation' : 'Show original';
      },
    });
  }
  function markSpans(key, state) {
    for (const s of S.spans.get(key) || []) s.dataset.limState = state;
  }
  document.addEventListener('mouseover', (e) => {
    const span = e.target.closest && e.target.closest('span.lim-w');
    if (!span) {
      if (hoverSpan && UI.cardOpen() && UI.cardAnchor() === hoverSpan && !UI.isOurs(e.target)) UI.scheduleHide();
      clearTimeout(hoverTimer);
      return;
    }
    UI.cancelHide();
    if (UI.cardOpen() && UI.cardAnchor() === span) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => openWordCard(span), 220);
  }, true);
  document.addEventListener('click', (e) => {
    const span = e.target.closest && e.target.closest('span.lim-w');
    if (span && !span.closest('a')) { clearTimeout(hoverTimer); openWordCard(span); }
    else if (!UI.isOurs(e.target) && UI.cardOpen() && !span) UI.hide();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { UI.hide(); UI.hidePill(); } }, true);
  addEventListener('scroll', () => { if (UI.cardOpen() && UI.cardAnchor()) UI.hide(); UI.hidePill(); }, { passive: true, capture: true });

  // ---------- selection translation ----------
  let selTimer = 0;
  function selectionInEditable(sel) {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return true;
    const n = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    return !!(n && n.closest && n.closest('[contenteditable]:not([contenteditable="false"])'));
  }
  function dictionaryLookup(text) {
    if (!S.lex || S.engine !== 'dictionary') return null;
    const w = text.toLowerCase().trim();
    const f = S.lex.forms.get(w);
    if (f) { const e = S.lex.entries.get(f.en); if (e && e.tr) return { en: f.en, tr: f.plural ? (LIM.targetPlural(S.settings.targetLang, e.tr) || e.tr) : e.tr, lemmaTr: e.tr, pos: f.pos, g: e.g }; }
    if (S.lex.phrases.has(w) && S.lex.phrases.get(w)) return { en: w, tr: S.lex.phrases.get(w), lemmaTr: S.lex.phrases.get(w), pos: 'phrase', g: '' };
    // Reverse lookup: a target-language word selected on the page.
    if (S.dict && S.dict.target) {
      for (const [en, v] of Object.entries(S.dict.target.words)) {
        const tr = Array.isArray(v) ? v[0] : v;
        if (tr.toLowerCase() === w) return { en, tr, lemmaTr: tr, pos: S.dict.en.words[en], g: Array.isArray(v) ? v[1] : '', reverse: true };
      }
    }
    return null;
  }
  document.addEventListener('mouseup', (e) => {
    if (UI.isOurs(e.target)) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(checkSelection, 30);
  }, true);
  document.addEventListener('keyup', (e) => { if (e.shiftKey) { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 60); } }, true);
  document.addEventListener('selectionchange', () => { const s = getSelection(); if (!s || s.isCollapsed) UI.hidePill(); });

  function checkSelection() {
    if (!S.settings.enabled || !S.settings.selectionTranslate || !LIM.hostAllowed(S.settings, location.hostname)) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return UI.hidePill();
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 1200 || !/\p{L}/u.test(text) || selectionInEditable(sel)) return UI.hidePill();
    const hasTranslator = 'Translator' in self && S.settings.engine !== 'dictionary';
    const lookup = text.split(' ').length <= 4 ? dictionaryLookup(text) : null;
    if (!hasTranslator && !lookup) return UI.hidePill();
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const full = range.getBoundingClientRect();
    UI.showPill(rect, () => translateSelection(text, full, lookup));
  }

  async function translateSelection(text, rect, lookup) {
    const { nativeLang, targetLang } = S.settings;
    let from = nativeLang, to = targetLang;
    const showLookup = () => {
      const f = lookup.reverse ? targetLang : nativeLang, t = lookup.reverse ? nativeLang : targetLang;
      const out = lookup.reverse ? lookup.en : lookup.tr;
      const card = UI.showSelectionCard(rect, { text, from: f, to: t, actions: selectionActions(text, () => out, f, t, lookup) });
      card.done(out, { canSave: true, note: 'From the offline dictionary' + (lookup.g && lookup.g !== 'x' && lookup.g !== 'pl' ? ` · ${LIM.genderLabel(lookup.g)} noun` : '') });
    };
    if (lookup && (!('Translator' in self) || S.settings.engine === 'dictionary' || !(await translatorUsable()))) return showLookup();
    // Detect the selection's language; text already in the target language is translated back.
    if ('LanguageDetector' in self) {
      try {
        if ((await self.LanguageDetector.availability()) !== 'unavailable') {
          S.detector = S.detector || await self.LanguageDetector.create();
          const [top] = await S.detector.detect(text);
          if (top && top.confidence > 0.4) {
            const d = baseLang(top.detectedLanguage);
            if (d === targetLang) { from = targetLang; to = nativeLang; } else if (d !== 'und') from = d;
          }
        }
      } catch (e) { /* keep defaults */ }
    }
    if (from === to) to = from === targetLang ? nativeLang : targetLang;
    let result = '';
    const card = UI.showSelectionCard(rect, { text, from, to, actions: selectionActions(text, () => result, from, to, null) });
    try {
      const av = await self.Translator.availability({ sourceLanguage: from, targetLanguage: to });
      if (av === 'unavailable' && lookup) return showLookup();
      if (av === 'unavailable') { card.error(`On-device translation from ${LIM.langName(from)} to ${LIM.langName(to)} isn't available in this browser.`); return; }
      const tr = await self.Translator.create({
        sourceLanguage: from, targetLanguage: to,
        monitor(m) { m.addEventListener('downloadprogress', (ev) => card.progress(ev.loaded > 1 ? ev.loaded / (ev.total || 1) : ev.loaded)); },
      });
      result = await tr.translate(text);
      try { tr.destroy(); } catch (e) { /* ignore */ }
      const words = text.split(/\s+/).length;
      card.done(result, { canSave: words <= 6 && (from === nativeLang || to === nativeLang), note: "Translated on-device with Chrome's built-in AI" });
    } catch (e) {
      if (lookup) return showLookup();
      card.error('Translation failed: ' + (e && e.message ? e.message : e));
    }
  }

  // True when the Translator API can serve native<->target now or after a model download.
  async function translatorUsable() {
    try {
      const av = await self.Translator.availability({ sourceLanguage: S.settings.nativeLang, targetLanguage: S.settings.targetLang });
      return av === 'available' || (av !== 'unavailable' && navigator.onLine);
    } catch (e) { return false; }
  }

  function selectionActions(text, getResult, from, to, lookup) {
    return {
      speak: () => LIM.speak(getResult(), to, S.settings.speechRate),
      copy: async (btn) => { try { await navigator.clipboard.writeText(getResult()); btn.querySelector('span').textContent = 'Copied'; } catch (e) { btn.querySelector('span').textContent = 'Copy failed'; } },
      save: async (btn) => {
        const target = S.settings.targetLang;
        // Store as native -> target regardless of the direction translated.
        const en = (from === target ? getResult() : (lookup ? lookup.en : text)).toLowerCase();
        const tr = from === target ? text : (lookup ? lookup.lemmaTr : getResult());
        const item = { key: LIM.wordKey(target, en), lang: target, en, tr, pos: lookup ? lookup.pos : (en.includes(' ') ? 'phrase' : ''), g: lookup ? lookup.g : '', context: '', url: location.href, source: lookup ? 'dict' : 'ai' };
        const r = await send({ type: 'setWordState', item, state: 'learning' });
        if (r && r.entry) S.vocab[item.key] = r.entry;
        UI.setButton(btn, `${UI.ICON.bookmarked}<span>Saved</span>`, true);
      },
    };
  }

  // ---------- messages & settings changes ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('lim:')) return false;
    if (msg.type === 'lim:status') {
      sendResponse({ host: HOST, engine: S.engine, running: S.running, replaced: document.querySelectorAll('span.lim-w').length,
        unique: S.spans.size, reason: S.reason, translatorApi: 'Translator' in self });
    } else if (msg.type === 'lim:rerun') {
      restart().then(() => sendResponse({ ok: true, replaced: document.querySelectorAll('span.lim-w').length }));
      return true;
    } else if (msg.type === 'lim:toggleSite') {
      toggleSite().then((on) => sendResponse({ ok: true, on }));
      return true;
    }
    return false;
  });

  async function toggleSite() {
    await loadSettings();
    const s = S.settings;
    const on = LIM.hostAllowed(s, location.hostname);
    let patch;
    if (s.siteMode === 'allowlist') patch = { enabledSites: on ? s.enabledSites.filter((h) => h !== HOST) : [...new Set([...s.enabledSites, HOST])] };
    else patch = { disabledSites: on ? [...new Set([...s.disabledSites, HOST])] : s.disabledSites.filter((h) => h !== HOST && !HOST.endsWith('.' + h)) };
    if (!s.enabled && !on) patch.enabled = true;
    await send({ type: 'patchSettings', patch });
    UI.toast(on ? `Immersion paused on ${HOST}` : `Immersion on for ${HOST}`);
    return !on;
  }

  const RESTART_KEYS = ['enabled', 'nativeLang', 'targetLang', 'difficulty', 'density', 'siteMode', 'disabledSites', 'enabledSites', 'engine', 'showKnown'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      const prev = S.settings;
      S.settings = { ...LIM.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      document.documentElement.dataset.limStyle = S.settings.highlight;
      const changed = RESTART_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(S.settings[k]));
      const wasAllowed = LIM.hostAllowed(prev, location.hostname), allowed = LIM.hostAllowed(S.settings, location.hostname);
      if (changed && (wasAllowed || allowed)) restart();
    } else if (area === 'local' && changes.vocab) {
      S.vocab = changes.vocab.newValue || {};
      for (const [key, set] of S.spans) {
        const st = (S.vocab[key] && S.vocab[key].state) || 'new';
        for (const s of set) s.dataset.limState = st;
      }
    }
  });

  // ---------- boot ----------
  async function boot() {
    await loadSettings();
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    // Give client-rendered pages a moment to put their content in.
    await new Promise((r) => setTimeout(r, 400));
    try { await start(); } catch (e) { S.reason = 'Error: ' + (e && e.message); }
  }
  boot();
})();
