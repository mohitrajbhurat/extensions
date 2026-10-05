// Variable interpolation: ${name}, ${row.column}, ${loop.index}, plus built-ins.

function pad(n) { return String(n).padStart(2, '0'); }

export function builtins() {
  const d = new Date();
  return {
    now: d.toISOString(),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    timestamp: String(d.getTime()),
    random: String(Math.floor(Math.random() * 1e6)),
  };
}

/** Looks up a dotted name in ctx. Exact keys win over nested lookups. */
export function lookup(ctx, name) {
  name = name.trim();
  if (Object.prototype.hasOwnProperty.call(ctx, name)) return ctx[name];
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot), rest = name.slice(dot + 1);
    const obj = ctx[head];
    if (obj && typeof obj === 'object') {
      if (Object.prototype.hasOwnProperty.call(obj, rest)) return obj[rest];
      // case-insensitive column match for CSV headers
      const key = Object.keys(obj).find(k => k.toLowerCase() === rest.toLowerCase());
      if (key !== undefined) return obj[key];
      if (rest === 'length' && Array.isArray(obj)) return obj.length;
    }
  }
  const b = builtins();
  if (name in b) return b[name];
  return undefined;
}

/** Replaces ${...} placeholders. Unknown names are collected in `missing`. */
export function interpolate(str, ctx, missing) {
  if (typeof str !== 'string' || !str.includes('${')) return str;
  return str.replace(/\$\{([^}]+)\}/g, (m, name) => {
    const v = lookup(ctx, name);
    if (v === undefined) { if (missing) missing.add(name.trim()); return ''; }
    return Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  });
}

export function matchText(actual, expected) {
  actual = String(actual ?? '');
  const re = /^\/(.+)\/([gimsuy]*)$/.exec(expected || '');
  if (re) { try { return new RegExp(re[1], re[2]).test(actual); } catch { return false; } }
  return actual.replace(/\s+/g, ' ').includes(String(expected).replace(/\s+/g, ' ').trim());
}
