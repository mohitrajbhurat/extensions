// Declarative assertions and variable extraction, evaluated without eval().
import { getPath } from './jsonpath.js';
import { deepEqual } from './util.js';

export const ASSERT_TYPES = [
  ['status', 'Status code'],
  ['time', 'Response time (ms)'],
  ['json', 'JSON path'],
  ['header', 'Header'],
  ['body', 'Body text'],
  ['size', 'Body size (bytes)'],
];

export const OPS = [
  ['eq', 'equals'], ['neq', 'not equals'], ['contains', 'contains'], ['notContains', 'does not contain'],
  ['exists', 'exists'], ['notExists', 'does not exist'], ['lt', 'less than'], ['lte', 'at most'],
  ['gt', 'greater than'], ['gte', 'at least'], ['matches', 'matches regex'], ['type', 'is type'],
  ['empty', 'is empty'], ['notEmpty', 'is not empty'],
];
export const NO_EXPECTED = new Set(['exists', 'notExists', 'empty', 'notEmpty']);
export const TARGETED = new Set(['json', 'header']);

/** ctx: { status, time, size, headers: [[k,v]], text, json, jsonOk } */
function actualFor(a, ctx) {
  switch (a.type) {
    case 'status': return { found: true, value: ctx.status };
    case 'time': return { found: true, value: Math.round(ctx.time) };
    case 'size': return { found: true, value: ctx.size };
    case 'body': return { found: true, value: ctx.text };
    case 'header': {
      const name = (a.target || '').trim().toLowerCase();
      const vals = ctx.headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
      return vals.length ? { found: true, value: vals.join(', ') } : { found: false };
    }
    case 'json':
      if (!ctx.jsonOk) return { found: false, error: 'Response is not valid JSON' };
      return getPath(ctx.json, a.target || '$');
    default: return { found: false, error: 'Unknown assertion type' };
  }
}

function parseExpected(s) {
  const t = String(s ?? '').trim();
  try { return { parsed: true, value: JSON.parse(t) }; } catch { return { parsed: false, value: t }; }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function toNum(v) { const n = typeof v === 'number' ? v : parseFloat(v); return n; }

export function describe(a) {
  const t = ASSERT_TYPES.find(x => x[0] === a.type)?.[1] || a.type;
  const op = OPS.find(x => x[0] === a.op)?.[1] || a.op;
  const target = TARGETED.has(a.type) ? ` ${a.target || (a.type === 'json' ? '$' : '')}` : '';
  return `${t}${target} ${op}${NO_EXPECTED.has(a.op) ? '' : ' ' + (a.expected ?? '')}`;
}

export function evaluate(assertions, ctx) {
  return (assertions || []).filter(a => a.enabled !== false).map(a => {
    const res = { id: a.id, label: describe(a), pass: false, actual: undefined, message: '' };
    try {
      const act = actualFor(a, ctx);
      res.actual = act.found ? act.value : undefined;
      if (act.error) { res.message = act.error; return res; }
      const v = act.value, exp = a.expected;
      switch (a.op) {
        case 'exists': res.pass = act.found && v !== undefined; break;
        case 'notExists': res.pass = !act.found; break;
        case 'eq': case 'neq': {
          if (!act.found) { res.pass = a.op === 'neq'; break; }
          const p = parseExpected(exp);
          let eq = p.parsed ? deepEqual(v, p.value) : false;
          if (!eq) eq = String(typeof v === 'object' ? JSON.stringify(v) : v) === String(exp ?? '').trim();
          res.pass = a.op === 'eq' ? eq : !eq; break;
        }
        case 'contains': case 'notContains': {
          let has = false;
          if (act.found) {
            if (Array.isArray(v)) { const p = parseExpected(exp); has = v.some(x => deepEqual(x, p.value) || String(x) === String(exp)); }
            else has = String(typeof v === 'object' ? JSON.stringify(v) : v).includes(String(exp ?? ''));
          }
          res.pass = a.op === 'contains' ? has : !has; break;
        }
        case 'lt': case 'lte': case 'gt': case 'gte': {
          const x = toNum(v), y = toNum(exp);
          if (!act.found || isNaN(x) || isNaN(y)) { res.message = 'Not a number'; break; }
          res.pass = a.op === 'lt' ? x < y : a.op === 'lte' ? x <= y : a.op === 'gt' ? x > y : x >= y; break;
        }
        case 'matches': {
          if (!act.found) break;
          const m = /^\/(.*)\/([a-z]*)$/s.exec(String(exp ?? ''));
          const re = m ? new RegExp(m[1], m[2]) : new RegExp(String(exp ?? ''));
          res.pass = re.test(String(typeof v === 'object' ? JSON.stringify(v) : v)); break;
        }
        case 'type': res.pass = act.found && typeOf(v) === String(exp || '').trim().toLowerCase(); break;
        case 'empty': case 'notEmpty': {
          const empty = !act.found || v == null || v === '' || (Array.isArray(v) && !v.length)
            || (typeof v === 'object' && v && !Array.isArray(v) && !Object.keys(v).length);
          res.pass = a.op === 'empty' ? empty : !empty; break;
        }
        default: res.message = 'Unknown operator';
      }
      if (!res.pass && !res.message) res.message = act.found ? `Actual: ${short(v)}` : 'Not found';
    } catch (e) {
      res.message = e.message;
    }
    return res;
  });
}

export function short(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

/** Variable extraction rules: { source: json|header|status|body, path, variable, scope } */
export function extract(rules, ctx) {
  const out = [];
  for (const r of rules || []) {
    if (r.enabled === false || !r.variable) continue;
    let found = false, value;
    if (r.source === 'json' && ctx.jsonOk) ({ found, value } = getPath(ctx.json, r.path || '$'));
    else if (r.source === 'header') {
      const h = ctx.headers.find(([k]) => k.toLowerCase() === String(r.path || '').trim().toLowerCase());
      if (h) { found = true; value = h[1]; }
    } else if (r.source === 'status') { found = true; value = ctx.status; }
    else if (r.source === 'body') { found = true; value = ctx.text; }
    if (found) out.push({ variable: r.variable.trim(), scope: r.scope || 'env', value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
    else out.push({ variable: r.variable.trim(), scope: r.scope || 'env', missing: true });
  }
  return out;
}
