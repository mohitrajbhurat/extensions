// Annotation editor: arrows, shapes, freehand, text, highlight, blur, pixelate, crop,
// undo/redo, export to PNG/JPEG and clipboard. Annotations stay editable (saved as data).
import { getShot, getShotBlob, putShot, updateShot, newId } from '../lib/db.js';
import { downloadBlob, safeFilename, timestampName, toast } from '../lib/util.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const g = canvas.getContext('2d');
const wrap = $('wrap');
const workspace = $('workspace');
const textInput = $('text-input');

const COLORS = ['#e5484d', '#f5a524', '#ffd60a', '#30a46c', '#3b6ef5', '#8e4ec6', '#111111', '#ffffff'];
const TOOL_KEYS = { v: 'select', a: 'arrow', r: 'rect', e: 'ellipse', p: 'pen', t: 'text', h: 'highlight', b: 'blur', x: 'pixelate', c: 'crop' };
const DRAW_TOOLS = new Set(['arrow', 'rect', 'ellipse', 'highlight', 'blur', 'pixelate']);

const state = {
  id: null,
  title: '',
  image: null,        // ImageBitmap
  doc: { shapes: [], crop: null },
  history: [],
  hIndex: -1,
  tool: 'arrow',
  colors: { default: '#e5484d', highlight: '#ffd60a' },
  sizeLevel: 2,
  zoom: 1,
  fit: true,
  selected: null,     // shape id
  temp: null,         // shape being drawn
  drag: null,
  cropDraft: null,    // pending crop rect while crop tool is active
  textEdit: null,     // { shape (new or existing), isNew }
  dirty: false,
};
const textBounds = new Map();

/* ------------------------------------------------------------------ */
/* Units and geometry                                                   */
/* ------------------------------------------------------------------ */
function unit() {
  const img = state.image;
  return img ? Math.max(1, Math.min(img.width, img.height) / 900) : 1;
}
function strokeFor(level) { return [0, 2, 4, 7, 11][level] * unit(); }
function fontFor(level) { return Math.round([0, 16, 24, 36, 54][level] * unit()); }
function currentColor() { return state.tool === 'highlight' ? state.colors.highlight : state.colors.default; }

function norm(s) {
  return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
}
function viewRect() {
  const img = state.image;
  if (state.tool === 'crop' || !state.doc.crop) return { x: 0, y: 0, w: img.width, h: img.height };
  return state.doc.crop;
}
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */
let raf = 0;
function requestRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function drawArrow(ctx, s) {
  const { x1, y1, x2, y2 } = s;
  const w = s.size;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10 * unit(), w * 4);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const shaftEnd = Math.max(0, len - head * 0.8);
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + Math.cos(angle) * shaftEnd, y1 + Math.sin(angle) * shaftEnd);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function drawText(ctx, s) {
  const lines = String(s.text).split('\n');
  const lh = s.fontSize * 1.2;
  ctx.font = `600 ${s.fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, s.fontSize / 7);
  ctx.strokeStyle = luminance(s.color) > 0.6 ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.95)';
  ctx.fillStyle = s.color;
  let maxW = 0;
  lines.forEach((line, i) => {
    ctx.strokeText(line, s.x, s.y + i * lh);
    ctx.fillText(line, s.x, s.y + i * lh);
    maxW = Math.max(maxW, ctx.measureText(line).width);
  });
  textBounds.set(s.id, { x: s.x, y: s.y, w: maxW, h: lines.length * lh });
}

function effectRegion(ctx, s, offset) {
  // Reads the pixels rendered so far (canvas pixel space) and redraws them obscured.
  const src = ctx.canvas;
  const r = norm(s);
  const sx = Math.max(0, Math.round(r.x - offset.x));
  const sy = Math.max(0, Math.round(r.y - offset.y));
  const sw = Math.min(src.width - sx, Math.round(r.w));
  const sh = Math.min(src.height - sy, Math.round(r.h));
  if (sw < 2 || sh < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx + offset.x, sy + offset.y, sw, sh);
  ctx.clip();
  if (s.type === 'pixelate') {
    const block = Math.max(4, Math.round((6 + s.level * 4) * unit()));
    const tw = Math.max(1, Math.ceil(sw / block));
    const th = Math.max(1, Math.ceil(sh / block));
    const tmp = new OffscreenCanvas(tw, th);
    const t = tmp.getContext('2d');
    t.imageSmoothingQuality = 'medium';
    t.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th, sx + offset.x, sy + offset.y, tw * block, th * block);
  } else {
    const radius = Math.round((4 + s.level * 4) * unit());
    const pad = radius * 2;
    const px = Math.max(0, sx - pad);
    const py = Math.max(0, sy - pad);
    const pw = Math.min(src.width - px, sw + pad * 2);
    const ph = Math.min(src.height - py, sh + pad * 2);
    const tmp = new OffscreenCanvas(pw, ph);
    tmp.getContext('2d').drawImage(src, px, py, pw, ph, 0, 0, pw, ph);
    ctx.filter = `blur(${radius}px)`;
    // Draw twice to avoid soft see-through edges.
    ctx.drawImage(tmp, px + offset.x, py + offset.y);
    ctx.drawImage(tmp, px + offset.x, py + offset.y);
    ctx.filter = 'none';
  }
  ctx.restore();
}

function drawShape(ctx, s, offset) {
  ctx.save();
  switch (s.type) {
    case 'arrow': drawArrow(ctx, s); break;
    case 'rect': {
      const r = norm(s);
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineJoin = 'round';
      const rad = Math.min(s.size * 1.5, r.w / 2, r.h / 2);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(r.x, r.y, r.w, r.h, rad) : ctx.rect(r.x, r.y, r.w, r.h);
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      const r = norm(s);
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'pen': {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      const pts = s.points;
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.stroke();
      break;
    }
    case 'highlight': {
      const r = norm(s);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = s.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'blur':
    case 'pixelate':
      effectRegion(ctx, s, offset);
      break;
    case 'text':
      if (!state.textEdit || state.textEdit.shape.id !== s.id) drawText(ctx, s);
      break;
  }
  ctx.restore();
}

function shapeBounds(s) {
  if (s.type === 'text') return textBounds.get(s.id) || { x: s.x, y: s.y, w: 10, h: s.fontSize };
  if (s.type === 'pen') {
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    for (const [x, y] of s.points) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return norm(s);
}

/** Renders the document into ctx; offset is the top-left of the visible area in image px. */
function paint(ctx, view, { overlays }) {
  const offset = { x: -view.x, y: -view.y };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(1, 0, 0, 1, offset.x, offset.y);
  ctx.drawImage(state.image, 0, 0);
  const shapes = state.temp ? [...state.doc.shapes, state.temp] : state.doc.shapes;
  for (const s of shapes) drawShape(ctx, s, offset);
  if (!overlays) return;
  const z = state.zoom;
  if (state.selected) {
    const s = state.doc.shapes.find(x => x.id === state.selected);
    if (s) {
      const b = shapeBounds(s);
      const pad = 6 / z;
      ctx.save();
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.strokeStyle = '#3b6ef5';
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }
  }
  if (state.tool === 'crop') {
    const c = state.cropDraft;
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,18,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, state.image.width, state.image.height);
    if (c) ctx.rect(c.x + c.w, c.y, -c.w, c.h); // even-odd hole
    ctx.fill('evenodd');
    if (c) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(17,19,24,.85)';
      const label = `${Math.round(c.w)} × ${Math.round(c.h)}`;
      ctx.font = `600 ${12 / z}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 12 / z;
      ctx.fillRect(c.x, c.y - 22 / z < 0 ? c.y + 4 / z : c.y - 22 / z, tw, 18 / z);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x + 6 / z, (c.y - 22 / z < 0 ? c.y + 4 / z : c.y - 22 / z) + 9 / z);
    }
    ctx.restore();
  }
}

function render() {
  if (!state.image) return;
  const view = viewRect();
  if (canvas.width !== Math.round(view.w) || canvas.height !== Math.round(view.h)) {
    canvas.width = Math.round(view.w);
    canvas.height = Math.round(view.h);
    applyZoom();
  }
  paint(g, view, { overlays: true });
  updateStatus();
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                 */
/* ------------------------------------------------------------------ */
function fitZoom() {
  const view = viewRect();
  const availW = workspace.clientWidth - 64;
  const availH = workspace.clientHeight - 64;
  return Math.max(0.05, Math.min(1 / devicePixelRatio, availW / view.w, availH / view.h));
}
function applyZoom() {
  if (!state.image) return;
  if (state.fit) state.zoom = fitZoom();
  canvas.style.width = `${canvas.width * state.zoom}px`;
  canvas.style.height = `${canvas.height * state.zoom}px`;
  $('zoom-label').textContent = `${Math.round(state.zoom * devicePixelRatio * 100)}%`;
}
function setZoom(z) {
  state.fit = false;
  state.zoom = Math.max(0.05, Math.min(8, z));
  applyZoom();
  requestRender();
}
$('zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
$('zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
$('zoom-label').addEventListener('click', () => {
  if (state.fit) setZoom(1 / devicePixelRatio); else { state.fit = true; applyZoom(); requestRender(); }
});
window.addEventListener('resize', () => { if (state.fit) { applyZoom(); requestRender(); } });
workspace.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

/* ------------------------------------------------------------------ */
/* History + persistence                                                */
/* ------------------------------------------------------------------ */
function snapshot() { return JSON.stringify(state.doc); }
function pushHistory() {
  state.history = state.history.slice(0, state.hIndex + 1);
  state.history.push(snapshot());
  if (state.history.length > 200) state.history.shift();
  state.hIndex = state.history.length - 1;
  updateButtons();
  scheduleSave();
}
function restore(idx) {
  state.hIndex = idx;
  state.doc = JSON.parse(state.history[idx]);
  if (state.selected && !state.doc.shapes.some(s => s.id === state.selected)) state.selected = null;
  updateButtons();
  scheduleSave();
  if (state.fit) applyZoom();
  requestRender();
}
function undo() { commitText(); if (state.hIndex > 0) restore(state.hIndex - 1); }
function redo() { if (state.hIndex < state.history.length - 1) restore(state.hIndex + 1); }

function updateButtons() {
  $('undo').disabled = state.hIndex <= 0;
  $('redo').disabled = state.hIndex >= state.history.length - 1;
  $('delete').disabled = !state.selected;
}

let saveTimer = null;
function scheduleSave() {
  if (!state.id) return;
  state.dirty = true;
  $('st-saved').textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 700);
}
async function persist() {
  if (!state.id || !state.image) return;
  try {
    const out = renderOutput();
    const scale = Math.min(1, 480 / out.width);
    const th = new OffscreenCanvas(Math.round(out.width * scale), Math.round(Math.min(out.height, out.width * 1.5) * scale));
    th.getContext('2d').drawImage(out, 0, 0, out.width, th.height / scale, 0, 0, th.width, th.height);
    const thumb = await th.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    await updateShot(state.id, { doc: state.doc, thumb, edited: Date.now() });
    state.dirty = false;
    $('st-saved').textContent = 'All changes saved';
  } catch (e) {
    $('st-saved').textContent = 'Could not save changes';
    console.warn(e);
  }
}

/* ------------------------------------------------------------------ */
/* Tools, colors, sizes                                                 */
/* ------------------------------------------------------------------ */
function setTool(tool) {
  commitText();
  if (state.tool === 'crop' && tool !== 'crop') state.cropDraft = null;
  state.tool = tool;
  if (tool !== 'select') state.selected = null;
  if (tool === 'crop') {
    const c = state.doc.crop;
    state.cropDraft = c ? { ...c } : null;
  }
  document.querySelectorAll('.tool').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  $('cropbar').hidden = tool !== 'crop';
  canvas.className = tool === 'select' ? 't-select' : tool === 'text' ? 't-text' : 't-draw';
  syncColorUi();
  updateButtons();
  if (state.image) { if (state.fit) applyZoom(); requestRender(); }
}

function syncColorUi() {
  const color = currentColor();
  document.querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-checked', String(s.dataset.color === color)));
  $('custom-color').value = color;
  document.querySelectorAll('.size').forEach(s => s.setAttribute('aria-checked', String(Number(s.dataset.size) === state.sizeLevel)));
}

function setColor(color) {
  const sel = selectedShape();
  if (state.tool === 'highlight' || (sel && sel.type === 'highlight')) state.colors.highlight = color;
  else state.colors.default = color;
  if (sel && 'color' in sel) { sel.color = color; pushHistory(); }
  if (state.textEdit) { state.textEdit.shape.color = color; styleTextInput(); }
  syncColorUi();
  requestRender();
  chrome.storage?.local.set({ editorPrefs: { colors: state.colors, sizeLevel: state.sizeLevel } }).catch(() => {});
}

function setSize(level) {
  state.sizeLevel = level;
  const sel = selectedShape();
  if (sel) {
    if (sel.type === 'text') sel.fontSize = fontFor(level);
    else if (sel.type === 'blur' || sel.type === 'pixelate') sel.level = level;
    else if ('size' in sel) sel.size = strokeFor(level);
    pushHistory();
  }
  if (state.textEdit) { state.textEdit.shape.fontSize = fontFor(level); styleTextInput(); }
  syncColorUi();
  requestRender();
  chrome.storage?.local.set({ editorPrefs: { colors: state.colors, sizeLevel: state.sizeLevel } }).catch(() => {});
}

const colorsEl = $('colors');
for (const c of COLORS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.color = c;
  b.style.background = c;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', 'Color ' + c);
  b.title = c;
  b.addEventListener('click', () => setColor(c));
  colorsEl.appendChild(b);
}
$('custom-color').addEventListener('input', e => setColor(e.target.value));
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('.size').forEach(b => { b.setAttribute('role', 'radio'); b.addEventListener('click', () => setSize(Number(b.dataset.size))); });
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('delete').addEventListener('click', deleteSelected);

function selectedShape() { return state.selected ? state.doc.shapes.find(s => s.id === state.selected) : null; }
function deleteSelected() {
  if (!state.selected) return;
  state.doc.shapes = state.doc.shapes.filter(s => s.id !== state.selected);
  state.selected = null;
  pushHistory();
  requestRender();
}

/* ------------------------------------------------------------------ */
/* Pointer interaction                                                  */
/* ------------------------------------------------------------------ */
function toImage(e) {
  const r = canvas.getBoundingClientRect();
  const view = viewRect();
  return {
    x: (e.clientX - r.left) / r.width * canvas.width + view.x,
    y: (e.clientY - r.top) / r.height * canvas.height + view.y,
  };
}

function hitTest(p) {
  const tol = Math.max(6 / state.zoom, 4);
  for (let i = state.doc.shapes.length - 1; i >= 0; i--) {
    const s = state.doc.shapes[i];
    if (s.type === 'arrow') { if (distToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= tol + s.size) return s; continue; }
    if (s.type === 'pen') {
      for (let k = 1; k < s.points.length; k++) {
        if (distToSegment(p.x, p.y, s.points[k - 1][0], s.points[k - 1][1], s.points[k][0], s.points[k][1]) <= tol + s.size) return s;
      }
      if (s.points.length === 1 && Math.hypot(p.x - s.points[0][0], p.y - s.points[0][1]) <= tol + s.size) return s;
      continue;
    }
    const b = shapeBounds(s);
    if (s.type === 'ellipse') {
      const rx = b.w / 2 + tol; const ry = b.h / 2 + tol;
      const dx = p.x - (b.x + b.w / 2); const dy = p.y - (b.y + b.h / 2);
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) return s;
      continue;
    }
    if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return s;
  }
  return null;
}

function moveShape(s, orig, dx, dy) {
  if (s.type === 'pen') s.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
  else if (s.type === 'text') { s.x = orig.x + dx; s.y = orig.y + dy; }
  else { s.x1 = orig.x1 + dx; s.x2 = orig.x2 + dx; s.y1 = orig.y1 + dy; s.y2 = orig.y2 + dy; }
}

function clampCrop(c) {
  const W = state.image.width; const H = state.image.height;
  const x = Math.max(0, Math.min(W - 1, c.x));
  const y = Math.max(0, Math.min(H - 1, c.y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.min(W - x, c.w)), h: Math.round(Math.min(H - y, c.h)) };
}

canvas.addEventListener('pointerdown', e => {
  if (!state.image || e.button !== 0) return;
  canvas.focus({ preventScroll: true });
  const p = toImage(e);
  const tool = state.tool;
  if (state.textEdit) { commitText(); if (tool === 'text') return; }

  if (tool === 'select') {
    const s = hitTest(p);
    state.selected = s ? s.id : null;
    updateButtons();
    if (s) {
      state.drag = { kind: 'move', start: p, orig: JSON.parse(JSON.stringify(s)), shape: s, moved: false };
      canvas.setPointerCapture(e.pointerId);
    }
    requestRender();
    return;
  }
  if (tool === 'text') { startText(p); e.preventDefault(); return; }
  if (tool === 'crop') {
    const c = state.cropDraft;
    if (c && p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) state.drag = { kind: 'crop-move', start: p, orig: { ...c } };
    else state.drag = { kind: 'crop', start: p };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  const color = currentColor();
  if (tool === 'pen') {
    state.temp = { id: newId('a'), type: 'pen', color, size: strokeFor(state.sizeLevel), points: [[p.x, p.y]] };
  } else if (DRAW_TOOLS.has(tool)) {
    state.temp = { id: newId('a'), type: tool, color, size: strokeFor(state.sizeLevel), level: state.sizeLevel, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }
  state.drag = { kind: 'draw', start: p };
  canvas.setPointerCapture(e.pointerId);
  requestRender();
});

canvas.addEventListener('pointermove', e => {
  if (!state.image) return;
  const p = toImage(e);
  if (!state.drag) {
    if (state.tool === 'select') canvas.className = hitTest(p) ? 't-move' : 't-select';
    return;
  }
  const d = state.drag;
  if (d.kind === 'move') {
    const dx = p.x - d.start.x; const dy = p.y - d.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) d.moved = true;
    moveShape(d.shape, d.orig, dx, dy);
  } else if (d.kind === 'crop') {
    state.cropDraft = clampCrop({ x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) });
  } else if (d.kind === 'crop-move') {
    const W = state.image.width; const H = state.image.height;
    const nx = Math.max(0, Math.min(W - d.orig.w, d.orig.x + p.x - d.start.x));
    const ny = Math.max(0, Math.min(H - d.orig.h, d.orig.y + p.y - d.start.y));
    state.cropDraft = { ...d.orig, x: Math.round(nx), y: Math.round(ny) };
  } else if (d.kind === 'draw' && state.temp) {
    const t = state.temp;
    if (t.type === 'pen') {
      const last = t.points[t.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5 * unit()) t.points.push([p.x, p.y]);
    } else {
      let x2 = p.x; let y2 = p.y;
      if (e.shiftKey) {
        if (t.type === 'arrow') {
          const ang = Math.round(Math.atan2(y2 - t.y1, x2 - t.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x2 - t.x1, y2 - t.y1);
          x2 = t.x1 + Math.cos(ang) * len; y2 = t.y1 + Math.sin(ang) * len;
        } else {
          const side = Math.max(Math.abs(x2 - t.x1), Math.abs(y2 - t.y1));
          x2 = t.x1 + Math.sign(x2 - t.x1 || 1) * side; y2 = t.y1 + Math.sign(y2 - t.y1 || 1) * side;
        }
      }
      t.x2 = x2; t.y2 = y2;
    }
  }
  requestRender();
});

function endPointer() {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.kind === 'move') { if (d.moved) pushHistory(); }
  else if (d.kind === 'crop' || d.kind === 'crop-move') {
    if (state.cropDraft && (state.cropDraft.w < 4 || state.cropDraft.h < 4)) state.cropDraft = null;
  } else if (d.kind === 'draw' && state.temp) {
    const t = state.temp;
    state.temp = null;
    let keep = true;
    if (t.type === 'arrow') keep = Math.hypot(t.x2 - t.x1, t.y2 - t.y1) > 4;
    else if (t.type !== 'pen') { const r = norm(t); keep = r.w > 3 && r.h > 3; }
    if (keep) { state.doc.shapes.push(t); pushHistory(); }
  }
  requestRender();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', e => {
  const s = hitTest(toImage(e));
  if (s && s.type === 'text') editText(s);
});

/* ---- crop ---- */
function applyCrop() {
  const c = state.cropDraft;
  const full = c && c.x <= 0 && c.y <= 0 && c.w >= state.image.width && c.h >= state.image.height;
  state.doc.crop = c && !full ? clampCrop(c) : null;
  pushHistory();
  state.fit = true;
  setTool('select');
}
$('crop-apply').addEventListener('click', applyCrop);
$('crop-cancel').addEventListener('click', () => { state.fit = true; setTool('select'); });
$('crop-reset').addEventListener('click', () => { state.cropDraft = null; requestRender(); });

/* ---- text ---- */
function styleTextInput() {
  const te = state.textEdit;
  if (!te) return;
  const s = te.shape;
  const r = canvas.getBoundingClientRect();
  const view = viewRect();
  const scale = r.width / canvas.width;
  const fs = s.fontSize * scale;
  Object.assign(textInput.style, {
    left: `${r.left + (s.x - view.x) * scale - 2}px`,
    top: `${r.top + (s.y - view.y) * scale - 2}px`,
    fontSize: `${fs}px`,
    color: s.color,
    caretColor: s.color,
  });
  autosizeText();
}
function autosizeText() {
  textInput.style.width = '0px';
  textInput.style.height = '0px';
  textInput.style.width = `${Math.max(40, textInput.scrollWidth + 8)}px`;
  textInput.style.height = `${textInput.scrollHeight + 2}px`;
}
function startText(p) {
  const shape = { id: newId('a'), type: 'text', color: currentColor(), fontSize: fontFor(state.sizeLevel), x: p.x, y: p.y - fontFor(state.sizeLevel) * 0.6, text: '' };
  state.textEdit = { shape, isNew: true };
  openTextInput('');
}
function editText(s) {
  state.selected = s.id;
  state.textEdit = { shape: s, isNew: false, before: s.text };
  openTextInput(s.text);
  requestRender();
}
function openTextInput(value) {
  textInput.value = value;
  textInput.hidden = false;
  styleTextInput();
  setTimeout(() => { textInput.focus(); textInput.select(); }, 0);
}
function commitText(cancel = false) {
  const te = state.textEdit;
  if (!te) return;
  state.textEdit = null;
  textInput.hidden = true;
  const text = textInput.value.replace(/\s+$/, '');
  if (te.isNew) {
    if (!cancel && text) { te.shape.text = text; state.doc.shapes.push(te.shape); pushHistory(); }
  } else if (cancel) {
    te.shape.text = te.before;
  } else if (!text) {
    state.doc.shapes = state.doc.shapes.filter(s => s.id !== te.shape.id);
    state.selected = null;
    pushHistory();
  } else if (text !== te.before) {
    te.shape.text = text;
    pushHistory();
  }
  requestRender();
}
textInput.addEventListener('input', autosizeText);
textInput.addEventListener('blur', () => commitText());
textInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); commitText(!state.textEdit?.isNew ? true : !textInput.value); canvas.focus(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText(); canvas.focus(); }
});
workspace.addEventListener('scroll', () => styleTextInput());

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */
function renderOutput() {
  const view = state.doc.crop || { x: 0, y: 0, w: state.image.width, h: state.image.height };
  const out = document.createElement('canvas');
  out.width = view.w;
  out.height = view.h;
  const savedTemp = state.temp;
  state.temp = null;
  paint(out.getContext('2d'), view, { overlays: false });
  state.temp = savedTemp;
  return out;
}

async function exportBlob(type) {
  const out = renderOutput();
  if (type === 'image/jpeg') {
    const flat = document.createElement('canvas');
    flat.width = out.width; flat.height = out.height;
    const f = flat.getContext('2d');
    f.fillStyle = '#fff';
    f.fillRect(0, 0, flat.width, flat.height);
    f.drawImage(out, 0, 0);
    return new Promise(r => flat.toBlob(r, type, 0.92));
  }
  return new Promise(r => out.toBlob(r, type));
}

async function download() {
  if (!state.image) return;
  commitText();
  const fmt = $('format').value;
  const blob = await exportBlob(fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
  downloadBlob(blob, `${safeFilename(state.title, 'screenshot')}.${fmt === 'jpeg' ? 'jpg' : 'png'}`);
  toast('Downloaded');
}

async function copy() {
  if (!state.image) return;
  commitText();
  try {
    const blob = exportBlob('image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied to clipboard');
  } catch (e) {
    toast('Could not copy: ' + e.message, { error: true });
  }
}
$('save').addEventListener('click', download);
$('copy').addEventListener('click', copy);
$('format').addEventListener('change', () => chrome.storage?.local.set({ editorFormat: $('format').value }).catch(() => {}));

/* ------------------------------------------------------------------ */
/* Keyboard                                                             */
/* ------------------------------------------------------------------ */
document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 's') { e.preventDefault(); download(); return; }
  if (mod && k === 'c') { e.preventDefault(); copy(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(state.zoom * 1.25); return; }
  if (mod && k === '-') { e.preventDefault(); setZoom(state.zoom / 1.25); return; }
  if (mod && k === '0') { e.preventDefault(); state.fit = true; applyZoom(); requestRender(); return; }
  if (mod) return;
  if (!state.image) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); return; }
  if (k === 'escape') {
    if (state.tool === 'crop') { state.fit = true; setTool('select'); }
    else { state.selected = null; updateButtons(); requestRender(); }
    return;
  }
  if (k === 'enter' && state.tool === 'crop') { e.preventDefault(); applyCrop(); return; }
  if (k === 'enter' && state.selected) { const s = selectedShape(); if (s && s.type === 'text') { e.preventDefault(); editText(s); } return; }
  if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
  if (['1', '2', '3', '4'].includes(k)) { setSize(Number(k)); return; }
  if (e.key.startsWith('Arrow') && state.selected) {
    e.preventDefault();
    const s = selectedShape();
    const step = (e.shiftKey ? 10 : 1) * unit();
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    moveShape(s, JSON.parse(JSON.stringify(s)), dx, dy);
    pushHistory();
    requestRender();
  }
});

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */
function updateStatus() {
  const v = state.doc.crop || (state.image && { w: state.image.width, h: state.image.height });
  $('st-size').textContent = v ? `${Math.round(v.w)} × ${Math.round(v.h)} px` : '';
  $('st-title').textContent = state.title;
}

async function loadImage(bitmap, { id, title, doc }) {
  state.image = bitmap;
  state.id = id;
  state.title = title;
  state.doc = doc && Array.isArray(doc.shapes) ? doc : { shapes: [], crop: null };
  state.history = [JSON.stringify(state.doc)];
  state.hIndex = 0;
  state.fit = true;
  document.title = `${title} - Capture Studio`;
  $('empty').hidden = true;
  wrap.hidden = false;
  canvas.width = 0;
  updateButtons();
  setTool(state.tool);
  render();
  $('st-saved').textContent = id ? 'Saved in library' : '';
}

async function openBlob(blob, title) {
  if (!blob || !blob.type.startsWith('image/')) { toast('That is not an image.', { error: true }); return; }
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { toast('Could not read that image.', { error: true }); return; }
  // Normalise to PNG and keep it in the library so edits persist.
  const id = newId('s');
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  const png = blob.type === 'image/png' ? blob : await c.convertToBlob({ type: 'image/png' });
  const scale = Math.min(1, 480 / bitmap.width);
  const th = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(Math.min(bitmap.height, bitmap.width * 1.5) * scale)));
  th.getContext('2d').drawImage(bitmap, 0, 0, bitmap.width, th.height / scale, 0, 0, th.width, th.height);
  const thumb = await th.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  await putShot({ id, created: Date.now(), kind: 'import', width: bitmap.width, height: bitmap.height, title, url: '', thumb, doc: null }, png);
  history.replaceState(null, '', `?id=${id}`);
  await loadImage(bitmap, { id, title, doc: null });
}

function showEmpty() {
  $('empty').hidden = false;
  wrap.hidden = true;
  document.title = 'Capture Studio - Editor';
}

$('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) openBlob(f, f.name.replace(/\.[^.]+$/, '')); });
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('textarea, input')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  if (state.image && !confirm('Replace the current image with the pasted one? (The current one stays in your library.)')) return;
  openBlob(item.getAsFile(), timestampName('Pasted image'));
});
workspace.addEventListener('dragover', e => { if (!state.image) { e.preventDefault(); $('empty').classList.add('drag'); } });
workspace.addEventListener('dragleave', () => $('empty').classList.remove('drag'));
workspace.addEventListener('drop', e => {
  $('empty').classList.remove('drag');
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  if (!f || state.image) return;
  e.preventDefault();
  openBlob(f, f.name.replace(/\.[^.]+$/, ''));
});

window.addEventListener('beforeunload', () => { if (state.dirty) persist(); });

async function init() {
  try {
    const prefs = await chrome.storage.local.get(['editorPrefs', 'editorFormat']);
    if (prefs.editorPrefs) {
      state.colors = { ...state.colors, ...prefs.editorPrefs.colors };
      state.sizeLevel = prefs.editorPrefs.sizeLevel || 2;
    }
    if (prefs.editorFormat) $('format').value = prefs.editorFormat;
  } catch { /* defaults */ }
  setTool('arrow');
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { showEmpty(); return; }
  const meta = await getShot(id);
  const blob = meta && await getShotBlob(id);
  if (!blob) { showEmpty(); toast('That screenshot is no longer in your library.', { error: true }); return; }
  const bitmap = await createImageBitmap(blob);
  await loadImage(bitmap, { id, title: meta.title || 'Screenshot', doc: meta.doc });
}

init().catch(e => { console.warn(e); showEmpty(); toast('Could not open the screenshot: ' + e.message, { error: true }); });
