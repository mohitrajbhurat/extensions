/* Point-and-Click Scraper: detection, selector generation and extraction engine.
 * Pure DOM logic, no chrome.* calls. Works on the live document and on documents
 * parsed with DOMParser (used for link-based pagination).
 * Exposes globalThis.PSCore inside the extension's isolated world. */
(() => {
  'use strict';
  if (globalThis.PSCore) return;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'HR',
    'OPTION', 'OPTGROUP', 'PATH', 'G', 'DEFS', 'USE', 'SYMBOL', 'IFRAME', 'PAGE-SCRAPER-UI']);
  const TABLE_PARTS = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'COLGROUP']);
  // Classes that describe state or are generated, which make poor generalizing selectors.
  const UNSTABLE_CLASS = /(^|[-_])(active|selected|hover|hovered|focus|focused|current|open|opened|closed|expanded|collapsed|visible|show|shown|hidden|disabled|first|last|odd|even|loaded|loading|lazy|lazyloaded|clearfix|ng-[a-z-]+|is-[a-z-]+|has-[a-z-]+)($|[-_])|^(js-|sc-|css-|jsx-|svelte-|ng-|v-|emotion-|_)|[0-9a-f]{6,}|\d{4,}|__[A-Za-z0-9_-]{5,}$/i;
  const VALID_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
  const MAX_ELEMENTS = 25000;

  const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^A-Za-z0-9_-]/g, '\\$&'));
  const tagOf = (el) => el.tagName.toLowerCase();

  function stableClasses(el) {
    const out = [];
    for (const c of el.classList || []) {
      if (c.length > 40 || !VALID_IDENT.test(c) || UNSTABLE_CLASS.test(c)) continue;
      out.push(c);
      if (out.length === 3) break;
    }
    return out;
  }

  function stableId(el) {
    const id = el.getAttribute && el.getAttribute('id');
    if (!id || id.length > 40 || !VALID_IDENT.test(id) || /\d{3,}|[0-9a-f]{8,}|^(ember|react|radix|mui|headlessui|:)/i.test(id)) return null;
    return id;
  }

  /** "div.card.product" style token for one element. */
  function token(el, classes) {
    const cls = classes || stableClasses(el);
    return tagOf(el) + cls.map((c) => '.' + esc(c)).join('');
  }

  function signature(el) { return tagOf(el) + '|' + stableClasses(el).slice().sort().join('.'); }

  function safeQueryAll(root, selector) {
    if (!selector) return [];
    try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
  }

  function isUnique(doc, sel) { return safeQueryAll(doc, sel).length === 1; }

  /** Precise selector that pins down exactly this element (id anchors, nth-of-type when needed). */
  function preciseSelector(el) {
    const doc = el.ownerDocument;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
      if (cur === doc.body) { parts.unshift('body'); break; }
      const id = stableId(cur);
      if (id && isUnique(doc, '#' + esc(id))) { parts.unshift('#' + esc(id)); break; }
      let part = token(cur);
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) {
          const matching = safeQueryAll(parent, ':scope > ' + part);
          if (matching.length !== 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  /** Structural selector without positions: generalizes to every element sharing the same class/structure path. */
  function structuralSelector(el, stopAt) {
    const doc = el.ownerDocument;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== doc.documentElement && cur !== stopAt) {
      if (cur === doc.body) { parts.unshift('body'); break; }
      const id = depth > 0 ? stableId(cur) : null;
      if (id && isUnique(doc, '#' + esc(id))) { parts.unshift('#' + esc(id)); break; }
      parts.unshift(token(cur));
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /** Relative selector from an item to a descendant, plus the occurrence index among matches. */
  function relativeSelector(item, el) {
    if (el === item) return { selector: '', index: 0 };
    const parts = [];
    let cur = el;
    while (cur && cur !== item) { parts.unshift(token(cur)); cur = cur.parentElement; }
    if (cur !== item) return null;
    const selector = ':scope > ' + parts.join(' > ');
    const matches = safeQueryAll(item, selector);
    const index = Math.max(0, matches.indexOf(el));
    return { selector, index };
  }

  function resolveEl(item, col) {
    if (!col.selector || col.selector === ':scope') return item;
    const list = safeQueryAll(item, col.selector);
    return list[col.index || 0] || null;
  }

  const collapse = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim();

  function textOf(el) {
    if (!el) return '';
    const live = el.ownerDocument === globalThis.document && el.isConnected;
    if (live && typeof el.innerText === 'string') return collapse(el.innerText);
    return collapse(el.textContent);
  }

  function absUrl(value, base) {
    if (!value) return '';
    const v = String(value).trim();
    if (/^(javascript:|#$)/i.test(v)) return '';
    try { return new URL(v, base).href; } catch { return v; }
  }

  function imageSrc(el, base) {
    if (!el) return '';
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (img) {
      const live = img.ownerDocument === globalThis.document;
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
      const src = img.getAttribute('src');
      if (lazy && (!src || /^data:/.test(src))) return absUrl(lazy, base);
      if (live && img.currentSrc) return img.currentSrc;
      if (src) return absUrl(src, base);
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (srcset) return absUrl(srcset.split(',')[0].trim().split(/\s+/)[0], base);
    }
    const source = el.querySelector && el.querySelector('source[srcset]');
    if (source) return absUrl(source.getAttribute('srcset').split(',')[0].trim().split(/\s+/)[0], base);
    const style = el.getAttribute && el.getAttribute('style');
    const m = style && style.match(/background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/i);
    if (m) return absUrl(m[2], base);
    return '';
  }

  function linkHref(el, base) {
    if (!el) return '';
    const a = el.closest('a[href]') || (el.querySelector && el.querySelector('a[href]'));
    return a ? absUrl(a.getAttribute('href'), base) : '';
  }

  function valueOf(item, col, base) {
    const el = resolveEl(item, col);
    if (!el) return '';
    switch (col.type) {
      case 'href': return linkHref(el, base);
      case 'src': return imageSrc(el, base);
      case 'attr': {
        const name = (col.attr || '').trim();
        if (!name) return '';
        const v = el.getAttribute(name) ?? '';
        return /^(href|src|action|data-src|poster)$/i.test(name) ? absUrl(v, base) : collapse(v);
      }
      case 'html': return (el.innerHTML || '').trim();
      default: return textOf(el);
    }
  }

  function extract(recipe, doc = document, base = (doc.baseURI || globalThis.location.href)) {
    const items = safeQueryAll(doc, recipe.itemSelector);
    const rows = items.map((item) => recipe.columns.map((c) => valueOf(item, c, base)));
    return { items, rows };
  }

  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }

  function isVisible(el) {
    if (el.ownerDocument !== globalThis.document) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------- column inference ----------

  const PRETTY_TAG = { h1: 'Heading', h2: 'Heading', h3: 'Title', h4: 'Title', h5: 'Title', h6: 'Title', a: 'Link text', p: 'Text', span: 'Text', div: 'Text', li: 'Item', td: 'Cell', time: 'Date', strong: 'Text', b: 'Text', em: 'Text', small: 'Note', label: 'Label', button: 'Button' };

  function humanize(s) {
    return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^./, (c) => c.toUpperCase());
  }

  const GENERIC_CLASS = /^(col|row|flex|grid|text|font|m[trblxy]?|p[trblxy]?|w|h|d|container|wrapper|wrap|inner|outer|content|body|box|block|item|card|link|left|right|center|small|large|big|bold|muted|primary|secondary)(-?\d+|-[a-z]{1,3})?$/i;

  function meaningfulName(el) {
    const itemprop = el.getAttribute('itemprop');
    if (itemprop) return humanize(itemprop);
    const cls = stableClasses(el).filter((c) => c.length > 2 && !GENERIC_CLASS.test(c));
    if (!cls.length) return '';
    const pick = cls.slice().sort((a, b) => b.length - a.length)[0];
    const cleaned = pick.replace(/^.*__/, '').replace(/^(product|item|card|listing|result|search-result|entry)[-_]/i, '');
    return humanize(cleaned || pick);
  }

  function nameFor(el, type, item) {
    if (type === 'src') {
      const n = meaningfulName(el);
      return n && /image|img|photo|thumb|picture|avatar|logo/i.test(n) ? n.replace(/\bimg\b/i, 'Image') : 'Image';
    }
    let base = '';
    for (let cur = el, d = 0; cur && d < 3; cur = cur.parentElement, d++) {
      base = meaningfulName(cur);
      if (base || cur === item) break;
    }
    if (!base) base = PRETTY_TAG[tagOf(el)] || humanize(tagOf(el));
    if (type === 'href') return /link|url/i.test(base) ? base : base === 'Link text' ? 'Link' : base + ' link';
    return base;
  }

  function uniqueNames(cols) {
    const seen = new Map();
    for (const c of cols) {
      let n = c.name || 'Column';
      if (seen.has(n)) { const k = seen.get(n) + 1; seen.set(n, k); n = `${n} ${k}`; } else seen.set(n, 1);
      c.name = n;
    }
    return cols;
  }

  let colSeq = 0;
  const newColId = () => 'c' + Date.now().toString(36) + (colSeq++).toString(36);

  function makeColumn(name, selector, index, type, attr) {
    return { id: newColId(), name, selector: selector || '', index: index || 0, type: type || 'text', attr: attr || '' };
  }

  /** Builds a column definition for an element inside an item (used by click-to-add). */
  function columnFor(item, el, type) {
    const rel = relativeSelector(item, el);
    if (!rel) return null;
    let t = type;
    if (!t) {
      if (el.tagName === 'IMG' || (!textOf(el) && el.querySelector('img'))) t = 'src';
      else t = 'text';
    }
    return makeColumn(nameFor(el, t, item), rel.selector, rel.index, t);
  }

  function tableColumns(rows, table) {
    const doc = table.ownerDocument;
    let headers = [];
    const headRow = table.querySelector(':scope > thead > tr') ||
      Array.from(table.rows).find((r) => r.cells.length && Array.from(r.cells).every((c) => c.tagName === 'TH'));
    if (headRow) headers = Array.from(headRow.cells).map((c) => textOf(c));
    const width = Math.min(40, Math.max(...rows.slice(0, 50).map((r) => r.cells.length), headers.length));
    const cols = [];
    const sample = rows.slice(0, 100);
    for (let k = 0; k < width; k++) {
      const name = headers[k] || `Column ${k + 1}`;
      cols.push(makeColumn(name, ':scope > :is(td, th)', k, 'text'));
      let links = 0; let imgs = 0;
      for (const r of sample) {
        const cell = r.cells[k];
        if (!cell) continue;
        if (cell.querySelector('a[href]:not([href^="#"]):not([href^="javascript:"])')) links++;
        if (cell.querySelector('img')) imgs++;
      }
      if (links >= sample.length * 0.5) cols.push(makeColumn(name + ' link', ':scope > :is(td, th)', k, 'href'));
      if (imgs >= sample.length * 0.5) cols.push(makeColumn(name + ' image', ':scope > :is(td, th)', k, 'src'));
    }
    void doc;
    return uniqueNames(cols);
  }

  /** Infers useful columns from a set of similar items (text leaves, links, images). */
  function inferColumns(items, base) {
    if (!items.length) return [];
    if (items[0].tagName === 'TR') {
      const table = items[0].closest('table');
      if (table) return tableColumns(items, table);
    }
    const sample = items.length > 150 ? items.filter((_, i) => i % Math.ceil(items.length / 150) === 0) : items;
    const fields = new Map(); // key -> {selector,index,type,el,count,pos}
    for (const item of sample) {
      const seenInItem = new Set();
      const walker = item.ownerDocument.createTreeWalker(item, 1);
      let el = item; let pos = 0; let visited = 0;
      while (el && visited < 400) {
        visited++;
        if (!SKIP_TAGS.has(el.tagName) && el.tagName !== 'svg' && el.tagName !== 'SVG') {
          const kinds = [];
          if (hasOwnText(el) && !/^(SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) kinds.push('text');
          if (el.tagName === 'A' && el.getAttribute('href') && !/^(#|javascript:)/i.test(el.getAttribute('href'))) kinds.push('href');
          if (el.tagName === 'IMG' && (el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('srcset'))) kinds.push('src');
          if (kinds.length) {
            const rel = relativeSelector(item, el);
            if (rel) {
              for (const kind of kinds) {
                const key = rel.selector + '|' + rel.index + '|' + kind;
                if (seenInItem.has(key)) continue;
                seenInItem.add(key);
                let f = fields.get(key);
                if (!f) { f = { selector: rel.selector, index: rel.index, type: kind, el, item, count: 0, pos: 0 }; fields.set(key, f); }
                f.count++; f.pos += pos;
              }
            }
          }
        }
        pos++;
        el = walker.nextNode();
      }
    }
    const minCount = Math.max(1, Math.ceil(sample.length * (sample.length >= 5 ? 0.25 : 0.5)));
    let cand = Array.from(fields.values()).filter((f) => f.count >= minCount)
      .sort((a, b) => a.pos / a.count - b.pos / b.count);
    // Compute value vectors to drop duplicates, empties and constants.
    const vecSample = sample.slice(0, 60);
    const out = []; const seenVec = new Set();
    for (const f of cand) {
      const col = makeColumn('', f.selector, f.index, f.type);
      const vals = vecSample.map((it) => valueOf(it, col, base));
      if (vals.every((v) => !v)) continue;
      const vec = vals.join('\u0001');
      if (seenVec.has(vec)) continue;
      const distinct = new Set(vals).size;
      if (f.type === 'text' && vecSample.length >= 4 && distinct === 1 && vals[0].length < 30) continue;
      if (f.type === 'text' && vals.every((v) => v.length > 2000)) continue;
      seenVec.add(vec);
      col.name = nameFor(f.el, f.type, f.item);
      out.push(col);
      if (out.length >= 30) break;
    }
    // Text of a container that equals the concatenation of its children is redundant if children are columns.
    return uniqueNames(out);
  }

  // ---------- auto-detection ----------

  function pathSet(item, limit = 150) {
    const set = new Set();
    const walker = item.ownerDocument.createTreeWalker(item, 1);
    let el = walker.nextNode(); let n = 0;
    while (el && n < limit) {
      let p = ''; let cur = el; let d = 0;
      while (cur && cur !== item && d < 6) { p = signature(cur) + '/' + p; cur = cur.parentElement; d++; }
      set.add(p);
      el = walker.nextNode(); n++;
    }
    return set;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function similarity(items) {
    const step = Math.max(1, Math.floor(items.length / 10));
    const sample = [];
    for (let i = 0; i < items.length && sample.length < 10; i += step) sample.push(pathSet(items[i]));
    if (sample.length < 2) return 1;
    let total = 0;
    for (let i = 1; i < sample.length; i++) total += jaccard(sample[0], sample[i]);
    return total / (sample.length - 1);
  }

  function itemArea(items) {
    if (items[0].ownerDocument !== globalThis.document) return items.length * 20000;
    const vw = globalThis.innerWidth || 1280;
    let total = 0;
    for (let i = 0; i < items.length && i < 400; i++) {
      const r = items[i].getBoundingClientRect();
      total += Math.min(r.width, vw) * Math.min(r.height, 1200);
    }
    if (items.length > 400) total *= items.length / 400;
    return total;
  }

  function commonClasses(items) {
    let common = stableClasses(items[0]);
    for (const it of items.slice(1, 50)) {
      const cls = new Set(stableClasses(it));
      common = common.filter((c) => cls.has(c));
      if (!common.length) break;
    }
    return common;
  }

  function scoreCandidate(items, columns, isTable) {
    const n = items.length;
    const area = itemArea(items);
    const sim = isTable ? 1 : similarity(items);
    let textLen = 0;
    for (const it of items.slice(0, 30)) textLen += textOf(it).length;
    textLen /= Math.min(30, n);
    const fieldCount = Math.max(1, Math.min(columns.length, 10));
    let score = Math.sqrt(area) * Math.log2(n + 1) * (0.35 + sim) * Math.sqrt(fieldCount);
    if (textLen < 3 && !columns.some((c) => c.type === 'src')) score *= 0.2;
    // Navigation menus: just a link per item.
    if (columns.length <= 2 && columns.some((c) => c.type === 'href') && textLen < 25) score *= 0.35;
    const inNav = items[0].closest('nav, header, footer, [role="navigation"], [role="menu"], [role="menubar"]');
    if (inNav) score *= 0.3;
    if (isTable) score *= 1.3;
    return { score, sim };
  }

  function describe(c) {
    if (c.kind === 'table') return `Table: ${c.count} rows × ${c.columns.length} columns`;
    const tag = c.itemSelector.split('>').pop().trim();
    return `${tag.length > 40 ? tag.slice(0, 40) + '…' : tag}: ${c.count} items × ${c.columns.length} columns`;
  }

  /** Finds repeating data containers (tables and sibling groups), best first. */
  function detect(doc = document, opts = {}) {
    const base = doc.baseURI;
    const max = opts.max || 12;
    const bySelector = new Map();
    const add = (itemSelector, kind) => {
      if (!itemSelector || bySelector.has(itemSelector)) return;
      const items = safeQueryAll(doc, itemSelector).filter((el) => !el.closest('page-scraper-ui'));
      if (items.length < 2) return;
      const vis = items.filter(isVisible);
      if (vis.length < Math.max(2, items.length * 0.5)) return;
      const columns = inferColumns(items, base);
      if (!columns.length) return;
      const { score, sim } = scoreCandidate(vis, columns, kind === 'table');
      bySelector.set(itemSelector, { itemSelector, kind, count: items.length, columns, score, sim });
    };

    // Tables
    for (const table of doc.querySelectorAll('table')) {
      if (table.closest('page-scraper-ui')) continue;
      const rows = Array.from(table.rows).filter((r) => r.closest('table') === table && Array.from(r.cells).some((c) => c.tagName === 'TD'));
      if (rows.length < 2) continue;
      if (Math.max(...rows.map((r) => r.cells.length)) < 2 && rows.length < 3) continue;
      const tsel = preciseSelector(table);
      const containers = new Set(rows.map((r) => r.parentElement.tagName.toLowerCase()));
      const sel = containers.size === 1
        ? `${tsel} > ${[...containers][0]} > tr:has(> td)`
        : `${tsel} tr:has(> td)`;
      add(sel, 'table');
    }

    // Repeated sibling structures
    const all = doc.body ? doc.body.getElementsByTagName('*') : [];
    const limit = Math.min(all.length, MAX_ELEMENTS);
    for (let i = 0; i < limit; i++) {
      const parent = all[i];
      if (parent.children.length < 3 || SKIP_TAGS.has(parent.tagName) || TABLE_PARTS.has(parent.tagName)) continue;
      if (parent.tagName === 'SELECT' || parent.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      const groups = new Map();
      for (const child of parent.children) {
        if (SKIP_TAGS.has(child.tagName)) continue;
        const key = tagOf(child);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(child);
      }
      for (const [tag, members] of groups) {
        if (members.length < 3) continue;
        // Split by class signature, but keep same-tag siblings together when they share classes.
        const common = commonClasses(members);
        let items = members;
        let childTok = tag + common.map((c) => '.' + esc(c)).join('');
        if (!common.length) {
          const bySig = new Map();
          for (const m of members) { const s = signature(m); if (!bySig.has(s)) bySig.set(s, []); bySig.get(s).push(m); }
          const biggest = [...bySig.values()].sort((a, b) => b.length - a.length)[0];
          if (biggest.length >= 3 && biggest.length < members.length * 0.8) {
            items = biggest; childTok = token(biggest[0]);
          }
        }
        if (items.length < 3) continue;
        if (!items.some((el) => textOf(el).length > 0 || el.querySelector('img'))) continue;
        const psel = preciseSelector(parent);
        add(psel + ' > ' + childTok, 'list');
        // Broader structural variant catches grids split across several rows/containers.
        const broad = structuralSelector(items[0]);
        const broadCount = safeQueryAll(doc, broad).length;
        if (broadCount > items.length && broadCount <= 5000) add(broad, 'list');
      }
    }

    const list = [...bySelector.values()].sort((a, b) => b.score - a.score);
    // Drop near-duplicates: same count and nested containers.
    const out = [];
    for (const c of list) {
      const first = safeQueryAll(doc, c.itemSelector)[0];
      const dup = out.some((o) => {
        if (o.count !== c.count) return false;
        const of = safeQueryAll(doc, o.itemSelector)[0];
        return of && first && (of.contains(first) || first.contains(of));
      });
      if (dup) continue;
      c.label = describe(c);
      out.push(c);
      if (out.length >= max) break;
    }
    return out;
  }

  // ---------- manual generalization ----------

  /** For a clicked element, list the ancestor levels that repeat on the page and pick a sensible default. */
  function generalize(el) {
    const doc = el.ownerDocument;
    const levels = [];
    let cur = el;
    while (cur && cur !== doc.body && cur !== doc.documentElement) {
      let selector;
      if (cur.tagName === 'TR') {
        const table = cur.closest('table');
        selector = table ? `${preciseSelector(table)} tr:has(> td)` : 'tr';
      } else selector = structuralSelector(cur);
      const count = safeQueryAll(doc, selector).length;
      if (count >= 1) levels.push({ selector, count, el: cur });
      cur = cur.parentElement;
    }
    if (!levels.length) return { levels: [{ selector: preciseSelector(el), count: 1, el }], index: 0 };
    const c0 = levels[0].count;
    let index = 0;
    const tr = levels.findIndex((l) => l.el.tagName === 'TR' && l.count >= 2);
    if (tr >= 0) index = tr;
    else if (c0 >= 2) {
      for (let i = 1; i < levels.length; i++) {
        const l = levels[i];
        if (l.count < 2 || l.count > c0) break;
        if (l.count >= c0 * 0.6) index = i; else break;
      }
    } else {
      const firstRepeat = levels.findIndex((l) => l.count >= 2);
      if (firstRepeat >= 0) index = firstRepeat;
    }
    return { levels, index };
  }

  // ---------- pagination ----------

  const NEXT_TEXT = /^(next|next page|next ›|next »|next >|›|»|>|→|›››|older|older posts|more|load more|show more|see more|weiter|suivant|siguiente|próxima|nächste|次へ|下一页)$/i;

  function isDisabled(el) {
    if (!el) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    const li = el.closest('li');
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      /(^|\s|-)disabled(\s|$)/i.test(cls) ||
      (li && /(^|\s)disabled(\s|$)/.test(li.className)));
  }

  function clickable(el) {
    return el.closest('a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]') || el;
  }

  function describeNext(el) {
    const target = clickable(el);
    return {
      selector: preciseSelector(target),
      structural: structuralSelector(target),
      text: collapse(target.textContent || target.value || '').slice(0, 60),
      rel: (target.getAttribute('rel') || '').toLowerCase(),
      aria: target.getAttribute('aria-label') || '',
    };
  }

  function candidateNexts(doc) {
    return safeQueryAll(doc, 'a, button, [role="button"], input[type="button"], input[type="submit"]')
      .filter((el) => !el.closest('page-scraper-ui'));
  }

  function findNext(doc, desc) {
    const ok = (el) => el && !isDisabled(el) && isVisible(el);
    if (desc) {
      if (desc.rel && /next/.test(desc.rel)) {
        const r = doc.querySelector('a[rel~="next"]');
        if (ok(r)) return r;
      }
      const exact = safeQueryAll(doc, desc.selector).find(ok);
      if (exact && (!desc.text || collapse(exact.textContent || exact.value) === desc.text || !collapse(exact.textContent))) return exact;
      const textMatch = (el) => desc.text && collapse(el.textContent || el.value) === desc.text;
      const ariaMatch = (el) => desc.aria && el.getAttribute('aria-label') === desc.aria;
      const structural = safeQueryAll(doc, desc.structural).filter(ok);
      const s = structural.find((el) => textMatch(el) || ariaMatch(el));
      if (s) return s;
      const any = candidateNexts(doc).find((el) => ok(el) && (ariaMatch(el) || textMatch(el)));
      if (any) return any;
      if (exact) return exact;
      return null;
    }
    return autoFindNext(doc);
  }

  function autoFindNext(doc) {
    const ok = (el) => el && !isDisabled(el) && isVisible(el);
    const rel = safeQueryAll(doc, 'a[rel~="next"]').find(ok);
    if (rel) return rel;
    const els = candidateNexts(doc).filter(ok);
    const byAria = els.find((el) => /^(next|next page|go to next page)$/i.test((el.getAttribute('aria-label') || el.getAttribute('title') || '').trim()));
    if (byAria) return byAria;
    const byText = els.find((el) => NEXT_TEXT.test(collapse(el.textContent || el.value)));
    if (byText) return byText;
    return els.find((el) => /(^|[\s_-])(next|pagination-next|pager-next)([\s_-]|$)/i.test(typeof el.className === 'string' ? el.className : '')) || null;
  }

  function rowKey(row) { return JSON.stringify(row); }

  globalThis.PSCore = {
    detect, extract, inferColumns, generalize, columnFor, makeColumn, valueOf, resolveEl,
    preciseSelector, structuralSelector, relativeSelector, safeQueryAll, textOf, absUrl, linkHref,
    imageSrc, findNext, autoFindNext, describeNext, isDisabled, clickable, uniqueNames, rowKey, collapse,
  };
})();
