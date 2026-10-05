// PDF Studio page tools: merge, split, organize, images to PDF, compress. Everything runs in this tab.
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import {
  downloadBlob, formatBytes, baseName, isPdfBytes, readFile, isPdfFile, isImageFile, toast, busy,
  makeDropTarget, pickFiles, takeHandoff, openWithDocument, parseRanges
} from '../lib/common.js';
import * as ops from '../lib/pdfops.js';
import { makeZip } from '../lib/zip.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const TOOLS = ['merge', 'split', 'organize', 'images', 'compress'];
let uid = 0;
const nextId = () => ++uid;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#t-' + name);
  svg.append(use);
  return svg;
}

function iconButton(name, label, onclick, cls = 'btn icon small') {
  const b = el('button', { class: cls, type: 'button', title: label, 'aria-label': label, onclick });
  b.append(icon(name));
  return b;
}

/** Load a PDF file, rejecting non-PDF and password-protected files with a readable message. */
async function loadPdfFile(file) {
  const bytes = file.bytes || (await readFile(file));
  if (!isPdfBytes(bytes)) throw new Error(`${file.name} is not a PDF`);
  let info;
  try {
    info = await ops.inspect(bytes);
  } catch (err) {
    throw new Error(`${file.name} could not be read (${err.message})`);
  }
  if (info.encrypted) throw new Error(`${file.name} is password-protected. Remove the password first.`);
  return { id: nextId(), name: file.name, size: bytes.length, bytes, pages: info.pages };
}

async function withBusy(message, fn) {
  busy(message);
  // Let the overlay paint before heavy synchronous work starts.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return await fn();
  } catch (err) {
    console.warn(err);
    toast(err.message || String(err), 'error', 5000);
    return undefined;
  } finally {
    busy(null);
  }
}

function openPdfJs(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

/** Generic drag-to-reorder for a list of elements carrying data-id. */
function makeSortable(container, itemSelector, { getOrder, setOrder, horizontal = false }) {
  let dragId = null;
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest?.(itemSelector);
    if (!item) return;
    dragId = item.dataset.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-pdf-studio-item', dragId);
  });
  const clear = () => container.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  const sideOf = (item, e) => {
    const r = item.getBoundingClientRect();
    return horizontal ? (e.clientX < r.left + r.width / 2 ? 'before' : 'after') : (e.clientY < r.top + r.height / 2 ? 'before' : 'after');
  };
  container.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    const item = e.target.closest?.(itemSelector);
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clear();
    if (item && item.dataset.id !== dragId) item.classList.add('drop-' + sideOf(item, e));
  });
  container.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const item = e.target.closest?.(itemSelector);
    clear();
    if (!item || item.dataset.id === dragId) return;
    const order = getOrder().filter((id) => id !== dragId);
    let at = order.indexOf(item.dataset.id);
    if (sideOf(item, e) === 'after') at++;
    order.splice(at, 0, dragId);
    setOrder(order, dragId);
  });
  container.addEventListener('dragend', () => {
    container.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
    clear();
    dragId = null;
  });
}

function moveInArray(arr, index, delta) {
  const j = index + delta;
  if (index < 0 || j < 0 || j >= arr.length) return false;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  return true;
}

function pickPdfs(multiple = true) {
  return pickFiles({ accept: 'application/pdf,.pdf', multiple });
}

function rejectNonPdf(files) {
  const pdfs = files.filter(isPdfFile);
  if (pdfs.length < files.length) toast(`${files.length - pdfs.length} file(s) skipped: only PDFs can be added here`, 'error');
  return pdfs;
}

// ================================================================ navigation

function showTool(name, { updateHash = true } = {}) {
  if (!TOOLS.includes(name)) name = 'merge';
  document.querySelectorAll('#tool-nav button').forEach((b) => {
    if (b.dataset.tool === name) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  if (updateHash && location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  const title = document.querySelector(`.panel[data-panel="${name}"] h1`)?.textContent || 'Page tools';
  document.title = `${title} – PDF Studio`;
}

const currentTool = () => document.querySelector('#tool-nav button[aria-current="true"]')?.dataset.tool || 'merge';

// ================================================================ merge

const merge = { files: [] };

async function mergeAdd(files) {
  files = rejectNonPdf(files);
  if (!files.length) return;
  await withBusy('Reading files…', async () => {
    for (const f of files) {
      try {
        merge.files.push({ ...(await loadPdfFile(f)), range: '' });
      } catch (err) {
        toast(err.message, 'error', 5000);
      }
    }
  });
  renderMerge();
}

function renderMerge() {
  const list = $('merge-list');
  list.replaceChildren();
  merge.files.forEach((f, i) => {
    const rangeInput = el('input', {
      type: 'text', value: f.range, placeholder: `All (1-${f.pages})`, 'aria-label': `Pages to include from ${f.name}`,
      title: 'Pages to include, e.g. 1-3, 5. Leave empty for all pages.',
      oninput: (e) => {
        f.range = e.target.value;
        validateMergeRow(f, row);
        updateMergeSummary();
      }
    });
    const row = el('li', { class: 'file-row', draggable: 'true', 'data-id': String(f.id) },
      el('span', { class: 'grip', 'aria-hidden': 'true', text: '⋮⋮' }),
      el('span', { class: 'name', title: f.name, text: `${i + 1}. ${f.name}` }),
      el('span', { class: 'meta', text: `${f.pages} page${f.pages === 1 ? '' : 's'} · ${formatBytes(f.size)}` }),
      rangeInput,
      el('span', { class: 'err', role: 'alert' }),
      iconButton('up', 'Move up', () => { if (moveInArray(merge.files, i, -1)) renderMerge(); }),
      iconButton('down', 'Move down', () => { if (moveInArray(merge.files, i, 1)) renderMerge(); }),
      iconButton('trash', `Remove ${f.name}`, () => { merge.files.splice(i, 1); renderMerge(); }, 'btn icon small remove')
    );
    row.querySelector('[aria-label="Move up"]').disabled = i === 0;
    row.querySelector('[aria-label="Move down"]').disabled = i === merge.files.length - 1;
    validateMergeRow(f, row);
    list.append(row);
  });
  $('merge-drop').hidden = merge.files.length > 0;
  updateMergeSummary();
}

function mergeSelection(f) {
  if (!f.range.trim()) return null;
  return parseRanges(f.range, f.pages).flat();
}

function validateMergeRow(f, row) {
  const err = row.querySelector('.err');
  try {
    mergeSelection(f);
    err.textContent = '';
    row.querySelector('input').removeAttribute('aria-invalid');
  } catch (e) {
    err.textContent = e.message;
    row.querySelector('input').setAttribute('aria-invalid', 'true');
  }
}

function updateMergeSummary() {
  let total = 0;
  let valid = true;
  for (const f of merge.files) {
    try {
      const sel = mergeSelection(f);
      total += sel ? sel.length : f.pages;
    } catch {
      valid = false;
    }
  }
  $('merge-go').disabled = merge.files.length < 1 || !valid || (merge.files.length < 2 && !merge.files.some((f) => f.range.trim()));
  $('merge-summary').textContent = merge.files.length
    ? `${merge.files.length} file${merge.files.length === 1 ? '' : 's'}, ${valid ? total : '?'} pages in the result.` + (merge.files.length < 2 ? ' Add at least one more PDF to merge.' : '')
    : '';
}

async function doMerge() {
  const out = await withBusy('Merging…', async () => {
    const selections = merge.files.map(mergeSelection);
    return ops.merge(merge.files.map((f) => f.bytes), selections.map((s) => s || undefined));
  });
  if (!out) return;
  downloadBlob(out, `${baseName(merge.files[0].name)}-merged.pdf`);
  toast(`Merged into ${formatBytes(out.length)}`, 'success');
}

// ================================================================ split

const split = { file: null };

async function splitLoad(files) {
  files = rejectNonPdf(files);
  if (!files.length) return;
  const f = await withBusy('Reading file…', () => loadPdfFile(files[0]));
  if (!f) return;
  split.file = f;
  $('split-drop').hidden = true;
  $('split-config').hidden = false;
  $('split-file').replaceChildren(el('span', { text: f.name }), el('span', { class: 'meta', text: `${f.pages} pages · ${formatBytes(f.size)}` }),
    el('button', { class: 'btn small ghost', type: 'button', text: 'Change', onclick: async () => splitLoad(await pickPdfs(false)) }));
  $('split-ranges').placeholder = f.pages > 1 ? `1-${Math.ceil(f.pages / 2)}, ${Math.ceil(f.pages / 2) + 1}-${f.pages}` : '1';
  $('split-every').max = String(f.pages);
  updateSplitPreview();
}

function splitMode() {
  return document.querySelector('input[name="split-mode"]:checked').value;
}

/** Returns { groups, single } or throws with a readable error. */
function splitPlan() {
  const f = split.file;
  const mode = splitMode();
  if (mode === 'ranges') return { groups: parseRanges($('split-ranges').value, f.pages), single: false };
  if (mode === 'every') {
    const n = parseInt($('split-every').value, 10);
    if (!(n >= 1)) throw new Error('Enter how many pages each file should have');
    return { groups: ops.chunkIndices(f.pages, n), single: false };
  }
  return { groups: [parseRanges($('split-extract').value, f.pages).flat()], single: true };
}

function updateSplitPreview() {
  if (!split.file) return;
  const out = $('split-preview');
  try {
    const { groups, single } = splitPlan();
    const pages = groups.reduce((s, g) => s + g.length, 0);
    out.textContent = single
      ? `One PDF with ${pages} page${pages === 1 ? '' : 's'}.`
      : `${groups.length} PDF${groups.length === 1 ? '' : 's'}: ` + groups.slice(0, 8).map((g) => describeGroup(g)).join(', ') + (groups.length > 8 ? '…' : '') + (groups.length > 1 ? ' (downloaded as a .zip)' : '');
    out.style.color = '';
    $('split-go').disabled = false;
  } catch (err) {
    out.textContent = err.message;
    out.style.color = 'var(--danger)';
    $('split-go').disabled = true;
  }
}

function describeGroup(g) {
  if (g.length === 1) return `p${g[0] + 1}`;
  const contiguous = g.every((v, i) => !i || v === g[i - 1] + 1);
  return contiguous ? `p${g[0] + 1}-${g[g.length - 1] + 1}` : `${g.length} pages`;
}

async function doSplit() {
  const f = split.file;
  let plan;
  try {
    plan = splitPlan();
  } catch (err) {
    return toast(err.message, 'error');
  }
  const base = baseName(f.name);
  const outs = await withBusy('Splitting…', () => ops.splitGroups(f.bytes, plan.groups));
  if (!outs) return;
  if (outs.length === 1) {
    downloadBlob(outs[0], plan.single ? `${base}-extract.pdf` : `${base}-${describeGroup(plan.groups[0]).replace(/^p/, 'pages-')}.pdf`);
  } else {
    const width = String(outs.length).length;
    const zip = makeZip(outs.map((bytes, i) => ({
      name: `${base}-part${String(i + 1).padStart(width, '0')}-${describeGroup(plan.groups[i]).replace(/^p/, 'p').replace(/ /g, '')}.pdf`,
      bytes
    })));
    downloadBlob(zip, `${base}-split.zip`, 'application/zip');
  }
  toast(`Created ${outs.length} PDF${outs.length === 1 ? '' : 's'}`, 'success');
}

// ================================================================ organize

const org = {
  sources: [], // { name, bytes, pdf (pdf.js doc), sizes: [[w,h]], rotations: [deg] }
  items: [], // { id, src, page, rotate } | { id, blank: true, size }
  selected: new Set(),
  anchor: null,
  undo: [],
  initial: [],
  thumbs: new Map(), // key -> canvas
  observer: null
};

async function orgAdd(files) {
  files = rejectNonPdf(files);
  if (!files.length) return;
  await withBusy('Reading pages…', async () => {
    for (const f of files) {
      try {
        const info = await loadPdfFile(f);
        const pdf = await openPdfJs(info.bytes);
        const sizes = [];
        const rotations = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const p = await pdf.getPage(i);
          const vp = p.getViewport({ scale: 1, rotation: 0 });
          sizes.push([vp.width, vp.height]);
          rotations.push(p.rotate);
        }
        const src = org.sources.push({ name: info.name, bytes: info.bytes, pdf, sizes, rotations }) - 1;
        if (org.items.length) pushUndo();
        for (let i = 0; i < pdf.numPages; i++) org.items.push({ id: String(nextId()), src, page: i, rotate: 0 });
      } catch (err) {
        toast(err.message, 'error', 5000);
      }
    }
  });
  org.initial = cloneItems(org.items);
  renderOrg();
}

const cloneItems = (items) => items.map((it) => ({ ...it }));

function pushUndo() {
  org.undo.push({ items: cloneItems(org.items), selected: [...org.selected] });
  if (org.undo.length > 100) org.undo.shift();
  $('org-undo').disabled = false;
}

function orgUndo() {
  const s = org.undo.pop();
  if (!s) return;
  org.items = s.items;
  org.selected = new Set(s.selected);
  renderOrg();
}

function orgReset() {
  if (!org.initial.length) return;
  pushUndo();
  org.items = cloneItems(org.initial);
  org.selected.clear();
  renderOrg();
}

function itemLabel(it) {
  if (it.blank) return 'Blank page';
  return `Page ${it.page + 1}` + (org.sources.length > 1 ? ` of ${org.sources[it.src].name}` : '');
}

function renderOrg() {
  const grid = $('org-grid');
  const focusedId = document.activeElement?.closest?.('.org-page')?.dataset.id;
  org.observer?.disconnect();
  org.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      org.observer.unobserve(e.target);
      drawThumb(e.target);
    }
  }, { root: null, rootMargin: '400px' });
  grid.replaceChildren();
  org.items.forEach((it, i) => {
    const frame = el('div', { class: 'frame' + (it.blank ? ' blank' : '') });
    if (it.blank) frame.textContent = 'Blank';
    const tools = el('div', { class: 'pagetools' },
      iconButton('rotl', 'Rotate left', (e) => { e.stopPropagation(); rotateItems([it.id], -90); }, ''),
      iconButton('rotr', 'Rotate right', (e) => { e.stopPropagation(); rotateItems([it.id], 90); }, ''),
      iconButton('trash', 'Delete page', (e) => { e.stopPropagation(); deleteItems([it.id]); }, ''));
    tools.querySelectorAll('button').forEach((b) => (b.tabIndex = -1));
    const rot = it.blank ? 0 : ((it.rotate % 360) + 360) % 360;
    const card = el('div', {
      class: 'org-page' + (org.selected.has(it.id) ? ' selected' : ''),
      draggable: 'true', tabindex: '0', role: 'option', 'data-id': it.id,
      'aria-selected': String(org.selected.has(it.id)),
      'aria-label': `${i + 1}: ${itemLabel(it)}${rot ? `, rotated ${rot} degrees` : ''}`
    },
    frame,
    rot ? el('span', { class: 'badge', text: `${rot}°` }) : null,
    tools,
    el('div', { class: 'cap' }, el('strong', { text: String(i + 1) }),
      it.blank ? el('span', { class: 'src', text: 'blank' }) : el('span', { class: 'src', title: org.sources[it.src].name, text: org.sources.length > 1 ? `${org.sources[it.src].name} · p${it.page + 1}` : `p${it.page + 1}` })));
    grid.append(card);
    if (!it.blank) org.observer.observe(card);
  });
  const has = org.items.length > 0;
  $('org-drop').hidden = has;
  $('org-bar').hidden = !has;
  $('org-go').disabled = !has;
  $('org-open-viewer').disabled = !has;
  $('org-undo').disabled = !org.undo.length;
  const n = org.selected.size;
  $('org-count').textContent = `${org.items.length} page${org.items.length === 1 ? '' : 's'}` + (n ? `, ${n} selected` : '');
  for (const id of ['org-rot-l', 'org-rot-r', 'org-move-up', 'org-move-down', 'org-extract', 'org-del']) $(id).disabled = !n;
  if (focusedId) grid.querySelector(`[data-id="${focusedId}"]`)?.focus();
}

async function drawThumb(card) {
  const it = org.items.find((x) => x.id === card.dataset.id);
  if (!it || it.blank) return;
  const s = org.sources[it.src];
  const rotation = (((s.rotations[it.page] + it.rotate) % 360) + 360) % 360;
  const key = `${it.src}:${it.page}:${rotation}`;
  let canvas = org.thumbs.get(key);
  if (!canvas) {
    try {
      const page = await s.pdf.getPage(it.page + 1);
      const base = page.getViewport({ scale: 1, rotation });
      const scale = Math.min(240 / base.width, 300 / base.height) * Math.min(2, devicePixelRatio || 1);
      const vp = page.getViewport({ scale, rotation });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      org.thumbs.set(key, canvas);
    } catch (err) {
      console.warn('thumbnail failed', err);
      return;
    }
  }
  const frame = card.querySelector('.frame');
  if (!frame || !card.isConnected) return;
  // A canvas can only live in one place; copy cached thumbnails.
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d').drawImage(canvas, 0, 0);
  copy.setAttribute('aria-hidden', 'true');
  frame.replaceChildren(copy);
}

function selectedIds() {
  return org.items.filter((it) => org.selected.has(it.id)).map((it) => it.id);
}

function rotateItems(ids, delta) {
  if (!ids.length) return;
  pushUndo();
  const set = new Set(ids);
  for (const it of org.items) if (set.has(it.id) && !it.blank) it.rotate = (((it.rotate + delta) % 360) + 360) % 360;
  renderOrg();
}

function deleteItems(ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  if (org.items.every((it) => set.has(it.id))) return toast('Keep at least one page. Use Reset to start over.', 'error');
  pushUndo();
  const firstIndex = org.items.findIndex((it) => set.has(it.id));
  org.items = org.items.filter((it) => !set.has(it.id));
  ids.forEach((id) => org.selected.delete(id));
  renderOrg();
  const next = org.items[Math.min(firstIndex, org.items.length - 1)];
  if (next) $('org-grid').querySelector(`[data-id="${next.id}"]`)?.focus();
  toast(`Deleted ${ids.length} page${ids.length === 1 ? '' : 's'}`);
}

function moveSelected(delta) {
  const ids = selectedIds();
  if (!ids.length) return;
  const items = org.items;
  const sel = new Set(ids);
  const indices = items.map((it, i) => (sel.has(it.id) ? i : -1)).filter((i) => i >= 0);
  if ((delta < 0 && indices[0] === 0) || (delta > 0 && indices[indices.length - 1] === items.length - 1)) return;
  pushUndo();
  const order = delta < 0 ? indices : indices.reverse();
  for (const i of order) moveInArray(items, i, delta);
  renderOrg();
}

function insertBlank() {
  pushUndo();
  const ids = selectedIds();
  let at = org.items.length;
  if (ids.length) at = org.items.findIndex((it) => it.id === ids[ids.length - 1]) + 1;
  const ref = org.items[Math.max(0, at - 1)];
  const size = refSize(ref);
  const blank = { id: String(nextId()), blank: true, size };
  org.items.splice(at, 0, blank);
  org.selected = new Set([blank.id]);
  renderOrg();
}

function refSize(it) {
  if (!it) return ops.PAGE_SIZES.a4;
  if (it.blank) return it.size;
  const s = org.sources[it.src];
  const [w, h] = s.sizes[it.page];
  const rot = (((s.rotations[it.page] + it.rotate) % 360) + 360) % 360;
  return rot % 180 ? [h, w] : [w, h];
}

function planFor(items) {
  return items.map((it) => (it.blank ? { blank: true, size: it.size } : { src: it.src, page: it.page, rotate: it.rotate }));
}

async function buildOrg(items) {
  return withBusy('Building PDF…', () => ops.buildFromPlan(org.sources.map((s) => s.bytes), planFor(items)));
}

const orgName = (suffix) => `${baseName(org.sources[0]?.name)}-${suffix}.pdf`;

async function orgSave() {
  const out = await buildOrg(org.items);
  if (!out) return;
  downloadBlob(out, orgName('organized'));
  toast(`Saved ${org.items.length} pages`, 'success');
}

async function orgExtract() {
  const items = org.items.filter((it) => org.selected.has(it.id));
  if (!items.length) return;
  const out = await buildOrg(items);
  if (!out) return;
  downloadBlob(out, orgName('extract'));
  toast(`Extracted ${items.length} page${items.length === 1 ? '' : 's'}`, 'success');
}

async function orgOpenViewer() {
  const out = await buildOrg(org.items);
  if (!out) return;
  try {
    await openWithDocument('viewer', out, orgName('organized'));
  } catch (err) {
    toast('Could not open the viewer: ' + err.message, 'error');
  }
}

function orgSelectWhere(pred) {
  org.selected = new Set(org.items.filter((it, i) => pred(it, i)).map((it) => it.id));
  renderOrg();
}

function onOrgClick(e) {
  const card = e.target.closest('.org-page');
  if (!card) return;
  const id = card.dataset.id;
  if (e.shiftKey && org.anchor) {
    const a = org.items.findIndex((it) => it.id === org.anchor);
    const b = org.items.findIndex((it) => it.id === id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!(e.ctrlKey || e.metaKey)) org.selected.clear();
    for (let i = lo; i <= hi; i++) org.selected.add(org.items[i].id);
  } else if (e.ctrlKey || e.metaKey) {
    if (org.selected.has(id)) org.selected.delete(id);
    else org.selected.add(id);
    org.anchor = id;
  } else {
    org.selected = org.selected.size === 1 && org.selected.has(id) ? new Set() : new Set([id]);
    org.anchor = id;
  }
  renderOrg();
  $('org-grid').querySelector(`[data-id="${id}"]`)?.focus();
}

function gridColumns() {
  const grid = $('org-grid');
  const cards = [...grid.children];
  if (cards.length < 2) return 1;
  const top = cards[0].offsetTop;
  const n = cards.findIndex((c) => c.offsetTop !== top);
  return n < 0 ? cards.length : n;
}

function onOrgKey(e) {
  const card = e.target.closest?.('.org-page');
  if (!card) return;
  const idx = org.items.findIndex((it) => it.id === card.dataset.id);
  const mod = e.ctrlKey || e.metaKey;
  const cols = gridColumns();
  const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
  if (e.key in deltas) {
    e.preventDefault();
    const d = deltas[e.key];
    if (mod || e.altKey) {
      if (!org.selected.has(card.dataset.id)) org.selected = new Set([card.dataset.id]);
      moveSelected(Math.sign(d) * (e.key === 'ArrowUp' || e.key === 'ArrowDown' ? 1 : 1) * (Math.abs(d) === 1 ? 1 : 1));
      return;
    }
    const j = Math.min(Math.max(idx + d, 0), org.items.length - 1);
    const next = org.items[j];
    if (e.shiftKey) {
      org.selected.add(card.dataset.id);
      org.selected.add(next.id);
      renderOrg();
    }
    $('org-grid').querySelector(`[data-id="${next.id}"]`)?.focus();
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    const id = card.dataset.id;
    if (org.selected.has(id)) org.selected.delete(id);
    else org.selected.add(id);
    org.anchor = id;
    renderOrg();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteItems(org.selected.size ? selectedIds() : [card.dataset.id]);
  } else if (e.key.toLowerCase() === 'r' && !mod) {
    e.preventDefault();
    rotateItems(org.selected.size ? selectedIds() : [card.dataset.id], e.shiftKey ? -90 : 90);
  }
}

function initOrganizeDrag() {
  const grid = $('org-grid');
  makeSortable(grid, '.org-page', {
    horizontal: true,
    getOrder: () => org.items.map((it) => it.id),
    setOrder: (order, draggedId) => {
      pushUndo();
      const byId = new Map(org.items.map((it) => [it.id, it]));
      // Dragging a selected page moves the whole selection as a block.
      if (org.selected.has(draggedId) && org.selected.size > 1) {
        const block = org.items.filter((it) => org.selected.has(it.id)).map((it) => it.id);
        const at = order.indexOf(draggedId);
        const before = order.slice(0, at).filter((id) => !org.selected.has(id));
        const after = order.slice(at + 1).filter((id) => !org.selected.has(id));
        order = [...before, ...block, ...after];
      }
      org.items = order.map((id) => byId.get(id));
      renderOrg();
    }
  });
}

// ================================================================ images

const imgs = { items: [] }; // { id, name, url, bytes, type, width, height }

function readUint16(view, off, little) {
  return view.getUint16(off, little);
}

/** EXIF orientation of a JPEG (1 = normal). */
function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 < v.byteLength && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      const n = readUint16(v, ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > v.byteLength) break;
        if (readUint16(v, e, little) === 0x0112) return readUint16(v, e + 8, little);
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

async function reencode(file, type) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, bmp.width, bmp.height);
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.92 } : { type });
  return new Uint8Array(await blob.arrayBuffer());
}

async function prepareImage(file) {
  let bytes = await readFile(file);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  let type;
  if (isJpg) {
    type = 'jpg';
    // pdf-lib ignores EXIF rotation; bake it into the pixels so phone photos come out upright.
    if (jpegOrientation(bytes) > 1) bytes = await reencode(file, 'image/jpeg');
  } else if (isPng) {
    type = 'png';
  } else {
    // WebP, GIF (first frame), BMP and others the browser can decode become PNG.
    bytes = await reencode(file, 'image/png');
    type = 'png';
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: type === 'png' ? 'image/png' : 'image/jpeg' }));
  return { id: String(nextId()), name: file.name, url, bytes, type };
}

async function imgAdd(files) {
  const images = files.filter(isImageFile);
  if (images.length < files.length) toast(`${files.length - images.length} file(s) skipped: only images can be added here`, 'error');
  if (!images.length) return;
  await withBusy('Reading images…', async () => {
    for (const f of images) {
      try {
        imgs.items.push(await prepareImage(f));
      } catch (err) {
        console.warn(err);
        toast(`${f.name} could not be read as an image`, 'error');
      }
    }
  });
  renderImages();
}

function renderImages() {
  const grid = $('img-grid');
  grid.replaceChildren();
  imgs.items.forEach((it, i) => {
    const card = el('div', { class: 'img-item', draggable: 'true', 'data-id': it.id, tabindex: '0', 'aria-label': `${i + 1}: ${it.name}` },
      el('div', { class: 'frame' }, el('img', { src: it.url, alt: '', draggable: 'false' })),
      el('div', { class: 'cap' },
        el('strong', { text: String(i + 1) }),
        el('span', { class: 'src', title: it.name, text: it.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px' }),
        iconButton('up', 'Move earlier', () => { if (moveInArray(imgs.items, i, -1)) renderImages(); }),
        iconButton('down', 'Move later', () => { if (moveInArray(imgs.items, i, 1)) renderImages(); }),
        iconButton('trash', `Remove ${it.name}`, () => {
          URL.revokeObjectURL(it.url);
          imgs.items.splice(i, 1);
          renderImages();
        }, 'btn icon small remove')));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        URL.revokeObjectURL(it.url);
        imgs.items.splice(i, 1);
        renderImages();
      }
    });
    grid.append(card);
  });
  const has = imgs.items.length > 0;
  $('img-drop').hidden = has;
  $('img-options').hidden = !has;
  $('img-go').disabled = !has;
}

async function doImages() {
  const opts = {
    pageSize: $('img-size').value,
    orientation: $('img-orient').value,
    margin: Number($('img-margin').value)
  };
  const out = await withBusy('Creating PDF…', () => ops.imagesToPdf(imgs.items.map((it) => ({ bytes: it.bytes, type: it.type })), opts));
  if (!out) return;
  const name = imgs.items.length === 1 ? `${imgs.items[0].name.replace(/\.[^.]+$/, '')}.pdf` : 'images.pdf';
  downloadBlob(out, name);
  toast(`Created a ${imgs.items.length}-page PDF (${formatBytes(out.length)})`, 'success');
}

// ================================================================ compress

const cmp = { file: null };

async function cmpLoad(files) {
  files = rejectNonPdf(files);
  if (!files.length) return;
  const f = await withBusy('Reading file…', () => loadPdfFile(files[0]));
  if (!f) return;
  cmp.file = f;
  $('cmp-drop').hidden = true;
  $('cmp-config').hidden = false;
  $('cmp-result').hidden = true;
  $('cmp-go').disabled = false;
  $('cmp-file').replaceChildren(el('span', { text: f.name }), el('span', { class: 'meta', text: `${f.pages} pages · ${formatBytes(f.size)}` }),
    el('button', { class: 'btn small ghost', type: 'button', text: 'Change', onclick: async () => cmpLoad(await pickPdfs(false)) }));
}

async function rasterize(bytes, { dpi, quality, gray }) {
  const pdf = await openPdfJs(bytes);
  const pages = [];
  const MAX_PIXELS = 16_000_000;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      busy(`Rasterizing page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      let scale = dpi / 72;
      const px = base.width * base.height * scale * scale;
      if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: gray });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (gray) {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = data.data;
        for (let k = 0; k < d.length; k += 4) {
          const y = (d[k] * 299 + d[k + 1] * 587 + d[k + 2] * 114) / 1000;
          d[k] = d[k + 1] = d[k + 2] = y;
        }
        ctx.putImageData(data, 0, 0);
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: base.width, height: base.height });
      page.cleanup();
      canvas.width = canvas.height = 0;
    }
  } finally {
    pdf.destroy();
  }
  busy('Writing PDF…');
  return ops.pdfFromJpegPages(pages);
}

async function doCompress() {
  const f = cmp.file;
  const mode = document.querySelector('input[name="cmp-mode"]:checked').value;
  const opts = { dpi: Number($('cmp-dpi').value), quality: Number($('cmp-quality').value) / 100, gray: $('cmp-gray').checked };
  const out = await withBusy('Compressing…', () => (mode === 'raster' ? rasterize(f.bytes, opts) : ops.compressResave(f.bytes)));
  if (!out) return;
  const result = $('cmp-result');
  result.hidden = false;
  const saved = f.size - out.length;
  const pct = Math.round((saved / f.size) * 100);
  const name = `${baseName(f.name)}-compressed.pdf`;
  if (saved <= 0) {
    result.replaceChildren(
      el('p', { style: 'margin:0 0 8px', text: `The file is already compact: the result would be ${formatBytes(out.length)} versus ${formatBytes(f.size)} now.` }),
      el('p', { class: 'muted', style: 'margin:0 0 8px', text: mode === 'raster' ? 'Try a lower resolution or JPEG quality.' : 'Try "Rasterize pages" for a much smaller file.' }),
      el('button', { class: 'btn small', type: 'button', text: 'Download anyway', onclick: () => downloadBlob(out, name) }));
    return;
  }
  result.replaceChildren(
    el('p', { style: 'margin:0 0 8px' }, `${formatBytes(f.size)} → ${formatBytes(out.length)} `, el('strong', { text: `(${pct}% smaller)` })),
    el('button', { class: 'btn small', type: 'button', text: 'Download again', onclick: () => downloadBlob(out, name) }));
  downloadBlob(out, name);
}

// ================================================================ wiring

function bind() {
  document.querySelectorAll('#tool-nav button').forEach((b) => b.addEventListener('click', () => showTool(b.dataset.tool)));
  $('tool-nav').addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const btns = [...document.querySelectorAll('#tool-nav button')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const j = (i + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + btns.length) % btns.length;
    btns[j].focus();
    showTool(btns[j].dataset.tool);
  });
  window.addEventListener('hashchange', () => showTool(location.hash.slice(1), { updateHash: false }));

  // Merge
  const mergePick = async () => mergeAdd(await pickPdfs(true));
  $('merge-add').addEventListener('click', mergePick);
  $('merge-add2').addEventListener('click', mergePick);
  $('merge-go').addEventListener('click', doMerge);
  makeSortable($('merge-list'), '.file-row', {
    getOrder: () => merge.files.map((f) => String(f.id)),
    setOrder: (order) => {
      const byId = new Map(merge.files.map((f) => [String(f.id), f]));
      merge.files = order.map((id) => byId.get(id));
      renderMerge();
    }
  });

  // Split
  const splitPick = async () => splitLoad(await pickPdfs(false));
  $('split-pick').addEventListener('click', splitPick);
  $('split-pick2').addEventListener('click', splitPick);
  $('split-go').addEventListener('click', doSplit);
  document.querySelectorAll('input[name="split-mode"]').forEach((r) => r.addEventListener('change', updateSplitPreview));
  const focusMode = (value) => () => {
    document.querySelector(`input[name="split-mode"][value="${value}"]`).checked = true;
    updateSplitPreview();
  };
  $('split-ranges').addEventListener('input', focusMode('ranges'));
  $('split-every').addEventListener('input', focusMode('every'));
  $('split-extract').addEventListener('input', focusMode('single'));

  // Organize
  const orgPick = async () => orgAdd(await pickPdfs(true));
  $('org-add').addEventListener('click', orgPick);
  $('org-add2').addEventListener('click', orgPick);
  $('org-go').addEventListener('click', orgSave);
  $('org-open-viewer').addEventListener('click', orgOpenViewer);
  $('org-select-all').addEventListener('click', () => orgSelectWhere(() => true));
  $('org-select-none').addEventListener('click', () => orgSelectWhere(() => false));
  $('org-select-odd').addEventListener('click', () => orgSelectWhere((_, i) => i % 2 === 0));
  $('org-select-even').addEventListener('click', () => orgSelectWhere((_, i) => i % 2 === 1));
  $('org-rot-l').addEventListener('click', () => rotateItems(selectedIds(), -90));
  $('org-rot-r').addEventListener('click', () => rotateItems(selectedIds(), 90));
  $('org-move-up').addEventListener('click', () => moveSelected(-1));
  $('org-move-down').addEventListener('click', () => moveSelected(1));
  $('org-blank').addEventListener('click', insertBlank);
  $('org-extract').addEventListener('click', orgExtract);
  $('org-del').addEventListener('click', () => deleteItems(selectedIds()));
  $('org-undo').addEventListener('click', orgUndo);
  $('org-reset').addEventListener('click', orgReset);
  $('org-grid').setAttribute('role', 'listbox');
  $('org-grid').setAttribute('aria-multiselectable', 'true');
  $('org-grid').setAttribute('aria-label', 'Pages');
  $('org-grid').addEventListener('click', onOrgClick);
  $('org-grid').addEventListener('keydown', onOrgKey);
  initOrganizeDrag();

  // Images
  const imgPick = async () => imgAdd(await pickFiles({ accept: 'image/*', multiple: true }));
  $('img-add').addEventListener('click', imgPick);
  $('img-add2').addEventListener('click', imgPick);
  $('img-go').addEventListener('click', doImages);
  makeSortable($('img-grid'), '.img-item', {
    horizontal: true,
    getOrder: () => imgs.items.map((it) => it.id),
    setOrder: (order) => {
      const byId = new Map(imgs.items.map((it) => [it.id, it]));
      imgs.items = order.map((id) => byId.get(id));
      renderImages();
    }
  });

  // Compress
  const cmpPick = async () => cmpLoad(await pickPdfs(false));
  $('cmp-pick').addEventListener('click', cmpPick);
  $('cmp-pick2').addEventListener('click', cmpPick);
  $('cmp-go').addEventListener('click', doCompress);
  document.querySelectorAll('input[name="cmp-mode"]').forEach((r) => r.addEventListener('change', () => {
    $('raster-opts').hidden = document.querySelector('input[name="cmp-mode"]:checked').value !== 'raster';
    $('cmp-result').hidden = true;
  }));
  $('cmp-quality').addEventListener('input', (e) => ($('cmp-quality-out').value = e.target.value + '%'));

  // File drops anywhere in a panel go to that tool.
  const handlers = { merge: mergeAdd, split: splitLoad, organize: orgAdd, images: imgAdd, compress: cmpLoad };
  document.querySelectorAll('.panel').forEach((panel) => {
    makeDropTarget(panel, (files) => handlers[panel.dataset.panel](files), {
      highlightEl: panel.querySelector('.dropzone:not([hidden])') ? panel.querySelector('.dropzone') : panel
    });
  });
  // Stop the browser from navigating away when a file misses the drop target.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // Page-level shortcuts for Organize.
  document.addEventListener('keydown', (e) => {
    if (currentTool() !== 'organize' || !org.items.length) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      orgUndo();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      orgSelectWhere(() => true);
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      orgSave();
    } else if (e.key === 'Escape' && org.selected.size) {
      orgSelectWhere(() => false);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (org.undo.length) e.preventDefault();
  });
}

async function init() {
  bind();
  const hashTool = location.hash.slice(1);
  showTool(TOOLS.includes(hashTool) ? hashTool : 'merge', { updateHash: TOOLS.includes(hashTool) });
  const params = new URLSearchParams(location.search);
  const key = params.get('doc');
  if (!key) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const entry = await takeHandoff(key).catch(() => null);
  if (!entry) return toast('That document is no longer available. Open it again.', 'error');
  const file = { name: entry.name || 'document.pdf', bytes: new Uint8Array(entry.bytes), type: 'application/pdf' };
  const handlers = { merge: mergeAdd, split: splitLoad, organize: orgAdd, images: orgAdd, compress: cmpLoad };
  const tool = TOOLS.includes(hashTool) && hashTool !== 'images' ? hashTool : 'organize';
  showTool(tool);
  await handlers[tool]([file]);
}

if (globalThis.chrome?.runtime?.getManifest) globalThis.__pdfTools = { merge, split, org, imgs, cmp, ops };

init();
