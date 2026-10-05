/* Collapsible, syntax-highlighted JSON tree.
   Written as a classic script that publishes globalThis.AWJsonTree so the same code
   serves the extension page (imported as a side-effect module) and the content script. */
(function () {
  'use strict';

  const SUMMARY_LIMIT = 60;

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function esc(s) { return s; }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function keyLabel(key, isIndex) {
    const k = el('span', isIndex ? 'jt-index' : 'jt-key', isIndex ? key : JSON.stringify(key));
    return k;
  }

  function primitive(v) {
    const t = typeOf(v);
    if (t === 'string') {
      const s = el('span', 'jt-str');
      s.textContent = JSON.stringify(v);
      if (/^https?:\/\/\S+$/.test(v)) {
        const a = document.createElement('a');
        a.className = 'jt-str jt-link'; a.href = v; a.target = '_blank'; a.rel = 'noreferrer noopener';
        a.textContent = JSON.stringify(v);
        return a;
      }
      return s;
    }
    if (t === 'number') return el('span', 'jt-num', String(v));
    if (t === 'boolean') return el('span', 'jt-bool', String(v));
    if (t === 'null') return el('span', 'jt-null', 'null');
    if (v === undefined) return el('span', 'jt-null', 'undefined');
    return el('span', 'jt-str', String(v));
  }

  function summary(v) {
    const t = typeOf(v);
    if (t === 'array') {
      if (!v.length) return '[]';
      const parts = [];
      let len = 0;
      for (const x of v) {
        const s = brief(x);
        if (len + s.length > SUMMARY_LIMIT) { parts.push('…'); break; }
        parts.push(s); len += s.length + 2;
      }
      return `${parts.join(', ')}  \u00B7 ${v.length} item${v.length === 1 ? '' : 's'}`;
    }
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const shown = [];
    let len = 0;
    for (const k of keys) {
      if (len + k.length > SUMMARY_LIMIT) { shown.push('…'); break; }
      shown.push(k); len += k.length + 2;
    }
    return `${shown.join(', ')}  \u00B7 ${keys.length} key${keys.length === 1 ? '' : 's'}`;
  }

  function brief(x) {
    const t = typeOf(x);
    if (t === 'string') return x.length > 16 ? JSON.stringify(x.slice(0, 14) + '…') : JSON.stringify(x);
    if (t === 'object') return '{…}';
    if (t === 'array') return '[…]';
    return String(x);
  }

  function pathString(segs) {
    return '$' + segs.map(s => typeof s === 'number' ? '[' + s + ']'
      : /^[A-Za-z_$][\w$]*$/.test(s) ? '.' + s : '[' + JSON.stringify(s) + ']').join('');
  }

  /** opts: { expandDepth, onCopyPath, maxNodes } */
  function render(value, opts) {
    opts = opts || {};
    const root = el('div', 'jt-root');
    root.tabIndex = 0;
    const expandDepth = opts.expandDepth == null ? 2 : opts.expandDepth;
    const maxNodes = opts.maxNodes || 20000;
    let nodes = 0;
    let truncated = false;

    function node(key, val, depth, path, isIndex, isLast) {
      const t = typeOf(val);
      const row = el('div', 'jt-node');
      const line = el('div', 'jt-line');
      row.append(line);
      if (++nodes > maxNodes) { truncated = true; line.append(el('span', 'jt-null', '… output truncated')); return row; }
      line.dataset.path = pathString(path);
      if (t === 'object' || t === 'array') {
        const open = t === 'array' ? '[' : '{';
        const close = t === 'array' ? ']' : '}';
        const entries = t === 'array' ? val.map((v, i) => [i, v, true]) : Object.keys(val).map(k => [k, val[k], false]);
        const tw = el('span', 'jt-tw');
        tw.setAttribute('role', 'button');
        tw.tabIndex = -1;
        line.append(tw);
        if (key !== null) { line.append(keyLabel(key, isIndex)); line.append(el('span', 'jt-colon', ': ')); }
        const brace = el('span', 'jt-brace', open);
        line.append(brace);
        const sum = el('span', 'jt-summary', ' ' + summary(val) + ' ');
        line.append(sum);
        const closeBrace = el('span', 'jt-brace', close + (isLast ? '' : ','));
        line.append(closeBrace);
        const kids = el('div', 'jt-children');
        row.append(kids);
        const tail = el('div', 'jt-tail');
        tail.append(el('span', 'jt-brace', close + (isLast ? '' : ',')));
        row.append(tail);
        let built = false;
        function build() {
          if (built) return;
          built = true;
          entries.forEach(([k, v, idx], i) => kids.append(node(k, v, depth + 1, path.concat(idx ? Number(k) : k), idx, i === entries.length - 1)));
        }
        function setOpen(o) {
          if (o && entries.length) build();
          row.classList.toggle('open', !!o && entries.length > 0);
          tw.setAttribute('aria-expanded', String(!!o && entries.length > 0));
        }
        row.dataset.container = '1';
        row._setOpen = setOpen;
        row._build = build;
        setOpen(depth < expandDepth && entries.length > 0);
        if (!entries.length) { row.classList.add('jt-empty'); sum.textContent = ''; closeBrace.textContent = close + (isLast ? '' : ','); }
        tw.addEventListener('click', e => { e.stopPropagation(); setOpen(!row.classList.contains('open')); });
        brace.addEventListener('click', () => setOpen(!row.classList.contains('open')));
        sum.addEventListener('click', () => setOpen(true));
      } else {
        line.append(el('span', 'jt-tw jt-leaf'));
        if (key !== null) { line.append(keyLabel(key, isIndex)); line.append(el('span', 'jt-colon', ': ')); }
        line.append(primitive(val));
        if (!isLast) line.append(el('span', 'jt-brace', ','));
      }
      const btn = el('button', 'jt-copy', 'copy path');
      btn.type = 'button';
      btn.title = 'Copy ' + pathString(path);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const p = pathString(path);
        const done = () => { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy path'; }, 1200); };
        if (opts.onCopyPath) { opts.onCopyPath(p, val); done(); }
        else if (navigator.clipboard) navigator.clipboard.writeText(p).then(done, () => {});
      });
      line.append(btn);
      return row;
    }

    root.append(node(null, value, 0, [], false, true));
    root.setAttribute('data-truncated', truncated ? '1' : '0');

    root.expandAll = function () {
      for (let pass = 0; pass < 40; pass++) {
        const closed = root.querySelectorAll('.jt-node[data-container="1"]:not(.open):not(.jt-empty)');
        if (!closed.length) break;
        closed.forEach(n => n._setOpen && n._setOpen(true));
      }
    };
    root.collapseAll = function () {
      root.querySelectorAll('.jt-node[data-container="1"].open').forEach(n => n._setOpen && n._setOpen(false));
      const first = root.firstElementChild;
      if (first && first._setOpen) first._setOpen(true);
    };
    /** Highlight matches; returns the number of matches. Expands ancestors of each hit. */
    root.search = function (query) {
      root.querySelectorAll('.jt-hit').forEach(n => n.classList.remove('jt-hit'));
      root.querySelectorAll('mark.jt-mark').forEach(m => { m.replaceWith(document.createTextNode(m.textContent)); });
      root.normalize();
      if (!query) return 0;
      root.expandAll();
      const q = query.toLowerCase();
      let count = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || p.classList.contains('jt-copy') || p.classList.contains('jt-summary')) return NodeFilter.FILTER_REJECT;
          return n.nodeValue.toLowerCase().includes(q) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const hits = [];
      while (walker.nextNode()) hits.push(walker.currentNode);
      for (const textNode of hits) {
        const text = textNode.nodeValue;
        const frag = document.createDocumentFragment();
        let i = 0;
        for (;;) {
          const at = text.toLowerCase().indexOf(q, i);
          if (at < 0) break;
          if (at > i) frag.append(text.slice(i, at));
          const mark = el('mark', 'jt-mark', text.substr(at, q.length));
          frag.append(mark);
          i = at + q.length;
          count++;
        }
        if (i < text.length) frag.append(text.slice(i));
        const line = textNode.parentElement.closest('.jt-line');
        textNode.replaceWith(frag);
        if (line) line.classList.add('jt-hit');
      }
      return count;
    };
    root.hits = function () { return [...root.querySelectorAll('.jt-line.jt-hit')]; };
    return root;
  }

  globalThis.AWJsonTree = { render: render, pathString: pathString, typeOf: typeOf, esc: esc };
})();
