// Research Canvas content script: web highlighter + sticky notes.
// Injected on demand (activeTab) or automatically on every page when the user enables auto-restore.
(() => {
  if (window.__researchCanvasLoaded) return;
  window.__researchCanvasLoaded = true;

  const COLORS = {
    yellow: '#ffe066',
    green: '#8ce99a',
    blue: '#a5d8ff',
    pink: '#fcc2d7',
    purple: '#d0bfff',
  };
  const STICKY_COLORS = {
    yellow: '#fff3bf',
    green: '#d3f9d8',
    blue: '#d0ebff',
    pink: '#ffdeeb',
    purple: '#e5dbff',
  };
  const COLOR_IDS = Object.keys(COLORS);
  const CONTEXT = 32;
  const HL_TAG = 'rc-highlight';
  const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src)$/i;

  function normalizeUrl(href) {
    try {
      const u = new URL(href);
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
      return u.toString();
    } catch {
      return String(href).split('#')[0];
    }
  }

  let pageUrl = normalizeUrl(location.href);
  let settings = { showToolbar: true, defaultColor: 'yellow' };
  let page = { highlights: [], stickies: [] };
  const anchored = new Map(); // highlight id -> [elements]
  const orphans = new Set(); // highlight ids that could not be anchored (yet)
  const pendingHl = new Map(); // highlight id -> highlight painted locally but not yet confirmed by storage
  let lastContextPoint = null;
  let alive = true;

  const send = msg => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, r => {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(r || { ok: false });
      });
    } catch (e) {
      // Extension was reloaded; this script is orphaned.
      alive = false;
      resolve({ ok: false, error: String(e) });
    }
  });

  // ---------- page style for highlights ----------
  const style = document.createElement('style');
  style.setAttribute('data-rc-ui', '');
  style.textContent = `
    ${HL_TAG}{all:unset;display:inline!important;background:var(--rc-hl,#ffe066)!important;color:#1a1a1a!important;
      border-radius:2px!important;cursor:pointer!important;box-decoration-break:clone;-webkit-box-decoration-break:clone;
      transition:box-shadow .15s ease, background-color .15s ease}
    ${HL_TAG}[data-rc-comment]{border-bottom:2px dotted rgba(0,0,0,.55)!important}
    ${HL_TAG}.rc-focus{box-shadow:0 0 0 2px #7c5cff!important}
    ${HL_TAG}.rc-flash{animation:rc-flash 1.2s ease 2}
    @keyframes rc-flash{50%{box-shadow:0 0 0 4px rgba(124,92,255,.65)}}
    @media print{${HL_TAG}{background:none!important;text-decoration:underline!important}}
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---------- text index ----------
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS', 'RC-UI', 'RC-STICKIES']);
  function buildIndex() {
    const nodes = [];
    let text = '';
    if (!document.body) return { nodes, text };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
          if (SKIP.has(p.tagName.toUpperCase()) || p.hasAttribute('data-rc-ui')) return NodeFilter.FILTER_REJECT;
        }
        return n.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
    return { nodes, text };
  }

  function pointToOffset(container, offset, idx) {
    if (container.nodeType === Node.TEXT_NODE) {
      const e = idx.nodes.find(x => x.node === container);
      if (e) return e.start + Math.min(offset, e.node.data.length);
    }
    const r = document.createRange();
    try { r.setStart(container, offset); } catch { return null; }
    for (const e of idx.nodes) {
      if (r.comparePoint(e.node, 0) >= 0) return e.start;
    }
    return idx.text.length;
  }

  function rangeToSelector(range) {
    const idx = buildIndex();
    let start = pointToOffset(range.startContainer, range.startOffset, idx);
    let end = pointToOffset(range.endContainer, range.endOffset, idx);
    if (start == null || end == null || end <= start) return null;
    // Trim whitespace at the edges so quotes are clean.
    while (start < end && /\s/.test(idx.text[start])) start++;
    while (end > start && /\s/.test(idx.text[end - 1])) end--;
    if (end <= start) return null;
    return {
      quote: {
        exact: idx.text.slice(start, end),
        prefix: idx.text.slice(Math.max(0, start - CONTEXT), start),
        suffix: idx.text.slice(end, end + CONTEXT),
      },
      position: { start, end, length: idx.text.length },
    };
  }

  function commonSuffixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function commonPrefixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  /** Normalize whitespace and keep a map from normalized index back to original index. */
  function normalizeWithMap(text, lower) {
    let out = '';
    const map = [];
    let ws = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (/\s/.test(c)) {
        if (!ws && out.length) { out += ' '; map.push(i); }
        ws = true;
      } else {
        out += lower ? c.toLowerCase() : c;
        map.push(i);
        ws = false;
      }
    }
    return { out, map };
  }
  const norm = (s, lower) => normalizeWithMap(s, lower).out.trim();

  /** Find the best {start,end} in idx.text for a stored selector. Quote first, position as fallback. */
  function anchorSelector(sel, idx) {
    const text = idx.text;
    const { exact, prefix = '', suffix = '' } = sel.quote || {};
    if (!exact) return null;
    const pos = sel.position || {};
    // 1. Exact text at the stored position (fast path, page unchanged).
    if (text.slice(pos.start, pos.end) === exact) return { start: pos.start, end: pos.end };
    // 2. All exact occurrences, scored by context and distance from the old position.
    const scale = pos.length ? text.length / pos.length : 1;
    const expected = (pos.start || 0) * scale;
    let best = null;
    let from = 0;
    let count = 0;
    while (count < 5000) {
      const i = text.indexOf(exact, from);
      if (i < 0) break;
      count++;
      const score = commonSuffixLen(text.slice(Math.max(0, i - prefix.length), i), prefix) +
        commonPrefixLen(text.slice(i + exact.length, i + exact.length + suffix.length), suffix) -
        Math.min(20, Math.abs(i - expected) / Math.max(1000, text.length / 50));
      if (!best || score > best.score) best = { start: i, end: i + exact.length, score };
      from = i + 1;
    }
    if (best) return best;
    // 3. Whitespace-insensitive, then case-insensitive matching.
    for (const lower of [false, true]) {
      const { out, map } = normalizeWithMap(text, lower);
      const needle = norm(exact, lower);
      if (!needle) continue;
      const np = norm(prefix, lower);
      const ns = norm(suffix, lower);
      let b = null;
      let f = 0;
      for (let n = 0; n < 2000; n++) {
        const i = out.indexOf(needle, f);
        if (i < 0) break;
        const score = commonSuffixLen(out.slice(Math.max(0, i - np.length - 1), i).trim(), np) +
          commonPrefixLen(out.slice(i + needle.length, i + needle.length + ns.length + 1).trim(), ns);
        if (!b || score > b.score) b = { i, score };
        f = i + 1;
      }
      if (b) return { start: map[b.i], end: map[b.i + needle.length - 1] + 1 };
    }
    // 4. Position fallback: accept if the text there is still very similar.
    if (pos.end > pos.start && pos.end <= text.length) {
      const there = norm(text.slice(pos.start, pos.end), true);
      const want = norm(exact, true);
      if (there && similarity(there, want) > 0.8) return { start: pos.start, end: pos.end };
    }
    return null;
  }

  function similarity(a, b) {
    if (a === b) return 1;
    const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
    const ga = grams(a), gb = grams(b);
    let inter = 0;
    for (const [k, v] of ga) inter += Math.min(v, gb.get(k) || 0);
    return (2 * inter) / Math.max(1, a.length + b.length - 2);
  }

  const BAD_PARENTS = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'OL', 'DL', 'SELECT', 'COLGROUP', 'HEAD', 'HTML']);
  function wrapRange(start, end, h) {
    const idx = buildIndex();
    const segs = [];
    for (const e of idx.nodes) {
      if (e.end <= start || e.start >= end) continue;
      const ls = Math.max(start, e.start) - e.start;
      const le = Math.min(end, e.end) - e.start;
      const slice = e.node.data.slice(ls, le);
      if (!slice.trim() && BAD_PARENTS.has(e.node.parentNode && e.node.parentNode.nodeName)) continue;
      segs.push({ node: e.node, ls, le });
    }
    const els = [];
    for (const s of segs) {
      let n = s.node;
      if (s.le < n.data.length) n.splitText(s.le);
      if (s.ls > 0) n = n.splitText(s.ls);
      const m = document.createElement(HL_TAG);
      m.setAttribute('data-rc-id', h.id);
      n.parentNode.insertBefore(m, n);
      m.appendChild(n);
      els.push(m);
    }
    decorate(els, h);
    return els;
  }

  function decorate(els, h) {
    for (const m of els) {
      m.style.setProperty('--rc-hl', COLORS[h.color] || COLORS.yellow);
      if (h.comment) { m.setAttribute('data-rc-comment', ''); m.title = h.comment; }
      else { m.removeAttribute('data-rc-comment'); m.removeAttribute('title'); }
    }
  }

  function unwrap(id) {
    const els = anchored.get(id) || [];
    for (const m of els) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    anchored.delete(id);
  }

  function anchorHighlight(h) {
    if (anchored.has(h.id)) return true;
    const idx = buildIndex();
    const r = anchorSelector(h, idx);
    if (!r) { orphans.add(h.id); return false; }
    const els = wrapRange(r.start, r.end, h);
    if (!els.length) { orphans.add(h.id); return false; }
    anchored.set(h.id, els);
    orphans.delete(h.id);
    return true;
  }

  function syncHighlights() {
    const want = new Map(page.highlights.map(h => [h.id, h]));
    for (const id of [...anchored.keys()]) if (!want.has(id)) unwrap(id);
    for (const id of [...orphans]) if (!want.has(id)) orphans.delete(id);
    observerPaused = true;
    for (const h of page.highlights) {
      if (anchored.has(h.id)) decorate(anchored.get(h.id), h);
      else anchorHighlight(h);
    }
    observerPaused = false;
    updateBadge();
  }

  function updateBadge() {
    const n = page.highlights.length + page.stickies.length;
    send({ type: 'badge', count: n });
  }

  // Retry orphans while the page keeps rendering content (SPAs, lazy loading).
  let observerPaused = false;
  let retryTimer = null;
  const startedAt = Date.now();
  const mo = new MutationObserver(() => {
    if (observerPaused || !orphans.size || Date.now() - startedAt > 60000) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      observerPaused = true;
      for (const h of page.highlights) if (orphans.has(h.id)) anchorHighlight(h);
      observerPaused = false;
      if (!orphans.size) updateBadge();
    }, 600);
  });

  // ---------- UI root (shadow DOM keeps page CSS out) ----------
  const uiHost = document.createElement('rc-ui');
  uiHost.setAttribute('data-rc-ui', '');
  uiHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const ui = uiHost.attachShadow({ mode: 'open' });
  const stickyHost = document.createElement('rc-stickies');
  stickyHost.setAttribute('data-rc-ui', '');
  stickyHost.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;';
  const sroot = stickyHost.attachShadow({ mode: 'open' });

  const BASE_CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
    button:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid #7c5cff;outline-offset:2px}
    .panel{--bg:#ffffff;--fg:#1f1f24;--muted:#6b6b76;--line:#e4e4ea;--hover:#f1f0f7;
      background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;
      box-shadow:0 8px 28px rgba(20,20,40,.18),0 2px 6px rgba(20,20,40,.08);font-size:13px;line-height:1.4}
    @media (prefers-color-scheme:dark){.panel{--bg:#24232b;--fg:#ececf1;--muted:#a3a2ad;--line:#3a3944;--hover:#302f39}}
    .dot{width:20px;height:20px;border-radius:50%;border:2px solid rgba(0,0,0,.12);display:inline-block}
    .sw{padding:4px;border-radius:50%;display:inline-flex}
    .sw:hover{background:var(--hover)}
    .sw[aria-pressed="true"] .dot{border-color:var(--fg)}
    .ib{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;padding:0 8px;border-radius:8px;color:var(--fg)}
    .ib:hover{background:var(--hover)}
    .sep{width:1px;align-self:stretch;background:var(--line);margin:4px 4px}
    svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  `;
  const ICON = {
    comment: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    clip: '<svg viewBox="0 0 24 24"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    max: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>',
    palette: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/></svg>',
  };

  const uiStyle = document.createElement('style');
  uiStyle.textContent = BASE_CSS + `
    .toolbar{position:fixed;display:flex;align-items:center;gap:2px;padding:4px;animation:pop .12s ease-out}
    .pop{position:fixed;width:300px;padding:12px;display:flex;flex-direction:column;gap:8px;animation:pop .12s ease-out}
    .pop .row{display:flex;align-items:center;gap:2px}
    .pop .quote{font-size:12px;color:var(--muted);max-height:54px;overflow:hidden;border-left:3px solid var(--qc);padding-left:8px}
    .pop textarea{width:100%;min-height:72px;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:var(--fg);font-size:13px}
    .pop .spacer{flex:1}
    .pop .hint{font-size:11px;color:var(--muted)}
    .toast{position:fixed;right:16px;bottom:16px;padding:10px 14px;animation:pop .15s ease-out}
    .danger:hover{color:#e03131}
    @keyframes pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  `;
  ui.appendChild(uiStyle);

  const stickyStyle = document.createElement('style');
  stickyStyle.textContent = BASE_CSS + `
    .sticky{position:absolute;display:flex;flex-direction:column;min-width:160px;min-height:40px;max-width:900px;
      background:var(--sc);color:#26251f;border-radius:10px;resize:both;overflow:hidden;
      box-shadow:0 10px 30px rgba(30,30,10,.22),0 1px 3px rgba(30,30,10,.15);border:1px solid rgba(0,0,0,.08);font-size:13px}
    .sticky.collapsed{resize:none;height:auto!important;min-height:0}
    .sticky.collapsed textarea{display:none}
    .sticky.dragging{opacity:.9;box-shadow:0 16px 40px rgba(30,30,10,.3)}
    .head{display:flex;align-items:center;gap:2px;padding:4px 4px 4px 10px;cursor:grab;user-select:none;background:rgba(0,0,0,.05);flex:none}
    .head:active{cursor:grabbing}
    .title{flex:1;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.75}
    .sticky .ib{color:#26251f;height:24px;min-width:24px;padding:0 4px}
    .sticky .ib:hover{background:rgba(0,0,0,.08)}
    textarea{flex:1;width:100%;border:0;outline:0;resize:none;background:transparent;color:inherit;padding:8px 10px 12px;font-size:13px;line-height:1.45}
    textarea:focus-visible{outline:none}
    .colors{display:none;position:absolute;top:30px;right:6px;padding:4px;gap:2px;z-index:2}
    .colors.open{display:flex}
    .colors .dot{width:18px;height:18px}
  `;
  sroot.appendChild(stickyStyle);

  function mountUi() {
    if (!uiHost.isConnected) document.documentElement.appendChild(uiHost);
    if (!stickyHost.isConnected) document.documentElement.appendChild(stickyHost);
  }

  function h(tag, attrs = {}, html) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    if (html != null) el.innerHTML = html;
    return el;
  }

  function toast(text) {
    mountUi();
    const t = h('div', { class: 'panel toast', role: 'status' });
    t.textContent = text;
    ui.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------- selection toolbar ----------
  let toolbar = null;
  let savedRange = null;

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.toString().trim()) return null;
    const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    if (anc && (anc.closest('input,textarea,[contenteditable=""],[contenteditable="true"]') || anc.closest('[data-rc-ui]'))) return null;
    return r;
  }

  function showToolbar(range) {
    hideToolbar();
    mountUi();
    savedRange = range.cloneRange();
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    toolbar = h('div', { class: 'panel toolbar', role: 'toolbar', 'aria-label': 'Research Canvas' });
    for (const c of COLOR_IDS) {
      toolbar.appendChild(h('button', {
        class: 'sw', title: `Highlight ${c}`, 'aria-label': `Highlight ${c}`,
        onmousedown: e => e.preventDefault(),
        onclick: () => { createFromRange(savedRange, c); },
      }, `<span class="dot" style="background:${COLORS[c]}"></span>`));
    }
    toolbar.appendChild(h('span', { class: 'sep' }));
    toolbar.appendChild(h('button', {
      class: 'ib', title: 'Highlight and comment', 'aria-label': 'Highlight and comment',
      onmousedown: e => e.preventDefault(),
      onclick: async () => {
        const hl = await createFromRange(savedRange, settings.defaultColor);
        if (hl) setTimeout(() => openPopover(hl.id, true), 50);
      },
    }, ICON.comment));
    toolbar.appendChild(h('button', {
      class: 'ib', title: 'Clip selection to project', 'aria-label': 'Clip selection to project',
      onmousedown: e => e.preventDefault(),
      onclick: async () => {
        const r = await send({ type: 'clip:selection', url: pageUrl, title: document.title, content: rangeToMarkdown(savedRange), text: savedRange.toString() });
        hideToolbar();
        toast(r.ok ? `Clipped to ${r.projectName || 'project'}` : 'Could not clip: ' + (r.error || 'unknown error'));
      },
    }, ICON.clip));
    toolbar.appendChild(h('button', {
      class: 'ib', title: 'Add sticky note here', 'aria-label': 'Add sticky note here',
      onmousedown: e => e.preventDefault(),
      onclick: () => {
        const text = savedRange.toString().trim();
        const b = rect;
        hideToolbar();
        addSticky({ x: b.left + window.scrollX, y: b.bottom + window.scrollY + 8, text: text ? `> ${text.slice(0, 400)}\n\n` : '' });
      },
    }, ICON.note));
    ui.appendChild(toolbar);
    const tw = toolbar.offsetWidth || 280;
    const th = toolbar.offsetHeight || 40;
    let x = rect.right - tw / 2;
    let y = rect.bottom + 8;
    if (y + th > innerHeight - 4) y = rect.top - th - 8;
    x = Math.max(8, Math.min(innerWidth - tw - 8, x));
    y = Math.max(8, y);
    toolbar.style.left = x + 'px';
    toolbar.style.top = y + 'px';
  }

  async function createFromRange(range, color) {
    hideToolbar();
    if (!range) { toast('Select some text first'); return null; }
    const sel = rangeToSelector(range);
    if (!sel) { toast('Could not highlight this selection'); return null; }
    const hl = { id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), color: color || settings.defaultColor, ...sel, comment: '' };
    // Paint optimistically, then persist.
    page.highlights.push(hl);
    pendingHl.set(hl.id, hl);
    observerPaused = true;
    anchorHighlight(hl);
    observerPaused = false;
    window.getSelection().removeAllRanges();
    const r = await send({ type: 'hl:add', url: pageUrl, title: document.title, highlight: hl });
    pendingHl.delete(hl.id);
    if (!r.ok) {
      unwrap(hl.id);
      page.highlights = page.highlights.filter(x => x.id !== hl.id);
      toast('Could not save highlight: ' + (r.error || ''));
      return null;
    }
    return hl;
  }

  // ---------- selection to Markdown ----------
  function rangeToMarkdown(range) {
    if (!range) return '';
    try {
      const frag = range.cloneContents();
      const div = document.createElement('div');
      div.appendChild(frag);
      const md = nodeToMd(div).replace(/\n{3,}/g, '\n\n').trim();
      return md || range.toString().trim();
    } catch {
      return range.toString().trim();
    }
  }
  function abs(u) { try { return new URL(u, location.href).href; } catch { return u; } }
  function nodeToMd(node, ctx = { list: null, n: 0 }) {
    if (node.nodeType === 3) return node.data.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'svg', 'button', 'rc-ui'].includes(tag)) return '';
    const kids = c => [...node.childNodes].map(n => nodeToMd(n, c || ctx)).join('');
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n\n${'#'.repeat(+tag[1])} ${kids().trim()}\n\n`;
      case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer': case 'figure':
        return `\n\n${kids().trim()}\n\n`;
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': { const t = kids().trim(); return t ? `**${t}**` : ''; }
      case 'em': case 'i': { const t = kids().trim(); return t ? `*${t}*` : ''; }
      case 'code': return node.closest('pre') ? node.textContent : '`' + node.textContent + '`';
      case 'pre': return '\n\n```\n' + node.textContent.replace(/\n$/, '') + '\n```\n\n';
      case 'a': {
        const t = kids().trim();
        const href = node.getAttribute('href');
        return href && !href.startsWith('javascript:') && t ? `[${t}](${abs(href)})` : t;
      }
      case 'img': {
        const src = node.getAttribute('src');
        return src ? `![${(node.getAttribute('alt') || '').replace(/[\[\]]/g, '')}](${abs(src)})` : '';
      }
      case 'ul': case 'ol': {
        const c = { list: tag, n: 0 };
        return '\n\n' + [...node.children].map(li => {
          c.n++;
          const inner = [...li.childNodes].map(n => nodeToMd(n, c)).join('').trim().replace(/\n+/g, '\n  ');
          return (tag === 'ol' ? `${c.n}. ` : '- ') + inner;
        }).join('\n') + '\n\n';
      }
      case 'li': return '- ' + kids().trim() + '\n';
      case 'blockquote': return '\n\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
      case 'tr': return [...node.children].map(td => nodeToMd(td).trim()).join(' | ') + '\n';
      default: return kids();
    }
  }

  // ---------- highlight popover ----------
  let popover = null;
  let popoverId = null;

  function closePopover() {
    if (popover) {
      const ta = popover.querySelector('textarea');
      if (ta && ta.dataset.dirty) saveComment(popoverId, ta.value);
      popover.remove();
      popover = null;
    }
    for (const els of anchored.values()) for (const m of els) m.classList.remove('rc-focus');
    popoverId = null;
  }

  async function saveComment(id, value) {
    const hl = page.highlights.find(x => x.id === id);
    if (!hl || hl.comment === value) return;
    hl.comment = value;
    decorate(anchored.get(id) || [], hl);
    await send({ type: 'hl:update', url: pageUrl, id, patch: { comment: value } });
  }

  function openPopover(id, focusComment) {
    closePopover();
    hideToolbar();
    const hl = page.highlights.find(x => x.id === id);
    const els = anchored.get(id);
    if (!hl || !els || !els.length) return;
    mountUi();
    popoverId = id;
    for (const m of els) m.classList.add('rc-focus');
    popover = h('div', { class: 'panel pop', role: 'dialog', 'aria-label': 'Highlight' });
    popover.style.setProperty('--qc', COLORS[hl.color]);
    const row = h('div', { class: 'row' });
    for (const c of COLOR_IDS) {
      row.appendChild(h('button', {
        class: 'sw', title: c, 'aria-label': `Change color to ${c}`, 'aria-pressed': String(hl.color === c),
        onclick: async () => {
          hl.color = c;
          decorate(anchored.get(id) || [], hl);
          popover.style.setProperty('--qc', COLORS[c]);
          row.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', String(b.title === c)));
          await send({ type: 'hl:update', url: pageUrl, id, patch: { color: c } });
        },
      }, `<span class="dot" style="background:${COLORS[c]}"></span>`));
    }
    row.appendChild(h('span', { class: 'spacer' }));
    row.appendChild(h('button', {
      class: 'ib', title: 'Copy text', 'aria-label': 'Copy highlighted text',
      onclick: async () => {
        try { await navigator.clipboard.writeText(hl.quote.exact); toast('Copied'); } catch { toast('Copy failed'); }
      },
    }, ICON.copy));
    row.appendChild(h('button', {
      class: 'ib danger', title: 'Delete highlight', 'aria-label': 'Delete highlight',
      onclick: async () => {
        const hid = id;
        popover.querySelector('textarea').dataset.dirty = '';
        closePopover();
        unwrap(hid);
        page.highlights = page.highlights.filter(x => x.id !== hid);
        updateBadge();
        await send({ type: 'hl:delete', url: pageUrl, id: hid });
      },
    }, ICON.trash));
    row.appendChild(h('button', { class: 'ib', title: 'Close', 'aria-label': 'Close', onclick: closePopover }, ICON.close));
    popover.appendChild(row);
    const q = h('div', { class: 'quote' });
    q.textContent = hl.quote.exact;
    popover.appendChild(q);
    const ta = h('textarea', { placeholder: 'Add a comment…', 'aria-label': 'Comment' });
    ta.value = hl.comment || '';
    ta.addEventListener('input', () => { ta.dataset.dirty = '1'; });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closePopover(); }
      if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
    });
    ta.addEventListener('keyup', e => e.stopPropagation());
    ta.addEventListener('keypress', e => e.stopPropagation());
    popover.appendChild(ta);
    popover.appendChild(h('div', { class: 'hint' }, 'Saved automatically. Ctrl+Enter or Esc to close.'));
    ui.appendChild(popover);
    const r = els[0].getBoundingClientRect();
    const pw = 300;
    const ph = popover.offsetHeight || 200;
    let x = Math.max(8, Math.min(innerWidth - pw - 8, r.left));
    let y = r.bottom + 8;
    if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 8);
    popover.style.left = x + 'px';
    popover.style.top = y + 'px';
    if (focusComment) ta.focus();
    else row.querySelector('.sw').focus();
  }

  // ---------- sticky notes ----------
  const stickyEls = new Map();
  const saveTimers = new Map();
  const unsavedStickies = new Set(); // created locally, first save not confirmed yet

  function persistSticky(s, delay = 400) {
    clearTimeout(saveTimers.get(s.id));
    saveTimers.set(s.id, setTimeout(() => {
      saveTimers.delete(s.id);
      send({ type: 'sticky:upsert', url: pageUrl, title: document.title, sticky: s }).then(() => unsavedStickies.delete(s.id));
    }, delay));
  }

  function addSticky({ x, y, text = '' } = {}) {
    const vw = document.documentElement.clientWidth;
    const s = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      color: 'yellow',
      x: Math.round(Math.max(8, Math.min((x ?? window.scrollX + vw - 280), window.scrollX + vw - 260))),
      y: Math.round(Math.max(8, y ?? window.scrollY + 96)),
      w: 240,
      h: 180,
      collapsed: false,
    };
    page.stickies.push(s);
    unsavedStickies.add(s.id);
    renderSticky(s, true);
    updateBadge();
    persistSticky(s, 0);
    return s;
  }

  function stickyTitle(s) {
    const line = (s.text || '').split('\n').map(l => l.replace(/^[>#\-*\s]+/, '').trim()).find(Boolean);
    return line || 'Sticky note';
  }

  function renderSticky(s, focus) {
    mountUi();
    let el = stickyEls.get(s.id);
    if (!el) {
      el = h('section', { class: 'sticky', 'aria-label': 'Sticky note' });
      const head = h('div', { class: 'head', tabindex: '0', title: 'Drag to move. Arrow keys move when focused.', 'aria-label': 'Move sticky note' });
      const title = h('span', { class: 'title' });
      const colorBtn = h('button', { class: 'ib', title: 'Color', 'aria-label': 'Change color', 'aria-haspopup': 'true' }, ICON.palette);
      const sendBtn = h('button', { class: 'ib', title: 'Send to project as a note', 'aria-label': 'Send to project as a note' }, ICON.send);
      const colBtn = h('button', { class: 'ib', title: 'Collapse', 'aria-label': 'Collapse note' }, ICON.min);
      const delBtn = h('button', { class: 'ib danger', title: 'Delete note', 'aria-label': 'Delete note' }, ICON.trash);
      head.append(title, colorBtn, sendBtn, colBtn, delBtn);
      const colors = h('div', { class: 'panel colors', role: 'menu' });
      for (const c of COLOR_IDS) {
        colors.appendChild(h('button', {
          class: 'sw', 'aria-label': c, title: c, role: 'menuitem',
          onclick: () => { s.color = c; colors.classList.remove('open'); renderSticky(s); persistSticky(s, 0); },
        }, `<span class="dot" style="background:${STICKY_COLORS[c]}"></span>`));
      }
      const ta = h('textarea', { placeholder: 'Write a note…', 'aria-label': 'Note text', spellcheck: 'true' });
      el.append(head, colors, ta);
      sroot.appendChild(el);
      stickyEls.set(s.id, el);

      ta.addEventListener('input', () => { s.text = ta.value; title.textContent = stickyTitle(s); persistSticky(s); });
      for (const ev of ['keydown', 'keyup', 'keypress']) ta.addEventListener(ev, e => e.stopPropagation());
      colorBtn.addEventListener('click', e => { e.stopPropagation(); colors.classList.toggle('open'); });
      sendBtn.addEventListener('click', async () => {
        const r = await send({ type: 'clip:add', clip: { type: 'note', title: stickyTitle(s), content: s.text, url: pageUrl, pageTitle: document.title } });
        toast(r.ok ? `Sent to ${r.projectName || 'project'}` : 'Could not send note');
      });
      colBtn.addEventListener('click', () => { s.collapsed = !s.collapsed; renderSticky(s); persistSticky(s, 0); });
      delBtn.addEventListener('click', async () => {
        if (s.text.trim() && !confirm('Delete this sticky note?')) return;
        el.remove();
        stickyEls.delete(s.id);
        page.stickies = page.stickies.filter(x => x.id !== s.id);
        clearTimeout(saveTimers.get(s.id));
        saveTimers.delete(s.id);
        unsavedStickies.delete(s.id);
        updateBadge();
        await send({ type: 'sticky:delete', url: pageUrl, id: s.id });
      });

      // Drag to move.
      head.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        head.setPointerCapture(e.pointerId);
        const sx = e.pageX - s.x;
        const sy = e.pageY - s.y;
        el.classList.add('dragging');
        const move = ev => {
          s.x = Math.max(0, Math.round(ev.pageX - sx));
          s.y = Math.max(0, Math.round(ev.pageY - sy));
          el.style.left = s.x + 'px';
          el.style.top = s.y + 'px';
        };
        const up = () => {
          head.removeEventListener('pointermove', move);
          head.removeEventListener('pointerup', up);
          head.removeEventListener('pointercancel', up);
          el.classList.remove('dragging');
          persistSticky(s, 0);
        };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
        head.addEventListener('pointercancel', up);
      });
      head.addEventListener('keydown', e => {
        const step = e.shiftKey ? 50 : 10;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        s.x = Math.max(0, s.x + d[0]);
        s.y = Math.max(0, s.y + d[1]);
        el.style.left = s.x + 'px';
        el.style.top = s.y + 'px';
        persistSticky(s);
      });
      // Resize (CSS resize: both) -> persist.
      let first = true;
      new ResizeObserver(() => {
        if (first) { first = false; return; }
        if (s.collapsed || el.classList.contains('dragging')) return;
        const w = Math.round(el.offsetWidth);
        const hh = Math.round(el.offsetHeight);
        if (w && hh && (w !== s.w || hh !== s.h)) { s.w = w; s.h = hh; persistSticky(s, 500); }
      }).observe(el);
    }
    const ta = el.querySelector('textarea');
    if (ta.value !== s.text && sroot.activeElement !== ta) ta.value = s.text || '';
    el.querySelector('.title').textContent = stickyTitle(s);
    el.style.setProperty('--sc', STICKY_COLORS[s.color] || STICKY_COLORS.yellow);
    el.style.left = s.x + 'px';
    el.style.top = s.y + 'px';
    el.style.width = s.w + 'px';
    if (!s.collapsed) el.style.height = s.h + 'px';
    el.classList.toggle('collapsed', !!s.collapsed);
    const colBtn = el.querySelectorAll('.head .ib')[2];
    colBtn.innerHTML = s.collapsed ? ICON.max : ICON.min;
    colBtn.title = s.collapsed ? 'Expand' : 'Collapse';
    colBtn.setAttribute('aria-label', s.collapsed ? 'Expand note' : 'Collapse note');
    colBtn.setAttribute('aria-expanded', String(!s.collapsed));
    if (focus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function syncStickies() {
    const want = new Set(page.stickies.map(s => s.id));
    for (const [id, el] of stickyEls) if (!want.has(id)) { el.remove(); stickyEls.delete(id); }
    for (const s of page.stickies) {
      if (saveTimers.has(s.id)) continue; // local edit pending; local copy wins
      renderSticky(s);
    }
  }

  // ---------- events ----------
  document.addEventListener('mouseup', e => {
    if (!alive || e.button !== 0) return;
    if (e.composedPath().some(n => n === uiHost || n === stickyHost)) return;
    setTimeout(() => {
      const r = selectionRange();
      if (r && settings.showToolbar) showToolbar(r);
      else if (!r) hideToolbar();
    }, 10);
  }, true);

  document.addEventListener('mousedown', e => {
    const path = e.composedPath();
    if (path.includes(uiHost)) return;
    hideToolbar();
    if (popover && !path.some(n => n.tagName && n.tagName.toLowerCase() === HL_TAG)) closePopover();
    if (!path.includes(stickyHost)) sroot.querySelectorAll('.colors.open').forEach(c => c.classList.remove('open'));
  }, true);

  document.addEventListener('click', e => {
    const m = e.target && e.target.closest && e.target.closest(HL_TAG);
    if (!m) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Let real links work with modifier keys; otherwise open the highlight popover.
    if (m.closest('a') && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    openPopover(m.getAttribute('data-rc-id'));
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideToolbar(); if (popover) closePopover(); }
  });
  document.addEventListener('contextmenu', e => { lastContextPoint = { x: e.pageX, y: e.pageY }; }, true);
  window.addEventListener('scroll', () => hideToolbar(), { passive: true });

  // ---------- messages ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('rc:')) return;
    switch (msg.type) {
      case 'rc:ping':
        sendResponse({ ok: true, url: pageUrl, title: document.title, orphans: [...orphans] });
        break;
      case 'rc:highlight': {
        const r = selectionRange() || savedRange;
        if (!r || !r.toString().trim()) { toast('Select some text to highlight'); sendResponse({ ok: false }); break; }
        createFromRange(r, msg.color).then(hl => sendResponse({ ok: !!hl }));
        return true;
      }
      case 'rc:selection': {
        const r = selectionRange();
        sendResponse({ ok: true, markdown: r ? rangeToMarkdown(r) : '', text: r ? r.toString() : '', url: pageUrl, title: document.title });
        break;
      }
      case 'rc:addSticky': {
        const p = msg.atContext && lastContextPoint ? lastContextPoint : {};
        const s = addSticky({ x: p.x, y: p.y, text: msg.text || '' });
        sendResponse({ ok: true, id: s.id });
        break;
      }
      case 'rc:scrollTo': {
        const els = anchored.get(msg.id);
        if (els && els.length) {
          els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          for (const m of els) { m.classList.remove('rc-flash'); void m.offsetWidth; m.classList.add('rc-flash'); }
          setTimeout(() => els.forEach(m => m.classList.remove('rc-flash')), 2600);
          sendResponse({ ok: true });
        } else if (stickyEls.has(msg.id)) {
          const el = stickyEls.get(msg.id);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.querySelector('textarea').focus({ preventScroll: true });
          sendResponse({ ok: true });
        } else {
          toast('This highlight could not be found on the current page');
          sendResponse({ ok: false });
        }
        break;
      }
      case 'rc:toast':
        toast(msg.text);
        sendResponse({ ok: true });
        break;
    }
  });

  // React to changes made elsewhere (side panel, other tabs, context menu).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !alive) return;
    if (changes.settings) {
      settings = { ...settings, ...(changes.settings.newValue || {}) };
      if (!settings.showToolbar) hideToolbar();
    }
    const ch = changes['page:' + pageUrl];
    if (ch) {
      const next = ch.newValue || { highlights: [], stickies: [] };
      // Keep optimistic local highlights that have not been persisted yet.
      const highlights = [...(next.highlights || [])];
      for (const [id, hl] of pendingHl) if (!highlights.some(x => x.id === id)) highlights.push(hl);
      const stickies = [...(next.stickies || [])];
      for (const id of unsavedStickies) {
        const local = page.stickies.find(x => x.id === id);
        if (local && !stickies.some(x => x.id === id)) stickies.push(local);
      }
      page = { ...next, highlights, stickies };
      syncHighlights();
      syncStickies();
      if (popoverId && !page.highlights.some(x => x.id === popoverId)) closePopover();
    }
  });

  async function load() {
    try {
      const key = 'page:' + pageUrl;
      const r = await chrome.storage.local.get(['settings', key]);
      settings = { ...settings, ...(r.settings || {}) };
      page = r[key] || { highlights: [], stickies: [] };
      page.highlights = page.highlights || [];
      page.stickies = page.stickies || [];
    } catch {
      alive = false;
      return;
    }
    if (page.highlights.length || page.stickies.length) mountUi();
    syncHighlights();
    syncStickies();
    if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function reset() {
    closePopover();
    hideToolbar();
    for (const id of [...anchored.keys()]) unwrap(id);
    orphans.clear();
    for (const el of stickyEls.values()) el.remove();
    stickyEls.clear();
    page = { highlights: [], stickies: [] };
  }

  // SPA navigation: reload annotations when the URL (minus hash) changes.
  setInterval(() => {
    if (!alive) return;
    const u = normalizeUrl(location.href);
    if (u !== pageUrl) {
      reset();
      pageUrl = u;
      load();
    }
  }, 1000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
