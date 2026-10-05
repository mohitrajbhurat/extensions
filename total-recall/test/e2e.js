#!/usr/bin/env node
// End-to-end check: serve fixtures, browse them with the extension loaded, then search.
// Usage: node total-recall/test/e2e.js   (requires playwright, like tools/smoke-test.js)
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const ext = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const shots = process.env.SHOTS;

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/spa')) p = '/spa.html';
    const file = path.join(fixtures, path.normalize(p));
    if (!file.startsWith(fixtures) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

const fail = [];
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fail.push(msg); };

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errors = [];
  ctx.on('page', p => p.on('pageerror', e => errors.push(e.message)));

  const page = await ctx.newPage();
  for (const f of ['article.html', 'recipe.html', 'login.html']) {
    await page.goto(`${base}/${f}?utm_source=test`);
    await page.waitForTimeout(2600);
  }
  await page.goto(`${base}/spa`);
  await page.waitForTimeout(8000);

  const app = await ctx.newPage();
  await app.goto(`chrome-extension://${id}/search/search.html`);
  const search = async q => {
    await app.fill('#q', q);
    await app.waitForTimeout(500);
    return app.$$eval('.result', rs => rs.map(r => ({ title: r.querySelector('.result-title').textContent, href: r.querySelector('.result-title').href, snippet: (r.querySelector('.snippet') || {}).innerHTML || '' })));
  };

  let r = await search('');
  check(r.length === 4, `browse mode lists 4 pages (got ${r.length}: ${r.map(x => x.title).join(' | ')})`);
  check(!r.some(x => /Sign in/.test(x.title)), 'login page with password field skipped');
  check(r.some(x => /Quantum/.test(x.title)), 'SPA navigation indexed');
  check(r.some(x => x.title === 'SPA Home'), 'SPA initial view indexed');
  check(!r.some(x => x.href.includes('utm_source')), 'tracking params stripped');

  r = await search('microtask');
  check(r[0] && /Event Loop/.test(r[0].title), 'stemmed term finds article');
  check(r[0] && /<mark>Microtasks<\/mark>/.test(r[0].snippet), 'snippet highlights match');
  check(r[0] && r[0].href.includes('#:~:text=Microtasks'), 'result links to text fragment: ' + (r[0] && r[0].href));

  r = await search('loop');
  check(r.length === 2, 'two pages mention loop');
  r = await search('loop -promise');
  check(r.length === 1 && /Sourdough/.test(r[0].title), 'exclusion works');
  r = await search('"wild yeast is active"');
  check(r.length === 1 && /Sourdough/.test(r[0].title) && r[0].href.includes('wild%20yeast'), 'phrase query works');
  r = await search('"yeast wild"');
  check(r.length === 0, 'phrase order enforced');
  r = await search('loop site:example.org');
  check(r.length === 0, 'site filter excludes');
  r = await search('loop site:127.0.0.1');
  check(r.length === 2, 'site filter includes');
  r = await search('pineapplezebra');
  check(r.length === 0, 'sensitive page text never stored');
  r = await search('zebra platypus');
  check(r.length === 0, 'nav and footer boilerplate excluded');
  r = await search('entang');
  check(r.length === 1 && /Quantum/.test(r[0].title), 'prefix (as-you-type) matching');
  r = await search('loop date:today');
  check(r.length === 2, 'date:today filter');
  r = await search('loop before:2001-01-01');
  check(r.length === 0, 'before: filter');
  await app.click('.chip[data-range="today"]');
  r = await search('bread');
  check(r.length === 1, 'today chip');
  if (shots) await app.screenshot({ path: path.join(shots, 'search.png') });

  // Keyboard: ArrowDown selects first result.
  await app.fill('#q', 'loop');
  await app.waitForTimeout(400);
  await app.keyboard.press('ArrowDown');
  check(await app.$eval('.result[aria-selected="true"]', n => !!n).catch(() => false), 'keyboard selection');

  // Omnibox suggestion pipeline via the service worker engine.
  const omni = await sw.evaluate(async () => (await self.totalRecall.engine.search('sourdough', { live: true, limit: 6 })).results.map(r => r.doc.title));
  check(omni[0] === "Grandma's Sourdough Bread", 'service worker engine (omnibox) finds results');

  // Pause: new pages are not indexed.
  await sw.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, paused: true } }); });
  await page.goto(`${base}/recipe.html#paused`);
  await page.goto(`${base}/article.html?x=1`);
  await page.waitForTimeout(2600);
  r = await search('');
  check(r.length === 4, 'paused indexing stores nothing new');

  // Popup renders stats.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.waitForTimeout(600);
  check((await popup.textContent('#statPages')) === '4', 'popup shows page count');
  if (shots) { await popup.setViewportSize({ width: 380, height: 640 }); await popup.screenshot({ path: path.join(shots, 'popup.png') }); }
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${id}/options/options.html`);
  await opts.waitForTimeout(600);
  if (shots) await opts.screenshot({ path: path.join(shots, 'options.png'), fullPage: true });
  const [dl] = await Promise.all([opts.waitForEvent('download'), opts.click('#exportBtn')]);
  const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  check(exported.format === 'total-recall' && exported.pages.length === 4, 'export JSON contains 4 pages');
  const importFile = path.join(os.tmpdir(), 'tr-import.json');
  fs.writeFileSync(importFile, JSON.stringify({ format: 'total-recall', version: 1, pages: [
    { url: 'https://imported.example/notes', title: 'Imported notes', text: 'Kubernetes operators reconcile desired state continuously.', firstVisit: Date.now() - 864e5 * 3, lastVisit: Date.now() - 864e5 * 2, visits: 3 },
  ] }));
  await opts.setInputFiles('#importFile', importFile);
  await opts.waitForTimeout(800);
  check(/Imported 1 page/.test(await opts.textContent('#progressText')), 'import reports success');
  await app.click('.chip[data-range="all"]');
  r = await search('kubernetes');
  check(r.length === 1 && r[0].title === 'Imported notes', 'imported page is searchable');
  r = await search('kubernetes date:today');
  check(r.length === 0, 'imported visit date preserved');

  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await ctx.close();
  server.close();
  console.log(fail.length ? `\n${fail.length} check(s) failed` : '\nALL CHECKS PASSED');
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
