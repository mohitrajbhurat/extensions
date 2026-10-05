// QR Code encoder — written from the ISO/IEC 18004 specification.
// Supports versions 1..40, error correction levels L/M/Q/H, numeric /
// alphanumeric / byte (UTF-8) segment modes, Reed-Solomon error correction,
// all eight data masks with penalty scoring, and SVG / matrix output.
//
// No dependencies; usable from extension pages, the service worker and node.

export const EC_LEVELS = ['L', 'M', 'Q', 'H'];
// Format information indicator for each level (not the array order).
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// Error correction codewords per block, indexed [level][version-1].
const ECC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

// Number of error correction blocks, indexed [level][version-1].
const EC_BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MODE = {
  numeric: { bits: 1, counts: [10, 12, 14] },
  alphanumeric: { bits: 2, counts: [9, 11, 13] },
  byte: { bits: 4, counts: [8, 16, 16] },
};

export function moduleCount(version) {
  return version * 4 + 17;
}

// Alignment pattern centre coordinates for a version (empty for version 1).
export function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const last = version * 4 + 10;
  const step = version === 32 ? 26 : Math.ceil((last - 6) / (count - 1) / 2) * 2;
  const pos = [6];
  for (let i = count - 1; i >= 1; i--) pos.push(last - (count - 1 - i) * step);
  return pos.sort((a, b) => a - b);
}

// Number of modules available for data + error correction codewords.
function rawDataModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

export function totalCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

export function dataCodewords(version, level) {
  return totalCodewords(version) - ECC_PER_BLOCK[level][version - 1] * EC_BLOCKS[level][version - 1];
}

function countBits(mode, version) {
  const i = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return MODE[mode].counts[i];
}

// ---------------------------------------------------------------- segments

export function utf8Bytes(str) {
  const out = [];
  for (const ch of str) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

export function pickMode(text) {
  if (text.length && /^[0-9]+$/.test(text)) return 'numeric';
  if (text.length && [...text].every(c => ALNUM_CHARS.includes(c))) return 'alphanumeric';
  return 'byte';
}

class BitBuffer {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

function segmentPayloadBits(mode, text) {
  const bb = new BitBuffer();
  if (mode === 'numeric') {
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      bb.push(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
  } else if (mode === 'alphanumeric') {
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) {
        bb.push(ALNUM_CHARS.indexOf(text[i]) * 45 + ALNUM_CHARS.indexOf(text[i + 1]), 11);
      } else {
        bb.push(ALNUM_CHARS.indexOf(text[i]), 6);
      }
    }
  } else {
    for (const b of utf8Bytes(text)) bb.push(b, 8);
  }
  return bb.bits;
}

function charCount(mode, text) {
  return mode === 'byte' ? utf8Bytes(text).length : text.length;
}

// ------------------------------------------------------------ Galois field

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Generator polynomial for `degree` error correction codewords, highest term first.
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return Array.from(rem);
}

// ------------------------------------------------------------- BCH helpers

function formatBits(level, mask) {
  const data = (EC_FORMAT_BITS[level] << 3) | mask; // 5 bits
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---------------------------------------------------------------- encoding

export function pickVersion(text, level, { minVersion = 1, maxVersion = 40 } = {}) {
  const mode = pickMode(text);
  const payload = segmentPayloadBits(mode, text).length;
  const count = charCount(mode, text);
  for (let v = Math.max(1, minVersion); v <= Math.min(40, maxVersion); v++) {
    const capacity = dataCodewords(v, level) * 8;
    const needed = 4 + countBits(mode, v) + payload;
    if (needed <= capacity) return { version: v, mode, bits: needed, capacity, count };
  }
  return null;
}

export function capacityFor(version, level) {
  const out = {};
  for (const mode of Object.keys(MODE)) {
    const bits = dataCodewords(version, level) * 8 - 4 - countBits(mode, version);
    if (mode === 'numeric') out.numeric = Math.floor(bits / 10) * 3 + (bits % 10 >= 7 ? 2 : bits % 10 >= 4 ? 1 : 0);
    else if (mode === 'alphanumeric') out.alphanumeric = Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
    else out.byte = Math.floor(bits / 8);
  }
  return out;
}

// Returns the final interleaved codeword sequence for the given text.
export function encodeCodewords(text, level, version) {
  const mode = pickMode(text);
  const bb = new BitBuffer();
  bb.push(MODE[mode].bits, 4);
  bb.push(charCount(mode, text), countBits(mode, version));
  for (const bit of segmentPayloadBits(mode, text)) bb.bits.push(bit);

  const capacity = dataCodewords(version, level) * 8;
  if (bb.length > capacity) throw new Error('Data too long for version ' + version + '-' + level);
  // Terminator and byte alignment.
  bb.push(0, Math.min(4, capacity - bb.length));
  while (bb.length % 8 !== 0) bb.bits.push(0);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    data.push(byte);
  }
  // Alternating pad codewords.
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, append error correction, interleave.
  const blockCount = EC_BLOCKS[level][version - 1];
  const eccLen = ECC_PER_BLOCK[level][version - 1];
  const total = totalCodewords(version);
  const shortLen = Math.floor(total / blockCount) - eccLen;
  const numShort = blockCount - (total % blockCount);

  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, eccLen));
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < blockCount; b++) out.push(eccBlocks[b][i]);
  }
  return { codewords: out, dataBlocks, eccBlocks, mode, dataCodewords: data };
}

// ----------------------------------------------------------------- drawing

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = new Uint8Array(size * size); // 1 = dark
    this.reserved = new Uint8Array(size * size); // 1 = function pattern
  }
  get(x, y) { return this.modules[y * this.size + x]; }
  set(x, y, dark, reserve = true) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    if (reserve) this.reserved[y * this.size + x] = 1;
  }
  isReserved(x, y) { return this.reserved[y * this.size + x] === 1; }
  rows() {
    const out = [];
    for (let y = 0; y < this.size; y++) {
      const row = [];
      for (let x = 0; x < this.size; x++) row.push(this.get(x, y));
      out.push(row);
    }
    return out;
  }
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      m.set(x, y, d !== 2 && d <= 3, true);
    }
  }
}

function drawFunctionPatterns(m, version, level) {
  const size = m.size;
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, size - 4, 3);
  drawFinder(m, 3, size - 4);
  // Alignment patterns (skipping the three finder corners).
  const pos = alignmentPositions(version);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      const cx = pos[i], cy = pos[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserve format information areas and set the dark module.
  // (6,8) and (8,6) belong to the timing patterns and must keep their colour.
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue;
    m.set(i, 8, false);
    m.set(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    m.set(size - 1 - i, 8, false);
    m.set(8, size - 1 - i, false);
  }
  m.set(8, size - 8, true); // dark module
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3), b = i % 3;
      m.set(size - 11 + b, a, bit);
      m.set(a, size - 11 + b, bit);
    }
  }
}

function drawFormatInfo(m, level, mask) {
  const bits = formatBits(level, mask);
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.set(8, i, ((bits >>> i) & 1) === 1);
  m.set(8, 7, ((bits >>> 6) & 1) === 1);
  m.set(8, 8, ((bits >>> 7) & 1) === 1);
  m.set(7, 8, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 0; i < 8; i++) m.set(size - 1 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 8; i < 15; i++) m.set(8, size - 15 + i, ((bits >>> i) & 1) === 1);
}

function placeCodewords(m, codewords) {
  const size = m.size;
  let bit = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.isReserved(x, y)) continue;
        let dark = false;
        if (bit < total) dark = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
        m.modules[y * size + x] = dark ? 1 : 0;
        bit++;
      }
    }
  }
}

export function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error('bad mask');
  }
}

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isReserved(x, y)) continue;
      if (maskBit(mask, x, y)) m.modules[y * m.size + x] ^= 1;
    }
  }
}

// Penalty scoring, ISO/IEC 18004 section 8.8.2.
export function penaltyScore(matrix) {
  const size = matrix.size;
  const get = (x, y) => matrix.modules[y * size + x];
  let score = 0;

  // Rule 1: runs of five or more same-colour modules in a row or column.
  const runScore = run => (run >= 5 ? 3 + (run - 5) : 0);
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (get(x, y) === get(x - 1, y)) run++;
      else { score += runScore(run); run = 1; }
    }
    score += runScore(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (get(x, y) === get(x, y - 1)) run++;
      else { score += runScore(run); run = 1; }
    }
    score += runScore(run);
  }
  // Rule 2: 2x2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = get(x, y);
      if (v === get(x + 1, y) && v === get(x, y + 1) && v === get(x + 1, y + 1)) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns with a 4-module light margin.
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (vals, start) => {
    for (let i = 0; i < 7; i++) if (vals[start + i] !== pattern[i]) return false;
    // Modules outside the symbol count as light (they are the quiet zone).
    let quietBefore = true, quietAfter = true;
    for (let i = 1; i <= 4; i++) {
      if (start - i >= 0 && vals[start - i] !== 0) quietBefore = false;
      if (start + 6 + i < vals.length && vals[start + 6 + i] !== 0) quietAfter = false;
    }
    return quietBefore || quietAfter;
  };
  const lines = [];
  for (let y = 0; y < size; y++) { const r = []; for (let x = 0; x < size; x++) r.push(get(x, y)); lines.push(r); }
  for (let x = 0; x < size; x++) { const c = []; for (let y = 0; y < size; y++) c.push(get(x, y)); lines.push(c); }
  for (const line of lines) {
    for (let i = 0; i + 7 <= size; i++) if (matches(line, i)) score += 40;
  }
  // Rule 4: deviation of dark module proportion from 50%.
  let dark = 0;
  for (let i = 0; i < matrix.modules.length; i++) dark += matrix.modules[i];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * Encode text as a QR symbol.
 * @returns {{modules:number[][], size:number, version:number, level:string, mask:number, mode:string}}
 */
export function encodeQR(text, options = {}) {
  const level = EC_LEVELS.includes(options.level) ? options.level : 'M';
  const chosen = pickVersion(text, level, options);
  if (!chosen) throw new Error('Text is too long for a QR code at level ' + level + ' (max version 40).');
  const version = chosen.version;
  const { codewords, mode } = encodeCodewords(text, level, version);

  let best = null;
  const masks = options.mask === undefined || options.mask === null || options.mask === 'auto'
    ? [0, 1, 2, 3, 4, 5, 6, 7]
    : [Number(options.mask)];
  for (const mask of masks) {
    const m = new Matrix(moduleCount(version));
    drawFunctionPatterns(m, version, level);
    placeCodewords(m, codewords);
    applyMask(m, mask);
    drawFormatInfo(m, level, mask);
    const score = penaltyScore(m);
    if (!best || score < best.score) best = { m, mask, score };
  }
  return {
    modules: best.m.rows(),
    size: best.m.size,
    version,
    level,
    mask: best.mask,
    mode,
    penalty: best.score,
    codewords,
    capacityBits: chosen.capacity,
    usedBits: chosen.bits,
  };
}

// ------------------------------------------------------------------ output

export function toSVG(qr, opts = {}) {
  const quiet = opts.quiet === undefined ? 4 : Math.max(0, opts.quiet);
  const scale = opts.scale || 8;
  const dark = opts.dark || '#000000';
  const light = opts.light || '#ffffff';
  const dim = (qr.size + quiet * 2) * scale;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${(x + quiet) * scale} ${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  const bg = light === 'transparent' ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">${bg}<path d="${path}" fill="${dark}"/></svg>`;
}

export function drawToCanvas(qr, canvas, opts = {}) {
  const quiet = opts.quiet === undefined ? 4 : Math.max(0, opts.quiet);
  const scale = opts.scale || 8;
  const dim = (qr.size + quiet * 2) * scale;
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (opts.light === 'transparent') ctx.clearRect(0, 0, dim, dim);
  else { ctx.fillStyle = opts.light || '#ffffff'; ctx.fillRect(0, 0, dim, dim); }
  ctx.fillStyle = opts.dark || '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
  return canvas;
}

// --------------------------------------------------------- payload helpers

const escapeQR = s => String(s).replace(/([\\;,:"])/g, '\\$1');

export function wifiPayload({ ssid, password, security = 'WPA', hidden = false }) {
  const type = security === 'none' ? 'nopass' : security;
  let out = `WIFI:T:${type};S:${escapeQR(ssid)};`;
  if (type !== 'nopass' && password) out += `P:${escapeQR(password)};`;
  if (hidden) out += 'H:true;';
  return out + ';';
}

export function vcardPayload(c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const last = c.lastName || '';
  const first = c.firstName || '';
  lines.push(`N:${last};${first};;;`);
  lines.push(`FN:${[first, last].filter(Boolean).join(' ') || c.org || 'Contact'}`);
  if (c.org) lines.push(`ORG:${c.org}`);
  if (c.title) lines.push(`TITLE:${c.title}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${c.phone}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${c.email}`);
  if (c.url) lines.push(`URL:${c.url}`);
  if (c.address) lines.push(`ADR;TYPE=HOME:;;${c.address};;;;`);
  if (c.note) lines.push(`NOTE:${c.note}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

export function smsPayload({ phone, message }) {
  return `SMSTO:${phone || ''}:${message || ''}`;
}

export function emailPayload({ to, subject, body }) {
  const q = [];
  if (subject) q.push('subject=' + encodeURIComponent(subject));
  if (body) q.push('body=' + encodeURIComponent(body));
  return `mailto:${to || ''}${q.length ? '?' + q.join('&') : ''}`;
}

export function geoPayload({ lat, lon }) {
  return `geo:${Number(lat) || 0},${Number(lon) || 0}`;
}
