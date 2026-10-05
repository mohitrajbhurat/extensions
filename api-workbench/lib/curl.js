// cURL import (shell tokenizer + flag parser) and cURL / fetch code generation.
import { newRequest, kv } from './model.js';
import { paramsFromUrl, splitUrl } from './urlparams.js';
import { b64decodeUtf8 } from './util.js';

export function tokenize(cmd) {
  const out = [];
  let cur = '', inTok = false, i = 0;
  const s = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (inTok) { out.push(cur); cur = ''; inTok = false; } i++; continue; }
    inTok = true;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end < 0 ? s.length : end); i = end < 0 ? s.length : end + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const e = s[i + 1]; i += 2;
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          if (e in map) cur += map[e];
          else if (e === 'x') { cur += String.fromCharCode(parseInt(s.substr(i, 2), 16)); i += 2; }
          else if (e === 'u') { cur += String.fromCharCode(parseInt(s.substr(i, 4), 16)); i += 4; }
          else cur += '\\' + e;
        } else cur += s[i++];
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; }
        else cur += s[i++];
      }
      i++;
    } else if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; }
    else { cur += c; i++; }
  }
  if (inTok) out.push(cur);
  return out;
}

const WITH_ARG = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii',
  '--data-urlencode', '-F', '--form', '--form-string', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie',
  '--url', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-w', '--write-out', '--oauth2-bearer',
  '-T', '--upload-file', '--retry', '-c', '--cookie-jar', '--cert', '--key', '--cacert', '-E', '--resolve', '-r', '--range',
  '-K', '--config', '--json']);
const SHORT_WITH_ARG = new Set('XHdFuAeboomxwTcEKr'.split(''));

export function parseCurl(cmd) {
  const toks = tokenize(cmd.trim());
  if (!toks.length || !/^curl(\.exe)?$/i.test(toks[0])) throw new Error('Not a cURL command (it should start with "curl")');
  let method = null, url = null, get = false, head = false, follow = false;
  const headers = [], data = [], form = [];
  let user = null, dataIsJson = false, bearer = null;
  const args = [];
  for (let i = 1; i < toks.length; i++) {
    let t = toks[i];
    if (t.startsWith('--') && t.includes('=')) { const e = t.indexOf('='); args.push([t.slice(0, e), t.slice(e + 1)]); continue; }
    if (t.startsWith('--')) { args.push(WITH_ARG.has(t) ? [t, toks[++i]] : [t, null]); continue; }
    if (t.startsWith('-') && t.length > 1) {
      // combined short flags: -sSL, -XPOST, -H'x: y'
      for (let j = 1; j < t.length; j++) {
        const f = '-' + t[j];
        if (SHORT_WITH_ARG.has(t[j])) { const rest = t.slice(j + 1); args.push([f, rest || toks[++i]]); break; }
        args.push([f, null]);
      }
      continue;
    }
    args.push(['url', t]);
  }
  for (const [f, v] of args) {
    switch (f) {
      case 'url': case '--url': if (!url) url = v; break;
      case '-X': case '--request': method = (v || '').toUpperCase(); break;
      case '-H': case '--header': {
        const c = (v || '').indexOf(':');
        if (c > 0) {
          const k = v.slice(0, c).trim(), val = v.slice(c + 1).trim();
          headers.push([k, val]);
        }
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii': data.push(v ?? ''); break;
      case '--json': data.push(v ?? ''); dataIsJson = true; break;
      case '--data-urlencode': {
        const s = v ?? ''; const e = s.indexOf('=');
        data.push(e >= 0 ? s.slice(0, e + 1) + encodeURIComponent(s.slice(e + 1)) : encodeURIComponent(s));
        break;
      }
      case '-F': case '--form': case '--form-string': {
        const s = v ?? ''; const e = s.indexOf('=');
        const key = e >= 0 ? s.slice(0, e) : s, val = e >= 0 ? s.slice(e + 1) : '';
        if (f !== '--form-string' && val.startsWith('@')) form.push(kv(key, '', { type: 'file', fileName: val.slice(1).split(';')[0] }));
        else form.push(kv(key, val.replace(/^"|"$/g, ''), { type: 'text' }));
        break;
      }
      case '-u': case '--user': user = v || ''; break;
      case '-A': case '--user-agent': headers.push(['User-Agent', v || '']); break;
      case '-e': case '--referer': headers.push(['Referer', v || '']); break;
      case '-b': case '--cookie': if (v && v.includes('=')) headers.push(['Cookie', v]); break;
      case '--oauth2-bearer': bearer = v; break;
      case '-G': case '--get': get = true; break;
      case '-I': case '--head': head = true; break;
      case '-L': case '--location': follow = true; break;
      default: break;
    }
  }
  if (!url) throw new Error('No URL found in the cURL command');
  const req = newRequest({ url });
  req.settings.followRedirects = follow || true;
  let body = data.join('&');
  if (get && data.length) {
    const { base, query, hash } = splitUrl(url);
    req.url = base + '?' + (query ? query + '&' : '') + body + hash;
    body = '';
  }
  req.method = method || (head ? 'HEAD' : (body || form.length) ? 'POST' : 'GET');
  if (dataIsJson) { headers.push(['Content-Type', 'application/json']); headers.push(['Accept', 'application/json']); }
  // Authorization header -> auth helper
  req.auth.type = 'none';
  const authIdx = headers.findIndex(([k]) => k.toLowerCase() === 'authorization');
  if (authIdx >= 0) {
    const val = headers[authIdx][1];
    let m;
    if ((m = /^Bearer\s+(.+)$/i.exec(val))) { req.auth.type = 'bearer'; req.auth.bearer.token = m[1]; headers.splice(authIdx, 1); }
    else if ((m = /^Basic\s+(.+)$/i.exec(val))) {
      const dec = b64decodeUtf8(m[1].trim());
      if (dec != null && dec.includes(':')) {
        req.auth.type = 'basic';
        req.auth.basic.username = dec.slice(0, dec.indexOf(':'));
        req.auth.basic.password = dec.slice(dec.indexOf(':') + 1);
        headers.splice(authIdx, 1);
      }
    }
  }
  if (bearer) { req.auth.type = 'bearer'; req.auth.bearer.token = bearer; }
  if (user != null) {
    const c = user.indexOf(':');
    req.auth.type = 'basic';
    req.auth.basic.username = c >= 0 ? user.slice(0, c) : user;
    req.auth.basic.password = c >= 0 ? user.slice(c + 1) : '';
  }
  const ctIdx = headers.findIndex(([k]) => k.toLowerCase() === 'content-type');
  const ct = ctIdx >= 0 ? headers[ctIdx][1].toLowerCase() : '';
  if (form.length) {
    req.body.mode = 'formdata'; req.body.formdata = form;
    if (ct.startsWith('multipart/')) headers.splice(ctIdx, 1);
  } else if (body) {
    let isJson = false;
    try { JSON.parse(body); isJson = /^\s*[[{]/.test(body); } catch { /* not json */ }
    if (ct.includes('json') || (!ct && isJson)) {
      req.body.mode = 'json';
      try { req.body.json = JSON.stringify(JSON.parse(body), null, 2); } catch { req.body.json = body; }
      if (ct === 'application/json') headers.splice(ctIdx, 1);
    } else if ((ct.includes('x-www-form-urlencoded') || !ct) && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
      req.body.mode = 'urlencoded';
      req.body.urlencoded = body.split('&').map(p => {
        const e = p.indexOf('=');
        const dec = x => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
        return kv(dec(p.slice(0, e)), dec(p.slice(e + 1)));
      });
      if (ct.includes('x-www-form-urlencoded')) headers.splice(ctIdx, 1);
    } else if (ct.includes('xml')) { req.body.mode = 'xml'; req.body.xml = body; }
    else { req.body.mode = 'text'; req.body.text = body; }
  }
  req.headers = headers.map(([k, v]) => kv(k, v));
  req.params = paramsFromUrl(req.url, []);
  return req;
}

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** prepared: { method, url, headers:[[k,v]], body:{kind,text,fields,fileName} } */
export function toCurl(p) {
  const lines = [`curl ${p.method === 'GET' ? '' : `-X ${p.method} `}${sq(p.url)}`];
  for (const [k, v] of p.headers) lines.push(`-H ${sq(`${k}: ${v}`)}`);
  const b = p.body || {};
  if (b.kind === 'text' || b.kind === 'urlencoded') lines.push(`--data-raw ${sq(b.text)}`);
  else if (b.kind === 'formdata') for (const f of b.fields) lines.push(`-F ${sq(f.type === 'file' ? `${f.key}=@${f.fileName || 'file'}` : `${f.key}=${f.value}`)}`);
  else if (b.kind === 'binary') lines.push(`--data-binary ${sq('@' + (b.fileName || 'file'))}`);
  if (p.followRedirects) lines[0] = lines[0].replace(/^curl /, 'curl -L ');
  return lines.join(' \\\n  ');
}

export function toFetch(p) {
  const opts = [`  method: ${JSON.stringify(p.method)}`];
  const hdrs = p.headers.filter(([k]) => !(p.body?.kind === 'formdata' && k.toLowerCase() === 'content-type'));
  if (hdrs.length) opts.push(`  headers: {\n${hdrs.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }`);
  let pre = '';
  const b = p.body || {};
  if (b.kind === 'text' || b.kind === 'urlencoded') {
    let lit = JSON.stringify(b.text);
    try { const j = JSON.parse(b.text); if (j && typeof j === 'object') lit = `JSON.stringify(${JSON.stringify(j, null, 2).replace(/\n/g, '\n  ')})`; } catch { /* keep string */ }
    opts.push(`  body: ${lit}`);
  } else if (b.kind === 'formdata') {
    pre = 'const form = new FormData();\n' + b.fields.map(f => f.type === 'file'
      ? `form.append(${JSON.stringify(f.key)}, fileInput.files[0], ${JSON.stringify(f.fileName || 'file')});`
      : `form.append(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)});`).join('\n') + '\n\n';
    opts.push('  body: form');
  } else if (b.kind === 'binary') {
    pre = `// ${b.fileName || 'file'}: pick it with an <input type="file"> or read it as a Blob\n`;
    opts.push('  body: fileBlob');
  }
  if (!p.followRedirects) opts.push(`  redirect: "manual"`);
  return `${pre}const response = await fetch(${JSON.stringify(p.url)}, {\n${opts.join(',\n')}\n});\n\nconsole.log(response.status, await response.text());`;
}
