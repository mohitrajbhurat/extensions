// Postman Collection v2.0/v2.1 import and v2.1 export (plus Postman environment import).
import { newCollection, newFolder, newRequestItem, newRequest, newAuth, kv, normalizeRequest } from './model.js';
import { paramsFromUrl } from './urlparams.js';
import { describe, NO_EXPECTED } from './assert.js';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

const arr = x => Array.isArray(x) ? x : [];
const desc = d => typeof d === 'string' ? d : d?.content || '';
const kvList = (list) => arr(list).map(x => kv(x.key ?? '', x.value == null ? '' : String(x.value), { enabled: !x.disabled, description: desc(x.description) }));
function authParams(list) {
  const o = {};
  if (Array.isArray(list)) for (const p of list) o[p.key] = p.value;
  else if (list && typeof list === 'object') Object.assign(o, list); // v2.0 style
  return o;
}

function importAuth(a, fallback) {
  const auth = newAuth(fallback);
  if (!a) return auth;
  const p = authParams(a[a.type]);
  switch (a.type) {
    case 'noauth': auth.type = 'none'; break;
    case 'bearer': auth.type = 'bearer'; auth.bearer.token = p.token ?? ''; break;
    case 'basic': auth.type = 'basic'; auth.basic.username = p.username ?? ''; auth.basic.password = p.password ?? ''; break;
    case 'apikey': auth.type = 'apikey'; auth.apikey = { key: p.key ?? '', value: p.value ?? '', in: p.in === 'query' ? 'query' : 'header' }; break;
    case 'oauth2':
      auth.type = 'oauth2';
      Object.assign(auth.oauth2, {
        tokenUrl: p.accessTokenUrl ?? '', clientId: p.clientId ?? '', clientSecret: p.clientSecret ?? '',
        scope: p.scope ?? '', accessToken: p.accessToken ?? '', headerPrefix: p.headerPrefix || 'Bearer',
        clientAuth: p.client_authentication === 'body' ? 'body' : 'header',
      });
      break;
    default: auth.type = fallback; // unsupported types (digest, hawk, aws...) are dropped
  }
  return auth;
}

function rawUrl(u) {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
  const path = Array.isArray(u.path) ? u.path.join('/') : (u.path || '');
  const q = arr(u.query).filter(x => !x.disabled).map(x => x.value == null ? x.key : `${x.key}=${x.value}`).join('&');
  return `${u.protocol ? u.protocol + '://' : ''}${host}${u.port ? ':' + u.port : ''}${path ? '/' + path.replace(/^\//, '') : ''}${q ? '?' + q : ''}`;
}

function importRequest(item, stats) {
  const r = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : (item.request || {});
  const req = newRequest({ method: r.method || 'GET', url: rawUrl(r.url) });
  req.description = desc(r.description) || desc(item.description);
  req.headers = kvList(r.header);
  const disabledQuery = typeof r.url === 'object' ? arr(r.url.query).filter(q => q.disabled) : [];
  req.params = paramsFromUrl(req.url, []).concat(disabledQuery.map(q => kv(q.key ?? '', q.value ?? '', { enabled: false })));
  if (typeof r.url === 'object') {
    // descriptions of enabled params
    for (const q of arr(r.url.query)) { const p = req.params.find(x => x.key === q.key); if (p && q.description) p.description = desc(q.description); }
  }
  req.auth = importAuth(r.auth, 'inherit');
  const b = r.body;
  if (b && !b.disabled) {
    if (b.mode === 'raw') {
      const lang = b.options?.raw?.language;
      const ct = req.headers.find(h => h.key.toLowerCase() === 'content-type')?.value || '';
      let looksJson = false; try { JSON.parse(b.raw); looksJson = /^\s*[[{]/.test(b.raw || ''); } catch { /* no */ }
      if (lang === 'json' || /json/i.test(ct) || (!lang && looksJson)) { req.body.mode = 'json'; req.body.json = b.raw || ''; }
      else if (lang === 'xml' || /xml/i.test(ct)) { req.body.mode = 'xml'; req.body.xml = b.raw || ''; }
      else { req.body.mode = 'text'; req.body.text = b.raw || ''; }
    } else if (b.mode === 'urlencoded') { req.body.mode = 'urlencoded'; req.body.urlencoded = kvList(b.urlencoded); }
    else if (b.mode === 'formdata') {
      req.body.mode = 'formdata';
      req.body.formdata = arr(b.formdata).map(f => f.type === 'file'
        ? kv(f.key ?? '', '', { type: 'file', enabled: !f.disabled, fileName: (Array.isArray(f.src) ? f.src[0] : f.src || '').split(/[\\/]/).pop() })
        : kv(f.key ?? '', f.value ?? '', { type: 'text', enabled: !f.disabled }));
      if (req.body.formdata.some(f => f.type === 'file')) stats.files++;
    } else if (b.mode === 'file') { req.body.mode = 'binary'; req.body.binary = { fileName: String(b.file?.src || '').split(/[\\/]/).pop() }; stats.files++; }
    else if (b.mode === 'graphql') {
      req.body.mode = 'json';
      let vars = {}; try { vars = JSON.parse(b.graphql?.variables || '{}'); } catch { /* ignore */ }
      req.body.json = JSON.stringify({ query: b.graphql?.query || '', variables: vars }, null, 2);
    }
  }
  if (item._workbench) {
    req.tests = normalizeRequest({ tests: item._workbench.tests }).tests;
    req.extract = normalizeRequest({ extract: item._workbench.extract }).extract;
    if (item._workbench.settings) Object.assign(req.settings, item._workbench.settings);
  } else if (arr(item.event).some(e => e.script && arr(e.script.exec).join('').trim())) stats.scripts++;
  stats.requests++;
  return newRequestItem(item.name || 'Request', req);
}

function importItems(items, stats) {
  return arr(items).map(it => {
    if (Array.isArray(it.item)) {
      const f = newFolder(it.name || 'Folder');
      f.description = desc(it.description);
      f.auth = importAuth(it.auth, 'inherit');
      f.items = importItems(it.item, stats);
      stats.folders++;
      return f;
    }
    return importRequest(it, stats);
  });
}

/** Returns { kind: 'collection'|'environment', value, stats } */
export function importPostman(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (data && Array.isArray(data.values) && !data.item) {
    return {
      kind: 'environment',
      value: { name: data.name || 'Imported environment', variables: arr(data.values).map(v => kv(v.key, v.value == null ? '' : String(v.value), { enabled: v.enabled !== false, secret: v.type === 'secret' })) },
    };
  }
  if (!data || !data.info || !Array.isArray(data.item)) throw new Error('Not a Postman collection (expected "info" and "item")');
  const stats = { requests: 0, folders: 0, scripts: 0, files: 0 };
  const col = newCollection(data.info.name || 'Imported collection');
  col.description = desc(data.info.description);
  col.auth = importAuth(data.auth, 'none');
  col.variables = kvList(data.variable);
  col.items = importItems(data.item, stats);
  return { kind: 'collection', value: col, stats };
}

/* ---------------- export ---------------- */

function exportAuth(a) {
  if (!a || a.type === 'inherit') return undefined;
  const p = o => Object.entries(o).map(([key, value]) => ({ key, value, type: 'string' }));
  switch (a.type) {
    case 'none': return { type: 'noauth' };
    case 'bearer': return { type: 'bearer', bearer: p({ token: a.bearer.token }) };
    case 'basic': return { type: 'basic', basic: p({ username: a.basic.username, password: a.basic.password }) };
    case 'apikey': return { type: 'apikey', apikey: p({ key: a.apikey.key, value: a.apikey.value, in: a.apikey.in }) };
    case 'oauth2': return {
      type: 'oauth2', oauth2: p({
        grant_type: 'client_credentials', accessTokenUrl: a.oauth2.tokenUrl, clientId: a.oauth2.clientId,
        clientSecret: a.oauth2.clientSecret, scope: a.oauth2.scope, headerPrefix: a.oauth2.headerPrefix,
        client_authentication: a.oauth2.clientAuth, addTokenTo: 'header',
      }),
    };
    default: return undefined;
  }
}

const kvOut = list => list.filter(x => x.key || x.value).map(x => ({ key: x.key, value: x.value, ...(x.enabled ? {} : { disabled: true }), ...(x.description ? { description: x.description } : {}) }));

function exportUrl(req) {
  const raw = req.url;
  const m = /^(?:([a-z][\w+.-]*):\/\/)?([^/?#]*)([^?#]*)/i.exec(raw) || [];
  const hostPort = m[2] || '';
  const [host, port] = hostPort.startsWith('{{') ? [hostPort, undefined] : hostPort.split(':');
  const out = { raw };
  if (m[1]) out.protocol = m[1];
  out.host = host ? host.split('.') : [];
  if (port) out.port = port;
  out.path = (m[3] || '').split('/').filter(Boolean);
  if (req.params.length) out.query = kvOut(req.params);
  return out;
}

/** Turn simple assertions into pm.test() code so the exported collection still runs in Postman. */
function testsToScript(tests) {
  const lines = [];
  for (const t of tests.filter(x => x.enabled)) {
    const name = JSON.stringify(describe(t));
    const exp = t.expected ?? '';
    let lit; try { lit = JSON.stringify(JSON.parse(exp)); } catch { lit = JSON.stringify(exp); }
    let actual;
    switch (t.type) {
      case 'status': actual = 'pm.response.code'; break;
      case 'time': actual = 'pm.response.responseTime'; break;
      case 'size': actual = 'pm.response.responseSize'; break;
      case 'body': actual = 'pm.response.text()'; break;
      case 'header': actual = `pm.response.headers.get(${JSON.stringify(t.target)})`; break;
      case 'json': {
        const path = (t.target || '$').replace(/^\$\.?/, '');
        actual = `(function(){ try { return ${path ? `pm.response.json()${path.startsWith('[') ? '' : '.'}${path}` : 'pm.response.json()'}; } catch (e) { return undefined; } })()`;
        break;
      }
      default: continue;
    }
    const chk = {
      eq: `pm.expect(${actual}).to.eql(${lit});`, neq: `pm.expect(${actual}).to.not.eql(${lit});`,
      contains: `pm.expect(String(${actual})).to.include(${JSON.stringify(exp)});`, notContains: `pm.expect(String(${actual})).to.not.include(${JSON.stringify(exp)});`,
      exists: `pm.expect(${actual}).to.not.be.undefined;`, notExists: `pm.expect(${actual}).to.be.undefined;`,
      lt: `pm.expect(Number(${actual})).to.be.below(${Number(exp)});`, lte: `pm.expect(Number(${actual})).to.be.at.most(${Number(exp)});`,
      gt: `pm.expect(Number(${actual})).to.be.above(${Number(exp)});`, gte: `pm.expect(Number(${actual})).to.be.at.least(${Number(exp)});`,
      matches: `pm.expect(String(${actual})).to.match(new RegExp(${JSON.stringify(exp)}));`,
      type: `pm.expect(${actual}).to.be.a(${JSON.stringify(exp)});`,
      empty: `pm.expect(${actual}).to.be.empty;`, notEmpty: `pm.expect(${actual}).to.not.be.empty;`,
    }[t.op];
    if (chk) lines.push(`pm.test(${name}, function () {`, `    ${chk}`, '});');
    void NO_EXPECTED;
  }
  return lines;
}

function exportBody(b) {
  switch (b.mode) {
    case 'json': return { mode: 'raw', raw: b.json, options: { raw: { language: 'json' } } };
    case 'text': return { mode: 'raw', raw: b.text, options: { raw: { language: 'text' } } };
    case 'xml': return { mode: 'raw', raw: b.xml, options: { raw: { language: 'xml' } } };
    case 'urlencoded': return { mode: 'urlencoded', urlencoded: kvOut(b.urlencoded) };
    case 'formdata': return {
      mode: 'formdata', formdata: b.formdata.filter(f => f.key).map(f => f.type === 'file'
        ? { key: f.key, type: 'file', src: f.fileName || '', ...(f.enabled ? {} : { disabled: true }) }
        : { key: f.key, value: f.value, type: 'text', ...(f.enabled ? {} : { disabled: true }) }),
    };
    case 'binary': return { mode: 'file', file: { src: b.binary?.fileName || '' } };
    default: return undefined;
  }
}

function exportItems(items) {
  return items.map(it => {
    if (it.type === 'folder') {
      return { name: it.name, ...(it.description ? { description: it.description } : {}), item: exportItems(it.items), ...(exportAuth(it.auth) ? { auth: exportAuth(it.auth) } : {}) };
    }
    const r = it.request;
    const request = { method: r.method, header: kvOut(r.headers), url: exportUrl(r) };
    const body = exportBody(r.body); if (body) request.body = body;
    const auth = exportAuth(r.auth); if (auth) request.auth = auth;
    if (r.description) request.description = r.description;
    const out = { name: it.name, request, response: [] };
    const script = testsToScript(r.tests);
    if (script.length) out.event = [{ listen: 'test', script: { type: 'text/javascript', exec: script } }];
    out._workbench = { tests: r.tests, extract: r.extract, settings: r.settings };
    return out;
  });
}

export function exportCollection(col) {
  const out = {
    info: { _postman_id: col.id, name: col.name, description: col.description || '', schema: SCHEMA },
    item: exportItems(col.items),
  };
  const auth = exportAuth(col.auth); if (auth && auth.type !== 'noauth') out.auth = auth;
  if (col.variables.length) out.variable = kvOut(col.variables);
  return out;
}

export function exportEnvironment(env) {
  return {
    id: env.id, name: env.name, _postman_variable_scope: 'environment',
    values: env.variables.filter(v => v.key).map(v => ({ key: v.key, value: v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled })),
  };
}
