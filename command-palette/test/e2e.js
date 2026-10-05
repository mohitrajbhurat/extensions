#!/usr/bin/env node
// End-to-end check for Command Palette.
// Usage: node command-palette/test/e2e.js   (needs Playwright, like tools/smoke-test.js)
//
// The keyboard shortcut cannot be pressed through Playwright, so the test injects the
// overlay with the same chrome.scripting.executeScript call the shortcut handler uses.
// That needs a host permission for the local test server (the real extension gets it
// from activeTab), so the test runs against a temporary copy with that one addition.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'test') continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

const PAGES = {
  '/alpha.html': 'Alpha Fixture',
  '/bravo.html': 'Bravo Quarterly Report',
  '/charlie.html': 'Charlie Notes',
};

(async () => {
  const server = http.createServer((req, res) => {
    const title = PAGES[req.url.split('?')[0]];
    if (!title) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${title}</title><body style="height:3000px;font-family:sans-serif"><h1>${title}</h1>
      <input id="pageinput"><script>window.pageKeys=0;document.addEventListener('keydown',()=>window.pageKeys++);</script></body>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-'));
  const ext = path.join(tmp, 'ext');
  copyDir(SRC, ext);
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const errors = [];
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });

  const open = async p => {
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(p + ': ' + e.message));
    await pg.goto(base + p);
    return pg;
  };
  const alpha = await open('/alpha.html');
  const bravo = await open('/bravo.html');
  const charlie = await open('/charlie.html');
  for (const pg of ctx.pages()) if (pg.url() === 'about:blank') await pg.close();

  const activeTab = () => sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return { url: t.url, id: t.id };
  });
  const tabIdOf = url => sw.evaluate(async u => (await chrome.tabs.query({ url: u }))[0].id, url);
  const togglePalette = async page => {
    await page.bringToFront();
    const tabId = await tabIdOf(page.url());
    await sw.evaluate(async t => {
      await chrome.tabs.update(t, { active: true });
      await chrome.scripting.executeScript({ target: { tabId: t }, files: ['ui/palette-ui.js', 'content/overlay.js'] });
    }, tabId);
    await page.waitForTimeout(250);
  };
  const overlayOpen = page => page.evaluate(() => !!document.querySelector('command-palette-overlay'));

  // 1. Open the palette on a page.
  await togglePalette(alpha);
  check('overlay injected into page', await overlayOpen(alpha));
  const focusedInShadow = await alpha.evaluate(() => document.activeElement && document.activeElement.tagName === 'COMMAND-PALETTE-OVERLAY');
  check('palette input has focus', focusedInShadow);
  await alpha.screenshot({ path: path.join(tmp, 'overlay-empty.png') });

  // 2. Search for a tab and switch to it.
  await alpha.keyboard.type('bravo rep', { delay: 20 });
  await alpha.waitForTimeout(300);
  await alpha.screenshot({ path: path.join(tmp, 'overlay-search.png') });
  const pageKeys = await alpha.evaluate(() => window.pageKeys);
  check('keystrokes isolated from page handlers', pageKeys === 0, 'page saw ' + pageKeys);
  await alpha.keyboard.press('Enter');
  await alpha.waitForTimeout(400);
  let act = await activeTab();
  check('Enter switches to matching tab', act.url.endsWith('/bravo.html'), act.url);
  check('overlay closed after switching', !(await overlayOpen(alpha)));

  // 3. Run an action: duplicate tab.
  await togglePalette(bravo);
  await bravo.keyboard.type('/dupl', { delay: 20 });
  await bravo.waitForTimeout(300);
  await bravo.keyboard.press('Enter');
  await bravo.waitForTimeout(600);
  const bravoCount = await sw.evaluate(async u => (await chrome.tabs.query({ url: u })).length, base + '/bravo.html');
  check('action "Duplicate Tab" ran', bravoCount === 2, bravoCount + ' bravo tabs');

  // 4. Copy URL action writes the clipboard and shows a toast.
  await togglePalette(charlie);
  await charlie.keyboard.type('copy url', { delay: 20 });
  await charlie.waitForTimeout(300);
  await charlie.keyboard.press('Enter');
  await charlie.waitForTimeout(400);
  const clip = await charlie.evaluate(() => navigator.clipboard.readText()).catch(e => 'ERR ' + e.message);
  check('action "Copy URL" copied', clip === base + '/charlie.html', clip);
  check('toast shown after copy', await charlie.evaluate(() => !!document.querySelector('command-palette-toast')));

  // 5. Scroll to bottom (in-page op) and Escape closes.
  await togglePalette(charlie);
  await charlie.keyboard.type('scroll bottom', { delay: 10 });
  await charlie.waitForTimeout(300);
  await charlie.keyboard.press('Enter');
  await charlie.waitForTimeout(900);
  const y = await charlie.evaluate(() => window.scrollY);
  check('action "Scroll to Bottom" scrolled the page', y > 1000, 'scrollY ' + y);
  await togglePalette(charlie);
  await charlie.keyboard.press('Escape');
  await charlie.waitForTimeout(150);
  check('Esc closes the palette', !(await overlayOpen(charlie)));
  await togglePalette(charlie);
  await togglePalette(charlie);
  check('shortcut again toggles it closed', !(await overlayOpen(charlie)));

  // 6. Popup page (also the fallback window): DOM-level checks.
  const charlieId = await tabIdOf(base + '/charlie.html');
  const popup = await ctx.newPage();
  popup.on('pageerror', e => errors.push('popup: ' + e.message));
  popup.on('console', m => { if (m.type() === 'error') errors.push('popup console: ' + m.text()); });
  await popup.goto(`chrome-extension://${id}/ui/palette.html?mode=window&tab=${charlieId}`);
  await popup.waitForTimeout(400);
  const rows = () => popup.$$eval('.cp-item', els => els.map(e => ({
    title: e.querySelector('.cp-title').textContent,
    badge: (e.querySelector('.cp-badge') || {}).textContent || '',
    marks: [...e.querySelectorAll('.cp-title mark')].map(m => m.textContent).join(''),
  })));
  const typeQ = async q => { await popup.fill('.cp-input', q); await popup.waitForTimeout(250); return rows(); };

  let r = await rows();
  check('empty query lists open tabs', r.some(x => x.badge === 'Tab'), r.length + ' rows');
  r = await typeQ('chrl');
  check('fuzzy "chrl" finds Charlie Notes first', r[0] && r[0].title === 'Charlie Notes', r[0] && r[0].title);
  check('match highlighting', r[0] && r[0].marks.toLowerCase() === 'chrl', r[0] && r[0].marks);
  r = await typeQ('/');
  check('"/" lists 40+ actions', r.filter(x => x.badge === 'Action').length >= 40, r.filter(x => x.badge === 'Action').length + ' actions');
  r = await typeQ('/ctr');
  check('"/ctr" ranks Close Tabs to the Right first', r[0] && r[0].title === 'Close Tabs to the Right', r[0] && r[0].title);
  r = await typeQ('>alpha');
  check('">" restricts to tabs', r.length > 0 && r.every(x => ['Tab', 'Current', 'Closed', 'Closed window'].includes(x.badge)), r.map(x => x.badge).join(','));
  r = await typeQ('@bravo');
  check('"@" searches history', r.length > 0 && r.every(x => x.badge === 'History'), r.map(x => x.title).join(' | '));
  r = await typeQ('yt lofi');
  check('keyword command "yt lofi"', r[0] && r[0].title === 'Search YouTube for “lofi”', r[0] && r[0].title);
  check('mode chip shows command name', await popup.$eval('.cp-chip', e => !e.hidden && e.textContent === 'YouTube'));
  r = await typeQ('zzqqxx something');
  check('fallback web searches offered', r.some(x => x.title.startsWith('Search Google for')), r.map(x => x.title).join(' | '));

  // Sub-list: move tab to window shows windows + New Window.
  r = await typeQ('move tab to window');
  await popup.keyboard.press('Enter');
  await popup.waitForTimeout(300);
  r = await rows();
  check('sub-list opens for "Move Tab to Window…"', r.some(x => x.title === 'New Window'), r.map(x => x.title).join(' | '));
  await popup.keyboard.press('Escape');
  await popup.waitForTimeout(250);
  check('Esc leaves sub-list', (await popup.inputValue('.cp-input')) === 'move tab to window');

  // Frecency: "Zoom In" normally ranks first for "z"; pick "Zoom Out" twice and it should win.
  const zoomCount = async () => sw.evaluate(async t => chrome.tabs.getZoom(t), charlieId);
  for (let i = 0; i < 2; i++) {
    const pz = await ctx.newPage();
    await pz.goto(`chrome-extension://${id}/ui/palette.html?mode=window&tab=${charlieId}`);
    await pz.waitForTimeout(300);
    await pz.fill('.cp-input', 'z');
    await pz.waitForTimeout(300);
    const titles = await pz.$$eval('.cp-item .cp-title', els => els.map(e => e.textContent));
    const idx = titles.indexOf('Zoom Out');
    await pz.locator('.cp-item').nth(idx).click({ shift: false });
    await pz.waitForEvent('close', { timeout: 3000 }).catch(() => {});
  }
  check('Zoom Out action changed zoom', (await zoomCount()) < 1, 'zoom ' + (await zoomCount()));

  const p2 = await ctx.newPage();
  await p2.goto(`chrome-extension://${id}/ui/palette.html?mode=window&tab=${charlieId}`);
  await p2.waitForTimeout(500);
  await p2.fill('.cp-input', 'z');
  await p2.waitForTimeout(300);
  const firstZ = await p2.$eval('.cp-item .cp-title', e => e.textContent);
  check('frecency: learned pick ranks first for "z"', firstZ === 'Zoom Out', firstZ);
  await p2.close().catch(() => {});

  // Options page renders the default search commands.
  const opt = await ctx.newPage();
  opt.on('pageerror', e => errors.push('options: ' + e.message));
  await opt.goto(`chrome-extension://${id}/options/options.html#commands`);
  await opt.waitForTimeout(400);
  const cmdRows = await opt.$$eval('#commands-table tbody tr', t => t.length);
  check('options lists default search commands', cmdRows >= 5, cmdRows + ' rows');
  await opt.fill('#add-command [name=name]', 'Jira');
  await opt.fill('#add-command [name=keyword]', 'jira');
  await opt.fill('#add-command [name=url]', 'https://example.atlassian.net/browse/{query}');
  await opt.click('#add-command button[type=submit]');
  await opt.waitForTimeout(400);
  const p3 = await ctx.newPage();
  await p3.goto(`chrome-extension://${id}/ui/palette.html?mode=window&tab=${charlieId}`);
  await p3.waitForTimeout(400);
  await p3.fill('.cp-input', 'jira ABC-123');
  await p3.waitForTimeout(300);
  const jira = await p3.$eval('.cp-item .cp-title', e => e.textContent);
  check('custom command added in options works', jira === 'Search Jira for “ABC-123”', jira);

  check('no page errors', errors.length === 0, errors.join('; '));
  console.log('screenshots in ' + tmp);
  await ctx.close();
  server.close();
  console.log(failures ? `FAILED ${failures} check(s)` : 'ALL E2E CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
