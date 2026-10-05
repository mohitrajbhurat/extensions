// node --test pocket-tools/test
// QR encoder tests: published reference values plus a round trip through an
// independent reader written here (format info, unmasking, de-interleaving,
// Reed-Solomon syndrome check, segment parsing).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeQR, encodeCodewords, rsRemainder, alignmentPositions, totalCodewords, dataCodewords,
  capacityFor, pickMode, maskBit, gfMul, toSVG, wifiPayload, vcardPayload, utf8Bytes,
} from '../lib/qr.js';

// ------------------------------------------------------------ mini reader

const FORMAT_LEVEL = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

function bchFormat(data) {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function readFormat(m) {
  const size = m.length;
  const get = (x, y) => m[y][x];
  let a = 0;
  for (let i = 0; i <= 5; i++) a |= get(8, i) << i;
  a |= get(8, 7) << 6;
  a |= get(8, 8) << 7;
  a |= get(7, 8) << 8;
  for (let i = 9; i < 15; i++) a |= get(14 - i, 8) << i;
  let b = 0;
  for (let i = 0; i < 8; i++) b |= get(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) b |= get(8, size - 15 + i) << i;
  assert.equal(a, b, 'both format copies agree');
  for (let data = 0; data < 32; data++) {
    if (bchFormat(data) === a) return { level: FORMAT_LEVEL[data >> 3], mask: data & 7 };
  }
  throw new Error('invalid format bits');
}

function functionMask(version) {
  const size = version * 4 + 17;
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) f[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const pos = alignmentPositions(version);
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(pos[i] + dx, pos[j] + dy);
  }
  for (let i = 0; i < 9; i++) { mark(i, 8); mark(8, i); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(size - 11 + j, i); mark(i, size - 11 + j); }
  return f;
}

function readCodewords(m, version, mask) {
  const size = m.length;
  const f = functionMask(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (f[y][x]) continue;
        bits.push(m[y][x] ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length && out.length < totalCodewords(version); i += 8) {
    out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  return out;
}

// Polynomial evaluation at alpha^i must be zero for a valid RS codeword.
function syndromesZero(block, eccLen) {
  let alpha = 1;
  for (let i = 0; i < eccLen; i++) {
    let acc = 0;
    for (const c of block) acc = gfMul(acc, alpha) ^ c;
    if (acc !== 0) return false;
    alpha = gfMul(alpha, 2);
  }
  return true;
}

function decode(qr) {
  const { level, mask } = readFormat(qr.modules);
  const version = (qr.modules.length - 17) / 4;
  const cw = readCodewords(qr.modules, version, mask);
  const total = totalCodewords(version);
  const dataLen = dataCodewords(version, level);
  // Recover block structure from the encoder's own layout description.
  const { dataBlocks, eccBlocks } = encodeCodewords('', level, version);
  const blockCount = dataBlocks.length;
  const eccLen = eccBlocks[0].length;
  assert.equal(dataLen + eccLen * blockCount, total);
  const shortLen = Math.floor(total / blockCount) - eccLen;
  const numShort = blockCount - (total % blockCount);
  const blocks = Array.from({ length: blockCount }, (_, b) => ({ data: [], ecc: [], len: shortLen + (b < numShort ? 0 : 1) }));
  let k = 0;
  for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.len) b.data.push(cw[k++]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) b.ecc.push(cw[k++]);
  for (const b of blocks) assert.ok(syndromesZero([...b.data, ...b.ecc], eccLen), 'RS syndromes are zero');
  const data = blocks.flatMap(b => b.data);
  const bits = data.flatMap(byte => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (byte >> i) & 1));
  let p = 0;
  const read = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]; return v; };
  const modeBits = read(4);
  const ci = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  if (modeBits === 4) {
    const n = read([8, 16, 16][ci]);
    const bytes = Array.from({ length: n }, () => read(8));
    return { text: new TextDecoder().decode(new Uint8Array(bytes)), level, mask, version };
  }
  if (modeBits === 2) {
    const n = read([9, 11, 13][ci]);
    let s = '';
    for (let i = 0; i + 1 < n; i += 2) { const v = read(11); s += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; }
    if (n % 2) s += ALNUM[read(6)];
    return { text: s, level, mask, version };
  }
  if (modeBits === 1) {
    const n = read([10, 12, 14][ci]);
    let s = '';
    for (let i = 0; i < n; i += 3) {
      const len = Math.min(3, n - i);
      s += String(read(len * 3 + 1)).padStart(len, '0');
    }
    return { text: s, level, mask, version };
  }
  throw new Error('unexpected mode ' + modeBits);
}

// ------------------------------------------------------------------- tests

test('Reed-Solomon matches the ISO 18004 / Thonky "HELLO WORLD" 1-M example', () => {
  const { dataCodewords: data, codewords } = encodeCodewords('HELLO WORLD', 'M', 1);
  assert.deepEqual(data, [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
  assert.deepEqual(rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.equal(codewords.length, 26);
});

test('alignment pattern positions match the specification table', () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(15), [6, 26, 48, 70]);
  assert.deepEqual(alignmentPositions(20), [6, 34, 62, 90]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('capacities match the published table', () => {
  assert.equal(totalCodewords(1), 26);
  assert.equal(totalCodewords(40), 3706);
  assert.deepEqual(capacityFor(1, 'L'), { numeric: 41, alphanumeric: 25, byte: 17 });
  assert.deepEqual(capacityFor(1, 'H'), { numeric: 17, alphanumeric: 10, byte: 7 });
  assert.equal(capacityFor(10, 'M').byte, 213);
  assert.equal(capacityFor(20, 'Q').byte, 482);
  assert.equal(capacityFor(20, 'L').byte, 858);
  assert.equal(capacityFor(40, 'L').byte, 2953);
  assert.equal(capacityFor(40, 'L').numeric, 7089);
  assert.equal(capacityFor(40, 'H').alphanumeric, 1852);
});

test('mode selection', () => {
  assert.equal(pickMode('0123456789'), 'numeric');
  assert.equal(pickMode('HELLO WORLD'), 'alphanumeric');
  assert.equal(pickMode('hello'), 'byte');
  assert.equal(pickMode(''), 'byte');
});

test('format and timing patterns are intact', () => {
  const qr = encodeQR('timing check', { level: 'Q' });
  const m = qr.modules;
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
  }
  assert.equal(m[qr.size - 8][8], 1, 'dark module');
  assert.deepEqual(readFormat(m), { level: 'Q', mask: qr.mask });
});

test('version information block for version 7 is 0x07C94', () => {
  const qr = encodeQR('x'.repeat(120), { level: 'L', minVersion: 7 });
  assert.equal(qr.version, 7);
  let bits = 0;
  for (let i = 0; i < 18; i++) bits |= qr.modules[Math.floor(i / 3)][qr.size - 11 + (i % 3)] << i;
  assert.equal(bits, 0x07c94);
  let bits2 = 0;
  for (let i = 0; i < 18; i++) bits2 |= qr.modules[qr.size - 11 + (i % 3)][Math.floor(i / 3)] << i;
  assert.equal(bits2, 0x07c94);
});

const samples = [
  ['HELLO WORLD', 'Q'],
  ['01234567890123456789', 'M'],
  ['https://example.com/path?q=1&lang=de', 'M'],
  ['Grüße aus München 🌍 你好', 'H'],
  [wifiPayload({ ssid: 'Cafe;Guest', password: 'p:ss"word', security: 'WPA' }), 'M'],
  [vcardPayload({ firstName: 'Ada', lastName: 'Lovelace', phone: '+44 20 1234 5678', email: 'ada@example.com' }), 'Q'],
  ['x'.repeat(400), 'L'],
  ['Lorem ipsum dolor sit amet '.repeat(30), 'M'],
  ['A'.repeat(900), 'H'],
];

for (const [text, level] of samples) {
  test(`round trip ${level}: ${JSON.stringify(text.slice(0, 24))}… (${text.length} chars)`, () => {
    const qr = encodeQR(text, { level });
    const back = decode(qr);
    assert.equal(back.text, text);
    assert.equal(back.level, level);
    assert.equal(back.mask, qr.mask);
  });
}

test('every mask produces a readable symbol', () => {
  for (let mask = 0; mask < 8; mask++) {
    const qr = encodeQR('mask test ' + mask, { level: 'M', mask });
    assert.equal(qr.mask, mask);
    assert.equal(decode(qr).text, 'mask test ' + mask);
  }
});

test('covers versions 1 through 25 and picks the smallest version that fits', () => {
  for (let v = 1; v <= 25; v++) {
    const max = capacityFor(v, 'M').byte;
    const full = encodeQR('b'.repeat(max), { level: 'M' });
    assert.equal(full.version, v, `full version ${v}`);
    assert.equal(decode(full).text, 'b'.repeat(max));
    if (v < 40) assert.equal(encodeQR('b'.repeat(max + 1), { level: 'M' }).version, v + 1);
  }
});

test('rejects data that does not fit in version 40', () => {
  assert.throws(() => encodeQR('z'.repeat(3000), { level: 'L' }), /too long/);
});

test('SVG output has the right size and colours', () => {
  const qr = encodeQR('svg', { level: 'L' });
  const svg = toSVG(qr, { scale: 4, quiet: 2, dark: '#123456', light: '#fedcba' });
  const dim = (qr.size + 4) * 4;
  assert.match(svg, new RegExp(`width="${dim}" height="${dim}"`));
  assert.match(svg, /fill="#123456"/);
  assert.match(svg, /fill="#fedcba"/);
});

test('payload helpers escape special characters', () => {
  assert.equal(wifiPayload({ ssid: 'a;b', password: 'c,d', security: 'WPA', hidden: true }), 'WIFI:T:WPA;S:a\\;b;P:c\\,d;H:true;;');
  assert.equal(wifiPayload({ ssid: 'open', security: 'none' }), 'WIFI:T:nopass;S:open;;');
  assert.match(vcardPayload({ firstName: 'A', lastName: 'B' }), /^BEGIN:VCARD\nVERSION:3.0\nN:B;A;;;\nFN:A B\nEND:VCARD$/);
  assert.deepEqual(utf8Bytes('é€😀'), [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
});
