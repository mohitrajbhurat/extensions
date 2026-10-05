// Turn a request model into a concrete HTTP request, send it, and capture the response.
import { resolve } from './vars.js';
import { finalizeUrl, appendQuery } from './urlparams.js';
import { b64encodeUtf8 } from './util.js';
import { getFile } from './idb.js';
import { hasOrigin } from './perms.js';

// Headers fetch() refuses to set; these are applied with a short-lived declarativeNetRequest rule.
const FORBIDDEN = new Set(['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent']);
const UNSETTABLE = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect']);
export const isForbidden = name => FORBIDDEN.has(name.toLowerCase()) || /^(proxy-|sec-)/i.test(name);

/** Walk request -> folders -> collection until a non-inherit auth is found. ancestors: nearest first. */
export function effectiveAuth(request, ancestors = []) {
  if (request.auth && request.auth.type !== 'inherit') return { auth: request.auth, owner: null };
  for (const a of ancestors) if (a.auth && a.auth.type !== 'inherit') return { auth: a.auth, owner: a };
  return { auth: { type: 'none' }, owner: null };
}

export function oauthExpired(o) { return !o.accessToken || (o.expiresAt && Date.now() > o.expiresAt - 10000); }

export async function fetchOAuthToken(o, R = s => s) {
  const tokenUrl = R(o.tokenUrl).trim();
  if (!tokenUrl) throw new Error('OAuth 2.0: token URL is empty');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (o.scope) body.set('scope', R(o.scope));
  if (o.audience) body.set('audience', R(o.audience));
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const id = R(o.clientId), secret = R(o.clientSecret);
  if (o.clientAuth === 'body') { body.set('client_id', id); body.set('client_secret', secret); }
  else headers.Authorization = 'Basic ' + b64encodeUtf8(`${id}:${secret}`);
  let res;
  try { res = await fetch(finalizeUrl(tokenUrl).href, { method: 'POST', headers, body, credentials: 'omit', cache: 'no-store' }); }
  catch (e) { throw new Error(`OAuth 2.0 token request failed: ${e.message}${hasOrigin(tokenUrl) ? '' : ' (no host access to the token URL)'}`); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok || !data.access_token) throw new Error(`OAuth 2.0 token request failed (${res.status}): ${data.error_description || data.error || text.slice(0, 200)}`);
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
  };
}

/**
 * opts: { scope: Map, ancestors: [], settings, onToken(authObj, token) }
 * Returns a "prepared" request used for sending, history, code generation and display.
 */
export async function prepare(request, opts) {
  const { scope, ancestors = [], settings = {}, loadFiles = true } = opts;
  const missing = new Set();
  const R = s => resolve(s, scope, missing);
  const warnings = [];
  const urlText = R(request.url).trim();
  if (!urlText) throw new Error('Enter a request URL');
  let u;
  try { u = finalizeUrl(urlText); } catch { throw new Error(`Invalid URL: ${urlText}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Unsupported protocol ${u.protocol} (use http or https)`);

  const headers = request.headers.filter(h => h.enabled && h.key.trim()).map(h => [R(h.key).trim(), R(h.value)]);
  const hasHeader = name => headers.some(([k]) => k.toLowerCase() === name);

  // Auth
  const { auth } = effectiveAuth(request, ancestors);
  switch (auth.type) {
    case 'bearer': if (!hasHeader('authorization') && auth.bearer.token) headers.push(['Authorization', `${R(auth.bearer.prefix || 'Bearer')} ${R(auth.bearer.token)}`.trim()]); break;
    case 'basic': if (!hasHeader('authorization')) headers.push(['Authorization', 'Basic ' + b64encodeUtf8(`${R(auth.basic.username)}:${R(auth.basic.password)}`)]); break;
    case 'apikey': {
      const k = R(auth.apikey.key).trim(), v = R(auth.apikey.value);
      if (k) { if (auth.apikey.in === 'query') appendQuery(u, k, v); else if (!hasHeader(k.toLowerCase())) headers.push([k, v]); }
      break;
    }
    case 'oauth2': {
      const o = auth.oauth2;
      if (oauthExpired(o) && o.autoRefresh && o.tokenUrl && opts.onToken) {
        const tok = await fetchOAuthToken(o, R);
        Object.assign(o, tok);
        opts.onToken(auth, tok);
      }
      if (o.accessToken && !hasHeader('authorization')) headers.push(['Authorization', `${o.headerPrefix || 'Bearer'} ${o.accessToken}`.trim()]);
      else if (!o.accessToken) warnings.push('OAuth 2.0: no access token. Use "Get new token" in the Auth tab.');
      break;
    }
    default: break;
  }

  // Body
  const method = request.method;
  const b = request.body;
  let body = { kind: 'none' }, fetchBody;
  const auto = settings.autoContentType !== false;
  const setCT = ct => { if (auto && !hasHeader('content-type')) headers.push(['Content-Type', ct]); };
  if (b.mode !== 'none' && (method === 'GET' || method === 'HEAD')) {
    if (b.mode !== 'none') warnings.push(`${method} requests cannot carry a body in the browser; the body was not sent.`);
  } else if (b.mode === 'json' || b.mode === 'text' || b.mode === 'xml') {
    const text = R(b[b.mode]);
    body = { kind: 'text', text };
    fetchBody = text;
    setCT(b.mode === 'json' ? 'application/json' : b.mode === 'xml' ? 'application/xml' : 'text/plain');
    if (b.mode === 'json' && text.trim()) { try { JSON.parse(text); } catch (e) { warnings.push(`Body is not valid JSON: ${e.message}`); } }
  } else if (b.mode === 'urlencoded') {
    const sp = new URLSearchParams();
    for (const r of b.urlencoded) if (r.enabled && r.key) sp.append(R(r.key), R(r.value));
    body = { kind: 'urlencoded', text: sp.toString() };
    fetchBody = body.text;
    setCT('application/x-www-form-urlencoded');
  } else if (b.mode === 'formdata') {
    const fd = new FormData();
    const fields = [];
    for (const r of b.formdata) {
      if (!r.enabled || !r.key) continue;
      if (r.type === 'file') {
        const rec = r.fileId && loadFiles ? await getFile(r.fileId) : null;
        fields.push({ key: R(r.key), type: 'file', fileName: rec?.name || r.fileName || 'file' });
        if (rec) fd.append(R(r.key), rec.blob, rec.name);
        else if (loadFiles) warnings.push(`Form field "${r.key}": no file selected, sent empty.`);
        if (!rec && loadFiles) fd.append(R(r.key), new Blob([]), r.fileName || 'file');
      } else { fields.push({ key: R(r.key), type: 'text', value: R(r.value) }); fd.append(R(r.key), R(r.value)); }
    }
    body = { kind: 'formdata', fields };
    fetchBody = fd;
    const i = headers.findIndex(([k]) => k.toLowerCase() === 'content-type');
    if (i >= 0 && /multipart/i.test(headers[i][1])) { headers.splice(i, 1); warnings.push('Removed manual multipart Content-Type: the browser adds it with the boundary.'); }
  } else if (b.mode === 'binary') {
    const rec = b.binary?.fileId && loadFiles ? await getFile(b.binary.fileId) : null;
    body = { kind: 'binary', fileName: rec?.name || b.binary?.fileName || '' };
    if (rec) { fetchBody = rec.blob; setCT(rec.type || 'application/octet-stream'); }
    else if (loadFiles) warnings.push('Binary body: no file selected.');
  }

  const fetchHeaders = new Headers();
  const dnrHeaders = [];
  for (const [k, v] of headers) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) { warnings.push(`Skipped invalid header name "${k}"`); continue; }
    if (isForbidden(k)) {
      if (UNSETTABLE.has(k.toLowerCase())) warnings.push(`The browser controls the "${k}" header; it was not sent.`);
      else dnrHeaders.push([k, v]);
      continue;
    }
    try { fetchHeaders.append(k, v); } catch { warnings.push(`Skipped invalid value for header "${k}"`); }
  }

  return {
    method, url: u.href, headers, fetchHeaders, dnrHeaders, body, fetchBody,
    missing: [...missing], warnings,
    followRedirects: request.settings.followRedirects ?? settings.followRedirects ?? true,
    timeout: Number(request.settings.timeout) || Number(settings.timeout) || 0,
  };
}

let ruleSeq = Math.floor(Math.random() * 100000) + 1000;
async function addHeaderRule(p) {
  if (!chrome.declarativeNetRequest || !hasOrigin(p.url)) return null;
  const id = ++ruleSeq;
  const rule = {
    id, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: p.dnrHeaders.map(([header, value]) => ({ header, operation: 'set', value })) },
    condition: { urlFilter: `|${p.url}|`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
  };
  try { await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }); return id; }
  catch (e) { console.warn('header rule failed', e); return null; }
}
async function removeRule(id) {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch { /* gone */ }
}
export async function clearStaleRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(r => r.id) });
  } catch { /* unavailable */ }
}

function charsetOf(ct) { const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(ct || ''); return m ? m[1] : 'utf-8'; }

export function classify(ct, bytes) {
  ct = (ct || '').toLowerCase();
  if (/^image\//.test(ct)) return 'image';
  if (/json/.test(ct)) return 'json';
  if (/html/.test(ct)) return 'html';
  if (/xml/.test(ct)) return 'xml';
  if (/^text\/|javascript|ecmascript|csv|yaml|x-www-form-urlencoded/.test(ct)) return 'text';
  // sniff
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return 'binary';
  return 'text';
}

/** Send a prepared request. Returns a response record. */
export async function execute(p, { signal, credentials = 'include' } = {}) {
  let ruleId = null;
  if (p.dnrHeaders.length) ruleId = await addHeaderRule(p);
  if (p.dnrHeaders.length && !ruleId) p.warnings.push(`Not sent (needs host access): ${p.dnrHeaders.map(h => h[0]).join(', ')}`);
  const t0 = performance.now();
  try {
    const res = await fetch(p.url, {
      method: p.method, headers: p.fetchHeaders, body: p.fetchBody,
      redirect: p.followRedirects ? 'follow' : 'manual', credentials, signal, cache: 'no-store',
    });
    const ttfb = performance.now() - t0;
    const buf = new Uint8Array(await res.arrayBuffer());
    const time = performance.now() - t0;
    const headers = [...res.headers];
    const ct = res.headers.get('content-type') || '';
    let kind = classify(ct, buf);
    let text = '';
    if (kind !== 'image' && kind !== 'binary') {
      try { text = new TextDecoder(charsetOf(ct)).decode(buf); } catch { text = new TextDecoder().decode(buf); }
    }
    let json, jsonOk = false;
    if (kind !== 'image' && kind !== 'binary' && text) {
      const t = text.trim();
      if (kind === 'json' || /^[[{]/.test(t)) {
        try { json = JSON.parse(t); jsonOk = true; kind = 'json'; } catch { /* not json */ }
      }
    }
    const headerBytes = headers.reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
    return {
      ok: true, status: res.status, statusText: res.statusText || '', redirected: res.redirected,
      finalUrl: res.url || p.url, opaqueRedirect: res.type === 'opaqueredirect',
      headers, contentType: ct, kind, bytes: buf, size: buf.byteLength, headerBytes, text, json, jsonOk,
      time, ttfb, ts: Date.now(),
    };
  } catch (e) {
    const aborted = e.name === 'AbortError' || signal?.aborted;
    let hint = '';
    if (!aborted) {
      hint = hasOrigin(p.url)
        ? 'Check that the server is reachable, the URL is right and the certificate is valid.'
        : 'The extension has no access to this host, so the browser applied CORS. Grant access when asked, or in Settings, and send again.';
    }
    return {
      ok: false, error: aborted ? (signal?.reason === 'timeout' ? `Request timed out after ${p.timeout} ms` : 'Request cancelled') : (e.message || 'Network error'),
      hint, time: performance.now() - t0, ts: Date.now(), headers: [], size: 0, status: 0, text: '', kind: 'none',
    };
  } finally {
    if (ruleId) removeRule(ruleId);
  }
}

export async function cookiesFor(url) {
  if (!chrome.cookies || !hasOrigin(url)) return null;
  try { return await chrome.cookies.getAll({ url }); } catch { return null; }
}
