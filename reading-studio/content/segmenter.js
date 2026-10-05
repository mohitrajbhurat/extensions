// Reading Studio sentence segmentation and DOM text mapping for read-aloud.
// Standalone: exposes globalThis.RSSegmenter (and RS.seg when loaded as a content script).
(function () {
  if (globalThis.RSSegmenter) { if (globalThis.RS) globalThis.RS.seg = globalThis.RSSegmenter; return; }

  // Lower-cased abbreviations (without the trailing dot) that do not end a sentence.
  const ABBR = new Set(('mr mrs ms mx dr prof sr jr st mt ft vs etc e.g i.e cf al approx est dept univ inc ltd co corp ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec no nos vol vols p pp fig figs ed eds rev gen col lt sgt capt cmdr ' +
    'gov sen rep pres hon u.s u.k u.n a.m p.m ph.d m.d b.a m.a d.c op cit ibid viz ca esp misc ave blvd rd bros dist ' +
    'z.b bzw usw ggf vgl d.h s.o mme mlle sra sr sto')
    .split(/\s+/));

  const CLOSERS = '"\'”’)]»」』';
  const TERMINALS = /[.!?…。！？؟।]/;

  function rawSplit(text, lang) {
    const out = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
        for (const s of seg.segment(text)) out.push([s.index, s.index + s.segment.length]);
        return out;
      } catch (e) { /* bad locale: fall through */ }
    }
    // Fallback: terminal punctuation + optional closers + whitespace, followed by a likely sentence start.
    const re = /[.!?…。！？؟।]+["'”’)\]»」』]*(\s+|$)|[。！？]/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      if (end <= last) { re.lastIndex++; continue; }
      out.push([last, end]);
      last = end;
    }
    if (last < text.length) out.push([last, text.length]);
    return out;
  }

  function lastToken(str) {
    const m = /([\p{L}\p{N}][\p{L}\p{N}.'’-]*)\.\s*$/u.exec(str.replace(/["'”’)\]]+\s*$/, ''));
    return m ? m[1] : '';
  }

  // Should the boundary between a and b be removed?
  function shouldJoin(a, b) {
    const at = a.trimEnd();
    const bt = b.trimStart();
    if (!bt) return true;
    if (!TERMINALS.test(at.slice(-3))) return true; // segmenter broke on something that isn't a terminal
    if (/\.\s*$/.test(at.replace(/["'”’)\]]+$/, ''))) {
      const tok = lastToken(at);
      if (tok) {
        const low = tok.toLowerCase();
        if (ABBR.has(low)) {
          // "...in the U.S. The next" really ends; keep join only when next word is lower-case or a name-like token
          if (!/^(u\.s|u\.k|u\.n|etc|a\.m|p\.m|inc|ltd|co|corp)$/.test(low)) return true;
          return /^[\p{Ll}\p{N}]/u.test(bt);
        }
        if (/^\p{Lu}$/u.test(tok)) return true;                 // initials: "J. R. R. Tolkien"
        if (/^(\p{L}\.){2,}\p{L}?$/u.test(tok)) return /^[\p{Ll}\p{N}]/u.test(bt); // acronyms "e.g", "U.S.A"
        if (/^\d+$/.test(tok) && /^\d/.test(bt)) return true;    // "3. 14"
      }
      if (/\.\.\.$/.test(at) || /…$/.test(at)) return /^\p{Ll}/u.test(bt);
    }
    if (/^[\p{Ll}]/u.test(bt) && /[.]$/.test(at) && !/[!?]$/.test(at)) return true; // next starts lower-case
    if (/^\p{Ll}/u.test(bt) && /[?!]["'”’»]$/.test(at)) return true; // “Really?” she asked.
    if (/^[,;:)\]]/.test(bt)) return true;
    return false;
  }

  // Break overly long sentences at clause punctuation (or spaces) so TTS engines stay responsive.
  function splitLong(text, start, end, maxLen, out) {
    if (end - start <= maxLen) { out.push([start, end]); return; }
    const slice = text.slice(start, end);
    const mid = slice.length / 2;
    let best = -1, bestScore = Infinity;
    const re = /[;:—–]\s+|,\s+|\s+[-–]\s+|\s+(?=(and|but|or|which|because|while|whereas|although)\s)/g;
    let m;
    while ((m = re.exec(slice))) {
      const pos = m.index + m[0].length;
      if (pos < 30 || slice.length - pos < 30) continue;
      const weight = /[;:—–]/.test(m[0]) ? 0.6 : /,/.test(m[0]) ? 0.8 : 1;
      const score = Math.abs(pos - mid) * weight;
      if (score < bestScore) { bestScore = score; best = pos; }
    }
    if (best < 0) {
      const sp = slice.lastIndexOf(' ', Math.min(maxLen, slice.length - 1));
      best = sp > 20 ? sp + 1 : Math.min(maxLen, slice.length);
    }
    splitLong(text, start, start + best, maxLen, out);
    splitLong(text, start + best, end, maxLen, out);
  }

  // Returns [{start, end, text}] covering the sentences in `text`, whitespace trimmed.
  function splitSentences(text, opts) {
    opts = opts || {};
    const maxLen = opts.maxLen || 260;
    const parts = rawSplit(text, opts.lang);
    const merged = [];
    for (const p of parts) {
      if (merged.length && shouldJoin(text.slice(merged[merged.length - 1][0], merged[merged.length - 1][1]), text.slice(p[0], p[1]))) {
        merged[merged.length - 1][1] = p[1];
      } else merged.push([p[0], p[1]]);
    }
    const out = [];
    for (const [s0, e0] of merged) {
      let s = s0, e = e0;
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      if (e <= s) continue;
      if (!/[\p{L}\p{N}]/u.test(text.slice(s, e))) {
        // Pure punctuation/emoji fragment: attach to previous sentence.
        if (out.length) out[out.length - 1][1] = e;
        continue;
      }
      splitLong(text, s, e, maxLen, out);
    }
    return out.map(([s, e]) => {
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      return { start: s, end: e, text: text.slice(s, e) };
    }).filter((x) => x.end > x.start);
  }

  // ---------- DOM mapping ----------
  const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN',
    'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'HTML']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA',
    'SELECT', 'BUTTON', 'OPTION', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'RS-UI', 'SUP']);

  function blockOf(node, root, checkDisplay) {
    let el = node.parentElement;
    while (el && el !== root) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      if (checkDisplay && el.tagName.includes('-')) {
        const d = getComputedStyle(el).display;
        if (d && !d.startsWith('inline') && d !== 'contents') return el;
      }
      el = el.parentElement;
    }
    return root;
  }

  /**
   * Build read-aloud segments from one or more DOM roots.
   * opts.range: only include text inside this Range (selection reading)
   * opts.checkVisibility: skip hidden elements (live pages)
   * opts.skipSelector: elements to ignore
   * Returns { segments: [{text, para, block, pieces, start, end}], paragraphs: n }
   */
  function buildSegments(roots, opts) {
    opts = opts || {};
    const segments = [];
    let paraIndex = -1;
    const range = opts.range || null;
    const doc = (roots[0] && roots[0].ownerDocument) || document;

    for (const root of roots) {
      let cur = null; // current paragraph run: { block, raw, pieces: [{node, rawStart, nodeStart, nodeEnd}] }
      const flush = () => {
        if (!cur || !cur.raw.trim()) { cur = null; return; }
        // Collapse whitespace, keeping a map from collapsed index to raw index.
        const raw = cur.raw;
        let norm = '';
        const map = [];
        let inSpace = true;
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
          if (/\s/.test(ch) || ch === '­') {
            if (ch === '­') continue;
            if (!inSpace) { norm += ' '; map.push(i); inSpace = true; }
          } else { norm += ch; map.push(i); inSpace = false; }
        }
        if (norm.endsWith(' ')) { norm = norm.slice(0, -1); map.pop(); }
        map.push(raw.length);
        if (!norm) { cur = null; return; }
        paraIndex++;
        const sentences = splitSentences(norm, { lang: opts.lang, maxLen: opts.maxLen });
        for (const s of sentences) {
          segments.push({
            text: s.text,
            para: paraIndex,
            block: cur.block,
            pieces: cur.pieces,
            rawStart: map[s.start],
            rawEnd: map[s.end - 1] + 1,
            normStart: s.start,
            map
          });
        }
        cur = null;
      };

      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (SKIP.has(n.tagName) || n.hasAttribute('data-rs-ui') || n.hasAttribute('data-rs-skip')) return NodeFilter.FILTER_REJECT;
            if (n.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
            if (opts.skipSelector && n.matches(opts.skipSelector)) return NodeFilter.FILTER_REJECT;
            if (opts.checkVisibility && typeof n.checkVisibility === 'function' && !n.checkVisibility()) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          if (range && !range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      // Track <br> as paragraph breaks: walk elements too.
      let node;
      let lastBlock = null;
      while ((node = walker.nextNode())) {
        let start = 0, end = node.nodeValue.length;
        if (range) {
          if (node === range.startContainer) start = range.startOffset;
          if (node === range.endContainer) end = range.endOffset;
        }
        if (end <= start) continue;
        const block = blockOf(node, root, !!opts.checkVisibility);
        // A <br> between this text node and the previous one inside the same block also breaks.
        let brBreak = false;
        if (cur && block === lastBlock) {
          let prev = node.previousSibling;
          while (prev && prev.nodeType === 3 && !prev.nodeValue.trim()) prev = prev.previousSibling;
          if (prev && prev.nodeType === 1 && prev.tagName === 'BR') {
            let prevBr = prev.previousSibling;
            while (prevBr && prevBr.nodeType === 3 && !prevBr.nodeValue.trim()) prevBr = prevBr.previousSibling;
            brBreak = !!(prevBr && prevBr.nodeType === 1 && prevBr.tagName === 'BR') || /[.!?:]\s*$/.test(cur.raw);
          }
        }
        if (!cur || block !== lastBlock || brBreak) {
          flush();
          cur = { block, raw: '', pieces: [] };
          lastBlock = block;
        } else {
          // Inline siblings separated by an element boundary that renders a break (e.g. <br>): insert a space.
          const prevSib = node.previousSibling;
          if (prevSib && prevSib.nodeType === 1 && prevSib.tagName === 'BR' && !/\s$/.test(cur.raw)) cur.raw += ' ';
        }
        cur.pieces.push({ node, rawStart: cur.raw.length, nodeStart: start, nodeEnd: end });
        cur.raw += node.nodeValue.slice(start, end);
      }
      flush();
    }
    return { segments, paragraphs: paraIndex + 1 };
  }

  // Map a raw offset inside a paragraph run to [node, offset].
  function locate(pieces, rawIdx, preferEnd) {
    let lo = 0, hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid].rawStart <= rawIdx - (preferEnd ? 1 : 0)) lo = mid; else hi = mid - 1;
    }
    const p = pieces[lo];
    const len = p.nodeEnd - p.nodeStart;
    const off = Math.max(0, Math.min(len, rawIdx - p.rawStart));
    return [p.node, p.nodeStart + off];
  }

  function rangeForRaw(seg, rawStart, rawEnd) {
    const doc = seg.pieces[0].node.ownerDocument;
    const r = doc.createRange();
    try {
      const [sn, so] = locate(seg.pieces, rawStart, false);
      const [en, eo] = locate(seg.pieces, rawEnd, true);
      r.setStart(sn, so);
      r.setEnd(en, eo);
    } catch (e) { return null; }
    return r;
  }

  // Range covering the whole sentence.
  function sentenceRange(seg) { return rangeForRaw(seg, seg.rawStart, seg.rawEnd); }

  // Range covering [charIndex, charIndex+len) of seg.text (as spoken).
  function wordRange(seg, charIndex, len) {
    const a = seg.normStart + Math.max(0, charIndex);
    let b;
    if (len && len > 0) b = a + len;
    else {
      const rest = seg.text.slice(charIndex);
      const m = /^[\s]*[^\s]+/.exec(rest);
      b = a + (m ? m[0].length : 1);
    }
    b = Math.min(b, seg.normStart + seg.text.length);
    if (b <= a) return null;
    const rawA = seg.map[a];
    const rawB = seg.map[b - 1] + 1;
    return rangeForRaw(seg, rawA, rawB);
  }

  const api = { splitSentences, buildSegments, sentenceRange, wordRange };
  globalThis.RSSegmenter = api;
  if (globalThis.RS) globalThis.RS.seg = api;
})();
