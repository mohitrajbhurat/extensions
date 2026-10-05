#!/usr/bin/env node
// End-to-end checks with Playwright.
//   node price-tracker/test/e2e.js
// 1. Detection: loads local product pages (served locally, or routed to store hostnames) and
//    runs lib/detect.js against the real DOM.
// 2. Picker: drives the "pick the price element" overlay with the mouse.
// 3. Extension: loads a temp copy of the extension (with host access to 127.0.0.1 pre-granted),
//    tracks items, runs background re-checks through the offscreen parser, checks alerts,
//    bot-block handling, the record-on-visit content script and the dashboard chart tooltip.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const LIBS = ['lib/price-parse.js', 'lib/detect.js'].map(f => path.join(EXT, f));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

// Test server ------------------------------------------------------------------------------
const dyn = { price: 100, avail: 'InStock' };
function productPage(title, price, avail) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${title}","image":"/img/x.jpg",
"offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD","availability":"https://schema.org/${avail}"}}</script>
</head><body><h1>${title}</h1><span class="price">$${price}</span></body></html>`;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/dyn/product') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(productPage('Dynamic Widget', dyn.price.toFixed(2), dyn.avail));
  }
  if (u.pathname === '/dyn/guarded') {
    // Simulates a store that blocks automated fetches but serves real browser navigations.
    if (req.headers['sec-fetch-dest'] !== 'document') {
      res.writeHead(503, { 'content-type': 'text/html' });
      return res.end('<html><head><title>Robot or human?</title></head><body><div id="px-captcha"></div></body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(productPage('Guarded Gadget', '70.00', 'InStock'));
  }
  const file = path.join(FIX, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (file.startsWith(FIX) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
});

async function detectOn(page, url, opts) {
  await page.goto(url);
  for (const f of LIBS) await page.addScriptTag({ path: f });
  return page.evaluate(o => globalThis.PriceDetect.detectProduct(document, location.href, o || {}), opts || null);
}

function expectProduct(p, exp) {
  for (const [k, v] of Object.entries(exp)) {
    if (v instanceof RegExp) assert.match(String(p[k]), v, `${k}: ${p[k]}`);
    else assert.deepEqual(p[k], v, `${k}: got ${JSON.stringify(p[k])}, expected ${JSON.stringify(v)}`);
  }
}

async function waitFor(fn, timeout = 15000, label = 'condition') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for ' + label);
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Detection -------------------------------------------------------------------------
  console.log('Detection');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const routed = {
    'https://www.amazon.com/': 'amazon.html', 'https://www.amazon.de/': 'amazon-de.html',
    'https://www.bestbuy.com/': 'bestbuy.html', 'https://www.walmart.com/': 'walmart.html',
    'https://www.target.com/': 'target.html', 'https://www.ebay.co.uk/': 'ebay.html',
    'https://www.etsy.com/': 'etsy.html', 'https://demo-hoodies.example/': 'shopify.html',
  };
  await ctx.route(/^https:\/\//, route => {
    const url = route.request().url();
    const key = Object.keys(routed).find(k => url.startsWith(k));
    if (!key) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(FIX, routed[key])) });
  });
  const page = await ctx.newPage();

  const cases = [
    ['JSON-LD @graph with strikethrough price', base + '/jsonld.html', { price: 1299, currency: 'USD', listPrice: 1499, availability: 'in_stock', title: 'Aurora Laptop 14"', source: 'jsonld', image: base + '/img/aurora.jpg', canonical: base + '/products/aurora-14', isProduct: true }],
    ['Microdata, EUR, out of stock', base + '/microdata-eur.html', { price: 1299, currency: 'EUR', availability: 'out_of_stock', title: 'Kaffeemühle Pro', source: 'microdata' }],
    ['OpenGraph product tags, INR', base + '/og-inr.html', { price: 129999, currency: 'INR', title: 'Phone X Pro (256 GB)', source: 'opengraph' }],
    ['Generic heuristic skips was/related/cart prices', base + '/generic.html', { price: 49.99, currency: 'USD', source: 'heuristic', title: 'Trail Runner 3' }],
    ['Amazon.com', 'https://www.amazon.com/Noise-Headphones/dp/B0TEST1234/ref=sr_1_1?th=1&psc=1', { price: 248, currency: 'USD', listPrice: 399.99, availability: 'in_stock', title: 'Noise Cancelling Headphones, Wireless', image: 'https://m.media-amazon.com/images/I/head.jpg', key: 'amazon.com/dp/B0TEST1234', source: 'store:Amazon' }],
    ['Amazon.de (1.299,00 €, unavailable)', 'https://www.amazon.de/dp/B0DE123456', { price: 1299, currency: 'EUR', availability: 'out_of_stock' }],
    ['Best Buy (sold out, was price)', 'https://www.bestbuy.com/site/sony-oled/6501234.p?skuId=6501234', { price: 1799.99, listPrice: 2299.99, availability: 'out_of_stock', key: 'bestbuy.com/sku/6501234' }],
    ['Walmart', 'https://www.walmart.com/ip/Ninja-Air-Fryer/123456?athbdg=L1600', { price: 89, listPrice: 129.99, availability: 'in_stock', title: 'Ninja Air Fryer 4qt', key: 'walmart.com/ip/123456' }],
    ['Target', 'https://www.target.com/p/lego-falcon/-/A-123456#lnk=sametab', { price: 159.99, listPrice: 169.99, availability: 'in_stock', key: 'target.com/A-123456' }],
    ['eBay UK', 'https://www.ebay.co.uk/itm/123456789012?hash=item1', { price: 89.99, currency: 'GBP', availability: 'in_stock', title: 'Vintage Film Camera 35mm', key: 'ebay.co.uk/itm/123456789012' }],
    ['Etsy (CA$)', 'https://www.etsy.com/listing/123456/handmade-mug?ref=hp', { price: 42.5, currency: 'CAD', listPrice: 50, key: 'etsy.com/listing/123456' }],
    ['Shopify variant from ?variant=', 'https://demo-hoodies.example/products/merino-hoodie?variant=1', { price: 120, currency: 'CAD', availability: 'out_of_stock', title: 'Merino Hoodie – S', source: 'shopify', listPrice: 140 }],
    ['Shopify default variant', 'https://demo-hoodies.example/products/merino-hoodie', { price: 99, availability: 'in_stock', title: 'Merino Hoodie – M' }],
  ];
  for (const [name, url, exp] of cases) await check(name, async () => expectProduct(await detectOn(page, url), exp));
  await check('Custom picked selector wins', async () => {
    const p = await detectOn(page, base + '/generic.html', { selector: '.price-was' });
    expectProduct(p, { price: 79.99, source: 'picked' });
  });
  await check('No product on a plain page', async () => {
    await page.route(base + '/plain.html', r => r.fulfill({ contentType: 'text/html', body: '<h1>About us</h1><p>We were founded in 1999.</p>' }));
    const p = await detectOn(page, base + '/plain.html');
    assert.equal(p.price, null);
    assert.equal(p.isProduct, false);
  });

  // 2. Picker -----------------------------------------------------------------------------
  console.log('Picker');
  await check('Picker selects the hovered price and builds a unique selector', async () => {
    await page.goto(base + '/generic.html');
    await page.evaluate(() => {
      window.chrome = window.chrome || {};
      window.chrome.runtime = { sendMessage: (m, cb) => { window.__picked = m; cb && cb(); }, lastError: null };
    });
    for (const f of [...LIBS, path.join(EXT, 'content/picker.js')]) await page.addScriptTag({ path: f });
    await page.hover('#the-price');
    await page.click('#the-price');
    const msg = await page.evaluate(() => window.__picked);
    assert.ok(msg, 'picked message sent');
    assert.equal(msg.product.price, 49.99);
    const same = await page.evaluate(sel => document.querySelector(sel) === document.getElementById('the-price'), msg.selector);
    assert.ok(same, 'selector resolves to the clicked element: ' + msg.selector);
    assert.equal(await page.evaluate(() => !!document.querySelector('[data-price-tracker-picker]')), false, 'overlay removed');
  });
  await check('Picker keyboard: Esc cancels', async () => {
    await page.goto(base + '/generic.html');
    for (const f of [...LIBS, path.join(EXT, 'content/picker.js')]) await page.addScriptTag({ path: f });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => !!document.querySelector('[data-price-tracker-picker]')), false);
  });
  await browser.close();

  // 3. Extension --------------------------------------------------------------------------
  console.log('Extension');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ext-'));
  const extCopy = path.join(tmp, 'ext');
  fs.cpSync(EXT, extCopy, { recursive: true, filter: src => !src.startsWith(path.join(EXT, 'test')) });
  const manifest = JSON.parse(fs.readFileSync(path.join(extCopy, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*']; // stands in for the user granting access
  fs.writeFileSync(path.join(extCopy, 'manifest.json'), JSON.stringify(manifest));
  const ectx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`],
  });
  const errors = [];
  let [sw] = ectx.serviceWorkers();
  if (!sw) sw = await ectx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  await waitFor(() => sw.evaluate(() => !!(globalThis.__priceTracker && globalThis.chrome && chrome.scripting)), 15000, 'service worker to boot');
  const call = (type, payload) => sw.evaluate(([t, p]) => globalThis.__priceTracker.handlers[t](p, {}), [type, payload]);
  const getItem = id => sw.evaluate(i => globalThis.__priceTracker.getItems().then(x => x[i]), id);

  let dynId, guardedId;
  await check('Track an item', async () => {
    const item = await call('track', { url: base + '/dyn/product?utm_source=x', target: { type: 'price', value: 90 }, product: { price: 100, currency: 'USD', title: 'Dynamic Widget', availability: 'in_stock', source: 'jsonld' } });
    dynId = item.id;
    assert.equal(item.history.length, 1);
    assert.equal(item.baselinePrice, 100);
    assert.equal(item.key, '127.0.0.1/dyn/product');
  });
  await check('Background check parses via offscreen document and records a drop', async () => {
    dyn.price = 95;
    const it = await sw.evaluate(id => globalThis.__priceTracker.checkItem(id), dynId);
    assert.equal(it.lastStatus, 'ok', it.statusReason);
    assert.equal(it.history.at(-1).p, 95);
    assert.equal(it.history.at(-1).v, 'b');
    assert.ok(it.events.some(e => e.kind === 'low'), 'all-time low event');
  });
  await check('Target alert fires once, then out-of-stock and back-in-stock', async () => {
    dyn.price = 85;
    let it = await sw.evaluate(id => globalThis.__priceTracker.checkItem(id), dynId);
    assert.ok(it.events.some(e => e.kind === 'target'), 'target event');
    assert.equal(it.alertState.targetHit, true);
    const targetEvents = it.events.filter(e => e.kind === 'target').length;
    it = await sw.evaluate(id => globalThis.__priceTracker.checkItem(id), dynId);
    assert.equal(it.events.filter(e => e.kind === 'target').length, targetEvents, 'no duplicate target alert');
    dyn.avail = 'OutOfStock';
    it = await sw.evaluate(id => globalThis.__priceTracker.checkItem(id), dynId);
    assert.equal(it.availability, 'out_of_stock');
    dyn.avail = 'InStock';
    it = await sw.evaluate(id => globalThis.__priceTracker.checkItem(id), dynId);
    assert.ok(it.events.some(e => e.kind === 'stock'), 'back in stock event');
  });
  await check('Bot-blocked page is marked "needs visit"', async () => {
    const item = await call('track', { url: base + '/dyn/guarded', target: { type: 'none' }, product: { price: 75, currency: 'USD', title: 'Guarded Gadget', availability: 'in_stock' } });
    guardedId = item.id;
    const it = await sw.evaluate(id => globalThis.__priceTracker.checkItem(id), guardedId);
    assert.equal(it.lastStatus, 'needs_visit');
    assert.match(it.statusReason, /blocked|captcha/i);
  });
  await check('Visiting the page normally records the price (content script)', async () => {
    const registered = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.ok(registered.length && registered[0].matches.includes('http://127.0.0.1/*'), 'content script registered for tracked origin');
    const tab = await ectx.newPage();
    await tab.goto(base + '/dyn/guarded');
    const it = await waitFor(async () => { const x = await getItem(guardedId); return x.lastStatus === 'ok' && x.history.at(-1).v === 'v' ? x : null; }, 15000, 'visit to be recorded');
    assert.equal(it.history.at(-1).p, 70);
    await tab.close();
  });
  await check('Dashboard lists items and the chart shows a hover tooltip', async () => {
    const dash = await ectx.newPage();
    dash.on('pageerror', e => errors.push('dashboard: ' + e.message));
    dash.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('dashboard: ' + m.text()); });
    await dash.setViewportSize({ width: 1400, height: 900 });
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#item=${dynId}`);
    await dash.waitForSelector('#rows tr');
    assert.equal(await dash.locator('#rows tr').count(), 2);
    await dash.waitForSelector('#detail:not([hidden]) canvas');
    const box = await dash.locator('#d-chart canvas').boundingBox();
    await dash.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await dash.waitForSelector('.chart-tip:not([hidden])');
    assert.match(await dash.locator('.chart-tip').innerText(), /\$\d/);
    // Keyboard access to the chart.
    await dash.locator('#d-chart canvas').focus();
    await dash.keyboard.press('Home');
    assert.match(await dash.locator('.chart-tip').innerText(), /\$100\.00/);
    // Export JSON works.
    const [download] = await Promise.all([dash.waitForEvent('download'), (async () => { await dash.click('#export-menu summary'); await dash.click('[data-export="json"]'); })()]);
    const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(data.items.length, 2);
    await dash.screenshot({ path: path.join(tmp, 'dashboard.png') });
    await dash.close();
  });
  await check('Popup detects a product, tracks it and shows the mini chart', async () => {
    const product = await ectx.newPage();
    await product.goto(base + '/jsonld.html');
    const tabId = await sw.evaluate(async u => (await chrome.tabs.query({ url: u }))[0].id, base + '/jsonld.html');
    const pop = await ectx.newPage();
    pop.on('pageerror', e => errors.push('popup: ' + e.message));
    pop.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('popup: ' + m.text()); });
    await pop.setViewportSize({ width: 392, height: 640 });
    await pop.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
    await pop.waitForSelector('#state-product:not([hidden])');
    assert.equal(await pop.locator('#p-price').innerText(), '$1,299.00');
    assert.match(await pop.locator('#p-title').innerText(), /Aurora Laptop/);
    assert.match(await pop.locator('#p-sale').innerText(), /claims 13% off/);
    await pop.click('#target-type [data-type="percent"]');
    await pop.fill('#target-value', '15');
    assert.match(await pop.locator('#target-hint').innerText(), /\$1,104\.15/);
    await pop.click('#track-btn');
    await pop.waitForSelector('#tracked:not([hidden]) canvas');
    const items = Object.values(await sw.evaluate(() => globalThis.__priceTracker.getItems()));
    const it = items.find(i => /Aurora/.test(i.title));
    assert.ok(it, 'item stored');
    assert.deepEqual(it.target, { type: 'percent', value: 15 });
    assert.equal(it.listPrice, 1499);
    await pop.screenshot({ path: path.join(tmp, 'popup.png') });
    await pop.close();
    await product.close();
  });
  await check('Delete removes the item', async () => {
    await call('delete', { ids: [guardedId] });
    assert.equal(await getItem(guardedId), undefined);
  });
  await check('No console errors in extension pages', async () => assert.deepEqual(errors, []));

  await ectx.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed  (screenshots in ${tmp})`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
