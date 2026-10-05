/* Language Immersion - replacement engine.
 * Finds replaceable words and phrases in a page's text nodes and picks a well-spread,
 * learner-weighted subset. Has no knowledge of storage or UI; content.js drives it. */
(function () {
  'use strict';
  if (globalThis.LIMEngine) return;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE',
    'KBD', 'SAMP', 'VAR', 'TT', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'TITLE', 'HEAD',
    'TEMPLATE', 'AUDIO', 'VIDEO', 'LIM-UI', 'ABBR', 'TIME', 'DATALIST', 'METER', 'PROGRESS']);
  const SKIP_SELECTOR = [
    '[contenteditable]:not([contenteditable="false"])', '[translate="no"]', '.notranslate', '[role="textbox"]',
    '[role="code"]', '[role="combobox"]', '[role="searchbox"]', '[role="button"]', '[aria-hidden="true"]',
    '.CodeMirror', '.cm-editor', '.monaco-editor', '.ace_editor', '.hljs', '.highlight', '.blob-code',
    '.code', '.lim-w', '[data-lim-skip]',
  ].join(',');

  // Words too ambiguous (several unrelated senses) for context-free single-word replacement.
  const AMBIGUOUS = new Set(('kind right light back watch lie rest mind fine last mean fair left like well still ' +
    'point close matter order state case lot sort bit bear fly ring sink park train play show second date match ' +
    'fit tip pass set free spare lead tear wind wave figure bill cold grade iron sound square type store mark sign ' +
    'kid guy present even just long hard fast mad plain raw rough fancy record permit spring fall miss act deal ' +
    'be have do get make let go say see come take give use seem tell call try keep become put cut hit run turn ' +
    'pick pack land face check stand lay hang ' +
    'major minor senior junior native chief current double single total general').split(' '));

  // Words common as both noun and verb: replaced only when the preceding word tells us which one it is.
  const NOUN_VERB = new Set(('work change study need care control plan support love step test practice report view ' +
    'form end head hand place question answer rain snow fish drink smile laugh kiss dream fear hope trust respect ' +
    'cook judge vote dance visit return travel offer search order share promise attack fight escape increase ' +
    'decrease request demand delay damage joke kick load limit smell taste rent cause design drop hug walk talk ' +
    'help wish cost rule shape trade dress cross plant wait start finish experience interest film picture water ' +
    'phone email paint copy print time book name rate effort price result experience program issue tax value ' +
    'figure position paper space ground event center project stop doubt walk ride shop surprise wonder smoke ' +
    'notice reply review rescue whistle wink yell cheer cough sneeze crash crawl delete download upload ' +
    'brush blow bite bend bake joke nod trip ice fire color heat milk salt sugar oil iron dust').split(' '));

  const VERB_CUES = new Set(('i you we they he she it to will would can could should must may might shall ' +
    "don't doesn't didn't won't can't couldn't wouldn't shouldn't let's please not never always often also " +
    'usually sometimes really just still who that').split(' '));
  const NOUN_CUES = new Set(('the a an this that these those my your our his her their its every each some any no ' +
    'of in on at for with from by about into over under after before between through during without against ' +
    'among around near behind above across along toward many few more most several one two three').split(' '));

  // Words that are legitimately capitalized mid-sentence in English.
  const CAP_OK = new Set(('january february april june july august september october november december monday ' +
    'tuesday wednesday thursday friday saturday sunday english spanish french german').split(' '));

  const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'these', 'those', 'every', 'each', 'some']);
  const ELIGIBLE_POS = {
    beginner: { n: 1 },
    intermediate: { n: 1, v: 2.2, adj: 2.2, adv: 1.6 },
    advanced: { n: 1, v: 1.6, adj: 1.6, adv: 1.4, num: 0.6, phrase: 3 },
  };

  /** Build lookup tables from en.json (POS) and the target dictionary (may be null in Translator-only mode). */
  function buildLexicon(enData, targetData, lang) {
    const L = globalThis.LIM;
    const forms = new Map(); // surface form (lowercase) -> { en, pos, plural }
    const entries = new Map(); // en -> { tr, g, pos }
    for (const [en, pos] of Object.entries(enData.words)) {
      let tr = null, g = '';
      if (targetData) {
        const v = targetData.words[en];
        if (!v) continue;
        if (Array.isArray(v)) { tr = v[0]; g = v[1]; } else tr = v;
      }
      entries.set(en, { tr, g, pos });
      if (!forms.has(en)) forms.set(en, { en, pos, plural: false });
      if (pos === 'n') {
        const pl = L.englishPlural(en);
        // A plural form is usable only when we can inflect the target (or a translator will).
        if (pl && pl !== en && !forms.has(pl) && (!targetData || (g !== 'x' && g !== 'pl' && L.targetPlural(lang, tr)))) {
          forms.set(pl, { en, pos, plural: true });
        }
      }
    }
    const phrases = [];
    const phraseSource = targetData ? targetData.phrases : Object.fromEntries((enData.phrases || []).map((p) => [p, null]));
    for (const [en, tr] of Object.entries(phraseSource || {})) phrases.push({ en, tr });
    phrases.sort((a, b) => b.en.length - a.en.length);
    const phraseRe = phrases.length
      ? new RegExp('(?<![\\p{L}\'])(' + phrases.map((p) => p.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\p{L}])', 'giu')
      : null;
    return { lang, forms, entries, phrases: new Map(phrases.map((p) => [p.en, p.tr])), phraseRe, hasDictionary: !!targetData };
  }

  /** Is this text node a candidate for replacement? Results cached per parent element. */
  function makeNodeFilter() {
    const cache = new WeakMap();
    return function accept(node) {
      const el = node.parentElement;
      if (!el) return false;
      let ok = cache.get(el);
      if (ok === undefined) {
        ok = true;
        for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
          if (SKIP_TAGS.has(p.tagName) || p.isContentEditable) { ok = false; break; }
        }
        if (ok && el.closest(SKIP_SELECTOR)) ok = false;
        cache.set(el, ok);
      }
      return ok;
    };
  }

  function collectTextNodes(root, opts) {
    const maxNodes = (opts && opts.maxNodes) || 6000;
    const accept = makeNodeFilter();
    const out = [];
    if (!root) return out;
    if (root.nodeType === Node.TEXT_NODE) {
      if (/\p{L}{2}/u.test(root.data) && accept(root)) out.push(root);
      return out;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.data.length < 2 || !/\p{L}{2}/u.test(n.data)) return NodeFilter.FILTER_REJECT;
        return accept(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && out.length < maxNodes) out.push(n);
    return out;
  }

  function isSentenceStart(text, idx) {
    for (let i = idx - 1; i >= 0; i--) {
      const c = text[i];
      if (/[\s"'“‘(«\-–—]/.test(c)) continue;
      return /[.!?:;…]/.test(c);
    }
    return true; // start of the text node: assume a new sentence/block
  }

  const WORD_RE_EN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  const WORD_RE_ANY = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

  /**
   * Find candidate occurrences in a list of text nodes.
   * opts: { difficulty, nativeLang, translator (bool), vocabState: (key) => entry|undefined, wordKey }
   * Returns { cands, totalWords }.
   */
  function findCandidates(nodes, lex, opts) {
    const allowed = ELIGIBLE_POS[opts.difficulty] || ELIGIBLE_POS.beginner;
    const english = opts.nativeLang === 'en';
    const cands = [];
    let totalWords = 0;
    for (const node of nodes) {
      const text = node.data;
      const norm = text.replace(/’/g, "'");
      const taken = [];
      const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);

      // 1) Phrases (advanced only)
      if (allowed.phrase && english && lex.phraseRe) {
        lex.phraseRe.lastIndex = 0;
        let m;
        while ((m = lex.phraseRe.exec(norm))) {
          const en = m[0].toLowerCase();
          if (!lex.phrases.has(en)) continue;
          const s = m.index, e = s + m[0].length;
          if (overlaps(s, e)) continue;
          taken.push([s, e]);
          cands.push(makeCand(node, s, e, m[0], en, 'phrase', false, lex.phrases.get(en), '', allowed.phrase, text));
        }
      }

      // 2) Words, and Translator-mode noun chunks
      const re = english ? WORD_RE_EN : WORD_RE_ANY;
      re.lastIndex = 0;
      const toks = [];
      let m;
      while ((m = re.exec(text))) {
        toks.push({ s: m.index, e: m.index + m[0].length, w: m[0] });
      }
      totalWords += toks.length;

      if (english && opts.translator && allowed.phrase) {
        // determiner + (adjective) + noun, e.g. "the old house" -> context-aware chunk translation
        for (let i = 0; i < toks.length - 1; i++) {
          const t0 = toks[i];
          if (!DETERMINERS.has(t0.w.toLowerCase())) continue;
          let j = i + 1;
          const f1 = lex.forms.get(toks[j].w.toLowerCase());
          if (f1 && f1.pos === 'adj' && j + 1 < toks.length) j++;
          const fn = lex.forms.get(toks[j].w.toLowerCase());
          if (!fn || fn.pos !== 'n') continue;
          if (!/^\s+$/.test(text.slice(t0.e, toks[i + 1].s)) || (j > i + 1 && !/^\s+$/.test(text.slice(toks[i + 1].e, toks[j].s)))) continue;
          if (/[A-Z]/.test(toks[j].w[0]) && !isSentenceStart(text, t0.s)) continue;
          const s = t0.s, e = toks[j].e;
          if (overlaps(s, e) || Math.random() > 0.5) continue;
          taken.push([s, e]);
          const surface = text.slice(s, e);
          cands.push(makeCand(node, s, e, surface, surface.toLowerCase().replace(/\s+/g, ' '), 'phrase', false, null, '', allowed.phrase, text));
          i = j;
        }
      }

      for (let ti = 0; ti < toks.length; ti++) {
        const t = toks[ti];
        if (overlaps(t.s, t.e)) continue;
        const w = t.w;
        if (w.length < 2 || /['’]/.test(w)) continue;
        const lower = w.toLowerCase();
        const upperFirst = w[0] !== w[0].toLowerCase();
        if (w.length > 1 && w === w.toUpperCase()) continue; // acronyms / shouting
        const sentenceStart = isSentenceStart(text, t.s);
        if (english) {
          const f = lex.forms.get(lower);
          if (!f) continue;
          const weight = allowed[f.pos];
          if (!weight || AMBIGUOUS.has(f.en)) continue;
          if (upperFirst && !sentenceStart && !CAP_OK.has(f.en)) continue; // probably a name or title
          if (!contextOk(f, prevWord(text, toks, ti), lex)) continue;
          const entry = lex.entries.get(f.en);
          if (lex.hasDictionary && (!entry || !entry.tr)) continue;
          cands.push(makeCand(node, t.s, t.e, w, f.en, f.pos, f.plural, entry && entry.tr, entry && entry.g, weight, text, sentenceStart));
        } else if (opts.translator) {
          // Non-English native language: no POS data; prefer longer lowercase content words.
          if (upperFirst && !sentenceStart) continue;
          if (lower.length < (opts.difficulty === 'beginner' ? 5 : 4)) continue;
          cands.push(makeCand(node, t.s, t.e, w, lower, 'word', false, null, '', 1, text, sentenceStart));
        }
      }
    }
    return { cands, totalWords };
  }

  function prevWord(text, toks, i) {
    if (i === 0) return null;
    const p = toks[i - 1];
    // Only an adjacent word (separated by plain spaces) is a reliable cue.
    if (!/^[ \u00a0]+$/.test(text.slice(p.e, toks[i].s))) return null;
    return p.w.toLowerCase().replace(/’/g, "'");
  }

  function contextOk(f, prev, lex) {
    const prevForm = prev ? lex.forms.get(prev) : null;
    const prevIsAdj = !!prevForm && prevForm.pos === 'adj' && !NOUN_CUES.has(prev);
    if (f.pos === 'n') {
      if (prev && VERB_CUES.has(prev) && !NOUN_CUES.has(prev)) return false; // "to work", "they work"
      if (NOUN_VERB.has(f.en) && !f.plural) return !!prev && (NOUN_CUES.has(prev) || prevIsAdj);
      return true;
    }
    if (f.pos === 'v') {
      if (prev && (NOUN_CUES.has(prev) && !VERB_CUES.has(prev) || prevIsAdj)) return false; // "the visit"
      if (NOUN_VERB.has(f.en)) return !!prev && VERB_CUES.has(prev);
      return true;
    }
    return true;
  }

  function makeCand(node, s, e, surface, en, pos, plural, tr, g, weight, text, sentenceStart) {
    return { node, s, e, surface, en, pos, plural, tr: tr || null, g: g || '', weight,
      upperFirst: surface[0] !== surface[0].toLowerCase(), sentenceStart: sentenceStart !== false && isSentenceStart(text, s) };
  }

  /**
   * Choose up to `budget` occurrences spread through the document.
   * learnerWeight(cand) adjusts by vocabulary state; returning 0 excludes the candidate.
   */
  function choose(cands, budget, learnerWeight, opts) {
    const maxPerKey = (opts && opts.maxPerKey) || 2;
    const perKey = (opts && opts.perKey) || new Map();
    if (!cands.length || budget <= 0) return [];
    const scored = [];
    for (const c of cands) {
      const w = c.weight * learnerWeight(c);
      if (w > 0) scored.push({ c, w });
    }
    if (!scored.length) return [];
    const buckets = Math.min(budget, scored.length);
    const size = scored.length / buckets;
    const chosen = [];
    for (let b = 0; b < buckets; b++) {
      const slice = scored.slice(Math.floor(b * size), Math.floor((b + 1) * size));
      let best = null, bestScore = -1;
      for (const item of slice) {
        const used = perKey.get(item.c.en) || 0;
        if (used >= maxPerKey) continue;
        // Prefer variety: later sightings of the same word on a page count for less.
        const score = item.w * (used ? 0.35 : 1) * (0.55 + Math.random());
        if (score > bestScore) { best = item; bestScore = score; }
      }
      if (best) {
        chosen.push(best.c);
        perKey.set(best.c.en, (perKey.get(best.c.en) || 0) + 1);
      }
    }
    return chosen;
  }

  /** Inflect and case a dictionary translation for the occurrence it replaces. */
  function surfaceTranslation(c, tr, lang) {
    let out = tr;
    if (c.plural && c.pos === 'n') out = globalThis.LIM.targetPlural(lang, tr) || tr;
    if (c.upperFirst && c.sentenceStart) out = out.charAt(0).toUpperCase() + out.slice(1);
    return out;
  }

  globalThis.LIMEngine = { buildLexicon, collectTextNodes, findCandidates, choose, surfaceTranslation, isSentenceStart, makeNodeFilter, SKIP_SELECTOR };
})();
