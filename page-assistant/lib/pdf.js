// Page Assistant: a small, dependency-free PDF text extractor.
// Supports classic and compressed (object stream) files, Flate/LZW/ASCIIHex/ASCII85
// filters, simple fonts (WinAnsi, MacRoman, Standard, Differences), Type0 fonts with
// ToUnicode CMaps, Form XObjects, and reconstructs lines, paragraphs and headings.
// Encrypted PDFs and scanned (image-only) PDFs are reported as errors.

class Name { constructor(n) { this.n = n; } }
class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
class Cmd { constructor(c) { this.c = c; } }
class Str { constructor(s) { this.s = s; } } // binary (latin1) string
class Dict {
  constructor() { this.m = Object.create(null); }
  get(k) { return this.m[k]; }
  has(k) { return k in this.m; }
}
class Stream { constructor(dict, bytes, start, end) { this.dict = dict; this.bytes = bytes; this.start = start; this.end = end; } }
const EOF = new Cmd('%%EOF-token');

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

export function bytesToLatin1(bytes, start = 0, end = bytes.length) {
  let s = '';
  const CH = 0x8000;
  for (let i = start; i < end; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CH)));
  return s;
}

class Lexer {
  constructor(bytes, pos = 0, end = bytes.length) { this.b = bytes; this.pos = pos; this.end = end; this.peeked = []; this.peekedPos = []; }
  skipWs() {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (isWs(c)) this.pos++;
      else if (c === 37) { while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++; }
      else break;
    }
  }
  peek(n = 0) {
    while (this.peeked.length <= n) { this.skipWs(); this.peekedPos.push(this.pos); this.peeked.push(this.lex()); }
    return this.peeked[n];
  }
  next() { if (this.peeked.length) { this.peekedPos.shift(); return this.peeked.shift(); } return this.lex(); }
  /** Position of the next unread token. */
  tell() { return this.peeked.length ? this.peekedPos[0] : this.pos; }
  lex() {
    this.skipWs();
    const b = this.b;
    if (this.pos >= this.end) return EOF;
    const c = b[this.pos];
    if (c === 40) return this.literal();
    if (c === 60) {
      if (b[this.pos + 1] === 60) { this.pos += 2; return new Cmd('<<'); }
      return this.hex();
    }
    if (c === 62) { this.pos += b[this.pos + 1] === 62 ? 2 : 1; return new Cmd('>>'); }
    if (c === 91 || c === 93 || c === 123 || c === 125) { this.pos++; return new Cmd(String.fromCharCode(c)); }
    if (c === 41) { this.pos++; return this.lex(); }
    if (c === 47) {
      this.pos++;
      let s = '';
      while (this.pos < this.end && !isWs(b[this.pos]) && !isDelim(b[this.pos])) {
        const ch = b[this.pos];
        if (ch === 35 && this.pos + 2 < this.end) { // #xx escape
          const h = parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16);
          if (!Number.isNaN(h)) { s += String.fromCharCode(h); this.pos += 3; continue; }
        }
        s += String.fromCharCode(ch); this.pos++;
      }
      return new Name(s);
    }
    const start = this.pos;
    while (this.pos < this.end && !isWs(b[this.pos]) && !isDelim(b[this.pos])) this.pos++;
    if (this.pos === start) { this.pos++; return this.lex(); }
    const tok = bytesToLatin1(b, start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return parseFloat(tok);
    if (/^[+-]?\d*\.?\d*$/.test(tok)) return parseFloat(tok) || 0;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return new Cmd(tok);
  }
  literal() {
    const b = this.b;
    this.pos++;
    let depth = 1;
    let out = '';
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 40) { depth++; out += '('; }
      else if (c === 41) { if (--depth === 0) break; out += ')'; }
      else if (c === 92) {
        const e = b[this.pos++];
        switch (e) {
          case 110: out += '\n'; break;
          case 114: out += '\r'; break;
          case 116: out += '\t'; break;
          case 98: out += '\b'; break;
          case 102: out += '\f'; break;
          case 13: if (b[this.pos] === 10) this.pos++; break;
          case 10: break;
          default:
            if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
              out += String.fromCharCode(v & 255);
            } else if (e !== undefined) out += String.fromCharCode(e);
        }
      } else out += String.fromCharCode(c);
    }
    return new Str(out);
  }
  hex() {
    const b = this.b;
    this.pos++;
    let digits = '';
    while (this.pos < this.end && b[this.pos] !== 62) {
      const c = b[this.pos++];
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) digits += String.fromCharCode(c);
    }
    this.pos++;
    if (digits.length % 2) digits += '0';
    let out = '';
    for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.substr(i, 2), 16));
    return new Str(out);
  }
}

// Parse one value. Handles "n g R" references when allowRefs.
function parseValue(lx, allowRefs = true) {
  const t = lx.next();
  if (t instanceof Cmd) {
    if (t.c === '<<') {
      const d = new Dict();
      for (;;) {
        const k = lx.peek();
        if (k === EOF) break;
        if (k instanceof Cmd && k.c === '>>') { lx.next(); break; }
        lx.next();
        if (!(k instanceof Name)) continue;
        d.m[k.n] = parseValue(lx, allowRefs);
      }
      return d;
    }
    if (t.c === '[') {
      const a = [];
      for (;;) {
        const k = lx.peek();
        if (k === EOF) break;
        if (k instanceof Cmd && k.c === ']') { lx.next(); break; }
        a.push(parseValue(lx, allowRefs));
      }
      return a;
    }
    return t;
  }
  if (allowRefs && typeof t === 'number' && Number.isInteger(t)) {
    const g = lx.peek(0);
    const r = lx.peek(1);
    if (typeof g === 'number' && Number.isInteger(g) && r instanceof Cmd && r.c === 'R') { lx.next(); lx.next(); return new Ref(t, g); }
  }
  return t;
}

// ---- Inflate (RFC 1951), used when DecompressionStream is unavailable or fails ----
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huff(lengths, n) {
  const counts = new Uint16Array(16);
  const offs = new Uint16Array(16);
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

export function inflateSync(src) {
  let pos = 0;
  if (src.length > 2 && (src[0] & 0x0f) === 8 && ((src[0] << 8) | src[1]) % 31 === 0) pos = 2;
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let len = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  const ensure = (n) => {
    if (len + n <= out.length) return;
    let size = out.length * 2;
    while (size < len + n) size *= 2;
    const o = new Uint8Array(size);
    o.set(out.subarray(0, len));
    out = o;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('eof');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= bits(1);
      const count = h.counts[l];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('bad code');
  };
  let fixedL = null;
  let fixedD = null;
  try {
    let final = 0;
    while (!final) {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) throw new Error('eof');
        const n = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        ensure(n);
        out.set(src.subarray(pos, pos + n), len);
        len += Math.min(n, src.length - pos);
        pos += n;
        continue;
      }
      let lh, dh;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          fixedL = huff(l, 288);
          fixedD = huff(new Uint8Array(30).fill(5), 30);
        }
        lh = fixedL; dh = fixedD;
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
        const clh = huff(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(clh);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep = 0, val = 0;
            if (sym === 16) { if (!i) throw new Error('bad repeat'); val = lens[i - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            while (rep-- && i < hlit + hdist) lens[i++] = val;
          }
        }
        lh = huff(lens.subarray(0, hlit), hlit);
        dh = huff(lens.subarray(hlit), hdist);
      } else throw new Error('bad block');
      for (;;) {
        let sym = decode(lh);
        if (sym < 256) { ensure(1); out[len++] = sym; continue; }
        if (sym === 256) break;
        sym -= 257;
        if (sym >= 29) throw new Error('bad length');
        const l = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dh);
        const d = DBASE[ds] + bits(DEXT[ds]);
        if (d > len) throw new Error('bad distance');
        ensure(l);
        for (let k = 0; k < l; k++, len++) out[len] = out[len - d];
      }
    }
  } catch (e) {
    // Return whatever was decoded: truncated streams are common in the wild.
  }
  return out.subarray(0, len);
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'function') {
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) { /* fall through to the tolerant JS inflater */ }
  }
  return inflateSync(bytes);
}

function lzwDecode(src, early = 1) {
  const out = [];
  let dict = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); };
  reset();
  let codeLen = 9;
  let bitBuf = 0, bitCnt = 0, pos = 0;
  let prev = null;
  for (;;) {
    while (bitCnt < codeLen && pos < src.length) { bitBuf = (bitBuf << 8) | src[pos++]; bitCnt += 8; }
    if (bitCnt < codeLen) break;
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    if (code === 256) { reset(); codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]);
    else break;
    for (const x of entry) out.push(x);
    if (prev) dict.push(prev.concat(entry[0]));
    prev = entry;
    if (dict.length + early >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return Uint8Array.from(out);
}

function asciiHex(src) {
  const s = bytesToLatin1(src).replace(/[^0-9a-fA-F>]/g, '');
  const end = s.indexOf('>');
  let h = end >= 0 ? s.slice(0, end) : s;
  if (h.length % 2) h += '0';
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function ascii85(src) {
  let s = bytesToLatin1(src).replace(/\s+/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function unpredict(data, parms) {
  const pred = parms && parms.get('Predictor');
  if (!pred || pred < 10) return data;
  const colors = parms.get('Colors') || 1;
  const bpc = parms.get('BitsPerComponent') || 8;
  const columns = parms.get('Columns') || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const inOff = r * (rowLen + 1) + 1;
    const o = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[inOff + i];
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = r ? out[o - rowLen + i] : 0;
      const c = r && i >= bpp ? out[o - rowLen + i - bpp] : 0;
      let v;
      switch (ft) {
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = x;
      }
      out[o + i] = v & 255;
    }
  }
  return out;
}

// ---- Encodings ----
const WIN_ANSI_HIGH = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
const MAC_ROMAN = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
function baseEncoding(name) {
  const map = new Array(256);
  for (let i = 0; i < 256; i++) map[i] = i >= 32 && i < 127 ? String.fromCharCode(i) : i >= 160 ? String.fromCharCode(i) : '';
  for (const k in WIN_ANSI_HIGH) map[k] = String.fromCharCode(WIN_ANSI_HIGH[k]);
  map[9] = ' '; map[10] = ' '; map[13] = ' ';
  if (name === 'MacRomanEncoding') for (let i = 0; i < 128; i++) map[128 + i] = MAC_ROMAN[i] || '';
  if (name === 'StandardEncoding') { map[0x27] = '’'; map[0x60] = '‘'; map[0xae] = 'fi'; map[0xaf] = 'fl'; map[0xb1] = '–'; map[0xd0] = '—'; map[0xb7] = '•'; }
  return map;
}

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', ellipsis: '…', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', dagger: '†', daggerdbl: '‡', section: '§', paragraph: '¶', copyright: '©', registered: '®', trademark: '™', degree: '°', periodcentered: '·', multiply: '×', divide: '÷', plusminus: '±', Euro: '€', sterling: '£', yen: '¥', cent: '¢', germandbls: 'ß', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', acircumflex: 'â', ecircumflex: 'ê', icircumflex: 'î', ocircumflex: 'ô', ucircumflex: 'û', adieresis: 'ä', edieresis: 'ë', idieresis: 'ï', odieresis: 'ö', udieresis: 'ü', ntilde: 'ñ', ccedilla: 'ç', Aacute: 'Á', Eacute: 'É', Oacute: 'Ó', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü', Ntilde: 'Ñ', Ccedilla: 'Ç', dotlessi: 'ı', nbspace: ' ', arrowright: '→', arrowleft: '←', guillemotleft: '«', guillemotright: '»', exclamdown: '¡', questiondown: '¿', oslash: 'ø', aring: 'å', ae: 'æ', oe: 'œ', OE: 'Œ', AE: 'Æ',
};
function glyphToUnicode(name) {
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) { let s = ''; for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].substr(i, 4), 16)); return s; }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  const base = name.split(/[._]/)[0];
  if (base && base !== name) return glyphToUnicode(base);
  return null;
}

function utf16be(s) {
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return out;
}

function decodeTextString(s) {
  if (!s) return '';
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) return utf16be(s.slice(2));
  if (s.startsWith('\xef\xbb\xbf')) { try { return new TextDecoder('utf-8').decode(Uint8Array.from(s.slice(3), (c) => c.charCodeAt(0))); } catch (e) { /* ignore */ } }
  return s;
}

function parseCMap(text) {
  const map = new Map();
  const ranges = []; // codespace: [len, lo, hi]
  const hexes = (str) => [...str.matchAll(/<([0-9a-fA-F\s]*)>|\[|\]/g)];
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const hs = [...m[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
    for (let i = 0; i + 1 < hs.length; i += 2) ranges.push([hs[i].length / 2, parseInt(hs[i], 16), parseInt(hs[i + 1], 16)]);
  }
  const hexToStr = (h) => { h = h.replace(/\s+/g, ''); if (h.length % 4 === 2) h = '00' + h; let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return s; };
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const hs = [...m[1].matchAll(/<([0-9a-fA-F\s]*)>/g)].map((x) => x[1]);
    for (let i = 0; i + 1 < hs.length; i += 2) map.set(parseInt(hs[i].replace(/\s+/g, ''), 16), hexToStr(hs[i + 1]));
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const toks = hexes(m[1]);
    let i = 0;
    while (i + 2 < toks.length) {
      const lo = parseInt(toks[i][1], 16);
      const hi = parseInt(toks[i + 1][1], 16);
      if (Number.isNaN(lo) || Number.isNaN(hi) || hi - lo > 65535) { i++; continue; }
      if (toks[i + 2][0] === '[') {
        let j = i + 3;
        let code = lo;
        while (j < toks.length && toks[j][0] !== ']') { map.set(code++, hexToStr(toks[j][1])); j++; }
        i = j + 1;
      } else {
        const dst = hexToStr(toks[i + 2][1]);
        for (let code = lo; code <= hi; code++) {
          const last = dst.charCodeAt(dst.length - 1) + (code - lo);
          map.set(code, dst.slice(0, -1) + String.fromCharCode(last));
        }
        i += 3;
      }
    }
  }
  if (!ranges.length) {
    const maxCode = Math.max(0, ...map.keys());
    ranges.push(maxCode > 255 ? [2, 0, 0xffff] : [1, 0, 0xff]);
  }
  return { map, ranges };
}

// ---- Matrices ----
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const ID = [1, 0, 0, 1, 0, 0];

export class PdfDoc {
  constructor(bytes) {
    this.b = bytes;
    this.s = bytesToLatin1(bytes);
    this.objs = new Map(); // num -> {pos, value} or {objstm, index}
    this.cache = new Map();
    this.fonts = new Map();
  }

  index() {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    const objStms = [];
    while ((m = re.exec(s))) {
      const num = +m[1];
      const lx = new Lexer(this.b, m.index + m[0].length);
      let value;
      try { value = parseValue(lx); } catch (e) { continue; }
      const after = lx.tell();
      if (value instanceof Dict) {
        const k = s.indexOf('stream', after);
        const endobj = s.indexOf('endobj', after);
        if (k >= 0 && (endobj < 0 || k < endobj) && /^\s*$/.test(s.slice(after, k))) {
          let start = k + 6;
          if (s[start] === '\r') start++;
          if (s[start] === '\n') start++;
          let end = -1;
          const L = value.get('Length');
          if (typeof L === 'number' && start + L <= s.length && /^\s*endstream/.test(s.slice(start + L, start + L + 20))) end = start + L;
          if (end < 0) {
            end = s.indexOf('endstream', start);
            if (end < 0) end = s.length;
            if (s[end - 1] === '\n') end--;
            if (s[end - 1] === '\r') end--;
          }
          value = new Stream(value, this.b, start, end);
          re.lastIndex = Math.max(re.lastIndex, end);
          if (value.dict.get('Type') instanceof Name && value.dict.get('Type').n === 'ObjStm') objStms.push([num, m.index]);
        }
      }
      this.objs.set(num, { pos: m.index, value });
    }
    this.objStms = objStms;
  }

  async expandObjectStreams() {
    for (const [num, pos] of this.objStms) {
      const st = this.objs.get(num) && this.objs.get(num).value;
      if (!(st instanceof Stream)) continue;
      let data;
      try { data = await this.decode(st); } catch (e) { continue; }
      if (!data) continue;
      const n = st.dict.get('N') || 0;
      const first = st.dict.get('First') || 0;
      const lx = new Lexer(data, 0, first);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const on = lx.next();
        const off = lx.next();
        if (typeof on !== 'number' || typeof off !== 'number') break;
        pairs.push([on, off]);
      }
      for (const [on, off] of pairs) {
        const existing = this.objs.get(on);
        if (existing && existing.pos > pos) continue;
        try {
          const v = parseValue(new Lexer(data, first + off));
          this.objs.set(on, { pos, value: v });
        } catch (e) { /* skip */ }
      }
    }
  }

  get(v) {
    let guard = 0;
    while (v instanceof Ref && guard++ < 32) {
      const o = this.objs.get(v.num);
      v = o ? o.value : null;
    }
    return v;
  }

  async decode(st) {
    if (!(st instanceof Stream)) return null;
    const key = st.start;
    if (this.cache.has(key)) return this.cache.get(key);
    let data = st.bytes.subarray(st.start, st.end);
    let filters = this.get(st.dict.get('Filter'));
    let parms = this.get(st.dict.get('DecodeParms'));
    if (!filters) filters = [];
    if (!Array.isArray(filters)) filters = [filters];
    if (!Array.isArray(parms)) parms = [parms];
    for (let i = 0; i < filters.length; i++) {
      const f = this.get(filters[i]);
      const name = f instanceof Name ? f.n : '';
      const p = this.get(parms[i]);
      if (name === 'FlateDecode' || name === 'Fl') data = unpredict(await inflate(data), p instanceof Dict ? p : null);
      else if (name === 'LZWDecode' || name === 'LZW') data = unpredict(lzwDecode(data, p instanceof Dict && p.get('EarlyChange') === 0 ? 0 : 1), p instanceof Dict ? p : null);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data);
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else { data = null; break; } // image codecs etc.
    }
    this.cache.set(key, data);
    return data;
  }

  trailer() {
    const s = this.s;
    let root = null;
    let info = null;
    let encrypt = null;
    let idx = s.lastIndexOf('trailer');
    while (idx >= 0) {
      try {
        const d = parseValue(new Lexer(this.b, idx + 7));
        if (d instanceof Dict) {
          root = root || d.get('Root');
          info = info || d.get('Info');
          encrypt = encrypt || d.get('Encrypt');
          if (root) break;
        }
      } catch (e) { /* ignore */ }
      idx = s.lastIndexOf('trailer', idx - 1);
    }
    if (!root) {
      // Cross-reference streams carry the trailer keys in their dictionary.
      let best = null;
      for (const [, o] of this.objs) {
        const v = o.value;
        if (v instanceof Stream && v.dict.get('Type') instanceof Name && v.dict.get('Type').n === 'XRef' && (!best || o.pos > best.pos)) best = { pos: o.pos, d: v.dict };
      }
      if (best) { root = best.d.get('Root'); info = best.d.get('Info'); encrypt = best.d.get('Encrypt'); }
    }
    if (!root) {
      for (const [num, o] of this.objs) if (o.value instanceof Dict && o.value.get('Type') instanceof Name && o.value.get('Type').n === 'Catalog') root = new Ref(num, 0);
    }
    return { root, info, encrypt };
  }

  pages(root) {
    const out = [];
    const cat = this.get(root);
    const seen = new Set();
    const walk = (node, inherited, depth) => {
      const n = this.get(node);
      if (!(n instanceof Dict) || depth > 64) return;
      if (node instanceof Ref) { if (seen.has(node.num)) return; seen.add(node.num); }
      const res = n.get('Resources') !== undefined ? n.get('Resources') : inherited;
      const kids = this.get(n.get('Kids'));
      const type = n.get('Type') instanceof Name ? n.get('Type').n : '';
      if (Array.isArray(kids) && type !== 'Page') { for (const k of kids) walk(k, res, depth + 1); return; }
      out.push({ dict: n, resources: this.get(res) });
    };
    if (cat instanceof Dict) walk(cat.get('Pages'), null, 0);
    if (!out.length) {
      for (const [, o] of this.objs) if (o.value instanceof Dict && o.value.get('Type') instanceof Name && o.value.get('Type').n === 'Page') out.push({ dict: o.value, resources: this.get(o.value.get('Resources')) });
    }
    return out;
  }

  async font(ref) {
    const key = ref instanceof Ref ? 'r' + ref.num : null;
    if (key && this.fonts.has(key)) return this.fonts.get(key);
    const fd = this.get(ref);
    const font = { bytes: 1, map: null, enc: baseEncoding('WinAnsiEncoding'), widths: null, firstChar: 0, dw: 1000, cidWidths: null, ranges: null, utf16: false, type0: false };
    if (fd instanceof Dict) {
      const subtype = fd.get('Subtype') instanceof Name ? fd.get('Subtype').n : '';
      const tu = this.get(fd.get('ToUnicode'));
      if (tu instanceof Stream) {
        const data = await this.decode(tu);
        if (data) { const cm = parseCMap(bytesToLatin1(data)); font.map = cm.map; font.ranges = cm.ranges; }
      }
      if (subtype === 'Type0') {
        font.type0 = true;
        font.bytes = 2;
        const enc = this.get(fd.get('Encoding'));
        if (enc instanceof Name && /UCS2|UTF16/.test(enc.n)) font.utf16 = true;
        const desc = this.get((this.get(fd.get('DescendantFonts')) || [])[0]);
        if (desc instanceof Dict) {
          font.dw = this.get(desc.get('DW')) || 1000;
          const W = this.get(desc.get('W'));
          if (Array.isArray(W)) {
            font.cidWidths = new Map();
            for (let i = 0; i < W.length;) {
              const c = this.get(W[i]);
              const nx = this.get(W[i + 1]);
              if (Array.isArray(nx)) { nx.forEach((w, k) => font.cidWidths.set(c + k, this.get(w))); i += 2; }
              else { const w = this.get(W[i + 2]); for (let k = c; k <= nx && k - c < 65536; k++) font.cidWidths.set(k, w); i += 3; }
            }
          }
        }
      } else {
        const enc = this.get(fd.get('Encoding'));
        if (enc instanceof Name) font.enc = baseEncoding(enc.n);
        else if (enc instanceof Dict) {
          const be = enc.get('BaseEncoding');
          font.enc = baseEncoding(be instanceof Name ? be.n : 'StandardEncoding');
          const diffs = this.get(enc.get('Differences'));
          if (Array.isArray(diffs)) {
            let code = 0;
            for (const d0 of diffs) {
              const d = this.get(d0);
              if (typeof d === 'number') code = d;
              else if (d instanceof Name) { const u = glyphToUnicode(d.n); if (u !== null) font.enc[code] = u; code++; }
            }
          }
        }
        const W = this.get(fd.get('Widths'));
        if (Array.isArray(W)) { font.widths = W.map((w) => this.get(w)); font.firstChar = this.get(fd.get('FirstChar')) || 0; }
        if (font.ranges && font.ranges.every((r) => r[0] === 2)) font.bytes = 2;
        else font.ranges = null;
      }
    }
    if (key) this.fonts.set(key, font);
    return font;
  }
}

// Split a shown string into codes according to the font's code space.
function codesOf(font, s) {
  const codes = [];
  if (font.ranges && font.ranges.length && !(font.ranges.length === 1)) {
    for (let i = 0; i < s.length;) {
      let matched = false;
      for (let n = 1; n <= 4 && i + n <= s.length; n++) {
        let c = 0;
        for (let k = 0; k < n; k++) c = (c << 8) | s.charCodeAt(i + k);
        if (font.ranges.some((r) => r[0] === n && c >= r[1] && c <= r[2])) { codes.push(c); i += n; matched = true; break; }
      }
      if (!matched) { codes.push(s.charCodeAt(i)); i++; }
    }
    return codes;
  }
  const n = font.ranges && font.ranges.length === 1 ? font.ranges[0][0] : font.bytes;
  for (let i = 0; i < s.length; i += n) {
    let c = 0;
    for (let k = 0; k < n; k++) c = (c << 8) | (s.charCodeAt(i + k) || 0);
    codes.push(c);
  }
  return codes;
}

function codeText(font, code) {
  if (font.map) { const u = font.map.get(code); if (u !== undefined) return u.replace(/\u0000/g, ''); }
  if (font.type0) return font.utf16 ? String.fromCharCode(code) : '';
  return font.enc[code] !== undefined ? font.enc[code] : '';
}

function codeWidth(font, code) {
  if (font.type0) return font.cidWidths && font.cidWidths.has(code) ? font.cidWidths.get(code) : font.dw;
  if (font.widths) { const w = font.widths[code - font.firstChar]; if (typeof w === 'number' && w > 0) return w; }
  return code === 32 ? 250 : 500;
}

export async function pageLines(doc, page) {
  const lines = []; // {text, size, x, y}
  let cur = null;
  let lastEnd = null; // device coords of where the last glyph run ended
  const startLine = (x, y, size, gap) => { if (cur && cur.text.trim()) lines.push(cur); cur = { text: '', size, x, y, gap }; };
  const visited = new Set();

  async function run(bytes, resources, ctm0, depth) {
    if (!bytes || depth > 6) return;
    const fontsDict = doc.get(resources instanceof Dict ? resources.get('Font') : null);
    const xobjs = doc.get(resources instanceof Dict ? resources.get('XObject') : null);
    const lx = new Lexer(bytes);
    const stack = [];
    let ctm = ctm0;
    const gstack = [];
    let font = null;
    let fontSize = 12;
    let tm = ID;
    let tlm = ID;
    let leading = 0;
    let charSp = 0;
    let wordSp = 0;
    let hScale = 1;
    let rise = 0;
    const show = (str) => {
      if (!font) return;
      const trm = mul([fontSize * hScale, 0, 0, fontSize, 0, rise], mul(tm, ctm));
      const x = trm[4];
      const y = trm[5];
      const size = Math.hypot(trm[2], trm[3]) || Math.abs(fontSize);
      if (!cur || !lastEnd) startLine(x, y, size, 0);
      else {
        const dy = Math.abs(y - lastEnd.y);
        if (dy > Math.max(size, cur.size) * 0.5) startLine(x, y, size, dy / Math.max(1, Math.max(size, cur.size)));
        else {
          const gap = x - lastEnd.x;
          if ((gap > size * 0.2 || gap < -size * 2) && !/\s$/.test(cur.text)) cur.text += ' ';
        }
      }
      if (size > cur.size) cur.size = size;
      let adv = 0;
      for (const code of codesOf(font, str)) {
        const t = codeText(font, code);
        cur.text += t;
        const w = codeWidth(font, code) / 1000;
        adv += (w * fontSize + charSp + (code === 32 && font.bytes === 1 ? wordSp : 0)) * hScale;
      }
      tm = mul([1, 0, 0, 1, adv, 0], tm);
      const end = mul(tm, ctm);
      lastEnd = { x: end[4], y };
    };
    for (;;) {
      const t = lx.next();
      if (t === EOF) break;
      if (!(t instanceof Cmd)) { stack.push(t); continue; }
      const op = t.c;
      if (op === '[') {
        // Arrays (TJ operands): collect until ']'.
        const arr = [];
        for (;;) { const x = lx.next(); if (x === EOF || (x instanceof Cmd && x.c === ']')) break; arr.push(x); }
        stack.push(arr);
        continue;
      }
      if (op === '<<') { // inline dict (BDC properties)
        let depthD = 1;
        while (depthD) { const x = lx.next(); if (x === EOF) break; if (x instanceof Cmd) { if (x.c === '<<') depthD++; else if (x.c === '>>') depthD--; } }
        stack.push(null);
        continue;
      }
      switch (op) {
        case 'q': gstack.push(ctm); break;
        case 'Q': ctm = gstack.length ? gstack.pop() : ctm0; break;
        case 'cm': if (stack.length >= 6) ctm = mul(stack.slice(-6), ctm); break;
        case 'BT': tm = ID; tlm = ID; break;
        case 'ET': break;
        case 'Tf': {
          const name = stack[stack.length - 2];
          fontSize = stack[stack.length - 1] || fontSize;
          if (name instanceof Name && fontsDict instanceof Dict) font = await doc.font(fontsDict.get(name.n));
          break;
        }
        case 'Td': case 'TD': {
          const tx = stack[stack.length - 2] || 0;
          const ty = stack[stack.length - 1] || 0;
          if (op === 'TD') leading = -ty;
          tlm = mul([1, 0, 0, 1, tx, ty], tlm);
          tm = tlm;
          break;
        }
        case 'Tm': if (stack.length >= 6) { tlm = stack.slice(-6); tm = tlm; } break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
        case 'TL': leading = stack[stack.length - 1] || 0; break;
        case 'Tc': charSp = stack[stack.length - 1] || 0; break;
        case 'Tw': wordSp = stack[stack.length - 1] || 0; break;
        case 'Tz': hScale = (stack[stack.length - 1] || 100) / 100; break;
        case 'Ts': rise = stack[stack.length - 1] || 0; break;
        case 'Tj': { const s = stack[stack.length - 1]; if (s instanceof Str) show(s.s); break; }
        case "'": case '"': {
          if (op === '"') { wordSp = stack[stack.length - 3] || 0; charSp = stack[stack.length - 2] || 0; }
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm;
          const s = stack[stack.length - 1];
          if (s instanceof Str) show(s.s);
          break;
        }
        case 'TJ': {
          const arr = stack[stack.length - 1];
          if (Array.isArray(arr)) {
            for (const el of arr) {
              if (el instanceof Str) show(el.s);
              else if (typeof el === 'number') {
                const dx = (-el / 1000) * fontSize * hScale;
                tm = mul([1, 0, 0, 1, dx, 0], tm);
                if (el < -180 && cur && !/\s$/.test(cur.text)) cur.text += ' ';
                if (lastEnd) lastEnd.x = mul(tm, ctm)[4];
              }
            }
          }
          break;
        }
        case 'Do': {
          const name = stack[stack.length - 1];
          if (!(name instanceof Name) || !(xobjs instanceof Dict)) break;
          const ref = xobjs.get(name.n);
          const xo = doc.get(ref);
          if (!(xo instanceof Stream)) break;
          const st = xo.dict.get('Subtype');
          if (!(st instanceof Name) || st.n !== 'Form') break;
          const k = ref instanceof Ref ? ref.num : xo.start;
          if (visited.has(k)) break;
          visited.add(k);
          const mtx = doc.get(xo.dict.get('Matrix'));
          const res = doc.get(xo.dict.get('Resources')) || resources;
          await run(await doc.decode(xo), res, Array.isArray(mtx) && mtx.length === 6 ? mul(mtx, ctm) : ctm, depth + 1);
          visited.delete(k);
          break;
        }
        case 'BI': {
          // Inline image: skip binary data between ID and EI.
          let p = lx.pos;
          const b = bytes;
          while (p < b.length - 1 && !(b[p] === 73 && b[p + 1] === 68 && isWs(b[p + 2]) && (p === 0 || isWs(b[p - 1])))) p++;
          p += 3;
          while (p < b.length - 2 && !(isWs(b[p - 1]) && b[p] === 69 && b[p + 1] === 73 && (p + 2 >= b.length || isWs(b[p + 2]) ))) p++;
          lx.pos = p + 2;
          lx.peeked = [];
          lx.peekedPos = [];
          break;
        }
        default: break;
      }
      stack.length = 0;
    }
  }

  const contents = doc.get(page.dict.get('Contents'));
  const parts = Array.isArray(contents) ? contents.map((c) => doc.get(c)) : [contents];
  const chunks = [];
  for (const p of parts) { const d = await doc.decode(p); if (d) chunks.push(d); }
  const total = chunks.reduce((a, c) => a + c.length + 1, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; all[off++] = 10; }
  await run(all, page.resources, ID, 0);
  if (cur && cur.text.trim()) lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

/** Group lines into paragraphs and headings. */
function linesToBlocks(pages) {
  // Lines repeated on many pages (running headers/footers) are noise.
  const freq = new Map();
  for (const lines of pages) for (const t of new Set(lines.map((l) => l.text.replace(/\d+/g, '#')))) freq.set(t, (freq.get(t) || 0) + 1);
  const repeatLimit = pages.length >= 3 ? Math.max(3, pages.length * 0.5) : Infinity;
  const sizes = [];
  for (const lines of pages) for (const l of lines) if (l.text.length > 30) sizes.push(Math.round(l.size * 2) / 2);
  sizes.sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 12;
  const blocks = [];
  pages.forEach((lines, pi) => {
    const kept = lines.filter((l) => !(freq.get(l.text.replace(/\d+/g, '#')) >= repeatLimit) && !/^(page )?\d+( of \d+)?$/i.test(l.text));
    const maxLen = Math.max(40, ...kept.map((l) => l.text.length));
    let para = null;
    const flush = () => { if (para) blocks.push(para); para = null; };
    for (const l of kept) {
      const isHeading = l.size >= body * 1.18 && l.text.length < 120 && !/[.,;]$/.test(l.text);
      if (isHeading) {
        const prev = blocks[blocks.length - 1];
        flush();
        if (prev && prev.type === 'heading' && prev.page === pi && Math.abs(prev.size - l.size) < 0.5 && (l.gap || 0) < 2) { prev.text += ' ' + l.text; continue; }
        const level = l.size >= body * 1.8 ? 1 : l.size >= body * 1.4 ? 2 : 3;
        blocks.push({ type: 'heading', level, text: l.text, page: pi, size: l.size });
        continue;
      }
      const bigGap = (l.gap || 0) > 1.9;
      if (para && !bigGap) {
        const prevLine = para._last;
        const endsSentence = /[.!?:"”)]$/.test(prevLine);
        const shortPrev = prevLine.length < maxLen * 0.7;
        if (endsSentence && shortPrev) { flush(); }
        else if (/^[••\-–*]\s/.test(l.text) || /^\d+[.)]\s/.test(l.text)) { flush(); }
      } else if (para && bigGap) flush();
      if (!para) para = { type: /^[••\-–*]\s/.test(l.text) ? 'li' : 'p', text: '', page: pi, _last: '' };
      if (para.text && /\p{L}-$/u.test(para.text) && /^\p{Ll}/u.test(l.text)) para.text = para.text.slice(0, -1) + l.text;
      else para.text += (para.text ? ' ' : '') + l.text;
      para._last = l.text;
    }
    flush();
  });
  return blocks.map(({ _last, size, ...b }) => ({ ...b, text: b.type === 'li' ? b.text.replace(/^[••\-–*]\s*/, '') : b.text }));
}

export function isPdfBytes(bytes) {
  const head = bytesToLatin1(bytes, 0, Math.min(1024, bytes.length));
  return head.includes('%PDF-');
}

/**
 * Extract text from a PDF. Returns { title, pageCount, blocks: [{type, text, page, level?}] }.
 * Throws with a readable message for encrypted or image-only files.
 */
export async function extractPdf(buffer, { maxPages = 400 } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!isPdfBytes(bytes)) throw new Error('This file is not a PDF.');
  const doc = new PdfDoc(bytes);
  doc.index();
  await doc.expandObjectStreams();
  const { root, info, encrypt } = doc.trailer();
  if (encrypt) throw new Error('This PDF is encrypted, so its text cannot be read.');
  const pages = doc.pages(root);
  const pageLinesAll = [];
  for (const p of pages.slice(0, maxPages)) {
    try { pageLinesAll.push(await pageLines(doc, p)); } catch (e) { pageLinesAll.push([]); }
  }
  const blocks = linesToBlocks(pageLinesAll);
  const infoD = doc.get(info);
  let title = '';
  if (infoD instanceof Dict) { const t = doc.get(infoD.get('Title')); if (t instanceof Str) title = decodeTextString(t.s).trim(); }
  const chars = blocks.reduce((a, b) => a + b.text.length, 0);
  if (!chars) throw new Error(pages.length ? 'No selectable text found. This PDF may be a scanned image.' : 'Could not read this PDF.');
  return { title, pageCount: pages.length, blocks, truncated: pages.length > maxPages };
}
