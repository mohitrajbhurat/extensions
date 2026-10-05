/* Design Inspector app shell: shadow-DOM host, toolbar, panel manager, event routing. */
import { CSS } from './css.js';
import { h, clear, HOST_ATTR, sendMessage, loadState, saveState } from './util.js';
import { createInspect } from './inspect.js';
import { createMeasure, createRulers } from './measure.js';
import { openColors, pickColor } from './eyedropper.js';
import { openTokens } from './extract.js';
import { createLiveEdit } from './liveedit.js';
import { openAssets } from './assets.js';

const POINTER_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
const BAR_KEY = 'di.bar';

class App {
  constructor() {
    this.mounted = false;
    this.mode = null;
    this.alt = false;
    this.mouse = { x: -1, y: -1 };
    this.panelOwner = null;
    this.uiHidden = 0;
    this.rafPending = false;
    this.handlers = [];
  }

  /* ---------------------------------------------------------------- mount */
  mount() {
    if (this.mounted) return;
    this.mounted = true;
    const host = document.createElement('design-inspector-ui');
    host.setAttribute(HOST_ATTR, '');
    Object.assign(host.style, {
      all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      zIndex: '2147483647', display: 'block', pointerEvents: 'none',
    });
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', { text: CSS }));
    }
    this.host = host;
    this.shadow = shadow;
    this.root = h('div.root');
    this.overlay = h('div.overlay');
    this.guidesLayer = h('div');
    this.panelSlot = h('div');
    this.toastEl = h('div.toast', { role: 'status', 'aria-live': 'polite' });
    this.root.append(this.overlay, this.guidesLayer, this.panelSlot, this.toastEl);
    shadow.append(this.root);
    (document.documentElement || document.body).appendChild(host);

    this.modes = {
      inspect: createInspect(this),
      measure: createMeasure(this),
      edit: createLiveEdit(this),
    };
    this.rulers = createRulers(this);
    this.buildBar();

    this.on(window, 'pointermove', e => this.onMove(e), { capture: true, passive: true });
    for (const t of POINTER_EVENTS) this.on(window, t, e => this.onPointer(e), { capture: true });
    this.on(window, 'keydown', e => this.onKey(e), { capture: true });
    this.on(window, 'keyup', e => this.onKeyUp(e), { capture: true });
    this.on(window, 'blur', () => this.setAlt(false));
    this.on(window, 'scroll', () => this.requestRedraw(), { capture: true, passive: true });
    this.on(window, 'resize', () => { this.requestRedraw(); this.keepInView(); }, { passive: true });
    this.on(document, 'mouseleave', () => this.modeCall('onLeave'));

    sendMessage({ type: 'di-active', active: true });
    this.setMode('inspect');
    this.toast('Design Inspector on. Press Esc to close.');
  }

  destroy() {
    if (!this.mounted) return;
    this.setMode(null);
    this.rulers.setOn(false);
    this.closePanel();
    for (const [target, type, fn, opts] of this.handlers) target.removeEventListener(type, fn, opts);
    this.handlers = [];
    this.host.remove();
    this.mounted = false;
    sendMessage({ type: 'di-active', active: false });
  }

  toggle() {
    if (this.mounted) this.destroy();
    else this.mount();
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.handlers.push([target, type, fn, opts]);
  }

  /* -------------------------------------------------------------- toolbar */
  buildBar() {
    const tool = (id, label, key, title, onClick, pressable = true) => {
      const b = h('button.tool', {
        type: 'button', title: `${title} (${key})`, 'data-tool': id,
        'aria-pressed': pressable ? 'false' : null,
        onclick: onClick,
      }, label, h('kbd', key));
      return b;
    };
    this.buttons = {
      inspect: tool('inspect', 'Inspect', 'I', 'Hover to see the box model and type, click to pin', () => this.toggleMode('inspect')),
      measure: tool('measure', 'Measure', 'M', 'Click an element, then hover another to measure. Hold Alt while inspecting too', () => this.toggleMode('measure')),
      rulers: tool('rulers', 'Rulers', 'R', 'Show rulers. Drag from a ruler to add a guide', () => this.rulers.setOn(!this.rulers.on)),
      color: tool('color', 'Pick color', 'C', 'Eyedropper, color formats and contrast checker', () => this.startPick(), false),
      tokens: tool('tokens', 'Palette & type', 'P', 'Extract colors, fonts, spacing, radii and shadows. Export tokens', () => this.togglePanel('tokens', () => openTokens(this)), true),
      edit: tool('edit', 'Edit', 'E', 'Live edit text, spacing, colors and fonts', () => this.toggleMode('edit')),
      assets: tool('assets', 'Assets', 'A', 'List images, SVGs and background images', () => this.togglePanel('assets', () => openAssets(this)), true),
    };
    const grip = h('div.grip', { title: 'Drag to move the toolbar', 'aria-hidden': 'true' });
    const close = h('button.icon', { type: 'button', title: 'Close Design Inspector (Esc)', 'aria-label': 'Close Design Inspector', onclick: () => this.destroy() }, '✕');
    const b = this.buttons;
    this.bar = h('div.bar', { role: 'toolbar', 'aria-label': 'Design Inspector' },
      grip, h('span.brand', 'Design Inspector'),
      b.inspect, b.measure, b.rulers, h('span.sep'), b.color, b.tokens, b.edit, b.assets, h('span.sep'), close);
    this.root.append(this.bar);
    this.makeDraggable(this.bar, grip, pos => saveState(BAR_KEY, pos));
    loadState(BAR_KEY, null).then(pos => {
      if (pos && typeof pos.left === 'number') this.placeAt(this.bar, pos.left, pos.top);
    });
    // Arrow keys move between toolbar buttons.
    this.bar.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const btns = [...this.bar.querySelectorAll('button')];
      const i = btns.indexOf(this.shadow.activeElement);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
    });
  }

  syncButtons() {
    for (const [id, btn] of Object.entries(this.buttons)) {
      if (!btn.hasAttribute('aria-pressed')) continue;
      let on = false;
      if (id === 'rulers') on = this.rulers.on;
      else if (id === 'tokens' || id === 'assets') on = this.panelOwner === id;
      else on = this.mode === id;
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  /* ---------------------------------------------------------------- modes */
  setMode(name) {
    if (this.mode === name) return;
    const prev = this.mode && this.modes[this.mode];
    if (prev) prev.exit();
    this.mode = name;
    if (name) this.modes[name].enter();
    this.syncButtons();
    this.requestRedraw();
  }

  toggleMode(name) {
    this.setMode(this.mode === name ? null : name);
  }

  modeCall(fn, ...args) {
    const m = this.mode && this.modes[this.mode];
    if (m && typeof m[fn] === 'function') return m[fn](...args);
  }

  isOwnEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(this.host) || e.target === this.host;
  }

  onMove(e) {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (e.altKey !== this.alt) this.setAlt(e.altKey);
    this.rulers.onMove(e);
    if (this.isOwnEvent(e)) {
      this.modeCall('onLeave');
      return;
    }
    this.modeCall('onMove', e);
  }

  onPointer(e) {
    if (!this.mode || this.isOwnEvent(e)) return;
    const m = this.modes[this.mode];
    if (m.allowPageEvent && m.allowPageEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.button === 0) m.onClick && m.onClick(e);
  }

  setAlt(on) {
    if (this.alt === on) return;
    this.alt = on;
    this.modeCall('onAlt', on);
    this.requestRedraw();
  }

  /** True when keyboard focus is in an editable field (page or our UI). */
  typingTarget(e) {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = t.localName;
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') return !/^(button|checkbox|radio|range|color|submit|reset|file)$/i.test(t.type);
    return false;
  }

  onKey(e) {
    if (e.key === 'Alt') {
      if (this.mode === 'inspect' || this.mode === 'measure') e.preventDefault();
      this.setAlt(true);
      return;
    }
    if (this.modeCall('onKey', e) === true) return;
    if (this.typingTarget(e)) {
      if (e.key === 'Escape' && this.isOwnEvent(e)) {
        e.preventDefault();
        e.stopPropagation();
        this.shadow.activeElement && this.shadow.activeElement.blur();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.escape();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const map = {
      i: () => this.toggleMode('inspect'),
      m: () => this.toggleMode('measure'),
      r: () => this.rulers.setOn(!this.rulers.on),
      c: () => this.startPick(),
      p: () => this.togglePanel('tokens', () => openTokens(this)),
      e: () => this.toggleMode('edit'),
      a: () => this.togglePanel('assets', () => openAssets(this)),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn && !e.repeat) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fn();
    }
  }

  onKeyUp(e) {
    if (e.key === 'Alt') {
      if (this.mode === 'inspect' || this.mode === 'measure') e.preventDefault();
      this.setAlt(false);
    }
  }

  escape() {
    if (this.modeCall('onEscape') === true) return;
    if (this.panelOwner) {
      this.closePanel();
      return;
    }
    if (this.mode) {
      this.setMode(null);
      return;
    }
    this.destroy();
  }

  /* --------------------------------------------------------------- redraw */
  requestRedraw() {
    if (this.rafPending || !this.mounted) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (!this.mounted) return;
      for (const m of Object.values(this.modes)) if (m.redraw) m.redraw(this.mode === m.name);
      this.rulers.redraw();
    });
  }

  /** A child container in the overlay owned by one module. */
  layer(name) {
    let el = this.overlay.querySelector(`[data-layer="${name}"]`);
    if (!el) {
      el = h('div', { 'data-layer': name });
      this.overlay.append(el);
    }
    return el;
  }

  hideUI(on) {
    this.uiHidden += on ? 1 : -1;
    if (this.uiHidden < 0) this.uiHidden = 0;
    this.root.style.visibility = this.uiHidden ? 'hidden' : '';
  }

  /* ---------------------------------------------------------------- panel */
  /**
   * Show the single side panel. owner identifies who opened it so a toolbar
   * button can toggle it. Returns the panel element.
   */
  showPanel(owner, { title, sub, body, foot, tabs, wide, onClose } = {}) {
    this.closePanel(true);
    const titleEl = h('h2', title, sub ? h('span.sub', ' ' + sub) : null);
    const head = h('div.panel-head', titleEl,
      h('button.icon', { type: 'button', title: 'Close panel (Esc)', 'aria-label': 'Close panel', onclick: () => this.closePanel() }, '✕'));
    const panel = h('section.panel' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-label': title, 'data-owner': owner },
      head, tabs || null, h('div.panel-body', body), foot ? h('div.panel-foot', foot) : null);
    this.panelSlot.append(panel);
    this.panelOwner = owner;
    this.panelOnClose = onClose;
    this.makeDraggable(panel, head);
    if (this.panelPos) this.placeAt(panel, this.panelPos.left, this.panelPos.top);
    this.syncButtons();
    return panel;
  }

  setPanelBody(...kids) {
    const body = this.panelSlot.querySelector('.panel-body');
    if (body) {
      clear(body);
      for (const k of kids) if (k) body.append(k);
    }
  }

  closePanel(replacing = false) {
    const panel = this.panelSlot.querySelector('.panel');
    if (!panel) return;
    const cb = this.panelOnClose;
    this.panelOnClose = null;
    panel.remove();
    const owner = this.panelOwner;
    this.panelOwner = null;
    if (cb) cb(replacing);
    if (!replacing) this.syncButtons();
    return owner;
  }

  togglePanel(owner, open) {
    if (this.panelOwner === owner) this.closePanel();
    else open();
    this.syncButtons();
  }

  /* ---------------------------------------------------------- color pick */
  async startPick() {
    const color = await pickColor(this);
    openColors(this, color ? { pick: color } : {});
  }

  /* ---------------------------------------------------------------- utils */
  toast(text, ms = 1800) {
    const t = this.toastEl;
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  placeAt(el, left, top) {
    const r = el.getBoundingClientRect();
    const maxL = Math.max(0, innerWidth - Math.max(r.width, 60));
    const maxT = Math.max(0, innerHeight - Math.max(r.height, 30));
    el.style.left = Math.min(Math.max(0, left), maxL) + 'px';
    el.style.top = Math.min(Math.max(0, top), maxT) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  keepInView() {
    for (const el of [this.bar, this.panelSlot.querySelector('.panel')]) {
      if (!el || !el.style.left) continue;
      this.placeAt(el, parseFloat(el.style.left), parseFloat(el.style.top));
    }
  }

  makeDraggable(el, handle, onDone) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button,input,select,textarea')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = ev => this.placeAt(el, ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        const pos = { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 };
        if (el.classList.contains('panel')) this.panelPos = pos;
        if (onDone) onDone(pos);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
}

export function start() {
  const app = new App();
  app.mount();
  return {
    toggle: () => app.toggle(),
    destroy: () => app.destroy(),
    get active() { return app.mounted; },
    app,
  };
}
