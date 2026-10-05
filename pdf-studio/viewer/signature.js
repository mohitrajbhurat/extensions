// Signature creation (draw / type / upload) and the saved-signature list (chrome.storage.local).
import { pickFiles, makeDropTarget, toast, isImageFile } from '../lib/common.js';

const STORE_KEY = 'signatures';
const MAX_SAVED = 8;
const INK_COLORS = ['#111111', '#1d3fbb', '#b0182b'];
const TYPE_FONTS = [
  { label: 'Script', css: '"Segoe Script", "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive' },
  { label: 'Handwriting', css: '"Lucida Handwriting", "Bradley Hand", "Comic Neue", "Segoe Print", cursive' },
  { label: 'Chancery', css: '"Apple Chancery", "Monotype Corsiva", "Z003", "URW Chancery L", cursive' },
  { label: 'Formal', css: '"Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", serif', style: 'italic' }
];

const storage = () => (globalThis.chrome?.storage?.local ? chrome.storage.local : null);

export async function loadSignatures() {
  const s = storage();
  if (!s) return [];
  const got = await s.get(STORE_KEY);
  return Array.isArray(got[STORE_KEY]) ? got[STORE_KEY] : [];
}

async function saveSignatures(list) {
  await storage()?.set({ [STORE_KEY]: list.slice(0, MAX_SAVED) });
}

export async function addSignature(sig) {
  const list = await loadSignatures();
  list.unshift(sig);
  await saveSignatures(list);
}

export async function removeSignature(id) {
  const list = await loadSignatures();
  await saveSignatures(list.filter((s) => s.id !== id));
}

/** Crop transparent margins of a canvas and return { dataUrl, w, h }. */
function trimCanvas(src, pad = 6) {
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  x1 = Math.max(0, x1 - pad);
  y1 = Math.max(0, y1 - pad);
  x2 = Math.min(width - 1, x2 + pad);
  y2 = Math.min(height - 1, y2 + pad);
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext('2d').drawImage(src, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height };
}

export class SignatureDialog {
  constructor() {
    this.dlg = document.getElementById('sig-dialog');
    this.pad = document.getElementById('sig-pad');
    this.ctx = this.pad.getContext('2d');
    this.tab = 'draw';
    this.inkColor = INK_COLORS[0];
    this.fontIndex = 0;
    this.uploaded = null;
    this.strokes = 0;
    this._setupTabs();
    this._setupDraw();
    this._setupType();
    this._setupUpload();
  }

  /** Resolve with { dataUrl, w, h } or null when cancelled. */
  open() {
    this._clearPad();
    document.getElementById('sig-text').value = '';
    this._renderFonts();
    this.uploaded = null;
    const prev = document.getElementById('sig-upload-preview');
    prev.hidden = true;
    prev.removeAttribute('src');
    this._selectTab('draw');
    this.dlg.returnValue = '';
    this.dlg.showModal();
    return new Promise((resolve) => {
      const onClose = async () => {
        this.dlg.removeEventListener('close', onClose);
        if (this.dlg.returnValue !== 'done') return resolve(null);
        const result = await this._result();
        if (!result) return resolve(null);
        if (document.getElementById('sig-save').checked) {
          await addSignature({ id: 's' + Date.now().toString(36), ...result, created: Date.now() });
        }
        resolve(result);
      };
      this.dlg.addEventListener('close', onClose);
    });
  }

  _setupTabs() {
    document.getElementById('sig-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this._selectTab(b.dataset.tab);
    });
    this.dlg.querySelector('form').addEventListener('submit', (e) => {
      if (e.submitter?.value === 'done' && !this._hasContent()) {
        e.preventDefault();
        toast(this.tab === 'type' ? 'Type your name first' : this.tab === 'upload' ? 'Choose an image first' : 'Draw your signature first', 'error');
      }
    });
  }

  _selectTab(tab) {
    this.tab = tab;
    for (const b of this.dlg.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of this.dlg.querySelectorAll('.sig-pane')) p.hidden = p.dataset.pane !== tab;
    if (tab === 'type') setTimeout(() => document.getElementById('sig-text').focus(), 0);
  }

  _hasContent() {
    if (this.tab === 'draw') return this.strokes > 0;
    if (this.tab === 'type') return !!document.getElementById('sig-text').value.trim();
    return !!this.uploaded;
  }

  // ----- draw -----
  _setupDraw() {
    const colors = document.getElementById('sig-colors');
    for (const c of INK_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = c;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', 'Ink color ' + c);
      b.setAttribute('aria-checked', String(c === this.inkColor));
      b.addEventListener('click', () => {
        this.inkColor = c;
        for (const x of colors.children) x.setAttribute('aria-checked', String(x === b));
        this._renderFonts();
      });
      colors.append(b);
    }
    document.getElementById('sig-clear').addEventListener('click', () => this._clearPad());
    let drawing = false;
    let last = null;
    let lastW = 0;
    const pos = (e) => {
      const r = this.pad.getBoundingClientRect();
      return [(e.clientX - r.left) * (this.pad.width / r.width), (e.clientY - r.top) * (this.pad.height / r.height), e.timeStamp];
    };
    this.pad.addEventListener('pointerdown', (e) => {
      this.pad.setPointerCapture(e.pointerId);
      drawing = true;
      last = pos(e);
      const base = +document.getElementById('sig-thick').value * 2.2;
      lastW = base;
      this.ctx.fillStyle = this.inkColor;
      this.ctx.beginPath();
      this.ctx.arc(last[0], last[1], base / 2, 0, Math.PI * 2);
      this.ctx.fill();
      this.strokes++;
      document.getElementById('sig-hint').hidden = true;
    });
    this.pad.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const p = pos(ev);
        const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
        if (dist < 1) continue;
        // Pressure or speed-based width for a natural pen feel.
        const base = +document.getElementById('sig-thick').value * 2.2;
        const speed = dist / Math.max(1, p[2] - last[2]);
        const pressure = ev.pressure && ev.pointerType === 'pen' ? 0.5 + ev.pressure : 1;
        const target = base * pressure * Math.max(0.45, Math.min(1.25, 1.3 - speed * 0.12));
        const w = lastW + (target - lastW) * 0.35;
        this.ctx.strokeStyle = this.inkColor;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.lineWidth = w;
        this.ctx.beginPath();
        this.ctx.moveTo(last[0], last[1]);
        this.ctx.lineTo(p[0], p[1]);
        this.ctx.stroke();
        last = p;
        lastW = w;
      }
    });
    const end = () => { drawing = false; };
    this.pad.addEventListener('pointerup', end);
    this.pad.addEventListener('pointercancel', end);
  }

  _clearPad() {
    this.ctx.clearRect(0, 0, this.pad.width, this.pad.height);
    this.strokes = 0;
    document.getElementById('sig-hint').hidden = false;
  }

  // ----- type -----
  _setupType() {
    document.getElementById('sig-text').addEventListener('input', () => this._renderFonts());
  }

  _renderFonts() {
    const host = document.getElementById('sig-fonts');
    const text = document.getElementById('sig-text').value.trim() || 'Your Name';
    host.replaceChildren();
    TYPE_FONTS.forEach((f, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sig-font';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === this.fontIndex));
      b.setAttribute('aria-label', f.label + ' style');
      b.style.fontFamily = f.css;
      b.style.fontStyle = f.style || 'normal';
      b.style.color = this.inkColor;
      b.textContent = text;
      b.addEventListener('click', () => {
        this.fontIndex = i;
        this._renderFonts();
      });
      host.append(b);
    });
  }

  _typedCanvas() {
    const text = document.getElementById('sig-text').value.trim();
    const f = TYPE_FONTS[this.fontIndex];
    const size = 120;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `${f.style || 'normal'} ${size}px ${f.css}`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + size;
    c.width = Math.min(w, 4000);
    c.height = Math.ceil(size * 1.8);
    ctx.font = font;
    ctx.fillStyle = this.inkColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, c.height / 2);
    return c;
  }

  // ----- upload -----
  _setupUpload() {
    const zone = document.getElementById('sig-upload');
    const handle = async (files) => {
      const file = files.find(isImageFile);
      if (!file) return toast('Choose a PNG or JPG image', 'error');
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        this.uploaded = img;
        const prev = document.getElementById('sig-upload-preview');
        prev.src = this._uploadCanvas().toDataURL('image/png');
        prev.hidden = false;
      } catch {
        toast('That image could not be read', 'error');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    makeDropTarget(zone, handle);
    document.getElementById('sig-upload-btn').addEventListener('click', async () => handle(await pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif' })));
    document.getElementById('sig-remove-bg').addEventListener('change', () => {
      if (!this.uploaded) return;
      document.getElementById('sig-upload-preview').src = this._uploadCanvas().toDataURL('image/png');
    });
  }

  _uploadCanvas() {
    const img = this.uploaded;
    const max = 1200;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (document.getElementById('sig-remove-bg').checked) {
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        // Soft threshold: near-white becomes transparent, mid-tones fade.
        if (lum > 225) px[i + 3] = 0;
        else if (lum > 170) px[i + 3] = Math.round(px[i + 3] * (225 - lum) / 55);
      }
      ctx.putImageData(d, 0, 0);
    }
    return c;
  }

  async _result() {
    let canvas;
    if (this.tab === 'draw') canvas = this.pad;
    else if (this.tab === 'type') canvas = this._typedCanvas();
    else canvas = this._uploadCanvas();
    const trimmed = trimCanvas(canvas);
    if (!trimmed) return null;
    return trimmed;
  }
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
