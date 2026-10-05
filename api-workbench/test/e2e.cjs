#!/usr/bin/env node
// End-to-end check: loads the unpacked extension in headless Chromium, drives the workbench
// against a local HTTP server, and checks the JSON page viewer.
// Usage (from the repo root): node api-workbench/test/e2e.cjs
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const ext = path.resolve(__dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function server() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      let body = [];
      req.on('data', c => body.push(c));
      req.on('end', () => {
        body = Buffer.concat(body);
        const u = new URL(req.url, 'http://x');
        const send = (code, type, data, extra = {}) => { res.writeHead(code, { ...cors, 'Content-Type': type, 'X-Test': 'yes', ...extra }); res.end(data); };
        if (u.pathname === '/echo') {
          send(200, 'application/json', JSON.stringify({ method: req.method, query: Object.fromEntries(u.searchParams), headers: req.headers, body: body.toString('utf8'), items: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }] }));
        } else if (u.pathname === '/token') {
          const p = new URLSearchParams(body.toString());
          if (p.get('grant_type') !== 'client_credentials' || !/^Basic /.test(req.headers.authorization || '')) return send(400, 'application/json', '{"error":"invalid_request"}');
          send(200, 'application/json', JSON.stringify({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 }));
        } else if (u.pathname === '/html') send(200, 'text/html', '<h1 id="x">Hello preview</h1><script>document.title="ran"</script>');
        else if (u.pathname === '/img') send(200, 'image/png', PNG);
        else if (u.pathname === '/doc.json') send(200, 'application/json', '{"user":{"name":"Ada","langs":["en","fr"]},"count":3,"ok":true}');
        else send(404, 'application/json', '{"error":"not found"}');
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`chrome-extension://${id}/app/workbench.html`);
    await page.waitForSelector('#urlInput');
    // Headless cannot answer permission prompts: resolve them as "denied" so requests go out with CORS rules.
    await page.evaluate(() => { chrome.permissions.request = async () => false; });

    console.log('workbench');
    check('seeded sample collection', await page.locator('.tree-row', { hasText: 'Sample: httpbin' }).count() === 1);

    // URL <-> params sync
    await page.fill('#urlInput', `${base}/echo?a=1&b=two`);
    await page.click('.etab[data-tab="params"]');
    const keys = await page.$$eval('#reqPane .kvt tbody tr:not(.row-new) td:nth-child(2) input', els => els.map(e => e.value));
    check('params parsed from URL', JSON.stringify(keys) === '["a","b"]', JSON.stringify(keys));
    await page.locator('#reqPane .kvt tbody tr.row-new td:nth-child(2) input').fill('c');
    check('params table updates URL', (await page.inputValue('#urlInput')).endsWith('?a=1&b=two&c='), await page.inputValue('#urlInput'));

    // POST JSON with header, bearer auth, assertions and extraction
    await page.selectOption('.method-select', 'POST');
    await page.click('.etab[data-tab="headers"]');
    await page.locator('#reqPane .kvt tbody tr.row-new td:nth-child(2) input').fill('X-Custom');
    await page.locator('#reqPane .kvt tbody tr:not(.row-new) td:nth-child(3) input').first().fill('{{$guid}}');
    await page.click('.etab[data-tab="body"]');
    await page.selectOption('#reqPane .code-tools select', 'json');
    await page.fill('#reqPane textarea.code', '{"hello": "world"');
    check('JSON validation flags invalid body', /Invalid JSON/.test(await page.textContent('.code-status')));
    await page.fill('#reqPane textarea.code', '{"hello": "world"}');
    check('JSON validation accepts valid body', /Valid JSON/.test(await page.textContent('.code-status')));
    await page.click('.etab[data-tab="auth"]');
    await page.selectOption('#authType', 'bearer');
    await page.locator('#reqPane .form-grid input[type=password]').first().fill('secret-token');
    await page.click('.etab[data-tab="tests"]');
    await page.click('text=+ Add assertion');
    await page.click('text=+ Add assertion');
    let rows = page.locator('#reqPane .kvt tbody tr');
    await rows.nth(1).locator('select').first().selectOption('json');
    rows = page.locator('#reqPane .kvt tbody tr');
    await rows.nth(1).locator('td:nth-child(3) input').fill('$.items[1].name');
    await rows.nth(1).locator('td:nth-child(5) input').fill('beta');
    await page.click('.etab[data-tab="extract"]');
    await page.click('text=+ Add rule');
    await page.locator('#reqPane .kvt tbody tr td:nth-child(3) input').fill('$.body');
    await page.locator('#reqPane .kvt tbody tr td:nth-child(4) input').fill('lastBody');
    await page.selectOption('#reqPane .kvt tbody tr td:nth-child(5) select', 'global');

    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(1500); console.log(await page.textContent("#resPane")); await page.screenshot({ path: "/tmp/claude-0/-home-claude-extensions/52fd0301-0e66-58ff-8add-dc82b45b40cb/scratchpad/dbg.png" });
    await page.waitForSelector('.status-pill', { timeout: 10000 });
    check('status 200 shown', (await page.textContent('.status-pill')).includes('200'));
    check('tests summary 2/2', (await page.textContent('.res-head .meta')).includes('Tests 2/2'), await page.textContent('.res-head .meta'));
    check('JSON tree rendered', await page.locator('#resPane .jt-root').count() === 1);
    await page.fill('#resSearch', 'beta');
    await page.waitForTimeout(400);
    check('tree search finds value', await page.locator('#resPane mark.jt-mark').count() >= 1);
    await page.click('#resPane .view-switch button:has-text("Raw")');
    const raw = await page.textContent('#resPane pre.raw');
    const echoed = JSON.parse(raw);
    check('method sent', echoed.method === 'POST');
    check('JSON body sent', echoed.body === '{"hello": "world"}');
    check('content-type auto', echoed.headers['content-type'] === 'application/json');
    check('bearer auth sent', echoed.headers.authorization === 'Bearer secret-token');
    check('dynamic variable resolved', /^[0-9a-f-]{36}$/.test(echoed.headers['x-custom'] || ''), echoed.headers['x-custom']);
    check('query sent', echoed.query.a === '1' && echoed.query.b === 'two');
    await page.click('#resPane .etab[data-tab="headers"]');
    check('response headers listed', (await page.textContent('#resPane .cookie-tbl')).includes('x-test'));
    await page.click('.side-tab[data-side="env"]');
    const globals = await page.$$eval('#sideBody .kvt tbody tr:not(.row-new) td:nth-child(2) input', els => els.map(e => e.value));
    check('extracted variable saved to globals', globals.includes('lastBody'), JSON.stringify(globals));
    await page.click('.side-tab[data-side="history"]');
    check('history entry added', await page.locator('.hist-item').count() >= 1);

    // Copy as cURL (code dialog) and save to a collection
    await page.click('.send-more');
    await page.click('.menu button:has-text("Show code")');
    const code = await page.inputValue('#modal textarea.code');
    check('cURL generated', code.startsWith('curl -L -X POST') && code.includes("-H 'Authorization: Bearer secret-token'"), code.split('\n')[0]);
    await page.click('#modal .seg button:has-text("fetch")');
    check('fetch generated', (await page.inputValue('#modal textarea.code')).includes('await fetch('));
    await page.click('#modal .modal-foot button:has-text("Close")');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('#saveName');
    await page.fill('#saveName', 'Echo test');
    await page.click('#modal .modal-foot button:has-text("Save")');
    await page.click('.side-tab[data-side="collections"]');
    check('saved request appears in tree', await page.locator('.tree-row', { hasText: 'Echo test' }).count() === 1);

    // HTML preview and image viewer
    await page.keyboard.press('Alt+t');
    await page.fill('#urlInput', `${base}/html`);
    await page.click('#sendBtn');
    await page.waitForSelector('#resPane iframe.preview-frame');
    const frame = page.frameLocator('#resPane iframe.preview-frame');
    check('HTML preview renders', (await frame.locator('#x').textContent()) === 'Hello preview');
    check('preview iframe is sandboxed', (await page.getAttribute('#resPane iframe', 'sandbox')) === '');
    await page.fill('#urlInput', `${base}/img`);
    await page.click('#sendBtn');
    await page.waitForSelector('#resPane img.img-preview');
    check('image viewer', await page.locator('#resPane img.img-preview').count() === 1);
    await page.fill('#urlInput', `${base}/missing`);
    await page.click('#sendBtn');
    await page.waitForSelector('.status-pill.s4');
    check('404 shown as client error', (await page.textContent('.status-pill')).includes('404'));

    // OAuth2 client credentials, urlencoded body, API key in query
    await page.keyboard.press('Alt+t');
    await page.fill('#urlInput', `${base}/echo`);
    await page.selectOption('.method-select', 'PUT');
    await page.click('.etab[data-tab="body"]');
    await page.selectOption('#reqPane .code-tools select', 'urlencoded');
    await page.locator('#reqPane .kvt tbody tr.row-new td:nth-child(2) input').fill('name');
    await page.locator('#reqPane .kvt tbody tr:not(.row-new) td:nth-child(3) input').first().fill('a b&c');
    await page.click('.etab[data-tab="auth"]');
    await page.selectOption('#authType', 'oauth2');
    const og = page.locator('#reqPane .form-grid input');
    await og.nth(0).fill(`${base}/token`);
    await og.nth(1).fill('client');
    await og.nth(2).fill('s3cret');
    await page.click('#sendBtn');
    await page.waitForSelector('.status-pill');
    await page.click('#resPane .view-switch button:has-text("Raw")');
    const e2 = JSON.parse(await page.textContent('#resPane pre.raw'));
    check('OAuth2 token fetched and used', e2.headers.authorization === 'Bearer tok-123', e2.headers.authorization);
    check('urlencoded body', e2.body === 'name=a+b%26c' && /x-www-form-urlencoded/.test(e2.headers['content-type']), e2.body);
    await page.selectOption('#authType', 'apikey');
    const ak = page.locator('#reqPane .form-grid input');
    await ak.nth(0).fill('api_key');
    await ak.nth(1).fill('k1');
    await page.selectOption('#akIn', 'query');
    await page.click('#sendBtn');
    await page.waitForSelector('.status-pill');
    await page.click('#resPane .view-switch button:has-text("Raw")');
    check('API key in query', JSON.parse(await page.textContent('#resPane pre.raw')).query.api_key === 'k1');

    // cURL import by pasting into the URL field
    await page.keyboard.press('Alt+t');
    await page.evaluate(text => {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.getElementById('urlInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, `curl -X PATCH '${base}/echo?x=1' -H 'Accept: application/json' -u bob:pw --data-raw '{"a":1}'`);
    await page.waitForTimeout(200);
    check('cURL paste sets URL', (await page.inputValue('#urlInput')) === `${base}/echo?x=1`);
    check('cURL paste sets method', (await page.inputValue('.method-select')) === 'PATCH');
    await page.click('#sendBtn');
    await page.waitForSelector('.status-pill');
    await page.click('#resPane .view-switch button:has-text("Raw")');
    const e3 = JSON.parse(await page.textContent('#resPane pre.raw'));
    check('cURL basic auth sent', e3.headers.authorization === 'Basic ' + Buffer.from('bob:pw').toString('base64'));
    check('cURL JSON body sent', e3.body.replace(/\s/g, '') === '{"a":1}');

    // Postman import
    await page.click('#btnImport');
    const coll = { info: { name: 'Imported PM', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'Folder', item: [{ name: 'Get thing', request: { method: 'GET', url: { raw: '{{host}}/echo?q=1' } } }] }], variable: [{ key: 'host', value: base }] };
    await page.fill('#modal textarea', JSON.stringify(coll));
    await page.click('#modal .modal-foot button:has-text("Import")');
    await page.waitForSelector('.tree-row:has-text("Imported PM")');
    check('Postman collection imported', true);
    await page.click('.tree-row:has-text("Imported PM")');
    await page.click('.tree-row:has-text("Folder")');
    await page.click('.tree-row:has-text("Get thing")');
    await page.click('#sendBtn');
    await page.waitForSelector('.status-pill');
    check('collection variable resolved on send', (await page.textContent('.status-pill')).includes('200'));

    // persistence across reload
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForSelector('#urlInput');
    const tabCount = await page.locator('.rtab').count();
    check('tabs restored after reload', tabCount >= 4, String(tabCount));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: path.join(os.tmpdir(), 'aw-e2e.png') });

    // JSON viewer content script against a raw JSON document
    console.log('json viewer');
    const doc = await ctx.newPage();
    await doc.goto(`${base}/doc.json`);
    await doc.addStyleTag({ path: path.join(ext, 'lib/jsontree.css') });
    await doc.addStyleTag({ path: path.join(ext, 'content/json-viewer.css') });
    await doc.addScriptTag({ path: path.join(ext, 'lib/jsontree.js') });
    await doc.addScriptTag({ path: path.join(ext, 'content/json-viewer.js') });
    await doc.waitForSelector('#aw-jv .jt-root');
    check('viewer renders tree', (await doc.textContent('#aw-jv .jt-root')).includes('"Ada"'));
    check('original pre hidden', await doc.locator('body > pre').isHidden());
    await doc.click('#aw-jv button:has-text("Raw")');
    check('raw toggle shows original text', (await doc.textContent('#aw-jv pre.aw-jv-pre:not([hidden])')).startsWith('{"user"'));
    await doc.click('#aw-jv button:has-text("Pretty")');
    check('pretty toggle indents', (await doc.textContent('#aw-jv pre.aw-jv-pre:not([hidden])')).includes('\n  "user"'));
    await doc.click('#aw-jv button:has-text("Tree")');
    await doc.click('#aw-jv button:has-text("Collapse all")');
    check('collapse all', await doc.locator('#aw-jv .jt-children:visible').count() === 1);
    await doc.screenshot({ path: path.join(os.tmpdir(), 'aw-viewer.png') });
    const html = await ctx.newPage();
    await html.goto(`${base}/html`);
    await html.addScriptTag({ path: path.join(ext, 'lib/jsontree.js') });
    await html.addScriptTag({ path: path.join(ext, 'content/json-viewer.js') });
    check('viewer ignores HTML pages', await html.locator('#aw-jv').count() === 0);
  } finally {
    await ctx.close();
    srv.close();
  }
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll e2e checks passed');
})().catch(e => { console.error(e); process.exit(1); });
