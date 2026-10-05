// Alert conditions. Pure functions shared by the service worker, UI pages and node:test.

export const CONDITION_TYPES = [
  { id: 'any', label: 'Any change', needsValue: false },
  { id: 'contains', label: 'Text contains', needsValue: true, placeholder: 'In stock' },
  { id: 'not_contains', label: 'Text does not contain', needsValue: true, placeholder: 'Sold out' },
  { id: 'above', label: 'Number goes above', needsValue: true, numeric: true, placeholder: '100' },
  { id: 'below', label: 'Number goes below', needsValue: true, numeric: true, placeholder: '49.99' },
  { id: 'regex', label: 'Matches regex', needsValue: true, placeholder: '\\bA\\+?\\b' },
];

const NUM_RE = /[-−]?\d{1,3}(?:[,.\u00a0\u202f\u2009']\d{3})+(?!\d)(?:[.,]\d+)?|[-−]?\d+(?:[.,]\d+)?|[-−]?[.,]\d+/;

/** Parse one number token such as "1,299.99", "1.299,99", "1 299", "-3.5". */
export function parseNumberToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[\u00a0\u202f\u2009' ]/g, '').replace('−', '-');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the later one is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const commas = s.split(',').length - 1;
    const after = s.length - lastComma - 1;
    s = commas === 1 && after !== 3 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot !== -1) {
    const dots = s.split('.').length - 1;
    if (dots > 1) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** First number found in a text, or null. */
export function extractNumber(text) {
  if (!text) return null;
  const m = String(text).match(NUM_RE);
  return m ? parseNumberToken(m[0]) : null;
}

/** Build a RegExp from "pattern" or "/pattern/flags". Throws on invalid input. */
export function buildRegex(src) {
  const s = String(src || '');
  const m = s.match(/^\/(.+)\/([dgimsuvy]*)$/s);
  if (m) return new RegExp(m[1], m[2].replace('g', ''));
  return new RegExp(s, 'i');
}

/** Returns an error message for an invalid condition, or '' when valid. */
export function validateCondition(cond) {
  const c = cond || { type: 'any' };
  const def = CONDITION_TYPES.find((t) => t.id === c.type);
  if (!def) return 'Unknown condition type';
  if (!def.needsValue) return '';
  const v = String(c.value ?? '').trim();
  if (!v) return 'Enter a value for the condition';
  if (def.numeric && parseNumberToken(v) == null) return 'Enter a valid number';
  if (c.type === 'regex') {
    try { buildRegex(v); } catch (e) { return 'Invalid regex: ' + e.message; }
  }
  return '';
}

/**
 * Evaluate a condition against the new text.
 * Returns { met, value } where value is the extracted number for numeric conditions.
 * A notification is sent when the content changed AND met is true.
 */
export function evaluateCondition(cond, text) {
  const c = cond || { type: 'any' };
  const t = String(text ?? '');
  const v = String(c.value ?? '');
  const cs = !!c.caseSensitive;
  const has = (needle) => (cs ? t.includes(needle) : t.toLowerCase().includes(needle.toLowerCase()));
  const number = extractNumber(t);
  switch (c.type) {
    case 'contains': return { met: v !== '' && has(v), value: number };
    case 'not_contains': return { met: v !== '' && !has(v), value: number };
    case 'above': {
      const th = parseNumberToken(v);
      return { met: number != null && th != null && number > th, value: number };
    }
    case 'below': {
      const th = parseNumberToken(v);
      return { met: number != null && th != null && number < th, value: number };
    }
    case 'regex': {
      try {
        const re = buildRegex(v);
        return { met: re.test(t), value: number };
      } catch {
        return { met: false, value: number, error: 'Invalid regex' };
      }
    }
    default: return { met: true, value: number };
  }
}

export function describeCondition(cond) {
  const c = cond || { type: 'any' };
  switch (c.type) {
    case 'contains': return `Text contains “${c.value}”`;
    case 'not_contains': return `Text does not contain “${c.value}”`;
    case 'above': return `Number above ${c.value}`;
    case 'below': return `Number below ${c.value}`;
    case 'regex': return `Matches /${String(c.value).replace(/^\/|\/[a-z]*$/g, '')}/`;
    default: return 'Any change';
  }
}

/** Normalise extracted text so whitespace-only noise never counts as a change. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
