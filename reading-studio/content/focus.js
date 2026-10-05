// Reading Studio focus aids: a reading ruler that follows the pointer, and bionic-style bold word starts.
(function () {
  const RS = globalThis.RS;
  if (!RS || RS.focus) return;

  // ---------------------------------------------------------------- ruler
  const R = { on: false, host: null, root: null, y: innerHeight / 2, raf: 0 };

  function rulerCss(f) {
    const h = Math.max(16, Math.min(240, f.rulerHeight || 56));
    const op = Math.max(0.1, Math.min(0.9, f.rulerOpacity || 0.55));
    const color = /^#[0-9a-f]{6}$/i.test(f.rulerColor || '') ? f.rulerColor : '#ffd54a';
    return `
      :host{all:initial}
      .wrap{position:fixed;inset:0;pointer-events:none;--h:${h}px;--y:50vh}
      .top,.bottom{position:fixed;left:0;right:0;background:rgba(0,0,0,${op});transition:background .2s}
      .top{top:0;height:max(0px,calc(var(--y) - var(--h) / 2))}
      .bottom{top:calc(var(--y) + var(--h) / 2);bottom:0}
      .band{position:fixed;left:0;right:0;top:calc(var(--y) - var(--h) / 2);height:var(--h);box-sizing:border-box}
      .mode-focus .band{border-top:1px solid rgba(255,255,255,.25);border-bottom:1px solid rgba(255,255,255,.25)}
      .mode-band .top,.mode-band .bottom,.mode-underline .top,.mode-underline .bottom{display:none}
      .mode-band .band{background:${color};opacity:${Math.min(0.45, op * 0.6)};mix-blend-mode:multiply}
      .mode-underline .band{height:3px;top:calc(var(--y) + var(--h) / 2 - 3px);background:${color};border-radius:2px;opacity:.95;box-shadow:0 0 0 1px rgba(0,0,0,.15)}
      @media (prefers-reduced-motion:reduce){.top,.bottom{transition:none}}
    `;
  }

  function renderRuler() {
    if (!R.on) return;
    const f = RS.settings.focus;
    if (!R.host || !R.host.isConnected) {
      const { host, root } = RS.createHost('rs-ruler', 2147483646);
      host.style.setProperty('inset', '0', 'important');
      host.style.setProperty('pointer-events', 'none', 'important');
      R.host = host; R.root = root;
      root.innerHTML = '<style></style><div class="wrap"><div class="top"></div><div class="band"></div><div class="bottom"></div></div>';
    }
    R.root.querySelector('style').textContent = rulerCss(f);
    R.root.querySelector('.wrap').className = 'wrap mode-' + (f.rulerMode || 'focus');
    moveRuler();
  }

  function moveRuler() {
    R.raf = 0;
    if (R.root) R.root.querySelector('.wrap').style.setProperty('--y', R.y + 'px');
  }

  function onMove(e) {
    if (e.pointerType === 'touch') return;
    R.y = e.clientY;
    if (!R.raf) R.raf = requestAnimationFrame(moveRuler);
  }
  function onKey(e) {
    if (!R.on || e.defaultPrevented) return;
    // Alt+ArrowUp/Down nudges the ruler by one band for keyboard-only reading.
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const h = RS.settings.focus.rulerHeight || 56;
      R.y = Math.max(0, Math.min(innerHeight, R.y + (e.key === 'ArrowDown' ? h * 0.6 : -h * 0.6)));
      moveRuler();
      e.preventDefault();
    }
  }

  function setRuler(on) {
    R.on = !!on;
    if (R.on) {
      renderRuler();
      addEventListener('pointermove', onMove, { passive: true, capture: true });
      addEventListener('keydown', onKey, true);
    } else {
      removeEventListener('pointermove', onMove, { capture: true });
      removeEventListener('keydown', onKey, true);
      if (R.host) R.host.remove();
      R.host = R.root = null;
    }
    document.dispatchEvent(new CustomEvent('rs:focus-change'));
    return R.on;
  }

  // ---------------------------------------------------------------- bionic
  const B = { pageOn: false, roots: [] };
  const BIONIC_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'PRE', 'CODE', 'KBD', 'SAMP',
    'SVG', 'MATH', 'CANVAS', 'BUTTON', 'RS-B', 'RS-BW', 'RS-UI', 'TITLE', 'IFRAME', 'H1', 'H2', 'H3', 'B', 'STRONG', 'TH']);
  const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;

  function boldLen(word, strength) {
    const n = word.length;
    if (n <= 1) return n;
    if (n <= 3) return 1;
    return Math.max(1, Math.min(n - 1, Math.round(n * strength)));
  }

  function ensureBionicStyle(doc, target) {
    const css = 'rs-bw{display:inline !important;font:inherit !important}rs-b{display:inline !important;font-weight:700 !important;font-style:inherit !important;color:inherit !important}';
    const host = target || doc.head || doc.documentElement;
    if (Array.from(host.children || []).some((c) => c.matches('style[data-rs-bionic]'))) return;
    const st = doc.createElement('style');
    st.setAttribute('data-rs-bionic', '');
    st.textContent = css;
    host.appendChild(st);
  }

  // Wrap word starts under root. Returns number of text nodes changed.
  function applyBionic(root, strength, styleTarget) {
    const doc = root.ownerDocument || document;
    ensureBionicStyle(doc, styleTarget);
    strength = Math.max(0.2, Math.min(0.8, strength || 0.5));
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (BIONIC_SKIP.has(n.tagName.toUpperCase()) || n.isContentEditable || n.hasAttribute('data-rs-ui') || n.hasAttribute('data-rs-skip')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return /[\p{L}]{2}/u.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode()) && nodes.length < 40000) nodes.push(n);
    for (const t of nodes) {
      const text = t.nodeValue;
      const frag = doc.createDocumentFragment();
      let last = 0;
      WORD.lastIndex = 0;
      let m;
      while ((m = WORD.exec(text))) {
        const k = boldLen(m[0], strength);
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
        const b = doc.createElement('rs-b');
        b.textContent = m[0].slice(0, k);
        frag.appendChild(b);
        if (k < m[0].length) frag.appendChild(doc.createTextNode(m[0].slice(k)));
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      const wrap = doc.createElement('rs-bw');
      wrap.appendChild(frag);
      t.replaceWith(wrap);
    }
    return nodes.length;
  }

  function removeBionic(root) {
    for (const w of Array.from(root.querySelectorAll('rs-bw'))) {
      w.replaceWith((root.ownerDocument || document).createTextNode(w.textContent));
    }
    try { root.normalize(); } catch (e) { /* ignore */ }
  }

  function pageRoots() {
    try {
      const art = RS.extract ? RS.extract(document) : null;
      if (art && art.isProbablyArticle && art.sourceRoots.length) return art.sourceRoots;
    } catch (e) { /* fall back to body */ }
    return [document.body];
  }

  function setPageBionic(on) {
    if (on && !B.pageOn) {
      B.roots = pageRoots();
      for (const r of B.roots) applyBionic(r, RS.settings.focus.bionicStrength);
      B.pageOn = true;
    } else if (!on && B.pageOn) {
      for (const r of B.roots) if (r.isConnected) removeBionic(r);
      B.pageOn = false;
      B.roots = [];
    }
    document.dispatchEvent(new CustomEvent('rs:bionic-change', { detail: { on: B.pageOn, scope: 'page' } }));
    return B.pageOn;
  }

  RS.focus = {
    setRuler, get rulerOn() { return R.on; },
    applyBionic, removeBionic, setPageBionic, get pageBionic() { return B.pageOn; }
  };

  RS.onSettings((s, changed) => { if (changed.has('focus') && R.on) renderRuler(); });

  RS.handlers['ruler-toggle'] = async (args) => {
    const on = args && typeof args.on === 'boolean' ? args.on : !R.on;
    setRuler(on);
    RS.saveSettings({ focus: { ruler: on } });
    return on;
  };
  RS.handlers['bionic-toggle'] = async (args) => {
    // In reader view, bionic applies to the article; otherwise to the page's main content.
    if (RS.reader && RS.reader.isOpen()) {
      const on = args && typeof args.on === 'boolean' ? args.on : !RS.settings.focus.bionic;
      RS.settings.focus.bionic = on;
      RS.reader.setBionic(on);
      RS.saveSettings({ focus: { bionic: on } });
      return on;
    }
    const on = args && typeof args.on === 'boolean' ? args.on : !B.pageOn;
    return setPageBionic(on);
  };
})();
