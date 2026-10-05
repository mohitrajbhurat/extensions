// Text extraction shared by the offscreen parser, the background render tab and the picker.
// Classic script (no import/export) so it can be injected with chrome.scripting and also
// loaded by module pages; it exposes globalThis.PageWatchExtract.
(function () {
  if (globalThis.PageWatchExtract) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'HEAD', 'META', 'LINK', 'AUDIO', 'VIDEO', 'MAP', 'DIALOG']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
    'HTML', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
    'LEGEND', 'OPTION', 'SELECT', 'TEXTAREA']);
  const CELL = new Set(['TD', 'TH']);

  function isHidden(el, live) {
    if (el.hasAttribute('hidden')) return true;
    const style = el.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    if (live && el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.getComputedStyle) {
      // Only consult computed style in a rendered document (DOMParser documents have no layout).
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
    }
    return false;
  }

  /** Readable text of a node: block elements become lines, whitespace collapsed. */
  function textOf(root, live) {
    const out = [];
    const walk = (node) => {
      if (node.nodeType === 3) { out.push(node.data); return; }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      const tag = node.nodeType === 1 ? node.tagName.toUpperCase() : '';
      if (tag) {
        if (SKIP.has(tag)) return;
        if (isHidden(node, live)) return;
        if (tag === 'BR') { out.push('\n'); return; }
        if (tag === 'IMG') {
          const alt = node.getAttribute('alt');
          if (alt && alt.trim()) out.push(' ' + alt.trim() + ' ');
          return;
        }
        if (tag === 'INPUT') {
          const type = (node.getAttribute('type') || 'text').toLowerCase();
          if (['submit', 'button'].includes(type) && node.getAttribute('value')) out.push(' ' + node.getAttribute('value') + ' ');
          return;
        }
      }
      const block = BLOCK.has(tag);
      if (block) out.push('\n');
      if (CELL.has(tag)) out.push(' ');
      const kids = node.shadowRoot && live ? node.shadowRoot.childNodes : node.childNodes;
      for (const child of kids) walk(child);
      if (CELL.has(tag)) out.push(' \t ');
      if (block) out.push('\n');
    };
    walk(root);
    return out.join('')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  function isXPath(selector) {
    return /^(xpath:|\/|\(\/)/i.test(selector);
  }

  /** Resolve a CSS selector or XPath (prefix "xpath:" or starting with "/") to elements. */
  function resolve(doc, selector) {
    const sel = String(selector || '').trim();
    if (!sel) return [doc.body || doc.documentElement];
    if (isXPath(sel)) {
      const expr = sel.replace(/^xpath:/i, '');
      const res = doc.evaluate(expr, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      const nodes = [];
      for (let i = 0; i < res.snapshotLength; i++) nodes.push(res.snapshotItem(i));
      return nodes;
    }
    return Array.from(doc.querySelectorAll(sel));
  }

  /**
   * Extract text for a selector from a document.
   * Returns { text, count, title, error? }. Multiple matches are joined with blank lines.
   */
  function extract(doc, selector, opts) {
    const live = !!(opts && opts.live);
    try {
      const nodes = resolve(doc, selector);
      const parts = nodes.map((n) => (n.nodeType === 1 || n.nodeType === 9 ? textOf(n, live) : String(n.textContent || '').trim()));
      return {
        text: parts.filter(Boolean).join('\n\n'),
        count: nodes.length,
        title: (doc.title || '').trim(),
      };
    } catch (e) {
      return { text: '', count: 0, title: (doc.title || '').trim(), error: 'Invalid selector: ' + (e && e.message ? e.message : e) };
    }
  }

  globalThis.PageWatchExtract = { extract, textOf, resolve, isXPath };
})();
