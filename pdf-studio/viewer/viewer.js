// PDF Studio viewer: rendering (pdf.js), navigation, search, annotate, fill & sign, save (pdf-lib).
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import {
  downloadBlob, baseName, isPdfBytes, readFile, isPdfFile, isImageFile, toast, busy,
  makeDropTarget, pickFiles, takeHandoff, openWithDocument, getDraft, putDraft, deleteDraft
} from '../lib/common.js';
import { AnnotationManager, PALETTES } from './annotations.js';
import { FieldLayer } from './fields.js';
import { SignatureDialog, loadSignatures, removeSignature, loadImage } from './signature.js';
import { applyAnnotations } from '../lib/export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const pagesEl = $('pages');
const MIN_SCALE = 0.1;
const MAX_SCALE = 6;
const PAGE_GAP = 16;
const MAX_CANVAS_PIXELS = 16_777_216;

const state = {
  pdf: null,
  bytes: null,
  name: '',
  fingerprint: null,
  pages: [],
  scale: 1,
  zoomMode: 'fit-width',
  current: 0,
  mode: 'view',
  dark: false,
  sidebar: true,
  dirty: false,
  loadToken: 0,
  settings: {}
};

// ---------------------------------------------------------------- settings

const settingsStore = globalThis.chrome?.storage?.local;
async function loadSettings() {
  try {
    const got = await settingsStore?.get('viewerSettings');
    state.settings = got?.viewerSettings || {};
  } catch {
    state.settings = {};
  }
}
let settingsTimer;
function saveSettings(patch) {
  Object.assign(state.settings, patch);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => settingsStore?.set({ viewerSettings: state.settings }).catch(() => {}), 300);
}

// ---------------------------------------------------------------- managers

const annots = new AnnotationManager({
  pagesEl,
  getPageEl: (i) => state.pages[i].el,
  getPageSize: (i) => ({ w: state.pages[i].w, h: state.pages[i].h }),
  getDateText,
  defaultTool: () => (state.mode === 'view' ? 'view' : 'select'),
  onChange: markDirty,
  onSelectionChange: updateProps,
  onToolChange: updateToolButtons,
  onStylesChange: (styles) => saveSettings({ styles })
});

const fields = new FieldLayer({
  onChange: markDirty,
  onLink: goToDest,
  onSignField: (field) => {
    setMode('sign');
    openSigMenu(field);
  },
  toUnitsRect: (i, rect) => {
    const [x1, y1, x2, y2] = state.pages[i].vp1.convertToViewportRectangle(rect);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
});

let sigDialog;

// ---------------------------------------------------------------- loading

async function openBytes(bytes, name, { sourceUrl = null } = {}) {
  if (state.dirty && !confirm('Open another PDF? Your unsaved changes are kept as a draft and come back when you reopen this file.')) return;
  await flushDraft();
  closeDocument();
  const token = ++state.loadToken;
  if (!isPdfBytes(bytes)) {
    showError('This is not a PDF', `${name || 'The file'} does not look like a PDF document.`);
    return;
  }
  busy('Opening ' + (name || 'PDF') + '…');
  try {
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      useSystemFonts: true,
      enableXfa: false,
      verbosity: 0
    });
    task.onPassword = (update, reason) => {
      busy(null);
      askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw == null) task.destroy();
        else {
          busy('Opening…');
          update(pw);
        }
      });
    };
    const pdf = await task.promise;
    if (token !== state.loadToken) return pdf.destroy();
    state.pdf = pdf;
    state.bytes = bytes;
    state.name = name || 'document.pdf';
    state.sourceUrl = sourceUrl;
    state.fingerprint = pdf.fingerprints?.[0] || null;
    await buildPages(token);
    if (token !== state.loadToken) return;
    showDocumentChrome();
    annots.reset([]);
    fields.reset();
    const n = await fields.scan(pdf);
    $('form-info').textContent = n ? `${n} fillable field${n === 1 ? '' : 's'}` : 'No form fields';
    if (n && state.mode === 'view') toast(`This PDF has ${n} fillable field${n === 1 ? '' : 's'}. Use Fill & Sign to complete it.`);
    await restoreDraft();
    applyZoom(state.zoomMode === 'custom' ? state.scale : state.zoomMode, { keepPosition: false });
    scroller.scrollTop = 0;
    updateCurrentPage();
    scheduleRender();
    buildThumbnails();
    try {
      const meta = await pdf.getMetadata();
      const title = meta?.info?.Title;
      document.title = `${title && title.trim() ? title.trim() : state.name} – PDF Studio`;
    } catch {
      document.title = `${state.name} – PDF Studio`;
    }
  } catch (err) {
    if (token !== state.loadToken) return;
    if (err?.name === 'PasswordException') showError('Password required', 'The PDF could not be opened without its password.');
    else showError("Couldn't open this PDF", err?.message || String(err));
  } finally {
    if (token === state.loadToken) busy(null);
  }
}

function closeDocument() {
  for (const p of state.pages) p.task?.cancel();
  state.pdf?.destroy();
  state.pdf = null;
  state.bytes = null;
  state.pages = [];
  state.dirty = false;
  pagesEl.replaceChildren();
  $('thumbs').replaceChildren();
  clearSearch();
  search.cache.clear();
  $('dirty-dot').hidden = true;
  $('load-error').hidden = true;
}

async function buildPages(token) {
  const n = state.pdf.numPages;
  const pages = new Array(n);
  const BATCH = 32;
  for (let start = 0; start < n; start += BATCH) {
    const chunk = [];
    for (let i = start; i < Math.min(n, start + BATCH); i++) {
      chunk.push(state.pdf.getPage(i + 1).then((page) => {
        const vp1 = page.getViewport({ scale: 1 });
        pages[i] = { index: i, w: vp1.width, h: vp1.height, vp1, page };
      }));
    }
    await Promise.all(chunk);
    if (token !== state.loadToken) return;
    if (n > 200) busy(`Reading pages… ${Math.min(n, start + BATCH)} / ${n}`);
  }
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = p.index;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', `Page ${p.index + 1}`);
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    const searchDiv = document.createElement('div');
    searchDiv.className = 'search-layer';
    const formDiv = document.createElement('div');
    formDiv.className = 'form-layer';
    const annoDiv = document.createElement('div');
    annoDiv.className = 'anno-layer';
    el.append(textDiv, searchDiv, formDiv, annoDiv);
    Object.assign(p, { el, textDiv, searchDiv, formDiv, annoDiv, canvas: null, renderedScale: 0, task: null, textLayer: null, near: false });
    frag.append(el);
  }
  pagesEl.append(frag);
  state.pages = pages;
  $('page-count').textContent = n;
  for (const p of pages) {
    annots.attachLayer(p.index, p.annoDiv);
    pageObserver.observe(p.el);
  }
}

function showDocumentChrome() {
  $('empty').hidden = true;
  $('load-error').hidden = true;
  $('toolbar').hidden = false;
  $('mode-tabs').hidden = false;
  $('doc-title').hidden = false;
  $('doc-name').textContent = state.name;
  $('doc-name').title = state.name;
  $('btn-save').disabled = false;
  $('sidebar').hidden = !state.sidebar;
  $('btn-sidebar').setAttribute('aria-pressed', String(state.sidebar));
  setMode(state.mode);
}

function showError(title, msg, actions = []) {
  busy(null);
  $('empty').hidden = true;
  $('toolbar').hidden = true;
  $('mode-tabs').hidden = true;
  $('doc-title').hidden = true;
  $('sidebar').hidden = true;
  const box = $('load-error');
  box.hidden = false;
  $('load-error-title').textContent = title;
  $('load-error-msg').textContent = msg;
  const host = $('load-error-actions');
  host.replaceChildren();
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    host.append(b);
  }
  const open = document.createElement('button');
  open.className = 'btn';
  open.textContent = 'Open another PDF';
  open.addEventListener('click', openFromPicker);
  host.append(open);
}

async function openFromPicker() {
  const [file] = await pickFiles({ accept: 'application/pdf,.pdf' });
  if (file) openFile(file);
}

async function openFile(file) {
  if (!isPdfFile(file)) {
    toast(`${file.name} is not a PDF`, 'error');
    return;
  }
  openBytes(await readFile(file), file.name);
}

async function openUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return showError('Invalid link', url);
  }
  busy('Downloading PDF…');
  try {
    const res = await fetch(parsed.href, { credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error(`The server answered ${res.status} ${res.statusText}`), { http: true });
    const bytes = new Uint8Array(await res.arrayBuffer());
    busy(null);
    if (!isPdfBytes(bytes)) {
      return showError("That link isn't a PDF", `${parsed.href} returned ${res.headers.get('content-type') || 'something else'}, not a PDF document.`);
    }
    const name = filenameFromResponse(res) || pdfjsLib.getPdfFilenameFromUrl(parsed.href, 'document.pdf');
    await openBytes(bytes, name, { sourceUrl: parsed.href });
  } catch (err) {
    busy(null);
    if (err.http) return showError("Couldn't download the PDF", err.message);
    if (parsed.protocol === 'file:') {
      return showError('Allow access to local files', 'To open PDFs from your computer by link, turn on "Allow access to file URLs" for PDF Studio on the extensions page, or simply drop the file here.', [
        { label: 'Open extension settings', primary: true, onClick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }) }
      ]);
    }
    const origin = `${parsed.protocol}//${parsed.host}/*`;
    const has = await chrome.permissions?.contains({ origins: [origin] }).catch(() => false);
    if (!has && /^https?:$/.test(parsed.protocol)) {
      return showError(`Allow PDF Studio to read ${parsed.host}?`, 'PDF Studio needs your permission to download this PDF. The file is processed on this computer and is never uploaded anywhere.', [
        {
          label: `Allow access to ${parsed.host}`,
          primary: true,
          onClick: async () => {
            const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
            if (ok) openUrl(url);
            else toast('Permission was not granted', 'error');
          }
        }
      ]);
    }
    showError("Couldn't download the PDF", `${err.message || err}. Check your connection, or download the file and drop it here.`);
  }
}

function filenameFromResponse(res) {
  const cd = res.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) try { return decodeURIComponent(star[1].trim().replace(/"/g, '')); } catch { /* fall through */ }
  const m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return m ? m[1].trim() : null;
}

function askPassword(incorrect) {
  const dlg = $('pw-dialog');
  $('pw-msg').textContent = incorrect ? 'That password is incorrect. Try again.' : 'This PDF is protected. Enter its password to open it.';
  $('pw-input').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  $('pw-input').focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('pw-input').value : null), { once: true });
  });
}

// ---------------------------------------------------------------- drafts

let draftTimer;
function markDirty() {
  if (!state.pdf) return;
  state.dirty = annots.count > 0 || fields.dirty;
  $('dirty-dot').hidden = !state.dirty;
  updateProps();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 800);
}

async function flushDraft() {
  clearTimeout(draftTimer);
  if (!state.fingerprint || !state.pdf) return;
  const data = { annotations: annots.serialize(), fields: fields.changedValues(), name: state.name };
  if (!data.annotations.length && !Object.keys(data.fields).length) await deleteDraft(state.fingerprint);
  else await putDraft(state.fingerprint, data);
}

async function restoreDraft() {
  if (!state.fingerprint) return;
  const draft = await getDraft(state.fingerprint);
  if (!draft) return;
  const nA = draft.annotations?.length || 0;
  const nF = Object.keys(draft.fields || {}).length;
  if (!nA && !nF) return;
  annots.reset(draft.annotations.filter((a) => a.page < state.pages.length));
  fields.restore(draft.fields);
  state.dirty = true;
  $('dirty-dot').hidden = false;
  const parts = [];
  if (nA) parts.push(`${nA} annotation${nA === 1 ? '' : 's'}`);
  if (nF) parts.push(`${nF} form field${nF === 1 ? '' : 's'}`);
  showBanner(`Restored ${parts.join(' and ')} from your last session.`, [
    { label: 'Keep', primary: true },
    {
      label: 'Discard',
      onClick: async () => {
        annots.reset([]);
        fields.restore({});
        await deleteDraft(state.fingerprint);
        // Re-render field inputs with original values.
        fields.reset();
        await fields.scan(state.pdf);
        for (const p of state.pages) p.formDiv.replaceChildren();
        scheduleRender(true);
        state.dirty = false;
        $('dirty-dot').hidden = true;
      }
    }
  ]);
}

function showBanner(text, actions, ms = 12000) {
  const b = $('banner');
  $('banner-text').textContent = text;
  const host = $('banner-actions');
  host.replaceChildren();
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'btn small' + (a.primary ? ' primary' : '');
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      b.hidden = true;
      a.onClick?.();
    });
    host.append(btn);
  }
  b.hidden = false;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => { b.hidden = true; }, ms);
}

// ---------------------------------------------------------------- layout and zoom

function availableWidth() {
  return Math.max(100, scroller.clientWidth - PAGE_GAP * 2 - 4);
}

function computeScale(mode) {
  if (!state.pages.length) return 1;
  if (mode === 'fit-width') {
    const maxW = Math.max(...state.pages.map((p) => p.w));
    return clamp(availableWidth() / maxW, MIN_SCALE, MAX_SCALE);
  }
  if (mode === 'fit-page') {
    const p = state.pages[state.current] || state.pages[0];
    return clamp(Math.min(availableWidth() / p.w, (scroller.clientHeight - 48) / p.h), MIN_SCALE, MAX_SCALE);
  }
  return clamp(+mode || 1, MIN_SCALE, MAX_SCALE);
}

/** mode: 'fit-width' | 'fit-page' | number. anchor: {x, y} client coords to keep fixed. */
function applyZoom(mode, { anchor = null, keepPosition = true } = {}) {
  if (!state.pages.length) return;
  const newScale = computeScale(mode);
  state.zoomMode = typeof mode === 'number' ? 'custom' : mode;
  let ref = null;
  if (keepPosition) {
    const sr = scroller.getBoundingClientRect();
    const ax = anchor ? anchor.x - sr.left : scroller.clientWidth / 2;
    const ay = anchor ? anchor.y - sr.top : 0;
    const p = pageAtOffset(scroller.scrollTop + ay);
    if (p) {
      ref = {
        p,
        ay,
        ax,
        uy: (scroller.scrollTop + ay - p.el.offsetTop) / state.scale,
        fx: (scroller.scrollLeft + ax) / Math.max(1, pagesEl.scrollWidth)
      };
    }
  }
  state.scale = newScale;
  for (const p of state.pages) {
    p.el.style.width = Math.floor(p.w * newScale) + 'px';
    p.el.style.height = Math.floor(p.h * newScale) + 'px';
    p.el.style.setProperty('--scale-factor', newScale);
  }
  if (ref) {
    scroller.scrollTop = ref.p.el.offsetTop + ref.uy * newScale - ref.ay;
    scroller.scrollLeft = ref.fx * pagesEl.scrollWidth - ref.ax;
  }
  updateZoomUi();
  scheduleRender();
}

function zoomBy(factor, anchor) {
  const steps = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
  let next;
  if (factor > 1) next = steps.find((s) => s > state.scale + 0.001) ?? MAX_SCALE;
  else next = [...steps].reverse().find((s) => s < state.scale - 0.001) ?? MIN_SCALE;
  applyZoom(next, { anchor });
}

function updateZoomUi() {
  const sel = $('zoom-select');
  const custom = sel.querySelector('option[value="custom"]');
  if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') {
    sel.value = state.zoomMode;
    custom.hidden = true;
  } else {
    const match = [...sel.options].find((o) => Math.abs(+o.value - state.scale) < 0.001);
    if (match) {
      sel.value = match.value;
      custom.hidden = true;
    } else {
      custom.hidden = false;
      custom.textContent = Math.round(state.scale * 100) + '%';
      sel.value = 'custom';
    }
  }
  sel.title = `Zoom ${Math.round(state.scale * 100)}%`;
}

function pageAtOffset(y) {
  const pages = state.pages;
  if (!pages.length) return null;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].el.offsetTop <= y) lo = mid;
    else hi = mid - 1;
  }
  return pages[lo];
}

function updateCurrentPage() {
  const p = pageAtOffset(scroller.scrollTop + scroller.clientHeight * 0.35);
  if (!p) return;
  if (p.index !== state.current || $('page-input').value !== String(p.index + 1)) {
    state.current = p.index;
    if (document.activeElement !== $('page-input')) $('page-input').value = p.index + 1;
    for (const t of $('thumbs').children) t.classList.toggle('active', +t.dataset.index === p.index);
    const active = $('thumbs').children[p.index];
    if (active && !$('sidebar').hidden) {
      const sb = $('sidebar');
      const top = active.offsetTop;
      if (top < sb.scrollTop || top + active.offsetHeight > sb.scrollTop + sb.clientHeight) sb.scrollTop = top - sb.clientHeight / 3;
    }
  }
  $('btn-prev').disabled = p.index === 0;
  $('btn-next').disabled = p.index === state.pages.length - 1;
}

function goToPage(index, yUnits = null) {
  const p = state.pages[clamp(index, 0, state.pages.length - 1)];
  if (!p) return;
  const y = yUnits == null ? -PAGE_GAP / 2 : yUnits * state.scale - 24;
  scroller.scrollTop = p.el.offsetTop + y;
  state.current = p.index;
  $('page-input').value = p.index + 1;
  updateCurrentPage();
}

async function goToDest(dest) {
  try {
    const explicit = typeof dest === 'string' ? await state.pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    const index = typeof ref === 'object' && ref !== null ? await state.pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
    if (index == null) return;
    let y = null;
    if (explicit[1]?.name === 'XYZ' && explicit[3] != null) {
      y = state.pages[index].vp1.convertToViewportPoint(explicit[2] || 0, explicit[3])[1];
    } else if (explicit[1]?.name === 'FitH' && explicit[2] != null) {
      y = state.pages[index].vp1.convertToViewportPoint(0, explicit[2])[1];
    }
    goToPage(index, y);
  } catch {
    toast('That link points to a place that could not be found', 'error');
  }
}

// ---------------------------------------------------------------- rendering

const pageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = state.pages[+e.target.dataset.index];
    if (!p) continue;
    p.near = e.isIntersecting;
    if (!p.near) releasePage(p);
  }
  scheduleRender();
}, { root: scroller, rootMargin: '1200px 0px' });

let renderPending = false;
let rendering = false;
function scheduleRender(force = false) {
  if (force) for (const p of state.pages) p.renderedScale = 0;
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderLoop();
  });
}

async function renderLoop() {
  if (rendering) {
    renderLoop.again = true;
    return;
  }
  rendering = true;
  try {
    for (;;) {
      const cur = state.current;
      const next = state.pages
        .filter((p) => p.near && p.renderedScale !== state.scale)
        .sort((a, b) => Math.abs(a.index - cur) - Math.abs(b.index - cur))[0];
      if (!next) break;
      await renderPage(next);
    }
  } finally {
    rendering = false;
  }
  if (renderLoop.again) {
    renderLoop.again = false;
    renderLoop();
  } else {
    thumbLoop();
  }
}

async function renderPage(p) {
  const scale = state.scale;
  const pdf = state.pdf;
  p.task?.cancel();
  const page = p.page;
  const vp = page.getViewport({ scale });
  let dpr = window.devicePixelRatio || 1;
  if (vp.width * vp.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = Math.max(1, Math.floor(vp.width * dpr));
  canvas.height = Math.max(1, Math.floor(vp.height * dpr));
  canvas.setAttribute('aria-hidden', 'true');
  if (!p.canvas) p.el.classList.add('loading');
  const task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS
  });
  p.task = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('Render failed for page', p.index + 1, err);
    p.el.classList.remove('loading');
    if (err?.name !== 'RenderingCancelledException') p.renderedScale = scale;
    return;
  } finally {
    if (p.task === task) p.task = null;
  }
  if (pdf !== state.pdf) return;
  if (!p.near) return;
  if (p.canvas) p.canvas.replaceWith(canvas);
  else p.el.prepend(canvas);
  p.canvas = canvas;
  p.el.classList.remove('loading');
  p.renderedScale = scale;
  if (scale !== state.scale) return;
  // Text layer
  try {
    p.textLayer?.cancel();
    p.textDiv.replaceChildren();
    const content = await getTextContent(p.index);
    if (pdf !== state.pdf || scale !== state.scale) return;
    const tl = new pdfjsLib.TextLayer({ textContentSource: content, container: p.textDiv, viewport: vp });
    p.textLayer = tl;
    await tl.render();
    const end = document.createElement('div');
    end.className = 'endOfContent';
    p.textDiv.append(end);
    paintSearchHits(p);
  } catch (err) {
    if (err?.name !== 'AbortException') console.warn('Text layer failed for page', p.index + 1, err);
  }
  fields.attach(p.index, page, p.formDiv, { w: p.w, h: p.h });
}

function releasePage(p) {
  p.task?.cancel();
  p.textLayer?.cancel();
  p.textLayer = null;
  if (p.canvas) {
    p.canvas.width = p.canvas.height = 0;
    p.canvas.remove();
    p.canvas = null;
  }
  p.textDiv.replaceChildren();
  p.searchDiv.replaceChildren();
  p.renderedScale = 0;
  p.el.classList.remove('loading');
}

async function getTextContent(i) {
  const p = state.pages[i];
  if (!p.textContent) {
    p.textContent = await p.page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  }
  return p.textContent;
}

// ---------------------------------------------------------------- thumbnails

const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = e.target;
    t._near = e.isIntersecting;
  }
  thumbLoop();
}, { root: $('sidebar'), rootMargin: '400px 0px' });

function buildThumbnails() {
  const host = $('thumbs');
  host.replaceChildren();
  const W = 120;
  for (const p of state.pages) {
    const b = document.createElement('button');
    b.className = 'thumb' + (p.index === state.current ? ' active' : '');
    b.dataset.index = p.index;
    b.setAttribute('aria-label', `Go to page ${p.index + 1}`);
    const box = document.createElement('div');
    box.className = 'thumb-img';
    box.style.width = W + 'px';
    box.style.height = Math.round((W * p.h) / p.w) + 'px';
    const label = document.createElement('span');
    label.textContent = p.index + 1;
    b.append(box, label);
    b.addEventListener('click', () => goToPage(p.index));
    host.append(b);
    thumbObserver.observe(b);
  }
}

let thumbBusy = false;
async function thumbLoop() {
  if (thumbBusy || rendering || $('sidebar').hidden) return;
  thumbBusy = true;
  try {
    for (;;) {
      if (rendering) break;
      const t = [...$('thumbs').children].find((x) => x._near && !x._done);
      if (!t) break;
      t._done = true;
      const p = state.pages[+t.dataset.index];
      if (!p) break;
      const box = t.firstChild;
      const scale = (box.clientWidth * (window.devicePixelRatio || 1)) / p.w;
      const vp = p.page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      try {
        await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
        box.replaceChildren(c);
      } catch {
        t._done = false;
        break;
      }
    }
  } finally {
    thumbBusy = false;
  }
}

// ---------------------------------------------------------------- search

const search = {
  query: '',
  matches: [],
  active: -1,
  token: 0,
  cache: new Map(),
  pendingScroll: false
};

async function pageSearchText(i) {
  if (search.cache.has(i)) return search.cache.get(i);
  const content = await getTextContent(i);
  let text = '';
  const segs = [];
  let k = 0;
  for (const item of content.items) {
    if (item.str === undefined) continue;
    segs.push({ start: text.length, end: text.length + item.str.length, item: k });
    text += item.str;
    if (item.hasEOL) text += ' ';
    k++;
  }
  const entry = { text, segs };
  search.cache.set(i, entry);
  return entry;
}

function buildRegex(q) {
  const esc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  let src = esc;
  if ($('search-word').checked) src = `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, 'gu' + ($('search-case').checked ? '' : 'i'));
}

async function runSearch() {
  const q = $('search-input').value;
  const token = ++search.token;
  clearSearchHits();
  search.matches = [];
  search.active = -1;
  search.query = q;
  if (!q.trim() || !state.pdf) {
    $('search-count').textContent = '';
    return;
  }
  let re;
  try {
    re = buildRegex(q);
  } catch {
    $('search-count').textContent = 'Invalid';
    return;
  }
  $('search-count').textContent = 'Searching…';
  const startPage = state.current;
  let jumped = false;
  for (let i = 0; i < state.pages.length; i++) {
    const { text } = await pageSearchText(i);
    if (token !== search.token) return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      search.matches.push({ page: i, start: m.index, end: m.index + m[0].length });
    }
    if (!jumped && search.matches.length && (i >= startPage || i === state.pages.length - 1)) {
      const idx = search.matches.findIndex((x) => x.page >= startPage);
      if (idx >= 0) {
        jumped = true;
        setActiveMatch(idx);
      }
    }
    if (i % 20 === 19) $('search-count').textContent = `${search.matches.length} found…`;
  }
  if (!jumped && search.matches.length) setActiveMatch(0);
  for (const p of state.pages) if (p.textLayer) paintSearchHits(p);
  updateSearchCount();
}

function updateSearchCount() {
  const n = search.matches.length;
  $('search-count').textContent = n ? `${search.active + 1} of ${n}` : search.query.trim() ? 'No matches' : '';
}

function setActiveMatch(i) {
  const n = search.matches.length;
  if (!n) return;
  const prev = search.matches[search.active];
  search.active = ((i % n) + n) % n;
  const m = search.matches[search.active];
  updateSearchCount();
  const p = state.pages[m.page];
  if (prev && prev.page !== m.page) paintSearchHits(state.pages[prev.page]);
  search.pendingScroll = true;
  if (p.textLayer) paintSearchHits(p);
  if (search.pendingScroll) {
    goToPage(m.page);
  }
}

function paintSearchHits(p) {
  if (!p) return;
  p.searchDiv.replaceChildren();
  if (!p.textLayer || !search.matches.length) return;
  const entry = search.cache.get(p.index);
  if (!entry) return;
  const divs = p.textLayer.textDivs;
  const pr = p.el.getBoundingClientRect();
  const s = pr.width / p.w;
  let activeEl = null;
  search.matches.forEach((m, mi) => {
    if (m.page !== p.index) return;
    for (const seg of entry.segs) {
      if (seg.end <= m.start || seg.start >= m.end) continue;
      const span = divs[seg.item];
      const node = span?.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const range = document.createRange();
      try {
        range.setStart(node, Math.max(0, m.start - seg.start));
        range.setEnd(node, Math.min(node.length, m.end - seg.start));
      } catch {
        continue;
      }
      for (const r of range.getClientRects()) {
        const hit = document.createElement('div');
        hit.className = 'search-hit' + (mi === search.active ? ' active' : '');
        hit.style.left = (((r.left - pr.left) / s) / p.w) * 100 + '%';
        hit.style.top = (((r.top - pr.top) / s) / p.h) * 100 + '%';
        hit.style.width = ((r.width / s) / p.w) * 100 + '%';
        hit.style.height = ((r.height / s) / p.h) * 100 + '%';
        p.searchDiv.append(hit);
        if (mi === search.active && !activeEl) activeEl = hit;
      }
    }
  });
  if (activeEl && search.pendingScroll) {
    search.pendingScroll = false;
    activeEl.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

function clearSearchHits() {
  for (const p of state.pages) p.searchDiv?.replaceChildren();
}

function clearSearch() {
  search.token++;
  search.matches = [];
  search.active = -1;
  search.query = '';
  clearSearchHits();
  $('search-count').textContent = '';
}

function openSearch() {
  if (!state.pdf) return;
  $('searchbar').hidden = false;
  $('btn-search').setAttribute('aria-pressed', 'true');
  const input = $('search-input');
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) {
    input.value = sel;
    runSearch();
  }
  input.focus();
  input.select();
}

function closeSearch() {
  $('searchbar').hidden = true;
  $('btn-search').setAttribute('aria-pressed', 'false');
  clearSearch();
  scroller.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- modes, tools, props

function setMode(mode) {
  state.mode = mode;
  for (const b of $('mode-tabs').querySelectorAll('[data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('tools-annotate').hidden = mode !== 'annotate';
  $('tools-sign').hidden = mode !== 'sign';
  $('props').hidden = mode === 'view';
  annots.setTool(mode === 'view' ? 'view' : 'select');
  updateProps();
}

function updateToolButtons(tool) {
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
  updateProps();
}

const SIGN_ONLY = new Set(['date', 'mark-check', 'mark-cross', 'mark-dot']);
const ANNOTATE_ONLY = new Set(['highlight', 'underline', 'strike', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'note']);

function setTool(tool) {
  if (!state.pdf) return;
  if (SIGN_ONLY.has(tool) && state.mode !== 'sign') setMode('sign');
  else if (ANNOTATE_ONLY.has(tool) && state.mode !== 'annotate') setMode('annotate');
  else if (state.mode === 'view') setMode('annotate');
  if (annots.tool === tool && tool !== 'select') tool = 'select';
  annots.setTool(tool);
}

function updateProps() {
  if ($('props').hidden) return;
  const st = annots.activeStyle();
  const kind = st.kind;
  const sw = $('swatches');
  sw.replaceChildren();
  const show = (id, on) => { $(id).hidden = !on; };
  show('swatches', !!kind);
  show('color-custom', !!kind && kind !== 'markup' && kind !== 'note');
  show('prop-width', kind === 'stroke' || (kind === 'shape' && !st.fill));
  show('prop-font', kind === 'text');
  show('prop-size', kind === 'text');
  show('prop-fill', kind === 'shape');
  if (kind) {
    const palette = kind === 'markup' ? PALETTES.markup : kind === 'note' ? PALETTES.note : PALETTES.stroke;
    for (const c of palette) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', 'Color ' + c);
      b.title = c;
      b.setAttribute('aria-checked', String((st.color || '').toLowerCase() === c));
      b.addEventListener('click', () => annots.setStyle({ color: c }));
      sw.append(b);
    }
    if (st.color) $('color-custom').value = st.color;
    if (st.width) setSelectValue($('stroke-width'), st.width);
    if (st.size) setSelectValue($('font-size'), st.size);
    if (st.font) $('font-family').value = st.font;
    $('shape-fill').checked = !!st.fill;
  }
  $('btn-undo').disabled = !annots.canUndo();
  $('btn-redo').disabled = !annots.canRedo();
  $('btn-delete').disabled = !annots.selected;
}

function setSelectValue(sel, v) {
  const s = String(v);
  if (![...sel.options].some((o) => o.value === s)) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = sel.id === 'stroke-width' ? `${s} pt` : s;
    sel.append(o);
  }
  sel.value = s;
}

function getDateText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  switch ($('date-format').value) {
    case 'iso': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    case 'us': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    case 'eu': return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 'long': return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    default: return d.toLocaleDateString();
  }
}

function initDateFormats() {
  const sel = $('date-format');
  const saved = state.settings.dateFormat;
  for (const o of sel.options) {
    const prev = sel.value;
    sel.value = o.value;
    o.textContent = o.value === 'locale' ? `${getDateText()} (local)` : getDateText();
    sel.value = prev;
  }
  if (saved) sel.value = saved;
}

// ---------------------------------------------------------------- signatures and images

async function openSigMenu(field = null) {
  const menu = $('sig-menu');
  const list = await loadSignatures();
  if (!list.length) {
    menu.hidden = true;
    return createSignature(field);
  }
  menu.replaceChildren();
  const label = document.createElement('div');
  label.className = 'menu-label';
  label.textContent = field ? 'Sign this field with' : 'Your signatures';
  menu.append(label);
  for (const sig of list) {
    const row = document.createElement('div');
    row.className = 'sig-item';
    const use = document.createElement('button');
    use.className = 'sig-use';
    use.setAttribute('role', 'menuitem');
    use.setAttribute('aria-label', 'Use this signature');
    const img = document.createElement('img');
    img.src = sig.dataUrl;
    img.alt = 'Saved signature';
    use.append(img);
    use.addEventListener('click', () => {
      menu.hidden = true;
      placeSignature(sig, field);
    });
    const del = document.createElement('button');
    del.className = 'icon-btn small';
    del.title = 'Delete this saved signature';
    del.setAttribute('aria-label', 'Delete saved signature');
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeSignature(sig.id);
      openSigMenu(field);
    });
    row.append(use, del);
    menu.append(row);
  }
  const create = document.createElement('button');
  create.className = 'btn small primary';
  create.setAttribute('role', 'menuitem');
  create.textContent = '+ Create new signature';
  create.addEventListener('click', () => {
    menu.hidden = true;
    createSignature(field);
  });
  menu.append(create);
  menu.hidden = false;
  menu.querySelector('button')?.focus();
}

async function createSignature(field) {
  sigDialog ??= new SignatureDialog();
  const sig = await sigDialog.open();
  if (sig) placeSignature(sig, field);
}

function placeSignature(sig, field) {
  // Default on-page size: about 160pt wide, at most 54pt tall.
  const s = Math.min(160 / sig.w, 54 / sig.h);
  annots.startPlace(sig.dataUrl, { w: sig.w * s, h: sig.h * s }, { field });
  if (!field) toast('Click on the page to place your signature. Drag the corners to resize.');
}

async function insertImage() {
  const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif' });
  if (!file) return;
  if (!isImageFile(file)) return toast('Choose a PNG or JPG image', 'error');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const max = 2000;
    let dataUrl;
    let { naturalWidth: w, naturalHeight: h } = img;
    if ((file.type === 'image/png' || file.type === 'image/jpeg') && Math.max(w, h) <= max) {
      dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
    } else {
      const s = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * s);
      c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      dataUrl = c.toDataURL('image/png');
      w = c.width;
      h = c.height;
    }
    const fit = Math.min(1, 240 / (w * 0.75), 240 / (h * 0.75));
    annots.startPlace(dataUrl, { w: w * 0.75 * fit, h: h * 0.75 * fit });
    toast('Click on the page to place the image');
  } catch {
    toast('That image could not be read', 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- saving

async function buildOutput() {
  const { PDFDocument } = globalThis.PDFLib;
  const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) return buildRasterized();
  const flatten = $('flatten-forms').checked;
  const fr = fields.apply(doc, { flatten });
  const mapper = (i) => {
    const vp = state.pages[i].vp1;
    return { toPdf: (x, y) => vp.convertToPdfPoint(x, y), rotation: vp.rotation };
  };
  const ar = await applyAnnotations(doc, annots.serialize(), mapper);
  doc.setModificationDate(new Date());
  doc.setProducer('PDF Studio (local)');
  const bytes = await doc.save();
  return { bytes, warnings: warningsFrom(fr, ar) };
}

/** Encrypted PDFs can't be rewritten by pdf-lib: rebuild from rendered page images instead. */
async function buildRasterized() {
  const { PDFDocument } = globalThis.PDFLib;
  const out = await PDFDocument.create();
  for (const p of state.pages) {
    busy(`Encrypted PDF: rendering page ${p.index + 1} of ${state.pages.length}…`);
    const scale = Math.min(150 / 72, Math.sqrt(MAX_CANVAS_PIXELS / 2 / (p.w * p.h)));
    const vp = p.page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await p.page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = out.addPage([p.w, p.h]);
    page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
    c.width = c.height = 0;
  }
  const ar = await applyAnnotations(out, annots.serialize(), (i) => ({ toPdf: (x, y) => [x, state.pages[i].h - y], rotation: 0 }));
  const bytes = await out.save();
  const warnings = warningsFrom({ failed: [], replacedChars: 0 }, ar);
  warnings.unshift('This PDF is encrypted, so it was saved as page images (text is not selectable).');
  if (fields.dirty) warnings.push('Form values could not be written into an encrypted PDF.');
  return { bytes, warnings };
}

function warningsFrom(fr, ar) {
  const w = [];
  if (fr.failed?.length) w.push(`${fr.failed.length} form field${fr.failed.length === 1 ? '' : 's'} could not be filled.`);
  const replaced = (fr.replacedChars || 0) + (ar.replacedChars || 0);
  if (replaced) w.push(`${replaced} character${replaced === 1 ? '' : 's'} not supported by the standard PDF fonts were replaced with "?".`);
  return w;
}

async function download() {
  if (!state.pdf) return;
  if (annots.isEditingText()) annots.escape();
  busy('Preparing your PDF…');
  try {
    const { bytes, warnings } = await buildOutput();
    const suffix = annots.count || fields.dirty ? '-edited' : '';
    downloadBlob(bytes, `${baseName(state.name)}${suffix}.pdf`);
    state.dirty = false;
    $('dirty-dot').hidden = true;
    if (warnings.length) toast(warnings.join(' '), 'error', 8000);
    else toast('Saved. Your PDF is in your downloads.', 'success');
  } catch (err) {
    console.warn(err);
    toast('Could not save this PDF: ' + (err.message || err), 'error', 8000);
  } finally {
    busy(null);
  }
}

async function openInTools(e) {
  if (!state.pdf) return;
  e.preventDefault();
  try {
    let bytes = state.bytes;
    if (annots.count || fields.dirty) {
      busy('Applying your changes…');
      bytes = (await buildOutput()).bytes;
    }
    await openWithDocument('tools', bytes, state.name, '#organize');
  } catch (err) {
    toast('Could not open page tools: ' + err.message, 'error');
  } finally {
    busy(null);
  }
}

// ---------------------------------------------------------------- events

function bindUi() {
  $('btn-open').addEventListener('click', openFromPicker);
  $('btn-open-empty').addEventListener('click', openFromPicker);
  $('btn-save').addEventListener('click', download);
  $('btn-tools').addEventListener('click', openInTools);
  $('btn-shortcuts').addEventListener('click', () => $('keys-dialog').showModal());
  $('url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('url-input').value.trim();
    if (v) openUrl(/^[a-z]+:/i.test(v) ? v : 'https://' + v);
  });

  $('mode-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  document.querySelector('[data-action="image"]').addEventListener('click', insertImage);
  $('btn-signature').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!$('sig-menu').hidden) $('sig-menu').hidden = true;
    else openSigMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.sig-picker')) $('sig-menu').hidden = true;
  });

  $('color-custom').addEventListener('input', (e) => annots.setStyle({ color: e.target.value }));
  $('stroke-width').addEventListener('change', (e) => annots.setStyle({ width: +e.target.value }));
  $('font-size').addEventListener('change', (e) => annots.setStyle({ size: +e.target.value }));
  $('font-family').addEventListener('change', (e) => annots.setStyle({ font: e.target.value }));
  $('shape-fill').addEventListener('change', (e) => {
    annots.setStyle({ fill: e.target.checked });
    updateProps();
  });
  $('btn-undo').addEventListener('click', () => { annots.undo(); updateProps(); });
  $('btn-redo').addEventListener('click', () => { annots.redo(); updateProps(); });
  $('btn-delete').addEventListener('click', () => annots.deleteSelected());
  $('date-format').addEventListener('change', (e) => saveSettings({ dateFormat: e.target.value }));
  $('flatten-forms').addEventListener('change', (e) => saveSettings({ flatten: e.target.checked }));

  $('btn-sidebar').addEventListener('click', () => {
    state.sidebar = $('sidebar').hidden;
    $('sidebar').hidden = !state.sidebar;
    $('btn-sidebar').setAttribute('aria-pressed', String(state.sidebar));
    saveSettings({ sidebar: state.sidebar });
    if (state.zoomMode.startsWith('fit')) applyZoom(state.zoomMode);
    thumbLoop();
  });
  $('btn-prev').addEventListener('click', () => goToPage(state.current - 1));
  $('btn-next').addEventListener('click', () => goToPage(state.current + 1));
  $('page-input').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n)) goToPage(n - 1);
    else e.target.value = state.current + 1;
  });
  $('page-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-fit-width').addEventListener('click', () => applyZoom('fit-width'));
  $('btn-fit-page').addEventListener('click', () => applyZoom('fit-page'));
  $('zoom-select').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') return;
    applyZoom(v.startsWith('fit') ? v : +v);
  });
  $('btn-dark').addEventListener('click', () => setDark(!state.dark));

  $('btn-search').addEventListener('click', () => ($('searchbar').hidden ? openSearch() : closeSearch()));
  let searchTimer;
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 220);
  });
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (search.query !== $('search-input').value) runSearch();
      else setActiveMatch(search.active + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
  $('search-next').addEventListener('click', () => setActiveMatch(search.active + 1));
  $('search-prev').addEventListener('click', () => setActiveMatch(search.active - 1));
  $('search-close').addEventListener('click', closeSearch);
  $('search-case').addEventListener('change', runSearch);
  $('search-word').addEventListener('change', runSearch);

  let scrollRaf = 0;
  scroller.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updateCurrentPage();
    });
  }, { passive: true });

  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.pdf) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    applyZoom(clamp(state.scale * factor, MIN_SCALE, MAX_SCALE), { anchor: { x: e.clientX, y: e.clientY } });
  }, { passive: false });

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.pdf && state.zoomMode.startsWith('fit')) applyZoom(state.zoomMode);
    }, 120);
  }).observe(scroller);

  // Drag and drop a PDF anywhere.
  makeDropTarget(document.body, async (files) => {
    const pdf = files.find(isPdfFile);
    if (pdf) return openFile(pdf);
    if (files.some(isImageFile)) toast('To turn images into a PDF, use Page tools → Images to PDF', 'error');
    else toast('Drop a PDF file', 'error');
  }, { highlightEl: document.body });
  document.body.classList.remove('dragover');
  new MutationObserver(() => document.body.classList.toggle('dropping', document.body.classList.contains('dragover')))
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      flushDraft();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.dirty) flushDraft();
  });
}

function setDark(on) {
  state.dark = on;
  $('workspace').classList.toggle('dark-pages', on);
  $('btn-dark').setAttribute('aria-pressed', String(on));
  saveSettings({ dark: on });
}

const TOOL_KEYS = { v: 'select', h: 'highlight', u: 'underline', k: 'strike', p: 'ink', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', t: 'text', n: 'note', d: 'date' };

function onKey(e) {
  const t = e.target;
  const typing = t.closest?.('input, textarea, select, [contenteditable="true"]');
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'o') {
    e.preventDefault();
    return openFromPicker();
  }
  if (mod && key === 's') {
    e.preventDefault();
    return download();
  }
  if (!state.pdf) return;
  if (mod && key === 'f') {
    e.preventDefault();
    return openSearch();
  }
  if (mod && (key === '=' || key === '+')) {
    e.preventDefault();
    return zoomBy(1.25);
  }
  if (mod && key === '-') {
    e.preventDefault();
    return zoomBy(0.8);
  }
  if (mod && key === '0') {
    e.preventDefault();
    return applyZoom(1);
  }
  if (typing) return;
  if (document.querySelector('dialog[open]')) return;
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) annots.redo();
    else annots.undo();
    return updateProps();
  }
  if (mod && key === 'y') {
    e.preventDefault();
    annots.redo();
    return updateProps();
  }
  if (e.key === 'Escape') {
    if (!$('sig-menu').hidden) {
      $('sig-menu').hidden = true;
      return;
    }
    if (annots.escape()) return;
    if (!$('searchbar').hidden) closeSearch();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && annots.selected) {
    e.preventDefault();
    annots.deleteSelected();
    return;
  }
  if (e.key.startsWith('Arrow') && annots.selected) {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (annots.nudge(...d)) e.preventDefault();
    return;
  }
  if (e.key === 'Home' && !mod) {
    e.preventDefault();
    return goToPage(0);
  }
  if (e.key === 'End' && !mod) {
    e.preventDefault();
    return goToPage(state.pages.length - 1);
  }
  if ((e.key === 'PageDown' || e.key === 'PageUp') && state.zoomMode === 'fit-page') {
    e.preventDefault();
    return goToPage(state.current + (e.key === 'PageDown' ? 1 : -1));
  }
  if (e.key === '?') {
    e.preventDefault();
    return $('keys-dialog').showModal();
  }
  if (!mod && !e.altKey && TOOL_KEYS[key]) {
    e.preventDefault();
    setTool(TOOL_KEYS[key]);
  }
}

// ---------------------------------------------------------------- start

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

async function init() {
  await loadSettings();
  annots.loadStyles(state.settings.styles);
  state.sidebar = state.settings.sidebar !== false;
  if (state.settings.dark) setDark(true);
  $('flatten-forms').checked = !!state.settings.flatten;
  initDateFormats();
  bindUi();
  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  const key = params.get('doc');
  if (key) {
    const entry = await takeHandoff(key).catch(() => null);
    history.replaceState(null, '', location.pathname);
    if (entry) return openBytes(entry.bytes, entry.name);
    toast('That document is no longer available. Open it again.', 'error');
  } else if (url) {
    return openUrl(url);
  }
}

init();
