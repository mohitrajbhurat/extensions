// Burn annotations into a pdf-lib document. Drawing (highlights, ink, shapes, text, signatures) is
// flattened into the page content; sticky comments become real PDF /Text annotations.
import {
  arrowHead, ellipsePoints, rectPoints, markGeometry, smoothPath, polyPath, wrapText,
  hexToRgb01, BASELINE, LINE_HEIGHT, TEXT_PAD
} from './annogeom.js';

const L = () => globalThis.PDFLib;

/**
 * @param doc pdf-lib PDFDocument
 * @param annotations array of annotation objects (see annogeom.js for units)
 * @param mapperFor (pageIndex) => { toPdf(x, y) -> [X, Y], rotation }
 * @returns {{ replacedChars: number }}
 */
export async function applyAnnotations(doc, annotations, mapperFor) {
  const { rgb, degrees, BlendMode, LineCapStyle, StandardFonts, PDFHexString, PDFString } = L();
  const fonts = {};
  const images = new Map();
  let replacedChars = 0;

  const getFont = async (key) => {
    if (!fonts[key]) {
      const name = key === 'times' ? StandardFonts.TimesRoman : key === 'courier' ? StandardFonts.Courier : StandardFonts.Helvetica;
      const font = await doc.embedFont(name);
      fonts[key] = { font, charset: new Set(font.getCharacterSet()) };
    }
    return fonts[key];
  };
  const clean = (str, charset) => {
    let out = '';
    for (const ch of str.replace(/\t/g, '    ')) {
      if (ch === '\n' || charset.has(ch.codePointAt(0))) out += ch;
      else {
        out += '?';
        replacedChars++;
      }
    }
    return out;
  };
  const getImage = async (src) => {
    if (!images.has(src)) {
      const bytes = dataUrlToBytes(src);
      const isPng = /^data:image\/png/i.test(src);
      images.set(src, isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes));
    }
    return images.get(src);
  };

  const pages = doc.getPages();
  for (const a of annotations) {
    const page = pages[a.page];
    if (!page) continue;
    const { toPdf, rotation } = mapperFor(a.page);
    const flip = (p) => {
      const [X, Y] = toPdf(p[0], p[1]);
      return [X, -Y]; // drawSvgPath flips y, so pre-negate.
    };
    const color = rgb(...hexToRgb01(a.color));
    const opacity = a.opacity ?? 1;
    const stroke = (d, width, extra = {}) => page.drawSvgPath(d, {
      x: 0, y: 0, borderColor: color, borderWidth: width, borderOpacity: opacity,
      borderLineCap: LineCapStyle.Round, ...extra
    });
    const fill = (d, extra = {}) => page.drawSvgPath(d, { x: 0, y: 0, color, opacity, ...extra });

    switch (a.type) {
      case 'highlight':
        for (const r of a.rects) fill(polyPath(rectPoints(r.x, r.y, r.w, r.h), true, flip), { blendMode: BlendMode.Multiply });
        break;
      case 'underline':
      case 'strike':
        for (const r of a.rects) {
          const t = Math.max(0.8, r.h * 0.07);
          const yy = a.type === 'underline' ? r.y + r.h - t / 2 : r.y + r.h * 0.55;
          stroke(polyPath([[r.x, yy], [r.x + r.w, yy]], false, flip), t, { borderLineCap: LineCapStyle.Butt });
        }
        break;
      case 'ink':
        stroke(smoothPath(a.points, flip), a.width);
        break;
      case 'rect':
      case 'ellipse': {
        const pts = a.type === 'rect' ? rectPoints(a.x, a.y, a.w, a.h) : ellipsePoints(a.x, a.y, a.w, a.h);
        const d = polyPath(pts, true, flip);
        if (a.fill) fill(d);
        else stroke(d, a.width, { borderLineCap: LineCapStyle.Round });
        break;
      }
      case 'line':
      case 'arrow':
        stroke(polyPath([[a.x1, a.y1], [a.x2, a.y2]], false, flip), a.width);
        if (a.type === 'arrow') stroke(polyPath(arrowHead(a.x1, a.y1, a.x2, a.y2, a.width), false, flip), a.width);
        break;
      case 'mark': {
        const g = markGeometry(a.variant, a.x, a.y, a.w, a.h);
        if (g.fill) fill(polyPath(g.fill, true, flip));
        else for (const line of g.lines) stroke(polyPath(line, false, flip), g.width);
        break;
      }
      case 'text': {
        if (!a.text || !a.text.trim()) break;
        const fontKey = a.font || 'helvetica';
        const { font, charset } = await getFont(fontKey);
        const text = clean(a.text, charset);
        const size = a.size;
        const lines = wrapText(text, a.w - TEXT_PAD * 2, (s) => font.widthOfTextAtSize(s, size));
        lines.forEach((line, i) => {
          if (!line) return;
          const baseline = a.y + TEXT_PAD + i * size * LINE_HEIGHT + size * (BASELINE[fontKey] ?? 0.94);
          const [X, Y] = toPdf(a.x + TEXT_PAD, baseline);
          page.drawText(line, { x: X, y: Y, size, font, color, opacity, rotate: degrees(rotation) });
        });
        break;
      }
      case 'image': {
        const img = await getImage(a.src);
        const [X, Y] = toPdf(a.x, a.y + a.h);
        page.drawImage(img, { x: X, y: Y, width: a.w, height: a.h, rotate: degrees(rotation), opacity });
        break;
      }
      case 'note': {
        const p1 = toPdf(a.x, a.y);
        const p2 = toPdf(a.x + 22, a.y + 22);
        const rect = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
        const annot = doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: rect,
          Contents: PDFHexString.fromText(a.text || ''),
          Name: 'Comment',
          C: hexToRgb01(a.color),
          F: 4,
          T: PDFHexString.fromText(a.author || 'PDF Studio'),
          M: PDFString.fromDate(new Date(a.created || Date.now())),
          Open: false
        });
        page.node.addAnnot(doc.context.register(annot));
        break;
      }
    }
  }
  return { replacedChars };
}

export function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
