// Keep the URL string and the query params table in sync without mangling {{vars}}.
import { kv } from './model.js';

export function splitUrl(url) {
  url = url || '';
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = noHash.indexOf('?');
  return q >= 0
    ? { base: noHash.slice(0, q), query: noHash.slice(q + 1), hasQuery: true, hash }
    : { base: noHash, query: '', hasQuery: false, hash };
}

export function parseQuery(query) {
  if (!query) return [];
  return query.split('&').filter((p, i, a) => p !== '' || i < a.length - 1).map(p => {
    const eq = p.indexOf('=');
    return eq >= 0 ? kv(p.slice(0, eq), p.slice(eq + 1)) : kv(p, '', { noEquals: true });
  });
}

export function buildQuery(params) {
  return params.filter(p => p.enabled && (p.key || p.value))
    .map(p => p.value === '' && p.noEquals ? p.key : `${p.key}=${p.value}`).join('&');
}

/** URL text changed: rebuild params, keeping disabled rows (and descriptions) the user had. */
export function paramsFromUrl(url, oldParams = []) {
  const parsed = parseQuery(splitUrl(url).query);
  const pool = oldParams.filter(p => p.enabled);
  for (const p of parsed) {
    const i = pool.findIndex(o => o.key === p.key);
    if (i >= 0) { const o = pool.splice(i, 1)[0]; p.id = o.id; p.description = o.description; }
  }
  const disabled = oldParams.filter(p => !p.enabled);
  return [...parsed, ...disabled];
}

/** Params table changed: rewrite the query part of the URL. */
export function urlFromParams(url, params) {
  const { base, hash } = splitUrl(url);
  const q = buildQuery(params);
  return base + (q ? '?' + q : '') + hash;
}

/** Encode a resolved URL for fetch, leaving valid %XX escapes alone. */
export function finalizeUrl(raw) {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  const u = new URL(s);
  return u;
}

export function appendQuery(u, key, value) {
  const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  u.search = u.search && u.search !== '?' ? `${u.search}&${pair}` : `?${pair}`;
  return u;
}
