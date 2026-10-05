// End-to-end checks: the extension's extraction and highlighting content scripts, and
// the side panel driving a real page through the extension APIs.
// Run: node --test page-assistant/test/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const FIX = path.join(EXT, 'test', 'fixtures');

let server, origin, ctx, extId, extCopy;

function serve() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'article.html';
      const file = path.join(FIX, path.basename(name));
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test.before(async () => {
  origin = await serve();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-'));
  // Headless tests cannot click the toolbar icon (activeTab) or answer the optional
  // permission prompt, so load a copy whose manifest already holds the host access a
  // user grants with "Allow on all sites".
  const copy = extCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ext-'));
  fs.cpSync(EXT, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}test${path.sep}`) && !src.endsWith(`${path.sep}test`) });
  const mf = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(mf, null, 2));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  extId = sw.url().split('/')[2];
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (server) server.close();
  if (extCopy) fs.rmSync(extCopy, { recursive: true, force: true });
});

async function extracted(file) {
  const page = await ctx.newPage();
  await page.goto(`${origin}/${file}`);
  await page.addScriptTag({ path: path.join(EXT, 'content', 'extract.js') });
  const r = await page.evaluate(() => globalThis.__PA_extract());
  return { page, r };
}

test('extracts an article and drops navigation, ads, comments and sidebars', async () => {
  const { page, r } = await extracted('article.html');
  const text = r.blocks.map((b) => b.text).join('\n');
  assert.strictEqual(r.title, 'The Quiet Return of the Honeybee');
  assert.strictEqual(r.byline, 'Lena Ortiz');
  assert.ok(r.published.startsWith('2026-04-12'));
  assert.match(text, /varroa mite feeds on the fat bodies/);
  assert.match(text, /wildflower strips/i);
  for (const junk of ['Advertisement', 'Most popular', 'Subscribe to our newsletter', 'All rights reserved', 'I have kept bees for twenty years', 'Share on Facebook', 'We use cookies']) {
    assert.ok(!text.includes(junk), `boilerplate leaked: ${junk}`);
  }
  const heads = r.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.deepStrictEqual(heads, ['The Quiet Return of the Honeybee', 'Why the varroa mite mattered', 'Forage and farming', 'What comes next']);
  assert.strictEqual(r.blocks.filter((b) => b.type === 'li').length, 3);
  await page.close();
});

test('extracts a div-soup blog without semantic tags', async () => {
  const { page, r } = await extracted('blog-divs.html');
  const text = r.blocks.map((b) => b.text).join('\n');
  assert.strictEqual(r.title, 'Notes on Sourdough');
  assert.match(text, /wild yeast and lactic acid bacteria/);
  assert.match(text, /80 percent hydration/);
  assert.ok(!text.includes('Archive 2025'), 'menu leaked');
  assert.ok(!text.includes('Powered by a static site generator'), 'footer leaked');
  // <br><br> inside one div must split into separate paragraphs.
  assert.ok(r.blocks.length >= 6, `expected paragraph splitting, got ${r.blocks.length}`);
  await page.close();
});

test('extracts docs pages with code blocks, headings and tables', async () => {
  const { page, r } = await extracted('docs.html');
  assert.strictEqual(r.title, 'Configuring the Cache');
  const pre = r.blocks.find((b) => b.type === 'pre');
  assert.ok(pre && pre.text.includes('maxEntries: 10000'));
  assert.ok(r.blocks.some((b) => b.type === 'table' && b.text.includes('serveStale')));
  assert.deepStrictEqual(r.blocks.filter((b) => b.type === 'heading').map((b) => b.level), [1, 2, 2, 3, 2]);
  const text = r.blocks.map((b) => b.text).join('\n');
  assert.ok(!text.includes('Getting started'), 'nav leaked');
  assert.ok(!text.includes('Was this page helpful'), 'footer leaked');
  await page.close();
});

test('reports the page selection', async () => {
  const page = await ctx.newPage();
  await page.goto(`${origin}/article.html`);
  await page.addScriptTag({ path: path.join(EXT, 'content', 'extract.js') });
  const sel = await page.evaluate(() => {
    const el = [...document.querySelectorAll('p')].find((p) => p.textContent.includes('varroa mite feeds'));
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return globalThis.__PA_getSelection();
  });
  assert.match(sel, /^The varroa mite feeds on the fat bodies/);
  await page.close();
});

test('highlights passages and terms in the page', async () => {
  const page = await ctx.newPage();
  await page.goto(`${origin}/article.html`);
  await page.addScriptTag({ path: path.join(EXT, 'content', 'extract.js') });
  await page.addScriptTag({ path: path.join(EXT, 'content', 'highlight.js') });
  await page.evaluate(() => globalThis.__PA_extract());
  const hit = await page.evaluate(() => globalThis.__PA_hl.highlight({
    passages: [{ text: 'The varroa mite feeds on the fat bodies of developing bees, weakening their immune systems.' }],
  }));
  assert.strictEqual(hit.found, 1);
  const term = await page.evaluate(() => globalThis.__PA_hl.highlightTerm({ term: 'honeybee' }));
  assert.ok(term.found >= 2, `expected several matches, got ${term.found}`);
  const cleared = await page.evaluate(() => { globalThis.__PA_hl.clear(); return document.querySelectorAll('mark.__pa-mark').length; });
  assert.strictEqual(cleared, 0);
  await page.close();
});

async function openPanel(file) {
  const target = await ctx.newPage();
  await target.goto(`${origin}/${file}`);
  await target.bringToFront();
  // Playwright keeps every page in one window, so bind the panel to the fixture tab the
  // same way the service worker does for the popup-window fallback (?tab=<id>).
  const [sw] = ctx.serviceWorkers();
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, target.url());
  const panel = await ctx.newPage();
  if (process.env.PA_DEBUG) { panel.on('console', (m) => console.log('PANEL', m.text())); panel.on('pageerror', (e) => console.log('PERR', e.message)); }
  await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html?mode=window&tab=${tabId}`);
  // The panel resolves the active tab; make sure it found the fixture.
  await panel.waitForFunction(() => /Honeybee|Sourdough|Cache/.test(document.querySelector('#page-title').textContent), { timeout: 20000 });
  return { target, panel };
}

test('side panel summarizes a page offline and shows reading insights', async () => {
  const { target, panel } = await openPanel('article.html');
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.click('#btn-summarize');
  await panel.waitForSelector('#sum-output .kp li', { timeout: 30000 });
  const points = await panel.$$eval('#sum-output .kp li .t', (els) => els.map((e) => e.textContent));
  assert.ok(points.length >= 3, `expected key points, got ${points.length}`);
  assert.ok(points.join(' ').toLowerCase().includes('mite'));
  assert.match(await panel.textContent('#sum-engine'), /Offline|On-device/);

  await panel.click('#tab-insights');
  const stats = await panel.textContent('#stats');
  assert.match(stats, /min/);
  const kws = await panel.$$eval('#keywords .chip', (els) => els.map((e) => e.textContent));
  assert.ok(kws.some((k) => /mite|bee|colon/i.test(k)), `keywords look wrong: ${kws.join(', ')}`);
  const outline = await panel.$$eval('#outline button', (els) => els.map((e) => e.textContent));
  assert.ok(outline.includes('Forage and farming'));

  // Clicking a key point highlights it on the page.
  await panel.click('#tab-summary');
  await panel.click('#sum-output .kp li .locate');
  await target.waitForFunction(() => document.querySelectorAll('mark.__pa-mark').length > 0 || (CSS.highlights && CSS.highlights.size > 0), { timeout: 10000 });
  assert.deepStrictEqual(errors, []);
  await panel.close();
  await target.close();
});

test('side panel answers questions offline with ranked passages', async () => {
  const { target, panel } = await openPanel('article.html');
  await panel.click('#tab-ask');
  await panel.fill('#chat-input', 'What is the varroa mite and why does it matter?');
  await panel.click('#chat-send');
  await panel.waitForSelector('.msg.bot .answer-best, .msg.bot .md', { timeout: 30000 });
  const answer = await panel.textContent('.msg.bot');
  assert.match(answer, /mite/i);
  const sources = await panel.$$('.msg.bot .source');
  assert.ok(sources.length >= 1, 'expected ranked source passages');
  await target.waitForFunction(() => document.querySelectorAll('mark.__pa-mark').length > 0 || (CSS.highlights && CSS.highlights.size > 0), { timeout: 10000 });
  await panel.close();
  await target.close();
});

test('side panel builds study material and saves history', async () => {
  const { target, panel } = await openPanel('docs.html');
  await panel.click('#tab-study');
  await panel.click('#btn-study');
  await panel.waitForSelector('.flashcard', { timeout: 30000 });
  const front = await panel.textContent('.flashcard .face.front');
  assert.ok(front.trim().length > 10);
  await panel.click('[data-nav="1"]');
  assert.match(await panel.textContent('.card-nav .muted'), /2 \/ /);

  await panel.click('#tab-summary');
  await panel.click('#btn-summarize');
  await panel.waitForSelector('#sum-output .kp li', { timeout: 30000 });
  await panel.click('#tab-history');
  await panel.waitForSelector('#hist-current .hist-entry', { timeout: 10000 });
  const entry = await panel.textContent('#hist-current .hist-entry');
  assert.match(entry, /cache/i);
  await panel.close();
  await target.close();
});

test('selection tools explain a passage offline', async () => {
  const { target, panel } = await openPanel('article.html');
  await target.evaluate(() => {
    const el = [...document.querySelectorAll('p')].find((p) => p.textContent.includes('varroa mite feeds'));
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await panel.click('#tab-tools');
  await panel.click('#sel-grab');
  await panel.waitForFunction(() => document.querySelector('#sel-text').value.includes('varroa'), { timeout: 10000 });
  await panel.click('[data-tool="explain"]');
  await panel.waitForSelector('#tool-output p, #tool-output ul', { timeout: 30000 });
  const out = await panel.textContent('#tool-output');
  assert.match(out, /Reading level|varroa|mite/i);
  await panel.close();
  await target.close();
});

test('context menu actions reach the panel (explain selection)', async () => {
  const { target, panel } = await openPanel('article.html');
  const [sw] = ctx.serviceWorkers();
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, target.url());
  // Same hand-off the service worker performs for "Explain" in the selection menu.
  await sw.evaluate(async (id) => chrome.storage.session.set({ 'pa:pending': { action: 'explain', text: 'Colonies with heavy infestations often fail during winter, when bees cannot forage and must survive on stored honey.', tabId: id, ts: Date.now() } }), tabId);
  await panel.waitForFunction(() => document.querySelector('#sel-text').value.includes('heavy infestations'), { timeout: 10000 });
  await panel.waitForSelector('#tool-output p, #tool-output ul', { timeout: 30000 });
  assert.ok(await panel.isVisible('#panel-tools'));
  const left = await sw.evaluate(async () => (await chrome.storage.session.get('pa:pending'))['pa:pending']);
  assert.strictEqual(left, undefined, 'pending action should be consumed once');
  await panel.close();
  await target.close();
});
