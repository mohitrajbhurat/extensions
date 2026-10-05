// MediaRecorder writes WebM files without a Duration element, which makes them
// unseekable in many players and report "Infinity" duration in <video>.
// fixWebmDuration() inserts (or overwrites) Segment > Info > Duration.

function readVint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  if (first === undefined) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = bytes[pos + i];
    if (b === undefined) return null;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function encodeSize8(n) {
  // 8-byte vint: marker 0x01 followed by 7 bytes of value.
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
}

function float64(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return new Uint8Array(buf);
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

export async function fixWebmDuration(blob, durationMs) {
  if (!blob || !durationMs || !isFinite(durationMs)) return blob;
  try {
    const headLen = Math.min(blob.size, 256 * 1024);
    const bytes = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
    let pos = 0;
    const id0 = readVint(bytes, pos, true);
    if (!id0 || id0.value !== ID_EBML) return blob;
    pos += id0.len;
    const s0 = readVint(bytes, pos);
    pos += s0.len + s0.value;
    const segId = readVint(bytes, pos, true);
    if (!segId || segId.value !== ID_SEGMENT) return blob;
    pos += segId.len;
    const segSize = readVint(bytes, pos);
    if (!segSize) return blob;
    const segKnown = !segSize.unknown;
    pos += segSize.len;
    // Walk segment children until Info.
    while (pos < bytes.length) {
      const id = readVint(bytes, pos, true);
      if (!id) return blob;
      const size = readVint(bytes, pos + id.len);
      if (!size) return blob;
      const dataStart = pos + id.len + size.len;
      if (id.value === ID_INFO) {
        const dataEnd = dataStart + size.value;
        if (dataEnd > bytes.length) return blob;
        let scale = 1000000;
        let p = dataStart;
        let durationAt = -1;
        let durationLen = 0;
        while (p < dataEnd) {
          const cid = readVint(bytes, p, true);
          const csize = readVint(bytes, p + cid.len);
          const cdata = p + cid.len + csize.len;
          if (cid.value === ID_TIMECODE_SCALE) {
            let v = 0;
            for (let i = 0; i < csize.value; i++) v = v * 256 + bytes[cdata + i];
            if (v) scale = v;
          } else if (cid.value === ID_DURATION) {
            durationAt = cdata;
            durationLen = csize.value;
          }
          p = cdata + csize.value;
        }
        const value = durationMs * 1000000 / scale;
        if (durationAt >= 0) {
          const copy = bytes.slice(0, dataEnd);
          const view = new DataView(copy.buffer);
          if (durationLen === 8) view.setFloat64(durationAt, value);
          else if (durationLen === 4) view.setFloat32(durationAt, value);
          else return blob;
          return new Blob([copy, blob.slice(dataEnd)], { type: blob.type });
        }
        if (segKnown) return blob; // inserting would invalidate a known Segment size
        const durEl = new Uint8Array([0x44, 0x89, 0x88, ...float64(value)]);
        const content = bytes.slice(dataStart, dataEnd);
        const idBytes = bytes.slice(pos, pos + id.len);
        const newInfo = new Blob([idBytes, encodeSize8(content.length + durEl.length), content, durEl]);
        return new Blob([bytes.slice(0, pos), newInfo, blob.slice(dataEnd)], { type: blob.type });
      }
      if (size.unknown) return blob;
      pos = dataStart + size.value;
    }
  } catch (e) {
    console.warn('fixWebmDuration failed', e);
  }
  return blob;
}
