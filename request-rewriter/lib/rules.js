// Request Rewriter: rule model, validation, compiler to declarativeNetRequest, local matcher,
// import/export. Pure module: no chrome.* calls, so it runs in the service worker, extension
// pages and Node alike.

export const FORMAT = 'request-rewriter';
export const FORMAT_VERSION = 1;

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
];
export const RESOURCE_LABELS = {
  main_frame: 'Page (main frame)', sub_frame: 'Iframe', stylesheet: 'Stylesheet', script: 'Script',
  image: 'Image', font: 'Font', object: 'Plugin object', xmlhttprequest: 'XHR / fetch', ping: 'Ping / beacon',
  csp_report: 'CSP report', media: 'Media', websocket: 'WebSocket', webtransport: 'WebTransport',
  webbundle: 'Web bundle', other: 'Other',
};
export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'connect', 'other'];

export const RULE_TYPES = {
  requestHeaders: { label: 'Modify request headers', short: 'Request headers', hint: 'Set, append or remove headers sent to the server.' },
  responseHeaders: { label: 'Modify response headers', short: 'Response headers', hint: 'Set, append or remove headers the page receives (CORS, CSP, caching).' },
  redirect: { label: 'Redirect URL', short: 'Redirect', hint: 'Send matching requests to another URL. Wildcard and regex matches can reuse captured parts with $1, $2 ...' },
  replace: { label: 'Replace text in URL', short: 'Replace', hint: 'Replace a piece of text anywhere in the URL, for example /v1/ to /v2/.' },
  host: { label: 'Replace host', short: 'Host', hint: 'Point a host at another one, for example production to staging or localhost.' },
  query: { label: 'Query parameters', short: 'Query', hint: 'Add, replace or remove query string parameters.' },
  block: { label: 'Block requests', short: 'Block', hint: 'Cancel matching requests (trackers, flaky third parties, feature flags).' },
  mock: { label: 'Mock response', short: 'Mock', hint: 'Answer matching requests with a body you write, served as a data: URL.' },
  userAgent: { label: 'Override user agent', short: 'User agent', hint: 'Send a different User-Agent header (and drop client hints).' },
  allow: { label: 'Allow (exception)', short: 'Allow', hint: 'Exempt matching requests from lower-priority rules in every group.' },
};

export const MATCH_TYPES = {
  all: 'All URLs',
  contains: 'URL contains',
  exact: 'URL equals',
  wildcard: 'Wildcard (*)',
  regex: 'Regular expression',
  domain: 'Domain (and subdomains)',
  urlFilter: 'DNR urlFilter syntax',
};

export const UA_PRESETS = [
  { id: 'chrome-android', label: 'Chrome on Android', value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' },
  { id: 'safari-iphone', label: 'Safari on iPhone', value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' },
  { id: 'safari-ipad', label: 'Safari on iPad', value: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' },
  { id: 'chrome-windows', label: 'Chrome on Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36' },
  { id: 'chrome-mac', label: 'Chrome on macOS', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36' },
  { id: 'firefox-windows', label: 'Firefox on Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' },
  { id: 'safari-mac', label: 'Safari on macOS', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15' },
  { id: 'edge-windows', label: 'Edge on Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0' },
  { id: 'googlebot', label: 'Googlebot', value: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { id: 'curl', label: 'curl', value: 'curl/8.9.1' },
];

export const CLIENT_HINT_HEADERS = [
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-model', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
];

// Chrome only accepts the "append" operation on these request headers.
export const APPENDABLE_REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'accept-language', 'access-control-request-headers', 'cache-control',
  'connection', 'content-language', 'cookie', 'forwarded', 'if-match', 'if-none-match', 'keep-alive',
  'range', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via', 'want-digest', 'x-forwarded-for',
];

export const COMMON_REQUEST_HEADERS = [
  'Authorization', 'Cookie', 'Accept', 'Accept-Language', 'Cache-Control', 'Origin', 'Referer',
  'User-Agent', 'X-Forwarded-For', 'X-Requested-With', 'X-Debug', 'X-Feature-Flags', 'X-Api-Key',
];
export const COMMON_RESPONSE_HEADERS = [
  'Access-Control-Allow-Origin', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods',
  'Access-Control-Allow-Credentials', 'Content-Security-Policy', 'Cache-Control', 'Set-Cookie',
  'X-Frame-Options', 'Content-Type', 'Strict-Transport-Security', 'Timing-Allow-Origin',
];

export const MOCK_CONTENT_TYPES = [
  'application/json', 'text/plain', 'text/html', 'application/javascript', 'text/css',
  'application/xml', 'image/svg+xml', 'text/csv',
];

// Mock bodies are inlined into the rule as a data: URL. Chrome caps URLs at 2 MB; we keep a
// margin and warn early because every mock lives in chrome.storage.local and in the rule set.
export const MOCK_WARN_BYTES = 100 * 1024;
export const MOCK_MAX_BYTES = 1024 * 1024;

export const GROUP_COLORS = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];

export const SESSION_ID_BASE = 1000000;

// ---------- small helpers ----------

export function uid(prefix = 'r') {
  const rnd = (globalThis.crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function escapeSubstitution(s) { return String(s).replace(/\\/g, '\\\\'); }

export function isAscii(s) { return /^[\x00-\x7f]*$/.test(s); }

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function byteLength(str) { return new TextEncoder().encode(str || '').length; }

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function splitList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// Turns "https://Example.com:8080/path" into "example.com". Returns '' for junk.
export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').replace(/^\.+/, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^[^@]*@/, '');
  if (s.startsWith('[')) return s.split(']')[0] + ']';
  return s.replace(/:\d*$/, '');
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// ---------- defaults ----------

export function defaultCondition() {
  return {
    matchType: 'all', value: '', resourceTypes: [], methods: [],
    initiatorDomains: [], excludedInitiatorDomains: [], excludedRequestDomains: [],
  };
}

export function defaultAction(type) {
  switch (type) {
    case 'requestHeaders': return { headers: [{ op: 'set', name: '', value: '' }] };
    case 'responseHeaders': return { headers: [{ op: 'set', name: '', value: '' }] };
    case 'redirect': return { url: '' };
    case 'replace': return { find: '', replaceWith: '' };
    case 'host': return { fromHost: '', toHost: '', scheme: '' };
    case 'query': return { add: [{ key: '', value: '', replaceOnly: false }], remove: [] };
    case 'mock': return { contentType: 'application/json', charset: 'utf-8', body: '{\n  "ok": true\n}' };
    case 'userAgent': return { preset: 'chrome-android', value: UA_PRESETS[0].value, dropClientHints: true };
    default: return {};
  }
}

export function newRule(type = 'requestHeaders', patch = {}) {
  const rule = {
    id: uid('r'), name: '', enabled: true, type, priority: 1, notes: '',
    condition: defaultCondition(), action: defaultAction(type),
  };
  if (type === 'mock' || type === 'redirect') rule.condition.matchType = type === 'mock' ? 'exact' : 'contains';
  return Object.assign(rule, patch);
}

export function newGroup(name = 'New group', patch = {}) {
  return Object.assign({ id: uid('g'), name, enabled: true, color: GROUP_COLORS[0], description: '', rules: [] }, patch);
}

export function defaultState() {
  const examples = newGroup('Examples', { enabled: false, color: '#64748b', description: 'Disabled sample rules. Turn the group on, or copy what you need.' });
  examples.rules = [
    newRule('requestHeaders', { name: 'Debug header on example.com', condition: { ...defaultCondition(), matchType: 'domain', value: 'example.com' }, action: { headers: [{ op: 'set', name: 'X-Debug', value: '1' }] } }),
    newRule('host', { name: 'Production API to staging', action: { fromHost: 'api.example.com', toHost: 'api.staging.example.com', scheme: '' } }),
    newRule('responseHeaders', { name: 'Allow CORS from anywhere', condition: { ...defaultCondition(), matchType: 'domain', value: 'api.example.com', resourceTypes: ['xmlhttprequest'] }, action: { headers: [{ op: 'set', name: 'Access-Control-Allow-Origin', value: '*' }] } }),
    newRule('block', { name: 'Block a tracker', condition: { ...defaultCondition(), matchType: 'domain', value: 'tracker.example' } }),
    newRule('mock', { name: 'Mock the feature-flags endpoint', condition: { ...defaultCondition(), matchType: 'exact', value: 'https://api.example.com/flags' }, action: { contentType: 'application/json', charset: 'utf-8', body: '{\n  "newCheckout": true\n}' } }),
  ];
  return { format: FORMAT, version: FORMAT_VERSION, paused: false, groups: [examples], updatedAt: Date.now() };
}

// Fills in missing fields so older or hand-written data never crashes the UI or compiler.
export function normalizeRule(r) {
  const type = RULE_TYPES[r && r.type] ? r.type : 'requestHeaders';
  const base = newRule(type);
  const out = Object.assign(base, r || {}, { type });
  out.id = typeof out.id === 'string' && out.id ? out.id : uid('r');
  out.name = String(out.name || '');
  out.enabled = out.enabled !== false;
  out.priority = Math.min(1000, Math.max(1, parseInt(out.priority, 10) || 1));
  out.condition = Object.assign(defaultCondition(), (r && r.condition) || {});
  if (!MATCH_TYPES[out.condition.matchType]) out.condition.matchType = 'all';
  for (const k of ['resourceTypes', 'methods', 'initiatorDomains', 'excludedInitiatorDomains', 'excludedRequestDomains']) {
    out.condition[k] = splitList(out.condition[k]);
  }
  out.condition.resourceTypes = out.condition.resourceTypes.filter(t => RESOURCE_TYPES.includes(t));
  out.condition.methods = out.condition.methods.map(m => m.toLowerCase()).filter(m => METHODS.includes(m));
  out.action = Object.assign(defaultAction(type), (r && r.action) || {});
  if (out.action.headers) out.action.headers = out.action.headers.map(h => ({ op: ['set', 'append', 'remove'].includes(h.op) ? h.op : 'set', name: String(h.name || ''), value: String(h.value ?? '') }));
  if (type === 'query') {
    out.action.add = (out.action.add || []).map(p => ({ key: String(p.key || ''), value: String(p.value ?? ''), replaceOnly: !!p.replaceOnly }));
    out.action.remove = splitList(out.action.remove);
  }
  return out;
}

export function normalizeGroup(g) {
  const out = Object.assign(newGroup(), g || {});
  out.id = typeof out.id === 'string' && out.id ? out.id : uid('g');
  out.name = String(out.name || 'Untitled group');
  out.enabled = out.enabled !== false;
  out.rules = Array.isArray(out.rules) ? out.rules.map(normalizeRule) : [];
  return out;
}

export function normalizeState(s) {
  if (!s || !Array.isArray(s.groups)) return defaultState();
  return {
    format: FORMAT, version: FORMAT_VERSION, paused: !!s.paused,
    groups: s.groups.map(normalizeGroup), updatedAt: s.updatedAt || Date.now(),
  };
}

// ---------- summaries ----------

export function conditionSummary(c) {
  const v = c.value || '';
  let s;
  switch (c.matchType) {
    case 'all': s = 'all URLs'; break;
    case 'contains': s = `URL contains "${v}"`; break;
    case 'exact': s = `URL = ${v}`; break;
    case 'wildcard': s = `URL like ${v}`; break;
    case 'regex': s = `URL ~ /${v}/`; break;
    case 'domain': s = `domain ${splitList(v).join(', ')}`; break;
    case 'urlFilter': s = `filter ${v}`; break;
    default: s = v;
  }
  const extra = [];
  if (c.resourceTypes.length) extra.push(c.resourceTypes.length > 3 ? `${c.resourceTypes.length} types` : c.resourceTypes.join('/'));
  if (c.methods.length) extra.push(c.methods.map(m => m.toUpperCase()).join('/'));
  if (c.initiatorDomains.length) extra.push(`from ${c.initiatorDomains.join(', ')}`);
  return extra.length ? `${s} · ${extra.join(' · ')}` : s;
}

export function actionSummary(rule) {
  const a = rule.action;
  switch (rule.type) {
    case 'requestHeaders':
    case 'responseHeaders':
      return (a.headers || []).filter(h => h.name).map(h => h.op === 'remove' ? `−${h.name}` : `${h.op === 'append' ? '+' : ''}${h.name}: ${h.value}`).join(', ') || 'no headers';
    case 'redirect': return `→ ${a.url || '?'}`;
    case 'replace': return `"${a.find}" → "${a.replaceWith}"`;
    case 'host': return `${a.fromHost || '?'} → ${a.scheme ? a.scheme + '://' : ''}${a.toHost || '?'}`;
    case 'query': {
      const parts = (a.add || []).filter(p => p.key).map(p => `${p.key}=${p.value}`);
      for (const k of a.remove || []) parts.push(`−${k}`);
      return parts.join(', ') || 'no changes';
    }
    case 'block': return 'blocked';
    case 'allow': return 'allowed (exception)';
    case 'mock': return `${a.contentType || 'text/plain'} · ${formatBytes(byteLength(a.body))}`;
    case 'userAgent': {
      const p = UA_PRESETS.find(x => x.id === a.preset);
      return p ? p.label : (a.value || '').slice(0, 60);
    }
    default: return '';
  }
}

export function ruleDisplayName(rule) {
  return rule.name || `${RULE_TYPES[rule.type].short}: ${actionSummary(rule)}`.slice(0, 80);
}

// ---------- compiler ----------

function wildcardToRegex(pattern) {
  return '^' + String(pattern).split('*').map(escapeRegex).join('(.*)') + '$';
}

// Converts $1 / \1 references to RE2 substitution syntax (\1). Other backslashes are escaped.
function toRegexSubstitution(dest) {
  let out = '';
  const s = String(dest);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === '$' || ch === '\\') && /[0-9]/.test(s[i + 1] || '')) { out += '\\' + s[i + 1]; i++; continue; }
    if (ch === '\\') { out += '\\\\'; continue; }
    out += ch;
  }
  return out;
}

function hasGroupRefs(dest) { return /[$\\][0-9]/.test(String(dest || '')); }

const RE_DOMAIN_OK = /^(?:[a-z0-9-_]+\.)*[a-z0-9-_]+\.?$|^\[[0-9a-f:.]+\]$/;

function domainList(list, field, errors) {
  const out = [];
  for (const raw of splitList(list)) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    if (!isAscii(d)) { errors.push({ field, message: `"${raw}" must be ASCII (use the punycode form, e.g. xn--...).` }); continue; }
    if (!RE_DOMAIN_OK.test(d)) { errors.push({ field, message: `"${raw}" is not a valid domain.` }); continue; }
    out.push(d);
  }
  return [...new Set(out)];
}

// Builds the URL part of a DNR condition. `needRegex` forces a regexFilter (needed for capture groups).
function urlCondition(c, errors, needRegex) {
  const v = String(c.value || '').trim();
  const cond = {};
  const special = /[*|^]/;
  switch (c.matchType) {
    case 'all': break;
    case 'contains':
      if (!v) { errors.push({ field: 'condition.value', message: 'Enter the text the URL must contain.' }); break; }
      if (needRegex || special.test(v) || !isAscii(v)) cond.regexFilter = escapeRegex(v);
      else cond.urlFilter = v;
      break;
    case 'exact':
      if (!v) { errors.push({ field: 'condition.value', message: 'Enter the full URL to match.' }); break; }
      if (needRegex || special.test(v) || !isAscii(v)) cond.regexFilter = '^' + escapeRegex(v) + '$';
      else cond.urlFilter = '|' + v + '|';
      break;
    case 'wildcard':
      if (!v) { errors.push({ field: 'condition.value', message: 'Enter a wildcard pattern such as *://api.example.com/*' }); break; }
      if (needRegex || /[|^]/.test(v) || !isAscii(v)) cond.regexFilter = wildcardToRegex(v);
      else {
        let f = v.replace(/\*{2,}/g, '*');
        if (!f.startsWith('*')) f = '|' + f;
        if (!f.endsWith('*')) f = f + '|';
        cond.urlFilter = f;
      }
      break;
    case 'regex':
      if (!v) { errors.push({ field: 'condition.value', message: 'Enter a regular expression.' }); break; }
      try { new RegExp(v); } catch (e) { errors.push({ field: 'condition.value', message: `Invalid regex: ${e.message}` }); break; }
      if (/\(\?<?[=!]/.test(v)) { errors.push({ field: 'condition.value', message: 'Lookahead and lookbehind are not supported by Chrome (RE2 syntax).' }); break; }
      if (/\\[1-9]/.test(v)) { errors.push({ field: 'condition.value', message: 'Backreferences inside the pattern are not supported by RE2.' }); break; }
      cond.regexFilter = v;
      break;
    case 'domain': {
      const ds = domainList(v, 'condition.value', errors);
      if (!ds.length && !errors.length) errors.push({ field: 'condition.value', message: 'Enter at least one domain.' });
      if (ds.length) cond.requestDomains = ds;
      break;
    }
    case 'urlFilter':
      if (!v) { errors.push({ field: 'condition.value', message: 'Enter a urlFilter such as ||example.com^' }); break; }
      if (!isAscii(v)) { errors.push({ field: 'condition.value', message: 'urlFilter must be ASCII.' }); break; }
      if (/^\|\|\*/.test(v)) { errors.push({ field: 'condition.value', message: 'urlFilter cannot start with ||*. Use * or a plain ||domain.' }); break; }
      cond.urlFilter = v;
      break;
  }
  if (cond.urlFilter && cond.urlFilter.length > 0 && /[\r\n]/.test(cond.urlFilter)) errors.push({ field: 'condition.value', message: 'Line breaks are not allowed.' });
  return cond;
}

function headerOps(list, kind, errors, field) {
  const out = [];
  (list || []).forEach((h, i) => {
    const name = String(h.name || '').trim();
    if (!name) { if (h.value) errors.push({ field: `${field}.${i}.name`, message: 'Header name is empty.' }); return; }
    if (!HEADER_NAME_RE.test(name)) { errors.push({ field: `${field}.${i}.name`, message: `"${name}" is not a valid header name.` }); return; }
    const op = h.op || 'set';
    const value = String(h.value ?? '');
    if (/[\r\n\0]/.test(value)) { errors.push({ field: `${field}.${i}.value`, message: 'Header values cannot contain line breaks.' }); return; }
    if (op === 'append' && kind === 'request' && !APPENDABLE_REQUEST_HEADERS.includes(name.toLowerCase())) {
      errors.push({ field: `${field}.${i}.op`, message: `Chrome does not allow "append" on the request header ${name}. Append works for Accept, Accept-Language, Cache-Control, Cookie, Range, User-Agent, X-Forwarded-For and a few others; use "set" instead.` });
      return;
    }
    if (op === 'remove') out.push({ header: name, operation: 'remove' });
    else out.push({ header: name, operation: op, value });
  });
  return out;
}

export function buildMockDataUrl(action) {
  const ct = String(action.contentType || 'text/plain').trim() || 'text/plain';
  const charset = String(action.charset || '').trim();
  const mime = charset && !/;\s*charset=/i.test(ct) && !/^image\/(?!svg)/.test(ct) ? `${ct};charset=${charset}` : ct;
  return `data:${mime};base64,${utf8ToBase64(String(action.body ?? ''))}`;
}

function parseHostPort(s) {
  let v = String(s || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
  const m = v.match(/^(\[[^\]]+\]|[^:]+)(?::(\d*))?$/);
  if (!m) return { host: v, port: undefined };
  return { host: m[1], port: m[2] };
}

/**
 * Compiles one rule into a DNR rule. Returns { dnr, errors, warnings }.
 * opts: { id, tabIds } where tabIds turns it into a tab-scoped session rule.
 */
export function compileRule(rule, opts = {}) {
  const errors = [];
  const warnings = [];
  const c = rule.condition || defaultCondition();
  const a = rule.action || {};
  const type = rule.type;
  let needRegex = false;
  let action;

  if (type === 'redirect' && hasGroupRefs(a.url)) {
    if (c.matchType === 'wildcard' || c.matchType === 'regex') needRegex = true;
    else errors.push({ field: 'action.url', message: '$1-style references only work with Wildcard or Regular expression matching.' });
  }

  let cond;
  if (type === 'replace') {
    const find = String(a.find || '');
    if (!find) errors.push({ field: 'action.find', message: 'Enter the text to find.' });
    if (!['all', 'domain'].includes(c.matchType)) warnings.push({ field: 'condition.matchType', message: 'Replace rules match every URL containing the text; only a domain filter is combined with it.' });
    cond = c.matchType === 'domain' ? urlCondition(c, errors, false) : {};
    if (find) cond.regexFilter = '^(.*?)' + escapeRegex(find) + '(.*)$';
  } else {
    cond = urlCondition(c, errors, needRegex);
  }

  switch (type) {
    case 'requestHeaders':
    case 'responseHeaders': {
      const kind = type === 'requestHeaders' ? 'request' : 'response';
      const ops = headerOps(a.headers, kind, errors, 'action.headers');
      if (!ops.length && !errors.length) errors.push({ field: 'action.headers', message: 'Add at least one header.' });
      action = { type: 'modifyHeaders', [kind === 'request' ? 'requestHeaders' : 'responseHeaders']: ops };
      if (kind === 'request' && ops.some(o => o.header.toLowerCase() === 'cookie')) warnings.push({ field: 'action.headers', message: 'Cookie set here replaces the browser cookies for matching requests.' });
      break;
    }
    case 'userAgent': {
      const value = String(a.value || '').trim();
      if (!value) errors.push({ field: 'action.value', message: 'Choose a preset or type a user agent.' });
      if (/[\r\n]/.test(value)) errors.push({ field: 'action.value', message: 'No line breaks allowed.' });
      const ops = [{ header: 'user-agent', operation: 'set', value }];
      if (a.dropClientHints !== false) for (const h of CLIENT_HINT_HEADERS) ops.push({ header: h, operation: 'remove' });
      action = { type: 'modifyHeaders', requestHeaders: ops };
      warnings.push({ field: 'action.value', message: 'Only the HTTP header changes; navigator.userAgent in page scripts keeps the real value.' });
      break;
    }
    case 'redirect': {
      const url = String(a.url || '').trim();
      if (!url) { errors.push({ field: 'action.url', message: 'Enter the destination URL.' }); break; }
      if (/^javascript:/i.test(url)) { errors.push({ field: 'action.url', message: 'javascript: URLs are not allowed.' }); break; }
      if (needRegex) {
        if (c.matchType === 'wildcard' && !cond.regexFilter) cond.regexFilter = wildcardToRegex(c.value);
        action = { type: 'redirect', redirect: { regexSubstitution: toRegexSubstitution(url) } };
        const groups = c.matchType === 'wildcard' ? (String(c.value).match(/\*/g) || []).length : countRegexGroups(c.value);
        const refs = [...url.matchAll(/[$\\]([0-9])/g)].map(m => +m[1]);
        const max = Math.max(0, ...refs);
        if (max > groups) errors.push({ field: 'action.url', message: `Destination uses $${max} but the pattern has only ${groups} capture group${groups === 1 ? '' : 's'}.` });
      } else {
        try { new URL(url); } catch { errors.push({ field: 'action.url', message: 'Destination must be an absolute URL (https://...).' }); break; }
        action = { type: 'redirect', redirect: { url } };
      }
      break;
    }
    case 'replace': {
      action = { type: 'redirect', redirect: { regexSubstitution: '\\1' + escapeSubstitution(a.replaceWith || '') + '\\2' } };
      break;
    }
    case 'host': {
      const from = parseHostPort(a.fromHost);
      const to = parseHostPort(a.toHost);
      if (!from.host) errors.push({ field: 'action.fromHost', message: 'Enter the host to replace.' });
      if (!to.host) errors.push({ field: 'action.toHost', message: 'Enter the new host.' });
      else if (!isAscii(to.host) || !/^[a-z0-9.\-_]+$|^\[[0-9a-f:.]+\]$/.test(to.host)) errors.push({ field: 'action.toHost', message: 'New host is not a valid hostname.' });
      if (from.host && to.host && from.host === to.host && from.port === to.port && !a.scheme) errors.push({ field: 'action.toHost', message: 'New host is the same as the old one.' });
      if (errors.length) break;
      const transform = { host: to.host };
      if (to.port !== undefined) transform.port = to.port;
      if (a.scheme) transform.scheme = a.scheme;
      action = { type: 'redirect', redirect: { transform } };
      if (from.port) {
        if (cond.urlFilter || cond.regexFilter) {
          cond.regexFilter = cond.regexFilter || null;
          errors.push({ field: 'action.fromHost', message: 'A host with a port cannot be combined with another URL filter; use match type "All URLs".' });
        } else cond.regexFilter = `^[a-z][a-z0-9+.-]*://${escapeRegex(from.host)}:${from.port}(?:[/?#]|$)`;
      } else {
        const d = normalizeDomain(from.host);
        cond.requestDomains = cond.requestDomains ? cond.requestDomains.filter(x => x === d || x.endsWith('.' + d) || d.endsWith('.' + x)) : [d];
        if (!cond.requestDomains.length) cond.requestDomains = [d];
      }
      break;
    }
    case 'query': {
      const add = (a.add || []).filter(p => String(p.key || '').trim());
      const remove = splitList(a.remove);
      if (!add.length && !remove.length) errors.push({ field: 'action.add', message: 'Add or remove at least one parameter.' });
      const qt = {};
      if (add.length) qt.addOrReplaceParams = add.map(p => {
        const o = { key: String(p.key).trim(), value: String(p.value ?? '') };
        if (p.replaceOnly) o.replaceOnly = true;
        return o;
      });
      if (remove.length) qt.removeParams = remove;
      action = { type: 'redirect', redirect: { transform: { queryTransform: qt } } };
      break;
    }
    case 'block': action = { type: 'block' }; break;
    case 'allow': action = { type: 'allow' }; break;
    case 'mock': {
      const bytes = byteLength(a.body);
      if (bytes > MOCK_MAX_BYTES) { errors.push({ field: 'action.body', message: `Body is ${formatBytes(bytes)}; the limit is ${formatBytes(MOCK_MAX_BYTES)}.` }); break; }
      if (bytes > MOCK_WARN_BYTES) warnings.push({ field: 'action.body', message: `Large mock (${formatBytes(bytes)}). Every mock is stored inside the rule; keep them small.` });
      if (!String(a.contentType || '').trim()) errors.push({ field: 'action.contentType', message: 'Enter a content type.' });
      else if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(;.*)?$/i.test(String(a.contentType).trim())) errors.push({ field: 'action.contentType', message: 'Content type should look like type/subtype.' });
      if (String(a.contentType).includes('json') && a.body) { try { JSON.parse(a.body); } catch (e) { warnings.push({ field: 'action.body', message: `Body is not valid JSON: ${e.message}` }); } }
      action = { type: 'redirect', redirect: { url: buildMockDataUrl(a) } };
      if (c.matchType === 'all') warnings.push({ field: 'condition.matchType', message: 'Mocking every URL will break most pages; narrow the match.' });
      break;
    }
    default: errors.push({ field: 'type', message: `Unknown rule type ${type}` });
  }

  // Resource types: DNR skips main_frame when none are listed, which surprises users, so be explicit.
  let types = c.resourceTypes && c.resourceTypes.length ? c.resourceTypes.slice() : RESOURCE_TYPES.slice();
  if (type === 'mock' && (!c.resourceTypes || !c.resourceTypes.length)) types = types.filter(t => t !== 'main_frame');
  if (type === 'mock' && types.includes('main_frame')) warnings.push({ field: 'condition.resourceTypes', message: 'Chrome refuses top-level navigation to data: URLs, so mocks do not apply to pages (main frame).' });
  if ((type === 'redirect' || type === 'replace' || type === 'host' || type === 'query') && types.includes('main_frame') && types.length === RESOURCE_TYPES.length) {
    // fine, the common case
  }
  cond.resourceTypes = types;
  if (c.methods && c.methods.length) cond.requestMethods = c.methods.slice();
  const ini = domainList(c.initiatorDomains, 'condition.initiatorDomains', errors);
  if (ini.length) cond.initiatorDomains = ini;
  const exIni = domainList(c.excludedInitiatorDomains, 'condition.excludedInitiatorDomains', errors);
  if (exIni.length) cond.excludedInitiatorDomains = exIni;
  const exReq = domainList(c.excludedRequestDomains, 'condition.excludedRequestDomains', errors);
  if (exReq.length) cond.excludedRequestDomains = exReq;
  if (opts.tabIds && opts.tabIds.length) cond.tabIds = opts.tabIds.slice();
  if (cond.urlFilter && cond.regexFilter) { delete cond.urlFilter; }
  if (cond.regexFilter === null) delete cond.regexFilter;

  if (errors.length || !action) return { dnr: null, errors, warnings };
  const dnr = { id: opts.id || 1, priority: rule.priority || 1, action, condition: cond };
  return { dnr, errors, warnings };
}

export function countRegexGroups(re) {
  try { return new RegExp(String(re) + '|').exec('').length - 1; } catch { return 0; }
}

/**
 * Compiles all enabled rules of enabled groups. Returns
 * { rules: DNR[], map: { [dnrId]: {groupId, ruleId} }, errors: { [ruleId]: [...] }, regexCount }.
 */
export function compileState(state, { startId = 1 } = {}) {
  const rules = [];
  const map = {};
  const errors = {};
  let id = startId;
  let regexCount = 0;
  if (state.paused) return { rules, map, errors, regexCount };
  for (const g of state.groups) {
    if (!g.enabled) continue;
    for (const r of g.rules) {
      if (!r.enabled) continue;
      const res = compileRule(r, { id });
      if (!res.dnr) { errors[r.id] = res.errors.map(e => e.message); continue; }
      if (res.dnr.condition.regexFilter) regexCount++;
      rules.push(res.dnr);
      map[id] = { groupId: g.id, ruleId: r.id };
      id++;
    }
  }
  return { rules, map, errors, regexCount };
}

export function countActiveRules(state) {
  if (state.paused) return 0;
  let n = 0;
  for (const g of state.groups) if (g.enabled) for (const r of g.rules) if (r.enabled) n++;
  return n;
}

export function findRule(state, ruleId) {
  for (const g of state.groups) {
    const r = g.rules.find(x => x.id === ruleId);
    if (r) return { group: g, rule: r };
  }
  return null;
}

// ---------- local matcher (mirrors DNR semantics for the URL tester) ----------

export function urlFilterToRegExp(filter) {
  let f = String(filter);
  let re = '';
  if (f.startsWith('||')) { re = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#@]*@)?(?:[^/?#]*\\.)?'; f = f.slice(2); }
  else if (f.startsWith('|')) { re = '^'; f = f.slice(1); }
  let end = '';
  if (f.endsWith('|')) { end = '$'; f = f.slice(0, -1); }
  for (const ch of f) {
    if (ch === '*') re += '.*';
    else if (ch === '^') re += '(?:[^a-zA-Z0-9_\\-.%]|$)';
    else re += escapeRegex(ch);
  }
  return new RegExp(re + end, 'i');
}

function hostMatches(host, domains) {
  return domains.some(d => host === d || host.endsWith('.' + d));
}

export function conditionMatches(cond, req) {
  let url;
  try { url = new URL(req.url); } catch { return { ok: false, reason: 'invalid URL' }; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, (m) => m);
  if (cond.urlFilter && !urlFilterToRegExp(cond.urlFilter).test(req.url)) return { ok: false, reason: 'URL does not match the filter' };
  if (cond.regexFilter) {
    let re;
    try { re = new RegExp(cond.regexFilter, 'i'); } catch { return { ok: false, reason: 'regex invalid' }; }
    if (!re.test(req.url)) return { ok: false, reason: 'URL does not match the regex' };
  }
  if (cond.requestDomains && !hostMatches(host, cond.requestDomains)) return { ok: false, reason: `host ${host} not in ${cond.requestDomains.join(', ')}` };
  if (cond.excludedRequestDomains && hostMatches(host, cond.excludedRequestDomains)) return { ok: false, reason: `host ${host} is excluded` };
  if (cond.resourceTypes && req.type && !cond.resourceTypes.includes(req.type)) return { ok: false, reason: `resource type ${req.type} not included` };
  if (cond.requestMethods && req.method && !cond.requestMethods.includes(req.method.toLowerCase())) return { ok: false, reason: `method ${req.method.toUpperCase()} not included` };
  const iniHost = req.initiator ? normalizeDomain(req.initiator) : '';
  if (cond.initiatorDomains && (!iniHost || !hostMatches(iniHost, cond.initiatorDomains))) return { ok: false, reason: iniHost ? `initiator ${iniHost} not allowed` : 'needs an initiator domain' };
  if (cond.excludedInitiatorDomains && iniHost && hostMatches(iniHost, cond.excludedInitiatorDomains)) return { ok: false, reason: `initiator ${iniHost} excluded` };
  if (cond.tabIds && req.tabId !== undefined && !cond.tabIds.includes(req.tabId)) return { ok: false, reason: 'other tab' };
  return { ok: true };
}

export function applyRedirect(dnr, urlStr) {
  const r = dnr.action.redirect;
  if (r.url) return r.url;
  if (r.regexSubstitution !== undefined) {
    const re = new RegExp(dnr.condition.regexFilter, 'i');
    const m = re.exec(urlStr);
    if (!m) return urlStr;
    let sub = '';
    const s = r.regexSubstitution;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && /[0-9]/.test(s[i + 1] || '')) { sub += m[+s[i + 1]] ?? ''; i++; }
      else if (s[i] === '\\' && s[i + 1] === '\\') { sub += '\\'; i++; }
      else sub += s[i];
    }
    return urlStr.slice(0, m.index) + sub + urlStr.slice(m.index + m[0].length);
  }
  if (r.transform) {
    const u = new URL(urlStr);
    const t = r.transform;
    if (t.scheme) u.protocol = t.scheme + ':';
    if (t.host) u.hostname = t.host;
    if (t.port !== undefined) u.port = t.port;
    if (t.path !== undefined) u.pathname = t.path;
    if (t.queryTransform) {
      const params = new URLSearchParams(u.search);
      for (const k of t.queryTransform.removeParams || []) params.delete(k);
      for (const p of t.queryTransform.addOrReplaceParams || []) {
        if (params.has(p.key)) params.set(p.key, p.value);
        else if (!p.replaceOnly) params.append(p.key, p.value);
      }
      const q = params.toString();
      u.search = q ? '?' + q : '';
    }
    return u.toString();
  }
  return urlStr;
}

const ACTION_RANK = { allow: 5, allowAllRequests: 5, block: 4, upgradeScheme: 3, redirect: 2, modifyHeaders: 1 };

/**
 * Evaluates the state against a request description.
 * req: { url, type, method, initiator }
 * Returns { checks: [{group, rule, matched, reason, dnr}], outcome }.
 */
export function testRequest(state, req, { includeDisabled = true } = {}) {
  const checks = [];
  const live = [];
  let id = 1;
  for (const g of state.groups) {
    for (const r of g.rules) {
      const active = !state.paused && g.enabled && r.enabled;
      if (!active && !includeDisabled) continue;
      const { dnr, errors } = compileRule(r, { id: id++ });
      if (!dnr) { checks.push({ group: g, rule: r, active, matched: false, reason: `invalid: ${errors[0] && errors[0].message}` }); continue; }
      const m = conditionMatches(dnr.condition, req);
      const check = { group: g, rule: r, active, matched: m.ok, reason: m.ok ? '' : m.reason, dnr };
      checks.push(check);
      if (active && m.ok) live.push(check);
    }
  }
  const outcome = resolveOutcome(live, req);
  if (outcome.redirectTo) {
    // Loop detection: does the destination get redirected again by the same rule?
    const again = [];
    for (const c of live.length ? checks.filter(x => x.active && x.dnr) : []) {
      if (c.dnr.action.type !== 'redirect') continue;
      if (conditionMatches(c.dnr.condition, { ...req, url: outcome.redirectTo }).ok) {
        const next = applyRedirect(c.dnr, outcome.redirectTo);
        if (next !== outcome.redirectTo) again.push(c);
      }
    }
    if (again.length) outcome.loopWarning = `The destination is redirected again by "${ruleDisplayName(again[0].rule)}" which may loop.`;
  }
  return { checks, outcome };
}

function resolveOutcome(live, req) {
  const out = { verdict: 'unchanged', winner: null, redirectTo: null, requestHeaders: [], responseHeaders: [], applied: [] };
  const terminal = live.filter(c => c.dnr.action.type !== 'modifyHeaders');
  terminal.sort((x, y) => (y.dnr.priority - x.dnr.priority) || (ACTION_RANK[y.dnr.action.type] - ACTION_RANK[x.dnr.action.type]));
  const win = terminal[0] || null;
  let headerFloor = 0;
  if (win) {
    out.winner = win;
    out.applied.push(win);
    const t = win.dnr.action.type;
    if (t === 'block') { out.verdict = 'blocked'; return out; }
    if (t === 'redirect') {
      out.verdict = win.rule.type === 'mock' ? 'mocked' : 'redirected';
      out.redirectTo = applyRedirect(win.dnr, req.url);
      if (out.redirectTo === req.url) { out.verdict = 'unchanged'; out.redirectTo = null; out.applied = []; out.winner = null; }
    }
    if (t === 'allow') { out.verdict = 'allowed'; headerFloor = win.dnr.priority; }
  }
  const headerRules = live.filter(c => c.dnr.action.type === 'modifyHeaders' && c.dnr.priority > headerFloor);
  headerRules.sort((x, y) => y.dnr.priority - x.dnr.priority);
  for (const c of headerRules) {
    out.applied.push(c);
    for (const h of c.dnr.action.requestHeaders || []) out.requestHeaders.push({ ...h, rule: c.rule });
    for (const h of c.dnr.action.responseHeaders || []) out.responseHeaders.push({ ...h, rule: c.rule });
  }
  if (out.verdict === 'unchanged' && headerRules.length) out.verdict = 'modified';
  return out;
}

// ---------- import / export ----------

export function exportState(state, groupIds) {
  const groups = state.groups.filter(g => !groupIds || groupIds.includes(g.id));
  return { format: FORMAT, version: FORMAT_VERSION, exportedAt: new Date().toISOString(), groups: clone(groups) };
}

function freshIds(group) {
  const g = normalizeGroup(clone(group));
  g.id = uid('g');
  g.rules = g.rules.map(r => ({ ...r, id: uid('r') }));
  return g;
}

/**
 * Parses any supported JSON (our export, a single group, a rule list, or ModHeader profiles).
 * Returns { groups, source, warnings }.
 */
export function parseImport(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  const warnings = [];
  if (data && data.format === FORMAT && Array.isArray(data.groups)) {
    return { groups: data.groups.map(freshIds), source: 'Request Rewriter', warnings };
  }
  if (isModHeader(data)) return importModHeader(data);
  if (data && Array.isArray(data.groups)) return { groups: data.groups.map(freshIds), source: 'groups', warnings };
  if (data && Array.isArray(data.rules)) return { groups: [freshIds({ name: data.name || 'Imported', ...data })], source: 'group', warnings };
  if (Array.isArray(data) && data.length && data.every(r => r && RULE_TYPES[r.type])) {
    return { groups: [freshIds({ name: 'Imported rules', rules: data })], source: 'rules', warnings };
  }
  throw new Error('Unrecognized format. Expected a Request Rewriter export or ModHeader profiles.');
}

function isModHeader(data) {
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.profiles) ? data.profiles : (data && (data.headers || data.respHeaders) ? [data] : null));
  return !!(arr && arr.length && arr.every(p => p && typeof p === 'object' && ('headers' in p || 'respHeaders' in p || 'title' in p || 'urlReplacements' in p)) && arr.some(p => 'headers' in p || 'respHeaders' in p || 'urlReplacements' in p));
}

const MODHEADER_RES_MAP = { main_frame: 'main_frame', sub_frame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', object: 'object', xmlhttprequest: 'xmlhttprequest', ping: 'ping', csp_report: 'csp_report', media: 'media', websocket: 'websocket', other: 'other' };

export function importModHeader(data) {
  const profiles = Array.isArray(data) ? data : (Array.isArray(data.profiles) ? data.profiles : [data]);
  const warnings = [];
  const groups = [];
  profiles.forEach((p, idx) => {
    const name = p.title || p.shortTitle || `ModHeader profile ${idx + 1}`;
    const g = newGroup(name, { color: GROUP_COLORS[idx % GROUP_COLORS.length], description: 'Imported from ModHeader', enabled: idx === 0 });
    if (/^#[0-9a-f]{6}$/i.test(p.backgroundColor || '')) g.color = p.backgroundColor;
    const cond = defaultCondition();
    const filters = (p.urlFilters || p.filters || []).filter(f => f && f.enabled !== false).map(f => f.urlRegex || f.urlPattern || f.value || f.url || '').filter(Boolean);
    if (filters.length === 1) { cond.matchType = 'regex'; cond.value = filters[0]; }
    else if (filters.length > 1) { cond.matchType = 'regex'; cond.value = filters.map(f => `(?:${f})`).join('|'); }
    if ((p.excludeUrlFilters || []).some(f => f && f.enabled !== false)) warnings.push(`${name}: exclude URL filters are not supported and were skipped.`);
    if ((p.tabFilters || []).length || (p.tabGroupFilters || []).length || (p.windowFilters || []).length) warnings.push(`${name}: tab/window filters were skipped (use the popup's "This tab only").`);
    if ((p.timeFilters || []).length) warnings.push(`${name}: time filters were skipped.`);
    const resTypes = new Set();
    for (const f of (p.resFilters || p.resourceFilters || [])) {
      if (!f || f.enabled === false) continue;
      for (const t of [].concat(f.resourceType || f.resourceTypes || [])) if (MODHEADER_RES_MAP[t]) resTypes.add(MODHEADER_RES_MAP[t]);
    }
    cond.resourceTypes = [...resTypes];
    const init = (p.initiatorDomainFilters || []).filter(f => f && f.enabled !== false).map(f => f.domain || f.value).filter(Boolean);
    if (init.length) cond.initiatorDomains = init;

    const mapHeaders = (list, kind) => {
      const on = []; const off = [];
      for (const h of list || []) {
        if (!h || !h.name) continue;
        let op = 'set';
        if (p.appendMode && (kind === 'response' || APPENDABLE_REQUEST_HEADERS.includes(String(h.name).toLowerCase()))) op = 'append';
        const row = { op, name: String(h.name).trim(), value: String(h.value ?? '') };
        (h.enabled === false ? off : on).push(row);
      }
      return { on, off };
    };
    const req = mapHeaders(p.headers, 'request');
    const res = mapHeaders(p.respHeaders || p.responseHeaders, 'response');
    const add = (type, rows, enabled, suffix) => {
      if (!rows.length) return;
      g.rules.push(normalizeRule({ type, name: `${type === 'requestHeaders' ? 'Request' : 'Response'} headers${suffix}`, enabled, condition: clone(cond), action: { headers: rows } }));
    };
    add('requestHeaders', req.on, true, '');
    add('requestHeaders', req.off, false, ' (disabled in ModHeader)');
    add('responseHeaders', res.on, true, '');
    add('responseHeaders', res.off, false, ' (disabled in ModHeader)');
    if ((p.cookieHeaders || []).length) {
      const cookie = p.cookieHeaders.filter(c => c && c.name && c.enabled !== false).map(c => `${c.name}=${c.value ?? ''}`).join('; ');
      if (cookie) g.rules.push(normalizeRule({ type: 'requestHeaders', name: 'Cookies', condition: clone(cond), action: { headers: [{ op: 'append', name: 'Cookie', value: cookie }] } }));
    }
    if ((p.setCookieHeaders || []).length) warnings.push(`${name}: Set-Cookie modifiers were skipped.`);
    if ((p.cspHeaders || []).length) {
      const csp = p.cspHeaders.filter(c => c && c.enabled !== false && c.value).map(c => c.value).join('; ');
      if (csp) g.rules.push(normalizeRule({ type: 'responseHeaders', name: 'CSP', condition: clone(cond), action: { headers: [{ op: 'set', name: 'Content-Security-Policy', value: csp }] } }));
    }
    for (const rep of p.urlReplacements || []) {
      if (!rep || !rep.name) continue;
      g.rules.push(normalizeRule({ type: 'replace', name: `Replace ${rep.name}`, enabled: rep.enabled !== false, condition: { ...defaultCondition(), resourceTypes: cond.resourceTypes }, action: { find: rep.name, replaceWith: rep.value || '' } }));
    }
    if (!g.rules.length) warnings.push(`${name}: nothing importable.`);
    groups.push(g);
  });
  return { groups, source: 'ModHeader', warnings };
}
