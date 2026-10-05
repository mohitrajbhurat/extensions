// Smart Autofill field matcher: finds fillable controls (including open/closed shadow roots),
// gathers their descriptive text and classifies them against the field dictionary.
(function () {
  'use strict';
  if (globalThis.__SA_matcher) return;
  const { FIELDS, SECTIONS, byKey } = globalThis.SmartAutofillFields;
  const UI_HOST_ID = 'smart-autofill-ui-host';

  // ---------- text helpers ----------
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  // Whole-word phrase match, tolerating a plural "s".
  function hasPhrase(text, phrase) {
    if (!text || !phrase) return false;
    const t = ' ' + text + ' ';
    return t.includes(' ' + phrase + ' ') || t.includes(' ' + phrase + 's ');
  }
  // Prefix match used for negatives ("relocat" matches "relocation").
  function hasPrefix(text, phrase) {
    return (' ' + text + ' ').includes(' ' + phrase);
  }

  const SKIP_TEXT_TAGS = new Set(['SELECT', 'OPTION', 'TEXTAREA', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'BUTTON']);
  function textOf(node, limit = 300) {
    if (!node) return '';
    let out = '';
    const walk = (n) => {
      if (out.length > limit) return;
      if (n.nodeType === 3) { out += n.nodeValue + ' '; return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        if (SKIP_TEXT_TAGS.has(n.tagName) || n.id === UI_HOST_ID) return;
        if (n.tagName === 'INPUT') return;
        if (n.hidden || n.getAttribute('aria-hidden') === 'true') return;
      }
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, ' ').trim().slice(0, limit);
  }
  function cleanLabel(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/[*:]+\s*$/, '').replace(/\(\s*(required|optional)\s*\)/ig, '').trim();
  }

  // ---------- control discovery ----------
  const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'number', 'search']);
  const DATE_TYPES = new Set(['date', 'month', 'week', 'datetime-local']);
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'range', 'color']);

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      if (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch (e) { /* not available */ }
    return null;
  }

  function kindOf(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (SKIP_TYPES.has(t)) return null;
      if (t === 'radio') return 'radio';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'file') return 'file';
      if (DATE_TYPES.has(t)) return 'date';
      if (t === 'search') return null;
      return TEXT_TYPES.has(t) ? 'text' : 'text';
    }
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null && !(el.parentElement && el.parentElement.isContentEditable)) return 'contenteditable';
    if (el.getAttribute && el.getAttribute('role') === 'textbox' && el.isContentEditable) return 'contenteditable';
    return null;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 || cs.opacity === '0';
  }

  function isUsable(el, kind) {
    if (el.disabled) return false;
    if (el.closest && el.closest('#' + UI_HOST_ID)) return false;
    if (kind === 'text' || kind === 'textarea' || kind === 'date') {
      if (el.readOnly && !el.getAttribute('role')) return false;
    }
    if (el.getAttribute('aria-hidden') === 'true' && kind !== 'file') return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(current-password|new-password|one-time-code|cc-)/.test(ac)) return false;
    if (/captcha|honeypot|^hp_|bot.?field/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.className && el.className.baseVal == null ? el.className : ''))) return false;
    if (kind === 'radio' || kind === 'checkbox' || kind === 'file') {
      if (isVisible(el)) return true;
      const lab = el.labels && el.labels[0];
      if (lab && isVisible(lab)) return true;
      const p = el.parentElement;
      return !!(p && isVisible(p));
    }
    return isVisible(el);
  }

  // Walk the document (and shadow roots) in order, collecting controls and the heading context.
  function collectControls(rootDoc) {
    const controls = [];
    const headingLevels = [];
    const headingText = () => headingLevels.filter(Boolean).join(' > ');
    const visit = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el = walker.currentNode.nodeType === 1 ? walker.currentNode : walker.nextNode();
      while (el) {
        if (el.id === UI_HOST_ID) { el = nextSkipping(walker); continue; }
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag) || tag === 'LEGEND' || el.getAttribute('role') === 'heading') {
          let level = tag === 'LEGEND' ? 7 : /^H/.test(tag) ? +tag[1] : (+el.getAttribute('aria-level') || 3);
          const t = cleanLabel(textOf(el, 120));
          if (t && isVisible(el)) {
            headingLevels[level] = t;
            headingLevels.length = level + 1;
          }
        }
        const kind = kindOf(el);
        if (kind) {
          if (isUsable(el, kind)) controls.push({ el, kind, heading: headingText() });
        }
        if (tag === 'IFRAME' || tag === 'FRAME') { /* handled by all_frames injection */ }
        const sr = shadowOf(el);
        if (sr) visit(sr);
        el = walker.nextNode();
      }
    };
    const nextSkipping = (walker) => {
      // skip subtree of current node
      let n = walker.currentNode;
      while (n) {
        if (walker.nextSibling()) return walker.currentNode;
        n = walker.parentNode();
        if (!n) return null;
      }
      return null;
    };
    visit(rootDoc.body || rootDoc.documentElement);
    return controls;
  }

  // ---------- describing a control ----------
  function rootOf(el) { return el.getRootNode ? el.getRootNode() : document; }
  function byIdIn(el, id) {
    const r = rootOf(el);
    return (r.getElementById ? r.getElementById(id) : null) || document.getElementById(id);
  }
  function ariaLabelledBy(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids.map(id => { const n = byIdIn(el, id); return n ? textOf(n) : ''; }).join(' ').trim();
  }
  function labelText(el) {
    const parts = [];
    try {
      if (el.labels && el.labels.length) for (const l of el.labels) parts.push(textOf(l));
    } catch (e) { /* contenteditable has no labels */ }
    if (!parts.length && el.id) {
      const r = rootOf(el);
      try {
        const l = r.querySelector && r.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) parts.push(textOf(l));
      } catch (e) { /* ignore */ }
    }
    if (!parts.length) {
      const wrap = el.closest && el.closest('label');
      if (wrap) parts.push(textOf(wrap));
    }
    return cleanLabel(parts.join(' '));
  }
  function countControls(node) {
    if (!node.querySelectorAll) return 0;
    return node.querySelectorAll('input:not([type=hidden]),select,textarea').length;
  }
  // Text close to a control when it has no label: previous siblings, then ancestors' own text.
  function nearbyText(el, anchor) {
    let node = anchor || el;
    for (let depth = 0; depth < 4 && node; depth++) {
      let sib = node.previousElementSibling, hops = 0;
      while (sib && hops < 3) {
        if (countControls(sib) === 0) {
          const t = cleanLabel(textOf(sib, 160));
          if (t) return t;
        } else break;
        sib = sib.previousElementSibling; hops++;
      }
      // Text nodes directly before
      let prev = node.previousSibling;
      while (prev && prev.nodeType === 3 && !prev.nodeValue.trim()) prev = prev.previousSibling;
      if (prev && prev.nodeType === 3) return cleanLabel(prev.nodeValue).slice(0, 160);
      const parent = node.parentElement || (node.parentNode && node.parentNode.host) || null;
      if (!parent || parent === document.body) break;
      if (countControls(parent) > 1) {
        node = parent; // keep walking but only via siblings
        continue;
      }
      const own = cleanLabel(textOf(parent, 160));
      if (own) return own;
      node = parent;
    }
    return '';
  }
  function optionLabel(el) {
    const l = labelText(el);
    if (l) return l;
    const a = el.getAttribute('aria-label') || ariaLabelledBy(el);
    if (a) return cleanLabel(a);
    let n = el.nextSibling;
    while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.nextSibling;
    if (n && n.nodeType === 3) return cleanLabel(n.nodeValue);
    if (n && n.nodeType === 1 && countControls(n) === 0) return cleanLabel(textOf(n, 120));
    return cleanLabel(el.value || '');
  }
  function commonAncestor(els) {
    if (els.length === 1) return els[0].parentElement;
    let a = els[0].parentElement;
    while (a && !els.every(e => a.contains(e))) a = a.parentElement;
    return a;
  }
  function groupQuestion(els) {
    const first = els[0];
    const fs = first.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) return cleanLabel(textOf(lg));
    }
    const rg = first.closest('[role=radiogroup],[role=group]');
    if (rg) {
      const t = rg.getAttribute('aria-label') || ariaLabelledBy(rg);
      if (t) return cleanLabel(t);
    }
    const anc = commonAncestor(els);
    if (anc) {
      if (els.length === 1) {
        // single checkbox: its own label is the question
        return optionLabel(first);
      }
      return nearbyText(anc, anc);
    }
    return '';
  }
  function ancestorAttrs(el) {
    let s = '';
    let n = el.parentElement;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      const id = n.id || '';
      const cls = typeof n.className === 'string' ? n.className : '';
      const da = n.getAttribute('data-automation-id') || n.getAttribute('data-section') || '';
      s += ' ' + id + ' ' + cls.slice(0, 80) + ' ' + da;
    }
    return norm(s);
  }

  // Build entries (single control, or radio/checkbox groups) from the raw control list.
  function buildEntries(controls) {
    const entries = [];
    const groups = new Map();
    for (const c of controls) {
      if ((c.kind === 'radio' || c.kind === 'checkbox') && c.el.name) {
        const root = rootOf(c.el);
        const form = c.el.form || root;
        const key = c.kind + '|' + c.el.name;
        let g = groups.get(form);
        if (!g) { g = new Map(); groups.set(form, g); }
        let entry = g.get(key);
        if (!entry) {
          entry = { kind: c.kind, el: c.el, els: [], heading: c.heading };
          g.set(key, entry);
          entries.push(entry);
        }
        entry.els.push(c.el);
      } else if (c.kind === 'radio') {
        entries.push({ kind: 'radio', el: c.el, els: [c.el], heading: c.heading });
      } else {
        entries.push({ kind: c.kind, el: c.el, els: [c.el], heading: c.heading });
      }
    }
    // Checkbox groups of one are plain checkboxes.
    for (const e of entries) {
      if (e.kind === 'checkbox' && e.els.length > 1) e.kind = 'checkgroup';
      if (e.kind === 'radio' || e.kind === 'checkgroup') e.options = e.els.map(el => ({ el, text: optionLabel(el), value: el.value }));
    }
    return entries;
  }

  function describe(entry) {
    if (entry.desc) return entry.desc;
    const el = entry.el;
    const d = {};
    const grouped = entry.kind === 'radio' || entry.kind === 'checkgroup';
    if (grouped) {
      d.label = groupQuestion(entry.els);
    } else if (entry.kind === 'checkbox') {
      d.label = optionLabel(el);
      const q = groupQuestion([el]);
      if (q && q !== d.label) d.near = q;
      if (!d.near) d.near = nearbyText(el.closest('label') || el);
    } else {
      d.label = labelText(el);
    }
    d.aria = cleanLabel(el.getAttribute('aria-label') || ariaLabelledBy(el));
    d.placeholder = cleanLabel(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '');
    d.name = el.getAttribute('name') || '';
    d.id = el.id || '';
    d.nameid = norm((d.name + ' ' + d.id).replace(/\d+/g, ' '));
    d.attrs = norm([el.getAttribute('title'), el.getAttribute('data-automation-id'), el.getAttribute('data-qa'), el.getAttribute('data-testid'), el.getAttribute('data-field')].filter(Boolean).join(' '));
    if (!d.label && !d.aria && !grouped && entry.kind !== 'checkbox') d.near = nearbyText(el);
    d.ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(t => t && !/^(section-|shipping|billing|home|work|mobile|fax|pager|on|off)$/.test(t) && !t.startsWith('section-'));
    d.heading = entry.heading || '';
    d.section = norm(d.heading + ' ' + d.name + ' ' + d.id + ' ' + ancestorAttrs(el));
    d.question = d.label || d.aria || d.placeholder || d.near || '';
    d.display = (d.question || d.name || d.id || entry.kind).slice(0, 120);
    entry.desc = d;
    return d;
  }

  // ---------- classification ----------
  const SRC_WEIGHTS = { label: 1.0, aria: 0.95, placeholder: 0.8, nameid: 0.75, attrs: 0.6, near: 0.6 };

  function sectionFlags(sectionText) {
    const f = {};
    for (const [g, words] of Object.entries(SECTIONS)) f[g] = words.some(w => hasPhrase(sectionText, w) || sectionText.includes(w.replace(/ /g, '')));
    return f;
  }

  function allowed(def, kind) {
    if (def.only && !def.only.includes(kind === 'checkgroup' ? 'checkbox' : kind)) {
      if (!(def.only.includes('text') && kind === 'textarea')) return false;
    }
    if (kind === 'file') return def.type === 'file';
    if (def.type === 'file') return false;
    if (def.type === 'bool') return kind === 'checkbox';
    if (kind === 'checkbox') return def.type === 'yesno' || def.type === 'bool';
    if (kind === 'date') return def.type === 'date';
    if (def.type === 'longtext') return kind === 'textarea' || kind === 'contenteditable' || kind === 'text';
    if (kind === 'radio' || kind === 'checkgroup') return def.type !== 'longtext' && def.type !== 'url' && def.type !== 'email' && def.type !== 'phone';
    return true;
  }

  function scoreField(def, texts, d, flags, entry) {
    // Autocomplete is the strongest signal.
    let acHit = d.ac.length && def.ac.some(a => d.ac.includes(a));
    let combined = 0;
    let best = 0;
    for (const [src, text] of Object.entries(texts)) {
      if (!text) continue;
      let s = 0;
      for (const [phrase, w] of def.kw) {
        if (hasPhrase(text, phrase)) {
          let v = w;
          if (text === phrase || text === phrase + 's') v = Math.min(1, v + 0.1);
          else {
            // Penalize long texts where the phrase is a small part.
            const ratio = phrase.length / text.length;
            if (ratio < 0.25 && src !== 'nameid') v *= 0.85;
          }
          if (v > s) s = v;
        }
      }
      if (s) {
        const val = s * SRC_WEIGHTS[src];
        combined = 1 - (1 - combined) * (1 - val * 0.92);
        if (val > best) best = val;
      }
    }
    let score = Math.max(best, combined);
    if (score && def.neg.length) {
      const strong = [texts.label, texts.aria, texts.placeholder, texts.nameid].filter(Boolean).join(' | ');
      if (def.neg.some(n => hasPrefix(strong, n))) score *= 0.3;
    }
    // Section context
    if (score) {
      if (def.group === 'work' || def.group === 'edu') {
        const other = def.group === 'work' ? 'edu' : 'work';
        if (flags[def.group] && !flags[other]) score = Math.min(1, score + 0.2);
        else if (flags[other] && !flags[def.group]) score *= 0.35;
        else if (!flags[def.group]) score *= /startDate|endDate|location|title|description|current/.test(def.key) ? 0.55 : 0.85;
      }
      if (def.key === 'misc.availableStart' && (flags.work || flags.edu) && !/availab|earliest|when can/.test(texts.label + texts.aria)) score *= 0.3;
      if (def.group === 'demo' && flags.demo) score = Math.min(1, score + 0.1);
      if (def.key === 'contact.fullName' && (flags.work || flags.edu)) score *= 0.5;
    }
    if (acHit) score = Math.max(score, 0.97);
    return score;
  }

  const STOP = new Set('a an the to of for and or in on at is are you your do does did with this that be have has what why how we our us please describe tell about any which would will can i my me it as by from'.split(' '));
  function tokens(s) { return norm(s).split(' ').filter(w => w && !STOP.has(w)); }
  function similarity(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const dice = (2 * inter) / (A.size + B.size);
    const contain = inter / Math.min(A.size, B.size);
    return Math.max(dice, contain * 0.85);
  }

  function classify(entry, qaList) {
    const d = describe(entry);
    const texts = {
      label: norm(d.label), aria: norm(d.aria), placeholder: norm(d.placeholder),
      nameid: d.nameid, attrs: d.attrs, near: norm(d.near || ''),
    };
    const flags = sectionFlags(d.section);
    const results = [];
    for (const def of FIELDS) {
      if (!allowed(def, entry.kind)) continue;
      const s = scoreField(def, texts, d, flags, entry);
      if (s > 0.05) results.push({ key: def.key, score: s });
    }
    results.sort((a, b) => b.score - a.score);
    let top = results[0] || null;
    // Custom Q&A answers: long-form questions that the dictionary cannot place.
    if (qaList && qaList.length && entry.kind !== 'file' && entry.kind !== 'date') {
      const q = d.question;
      if (q && q.length >= 6) {
        let bestQa = null;
        for (const qa of qaList) {
          if (!qa.question || !qa.answer) continue;
          const sim = similarity(q, qa.question);
          if (!bestQa || sim > bestQa.score) bestQa = { key: 'qa.' + qa.id, score: sim };
        }
        if (bestQa && bestQa.score >= 0.55) {
          const boosted = { key: bestQa.key, score: Math.min(0.99, bestQa.score) };
          if (!top || boosted.score > top.score || (q.length > 40 && boosted.score >= 0.7)) {
            results.unshift(boosted);
            top = boosted;
          }
        }
      }
    }
    return { best: top, alternatives: results.slice(0, 5), flags };
  }

  // Stable per-site signature of a field for learned rules.
  function signature(entry) {
    const d = describe(entry);
    const base = d.name ? 'n:' + d.name.replace(/\d+/g, '#') : d.id && !/^[a-z]*[-_]?\d{3,}|:r\w+:|^ember\d+|^react-/i.test(d.id) ? 'i:' + d.id.replace(/\d+/g, '#') : 'l:' + norm(d.question).slice(0, 60);
    return entry.kind + '|' + base;
  }

  // Index of a repeatable entry (work[1], education_2_school, "Position 2" headings).
  function explicitIndex(entry) {
    const d = describe(entry);
    const src = d.name + ' ' + d.id;
    let m = src.match(/[\[_\-.](\d{1,2})[\]_\-.]/) || src.match(/(?:^|[^0-9])(\d{1,2})$/);
    if (m) return { n: +m[1], from: 'attr' };
    m = (d.heading || '').match(/(?:experience|employment|position|job|education|school|degree|entry|#)\s*#?\s*(\d{1,2})\b/i);
    if (m) return { n: +m[1], from: 'heading' };
    return null;
  }

  globalThis.__SA_matcher = { norm, textOf, collectControls, buildEntries, describe, classify, signature, explicitIndex, similarity, hasPhrase, isVisible, shadowOf, UI_HOST_ID, byKey };
})();
