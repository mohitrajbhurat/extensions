// Page Assistant: in-page highlighting of passages and terms. Injected on demand.
// Uses the CSS Custom Highlight API when available (no DOM changes), otherwise wraps
// text in <mark> elements that are removed on clear().
(() => {
  if (globalThis.__PA_hl) return;
  const STYLE_ID = '__pa-highlight-style';
  const supportsHL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      ::highlight(pa-hit){background-color:#ffe066;color:#111}
      ::highlight(pa-focus){background-color:#ffb057;color:#111}
      mark.__pa-mark{background:#ffe066;color:#111;border-radius:2px;padding:0}
      mark.__pa-mark.__pa-focus{background:#ffb057}
      .__pa-flash{outline:3px solid #6d5dfc !important;outline-offset:4px;border-radius:4px;transition:outline-color 1.2s ease}
      .__pa-flash.__pa-fade{outline-color:transparent !important}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function clear() {
    if (supportsHL) { CSS.highlights.delete('pa-hit'); CSS.highlights.delete('pa-focus'); }
    const parents = new Set();
    document.querySelectorAll('mark.__pa-mark').forEach((m) => {
      parents.add(m.parentNode);
      m.replaceWith(...m.childNodes);
    });
    parents.forEach((p) => p && p.normalize && p.normalize());
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);

  // Build a whitespace-normalized lowercase string of the root's text with a map back
  // to (node, offset) for every character.
  function indexText(root) {
    const nodes = [];
    const offs = [];
    let hay = '';
    let lastSpace = true;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || p.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (/[\s ​]/.test(ch)) {
          if (lastSpace) continue;
          hay += ' ';
          lastSpace = true;
        } else {
          hay += ch.toLowerCase();
          lastSpace = false;
        }
        nodes.push(n);
        offs.push(i);
      }
      // Block boundaries count as whitespace.
      if (!lastSpace) { hay += ' '; nodes.push(n); offs.push(v.length); lastSpace = true; }
    }
    return { hay, nodes, offs };
  }

  const normNeedle = (s) => String(s || '').replace(/[\s ​]+/g, ' ').trim().toLowerCase();

  function rangeAt(idx, start, len) {
    const end = start + len - 1;
    if (start < 0 || end >= idx.nodes.length) return null;
    const r = document.createRange();
    r.setStart(idx.nodes[start], idx.offs[start]);
    const endNode = idx.nodes[end];
    r.setEnd(endNode, Math.min(endNode.nodeValue.length, idx.offs[end] + 1));
    return r;
  }

  function findIn(root, text) {
    const needle = normNeedle(text);
    if (!needle) return null;
    const idx = indexText(root);
    let at = idx.hay.indexOf(needle);
    if (at >= 0) return rangeAt(idx, at, needle.length);
    // Fall back to the longest prefix that matches (text may differ in formatting).
    for (const n of [160, 100, 60, 35]) {
      if (needle.length <= n) continue;
      const head = needle.slice(0, n);
      at = idx.hay.indexOf(head);
      if (at >= 0) {
        const tail = needle.slice(-Math.min(40, needle.length - n));
        const endAt = idx.hay.indexOf(tail, at + n);
        const len = endAt > 0 && endAt - at < needle.length * 1.5 ? endAt + tail.length - at : n;
        return rangeAt(idx, at, len);
      }
    }
    return null;
  }

  function wrapRange(range, focus) {
    const nodes = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) nodes.push(n);
    if (range.commonAncestorContainer.nodeType === 3 && !nodes.length) nodes.push(range.commonAncestorContainer);
    let first = null;
    for (const n of nodes) {
      const start = n === range.startContainer ? range.startOffset : 0;
      const end = n === range.endContainer ? range.endOffset : n.nodeValue.length;
      if (end <= start) continue;
      let target = n;
      if (start > 0) target = target.splitText(start);
      if (end - start < target.nodeValue.length) target.splitText(end - start);
      const mark = document.createElement('mark');
      mark.className = '__pa-mark' + (focus ? ' __pa-focus' : '');
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      if (!first) first = mark;
    }
    return first;
  }

  function scrollToRange(range) {
    const el = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function apply(ranges, focusIdx) {
    ensureStyle();
    if (supportsHL) {
      const hits = ranges.filter((_, i) => i !== focusIdx);
      if (hits.length) CSS.highlights.set('pa-hit', new Highlight(...hits));
      if (ranges[focusIdx]) CSS.highlights.set('pa-focus', new Highlight(ranges[focusIdx]));
    } else {
      // Wrap from last to first so earlier ranges stay valid.
      for (let i = ranges.length - 1; i >= 0; i--) wrapRange(ranges[i], i === focusIdx);
    }
  }

  function blockEl(i) {
    const els = globalThis.__PA_blockEls || [];
    const el = els[i];
    return el && el.isConnected ? el : null;
  }

  // passages: [{text, block}] ; focus: index to scroll to (default 0)
  function highlight({ passages = [], focus = 0, scroll = true } = {}) {
    clear();
    const ranges = [];
    let focusRange = null;
    passages.forEach((p, i) => {
      const root = (p.block != null && blockEl(p.block)) || document.body;
      let r = findIn(root, p.text);
      if (!r && root !== document.body) r = findIn(document.body, p.text);
      if (!r && root !== document.body && (p.text || '').length > 200) {
        // Highlight the block itself when the text cannot be mapped.
        r = document.createRange();
        r.selectNodeContents(root);
      }
      if (r) { ranges.push(r); if (i === focus) focusRange = r; }
    });
    if (!ranges.length) return { found: 0 };
    apply(ranges, focusRange ? ranges.indexOf(focusRange) : -1);
    if (scroll) scrollToRange(focusRange || ranges[0]);
    return { found: ranges.length };
  }

  // Highlight every occurrence of a term (word-bounded, case-insensitive).
  function highlightTerm({ term, scroll = true, max = 400 } = {}) {
    clear();
    const needle = normNeedle(term);
    if (!needle) return { found: 0 };
    const idx = indexText(document.body);
    const ranges = [];
    const isWord = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
    let at = idx.hay.indexOf(needle);
    while (at >= 0 && ranges.length < max) {
      if (!isWord(idx.hay[at - 1]) && !isWord(idx.hay[at + needle.length])) {
        const r = rangeAt(idx, at, needle.length);
        if (r) ranges.push(r);
      }
      at = idx.hay.indexOf(needle, at + needle.length);
    }
    if (!ranges.length) return { found: 0 };
    apply(ranges, 0);
    if (scroll) scrollToRange(ranges[0]);
    return { found: ranges.length };
  }

  function scrollToBlock({ block, text } = {}) {
    clear();
    let el = blockEl(block);
    if (!el && text) {
      const r = findIn(document.body, text);
      if (r) el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    }
    if (!el) return { found: 0 };
    ensureStyle();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('__pa-flash');
    setTimeout(() => el.classList.add('__pa-fade'), 900);
    setTimeout(() => el.classList.remove('__pa-flash', '__pa-fade'), 2400);
    return { found: 1 };
  }

  globalThis.__PA_hl = { highlight, highlightTerm, scrollToBlock, clear };
})();
