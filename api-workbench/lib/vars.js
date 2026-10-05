// {{variable}} resolution with global < collection < environment precedence and dynamic vars.
import { uid } from './util.js';

const RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const DYNAMIC = {
  $guid: () => uid(),
  $randomUUID: () => uid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomEmail: () => `user${Math.floor(Math.random() * 1e6)}@example.com`,
};
export const DYNAMIC_NAMES = Object.keys(DYNAMIC);

/** Build a lookup Map from variable lists. Later sources win. */
export function buildScope(...lists) {
  const m = new Map();
  for (const list of lists) {
    for (const v of list || []) if (v && v.enabled !== false && v.key) m.set(v.key.trim(), v.value ?? '');
  }
  return m;
}

/** Replace {{vars}} (nested up to 6 levels). Missing names are collected in `missing`. */
export function resolve(str, scope, missing) {
  if (str == null) return '';
  let s = String(str);
  for (let depth = 0; depth < 6 && s.includes('{{'); depth++) {
    let changed = false;
    s = s.replace(RE, (whole, name) => {
      if (scope && scope.has(name)) { changed = true; return scope.get(name); }
      if (DYNAMIC[name]) { changed = true; return DYNAMIC[name](); }
      return whole;
    });
    if (!changed) break;
  }
  if (missing) for (const m of s.matchAll(RE)) missing.add(m[1]);
  return s;
}

export function findVars(str) {
  return [...String(str || '').matchAll(RE)].map(m => m[1]);
}
