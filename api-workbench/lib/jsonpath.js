// Minimal JSON path: $.a.b[0]["c d"], a.b[-1], $.items.length, $.items[*].id
export function parsePath(path) {
  let s = String(path || '').trim();
  if (s.startsWith('$')) s = s.slice(1);
  const segs = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      i++;
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
      if (j > i) segs.push(s.slice(i, j));
      i = j;
    } else if (c === '[') {
      const end = findClose(s, i);
      if (end < 0) throw new Error('Unclosed [ in path');
      const inner = s.slice(i + 1, end).trim();
      if (inner === '*') segs.push({ wildcard: true });
      else if (/^-?\d+$/.test(inner)) segs.push(Number(inner));
      else if (/^(['"]).*\1$/s.test(inner)) segs.push(inner.slice(1, -1).replace(/\\(.)/g, '$1'));
      else segs.push(inner);
      i = end + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
      segs.push(s.slice(i, j));
      i = j;
    }
  }
  return segs;
}

function findClose(s, start) {
  let q = null;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ']') return i;
  }
  return -1;
}

/** Returns { found, value }. Wildcards collect into an array. */
export function getPath(obj, path) {
  let segs;
  try { segs = parsePath(path); } catch { return { found: false }; }
  let cur = [obj], multi = false;
  for (const seg of segs) {
    const next = [];
    for (const v of cur) {
      if (seg && seg.wildcard) {
        multi = true;
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === 'object') next.push(...Object.values(v));
      } else if (Array.isArray(v) && typeof seg === 'number') {
        const idx = seg < 0 ? v.length + seg : seg;
        if (idx >= 0 && idx < v.length) next.push(v[idx]);
      } else if (Array.isArray(v) && seg === 'length') next.push(v.length);
      else if (typeof v === 'string' && seg === 'length') next.push(v.length);
      else if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, String(seg))) next.push(v[String(seg)]);
    }
    cur = next;
    if (!cur.length && !multi) return { found: false };
  }
  if (multi) return { found: true, value: cur };
  return cur.length ? { found: true, value: cur[0] } : { found: false };
}

export function pathToString(segs) {
  return '$' + segs.map(s => typeof s === 'number' ? `[${s}]`
    : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`).join('');
}
