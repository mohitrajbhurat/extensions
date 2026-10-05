// Unit tests for lib/rules.js (pure module). Run: node --test request-rewriter/test/rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newRule, newGroup, defaultCondition, compileRule, testRequest, parseImport, exportState, normalizeState,
  defaultState, conditionMatches, applyRedirect, urlFilterToRegExp, normalizeDomain, countActiveRules,
} from '../lib/rules.js';

const cond = patch => ({ ...defaultCondition(), ...patch });
const compile = r => compileRule(r, { id: 7 });
const stateOf = (...rules) => ({ paused: false, groups: [{ ...newGroup('G'), rules }] });

test('request header set compiles to modifyHeaders', () => {
  const { dnr, errors } = compile(newRule('requestHeaders', { condition: cond({ matchType: 'domain', value: 'https://Example.com/x' }), action: { headers: [{ op: 'set', name: 'X-Debug', value: '1' }] } }));
  assert.deepEqual(errors, []);
  assert.equal(dnr.id, 7);
  assert.deepEqual(dnr.action, { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Debug', operation: 'set', value: '1' }] });
  assert.deepEqual(dnr.condition.requestDomains, ['example.com']);
  assert.ok(dnr.condition.resourceTypes.includes('main_frame'));
});

test('append is rejected on request headers Chrome does not allow', () => {
  const { dnr, errors } = compile(newRule('requestHeaders', { action: { headers: [{ op: 'append', name: 'X-Custom', value: '1' }] } }));
  assert.equal(dnr, null);
  assert.match(errors[0].message, /append/);
  assert.ok(compile(newRule('requestHeaders', { action: { headers: [{ op: 'append', name: 'Accept-Language', value: 'fr' }] } })).dnr);
});

test('invalid header names and values are reported', () => {
  assert.ok(compile(newRule('responseHeaders', { action: { headers: [{ op: 'set', name: 'Bad Name', value: 'x' }] } })).errors.length);
  assert.ok(compile(newRule('responseHeaders', { action: { headers: [{ op: 'set', name: 'X', value: 'a\nb' }] } })).errors.length);
});

test('url match types', () => {
  const c = (matchType, value) => compile(newRule('block', { condition: cond({ matchType, value }) })).dnr.condition;
  assert.equal(c('contains', '/api/').urlFilter, '/api/');
  assert.equal(c('exact', 'https://a.com/x').urlFilter, '|https://a.com/x|');
  assert.equal(c('wildcard', '*://a.com/*').urlFilter, '*://a.com/*');
  assert.equal(c('wildcard', 'https://a.com/*').urlFilter, '|https://a.com/*');
  assert.equal(c('contains', 'a^b').regexFilter, 'a\\^b');
  assert.equal(c('regex', '^https://x\\.com/(\\d+)$').regexFilter, '^https://x\\.com/(\\d+)$');
  assert.equal(c('urlFilter', '||ads.example^').urlFilter, '||ads.example^');
  assert.equal(c('all', '').urlFilter, undefined);
});

test('regex validation catches unsupported syntax', () => {
  assert.ok(compile(newRule('block', { condition: cond({ matchType: 'regex', value: 'a(?=b)' }) })).errors.length);
  assert.ok(compile(newRule('block', { condition: cond({ matchType: 'regex', value: '(a' }) })).errors.length);
  assert.ok(compile(newRule('block', { condition: cond({ matchType: 'regex', value: '' }) })).errors.length);
});

test('wildcard redirect with captures', () => {
  const r = newRule('redirect', { condition: cond({ matchType: 'wildcard', value: 'https://prod.example.com/*' }), action: { url: 'https://staging.example.com/$1' } });
  const { dnr, errors } = compile(r);
  assert.deepEqual(errors, []);
  assert.equal(dnr.condition.regexFilter, '^https://prod\\.example\\.com/(.*)$');
  assert.equal(dnr.action.redirect.regexSubstitution, 'https://staging.example.com/\\1');
  assert.equal(applyRedirect(dnr, 'https://prod.example.com/a/b?c=1'), 'https://staging.example.com/a/b?c=1');
});

test('regex redirect checks group count', () => {
  const bad = compile(newRule('redirect', { condition: cond({ matchType: 'regex', value: '^https://(a)\\.com/' }), action: { url: 'https://b.com/$2' } }));
  assert.match(bad.errors[0].message, /\$2/);
  const refsWithContains = compile(newRule('redirect', { condition: cond({ matchType: 'contains', value: 'x' }), action: { url: 'https://b.com/$1' } }));
  assert.ok(refsWithContains.errors.length);
  const plain = compile(newRule('redirect', { condition: cond({ matchType: 'exact', value: 'https://a.com/' }), action: { url: 'https://b.com/' } }));
  assert.deepEqual(plain.dnr.action.redirect, { url: 'https://b.com/' });
  assert.ok(compile(newRule('redirect', { condition: cond({ matchType: 'exact', value: 'https://a.com/' }), action: { url: 'javascript:alert(1)' } })).errors.length);
});

test('replace text in URL', () => {
  const { dnr } = compile(newRule('replace', { action: { find: '/v1/', replaceWith: '/v2/' } }));
  assert.equal(applyRedirect(dnr, 'https://a.com/api/v1/users'), 'https://a.com/api/v2/users');
  assert.equal(conditionMatches(dnr.condition, { url: 'https://a.com/api/v3/users' }).ok, false);
});

test('host replace with port and scheme', () => {
  const { dnr, errors } = compile(newRule('host', { action: { fromHost: 'api.example.com', toHost: 'localhost:3000', scheme: 'http' } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(dnr.condition.requestDomains, ['api.example.com']);
  assert.deepEqual(dnr.action.redirect.transform, { host: 'localhost', port: '3000', scheme: 'http' });
  assert.equal(applyRedirect(dnr, 'https://api.example.com/x?y=1'), 'http://localhost:3000/x?y=1');
  const fromPort = compile(newRule('host', { action: { fromHost: 'localhost:8080', toHost: 'localhost:9090' } })).dnr;
  assert.ok(fromPort.condition.regexFilter.includes(':8080'));
  assert.ok(compile(newRule('host', { action: { fromHost: 'a.com', toHost: 'a.com' } })).errors.length);
});

test('query params add and remove', () => {
  const { dnr } = compile(newRule('query', { action: { add: [{ key: 'debug', value: '1' }, { key: 'lang', value: 'fr', replaceOnly: true }], remove: 'utm_source, fbclid' } }));
  assert.equal(applyRedirect(dnr, 'https://a.com/?utm_source=x&q=1&fbclid=2'), 'https://a.com/?q=1&debug=1');
  assert.equal(applyRedirect(dnr, 'https://a.com/?lang=en'), 'https://a.com/?lang=fr&debug=1');
});

test('mock builds a base64 data URL, skips main_frame and enforces size', () => {
  const { dnr, errors } = compile(newRule('mock', { condition: cond({ matchType: 'exact', value: 'https://a.com/flags' }), action: { contentType: 'application/json', charset: 'utf-8', body: '{"é":1}' } }));
  assert.deepEqual(errors, []);
  assert.equal(dnr.action.redirect.url, 'data:application/json;charset=utf-8;base64,' + Buffer.from('{"é":1}').toString('base64'));
  assert.ok(!dnr.condition.resourceTypes.includes('main_frame'));
  const huge = compile(newRule('mock', { condition: cond({ matchType: 'exact', value: 'https://a.com/' }), action: { contentType: 'text/plain', body: 'x'.repeat(1024 * 1024 + 1) } }));
  assert.equal(huge.dnr, null);
  const badJson = compile(newRule('mock', { condition: cond({ matchType: 'exact', value: 'https://a.com/' }), action: { contentType: 'application/json', body: '{nope' } }));
  assert.ok(badJson.warnings.some(w => /JSON/.test(w.message)));
});

test('user agent override drops client hints', () => {
  const { dnr } = compile(newRule('userAgent'));
  assert.equal(dnr.action.requestHeaders[0].header, 'user-agent');
  assert.ok(dnr.action.requestHeaders.some(h => h.header === 'sec-ch-ua' && h.operation === 'remove'));
});

test('conditions: methods, resource types, initiators, tab ids', () => {
  const r = newRule('block', { condition: cond({ matchType: 'all', methods: ['post'], resourceTypes: ['xmlhttprequest'], initiatorDomains: 'app.example.com', excludedRequestDomains: ['cdn.example.com'] }) });
  const { dnr } = compileRule(r, { id: 1000001, tabIds: [42] });
  assert.deepEqual(dnr.condition.requestMethods, ['post']);
  assert.deepEqual(dnr.condition.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(dnr.condition.initiatorDomains, ['app.example.com']);
  assert.deepEqual(dnr.condition.tabIds, [42]);
  const ok = { url: 'https://api.x.com/', type: 'xmlhttprequest', method: 'POST', initiator: 'https://app.example.com' };
  assert.equal(conditionMatches(dnr.condition, ok).ok, true);
  assert.equal(conditionMatches(dnr.condition, { ...ok, method: 'GET' }).ok, false);
  assert.equal(conditionMatches(dnr.condition, { ...ok, initiator: 'https://evil.com' }).ok, false);
  assert.equal(conditionMatches(dnr.condition, { ...ok, url: 'https://cdn.example.com/a' }).ok, false);
  assert.ok(compile(newRule('block', { condition: cond({ initiatorDomains: 'bücher.de' }) })).errors.length);
});

test('tester resolves priority and action ranks like DNR', () => {
  const block = newRule('block', { condition: cond({ matchType: 'domain', value: 'a.com' }) });
  const redirect = newRule('redirect', { condition: cond({ matchType: 'contains', value: 'a.com' }), action: { url: 'https://b.com/' } });
  const header = newRule('requestHeaders', { action: { headers: [{ op: 'set', name: 'X-A', value: '1' }] } });
  let res = testRequest(stateOf(block, redirect, header), { url: 'https://a.com/', type: 'main_frame', method: 'get' });
  assert.equal(res.outcome.verdict, 'blocked');
  redirect.priority = 2;
  res = testRequest(stateOf(block, redirect, header), { url: 'https://a.com/', type: 'main_frame', method: 'get' });
  assert.equal(res.outcome.verdict, 'redirected');
  assert.equal(res.outcome.redirectTo, 'https://b.com/');
  res = testRequest(stateOf(header), { url: 'https://z.com/', type: 'main_frame', method: 'get' });
  assert.equal(res.outcome.verdict, 'modified');
  assert.equal(res.outcome.requestHeaders[0].header, 'X-A');
  const allow = newRule('allow', { priority: 5, condition: cond({ matchType: 'domain', value: 'a.com' }) });
  res = testRequest(stateOf(block, allow, header), { url: 'https://a.com/', type: 'script', method: 'get' });
  assert.equal(res.outcome.verdict, 'allowed');
  assert.equal(res.outcome.requestHeaders.length, 0);
});

test('tester warns about redirect loops', () => {
  const r = newRule('replace', { action: { find: 'x', replaceWith: 'xx' } });
  const res = testRequest(stateOf(r), { url: 'https://a.com/x', type: 'script', method: 'get' });
  assert.match(res.outcome.loopWarning, /loop/);
});

test('paused and disabled rules do not apply', () => {
  const s = stateOf(newRule('block'));
  s.paused = true;
  assert.equal(countActiveRules(s), 0);
  assert.equal(testRequest(s, { url: 'https://a.com/' }).outcome.verdict, 'unchanged');
});

test('urlFilter matcher semantics', () => {
  assert.ok(urlFilterToRegExp('||example.com^').test('https://sub.example.com/x'));
  assert.ok(!urlFilterToRegExp('||example.com^').test('https://notexample.com/x'));
  assert.ok(urlFilterToRegExp('|https://a.com/x|').test('https://a.com/x'));
  assert.ok(!urlFilterToRegExp('|https://a.com/x|').test('https://a.com/xy'));
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain('https://user@Sub.Example.com:8080/path'), 'sub.example.com');
  assert.equal(normalizeDomain('*.example.com'), 'example.com');
  assert.equal(normalizeDomain(''), '');
});

test('export / import round trip gives fresh ids', () => {
  const s = defaultState();
  const out = exportState(s);
  const back = parseImport(JSON.stringify(out));
  assert.equal(back.source, 'Request Rewriter');
  assert.equal(back.groups.length, s.groups.length);
  assert.notEqual(back.groups[0].id, s.groups[0].id);
  assert.equal(back.groups[0].rules.length, s.groups[0].rules.length);
  assert.throws(() => parseImport('{nope'), /JSON/);
  assert.throws(() => parseImport('{"x":1}'), /Unrecognized/);
});

test('ModHeader import (best effort)', () => {
  const profiles = [{
    title: 'Staging', backgroundColor: '#ff0000',
    headers: [{ enabled: true, name: 'X-Env', value: 'staging' }, { enabled: false, name: 'X-Off', value: '1' }],
    respHeaders: [{ enabled: true, name: 'Access-Control-Allow-Origin', value: '*' }],
    urlFilters: [{ enabled: true, urlRegex: '.*://api\\.example\\.com/.*' }],
    resFilters: [{ enabled: true, resourceType: ['xmlhttprequest'] }],
    cookieHeaders: [{ enabled: true, name: 'session', value: 'abc' }],
    urlReplacements: [{ enabled: true, name: 'prod.example.com', value: 'staging.example.com' }],
    timeFilters: [{ enabled: true }],
  }];
  const res = parseImport(JSON.stringify(profiles));
  assert.equal(res.source, 'ModHeader');
  const g = res.groups[0];
  assert.equal(g.name, 'Staging');
  assert.equal(g.color, '#ff0000');
  const types = g.rules.map(r => r.type);
  assert.deepEqual(types, ['requestHeaders', 'requestHeaders', 'responseHeaders', 'requestHeaders', 'replace']);
  assert.equal(g.rules[1].enabled, false);
  assert.equal(g.rules[0].condition.matchType, 'regex');
  assert.deepEqual(g.rules[0].condition.resourceTypes, ['xmlhttprequest']);
  assert.ok(res.warnings.some(w => /time/.test(w)));
  for (const r of g.rules) assert.ok(compileRule(r, { id: 1 }).dnr, `compiles: ${r.name}`);
});

test('normalizeState repairs junk', () => {
  const s = normalizeState({ groups: [{ name: 'x', rules: [{ type: 'nope', condition: { matchType: 'weird', methods: 'GET, post' } }] }] });
  const r = s.groups[0].rules[0];
  assert.equal(r.type, 'requestHeaders');
  assert.equal(r.condition.matchType, 'all');
  assert.deepEqual(r.condition.methods, ['get', 'post']);
  assert.equal(normalizeState(null).groups[0].name, 'Examples');
});
