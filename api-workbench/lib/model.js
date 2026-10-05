// Data model: requests, key/value rows, defaults and normalisation.
import { uid } from './util.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const BODY_MODES = [
  ['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['xml', 'XML'],
  ['urlencoded', 'x-www-form-urlencoded'], ['formdata', 'Form data'], ['binary', 'Binary'],
];
export const AUTH_TYPES = [
  ['inherit', 'Inherit from parent'], ['none', 'No auth'], ['bearer', 'Bearer token'],
  ['basic', 'Basic auth'], ['apikey', 'API key'], ['oauth2', 'OAuth 2.0 (client credentials)'],
];

export const kv = (key = '', value = '', extra = {}) => ({ id: uid(), key, value, enabled: true, description: '', ...extra });

export function newAuth(type = 'none') {
  return {
    type,
    bearer: { token: '', prefix: 'Bearer' },
    basic: { username: '', password: '' },
    apikey: { key: 'X-API-Key', value: '', in: 'header' },
    oauth2: {
      tokenUrl: '', clientId: '', clientSecret: '', scope: '', audience: '',
      clientAuth: 'header', headerPrefix: 'Bearer', autoRefresh: true,
      accessToken: '', tokenType: '', expiresAt: 0,
    },
  };
}

export function newRequest(over = {}) {
  return normalizeRequest({ method: 'GET', url: '', ...over });
}

export function normalizeRequest(r = {}) {
  const a = newAuth(r.auth?.type || 'inherit');
  const auth = r.auth ? {
    ...a, ...r.auth,
    bearer: { ...a.bearer, ...r.auth.bearer }, basic: { ...a.basic, ...r.auth.basic },
    apikey: { ...a.apikey, ...r.auth.apikey }, oauth2: { ...a.oauth2, ...r.auth.oauth2 },
  } : a;
  const rows = list => (Array.isArray(list) ? list : []).map(x => ({ ...kv(), ...x, id: x.id || uid() }));
  const body = r.body || {};
  return {
    method: (r.method || 'GET').toUpperCase(),
    url: r.url || '',
    params: rows(r.params),
    headers: rows(r.headers),
    body: {
      mode: body.mode || 'none',
      json: body.json ?? '',
      text: body.text ?? '',
      xml: body.xml ?? '',
      urlencoded: rows(body.urlencoded),
      formdata: rows(body.formdata).map(x => ({ type: 'text', ...x })),
      binary: body.binary || null,
    },
    auth,
    tests: (r.tests || []).map(t => ({ id: uid(), enabled: true, type: 'status', target: '', op: 'eq', expected: '', ...t })),
    extract: (r.extract || []).map(t => ({ id: uid(), enabled: true, source: 'json', path: '', variable: '', scope: 'env', ...t })),
    settings: { timeout: 0, followRedirects: true, ...(r.settings || {}) },
    description: r.description || '',
  };
}

export function newCollection(name = 'New collection') {
  return { id: uid(), type: 'collection', name, description: '', auth: newAuth('none'), variables: [], items: [] };
}
export function newFolder(name = 'New folder') {
  return { id: uid(), type: 'folder', name, description: '', auth: newAuth('inherit'), items: [] };
}
export function newRequestItem(name = 'New request', request = newRequest()) {
  return { id: uid(), type: 'request', name, request };
}

export function defaultSettings() {
  return {
    timeout: 30000,
    followRedirects: true,
    sendCookies: true,
    historyLimit: 100,
    layout: 'auto', // auto | side | stacked
    theme: 'system',
    wrapResponse: false,
    autoContentType: true,
    jsonViewer: { enabled: true, defaultView: 'tree', expandDepth: 3 },
  };
}

/** Requests are named from method + path when they have no explicit name. */
export function autoName(req) {
  const u = (req.url || '').replace(/^\w+:\/\//, '').replace(/\?.*$/, '');
  const path = u.slice(u.indexOf('/') >= 0 ? u.indexOf('/') : u.length) || u;
  return u ? `${req.method} ${path || '/'}` : 'Untitled request';
}

/** Deep clone giving every row, item and folder a fresh id. */
export function cloneFresh(obj) {
  const c = structuredClone(obj);
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if ('id' in o) o.id = uid();
      for (const v of Object.values(o)) walk(v);
    }
  })(c);
  return c;
}
