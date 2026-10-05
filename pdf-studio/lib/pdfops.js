// Page operations built on pdf-lib (global PDFLib). Pure functions: bytes in, bytes out.
// Works in extension pages and in Node (tests set globalThis.PDFLib before importing).

const lib = () => {
  const L = globalThis.PDFLib;
  if (!L) throw new Error('pdf-lib is not loaded');
  return L;
};

export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a5: [419.53, 595.28]
};

const LOAD_OPTS = { ignoreEncryption: true, updateMetadata: false };

export async function loadPdf(bytes) {
  return lib().PDFDocument.load(bytes, LOAD_OPTS);
}

function stamp(doc) {
  doc.setProducer('PDF Studio (local, pdf-lib)');
  doc.setModificationDate(new Date());
  return doc;
}

export async function saveDoc(doc, { objectStreams = true } = {}) {
  stamp(doc);
  return doc.save({ useObjectStreams: objectStreams });
}

export async function pageCount(bytes) {
  return (await loadPdf(bytes)).getPageCount();
}

function normAngle(a) {
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

/** Merge several PDFs (array of bytes) in order. Optional per-file page index lists. */
export async function merge(list, pageSelections = []) {
  const { PDFDocument } = lib();
  const out = await PDFDocument.create();
  for (let i = 0; i < list.length; i++) {
    const src = await loadPdf(list[i]);
    const indices = pageSelections[i] || src.getPageIndices();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
  }
  return saveDoc(out);
}

/** Copy the given zero-based page indices (any order, duplicates allowed) into a new PDF. */
export async function extract(bytes, indices) {
  const { PDFDocument } = lib();
  const src = await loadPdf(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return saveDoc(out);
}

/** Split into several PDFs. groups: array of arrays of zero-based indices. */
export async function splitGroups(bytes, groups) {
  const { PDFDocument } = lib();
  const src = await loadPdf(bytes);
  const results = [];
  for (const group of groups) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, group);
    pages.forEach((p) => out.addPage(p));
    results.push(await saveDoc(out));
  }
  return results;
}

/** Index groups of size n covering count pages. */
export function chunkIndices(count, n) {
  n = Math.max(1, Math.floor(n));
  const groups = [];
  for (let i = 0; i < count; i += n) {
    groups.push(Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k));
  }
  return groups;
}

export async function splitEvery(bytes, n) {
  const count = await pageCount(bytes);
  return splitGroups(bytes, chunkIndices(count, n));
}

/** Rotate pages by delta degrees (multiple of 90). indices omitted = all pages. */
export async function rotate(bytes, delta, indices = null) {
  const { degrees } = lib();
  const doc = await loadPdf(bytes);
  const targets = indices || doc.getPageIndices();
  for (const i of targets) {
    const p = doc.getPage(i);
    p.setRotation(degrees(normAngle(p.getRotation().angle + delta)));
  }
  return saveDoc(doc);
}

export async function removePages(bytes, indices) {
  const doc = await loadPdf(bytes);
  const n = doc.getPageCount();
  const set = new Set(indices);
  if (set.size >= n) throw new Error('A PDF must keep at least one page');
  [...set].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  return saveDoc(doc);
}

/** Reorder pages. order: array of zero-based source indices for the new sequence. */
export async function reorder(bytes, order) {
  return extract(bytes, order);
}

/** Insert a blank page at index (0 = before first page). Size copies the neighbour page by default. */
export async function insertBlank(bytes, atIndex, size = null) {
  const doc = await loadPdf(bytes);
  const n = doc.getPageCount();
  const ref = doc.getPage(Math.min(Math.max(atIndex - 1, 0), n - 1));
  const s = size || [ref.getWidth(), ref.getHeight()];
  doc.insertPage(Math.min(Math.max(atIndex, 0), n), s);
  return saveDoc(doc);
}

/**
 * Build a document from a page plan, the general form behind the Organize tool.
 * sources: array of bytes. plan: [{ src: sourceIdx, page: pageIdx, rotate: deltaDegrees } | { blank: true, size: [w,h] }]
 */
export async function buildFromPlan(sources, plan) {
  const { PDFDocument, degrees } = lib();
  const out = await PDFDocument.create();
  const docs = [];
  for (const s of sources) docs.push(await loadPdf(s));
  // Copy pages grouped by source to share resources, then add in plan order.
  const copied = new Map();
  for (let si = 0; si < docs.length; si++) {
    const wanted = [...new Set(plan.filter((p) => !p.blank && p.src === si).map((p) => p.page))];
    if (!wanted.length) continue;
    const pages = await out.copyPages(docs[si], wanted);
    wanted.forEach((pi, k) => copied.set(`${si}:${pi}`, pages[k]));
  }
  const used = new Set();
  let lastSize = PAGE_SIZES.a4;
  for (const item of plan) {
    if (item.blank) {
      out.addPage(item.size || lastSize);
      continue;
    }
    const key = `${item.src}:${item.page}`;
    let page = copied.get(key);
    if (used.has(key)) {
      // Same page used twice: copy again so each placement is its own page object.
      [page] = await out.copyPages(docs[item.src], [item.page]);
    }
    used.add(key);
    if (item.rotate) page.setRotation(degrees(normAngle(page.getRotation().angle + item.rotate)));
    out.addPage(page);
    lastSize = [page.getWidth(), page.getHeight()];
  }
  if (!out.getPageCount()) throw new Error('The result has no pages');
  return saveDoc(out);
}

/**
 * Images to PDF. images: [{ bytes, type: 'png'|'jpg', width, height }]
 * opts: { pageSize: 'fit'|'a4'|'letter'|..., orientation: 'auto'|'portrait'|'landscape', margin: points }
 */
export async function imagesToPdf(images, { pageSize = 'fit', orientation = 'auto', margin = 0 } = {}) {
  const { PDFDocument } = lib();
  const doc = await PDFDocument.create();
  for (const img of images) {
    const embedded = img.type === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    const iw = embedded.width;
    const ih = embedded.height;
    let pw;
    let ph;
    if (pageSize === 'fit') {
      // 1 image pixel = 0.75pt (96 dpi), keep a sensible size for camera photos.
      let scale = 0.75;
      const maxSide = 1440;
      if (Math.max(iw, ih) * scale > maxSide) scale = maxSide / Math.max(iw, ih);
      pw = iw * scale + margin * 2;
      ph = ih * scale + margin * 2;
    } else {
      [pw, ph] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
      const landscape = orientation === 'landscape' || (orientation === 'auto' && iw > ih);
      if (landscape) [pw, ph] = [Math.max(pw, ph), Math.min(pw, ph)];
    }
    const page = doc.addPage([pw, ph]);
    const aw = pw - margin * 2;
    const ah = ph - margin * 2;
    const s = Math.min(aw / iw, ah / ih);
    const w = iw * s;
    const h = ih * s;
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return saveDoc(doc);
}

/** Lossless-ish compression: re-save with object streams, dropping unused objects. */
export async function compressResave(bytes) {
  const { PDFDocument } = lib();
  const src = await loadPdf(bytes);
  // Copying pages into a fresh document drops orphaned objects (old revisions, unused resources).
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  const title = src.getTitle();
  if (title) out.setTitle(title);
  const author = src.getAuthor();
  if (author) out.setAuthor(author);
  return saveDoc(out, { objectStreams: true });
}

/**
 * Rebuild a PDF from rasterized pages. pages: [{ jpeg: bytes, width, height }] in points.
 */
export async function pdfFromJpegPages(pages) {
  const { PDFDocument } = lib();
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const img = await doc.embedJpg(p.jpeg);
    const page = doc.addPage([p.width, p.height]);
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
  }
  return saveDoc(doc);
}
