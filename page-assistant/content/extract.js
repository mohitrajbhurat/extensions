// Page Assistant: readable-content extraction. Injected on demand with
// chrome.scripting.executeScript (isolated world). Defines globalThis.__PA_extract().
// The algorithm scores text blocks by length, commas, tag and class hints and link
// density, picks the best content container (plus related siblings), then walks it
// emitting clean blocks while dropping boilerplate subtrees.
(() => {
  if (globalThis.__PA_extract) return;

  const UNLIKELY = /-ad-|\bads?\b|adsbygoogle|advert|agegate|banner|breadcrumb|combx|comment|community|consent|cookie|cover-wrap|disqus|footer|gdpr|legends|menu|modal|newsletter|outbrain|pager|pagination|popup|promo|related|remark|replies|rss|share|sharing|shoutbox|sidebar|skyscraper|social|sponsor|subscribe|supplemental|taboola|toolbar|tweet|widget|signup|paywall|recommend|trending|most-popular|read-next|jump-link|skip-link|toc-mobile/i;
  const MAYBE = /and|article|body|column|content|main|post|entry|story|prose|markdown|text|blog/i;
  const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|prose|markdown|e-content|post-body|article-body/i;
  const NEGATIVE = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|nav|menu|social|subscribe|newsletter|cookie|byline|author-bio|breadcrumb/i;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'NAV', 'ASIDE', 'DIALOG', 'MENU', 'LINK', 'META', 'HEAD', 'VIDEO', 'AUDIO', 'MAP', 'IMG', 'PICTURE', 'SOURCE', 'LABEL']);
  const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'menu', 'menubar', 'search', 'dialog', 'alertdialog', 'alert', 'tablist', 'toolbar', 'tooltip']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'HR', 'HEADER', 'FOOTER', 'ADDRESS', 'DETAILS', 'SUMMARY', 'CENTER', 'FORM', 'FIELDSET', 'HGROUP', 'CAPTION']);
  const PARA_TAGS = new Set(['P', 'PRE', 'TD', 'BLOCKQUOTE', 'DD', 'LI', 'FIGCAPTION']);
  const BOILER_TEXT = /^(advertisement|ad|sponsored( content)?|share( this( article| story)?)?( on \w+)?|tweet|subscribe( now)?|sign up|log ?in|read more|continue reading|related( articles| stories)?|comments?( \(\d+\))?|show comments|skip to (main )?content|back to top|print|email|copy link|follow us)\.?$/i;

  const norm = (s) => String(s || '').replace(/[\s ​]+/g, ' ').trim();
  const classId = (el) => {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return c + ' ' + (el.id || '');
  };

  function isHidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (el.checkVisibility) {
      // Collapsed <details> content still counts as readable content.
      if (!el.checkVisibility({ visibilityProperty: true }) && !el.closest('details:not([open])')) return true;
      return false;
    }
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function inContentLandmark(el) {
    return !!el.closest('article, main, [role="main"], [itemprop="articleBody"]');
  }

  // Elements whose subtree is never content.
  function isJunk(el, strict) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return !(tag === 'ASIDE' && inContentLandmark(el) && /pull|quote|note|callout|info|tip|warning/i.test(classId(el)));
    if (tag === 'MATH') return false;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    if ((tag === 'HEADER' || tag === 'FOOTER') && !inContentLandmark(el)) return true;
    if (tag === 'FOOTER' && el.closest('article') && el.parentElement && el.parentElement.closest('article')) return true;
    if (isHidden(el)) return true;
    if (strict && tag !== 'BODY' && tag !== 'HTML' && tag !== 'ARTICLE' && tag !== 'MAIN') {
      const ci = classId(el);
      if (UNLIKELY.test(ci) && !MAYBE.test(ci) && !el.querySelector('article, main')) return true;
    }
    return false;
  }

  function textOf(el) { return norm(el.textContent); }

  function linkDensity(el, text) {
    const len = (text || textOf(el)).length;
    if (!len) return 0;
    let linkLen = 0;
    for (const a of el.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      const coef = href.startsWith('#') ? 0.3 : 1;
      linkLen += norm(a.textContent).length * coef;
    }
    return Math.min(1, linkLen / len);
  }

  function classWeight(el) {
    let w = 0;
    const c = typeof el.className === 'string' ? el.className : '';
    if (c) { if (NEGATIVE.test(c)) w -= 25; if (POSITIVE.test(c)) w += 25; }
    if (el.id) { if (NEGATIVE.test(el.id)) w -= 25; if (POSITIVE.test(el.id)) w += 25; }
    if (el.getAttribute('itemprop') === 'articleBody') w += 40;
    return w;
  }

  function initScore(el) {
    let s = 0;
    switch (el.tagName) {
      case 'ARTICLE': s += 10; break;
      case 'MAIN': s += 8; break;
      case 'DIV': s += 5; break;
      case 'SECTION': s += 3; break;
      case 'PRE': case 'TD': case 'BLOCKQUOTE': s += 3; break;
      case 'ADDRESS': case 'OL': case 'UL': case 'DL': case 'DD': case 'DT': case 'LI': case 'FORM': s -= 3; break;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': case 'TH': s -= 5; break;
      default: break;
    }
    return s + classWeight(el);
  }

  // Direct inline text of a container (text nodes + inline children), used to treat
  // "div soup" pages like paragraphs.
  function ownInlineText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) t += n.nodeValue;
      else if (n.nodeType === 1 && !BLOCK_TAGS.has(n.tagName) && !SKIP_TAGS.has(n.tagName)) t += n.textContent;
    }
    return norm(t);
  }

  function findCandidates(body) {
    const scores = new Map();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (isJunk(el, true) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const paras = [];
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (PARA_TAGS.has(el.tagName)) {
        if (el.tagName === 'LI' && el.querySelector('p')) continue;
        paras.push([el, textOf(el)]);
      } else if (el.tagName === 'DIV' || el.tagName === 'SECTION' || el.tagName === 'ARTICLE') {
        const own = ownInlineText(el);
        if (own.length >= 25) paras.push([el, own]);
      }
    }
    for (const [el, text] of paras) {
      if (text.length < 25) continue;
      const ancestors = [];
      for (let a = el.parentElement, d = 0; a && d < 5; a = a.parentElement, d++) { ancestors.push(a); if (a === body) break; }
      if (!ancestors.length) continue;
      let score = 1 + (text.match(/[,，、]/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
      if (el.tagName === 'LI') score *= 0.5;
      ancestors.forEach((a, level) => {
        if (!scores.has(a)) scores.set(a, initScore(a));
        const div = level === 0 ? 1 : level === 1 ? 2 : level * 3;
        scores.set(a, scores.get(a) + score / div);
      });
    }
    const out = [];
    for (const [el, s] of scores) out.push({ el, score: s * (1 - linkDensity(el)) });
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function pickRoots(body) {
    const cands = findCandidates(body);
    if (!cands.length) return [body];
    let top = cands[0];
    const scoreOf = new Map(cands.map((c) => [c.el, c.score]));
    // If several strong candidates share an ancestor, the article probably spans them.
    const strong = cands.slice(1, 6).filter((c) => c.score >= top.score * 0.75);
    if (strong.length >= 2) {
      for (let p = top.el.parentElement; p && p !== body.parentElement; p = p.parentElement) {
        const contained = strong.filter((c) => p.contains(c.el)).length;
        if (contained >= Math.min(3, strong.length)) { top = { el: p, score: scoreOf.get(p) || top.score }; break; }
      }
    }
    // Climb while the parent is mostly just this node (wrapper divs).
    let el = top.el;
    while (el.parentElement && el.parentElement !== body && el.parentElement.tagName !== 'HTML') {
      const parent = el.parentElement;
      const pt = textOf(parent).length;
      if (pt && textOf(el).length / pt > 0.9 && linkDensity(parent) < 0.3) el = parent;
      else break;
    }
    const topScore = Math.max(scoreOf.get(el) || 0, top.score);
    const roots = [el];
    const parent = el.parentElement;
    if (parent && el !== body) {
      const threshold = Math.max(10, topScore * 0.2);
      for (const sib of parent.children) {
        if (sib === el || isJunk(sib, true)) continue;
        const sScore = scoreOf.get(sib) || 0;
        let include = sScore >= threshold;
        if (!include && sib.tagName === 'P') {
          const t = textOf(sib);
          const ld = linkDensity(sib, t);
          include = (t.length > 80 && ld < 0.25) || (t.length > 0 && t.length <= 80 && ld === 0 && /\.( |$)/.test(t));
        }
        if (include) roots.push(sib);
      }
      roots.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    }
    return roots;
  }

  // Container-level boilerplate check during emission.
  function isBoilerContainer(el) {
    const tag = el.tagName;
    if (!/^(DIV|SECTION|UL|OL|TABLE|HEADER|FOOTER|FORM|DL|FIGURE)$/.test(tag)) return false;
    const text = textOf(el);
    if (!text) return true;
    const ci = classId(el);
    const ld = linkDensity(el, text);
    if (UNLIKELY.test(ci) && !MAYBE.test(ci) && text.length < 1500) return true;
    if (ld > 0.5 && text.length < 600) return true;
    if (NEGATIVE.test(ci) && !POSITIVE.test(ci) && ld > 0.33 && text.length < 1000) return true;
    if (tag === 'FORM' && text.length < 300) return true;
    return false;
  }

  function isDataTable(table) {
    if (table.getAttribute('role') === 'presentation') return false;
    if (table.querySelector('table')) return false;
    if (table.querySelector('th, thead, caption')) return true;
    const rows = table.rows ? table.rows.length : 0;
    const cols = rows ? table.rows[0].cells.length : 0;
    return rows >= 3 && cols >= 2;
  }

  function emitBlocks(roots) {
    const blocks = [];
    const els = [];
    let buf = '';
    let bufEl = null;
    let bufType = 'p';
    const push = (type, text, el, extra) => {
      const t = norm(text);
      if (!t) return;
      if (type !== 'heading' && type !== 'pre' && BOILER_TEXT.test(t)) return;
      const last = blocks[blocks.length - 1];
      if (last && last.text === t) return;
      blocks.push(Object.assign({ type, text: t }, extra || {}));
      els.push(el);
    };
    const flush = () => {
      if (buf.trim()) {
        for (const part of buf.split(/\n[ \t]*\n/)) push(bufType, part.replace(/\n/g, ' '), bufEl);
      }
      buf = '';
      bufEl = null;
    };
    const walk = (node, ctxType) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          if (!bufEl) { bufEl = node; bufType = ctxType; }
          buf += n.nodeValue.replace(/[\s ]+/g, ' ');
          continue;
        }
        if (n.nodeType !== 1) continue;
        const el = n;
        const tag = el.tagName;
        if (isJunk(el, false)) continue;
        if (tag === 'BR') { buf += '\n'; continue; }
        if (!BLOCK_TAGS.has(tag)) {
          if (tag === 'MATH' || tag === 'SUP' && /^\[?\d+\]?$/.test(norm(el.textContent))) continue; // footnote markers
          walk(el, ctxType);
          continue;
        }
        flush();
        if (/^H[1-6]$/.test(tag)) { push('heading', el.textContent, el, { level: +tag[1] }); continue; }
        if (tag === 'PRE') { const t = el.textContent.replace(/\s+$/, ''); if (t.trim()) { blocks.push({ type: 'pre', text: t.slice(0, 20000) }); els.push(el); } continue; }
        if (tag === 'HR') continue;
        if (tag === 'TABLE') {
          if (isBoilerContainer(el)) continue;
          if (isDataTable(el)) {
            for (const row of el.rows) {
              const cells = [...row.cells].map((c) => norm(c.textContent)).filter(Boolean);
              if (cells.length) push('table', cells.join(' | '), row);
            }
            continue;
          }
          walk(el, ctxType);
          flush();
          continue;
        }
        if (isBoilerContainer(el)) continue;
        if (/\b(byline|dateline|author-?info|post-?meta|article-?meta|timestamp)\b/i.test(classId(el)) && textOf(el).length < 200) continue;
        let type = ctxType;
        if (tag === 'LI' || tag === 'DT' || tag === 'DD') type = 'li';
        else if (tag === 'BLOCKQUOTE') type = 'quote';
        else if (tag === 'FIGCAPTION' || tag === 'CAPTION') type = 'caption';
        else if (tag === 'P') type = ctxType === 'quote' ? 'quote' : ctxType === 'li' ? 'li' : 'p';
        walk(el, type);
        flush();
      }
    };
    for (const r of roots) {
      if (/^H[1-6]$/.test(r.tagName)) { push('heading', r.textContent, r, { level: +r.tagName[1] }); continue; }
      walk(r, 'p');
      flush();
    }
    return { blocks, els };
  }

  function meta(names) {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      const v = el && norm(el.getAttribute('content'));
      if (v) return v;
    }
    return '';
  }

  function cleanTitle(raw, site) {
    let t = norm(raw);
    if (!t) return '';
    const parts = t.split(/\s+[|\-–—·•»:]\s+/);
    if (parts.length > 1) {
      // Drop the site-name part (usually the shortest end piece).
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (site && norm(last).toLowerCase() === site.toLowerCase()) t = parts.slice(0, -1).join(' - ');
      else if (site && norm(first).toLowerCase() === site.toLowerCase()) t = parts.slice(1).join(' - ');
      else if (first.split(' ').length >= 3) t = first;
    }
    return t;
  }

  function extract(opts) {
    opts = opts || {};
    const doc = document;
    const isPdf = doc.contentType === 'application/pdf' || !!doc.querySelector('embed[type="application/pdf"], embed[type="application/x-google-chrome-pdf"]');
    const selection = norm(String((globalThis.getSelection && getSelection()) || '')).slice(0, 20000);
    const siteName = meta(['og:site_name', 'application-name']) || location.hostname.replace(/^www\./, '');
    const h1 = doc.querySelector('article h1, main h1, h1');
    const metaTitle = meta(['og:title', 'twitter:title']);
    const title = cleanTitle(metaTitle || doc.title, siteName) || norm(h1 && h1.textContent) || location.hostname;
    const byline = meta(['author', 'article:author', 'parsely-author', 'dc.creator']) ||
      norm((doc.querySelector('[rel="author"], [itemprop="author"], .byline, .author-name, .author') || {}).textContent || '').slice(0, 120);
    const published = meta(['article:published_time', 'datePublished', 'pubdate', 'date', 'dc.date']) ||
      ((doc.querySelector('time[datetime]') || {}).getAttribute ? doc.querySelector('time[datetime]').getAttribute('datetime') : '');
    const excerpt = meta(['description', 'og:description', 'twitter:description']);
    const lang = (doc.documentElement.lang || meta(['og:locale']) || navigator.language || 'en').slice(0, 2).toLowerCase();
    const result = { url: location.href, title, siteName, byline, published, excerpt, lang, selection, isPdf, blocks: [], method: 'readable' };
    if (!doc.body || isPdf) return result;

    let roots = pickRoots(doc.body);
    let { blocks, els } = emitBlocks(roots);
    let total = blocks.reduce((a, b) => a + b.text.length, 0);
    const bodyLen = textOf(doc.body).length;
    if (total < 250 || (bodyLen > 2000 && total < bodyLen * 0.1 && total < 1500)) {
      // Scoring found too little (app-like page): fall back to the whole body minus junk.
      ({ blocks, els } = emitBlocks([doc.body]));
      result.method = 'body';
      total = blocks.reduce((a, b) => a + b.text.length, 0);
    }
    // Make sure the article title heading is present for the outline.
    if (h1 && !els.includes(h1) && !blocks.some((b) => b.type === 'heading' && b.text === norm(h1.textContent))) {
      const firstEl = els[0];
      if (!firstEl || (h1.compareDocumentPosition(firstEl) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        blocks.unshift({ type: 'heading', level: 1, text: norm(h1.textContent) });
        els.unshift(h1);
      }
    }
    // Cap very large documents.
    const max = opts.maxChars || 500000;
    let acc = 0;
    let cut = blocks.length;
    for (let i = 0; i < blocks.length; i++) { acc += blocks[i].text.length; if (acc > max) { cut = i; break; } }
    result.truncated = cut < blocks.length;
    blocks = blocks.slice(0, cut);
    els = els.slice(0, cut);
    globalThis.__PA_blockEls = els;
    result.blocks = blocks;
    return result;
  }

  globalThis.__PA_extract = extract;
  globalThis.__PA_getSelection = () => norm(String((globalThis.getSelection && getSelection()) || '')).slice(0, 20000);
})();
