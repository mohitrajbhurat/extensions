// Draggable, resizable widget card. Position and size persist in storage ('layout').
// Mouse/touch: drag the header, resize from the corner. Keyboard: focus the move handle and use
// the arrow keys to move (Shift = bigger steps) or Alt+arrows to resize.
import { h, icon } from '../../lib/ui.js';

export const MIN_W = 220;
export const MIN_H = 140;
const GRID = 8;
const snap = (v) => Math.round(v / GRID) * GRID;

export function clampRect(r, vw = innerWidth, vh = innerHeight) {
  const w = Math.max(MIN_W, Math.min(r.w, vw - 16));
  const hh = Math.max(MIN_H, Math.min(r.h, vh - 16));
  return {
    x: Math.max(8, Math.min(r.x, vw - w - 8)),
    y: Math.max(8, Math.min(r.y, vh - hh - 8)),
    w, h: hh,
  };
}

/**
 * @param {{id:string,title:string,rect:{x,y,w,h},onChange:(rect)=>void,onClose:()=>void,actions?:Node[]}} o
 */
export function createFrame(o) {
  const title = h('h2.widget-title', { id: `w-${o.id}-title` }, o.title);
  const handle = h('button.icon-btn.move-handle', {
    type: 'button',
    'aria-label': `Move or resize ${o.title} widget. Arrow keys move, Alt+arrow keys resize.`,
    title: 'Drag to move. Arrow keys move, Alt+arrows resize.',
  }, icon('drag', 16));
  const close = h('button.icon-btn', { type: 'button', 'aria-label': `Hide ${o.title} widget`, title: 'Hide widget', onclick: o.onClose }, icon('x', 16));
  const head = h('header.widget-head', handle, title, h('div.widget-actions', o.actions || [], close));
  const body = h('div.widget-body');
  const grip = h('div.resize-grip', { 'aria-hidden': 'true' });
  const el = h('section.widget', { 'aria-labelledby': title.id, dataset: { widget: o.id } }, head, body, grip);

  let rect = clampRect(o.rect);
  const apply = () => {
    el.style.setProperty('--x', rect.x + 'px');
    el.style.setProperty('--y', rect.y + 'px');
    el.style.setProperty('--w', rect.w + 'px');
    el.style.setProperty('--h', rect.h + 'px');
  };
  apply();

  const bringFront = () => {
    const all = [...document.querySelectorAll('.widget')];
    const max = Math.max(0, ...all.map((w) => +w.style.zIndex || 0));
    if ((+el.style.zIndex || 0) < max || !el.style.zIndex) el.style.zIndex = String(max + 1);
  };
  el.addEventListener('pointerdown', bringFront);

  const isFloating = () => getComputedStyle(el).position === 'absolute';

  function drag(e, mode) {
    if (e.button !== 0 || !isFloating()) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, r: { ...rect } };
    el.classList.add(mode === 'move' ? 'moving' : 'resizing');
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      rect = mode === 'move'
        ? clampRect({ ...start.r, x: snap(start.r.x + dx), y: snap(start.r.y + dy) })
        : clampRect({ ...start.r, w: snap(start.r.w + dx), h: snap(start.r.h + dy) });
      apply();
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      el.classList.remove('moving', 'resizing');
      if (start.r.x !== rect.x || start.r.y !== rect.y || start.r.w !== rect.w || start.r.h !== rect.h) o.onChange(rect);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select, a') && !e.target.closest('.move-handle')) return;
    drag(e, 'move');
  });
  grip.addEventListener('pointerdown', (e) => drag(e, 'resize'));

  handle.addEventListener('keydown', (e) => {
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (!d || !isFloating()) return;
    e.preventDefault();
    const step = e.shiftKey ? GRID * 6 : GRID;
    rect = e.altKey
      ? clampRect({ ...rect, w: rect.w + d[0] * step, h: rect.h + d[1] * step })
      : clampRect({ ...rect, x: rect.x + d[0] * step, y: rect.y + d[1] * step });
    apply();
    o.onChange(rect);
  });

  return {
    el, body, head,
    setRect(r) { rect = clampRect(r); apply(); },
    getRect() { return rect; },
    reclamp() { const before = JSON.stringify(rect); rect = clampRect(rect); apply(); return before !== JSON.stringify(rect); },
  };
}
