/* Accessibility Auditor - on-page overlays.
 * Highlight an element, issue markers, tab-order visualiser, headings/landmarks labels
 * and colour-vision simulation filters. Everything lives in one shadow-rooted host so
 * page styles cannot leak in and our styles cannot leak out.
 * Exposes window.A11Y.overlay
 */
(function (root) {
  'use strict';
  const A11Y = (root.A11Y = root.A11Y || {});
  const VERSION = 1;
  if (A11Y.overlay && A11Y.overlay.version === VERSION) return;

  const HOST_ID = '__a11y-auditor-root';
  const FILTER_SVG_ID = '__a11y-auditor-filters';
  const doc = root.document;

  const IMPACT_COLORS = { critical: '#c62828', serious: '#e65100', moderate: '#b28704', minor: '#1565c0', review: '#6a1b9a' };
  const LANDMARK_COLORS = { banner: '#00897b', navigation: '#5e35b1', main: '#d81b60', complementary: '#6d4c41', contentinfo: '#546e7a', search: '#0277bd', form: '#2e7d32', region: '#ef6c00' };

  let host = null;
  let shadow = null;
  const layers = {}; // name -> { el, update }
  let rafPending = false;

  const CSS_TEXT = `
    :host { all: initial; }
    .layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
    .box { position: absolute; box-sizing: border-box; border-radius: 3px; }
    .hl { outline: 3px solid #d81b60; outline-offset: 2px; box-shadow: 0 0 0 9999px rgba(0,0,0,.18); animation: pulse 1.2s ease-out 2; }
    @keyframes pulse { 0% { outline-color: #d81b60; } 50% { outline-color: #ffb300; } 100% { outline-color: #d81b60; } }
    .hl-label { position: absolute; font: 600 12px/1.3 system-ui, sans-serif; color: #fff; background: #d81b60; padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .marker { position: absolute; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4);
      font: 700 11px/16px system-ui, sans-serif; color: #fff; text-align: center; pointer-events: auto; cursor: pointer; padding: 0; box-sizing: border-box; }
    .marker:focus-visible { outline: 3px solid #111; outline-offset: 2px; }
    .marker-box { position: absolute; box-sizing: border-box; border: 2px dashed; border-radius: 3px; }
    .tab-num { position: absolute; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 11px; box-sizing: border-box;
      background: #1a237e; color: #fff; font: 700 11px/22px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.45); }
    .tab-num.pos { background: #c62828; }
    .tab-box { position: absolute; box-sizing: border-box; border: 2px solid #3949ab; border-radius: 3px; }
    svg.path { position: absolute; left: 0; top: 0; overflow: visible; }
    .lm-box { position: absolute; box-sizing: border-box; border: 3px dashed; border-radius: 4px; }
    .tag { position: absolute; font: 700 11px/1.4 system-ui, sans-serif; color: #fff; padding: 1px 6px; border-radius: 3px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 1px 2px rgba(0,0,0,.35); }
    .tip { position: absolute; max-width: 320px; font: 12px/1.4 system-ui, sans-serif; color: #111; background: #fff; border: 1px solid #999; border-radius: 6px; padding: 6px 8px; box-shadow: 0 2px 8px rgba(0,0,0,.25); pointer-events: auto; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return shadow;
    host = doc.getElementById(HOST_ID);
    if (!host) {
      host = doc.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;';
      (doc.documentElement || doc.body).appendChild(host);
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    if (!shadow.querySelector('style')) {
      const st = doc.createElement('style');
      st.textContent = CSS_TEXT;
      shadow.appendChild(st);
    }
    return shadow;
  }

  function layer(name) {
    const sh = ensureHost();
    if (layers[name] && layers[name].el.isConnected) return layers[name];
    const el = doc.createElement('div');
    el.className = 'layer';
    el.dataset.layer = name;
    sh.appendChild(el);
    layers[name] = { el, update: null };
    return layers[name];
  }

  function clearLayer(name) {
    const l = layers[name];
    if (!l) return;
    l.el.remove();
    delete layers[name];
    maybeRemoveHost();
  }

  function maybeRemoveHost() {
    if (Object.keys(layers).length === 0 && host && !doc.getElementById(FILTER_SVG_ID)) {
      host.remove();
      host = null;
      shadow = null;
      root.removeEventListener('scroll', schedule, true);
      root.removeEventListener('resize', schedule);
    }
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    root.requestAnimationFrame(() => {
      rafPending = false;
      for (const k of Object.keys(layers)) {
        const l = layers[k];
        if (l.update) {
          try {
            l.update();
          } catch (e) { /* element went away */ }
        }
      }
    });
  }

  function listen() {
    root.addEventListener('scroll', schedule, { passive: true, capture: true });
    root.addEventListener('resize', schedule, { passive: true });
  }

  function docRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + root.scrollX, y: r.top + root.scrollY, w: r.width, h: r.height, vis: r.width > 0 || r.height > 0 };
  }

  function refs() {
    return (A11Y.state && A11Y.state.refs) || new Map();
  }

  function getEl(ref) {
    const el = refs().get(ref);
    return el && el.isConnected ? el : null;
  }

  function place(node, x, y, w, h) {
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    if (w != null) node.style.width = w + 'px';
    if (h != null) node.style.height = h + 'px';
  }

  // ------------------------------------------------------------ highlight
  /** Scroll to an element and outline it. Returns false when the element is gone. */
  function highlight(ref, label) {
    const el = getEl(ref);
    if (!el) return false;
    clearLayer('hl');
    const l = layer('hl');
    const box = doc.createElement('div');
    box.className = 'box hl';
    const tag = doc.createElement('div');
    tag.className = 'hl-label';
    tag.textContent = label || (A11Y.dom ? A11Y.dom.selectorFor(el) : el.tagName.toLowerCase());
    l.el.append(box, tag);
    l.update = () => {
      const r = docRect(el);
      place(box, r.x - 2, r.y - 2, Math.max(r.w, 4) + 4, Math.max(r.h, 4) + 4);
      place(tag, r.x - 2, Math.max(0, r.y - 24));
    };
    l.update();
    listen();
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch (e) {
      el.scrollIntoView();
    }
    clearTimeout(highlight._t);
    highlight._t = setTimeout(() => clearLayer('hl'), 6000);
    return true;
  }

  // ------------------------------------------------------------ issue markers
  /**
   * items: [{ ref, impact, kind, title, count }]
   */
  function showMarkers(items) {
    clearLayer('markers');
    const l = layer('markers');
    const entries = [];
    const byRef = new Map();
    for (const it of items || []) {
      const el = getEl(it.ref);
      if (!el) continue;
      if (!byRef.has(it.ref)) byRef.set(it.ref, { el, items: [] });
      byRef.get(it.ref).items.push(it);
    }
    const order = ['critical', 'serious', 'moderate', 'minor'];
    for (const [ref, v] of byRef) {
      const worst = v.items.slice().sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact))[0];
      const allReview = v.items.every((i) => i.kind === 'review');
      const color = allReview ? IMPACT_COLORS.review : IMPACT_COLORS[worst.impact] || IMPACT_COLORS.minor;
      const outlineBox = doc.createElement('div');
      outlineBox.className = 'marker-box';
      outlineBox.style.borderColor = color;
      const m = doc.createElement('button');
      m.className = 'marker';
      m.type = 'button';
      m.style.background = color;
      m.textContent = allReview ? '?' : (v.items.length > 9 ? '9+' : String(v.items.length));
      const text = v.items.map((i) => `${i.kind === 'review' ? '[Review] ' : ''}${i.title}`).join('\n');
      m.title = text;
      m.setAttribute('aria-label', `${v.items.length} accessibility issue${v.items.length > 1 ? 's' : ''}: ${text}`);
      m.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        highlight(ref, v.items[0].title);
      });
      l.el.append(outlineBox, m);
      entries.push({ el: v.el, m, outlineBox });
    }
    l.update = () => {
      for (const e of entries) {
        const r = docRect(e.el);
        const hide = !r.vis;
        e.m.style.display = hide ? 'none' : '';
        e.outlineBox.style.display = hide ? 'none' : '';
        place(e.outlineBox, r.x, r.y, r.w, r.h);
        place(e.m, Math.max(0, r.x - 10), Math.max(0, r.y - 10));
      }
    };
    l.update();
    listen();
    return entries.length;
  }

  // ------------------------------------------------------------ tab order
  function collectAll() {
    const out = [];
    const walk = (node) => {
      for (const el of node.children) {
        if (el.id === HOST_ID) continue;
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
        walk(el);
      }
    };
    if (doc.documentElement) walk(doc.documentElement);
    return out;
  }

  /** Sequential focus order approximation: positive tabindex first (ascending), then DOM order. */
  function tabSequence() {
    const D = A11Y.dom;
    const els = collectAll().filter((el) => {
      if (!D.isFocusable(el)) return false;
      const ti = D.tabIndexValue(el);
      if (ti != null && ti < 0) return false;
      if (el.closest('[inert]')) return false;
      const st = root.getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      if (!D.isRendered(el) && D.tag(el) !== 'AREA') return false;
      // Hidden ancestors (display:none) make it unfocusable.
      let p = el.parentElement;
      while (p) {
        if (root.getComputedStyle(p).display === 'none') return false;
        p = p.parentElement;
      }
      // Only the checked radio (or first) of a group is in the sequence.
      if (D.tag(el) === 'INPUT' && (el.type || '').toLowerCase() === 'radio' && el.name) {
        const form = el.form || doc;
        const group = Array.from(form.querySelectorAll(`input[type="radio" i][name="${CSS.escape(el.name)}"]`));
        const checked = group.find((g) => g.checked);
        if (checked ? checked !== el : group[0] !== el) return false;
      }
      return true;
    });
    const positive = els.filter((el) => (D.tabIndexValue(el) || 0) > 0).sort((a, b) => D.tabIndexValue(a) - D.tabIndexValue(b));
    const rest = els.filter((el) => !((D.tabIndexValue(el) || 0) > 0));
    return positive.concat(rest);
  }

  function showTabOrder() {
    clearLayer('tab');
    const D = A11Y.dom;
    const seq = tabSequence();
    const l = layer('tab');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'path');
    const path = doc.createElementNS(NS, 'polyline');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#3949ab');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '6 4');
    path.setAttribute('opacity', '0.8');
    svg.appendChild(path);
    l.el.appendChild(svg);
    const items = seq.map((el, i) => {
      const box = doc.createElement('div');
      box.className = 'tab-box';
      const num = doc.createElement('div');
      num.className = 'tab-num' + ((D.tabIndexValue(el) || 0) > 0 ? ' pos' : '');
      num.textContent = String(i + 1);
      l.el.append(box, num);
      return { el, box, num };
    });
    l.update = () => {
      const pts = [];
      let maxX = 0;
      let maxY = 0;
      for (const it of items) {
        const r = docRect(it.el);
        place(it.box, r.x, r.y, r.w, r.h);
        place(it.num, Math.max(0, r.x - 11), Math.max(0, r.y - 11));
        if (r.vis) pts.push(`${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)}`);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
      }
      svg.setAttribute('width', String(Math.ceil(maxX + 20)));
      svg.setAttribute('height', String(Math.ceil(maxY + 20)));
      path.setAttribute('points', pts.join(' '));
    };
    l.update();
    listen();
    const refFor = A11Y.engine ? A11Y.engine.refFor : null;
    return seq.map((el, i) => {
      let name = '';
      try {
        name = D.accessibleName(el).name;
      } catch (e) { /* ignore */ }
      return {
        n: i + 1, ref: refFor ? refFor(el) : null, role: D.role(el) || el.tagName.toLowerCase(),
        name: name.slice(0, 120), tabindex: D.tabIndexValue(el), selector: D.selectorFor(el),
      };
    });
  }

  // ------------------------------------------------------------ structure labels
  function showStructure(data) {
    clearLayer('structure');
    const l = layer('structure');
    const items = [];
    for (const lm of (data && data.landmarks) || []) {
      const el = getEl(lm.ref);
      if (!el) continue;
      const color = LANDMARK_COLORS[lm.role] || '#455a64';
      const box = doc.createElement('div');
      box.className = 'lm-box';
      box.style.borderColor = color;
      const tag = doc.createElement('div');
      tag.className = 'tag';
      tag.style.background = color;
      tag.textContent = lm.role + (lm.name ? ': ' + lm.name : '');
      l.el.append(box, tag);
      items.push({ el, box, tag, kind: 'lm' });
    }
    for (const h of (data && data.headings) || []) {
      const el = getEl(h.ref);
      if (!el) continue;
      const tag = doc.createElement('div');
      tag.className = 'tag';
      tag.style.background = h.skipped ? '#c62828' : '#283593';
      tag.textContent = 'H' + h.level + (h.skipped ? ' (skipped level)' : '');
      l.el.append(tag);
      items.push({ el, tag, kind: 'h' });
    }
    l.update = () => {
      for (const it of items) {
        const r = docRect(it.el);
        if (it.kind === 'lm') {
          place(it.box, r.x, r.y, r.w, r.h);
          place(it.tag, r.x, r.y);
        } else {
          place(it.tag, Math.max(0, r.x - 4), Math.max(0, r.y - 18));
        }
      }
    };
    l.update();
    listen();
    return items.length;
  }

  // ------------------------------------------------------------ colour vision
  // Machado, Oliveira & Fernandes (2009) matrices at full severity, applied in linear RGB.
  const MATRICES = {
    protanopia: '0.152286 1.052583 -0.204868 0 0  0.114503 0.786281 0.099216 0 0  -0.003882 -0.048116 1.051998 0 0  0 0 0 1 0',
    deuteranopia: '0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0',
    tritanopia: '1.255528 -0.076749 -0.178779 0 0  -0.078411 0.930809 0.147602 0 0  0.004733 0.691367 0.303900 0 0  0 0 0 1 0',
    achromatopsia: '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0',
  };
  const VISION_TYPES = ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred'];

  function ensureFilters() {
    let svg = doc.getElementById(FILTER_SVG_ID);
    if (svg) return svg;
    const NS = 'http://www.w3.org/2000/svg';
    svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('id', FILTER_SVG_ID);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('style', 'position:absolute!important;width:0!important;height:0!important;overflow:hidden!important;left:-9999px!important;');
    const defs = doc.createElementNS(NS, 'defs');
    for (const [name, values] of Object.entries(MATRICES)) {
      const f = doc.createElementNS(NS, 'filter');
      f.setAttribute('id', '__a11y-cv-' + name);
      f.setAttribute('color-interpolation-filters', 'linearRGB');
      const m = doc.createElementNS(NS, 'feColorMatrix');
      m.setAttribute('type', 'matrix');
      m.setAttribute('values', values);
      f.appendChild(m);
      defs.appendChild(f);
    }
    svg.appendChild(defs);
    (doc.body || doc.documentElement).appendChild(svg);
    return svg;
  }

  let savedFilter = null;
  let currentVision = 'none';

  function setVision(type) {
    const html = doc.documentElement;
    if (VISION_TYPES.indexOf(type) === -1) type = 'none';
    if (savedFilter === null) savedFilter = html.style.getPropertyValue('filter') || '';
    if (type === 'none') {
      if (savedFilter) html.style.setProperty('filter', savedFilter);
      else html.style.removeProperty('filter');
      savedFilter = null;
      const svg = doc.getElementById(FILTER_SVG_ID);
      if (svg) svg.remove();
      currentVision = 'none';
      maybeRemoveHost();
      return 'none';
    }
    if (type === 'blurred') {
      html.style.setProperty('filter', 'blur(2px)', 'important');
    } else {
      ensureFilters();
      html.style.setProperty('filter', `url(#__a11y-cv-${type})`, 'important');
    }
    currentVision = type;
    return type;
  }

  // ------------------------------------------------------------ clear / status
  function clear(what) {
    const names = what ? [].concat(what) : Object.keys(layers).concat(['vision']);
    for (const n of names) {
      if (n === 'vision') setVision('none');
      else clearLayer(n);
    }
    return status();
  }

  function status() {
    return {
      markers: !!layers.markers, tab: !!layers.tab, structure: !!layers.structure,
      vision: currentVision,
    };
  }

  A11Y.overlay = { version: VERSION, highlight, showMarkers, showTabOrder, tabSequence, showStructure, setVision, clear, status, VISION_TYPES };
})(typeof window !== 'undefined' ? window : self);
