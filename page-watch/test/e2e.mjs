// End-to-end check with Playwright: picker, fetch + extract, conditions, render mode, diff UI, import.
// Usage: node page-watch/test/e2e.mjs   (needs Playwright's Chromium, as used by tools/smoke-test.js)
//
// A copy of the extension is loaded with host access to 127.0.0.1 pre-granted, because the
// permission prompt from optional_host_permissions cannot be clicked in headless Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS; // optional folder for screenshots
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png') }) : null);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ----------------------------------------------------------------- local site
const site = { price: '$59.99', status: 'Sold out', footer: 'v1', jobs: ['Designer', 'Engineer'] };
const pageHtml = () => `<!doctype html><html><head><title>Test Shop</title><style>.hidden{display:none}</style></head><body>
<header><h1>Test Shop</h1><nav><a href="#">Home</a></nav></header>
<main>
  <article class="product" id="prod">
    <h2 class="product-title">Widget Pro</h2>
    <div class="buy-box"><span class="price" id="price">${site.price}</span> <span class="stock">${site.status}</span></div>
    <ul class="features"><li>Fast</li><li>Small</li><li>Quiet</li></ul>
  </article>
</main>
<script>document.title = 'Test Shop';</script>
<footer id="foot">Build ${site.footer}</footer></body></html>`;
const spaHtml = () => `<!doctype html><html><head><title>Jobs</title></head><body>
<div id="app">Loading…</div>
<script>
  setTimeout(() => {
    document.getElementById('app').innerHTML = '<ul id="jobs">' + ${JSON.stringify(site.jobs)}.map(j => '<li>' + j + '</li>').join('') + '</ul>';
  }, 400);
</script></body></html>`;

let server;
let base;
let ctx;
let sw;
let dir;
let ext;

test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml()); return; }
    if (u.pathname === '/spa.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(spaHtml()); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-'));
  ext = path.join(dir, 'ext');
  fs.cpSync(SRC, ext, { recursive: true, filter: (p) => !p.includes(`${path.sep}test${path.sep}`) && !p.endsWith(`${path.sep}test`) });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

  ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
});

test.after(async () => {
  await ctx?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const extId = () => sw.url().split('/')[2];
const storage = (key) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);

async function extPage(p = 'dashboard/dashboard.html') {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extId()}/${p}`);
  page.errors = errors;
  return page;
}
const msg = (page, m) => page.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('picker: hover, click, parent/child, confirm saves a draft', async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/page.html`);
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/extract.js', 'content/picker.js'] });
  }, `${base}/page.html`);
  const host = page.locator('#page-watch-picker-host');
  await host.locator('.bar').waitFor();

  await page.hover('#price');
  await page.locator('#price').click();
  const input = host.locator('input.selector');
  await assert.doesNotReject(input.waitFor());
  assert.equal(await input.inputValue(), '#price');
  assert.match(await host.locator('.count').textContent(), /1 match/);
  assert.match(await host.locator('.preview').textContent(), /\$59\.99/);

  await host.locator('button.parent').click();
  assert.equal(await input.inputValue(), 'div.buy-box');
  assert.match(await host.locator('.preview').textContent(), /\$59\.99 Sold out/);
  await shot(page, 'picker');
  await host.locator('button.parent').click();
  assert.equal(await input.inputValue(), '#prod');
  await host.locator('button.child').click();
  await host.locator('button.child').click();
  assert.equal(await input.inputValue(), '#price');

  // Clicking a list item builds a structural selector with :nth-of-type.
  await page.locator('.features li').nth(1).click({ force: true });
  const sel = await input.inputValue();
  assert.equal(await page.evaluate((s) => document.querySelector(s)?.textContent, sel), 'Small');

  // Page clicks are swallowed while picking (no navigation from the nav link).
  await page.locator('nav a').click({ force: true });
  assert.equal(page.url(), `${base}/page.html`);

  await page.locator('#price').click();
  await page.keyboard.press('ArrowUp');
  assert.equal(await input.inputValue(), 'div.buy-box');
  await page.keyboard.press('ArrowDown');
  await host.locator('button.confirm').click();
  const draft = await waitFor(() => storage('draft'));
  assert.equal(draft.selector, '#price');
  assert.equal(draft.url, `${base}/page.html`);
  assert.equal(draft.count, 1);
  assert.match(draft.preview, /59\.99/);
  await waitFor(async () => (await page.locator('#page-watch-picker-host').count()) === 0);
  await page.close();
  for (const p of ctx.pages()) if (p.url().includes('dashboard.html')) await p.close();
});

test('fetch + extract: baseline, change detection, condition, badge, diff UI', async () => {
  const dash = await extPage();
  await sw.evaluate(() => chrome.storage.local.remove('draft'));
  const { monitor } = await msg(dash, {
    type: 'monitor:save',
    monitor: { url: `${base}/page.html`, selector: '#price', interval: 1, condition: { type: 'below', value: '50' }, name: 'Widget price' },
  });
  assert.ok(monitor.id);
  const m1 = await waitFor(async () => { const m = (await storage('monitors'))[monitor.id]; return m.lastCheck && !m.checking && m; });
  assert.equal(m1.status, 'ok');
  assert.equal(m1.lastValue, 59.99);
  assert.equal(m1.conditionMet, false);
  const alarm = await sw.evaluate((id) => chrome.alarms.get('pw:' + id), monitor.id);
  assert.equal(alarm.periodInMinutes, 1);

  // Change outside the watched element: not a change.
  site.footer = 'v2';
  let r = await msg(dash, { type: 'monitor:check', id: monitor.id });
  assert.equal(r.changed, false);

  // Change that does not satisfy the condition: recorded, no alert.
  site.price = '$54.00';
  r = await msg(dash, { type: 'monitor:check', id: monitor.id });
  assert.equal(r.changed, true);
  assert.equal(r.met, false);
  assert.equal((await storage('monitors'))[monitor.id].unread, 0);

  // Price drop below threshold: alert.
  site.price = '$45.00';
  r = await msg(dash, { type: 'monitor:check', id: monitor.id });
  assert.equal(r.changed, true);
  assert.equal(r.met, true);
  const m2 = (await storage('monitors'))[monitor.id];
  assert.equal(m2.unread, 1);
  assert.equal(m2.changes, 2);
  assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '1');

  // Dashboard shows the word-level diff between the two latest snapshots and marks read.
  await dash.goto(`chrome-extension://${extId()}/dashboard/dashboard.html#m=${monitor.id}`);
  await dash.reload();
  await dash.locator('#diff del').first().waitFor();
  assert.equal(await dash.locator('#diff del').textContent(), '54.00');
  assert.equal(await dash.locator('#diff ins').textContent(), '45.00');
  assert.equal(await dash.locator('#timeline .tl').count(), 3);
  assert.equal(await dash.locator('#m-name').textContent(), 'Widget price');
  await waitFor(async () => (await storage('monitors'))[monitor.id].unread === 0);
  assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');

  // Pick older snapshot (baseline) from the timeline: diff baseline -> second.
  await dash.locator('#timeline .tl').nth(1).click();
  await waitFor(async () => (await dash.locator('#diff ins').textContent()) === '54.00');
  assert.equal(await dash.locator('#diff del').textContent(), '59.99');
  await shot(dash, 'dashboard-inline');
  // Side-by-side view.
  await dash.locator('#diff-mode button[data-mode="split"]').click();
  await dash.locator('#diff table.split').waitFor();
  await shot(dash, 'dashboard-split');
  await dash.emulateMedia({ colorScheme: 'dark' });
  await shot(dash, 'dashboard-dark');
  await dash.emulateMedia({ colorScheme: 'light' });
  await dash.locator('#diff-mode button[data-mode="inline"]').click();

  // Pause/resume clears and restores the alarm.
  await msg(dash, { type: 'monitor:pause', id: monitor.id, paused: true });
  assert.equal(await sw.evaluate((id) => chrome.alarms.get('pw:' + id), monitor.id), undefined);
  await msg(dash, { type: 'monitor:pause', id: monitor.id, paused: false });
  assert.ok(await sw.evaluate((id) => chrome.alarms.get('pw:' + id), monitor.id));
  assert.deepEqual(dash.errors, []);
  await dash.close();
});

test('text conditions and whole-page monitors', async () => {
  const dash = await extPage();
  const { monitor } = await msg(dash, {
    type: 'monitor:save',
    monitor: { url: `${base}/page.html`, selector: '.stock', interval: 5, condition: { type: 'contains', value: 'in stock' } },
  });
  await waitFor(async () => (await storage('monitors'))[monitor.id].lastCheck);
  site.status = 'In stock — ships today';
  const r = await msg(dash, { type: 'monitor:check', id: monitor.id });
  assert.equal(r.met, true);

  const whole = (await msg(dash, { type: 'monitor:save', monitor: { url: `${base}/page.html`, selector: '', interval: 60 } })).monitor;
  await waitFor(async () => (await storage('monitors'))[whole.id].lastCheck);
  const p = await msg(dash, { type: 'preview', url: `${base}/page.html`, selector: '', mode: 'fetch' });
  assert.match(p.text, /Widget Pro/);
  assert.match(p.text, /Fast\nSmall\nQuiet/);
  assert.doesNotMatch(p.text, /document\.title/); // scripts are ignored
  site.footer = 'v3';
  assert.equal((await msg(dash, { type: 'monitor:check', id: whole.id })).changed, true);

  // Selector that matches nothing: warning, not an error.
  const bad = (await msg(dash, { type: 'monitor:save', monitor: { url: `${base}/page.html`, selector: '#nope', interval: 60 } })).monitor;
  const mb = await waitFor(async () => { const m = (await storage('monitors'))[bad.id]; return m.lastCheck && m; });
  assert.equal(mb.status, 'ok');
  assert.match(mb.warning, /matched nothing/);
  // Unreachable page: error status.
  const dead = (await msg(dash, { type: 'monitor:save', monitor: { url: `${base}/missing.html`, interval: 60 } })).monitor;
  const md = await waitFor(async () => { const m = (await storage('monitors'))[dead.id]; return m.lastCheck && m; });
  assert.equal(md.status, 'error');
  assert.match(md.error, /HTTP 404/);
  await dash.close();
});

test('render mode extracts JavaScript-rendered content', async () => {
  const dash = await extPage();
  const fetched = await msg(dash, { type: 'preview', url: `${base}/spa.html`, selector: '#jobs', mode: 'fetch' });
  assert.equal(fetched.count, 0);
  const tabsBefore = (await sw.evaluate(() => chrome.tabs.query({}))).length;
  const rendered = await msg(dash, { type: 'preview', url: `${base}/spa.html`, selector: '#jobs', mode: 'render', renderWait: 1 });
  assert.equal(rendered.count, 1);
  assert.equal(rendered.text, 'Designer\nEngineer');
  await waitFor(async () => (await sw.evaluate(() => chrome.tabs.query({}))).length === tabsBefore);

  const { monitor } = await msg(dash, { type: 'monitor:save', monitor: { url: `${base}/spa.html`, selector: '#jobs', mode: 'render', renderWait: 1, interval: 15 } });
  await waitFor(async () => { const m = (await storage('monitors'))[monitor.id]; return m.lastCheck && !m.checking; }, 30000);
  site.jobs = ['Designer', 'Engineer', 'Data Scientist'];
  const r = await msg(dash, { type: 'monitor:check', id: monitor.id });
  assert.equal(r.changed, true);
  assert.equal(r.text, 'Designer\nEngineer\nData Scientist');
  await dash.close();
});

test('import / export round trip with dedupe', async () => {
  const dash = await extPage();
  const before = Object.values(await storage('monitors'));
  const exported = before.map((m) => ({ id: m.id, name: m.name, url: m.url, selector: m.selector, interval: m.interval, condition: m.condition }));
  let r = await msg(dash, { type: 'monitor:import', monitors: exported });
  assert.equal(r.added, 0);
  assert.equal(r.skipped.length, exported.length);
  r = await msg(dash, { type: 'monitor:import', monitors: [{ url: `${base}/page.html`, selector: 'h2', paused: true }, { url: 'not a url' }] });
  assert.equal(r.added, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(Object.values(await storage('monitors')).length, before.length + 1);
  // Export button produces a download with the monitors.
  await dash.reload();
  const [download] = await Promise.all([dash.waitForEvent('download'), dash.click('#export')]);
  const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(data.format, 'page-watch');
  assert.equal(data.monitors.length, before.length + 1);
  assert.ok(data.monitors.every((m) => m.url && !('lastCheck' in m)));
  // Delete removes monitor, alarm and history.
  const id = data.monitors[0].id;
  await msg(dash, { type: 'monitor:delete', id });
  assert.equal((await storage('monitors'))[id], undefined);
  assert.equal(await sw.evaluate((i) => chrome.alarms.get('pw:' + i), id), undefined);
  assert.deepEqual(dash.errors, []);
  await dash.close();
});

test('popup renders monitors and the editor from a draft', async () => {
  await sw.evaluate((url) => chrome.storage.local.set({ draft: { url, title: 'Test Shop', selector: '#price', preview: '$45.00', count: 1, createdAt: Date.now() } }), `${base}/page.html`);
  const popup = await extPage('popup/popup.html');
  await popup.locator('#view-editor:not([hidden])').waitFor();
  assert.equal(await popup.locator('input[name="selector"]').inputValue(), '#price');
  await popup.setViewportSize({ width: 380, height: 760 });
  await shot(popup, 'popup-editor');
  await popup.selectOption('select[name="ctype"]', 'above');
  await popup.fill('input[name="cvalue"]', 'abc');
  await popup.click('#editor-save');
  assert.match(await popup.locator('.form-error').textContent(), /valid number/);
  await popup.click('#editor-cancel');
  await popup.locator('#view-home:not([hidden])').waitFor();
  await shot(popup, 'popup-home');
  assert.equal(await storage('draft'), undefined);
  assert.deepEqual(popup.errors, []);
  await popup.close();
});
