// Annotation model, on-page rendering and pointer interactions.
// Every annotation lives in "page units" (PDF points of the displayed page, origin top-left), so the
// layers simply scale with CSS (var(--scale-factor)) when zooming.
import {
  arrowHead, ellipsePoints, markGeometry, smoothPath, polyPath, bbox,
  FONT_STACKS, LINE_HEIGHT
} from '../lib/annogeom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARKUP = new Set(['highlight', 'underline', 'strike']);
const DRAWING_TOOLS = new Set(['ink', 'rect', 'ellipse', 'line', 'arrow', 'text', 'date', 'note', 'place', 'mark-check', 'mark-cross', 'mark-dot']);
const HISTORY_LIMIT = 150;
const NOTE_SIZE = 22;

export const PALETTES = {
  markup: ['#ffd400', '#7cf06b', '#5ec8ff', '#ff8ad8', '#ffa64d', '#e0313f'],
  stroke: ['#000000', '#e0313f', '#f97316', '#eab308', '#16a34a', '#2563eb', '#7c3aed', '#ffffff'],
  note: ['#ffd400', '#ffa64d', '#7cf06b', '#5ec8ff', '#ff8ad8']
};

/** Which style controls apply to an annotation type / tool. */
export function styleKind(typeOrTool) {
  switch (typeOrTool) {
    case 'highlight': case 'underline': case 'strike': return 'markup';
    case 'ink': case 'line': case 'arrow': return 'stroke';
    case 'rect': case 'ellipse': return 'shape';
    case 'text': case 'date': return 'text';
    case 'note': return 'note';
    case 'mark': case 'mark-check': case 'mark-cross': case 'mark-dot': return 'mark';
    default: return null;
  }
}

const DEFAULT_STYLES = {
  highlight: { color: '#ffd400', opacity: 0.4 },
  underline: { color: '#e0313f', opacity: 1 },
  strike: { color: '#e0313f', opacity: 1 },
  ink: { color: '#e0313f', width: 3, opacity: 1 },
  shape: { color: '#e0313f', width: 2, fill: false, opacity: 1 },
  line: { color: '#e0313f', width: 2, opacity: 1 },
  text: { color: '#000000', size: 12, font: 'helvetica', opacity: 1 },
  note: { color: '#ffd400' },
  mark: { color: '#000000', opacity: 1 }
};

function styleKey(typeOrTool) {
  switch (typeOrTool) {
    case 'rect': case 'ellipse': return 'shape';
    case 'line': case 'arrow': return 'line';
    case 'date': return 'text';
    case 'mark': case 'mark-check': case 'mark-cross': case 'mark-dot': return 'mark';
    default: return typeOrTool;
  }
}

let uid = 0;
const newId = () => 'a' + Date.now().toString(36) + (uid++).toString(36);
const clone = (v) => JSON.parse(JSON.stringify(v));

export class AnnotationManager {
  /**
   * opts: {
   *   pagesEl: container with .page elements, getPageEl(i), getPageSize(i) -> {w,h},
   *   onChange(), onSelectionChange(), onToolChange(tool), getDateText(), toast(msg)
   * }
   */
  constructor(opts) {
    this.o = opts;
    this.annotations = [];
    this.layers = new Map(); // pageIndex -> { root, svg, html, draft }
    this.tool = 'view';
    this.selectedId = null;
    this.editingId = null;
    this.openNoteId = null;
    this.styles = clone(DEFAULT_STYLES);
    this.history = [];
    this.histIndex = -1;
    this.placeSrc = null;
    this.drag = null;
    this._bind();
  }

  // ---------- public API ----------

  reset(annotations = []) {
    this.annotations = clone(annotations);
    this.selectedId = null;
    this.editingId = null;
    this.openNoteId = null;
    this.history = [clone(this.annotations)];
    this.histIndex = 0;
    this.renderAll();
    this._emitSelection();
  }

  loadStyles(saved) {
    if (!saved) return;
    for (const k of Object.keys(DEFAULT_STYLES)) if (saved[k]) Object.assign(this.styles[k], saved[k]);
  }

  get count() {
    return this.annotations.length;
  }

  serialize() {
    return clone(this.annotations);
  }

  attachLayer(pageIndex, root) {
    root.innerHTML = '';
    const { w, h } = this.o.getPageSize(pageIndex);
    root.style.width = w + 'px';
    root.style.height = h + 'px';
    root.dataset.page = pageIndex;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('anno-svg');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const html = document.createElement('div');
    html.className = 'anno-html';
    root.append(svg, html);
    this.layers.set(pageIndex, { root, svg, html });
    this.renderPage(pageIndex);
  }

  setTool(tool) {
    if (this.editingId) this._finishEditing();
    if (tool !== 'place') this._clearGhost();
    this.tool = tool;
    if (tool !== 'select' && tool !== 'view') this.select(null);
    if (tool === 'view') this.select(null);
    const el = this.o.pagesEl;
    el.className = el.className.replace(/\btool-\S+/g, '').replace(/\bdrawing-mode\b/g, '').trim();
    el.classList.add('pages', `tool-${tool}`);
    if (DRAWING_TOOLS.has(tool)) el.classList.add('drawing-mode');
    this.o.onToolChange?.(tool);
  }

  /** Start placing an image (signature, stamp). size: natural {w,h} in units */
  startPlace(src, size, { field = null } = {}) {
    this.placeSrc = { src, w: size.w, h: size.h };
    if (field) {
      // Fit straight into a signature field.
      const fit = Math.min(field.w / size.w, field.h / size.h);
      const w = size.w * fit;
      const h = size.h * fit;
      const a = this._add({
        type: 'image', page: field.page, src,
        x: field.x + (field.w - w) / 2, y: field.y + (field.h - h) / 2, w, h, opacity: 1
      });
      this.setTool('select');
      this.select(a.id);
      return;
    }
    this.setTool('place');
  }

  select(id) {
    if (this.selectedId === id) return;
    const prev = this.selectedId && this._find(this.selectedId);
    this.selectedId = id;
    if (prev) this.renderPage(prev.page);
    const cur = id && this._find(id);
    if (cur) this.renderPage(cur.page);
    this._emitSelection();
  }

  get selected() {
    return this.selectedId ? this._find(this.selectedId) : null;
  }

  /** Style for the toolbar: of the selected annotation, else of the current tool. */
  activeStyle() {
    const sel = this.selected;
    if (sel) {
      const kind = styleKind(sel.type);
      return { kind, ...this._styleOf(sel), target: 'selection' };
    }
    const kind = styleKind(this.tool);
    if (!kind) return { kind: null };
    return { kind, ...this.styles[styleKey(this.tool)], target: 'tool' };
  }

  setStyle(patch) {
    const sel = this.selected;
    if (sel) {
      const p = { ...patch };
      if (sel.type === 'highlight' && p.color) p.opacity = this.styles.highlight.opacity;
      Object.assign(sel, p);
      Object.assign(this.styles[styleKey(sel.type)], patch);
      if (this.editingId === sel.id) this._styleEditor(sel);
      this.renderPage(sel.page);
      this._commit();
    } else {
      const key = styleKey(this.tool);
      if (this.styles[key]) Object.assign(this.styles[key], patch);
    }
    this.o.onStylesChange?.(this.styles);
  }

  deleteSelected() {
    const sel = this.selected;
    if (!sel) return false;
    this.editingId = null;
    if (this.openNoteId === sel.id) this.openNoteId = null;
    this.annotations = this.annotations.filter((a) => a.id !== sel.id);
    this.selectedId = null;
    this.renderPage(sel.page);
    this._commit();
    this._emitSelection();
    return true;
  }

  nudge(dx, dy) {
    const sel = this.selected;
    if (!sel || MARKUP.has(sel.type)) return false;
    translate(sel, dx, dy);
    this.renderPage(sel.page);
    this._commitDebounced();
    return true;
  }

  canUndo() {
    return this.histIndex > 0;
  }

  canRedo() {
    return this.histIndex < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo()) return;
    this._restore(--this.histIndex);
  }

  redo() {
    if (!this.canRedo()) return;
    this._restore(++this.histIndex);
  }

  /** Esc: finish editing, drop selection, go back to select. Returns true if handled. */
  escape() {
    if (this.editingId) {
      this._finishEditing();
      return true;
    }
    if (this.openNoteId) {
      const n = this._find(this.openNoteId);
      this.openNoteId = null;
      if (n) this.renderPage(n.page);
      return true;
    }
    if (this.tool !== 'select' && this.tool !== 'view') {
      this.setTool(this.o.defaultTool?.() || 'select');
      return true;
    }
    if (this.selectedId) {
      this.select(null);
      return true;
    }
    return false;
  }

  isEditingText() {
    return !!this.editingId;
  }

  renderAll() {
    for (const i of this.layers.keys()) this.renderPage(i);
  }

  annotationsOnPage(i) {
    return this.annotations.filter((a) => a.page === i);
  }

  // ---------- history ----------

  _commit() {
    this.history = this.history.slice(0, this.histIndex + 1);
    this.history.push(clone(this.annotations));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.histIndex = this.history.length - 1;
    this.o.onChange?.();
  }

  _commitDebounced() {
    clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => this._commit(), 400);
  }

  _restore(index) {
    this.annotations = clone(this.history[index]);
    this.editingId = null;
    if (this.selectedId && !this._find(this.selectedId)) this.selectedId = null;
    if (this.openNoteId && !this._find(this.openNoteId)) this.openNoteId = null;
    this.renderAll();
    this._emitSelection();
    this.o.onChange?.();
  }

  _emitSelection() {
    this.o.onSelectionChange?.(this.selected);
  }

  // ---------- model helpers ----------

  _find(id) {
    return this.annotations.find((a) => a.id === id) || null;
  }

  _add(a) {
    a.id = newId();
    a.created = Date.now();
    this.annotations.push(a);
    this.renderPage(a.page);
    this._commit();
    return a;
  }

  _styleOf(a) {
    const s = {};
    for (const k of ['color', 'width', 'size', 'font', 'fill', 'opacity']) if (a[k] !== undefined) s[k] = a[k];
    return s;
  }

  // ---------- rendering ----------

  renderPage(i) {
    const layer = this.layers.get(i);
    if (!layer) return;
    const { svg, html } = layer;
    let editor = null;
    if (this.editingId) {
      editor = html.querySelector('textarea.anno-editing');
      editor?.remove();
    }
    svg.replaceChildren();
    html.replaceChildren();
    for (const a of this.annotations) {
      if (a.page !== i) continue;
      if (a.id === this.editingId && editor) {
        html.append(editor);
        continue;
      }
      this._renderOne(a, svg, html);
    }
    const sel = this.selected;
    if (sel && sel.page === i) this._renderSelection(sel, html);
    const note = this.openNoteId && this._find(this.openNoteId);
    if (note && note.page === i) this._renderNotePopup(note, html);
  }

  _renderOne(a, svg, html) {
    const g = (tag, attrs, parent = svg) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
      parent.append(el);
      return el;
    };
    const op = a.opacity ?? 1;
    switch (a.type) {
      case 'highlight': {
        const grp = g('g', { 'data-id': a.id });
        for (const r of a.rects) g('rect', { class: 'hl', x: r.x, y: r.y, width: r.w, height: r.h, fill: a.color, 'fill-opacity': op }, grp);
        break;
      }
      case 'underline':
      case 'strike': {
        const grp = g('g', { 'data-id': a.id });
        for (const r of a.rects) {
          const t = Math.max(0.8, r.h * 0.07);
          const yy = a.type === 'underline' ? r.y + r.h - t : r.y + r.h * 0.55 - t / 2;
          g('rect', { x: r.x, y: yy, width: r.w, height: t, fill: a.color, 'fill-opacity': op, class: 'shape-vis' }, grp);
          g('rect', { class: 'hl', x: r.x, y: r.y, width: r.w, height: r.h, fill: 'transparent' }, grp);
        }
        break;
      }
      case 'ink': {
        const d = smoothPath(a.points);
        const grp = g('g', { 'data-id': a.id });
        g('path', { class: 'shape-vis', d, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': op }, grp);
        g('path', { class: 'hit', d, 'stroke-width': Math.max(a.width, 10) }, grp);
        break;
      }
      case 'rect':
      case 'ellipse': {
        const grp = g('g', { 'data-id': a.id });
        const attrs = a.fill
          ? { fill: a.color, 'fill-opacity': op, stroke: 'none' }
          : { fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-opacity': op, 'stroke-linejoin': 'round' };
        const shape = a.type === 'rect'
          ? { x: a.x, y: a.y, width: Math.max(a.w, 0.1), height: Math.max(a.h, 0.1) }
          : { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: Math.max(a.w / 2, 0.1), ry: Math.max(a.h / 2, 0.1) };
        g(a.type === 'rect' ? 'rect' : 'ellipse', { class: 'shape-vis', ...shape, ...attrs }, grp);
        const hit = g(a.type === 'rect' ? 'rect' : 'ellipse', { class: 'hit', ...shape, 'stroke-width': Math.max(a.width || 0, 10) }, grp);
        if (a.fill) hit.setAttribute('fill', 'transparent'), hit.style.pointerEvents = 'all';
        break;
      }
      case 'line':
      case 'arrow': {
        let d = polyPath([[a.x1, a.y1], [a.x2, a.y2]], false);
        if (a.type === 'arrow') d += ' ' + polyPath(arrowHead(a.x1, a.y1, a.x2, a.y2, a.width), false);
        const grp = g('g', { 'data-id': a.id });
        g('path', { class: 'shape-vis', d, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': op }, grp);
        g('path', { class: 'hit', d, 'stroke-width': Math.max(a.width, 10) }, grp);
        break;
      }
      case 'mark': {
        const geo = markGeometry(a.variant, a.x, a.y, a.w, a.h);
        const grp = g('g', { 'data-id': a.id });
        if (geo.fill) g('path', { class: 'shape-vis', d: polyPath(geo.fill, true), fill: a.color, 'fill-opacity': op }, grp);
        else for (const line of geo.lines) g('path', { class: 'shape-vis', d: polyPath(line, false), fill: 'none', stroke: a.color, 'stroke-width': geo.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': op }, grp);
        g('rect', { class: 'hl', x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent' }, grp);
        break;
      }
      case 'image': {
        g('image', { 'data-id': a.id, href: a.src, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none', opacity: op });
        break;
      }
      case 'text': {
        const div = document.createElement('div');
        div.className = 'anno-text' + (a.id === this.selectedId ? ' selected' : '');
        div.dataset.id = a.id;
        div.textContent = a.text;
        applyTextStyle(div, a);
        html.append(div);
        // Keep the stored height in sync with the laid-out text (used for selection and hit testing).
        const h = div.offsetHeight;
        if (h && Math.abs(h - a.h) > 0.5) a.h = h;
        break;
      }
      case 'note': {
        const div = document.createElement('div');
        div.className = 'anno-note';
        div.dataset.id = a.id;
        div.title = a.text ? a.text.slice(0, 200) : 'Comment';
        div.style.left = a.x + 'px';
        div.style.top = a.y + 'px';
        div.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 3h18v14h-7l-5 4v-4H3z" fill="${escapeAttr(a.color)}" stroke="rgba(0,0,0,.55)" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 8h10M7 11.5h7" stroke="rgba(0,0,0,.55)" stroke-width="1.4" stroke-linecap="round"/></svg>`;
        html.append(div);
        break;
      }
    }
  }

  _renderSelection(a, html) {
    const b = bbox(a);
    const pad = MARKUP.has(a.type) ? 1 : 2;
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.left = b.x - pad + 'px';
    box.style.top = b.y - pad + 'px';
    box.style.width = b.w + pad * 2 + 'px';
    box.style.height = b.h + pad * 2 + 'px';
    const handles = handlesFor(a);
    for (const h of handles) {
      const el = document.createElement('div');
      el.className = 'handle';
      el.dataset.h = h;
      el.dataset.handleFor = a.id;
      let hx;
      let hy;
      if (h === 'p1' || h === 'p2') {
        hx = (h === 'p1' ? a.x1 : a.x2) - (b.x - pad);
        hy = (h === 'p1' ? a.y1 : a.y2) - (b.y - pad);
        el.style.left = hx + 'px';
        el.style.top = hy + 'px';
      } else {
        el.style.left = h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%';
        el.style.top = h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%';
      }
      box.append(el);
    }
    html.append(box);
  }

  _renderNotePopup(a, html) {
    const pop = document.createElement('div');
    pop.className = 'anno-note-pop';
    pop.dataset.popFor = a.id;
    const { w } = this.o.getPageSize(a.page);
    const left = a.x + NOTE_SIZE + 6 + 220 > w ? Math.max(0, a.x - 226) : a.x + NOTE_SIZE + 6;
    pop.style.left = left + 'px';
    pop.style.top = a.y + 'px';
    const date = new Date(a.created || Date.now()).toLocaleString();
    pop.innerHTML = `<header><span>Comment</span><span><button type="button" data-act="delete" title="Delete comment" aria-label="Delete comment">🗑</button><button type="button" data-act="close" title="Close" aria-label="Close">×</button></span></header><textarea aria-label="Comment text" placeholder="Write a comment…"></textarea><div style="padding:0 6px 4px;color:#8a7a2a;font-size:11px"></div>`;
    pop.querySelector('div').textContent = date;
    const ta = pop.querySelector('textarea');
    ta.value = a.text || '';
    ta.addEventListener('input', () => {
      a.text = ta.value;
      this._noteDirty = true;
    });
    ta.addEventListener('blur', () => {
      if (this._noteDirty) {
        this._noteDirty = false;
        this._commit();
      }
    });
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.querySelector('[data-act="close"]').addEventListener('click', () => {
      if (this._noteDirty) {
        this._noteDirty = false;
        this._commit();
      }
      this.openNoteId = null;
      this.renderPage(a.page);
    });
    pop.querySelector('[data-act="delete"]').addEventListener('click', () => {
      this.selectedId = a.id;
      this.deleteSelected();
    });
    html.append(pop);
    if (this._focusNote === a.id) {
      this._focusNote = null;
      requestAnimationFrame(() => ta.focus());
    }
  }

  // ---------- text editing ----------

  _startEditing(a) {
    this.editingId = a.id;
    this.selectedId = a.id;
    const layer = this.layers.get(a.page);
    if (!layer) return;
    this.renderPage(a.page);
    const old = layer.html.querySelector(`[data-id="${a.id}"]`);
    const ta = document.createElement('textarea');
    ta.className = 'anno-editing';
    ta.dataset.editFor = a.id;
    ta.value = a.text;
    ta.spellcheck = true;
    this._styleEditor(a, ta);
    if (old) old.replaceWith(ta);
    else layer.html.append(ta);
    layer.html.querySelector('.sel-box')?.remove();
    const autosize = () => {
      ta.style.height = '0px';
      ta.style.height = ta.scrollHeight + 2 + 'px';
      a.h = ta.offsetHeight;
    };
    ta.addEventListener('input', () => {
      a.text = ta.value;
      autosize();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this._finishEditing();
      }
    });
    ta.addEventListener('blur', () => {
      if (this.editingId === a.id) this._finishEditing();
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    autosize();
    this._editStartText = a.text;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    this._emitSelection();
  }

  _styleEditor(a, ta = this.layers.get(a.page)?.html.querySelector('textarea.anno-editing')) {
    if (!ta) return;
    applyTextStyle(ta, a);
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  }

  _finishEditing() {
    const a = this._find(this.editingId);
    this.editingId = null;
    if (!a) return;
    if (!a.text.trim()) {
      this.annotations = this.annotations.filter((x) => x.id !== a.id);
      if (this.selectedId === a.id) this.selectedId = null;
      this.renderPage(a.page);
      if (this._editStartText) this._commit();
      else {
        // It never existed in history; drop silently.
        this.history[this.histIndex] = clone(this.annotations);
      }
      this._emitSelection();
      return;
    }
    this.renderPage(a.page);
    if (a.text !== this._editStartText || this._editIsNew) this._commit();
    this._editIsNew = false;
    this._emitSelection();
  }

  // ---------- events ----------

  _bind() {
    const root = this.o.pagesEl;
    root.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    root.addEventListener('pointermove', (e) => this._onPointerMove(e));
    root.addEventListener('pointerleave', () => {
      if (this.tool === 'place') this._clearGhost();
    });
    window.addEventListener('pointermove', (e) => this._onDragMove(e));
    window.addEventListener('pointerup', (e) => this._onDragEnd(e));
    window.addEventListener('pointercancel', (e) => this._onDragEnd(e, true));
    root.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-id]');
      if (!el || (this.tool !== 'select' && this.tool !== 'view')) return;
      const a = this._find(el.dataset.id);
      if (a && a.type === 'text') {
        if (this.tool === 'view') return;
        this._startEditing(a);
      }
    });
    document.addEventListener('mouseup', () => {
      if (MARKUP.has(this.tool)) setTimeout(() => this._markupFromSelection(), 0);
    });
    // Track text selection in the text layer so pdf.js "endOfContent" trick keeps selection smooth.
    root.addEventListener('mousedown', (e) => {
      const tl = e.target.closest('.textLayer');
      if (tl) tl.classList.add('selecting');
    });
    document.addEventListener('mouseup', () => {
      for (const tl of root.querySelectorAll('.textLayer.selecting')) tl.classList.remove('selecting');
    });
  }

  _pageFromEvent(e) {
    const pageEl = e.target.closest?.('.page');
    if (!pageEl) return null;
    const index = +pageEl.dataset.index;
    return { index, ...this._toUnits(index, e.clientX, e.clientY) };
  }

  _toUnits(index, clientX, clientY) {
    const pageEl = this.o.getPageEl(index);
    const r = pageEl.getBoundingClientRect();
    const { w } = this.o.getPageSize(index);
    const s = r.width / w;
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s, scale: s };
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    const handle = e.target.closest('.handle');
    if (handle && this.tool === 'select') {
      const a = this._find(handle.dataset.handleFor);
      if (a) return this._beginDrag(e, 'resize', a, handle.dataset.h);
    }
    const item = e.target.closest('[data-id]');
    if (item && (this.tool === 'select' || this.tool === 'view')) {
      const a = this._find(item.dataset.id);
      if (!a) return;
      if (this.tool === 'view') {
        if (a.type === 'note') {
          this.openNoteId = this.openNoteId === a.id ? null : a.id;
          this.renderPage(a.page);
          e.preventDefault();
        }
        return;
      }
      e.preventDefault();
      if (this.editingId && this.editingId !== a.id) this._finishEditing();
      this.select(a.id);
      if (a.type === 'note') {
        this._noteClick = { id: a.id, x: e.clientX, y: e.clientY };
      }
      if (!MARKUP.has(a.type)) this._beginDrag(e, 'move', a);
      return;
    }
    if (!DRAWING_TOOLS.has(this.tool)) {
      if (this.tool === 'select' && !e.target.closest('.anno-note-pop, textarea')) this.select(null);
      return;
    }
    const pos = this._pageFromEvent(e);
    if (!pos) return;
    e.preventDefault();
    if (this.editingId) this._finishEditing();
    this._createAt(e, pos);
  }

  _createAt(e, pos) {
    const { index: page, x, y } = pos;
    const tool = this.tool;
    const st = this.styles[styleKey(tool)];
    const { w: pw } = this.o.getPageSize(page);
    switch (tool) {
      case 'ink':
        this._beginDrag(e, 'ink', { page, points: [[x, y]] });
        break;
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'arrow':
        this._beginDrag(e, 'shape', { page, x0: x, y0: y });
        break;
      case 'text':
      case 'date': {
        const s = this.styles.text;
        let text = '';
        let w = Math.min(200, pw - x - 4);
        if (tool === 'date') {
          text = this.o.getDateText();
          w = measureText(text, s.font, s.size) + 8;
        }
        w = Math.max(w, 40);
        const a = {
          type: 'text', page, x: Math.min(x, pw - w), y: y - s.size * 0.7, w, h: s.size * LINE_HEIGHT + 6,
          text, color: s.color, size: s.size, font: s.font, opacity: 1
        };
        a.id = newId();
        a.created = Date.now();
        this.annotations.push(a);
        if (tool === 'date') {
          this.renderPage(page);
          this._commit();
          this.setTool('select');
          this.select(a.id);
        } else {
          this._editIsNew = true;
          this.setTool('select');
          this._startEditing(a);
        }
        break;
      }
      case 'note': {
        const a = this._add({ type: 'note', page, x: x - NOTE_SIZE / 2, y: y - NOTE_SIZE / 2, text: '', color: this.styles.note.color });
        this.setTool('select');
        this.selectedId = a.id;
        this.openNoteId = a.id;
        this._focusNote = a.id;
        this.renderPage(page);
        this._emitSelection();
        break;
      }
      case 'mark-check':
      case 'mark-cross':
      case 'mark-dot': {
        const size = 14;
        this._add({ type: 'mark', variant: tool.slice(5), page, x: x - size / 2, y: y - size / 2, w: size, h: size, color: st.color, opacity: 1 });
        break;
      }
      case 'place': {
        if (!this.placeSrc) return;
        const { src, w, h } = this.placeSrc;
        this._clearGhost();
        const a = this._add({ type: 'image', page, src, x: x - w / 2, y: y - h / 2, w, h, opacity: 1 });
        this.placeSrc = null;
        this.setTool('select');
        this.select(a.id);
        break;
      }
    }
  }

  _onPointerMove(e) {
    if (this.tool !== 'place' || !this.placeSrc || this.drag) return;
    const pos = this._pageFromEvent(e);
    if (!pos) return this._clearGhost();
    const layer = this.layers.get(pos.index);
    if (!layer) return;
    if (!this._ghost || this._ghost.parentNode !== layer.html) {
      this._clearGhost();
      this._ghost = document.createElement('img');
      this._ghost.className = 'ghost-img';
      this._ghost.src = this.placeSrc.src;
      this._ghost.alt = '';
      layer.html.append(this._ghost);
    }
    const { w, h } = this.placeSrc;
    Object.assign(this._ghost.style, { left: pos.x - w / 2 + 'px', top: pos.y - h / 2 + 'px', width: w + 'px', height: h + 'px' });
  }

  _clearGhost() {
    this._ghost?.remove();
    this._ghost = null;
  }

  _beginDrag(e, kind, target, handle) {
    const start = this._toUnits(target.page, e.clientX, e.clientY);
    this.drag = {
      kind, target, handle, pointerId: e.pointerId,
      startX: start.x, startY: start.y,
      orig: kind === 'move' || kind === 'resize' ? clone(target) : null,
      moved: false
    };
    if (kind === 'ink' || kind === 'shape') {
      const layer = this.layers.get(target.page);
      const d = document.createElementNS(SVG_NS, 'path');
      d.setAttribute('fill', 'none');
      d.setAttribute('stroke-linecap', 'round');
      d.setAttribute('stroke-linejoin', 'round');
      const st = this.styles[styleKey(this.tool)];
      d.setAttribute('stroke', st.color);
      d.setAttribute('stroke-width', st.width || 2);
      d.setAttribute('stroke-opacity', st.opacity ?? 1);
      if (kind === 'shape' && st.fill && (this.tool === 'rect' || this.tool === 'ellipse')) {
        d.setAttribute('fill', st.color);
        d.setAttribute('stroke', 'none');
      }
      layer.svg.append(d);
      this.drag.draftEl = d;
    }
  }

  _onDragMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const { x, y, scale } = this._toUnits(d.target.page, e.clientX, e.clientY);
    const { w: pw, h: ph } = this.o.getPageSize(d.target.page);
    const cx = clamp(x, 0, pw);
    const cy = clamp(y, 0, ph);
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) * scale < 3) return;
    d.moved = true;
    if (d.kind === 'ink') {
      const pts = d.target.points;
      const last = pts[pts.length - 1];
      if (Math.hypot(cx - last[0], cy - last[1]) * scale >= 1.5) pts.push([cx, cy]);
      d.draftEl.setAttribute('d', smoothPath(pts));
    } else if (d.kind === 'shape') {
      d.end = constrain(this.tool, d.startX, d.startY, cx, cy, e.shiftKey);
      d.draftEl.setAttribute('d', draftPath(this.tool, d.startX, d.startY, d.end[0], d.end[1], this.styles[styleKey(this.tool)].width));
    } else if (d.kind === 'move') {
      const a = d.target;
      const ob = bbox(d.orig);
      let dx = x - d.startX;
      let dy = y - d.startY;
      dx = clamp(dx, -ob.x, pw - ob.x - ob.w);
      dy = clamp(dy, -ob.y, ph - ob.y - ob.h);
      Object.assign(a, clone(d.orig));
      translate(a, dx, dy);
      this.renderPage(a.page);
      this._noteClick = null;
    } else if (d.kind === 'resize') {
      const a = d.target;
      Object.assign(a, clone(d.orig));
      resize(a, d.orig, d.handle, cx - d.startX, cy - d.startY, e.shiftKey);
      this.renderPage(a.page);
    }
  }

  _onDragEnd(e, cancelled = false) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    d.draftEl?.remove();
    if (cancelled) {
      if (d.orig) {
        Object.assign(d.target, d.orig);
        this.renderPage(d.target.page);
      }
      return;
    }
    if (d.kind === 'ink') {
      const st = this.styles.ink;
      if (d.target.points.length === 1) {
        const [x, y] = d.target.points[0];
        d.target.points.push([x + 0.01, y + 0.01]);
      }
      this._add({ type: 'ink', page: d.target.page, points: d.target.points.map((p) => [round2(p[0]), round2(p[1])]), color: st.color, width: st.width, opacity: st.opacity ?? 1 });
    } else if (d.kind === 'shape') {
      const tool = this.tool;
      const st = this.styles[styleKey(tool)];
      let [x2, y2] = d.end || [d.startX, d.startY];
      if (!d.moved) {
        // Click without dragging: drop a default-sized shape.
        x2 = d.startX + (tool === 'line' || tool === 'arrow' ? 100 : 120);
        y2 = d.startY + (tool === 'line' || tool === 'arrow' ? 0 : 72);
      }
      const page = d.target.page;
      if (tool === 'line' || tool === 'arrow') {
        this._add({ type: tool, page, x1: d.startX, y1: d.startY, x2, y2, color: st.color, width: st.width, opacity: st.opacity ?? 1 });
      } else {
        this._add({
          type: tool, page,
          x: Math.min(d.startX, x2), y: Math.min(d.startY, y2), w: Math.abs(x2 - d.startX), h: Math.abs(y2 - d.startY),
          color: st.color, width: st.width, fill: !!st.fill, opacity: st.opacity ?? 1
        });
      }
    } else if (d.kind === 'move' || d.kind === 'resize') {
      if (d.moved) this._commit();
      else if (this._noteClick && d.target.type === 'note') {
        this.openNoteId = this.openNoteId === d.target.id ? null : d.target.id;
        this.renderPage(d.target.page);
      }
      this._noteClick = null;
    }
  }

  // ---------- text markup ----------

  _markupFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer;
    const ancEl = anc.nodeType === 1 ? anc : anc.parentElement;
    if (!ancEl || !this.o.pagesEl.contains(ancEl)) return;
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) return;
    const byPage = new Map();
    const pageEls = [...this.o.pagesEl.querySelectorAll('.page')].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight * 4;
    });
    for (const r of rects) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const pageEl = pageEls.find((p) => {
        const pr = p.getBoundingClientRect();
        return cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom;
      });
      if (!pageEl) continue;
      const index = +pageEl.dataset.index;
      const pr = pageEl.getBoundingClientRect();
      const { w, h } = this.o.getPageSize(index);
      const s = pr.width / w;
      const u = { x: (r.left - pr.left) / s, y: (r.top - pr.top) / s, w: r.width / s, h: r.height / s };
      if (u.h > h * 0.2 || u.w > w * 0.98) continue; // container boxes, not text
      if (!byPage.has(index)) byPage.set(index, []);
      byPage.get(index).push(u);
    }
    const st = this.styles[this.tool];
    let created = null;
    for (const [page, list] of byPage) {
      const merged = mergeRects(list);
      if (!merged.length) continue;
      created = this._add({
        type: this.tool, page, rects: merged.map((r) => ({ x: round2(r.x), y: round2(r.y), w: round2(r.w), h: round2(r.h) })),
        color: st.color, opacity: st.opacity ?? 1,
        text: sel.toString().slice(0, 2000)
      });
    }
    if (created) sel.removeAllRanges();
  }
}

// ---------- geometry helpers ----------

function handlesFor(a) {
  switch (a.type) {
    case 'line':
    case 'arrow': return ['p1', 'p2'];
    case 'text': return ['w', 'e'];
    case 'note':
    case 'highlight':
    case 'underline':
    case 'strike': return [];
    case 'image':
    case 'ink':
    case 'mark': return ['nw', 'ne', 'sw', 'se'];
    default: return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  }
}

function translate(a, dx, dy) {
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strike':
      a.rects.forEach((r) => { r.x += dx; r.y += dy; });
      break;
    case 'ink':
      a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
      break;
    case 'line':
    case 'arrow':
      a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy;
      break;
    default:
      a.x += dx;
      a.y += dy;
  }
}

function resize(a, orig, handle, dx, dy, shift) {
  if (handle === 'p1' || handle === 'p2') {
    const k = handle === 'p1' ? 1 : 2;
    let nx = orig['x' + k] + dx;
    let ny = orig['y' + k] + dy;
    if (shift) {
      const ox = orig['x' + (3 - k)];
      const oy = orig['y' + (3 - k)];
      [nx, ny] = snapAngle(ox, oy, nx, ny);
    }
    a['x' + k] = nx;
    a['y' + k] = ny;
    return;
  }
  const b = bbox(orig);
  let x1 = b.x;
  let y1 = b.y;
  let x2 = b.x + b.w;
  let y2 = b.y + b.h;
  if (handle.includes('w')) x1 = Math.min(x1 + dx, x2 - 4);
  if (handle.includes('e')) x2 = Math.max(x2 + dx, x1 + 4);
  if (handle.includes('n')) y1 = Math.min(y1 + dy, y2 - 4);
  if (handle.includes('s')) y2 = Math.max(y2 + dy, y1 + 4);
  const keepAspect = (a.type === 'image' || a.type === 'mark') !== shift && handle.length === 2;
  if (keepAspect && b.w > 0 && b.h > 0) {
    const ratio = b.w / b.h;
    let nw = x2 - x1;
    let nh = y2 - y1;
    if (nw / nh > ratio) nw = nh * ratio;
    else nh = nw / ratio;
    if (handle.includes('w')) x1 = x2 - nw; else x2 = x1 + nw;
    if (handle.includes('n')) y1 = y2 - nh; else y2 = y1 + nh;
  }
  if (a.type === 'ink') {
    const sx = b.w ? (x2 - x1) / b.w : 1;
    const sy = b.h ? (y2 - y1) / b.h : 1;
    a.points = orig.points.map(([x, y]) => [x1 + (x - b.x) * sx, y1 + (y - b.y) * sy]);
  } else if (a.type === 'text') {
    a.x = x1;
    a.w = x2 - x1;
  } else {
    a.x = x1;
    a.y = y1;
    a.w = x2 - x1;
    a.h = y2 - y1;
  }
}

function constrain(tool, x0, y0, x, y, shift) {
  if (!shift) return [x, y];
  if (tool === 'line' || tool === 'arrow') return snapAngle(x0, y0, x, y);
  const s = Math.max(Math.abs(x - x0), Math.abs(y - y0));
  return [x0 + Math.sign(x - x0 || 1) * s, y0 + Math.sign(y - y0 || 1) * s];
}

function snapAngle(x0, y0, x, y) {
  const len = Math.hypot(x - x0, y - y0);
  const ang = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * (Math.PI / 4);
  return [x0 + len * Math.cos(ang), y0 + len * Math.sin(ang)];
}

function draftPath(tool, x1, y1, x2, y2, width) {
  if (tool === 'rect') return polyPath([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true);
  if (tool === 'ellipse') return polyPath(ellipsePoints(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)), true);
  let d = polyPath([[x1, y1], [x2, y2]], false);
  if (tool === 'arrow') d += ' ' + polyPath(arrowHead(x1, y1, x2, y2, width), false);
  return d;
}

/** Merge character/word rects into line rects. */
function mergeRects(list) {
  const rects = list.map((r) => ({ ...r })).sort((a, b) => (Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y));
  const out = [];
  for (const r of rects) {
    const last = out.find((o) => {
      const overlap = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
      return overlap > Math.min(o.h, r.h) * 0.5 && r.x <= o.x + o.w + Math.max(o.h, r.h) * 0.6 && r.x + r.w >= o.x - Math.max(o.h, r.h) * 0.6;
    });
    if (last) {
      const x1 = Math.min(last.x, r.x);
      const y1 = Math.min(last.y, r.y);
      last.w = Math.max(last.x + last.w, r.x + r.w) - x1;
      last.h = Math.max(last.y + last.h, r.y + r.h) - y1;
      last.x = x1;
      last.y = y1;
    } else out.push(r);
  }
  return out;
}

function applyTextStyle(el, a) {
  Object.assign(el.style, {
    left: a.x + 'px',
    top: a.y + 'px',
    width: a.w + 'px',
    fontSize: a.size + 'px',
    fontFamily: FONT_STACKS[a.font] || FONT_STACKS.helvetica,
    color: a.color,
    opacity: a.opacity ?? 1
  });
}

let measureCtx;
export function measureText(text, font, size) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px ${FONT_STACKS[font] || FONT_STACKS.helvetica}`;
  return Math.ceil(Math.max(...String(text).split('\n').map((l) => measureCtx.measureText(l).width)));
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round2 = (v) => Math.round(v * 100) / 100;
const escapeAttr = (s) => String(s).replace(/[^#0-9a-zA-Z]/g, '');
