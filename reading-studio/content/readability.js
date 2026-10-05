// Reading Studio article extractor. Scores the live DOM to find the main content,
// then builds a sanitized copy using a strict tag and attribute whitelist.
// Standalone: exposes globalThis.RSReadability.extract(doc) (also RS.extract when loaded as content script).
(function () {
  if (globalThis.RSReadability) { if (globalThis.RS) globalThis.RS.extract = globalThis.RSReadability.extract; return; }

  const RX = {
    unlikely: /-ad-|ai2html|banner|breadcrumb|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|promo|share|sharing|toolbar|navbar|masthead|outbrain|taboola|recommend|signup|paywall|modal|overlay/i,
    maybe: /and|article|body|column|content|main|shadow|story|entry|post|prose/i,
    positive: /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|prose|markdown|rich-?text/i,
    negative: /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|nav|menu|subscribe|newsletter|cookie|byline|author-bio|social|recommend|trending|popular|advert/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    videos: /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
    sentenceEnd: /[.!?。！？]["'”’)]?\s*$/
  };

  const BLOCKISH = new Set(['A', 'BLOCKQUOTE', 'DL', 'DIV', 'IMG', 'OL', 'P', 'PRE', 'TABLE', 'UL', 'SECTION', 'ARTICLE', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'FORM', 'LI']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'NAV', 'LINK', 'META']);
  const SCORE_TAGS = new Set(['P', 'PRE', 'TD', 'BLOCKQUOTE', 'H2', 'H3', 'LI']);

  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const classId = (el) => ((el.className && typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '') + ' ' + (el.id || ''));

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true' && !el.querySelector('p')) return false;
    const st = el.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) return false;
    if (typeof el.checkVisibility === 'function' && el.ownerDocument.defaultView && el.isConnected) {
      try { if (!el.checkVisibility()) return false; } catch (e) { /* ignore */ }
    }
    return true;
  }

  function classWeight(el) {
    let w = 0;
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (cls) { if (RX.negative.test(cls)) w -= 25; if (RX.positive.test(cls)) w += 25; }
    if (el.id) { if (RX.negative.test(el.id)) w -= 25; if (RX.positive.test(el.id)) w += 25; }
    const role = el.getAttribute('role');
    if (role === 'main' || role === 'article') w += 20;
    if (el.getAttribute('itemprop') === 'articleBody') w += 40;
    return w;
  }

  function linkDensity(el, totalLen) {
    const total = totalLen != null ? totalLen : textOf(el).length;
    if (!total) return 0;
    let linkLen = 0;
    for (const a of el.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      const coef = href.startsWith('#') ? 0.3 : 1;
      linkLen += textOf(a).length * coef;
    }
    return Math.min(1, linkLen / total);
  }

  function initScore(el) {
    let s = 0;
    switch (el.tagName) {
      case 'DIV': s += 5; break;
      case 'ARTICLE': s += 10; break;
      case 'MAIN': s += 6; break;
      case 'SECTION': s += 3; break;
      case 'PRE': case 'TD': case 'BLOCKQUOTE': s += 3; break;
      case 'ADDRESS': case 'OL': case 'UL': case 'DL': case 'DD': case 'DT': case 'LI': case 'FORM': s -= 3; break;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': case 'TH': s -= 5; break;
    }
    return s + classWeight(el);
  }

  function isUnlikely(el, body) {
    if (el === body || el.tagName === 'BODY' || el.tagName === 'ARTICLE' || el.tagName === 'MAIN') return false;
    const ci = classId(el);
    const role = el.getAttribute('role');
    if (role && /^(navigation|banner|contentinfo|complementary|dialog|alertdialog|menu|menubar|search)$/.test(role)) return true;
    if (!RX.unlikely.test(ci) || RX.maybe.test(ci)) return false;
    if (el.closest('table, code')) return false;
    if (el.querySelector('article, main, [itemprop="articleBody"]')) return false;
    return true;
  }

  // Div used as a paragraph (no block-level children).
  function isParagraphDiv(el) {
    for (const c of el.children) if (BLOCKISH.has(c.tagName)) return false;
    return true;
  }

  function collectParagraphs(body) {
    const out = [];
    const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.tagName === 'HEADER' || el.tagName === 'FOOTER' || el.tagName === 'ASIDE') {
          if (!el.querySelector('p, article')) return NodeFilter.FILTER_REJECT;
        }
        if (isUnlikely(el, body)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (SCORE_TAGS.has(n.tagName) || ((n.tagName === 'DIV' || n.tagName === 'SECTION' || n.tagName === 'SPAN') && n.childElementCount < 6 && isParagraphDiv(n) && !n.closest('p'))) {
        if (n.tagName === 'LI' && n.closest('nav')) continue;
        out.push(n);
      }
    }
    return out;
  }

  function findMain(doc) {
    const body = doc.body;
    if (!body) return { top: null, roots: [] };

    // Strong signals first.
    const explicit = doc.querySelector('[itemprop="articleBody"]');
    if (explicit && textOf(explicit).length > 500 && isVisible(explicit)) return { top: explicit, roots: [explicit] };

    const scores = new Map();
    const candidates = [];
    const paras = collectParagraphs(body);
    for (const p of paras) {
      const text = textOf(p);
      if (text.length < 25) continue;
      let content = 1 + (text.match(/[,，、،]/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
      if (p.tagName === 'LI' || p.tagName === 'H2' || p.tagName === 'H3') content *= 0.5;
      let anc = p.parentElement, level = 0;
      while (anc && level < 5 && anc !== doc.documentElement) {
        if (!scores.has(anc)) { scores.set(anc, initScore(anc)); candidates.push(anc); }
        const div = level === 0 ? 1 : level === 1 ? 2 : level * 3;
        scores.set(anc, scores.get(anc) + content / div);
        anc = anc.parentElement; level++;
      }
    }

    const finals = [];
    for (const c of candidates) {
      if (c === doc.documentElement) continue;
      const s = scores.get(c) * (1 - linkDensity(c));
      finals.push([c, s]);
    }
    finals.sort((a, b) => b[1] - a[1]);
    let top = finals.length ? finals[0][0] : null;
    let topScore = finals.length ? finals[0][1] : 0;

    if (!top) {
      const fallback = doc.querySelector('article, main, [role="main"]') || body;
      return { top: fallback, roots: [fallback] };
    }

    // If several of the best candidates share an ancestor, that ancestor is the real container.
    const alts = finals.slice(1, 6).filter(([, s]) => s >= topScore * 0.75).map(([el]) => el);
    if (alts.length >= 2) {
      let parent = top.parentElement;
      while (parent && parent !== body) {
        const contained = alts.filter((a) => parent.contains(a)).length;
        if (contained >= 2) { top = parent; topScore = scores.get(parent) || topScore; break; }
        parent = parent.parentElement;
      }
    }

    // Climb single-child wrappers and parents whose score keeps growing.
    let parent = top.parentElement;
    let lastScore = topScore;
    while (parent && parent !== body) {
      const ps = scores.get(parent);
      if (parent.children.length === 1 && textOf(parent).length <= textOf(top).length * 1.1) { top = parent; parent = top.parentElement; continue; }
      if (ps && ps > lastScore && ps > topScore * 1.05) { top = parent; lastScore = ps; parent = top.parentElement; continue; }
      break;
    }

    // Prefer an enclosing <article> if the candidate sits inside one with modest extra text.
    const art = top.closest('article');
    if (art && art !== top && textOf(art).length < textOf(top).length * 1.6) top = art;

    // Gather siblings that also look like content.
    const roots = [];
    const threshold = Math.max(10, topScore * 0.2);
    const sibs = top.parentElement ? Array.from(top.parentElement.children) : [top];
    const topClass = typeof top.className === 'string' ? top.className : '';
    for (const sib of sibs) {
      if (sib === top) { roots.push(sib); continue; }
      if (SKIP_TAGS.has(sib.tagName) || !isVisible(sib) || isUnlikely(sib, body)) continue;
      let append = false;
      let bonus = 0;
      if (topClass && sib.className === topClass) bonus += topScore * 0.2;
      const ss = scores.get(sib);
      if (ss != null && ss * (1 - linkDensity(sib)) + bonus >= threshold) append = true;
      else if (sib.tagName === 'P') {
        const t = textOf(sib); const ld = linkDensity(sib, t.length);
        if (t.length > 80 && ld < 0.25) append = true;
        else if (t.length < 80 && t.length > 0 && ld === 0 && RX.sentenceEnd.test(t)) append = true;
      }
      if (append) roots.push(sib);
    }

    // Too little text? fall back to semantic containers.
    const totalLen = roots.reduce((n, r) => n + textOf(r).length, 0);
    if (totalLen < 200) {
      const sem = doc.querySelector('article, main, [role="main"]');
      if (sem && textOf(sem).length > totalLen) return { top: sem, roots: [sem] };
    }
    return { top, roots };
  }

  // ---------- metadata ----------
  function metaContent(doc, sel) {
    const m = doc.querySelector(sel);
    return m ? (m.getAttribute('content') || '').trim() : '';
  }

  function jsonLd(doc) {
    const out = {};
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        let data = JSON.parse(s.textContent);
        const items = [];
        const visit = (d) => { if (!d) return; if (Array.isArray(d)) d.forEach(visit); else if (typeof d === 'object') { items.push(d); if (d['@graph']) visit(d['@graph']); } };
        visit(data);
        for (const it of items) {
          const t = [].concat(it['@type'] || []).join(' ');
          if (!/Article|BlogPosting|NewsArticle|Report|WebPage/i.test(t)) continue;
          if (!out.title && typeof it.headline === 'string') out.title = it.headline;
          if (!out.byline && it.author) {
            const a = [].concat(it.author).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
            if (a.length) out.byline = a.join(', ');
          }
          if (!out.published && it.datePublished) out.published = it.datePublished;
          if (!out.siteName && it.publisher && it.publisher.name) out.siteName = it.publisher.name;
        }
      } catch (e) { /* malformed JSON-LD */ }
    }
    return out;
  }

  function cleanTitle(doc, h1Text) {
    const raw = (doc.title || '').trim();
    if (!raw) return h1Text || '';
    if (h1Text && raw.includes(h1Text)) return h1Text;
    const parts = raw.split(/\s+[|\-–—:·»/]\s+/);
    if (parts.length > 1) {
      const first = parts[0];
      if (first.split(/\s+/).length >= 3) return first;
      return parts.reduce((a, b) => (b.length > a.length ? b : a), '');
    }
    return raw;
  }

  function getMetadata(doc, top) {
    const ld = jsonLd(doc);
    const h1s = Array.from(doc.querySelectorAll('h1')).filter((h) => isVisible(h));
    let h1 = h1s.find((h) => top && (top.contains(h) || h.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING)) || h1s[0];
    const h1Text = h1 ? textOf(h1) : '';
    let title = metaContent(doc, 'meta[property="og:title"]') || metaContent(doc, 'meta[name="twitter:title"]') || ld.title || '';
    if (!title || (h1Text && h1Text.length > 10 && !title.includes(h1Text) && !h1Text.includes(title) && h1s.length === 1)) title = h1Text || title;
    if (!title) title = cleanTitle(doc, h1Text);
    // og:title often carries a site suffix too
    title = title.replace(/\s+[|–—]\s+[^|–—]{2,40}$/, (m) => (title.length - m.length > 15 ? '' : m)).trim();

    let byline = metaContent(doc, 'meta[name="author"]') || ld.byline || '';
    if (!byline) {
      const el = doc.querySelector('[rel="author"], [itemprop="author"] [itemprop="name"], [itemprop="author"], .byline, .author, .p-author, [class*="byline"]');
      if (el) byline = textOf(el);
    }
    byline = byline.replace(/^\s*(by|von|par|por)\s+/i, '').trim();
    if (byline.length > 100 || /^https?:/.test(byline)) byline = '';

    const siteName = metaContent(doc, 'meta[property="og:site_name"]') || ld.siteName || metaContent(doc, 'meta[name="application-name"]') || (doc.location && doc.location.hostname || '').replace(/^www\./, '');
    let published = metaContent(doc, 'meta[property="article:published_time"]') || ld.published || metaContent(doc, 'meta[name="date"]') || '';
    if (!published) {
      const t = (top && top.querySelector('time[datetime]')) || doc.querySelector('article time[datetime], time[datetime]');
      if (t) published = t.getAttribute('datetime');
    }
    const excerpt = metaContent(doc, 'meta[property="og:description"]') || metaContent(doc, 'meta[name="description"]');
    const leadImage = metaContent(doc, 'meta[property="og:image"]');
    const lang = (doc.documentElement.getAttribute('lang') || '').trim() || (doc.defaultView && doc.defaultView.navigator.language) || 'en';
    let dir = doc.documentElement.getAttribute('dir') || doc.body && doc.body.getAttribute('dir') || '';
    return { title: title.trim(), byline, siteName, published, excerpt, leadImage, lang, dir: dir === 'rtl' ? 'rtl' : 'ltr', h1 };
  }

  // ---------- sanitizing rebuild ----------
  const KEEP = {
    P: 'p', H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6', A: 'a', B: 'strong', STRONG: 'strong', I: 'em', EM: 'em',
    U: 'u', S: 's', DEL: 'del', INS: 'ins', MARK: 'mark', SMALL: 'small', SUB: 'sub', SUP: 'sup', CODE: 'code', PRE: 'pre',
    KBD: 'kbd', SAMP: 'samp', VAR: 'var', BLOCKQUOTE: 'blockquote', Q: 'q', CITE: 'cite', ABBR: 'abbr', TIME: 'time', UL: 'ul', OL: 'ol',
    LI: 'li', DL: 'dl', DT: 'dt', DD: 'dd', FIGURE: 'figure', FIGCAPTION: 'figcaption', IMG: 'img', VIDEO: 'video', AUDIO: 'audio',
    TABLE: 'table', THEAD: 'thead', TBODY: 'tbody', TFOOT: 'tfoot', TR: 'tr', TH: 'th', TD: 'td', CAPTION: 'caption', HR: 'hr', BR: 'br',
    DETAILS: 'details', SUMMARY: 'summary', DIV: 'div', SECTION: 'div', ARTICLE: 'div', MAIN: 'div', CENTER: 'div', HEADER: 'div',
    ADDRESS: 'p', TT: 'code', BIG: 'strong'
  };
  const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
    'SELECT', 'TEXTAREA', 'NAV', 'ASIDE', 'FOOTER', 'SVG', 'CANVAS', 'DIALOG', 'MENU', 'LABEL', 'OPTION', 'MATH', 'APPLET', 'SOURCE', 'TRACK', 'MAP', 'AREA']);

  function absUrl(u, base) {
    if (!u) return '';
    try {
      const url = new URL(u.trim(), base);
      if (!/^(https?|data|blob):$/.test(url.protocol) && url.protocol !== 'mailto:') return '';
      if (url.protocol === 'data:' && !/^data:image\//i.test(u.trim())) return '';
      return url.href;
    } catch (e) { return ''; }
  }

  function absSrcset(v, base) {
    return v.split(/,\s+/).map((part) => {
      const [u, d] = part.trim().split(/\s+/);
      const a = absUrl(u, base);
      return a ? (d ? `${a} ${d}` : a) : '';
    }).filter(Boolean).join(', ');
  }

  function bestImageSrc(img, base) {
    // Live <img> knows its resolved current source; lazy loaders keep the real one in data attributes.
    const lazy = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-hi-res-src', 'data-full-src', 'data-actualsrc'];
    for (const a of lazy) { const v = img.getAttribute(a); if (v && !/^data:/.test(v)) return absUrl(v, base); }
    const ds = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
    if (ds) { const first = ds.split(',').pop().trim().split(/\s+/)[0]; if (first) return absUrl(first, base); }
    const cur = img.currentSrc || img.getAttribute('src') || '';
    if (/^data:image\/(gif|svg)/.test(cur) || /blank|spacer|pixel|placeholder|1x1/.test(cur)) {
      const ss = img.getAttribute('srcset');
      if (ss) return absUrl(ss.split(',').pop().trim().split(/\s+/)[0], base);
    }
    return absUrl(cur, base);
  }

  function shouldDropConditionally(el, title) {
    const tag = el.tagName;
    if (!['DIV', 'SECTION', 'TABLE', 'UL', 'OL', 'FIGURE', 'HEADER', 'ASIDE', 'P', 'SPAN'].includes(tag)) return false;
    if (el.closest('pre, code')) return false;
    const text = textOf(el);
    const weight = classWeight(el);
    if (tag === 'HEADER') {
      // Article headers usually repeat the title and byline we show ourselves.
      if (!el.querySelector('p') || text.length < 200) return true;
    }
    if (weight < 0 && text.length < 1000) return true;
    if (tag === 'P' || tag === 'SPAN') return false;
    if (isUnlikely(el, null) && text.length < 800) return true;
    const ps = el.querySelectorAll('p').length;
    const imgs = el.querySelectorAll('img').length;
    const lis = el.querySelectorAll('li').length - 100;
    const inputs = el.querySelectorAll('input, select, textarea, button').length;
    const embeds = el.querySelectorAll('iframe, embed, object').length;
    const ld = linkDensity(el, text.length);
    const isList = tag === 'UL' || tag === 'OL';
    if (tag === 'FIGURE' || el.querySelector(':scope > figure, :scope > picture')) {
      return imgs === 0 && !el.querySelector('video, picture, pre, table, blockquote');
    }
    if (tag === 'TABLE' && text.length > 20 && ld < 0.5) return false;
    if (isList && ld < 0.5 && text.length > 40) return false;
    if (imgs > 1 && ps / imgs < 0.5 && !el.querySelector('figcaption') && text.length < 200) return true;
    if (!isList && lis > ps) return true;
    if (inputs > Math.floor(ps / 3)) return true;
    if (text.length < 25 && imgs === 0 && !el.querySelector('video, audio, picture, pre, table, hr')) return true;
    if (text.length < 25 && imgs > 2 && !el.querySelector('figcaption')) return true;
    if (weight < 25 && ld > 0.33 && text.length < 600) return true;
    if (weight >= 25 && ld > 0.5) return true;
    if ((embeds === 1 && text.length < 75) || embeds > 1) return true;
    if (title && text.length < 160 && ps === 0 && /^(share|related|more|read more|advertisement|sponsored|recommended|subscribe|sign up)/i.test(text)) return true;
    return false;
  }

  function sanitize(roots, doc, meta) {
    const base = doc.baseURI;
    const out = doc.createElement('div');
    const titleNorm = (meta.title || '').toLowerCase().replace(/\W+/g, ' ').trim();
    let imgCount = 0;

    function walk(src, dest) {
      for (const node of Array.from(src.childNodes)) {
        if (node.nodeType === 3) { dest.appendChild(doc.createTextNode(node.nodeValue)); continue; }
        if (node.nodeType !== 1) continue;
        const tag = node.tagName.toUpperCase();
        if (DROP.has(tag)) {
          if (tag === 'IFRAME') {
            const s = absUrl(node.getAttribute('src') || node.getAttribute('data-src'), base);
            if (s && RX.videos.test(s)) {
              const p = doc.createElement('p'); const a = doc.createElement('a');
              a.href = s; a.textContent = 'Embedded video ↗'; a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
              p.appendChild(a); dest.appendChild(p);
            }
          } else if (tag === 'NOSCRIPT') {
            // Lazy-load fallbacks: an <img> hidden in <noscript> right after a placeholder.
            const m = /<img[^>]+src=["']([^"']+)["']/i.exec(node.textContent || '');
            const prev = dest.lastElementChild;
            if (m && !(prev && prev.tagName === 'IMG')) {
              const img = doc.createElement('img'); const u = absUrl(m[1], base);
              if (u) { img.src = u; dest.appendChild(img); imgCount++; }
            }
          }
          continue;
        }
        if (node.getAttribute('aria-hidden') === 'true' && !node.querySelector('img')) continue;
        if (node.hidden || /display\s*:\s*none/i.test(node.getAttribute('style') || '')) continue;
        if (node.isConnected && typeof node.checkVisibility === 'function' && !['IMG', 'BR', 'HR', 'VIDEO'].includes(tag)) {
          try { if (!node.checkVisibility() && !node.closest('details')) continue; } catch (e) { /* ignore */ }
        }
        if (shouldDropConditionally(node, meta.title)) continue;
        if (/^H[1-3]$/.test(tag)) {
          const t = textOf(node).toLowerCase().replace(/\W+/g, ' ').trim();
          if (titleNorm && t === titleNorm) continue;
          if (classWeight(node) < 0) continue;
        }

        if (tag === 'PICTURE') {
          const img = node.querySelector('img');
          if (img) { const el = makeImg(img); if (el) dest.appendChild(el); }
          continue;
        }
        if (tag === 'IMG') { const el = makeImg(node); if (el) dest.appendChild(el); continue; }

        const mapped = KEEP[tag];
        if (!mapped) { walk(node, dest); continue; } // unknown wrapper: keep children only
        const el = doc.createElement(mapped);
        copyAttrs(node, el, mapped);
        if (mapped === 'video' || mapped === 'audio') {
          el.setAttribute('controls', '');
          const s = node.currentSrc || node.getAttribute('src') || (node.querySelector('source') && node.querySelector('source').getAttribute('src'));
          const u = absUrl(s, base); if (u) el.setAttribute('src', u);
          const poster = absUrl(node.getAttribute('poster'), base); if (poster) el.setAttribute('poster', poster);
          el.setAttribute('preload', 'none');
          dest.appendChild(el);
          continue;
        }
        if (mapped === 'pre') { el.textContent = node.textContent; dest.appendChild(el); continue; }
        walk(node, el);
        dest.appendChild(el);
      }
    }

    function makeImg(img) {
      const src = bestImageSrc(img, base);
      if (!src) return null;
      const w = parseInt(img.getAttribute('width') || '0', 10) || img.naturalWidth || 0;
      const h = parseInt(img.getAttribute('height') || '0', 10) || img.naturalHeight || 0;
      if ((w && w < 40 && h && h < 40) || /(pixel|tracking|beacon|spacer)\b/i.test(src)) return null;
      const el = doc.createElement('img');
      el.setAttribute('src', src);
      el.setAttribute('alt', img.getAttribute('alt') || '');
      el.setAttribute('loading', 'lazy');
      if (w) el.setAttribute('width', String(w));
      if (h) el.setAttribute('height', String(h));
      imgCount++;
      return el;
    }

    function copyAttrs(src, el, mapped) {
      if (mapped === 'a') {
        const href = src.getAttribute('href') || '';
        if (href.startsWith('#')) el.setAttribute('href', href);
        else { const u = absUrl(href, base); if (u && !u.startsWith('data:')) { el.setAttribute('href', u); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); } }
      }
      if (mapped === 'td' || mapped === 'th') {
        for (const a of ['colspan', 'rowspan']) { const v = src.getAttribute(a); if (v && /^\d+$/.test(v)) el.setAttribute(a, v); }
      }
      if (mapped === 'ol') { const s = src.getAttribute('start'); if (s && /^-?\d+$/.test(s)) el.setAttribute('start', s); if (src.hasAttribute('reversed')) el.setAttribute('reversed', ''); }
      if (mapped === 'time') { const d = src.getAttribute('datetime'); if (d) el.setAttribute('datetime', d); }
      if (mapped === 'abbr') { const t = src.getAttribute('title'); if (t) el.setAttribute('title', t); }
      if (mapped === 'details' && src.hasAttribute('open')) el.setAttribute('open', '');
      const lang = src.getAttribute('lang'); if (lang && /^[a-zA-Z-]{2,20}$/.test(lang)) el.setAttribute('lang', lang);
      const dir = src.getAttribute('dir'); if (dir === 'rtl' || dir === 'ltr') el.setAttribute('dir', dir);
      if (src.id && /^[\w-]{1,60}$/.test(src.id) && mapped !== 'div') el.setAttribute('id', 'rs-' + src.id);
    }

    for (const r of roots) {
      const tag = r.tagName.toUpperCase();
      if (['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY', 'TD'].includes(tag)) walk(r, out);
      else walk({ childNodes: [r] }, out); // keep the root element itself (p, ul, figure...)
    }

    // Fix internal anchor ids we prefixed.
    for (const a of out.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute('href').slice(1);
      if (id && out.querySelector('#rs-' + CSS.escape(id))) a.setAttribute('href', '#rs-' + id);
      else { a.removeAttribute('href'); }
    }

    // Prune empty containers and collapse wrapper divs.
    for (let pass = 0; pass < 3; pass++) {
      for (const el of Array.from(out.querySelectorAll('div, p, span, li, ul, ol, figure, blockquote, section, strong, em, a:not([href])'))) {
        if (!el.isConnected) continue;
        if (!textOf(el) && !el.querySelector('img, video, audio, hr, br, pre, table, picture')) el.remove();
      }
    }
    for (const d of Array.from(out.querySelectorAll('div'))) {
      if (d.childNodes.length === 1 && d.firstElementChild && d.firstElementChild.tagName === 'DIV') d.replaceWith(d.firstElementChild);
    }
    // Drop a leading byline/date line that duplicates our header.
    const first = out.querySelector('p');
    if (first && meta.byline && textOf(first).length < 120 && textOf(first).toLowerCase().includes(meta.byline.toLowerCase())) first.remove();
    return { content: out, imgCount };
  }

  function countWords(text, lang) {
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    return { words, cjk, units: words + cjk / 2 };
  }

  function extract(doc, opts) {
    doc = doc || document;
    opts = opts || {};
    const { top, roots } = findMain(doc);
    const meta = getMetadata(doc, top);
    const usedRoots = roots.length ? roots : [doc.body];
    const { content, imgCount } = sanitize(usedRoots, doc, meta);
    const text = textOf(content);
    const wc = countWords(text, meta.lang);
    const wpm = opts.wpm || 230;
    const minutes = Math.max(1, Math.round(wc.units / wpm));
    return {
      title: meta.title || doc.title || '',
      byline: meta.byline,
      siteName: meta.siteName,
      published: meta.published,
      excerpt: meta.excerpt,
      leadImage: imgCount === 0 ? meta.leadImage : '',
      lang: meta.lang,
      dir: meta.dir,
      content,              // sanitized element (owned by doc, detached)
      sourceRoots: usedRoots, // live page elements the article came from
      textLength: text.length,
      wordCount: wc.words + wc.cjk,
      readingMinutes: minutes,
      isProbablyArticle: text.length > 600
    };
  }

  globalThis.RSReadability = { extract, findMain, textOf, countWords };
  if (globalThis.RS) globalThis.RS.extract = extract;
})();
