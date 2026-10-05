// Geometry shared by the on-screen annotation renderer and the PDF exporter, so both draw the same thing.
// Coordinates are "page units": PDF points in the displayed (rotated) page, origin top-left, y down.

export const FONT_STACKS = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace'
};

// Distance from the line box top to the baseline, as a fraction of font size, for line-height 1.2.
export const BASELINE = { helvetica: 0.947, times: 0.937, courier: 0.866 };
export const LINE_HEIGHT = 1.2;
export const TEXT_PAD = 3; // 1px border + 2px padding, matches .anno-text

export function arrowHead(x1, y1, x2, y2, width) {
  const len = Math.max(8, width * 4);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)],
    [x2, y2],
    [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)]
  ];
}

export function ellipsePoints(x, y, w, h, n = 72) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + (w / 2) * Math.cos(t), cy + (h / 2) * Math.sin(t)]);
  }
  return pts;
}

export function rectPoints(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** Polylines for check / cross marks in a box, plus stroke width. Dot returns a polygon to fill. */
export function markGeometry(variant, x, y, w, h) {
  const s = Math.min(w, h);
  const P = (u, v) => [x + u * w, y + v * h];
  if (variant === 'check') return { lines: [[P(0.12, 0.55), P(0.4, 0.82), P(0.9, 0.18)]], width: s * 0.13 };
  if (variant === 'cross') return { lines: [[P(0.15, 0.15), P(0.85, 0.85)], [P(0.85, 0.15), P(0.15, 0.85)]], width: s * 0.13 };
  return { fill: ellipsePoints(x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6, 40), width: 0 };
}

/** SVG path data for a smoothed freehand stroke. fmt maps a point to [x, y] output. */
export function smoothPath(points, fmt = (p) => p) {
  if (!points.length) return '';
  const f = (p) => fmt(p).map((v) => +v.toFixed(2)).join(' ');
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${f([x, y])} L ${f([x + 0.01, y + 0.01])}`;
  }
  if (points.length === 2) return `M ${f(points[0])} L ${f(points[1])}`;
  let d = `M ${f(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    d += ` Q ${f(p)} ${f([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])}`;
  }
  d += ` L ${f(points[points.length - 1])}`;
  return d;
}

export function polyPath(points, closed, fmt = (p) => p) {
  const f = (p) => fmt(p).map((v) => +v.toFixed(2)).join(' ');
  return points.map((p, i) => (i ? 'L ' : 'M ') + f(p)).join(' ') + (closed ? ' Z' : '');
}

/** Greedy word wrap. measure(str) returns width in the same units as maxWidth. */
export function wrapText(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    const tokens = para.match(/\S+\s*|\s+/g) || [''];
    let line = '';
    for (const tok of tokens) {
      if (measure((line + tok).trimEnd()) <= maxWidth || !line) {
        if (!line && measure(tok.trimEnd()) > maxWidth) {
          // Break a very long word by characters.
          let chunk = '';
          for (const ch of tok) {
            if (measure(chunk + ch) > maxWidth && chunk) {
              out.push(chunk);
              chunk = '';
            }
            chunk += ch;
          }
          line = chunk;
        } else {
          line += tok;
        }
      } else {
        out.push(line.trimEnd());
        line = tok.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Bounding box of an annotation in page units. */
export function bbox(a) {
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strike': {
      const xs = a.rects.flatMap((r) => [r.x, r.x + r.w]);
      const ys = a.rects.flatMap((r) => [r.y, r.y + r.h]);
      return box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
    case 'ink': {
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      const pad = a.width / 2;
      return box(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
    }
    case 'line':
    case 'arrow':
      return box(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.max(a.x1, a.x2), Math.max(a.y1, a.y2));
    case 'note':
      return { x: a.x, y: a.y, w: 22, h: 22 };
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

function box(x1, y1, x2, y2) {
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
