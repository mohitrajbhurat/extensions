// Unit tests for the pure library modules. Run: node api-workbench/test/unit.mjs
import assert from 'node:assert/strict';
import { getPath, parsePath } from '../lib/jsonpath.js';
import { evaluate, extract } from '../lib/assert.js';
import { parseCurl, toCurl, toFetch, tokenize } from '../lib/curl.js';
import { paramsFromUrl, urlFromParams, finalizeUrl } from '../lib/urlparams.js';
import { buildScope, resolve, findVars } from '../lib/vars.js';
import { importPostman, exportCollection } from '../lib/postman.js';
import { newRequest, kv } from '../lib/model.js';
import { effectiveAuth } from '../lib/send.js';

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
}

console.log('jsonpath');
const doc = { a: { b: [10, 20, { 'c d': 'x' }] }, items: [{ id: 1 }, { id: 2 }], s: 'hey' };
test('dot and index', () => assert.deepEqual(getPath(doc, '$.a.b[1]'), { found: true, value: 20 }));
test('negative index', () => assert.equal(getPath(doc, 'a.b[-1]["c d"]').value, 'x'));
test('wildcard collects', () => assert.deepEqual(getPath(doc, '$.items[*].id').value, [1, 2]));
test('length', () => { assert.equal(getPath(doc, '$.items.length').value, 2); assert.equal(getPath(doc, '$.s.length').value, 3); });
test('missing path', () => assert.equal(getPath(doc, '$.nope.x').found, false));
test('root', () => assert.equal(getPath(doc, '$').value, doc));
test('quoted brackets', () => assert.deepEqual(parsePath(`$['a.b']["q\\"x"]`), ['a.b', 'q"x']));

console.log('assertions');
const ctx = { status: 201, time: 120, size: 50, headers: [['Content-Type', 'application/json; charset=utf-8']], text: '{"id":7,"tags":["a","b"],"name":"Ada","n":null}', json: { id: 7, tags: ['a', 'b'], name: 'Ada', n: null }, jsonOk: true };
const run = list => evaluate(list.map((a, i) => ({ id: String(i), enabled: true, target: '', expected: '', ...a })), ctx);
test('status equals', () => assert.ok(run([{ type: 'status', op: 'eq', expected: '201' }])[0].pass));
test('status mismatch reports actual', () => { const r = run([{ type: 'status', op: 'eq', expected: '200' }])[0]; assert.equal(r.pass, false); assert.match(r.message, /201/); });
test('time under', () => assert.ok(run([{ type: 'time', op: 'lt', expected: '500' }])[0].pass));
test('json path equals number', () => assert.ok(run([{ type: 'json', target: '$.id', op: 'eq', expected: '7' }])[0].pass));
test('json path equals string unquoted', () => assert.ok(run([{ type: 'json', target: '$.name', op: 'eq', expected: 'Ada' }])[0].pass));
test('json path equals array', () => assert.ok(run([{ type: 'json', target: '$.tags', op: 'eq', expected: '["a","b"]' }])[0].pass));
test('json path exists / null exists', () => { assert.ok(run([{ type: 'json', target: '$.n', op: 'exists' }])[0].pass); assert.ok(run([{ type: 'json', target: '$.zz', op: 'notExists' }])[0].pass); });
test('array contains', () => assert.ok(run([{ type: 'json', target: '$.tags', op: 'contains', expected: 'b' }])[0].pass));
test('header contains (case-insensitive name)', () => assert.ok(run([{ type: 'header', target: 'content-type', op: 'contains', expected: 'json' }])[0].pass));
test('regex match', () => assert.ok(run([{ type: 'body', op: 'matches', expected: '/"id":\\d+/' }])[0].pass));
test('type check', () => assert.ok(run([{ type: 'json', target: '$.tags', op: 'type', expected: 'array' }])[0].pass));
test('invalid regex fails without throwing', () => assert.equal(run([{ type: 'body', op: 'matches', expected: '(' }])[0].pass, false));
test('disabled assertions skipped', () => assert.equal(evaluate([{ id: '1', enabled: false, type: 'status', op: 'eq', expected: '1' }], ctx).length, 0));
test('json on non-JSON response', () => assert.match(evaluate([{ id: '1', enabled: true, type: 'json', target: '$.a', op: 'exists' }], { ...ctx, jsonOk: false })[0].message, /not valid JSON/));
test('extract json + header', () => {
  const out = extract([{ source: 'json', path: '$.tags', variable: 't' }, { source: 'header', path: 'content-type', variable: 'ct' }, { source: 'json', path: '$.zz', variable: 'm' }], ctx);
  assert.equal(out[0].value, '["a","b"]'); assert.match(out[1].value, /json/); assert.ok(out[2].missing);
});

console.log('cURL');
test('tokenizer quoting', () => assert.deepEqual(tokenize(`curl 'a b' "c \\"d\\"" $'e\\nf' g\\ h`), ['curl', 'a b', 'c "d"', 'e\nf', 'g h']));
test('line continuations', () => assert.equal(parseCurl('curl \\\n  -X DELETE \\\n  https://x.io/a').method, 'DELETE'));
test('POST JSON with headers', () => {
  const r = parseCurl(`curl https://api.x.io/v1/items?limit=5 -H 'Content-Type: application/json' -H 'X-A: 1' -d '{"a":1}'`);
  assert.equal(r.method, 'POST'); assert.equal(r.body.mode, 'json'); assert.deepEqual(JSON.parse(r.body.json), { a: 1 });
  assert.deepEqual(r.headers.map(h => h.key), ['X-A']); assert.equal(r.params[0].key, 'limit');
});
test('bearer header becomes auth', () => { const r = parseCurl(`curl -H 'Authorization: Bearer abc' https://x.io`); assert.equal(r.auth.type, 'bearer'); assert.equal(r.auth.bearer.token, 'abc'); });
test('-u becomes basic auth', () => { const r = parseCurl(`curl -u me:p:w https://x.io`); assert.equal(r.auth.basic.username, 'me'); assert.equal(r.auth.basic.password, 'p:w'); });
test('form fields and files', () => { const r = parseCurl(`curl -F name=Ada -F file=@/tmp/a.png https://x.io/up`); assert.equal(r.body.mode, 'formdata'); assert.equal(r.body.formdata[1].type, 'file'); assert.equal(r.body.formdata[1].fileName, '/tmp/a.png'); });
test('urlencoded data', () => { const r = parseCurl(`curl -d 'a=1&b=x%20y' https://x.io`); assert.equal(r.body.mode, 'urlencoded'); assert.equal(r.body.urlencoded[1].value, 'x y'); });
test('-G moves data to query', () => { const r = parseCurl(`curl -G -d q=1 https://x.io/s`); assert.equal(r.method, 'GET'); assert.equal(r.url, 'https://x.io/s?q=1'); });
test('combined short flags', () => { const r = parseCurl(`curl -sSL -XPUT https://x.io`); assert.equal(r.method, 'PUT'); });
test('rejects non-curl', () => assert.throws(() => parseCurl('wget x')));
test('toCurl escapes quotes', () => {
  const s = toCurl({ method: 'POST', url: 'https://x.io', headers: [['A', "it's"]], body: { kind: 'text', text: '{"a":"b\'c"}' }, followRedirects: false });
  assert.equal(s, `curl -X POST 'https://x.io' \\\n  -H 'A: it'\\''s' \\\n  --data-raw '{"a":"b'\\''c"}'`);
});
test('cURL round trip', () => {
  const p = { method: 'PATCH', url: 'https://x.io/a?b=1', headers: [['X-K', 'v']], body: { kind: 'text', text: '{"z":[1,2]}' }, followRedirects: true };
  const r = parseCurl(toCurl(p));
  assert.equal(r.method, 'PATCH'); assert.equal(r.url, p.url); assert.equal(r.headers[0].value, 'v'); assert.deepEqual(JSON.parse(r.body.json), { z: [1, 2] });
});
test('toFetch with JSON body', () => { const s = toFetch({ method: 'POST', url: 'https://x.io', headers: [], body: { kind: 'text', text: '{"a":1}' }, followRedirects: true }); assert.match(s, /JSON\.stringify\(\{\n {4}"a": 1/); });

console.log('URL params and variables');
test('params from URL keep {{vars}}', () => { const p = paramsFromUrl('{{base}}/x?a={{v}}&b&c=3#h', []); assert.deepEqual(p.map(x => [x.key, x.value]), [['a', '{{v}}'], ['b', ''], ['c', '3']]); });
test('URL from params keeps hash and bare keys', () => { const p = paramsFromUrl('/x?a=1&b#h', []); p[0].value = '2'; assert.equal(urlFromParams('/x?a=1&b#h', p), '/x?a=2&b#h'); });
test('disabled params survive URL edits', () => { const p = [kv('a', '1'), kv('off', 'x', { enabled: false })]; const q = paramsFromUrl('/x?a=5', p); assert.equal(q.length, 2); assert.equal(q[1].enabled, false); });
test('finalizeUrl adds scheme', () => { assert.equal(finalizeUrl('api.x.io/a').href, 'https://api.x.io/a'); assert.equal(finalizeUrl('localhost:3000').protocol, 'http:'); });
test('scope precedence: later wins', () => { const s = buildScope([kv('a', 'g')], [kv('a', 'c')], [kv('a', 'e')]); assert.equal(resolve('{{a}}', s), 'e'); });
test('nested variables', () => { const s = buildScope([kv('host', 'x.io'), kv('base', 'https://{{host}}')]); assert.equal(resolve('{{base}}/a', s), 'https://x.io/a'); });
test('missing collected', () => { const m = new Set(); resolve('{{a}} {{ b }}', new Map(), m); assert.deepEqual([...m], ['a', 'b']); });
test('disabled variables ignored', () => { const s = buildScope([kv('a', '1', { enabled: false })]); assert.equal(resolve('{{a}}', s), '{{a}}'); });
test('dynamic variables', () => { assert.match(resolve('{{$guid}}', new Map()), /^[0-9a-f-]{36}$/); assert.match(resolve('{{$timestamp}}', new Map()), /^\d{10}$/); });
test('findVars', () => assert.deepEqual(findVars('{{a}}/x/{{b}}'), ['a', 'b']));

console.log('Postman');
const pm = {
  info: { name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] },
  variable: [{ key: 'base', value: 'https://x.io' }],
  item: [
    { name: 'Users', item: [{ name: 'List', request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }], url: { raw: '{{base}}/users?page=1', query: [{ key: 'page', value: '1' }, { key: 'debug', value: 'true', disabled: true }] } } }] },
    { name: 'Create', request: { method: 'POST', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'k' }, { key: 'value', value: 'v' }, { key: 'in', value: 'query' }] }, url: '{{base}}/users', body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ['pm.test("x", () => {})'] } }] },
    { name: 'Upload', request: { method: 'POST', url: '{{base}}/up', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: '/a/b.png' }, { key: 't', value: 'x', type: 'text' }] } } },
    { name: 'GQL', request: { method: 'POST', url: '{{base}}/gql', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } } },
  ],
};
const imp = importPostman(pm);
test('collection imported with stats', () => { assert.equal(imp.kind, 'collection'); assert.deepEqual(imp.stats, { requests: 4, folders: 1, scripts: 1, files: 1 }); });
test('collection auth and variables', () => { assert.equal(imp.value.auth.type, 'bearer'); assert.equal(imp.value.auth.bearer.token, '{{tok}}'); assert.equal(imp.value.variables[0].value, 'https://x.io'); });
const list = imp.value.items[0].items[0].request;
test('headers incl. disabled', () => { assert.equal(list.headers.length, 2); assert.equal(list.headers[1].enabled, false); });
test('disabled query param kept', () => assert.deepEqual(list.params.map(p => [p.key, p.enabled]), [['page', true], ['debug', false]]));
test('request auth inherits by default', () => assert.equal(list.auth.type, 'inherit'));
test('apikey auth in query', () => { const r = imp.value.items[1].request; assert.equal(r.auth.type, 'apikey'); assert.equal(r.auth.apikey.in, 'query'); assert.equal(r.body.mode, 'json'); });
test('formdata file row', () => { const r = imp.value.items[2].request; assert.equal(r.body.formdata[0].type, 'file'); assert.equal(r.body.formdata[0].fileName, 'b.png'); });
test('graphql becomes JSON', () => assert.deepEqual(JSON.parse(imp.value.items[3].request.body.json), { query: '{ me { id } }', variables: { a: 1 } }));
test('effective auth walks to collection', () => { const { auth, owner } = effectiveAuth(list, [imp.value.items[0], imp.value]); assert.equal(auth.type, 'bearer'); assert.equal(owner, imp.value); });
test('export then re-import is stable', () => {
  imp.value.items[1].request.tests = [{ id: 't', enabled: true, type: 'status', op: 'eq', target: '', expected: '201' }];
  const out = exportCollection(imp.value);
  assert.equal(out.info.schema, pm.info.schema);
  assert.match(out.item[1].event[0].script.exec.join('\n'), /pm\.response\.code\)\.to\.eql\(201\)/);
  const again = importPostman(JSON.parse(JSON.stringify(out))).value;
  assert.equal(again.items[0].items[0].request.url, '{{base}}/users?page=1');
  assert.equal(again.items[1].request.tests[0].expected, '201');
  assert.equal(again.items[1].request.auth.apikey.in, 'query');
  assert.equal(again.auth.type, 'bearer');
});
test('environment import', () => { const e = importPostman({ name: 'Prod', values: [{ key: 'a', value: '1', enabled: true, type: 'secret' }] }); assert.equal(e.kind, 'environment'); assert.equal(e.value.variables[0].secret, true); });
test('rejects non-collections', () => assert.throws(() => importPostman({ foo: 1 }), /Not a Postman collection/));
test('new request defaults', () => { const r = newRequest(); assert.equal(r.method, 'GET'); assert.equal(r.auth.type, 'inherit'); assert.equal(r.body.mode, 'none'); });

console.log(`\n${n - failed}/${n} passed`);
if (failed) process.exit(1);
