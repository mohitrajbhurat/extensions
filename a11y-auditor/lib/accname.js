/* Accessibility Auditor - roles, visibility, selectors and accessible name computation.
 * A pragmatic subset of HTML-AAM and accname 1.2. Exposes window.A11Y.dom
 */
(function (root) {
  'use strict';
  const A11Y = (root.A11Y = root.A11Y || {});
  if (A11Y.dom) return;

  const FOCUSABLE_SELECTOR = [
    'a[href]', 'area[href]', 'button', 'input', 'select', 'textarea', 'summary',
    'iframe', 'object', 'embed', 'audio[controls]', 'video[controls]',
    '[tabindex]', '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');

  const INPUT_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    password: 'textbox', search: 'searchbox', hidden: null,
    date: 'textbox', 'datetime-local': 'textbox', month: 'textbox', week: 'textbox',
    time: 'textbox', color: 'button', file: 'button',
  };

  const SECTIONING = new Set(['ARTICLE', 'ASIDE', 'NAV', 'SECTION', 'MAIN']);

  function tag(el) {
    return el && el.nodeType === 1 ? el.tagName.toUpperCase() : '';
  }

  function attr(el, name) {
    return el && el.getAttribute ? el.getAttribute(name) : null;
  }

  function trimText(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  /** Implicit ARIA role per HTML-AAM (subset). */
  function implicitRole(el) {
    const t = tag(el);
    switch (t) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href') ? 'link' : 'generic';
      case 'ARTICLE': return 'article';
      case 'ASIDE': return 'complementary';
      case 'BLOCKQUOTE': return 'blockquote';
      case 'BUTTON': return 'button';
      case 'CAPTION': return 'caption';
      case 'CODE': return 'code';
      case 'DATALIST': return 'listbox';
      case 'DD': return 'definition';
      case 'DEL': return 'deletion';
      case 'DETAILS': return 'group';
      case 'DFN': return 'term';
      case 'DIALOG': return 'dialog';
      case 'DT': return 'term';
      case 'EM': return 'emphasis';
      case 'FIELDSET': return 'group';
      case 'FIGURE': return 'figure';
      case 'FOOTER': return isTopLevelLandmark(el) ? 'contentinfo' : 'generic';
      case 'FORM': return 'form';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'HEADER': return isTopLevelLandmark(el) ? 'banner' : 'generic';
      case 'HGROUP': return 'group';
      case 'HR': return 'separator';
      case 'IMG': {
        const alt = attr(el, 'alt');
        if (alt === '') return 'presentation';
        return 'img';
      }
      case 'INPUT': {
        const type = (attr(el, 'type') || 'text').toLowerCase();
        if (type === 'text' && el.hasAttribute('list')) return 'combobox';
        return Object.prototype.hasOwnProperty.call(INPUT_ROLE, type) ? INPUT_ROLE[type] : 'textbox';
      }
      case 'INS': return 'insertion';
      case 'LI': return 'listitem';
      case 'MAIN': return 'main';
      case 'MATH': return 'math';
      case 'MENU': case 'UL': case 'OL': return 'list';
      case 'METER': return 'meter';
      case 'NAV': return 'navigation';
      case 'OPTGROUP': return 'group';
      case 'OPTION': return 'option';
      case 'OUTPUT': return 'status';
      case 'P': return 'paragraph';
      case 'PROGRESS': return 'progressbar';
      case 'SEARCH': return 'search';
      case 'SECTION': return 'region';
      case 'SELECT':
        return el.multiple || (parseInt(attr(el, 'size'), 10) || 1) > 1 ? 'listbox' : 'combobox';
      case 'STRONG': return 'strong';
      case 'SUB': return 'subscript';
      case 'SUP': return 'superscript';
      case 'SUMMARY': return 'button';
      case 'SVG': return 'graphics-document';
      case 'TABLE': return 'table';
      case 'TBODY': case 'TFOOT': case 'THEAD': return 'rowgroup';
      case 'TD': return 'cell';
      case 'TEXTAREA': return 'textbox';
      case 'TH': {
        const scope = (attr(el, 'scope') || '').toLowerCase();
        if (scope === 'row') return 'rowheader';
        return 'columnheader';
      }
      case 'TIME': return 'time';
      case 'TR': return 'row';
      case 'DIV': case 'SPAN': return 'generic';
      default: return null;
    }
  }

  function isTopLevelLandmark(el) {
    let p = el.parentElement;
    while (p) {
      if (SECTIONING.has(tag(p))) return false;
      p = p.parentElement;
    }
    return true;
  }

  /** Effective role: first valid token of the role attribute, else implicit. */
  function role(el) {
    const explicit = trimText(attr(el, 'role')).toLowerCase();
    if (explicit) {
      const tokens = explicit.split(/\s+/);
      for (const token of tokens) {
        if (A11Y.aria.isValidRole(token)) return token;
      }
    }
    return implicitRole(el);
  }

  function styleOf(el) {
    try {
      return (el.ownerDocument.defaultView || root).getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  /** Rendered (takes up space and is painted). */
  function isRendered(el) {
    if (!el || el.nodeType !== 1) return false;
    if (tag(el) === 'AREA') return true; // map areas have no box
    const st = styleOf(el);
    if (!st) return false;
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (parseFloat(st.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Zero-size is still "rendered" for things like <input type=hidden>-less wrappers;
      // treat as not rendered unless it has overflow-visible children.
      if (!el.firstElementChild) return false;
    }
    return true;
  }

  function isOffscreen(el) {
    const rect = el.getBoundingClientRect();
    const doc = el.ownerDocument;
    const win = doc.defaultView || root;
    const w = Math.max(doc.documentElement.clientWidth || 0, win.innerWidth || 0);
    if (rect.width === 0 && rect.height === 0) return true;
    if (rect.right <= 0 || rect.bottom <= -1) return true;
    if (rect.left >= w) return true;
    // Classic visually-hidden pattern: 1px clipped box.
    const st = styleOf(el);
    if (st && /rect\(/.test(st.clip) && rect.width <= 1 && rect.height <= 1) return true;
    return false;
  }

  /** Excluded from the accessibility tree. */
  function isHiddenFromAT(el) {
    if (!el || el.nodeType !== 1) return true;
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.hasAttribute('hidden')) return true;
      if (trimText(attr(node, 'aria-hidden')).toLowerCase() === 'true') return true;
      if (node.inert === true) return true;
      const st = styleOf(node);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse')) return true;
      if (tag(node) === 'DETAILS' && !node.open && node !== el) {
        const summary = node.querySelector(':scope > summary');
        if (!summary || !summary.contains(el)) return true;
      }
      const parent = node.parentElement;
      if (!parent) {
        const r = node.getRootNode && node.getRootNode();
        node = r && r.host ? r.host : null;
      } else {
        node = parent;
      }
    }
    return false;
  }

  function isDisabled(el) {
    if (el.disabled === true) return true;
    if (trimText(attr(el, 'aria-disabled')).toLowerCase() === 'true') return true;
    const fs = el.closest && el.closest('fieldset[disabled]');
    return !!fs;
  }

  function tabIndexValue(el) {
    const raw = attr(el, 'tabindex');
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  }

  /** Keyboard focusable (approximation of the sequential focus navigation rules). */
  function isFocusable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isDisabled(el) && !/^(A|AREA)$/.test(tag(el))) return false;
    const ti = tabIndexValue(el);
    if (ti != null) return ti >= 0 ? true : false;
    if (!el.matches) return false;
    if (tag(el) === 'INPUT' && (attr(el, 'type') || '').toLowerCase() === 'hidden') return false;
    return el.matches(FOCUSABLE_SELECTOR);
  }

  function isInTabOrder(el) {
    const ti = tabIndexValue(el);
    if (ti != null && ti < 0) return false;
    return isFocusable(el) && !isHiddenFromAT(el);
  }

  function idRefs(el, name) {
    const raw = trimText(attr(el, name));
    if (!raw) return [];
    const doc = el.getRootNode ? el.getRootNode() : el.ownerDocument;
    return raw.split(/\s+/).map((id) => ({
      id,
      el: (doc.getElementById ? doc.getElementById(id) : null) || el.ownerDocument.getElementById(id),
    }));
  }

  function labelsFor(el) {
    const out = [];
    const id = attr(el, 'id');
    if (id) {
      try {
        const doc = el.ownerDocument;
        doc.querySelectorAll('label[for]').forEach((l) => {
          if (l.getAttribute('for') === id) out.push(l);
        });
      } catch (e) { /* ignore */ }
    }
    const wrapping = el.closest ? el.closest('label') : null;
    if (wrapping && out.indexOf(wrapping) === -1) out.push(wrapping);
    return out;
  }

  const LABELABLE = /^(BUTTON|INPUT|METER|OUTPUT|PROGRESS|SELECT|TEXTAREA)$/;

  /** Text from an element subtree, following accname's content rules. */
  function subtreeText(el, ctx) {
    if (!el) return '';
    if (ctx.visited.has(el)) return '';
    ctx.visited.add(el);
    if (!ctx.ignoreHidden && isHiddenFromAT(el)) return '';
    let out = '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3) {
        out += n.nodeValue;
      } else if (n.nodeType === 1) {
        out += ' ' + nameFromNode(n, ctx) + ' ';
      }
    }
    const st = styleOf(el);
    if (st) {
      const before = (el.ownerDocument.defaultView || root).getComputedStyle(el, '::before').content;
      const after = (el.ownerDocument.defaultView || root).getComputedStyle(el, '::after').content;
      // Only literal strings count; counters, attr() and url() are ignored.
      const clean = (c) => {
        const m = /^"((?:[^"\\]|\\.)*)"$/.exec(c || '');
        return m ? m[1].replace(/\\(.)/g, '$1') : '';
      };
      out = clean(before) + out + clean(after);
    }
    return out;
  }

  function nameFromNode(el, ctx) {
    if (!el || el.nodeType !== 1) return '';
    if (!ctx.ignoreHidden && isHiddenFromAT(el)) return '';
    const r = role(el);
    // Embedded controls contribute their value.
    const t = tag(el);
    if (t === 'INPUT') {
      const type = (attr(el, 'type') || 'text').toLowerCase();
      if (type === 'image') return trimText(attr(el, 'alt') || attr(el, 'aria-label') || '');
      if (/^(button|submit|reset)$/.test(type)) return trimText(el.value || attr(el, 'aria-label') || type);
      if (/^(text|email|tel|url|search|password|number)$/.test(type)) return trimText(el.value || '');
      if (/^(checkbox|radio)$/.test(type)) return '';
    }
    if (t === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return opt ? trimText(opt.textContent) : '';
    }
    if (t === 'TEXTAREA') return trimText(el.value || '');
    if (t === 'IMG') return trimText(attr(el, 'alt') || '');
    if (t === 'BR') return ' ';
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(t)) return '';
    if (t === 'SVG') {
      const lbl = trimText(attr(el, 'aria-label'));
      if (lbl) return lbl;
      const title = el.querySelector('title');
      return title ? trimText(title.textContent) : '';
    }
    if (r === 'presentation' || r === 'none') return subtreeText(el, ctx);
    const own = trimText(attr(el, 'aria-label'));
    const labelled = idRefs(el, 'aria-labelledby');
    if (labelled.length && !ctx.noRecurse) {
      const parts = labelled.map((x) => (x.el ? subtreeText(x.el, { visited: ctx.visited, ignoreHidden: true, noRecurse: true }) : ''));
      const joined = trimText(parts.join(' '));
      if (joined) return joined;
    }
    if (own) return own;
    return subtreeText(el, ctx);
  }

  /**
   * Accessible name for an element. Returns { name, source }.
   * source is one of: aria-labelledby, aria-label, label, legend, caption,
   * alt, value, title, placeholder, content, none
   */
  function accessibleName(el) {
    if (!el || el.nodeType !== 1) return { name: '', source: 'none' };
    const r = role(el);
    const t = tag(el);
    if (A11Y.aria.NO_NAME_ROLES.has(r) && !attr(el, 'aria-label') && !attr(el, 'aria-labelledby')) {
      // Name prohibited and none authored.
      if (t !== 'IMG') return { name: '', source: 'prohibited' };
    }

    // 1. aria-labelledby
    const labelled = idRefs(el, 'aria-labelledby');
    if (labelled.length) {
      const resolved = labelled.filter((x) => x.el);
      if (resolved.length) {
        const text = trimText(resolved
          .map((x) => subtreeText(x.el, { visited: new Set([el]), ignoreHidden: true, noRecurse: true }))
          .join(' '));
        if (text) return { name: text, source: 'aria-labelledby' };
      }
    }
    // 2. aria-label
    const ariaLabel = trimText(attr(el, 'aria-label'));
    if (ariaLabel) return { name: ariaLabel, source: 'aria-label' };

    // 3. Native host-language labels
    if (LABELABLE.test(t) || /^(checkbox|radio)$/.test((attr(el, 'type') || '').toLowerCase())) {
      const labels = labelsFor(el);
      for (const l of labels) {
        const text = trimText(subtreeText(l, { visited: new Set([el]), ignoreHidden: false }));
        if (text) return { name: text, source: 'label' };
      }
    }
    if (t === 'IMG' || t === 'AREA' || (t === 'INPUT' && (attr(el, 'type') || '').toLowerCase() === 'image')) {
      const alt = attr(el, 'alt');
      if (alt != null && trimText(alt)) return { name: trimText(alt), source: 'alt' };
    }
    if (t === 'INPUT') {
      const type = (attr(el, 'type') || 'text').toLowerCase();
      if (/^(button|submit|reset)$/.test(type)) {
        const v = trimText(el.getAttribute('value'));
        if (v) return { name: v, source: 'value' };
        if (type !== 'button') return { name: type === 'submit' ? 'Submit' : 'Reset', source: 'default' };
      }
    }
    if (t === 'FIELDSET') {
      const legend = el.querySelector('legend');
      if (legend) {
        const text = trimText(subtreeText(legend, { visited: new Set([el]), ignoreHidden: false }));
        if (text) return { name: text, source: 'legend' };
      }
    }
    if (t === 'TABLE') {
      const cap = el.querySelector('caption');
      if (cap) {
        const text = trimText(subtreeText(cap, { visited: new Set([el]), ignoreHidden: false }));
        if (text) return { name: text, source: 'caption' };
      }
    }
    if (t === 'FIGURE') {
      const cap = el.querySelector('figcaption');
      if (cap) {
        const text = trimText(subtreeText(cap, { visited: new Set([el]), ignoreHidden: false }));
        if (text) return { name: text, source: 'figcaption' };
      }
    }
    if (t === 'SVG') {
      const title = el.querySelector('title');
      if (title) {
        const text = trimText(title.textContent);
        if (text) return { name: text, source: 'svg-title' };
      }
    }
    if (t === 'IFRAME' || t === 'FRAME') {
      const ti = trimText(attr(el, 'title'));
      if (ti) return { name: ti, source: 'title' };
    }

    // 4. Name from content, for roles that allow it
    const def = A11Y.aria.ROLES[r];
    const nameFromContent = (def && def.nameFrom === 'content') ||
      /^(H1|H2|H3|H4|H5|H6|A|BUTTON|SUMMARY|TD|TH|LABEL|LEGEND|CAPTION|FIGCAPTION|OPTION)$/.test(t);
    if (nameFromContent) {
      const text = trimText(subtreeText(el, { visited: new Set(), ignoreHidden: false }));
      if (text) return { name: text, source: 'content' };
    }

    // 5. title
    const title = trimText(attr(el, 'title'));
    if (title) return { name: title, source: 'title' };

    // 6. placeholder (inputs only, last resort)
    if (/^(INPUT|TEXTAREA)$/.test(t)) {
      const ph = trimText(attr(el, 'placeholder')) || trimText(attr(el, 'aria-placeholder'));
      if (ph) return { name: ph, source: 'placeholder' };
    }

    return { name: '', source: 'none' };
  }

  function accessibleDescription(el) {
    const described = idRefs(el, 'aria-describedby').filter((x) => x.el);
    if (described.length) {
      return trimText(described.map((x) => subtreeText(x.el, { visited: new Set(), ignoreHidden: true, noRecurse: true })).join(' '));
    }
    const d = trimText(attr(el, 'aria-description'));
    if (d) return d;
    const name = accessibleName(el);
    const title = trimText(attr(el, 'title'));
    if (title && name.source !== 'title') return title;
    return '';
  }

  function cssEscape(value) {
    if (root.CSS && root.CSS.escape) return root.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  /** Short, stable-ish CSS selector for display and re-finding the element. */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === el.ownerDocument.documentElement) return 'html';
    if (el === el.ownerDocument.body) return 'body';
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth++ < 8) {
      let part = node.tagName.toLowerCase();
      const id = node.getAttribute('id');
      if (id && /^[A-Za-z][\w-]*$/.test(id)) {
        parts.unshift('#' + id);
        break;
      }
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      if (node === el.ownerDocument.body) break;
    }
    return parts.join(' > ');
  }

  /** Opening tag plus a little content, for the issue list. */
  function snippetFor(el, max) {
    if (!el || el.nodeType !== 1) return '';
    const limit = max || 160;
    let html = '';
    try {
      html = el.cloneNode(false).outerHTML || '';
      const open = html.replace(/<\/[a-z0-9-]+>$/i, '');
      const text = trimText(el.textContent).slice(0, 60);
      html = open + (text ? text + '</' + el.tagName.toLowerCase() + '>' : '');
    } catch (e) {
      html = '<' + el.tagName.toLowerCase() + '>';
    }
    return html.length > limit ? html.slice(0, limit - 1) + '…' : html;
  }

  function hasVisibleText(el) {
    if (!el) return false;
    const walker = el.ownerDocument.createTreeWalker(el, 4 /* TEXT */, null);
    let n;
    while ((n = walker.nextNode())) {
      if (!trimText(n.nodeValue)) continue;
      const p = n.parentElement;
      if (p && !isHiddenFromAT(p)) return true;
    }
    return false;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  A11Y.dom = {
    tag, attr, trimText, role, implicitRole, styleOf, isRendered, isOffscreen,
    isHiddenFromAT, isDisabled, isFocusable, isInTabOrder, tabIndexValue, idRefs,
    labelsFor, accessibleName, accessibleDescription,
    selectorFor, snippetFor, hasVisibleText, rectOf, subtreeText, FOCUSABLE_SELECTOR,
  };
})(typeof window !== 'undefined' ? window : self);
