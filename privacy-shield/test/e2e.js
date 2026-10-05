#!/usr/bin/env node
// End-to-end check in real Chromium with the extension loaded.
// Every hostname is mapped to a local server with --host-resolver-rules, so pages on
// site-a.com can load "third-party" scripts from www.google-analytics.com and friends.
// Usage: node privacy-shield/test/e2e.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const log = []; // { host, path, gpc, cookie }

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  const url = new URL(req.url, `http://${host}`);
  log.push({ host, path: url.pathname, search: url.search, gpc: req.headers['sec-gpc'] || null, at: Date.now() });
  const headers = { 'Cache-Control': 'no-store' };
  if (host.endsWith('learnme-cdn.com')) headers['Set-Cookie'] = 'uid=abc123; Path=/; Max-Age=3600';
  let file = null;
  if (url.pathname === '/frame.html') file = 'frame.html';
  else if (url.pathname.endsWith('.html')) file = path.basename(url.pathname);
  if (file && fs.existsSync(path.join(FIXTURES, file))) {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(FIXTURES, file)));
  } else if (url.pathname.endsWith('.js')) {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' });
    res.end(`window.__loaded = (window.__loaded || []).concat(${JSON.stringify(host + url.pathname)});`);
  } else if (url.pathname.endsWith('.gif')) {
    res.writeHead(200, { ...headers, 'Content-Type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } else {
    res.writeHead(404, headers);
    res.end('not found');
  }
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
const hits = (host, p, since = 0) => log.filter((r) => r.host === host && (!p || r.path === p) && r.at >= since);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost`,
    ],
  });
  let exitCode = 1;
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = sw.url().split('/')[2];
    const swErrors = [];
    sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

    // An extension page to talk to the worker with the same messages as the popup.
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${id}/options/options.html`);
    const msg = (type, payload = {}) => ext.evaluate(async ([t, p]) => chrome.runtime.sendMessage({ type: t, ...p }), [type, payload]);
    const tabIdFor = (pattern) => ext.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0]?.id, pattern);

    // Wait for onInstalled to finish syncing rules and registering the GPC script.
    for (let i = 0; i < 50; i++) {
      const n = await ext.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
      if (n) break;
      await sleep(100);
    }
    const enabled = await ext.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
    check('all static rulesets enabled', ['ads', 'analytics', 'social', 'fingerprinting', 'session-replay', 'params', 'gpc'].every((r) => enabled.includes(r)), enabled.join(','));

    // ── 1. Third-party tracker blocking ──
    const page = await ctx.newPage();
    let t0 = Date.now();
    await page.goto('http://site-a.com/tracked.html');
    await sleep(1500);
    check('first-party script loads', hits('site-a.com', '/first-party.js', t0).length === 1);
    check('non-tracker third party loads', hits('cdn.widget-ok.com', '/widget.js', t0).length === 1);
    check('analytics tracker blocked', hits('www.google-analytics.com', null, t0).length === 0);
    check('session replay tracker blocked', hits('static.hotjar.com', null, t0).length === 0);
    check('advertising tracker blocked', hits('ad.doubleclick.net', null, t0).length === 0);
    check('fingerprinting tracker blocked', hits('cdn.fpjs.io', null, t0).length === 0);

    // ── 2. GPC header and JS property ──
    const docReq = hits('site-a.com', '/tracked.html', t0)[0];
    check('Sec-GPC header sent', docReq && docReq.gpc === '1');
    check('navigator.globalPrivacyControl is true', await page.evaluate(() => navigator.globalPrivacyControl === true));

    // ── 3. Popup report ──
    const tabA = await tabIdFor('http://site-a.com/*');
    let res = await msg('popup:report', { tabId: tabA, url: page.url() });
    const rep = res.result;
    const domains = rep.trackers.map((t) => t.domain).sort();
    check('report lists blocked trackers', ['doubleclick.net', 'fpjs.io', 'google-analytics.com', 'hotjar.com'].every((d) => domains.includes(d)), domains.join(','));
    check('report counts blocked requests', rep.trackers.every((t) => t.blocked >= 1));
    check('report has a grade', /^[A-F]$/.test(rep.grade.grade) && rep.grade.grade !== 'A', rep.grade.grade);
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForTimeout(300);
    await popup.close();

    // ── 4. Same-company resources stay allowed ──
    t0 = Date.now();
    await page.goto('http://www.facebook.com/facebook.html');
    await sleep(800);
    check('facebook.net allowed on facebook.com', hits('connect.facebook.net', '/sdk.js', t0).length === 1);
    check('fbcdn.net allowed on facebook.com', hits('static.fbcdn.net', '/rsrc.js', t0).length === 1);

    // ── 5. Tracking parameter stripping ──
    t0 = Date.now();
    await page.goto('http://site-b.org/landing.html?id=5&utm_source=newsletter&utm_medium=email&fbclid=abc&mc_eid=9');
    await sleep(500);
    check('tracking params stripped from URL', page.url() === 'http://site-b.org/landing.html?id=5', page.url());
    const landing = hits('site-b.org', '/landing.html', t0);
    check('server never saw tracking params', landing.length >= 1 && landing.every((r) => !/utm_|fbclid|mc_eid/.test(r.search)), landing.map((r) => r.search).join(' '));
    const tabB = await tabIdFor('http://site-b.org/*');
    res = await msg('popup:report', { tabId: tabB, url: page.url() });
    check('report counts stripped params', res.result.params === 4, String(res.result.params));

    // ── 6. Cookie banners (reject mode is the default) ──
    await page.goto('http://site-c.net/onetrust.html');
    await page.waitForFunction(() => document.documentElement.dataset.consent, null, { timeout: 8000 }).catch(() => {});
    check('OneTrust rejected', await page.evaluate(() => document.documentElement.dataset.consent) === 'rejected');
    check('OneTrust page scrolls again', await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'));
    const tabC = await tabIdFor('http://site-c.net/*');
    await sleep(1000);
    res = await msg('popup:report', { tabId: tabC, url: page.url() });
    check('report shows banner action', res.result.banner && res.result.banner.cmp === 'onetrust' && res.result.banner.action === 'reject', JSON.stringify(res.result.banner));

    await page.goto('http://site-c.net/cookiebot.html');
    await page.waitForFunction(() => document.documentElement.dataset.consent, null, { timeout: 8000 }).catch(() => {});
    await sleep(1000);
    check('Cookiebot rejected', await page.evaluate(() => document.documentElement.dataset.consent) === 'rejected');

    await page.goto('http://site-c.net/generic.html');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('banner')).display === 'none', null, { timeout: 8000 }).catch(() => {});
    await sleep(1000);
    check('generic banner without reject button is hidden', await page.evaluate(() => getComputedStyle(document.getElementById('banner')).display === 'none'));
    check('generic banner scroll lock removed', await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden'));

    await msg('settings:save', { patch: { cookieMode: 'accept' } });
    await page.goto('http://site-c.net/onetrust.html');
    await page.waitForFunction(() => document.documentElement.dataset.consent, null, { timeout: 8000 }).catch(() => {});
    await sleep(1000);
    check('accept mode accepts', await page.evaluate(() => document.documentElement.dataset.consent) === 'accepted');
    await msg('settings:save', { patch: { cookieMode: 'reject' } });

    // ── 7. Category toggle ──
    await msg('settings:save', { patch: { categories: { analytics: false } } });
    t0 = Date.now();
    await page.goto('http://site-a.com/tracked.html');
    await sleep(1000);
    check('disabled category is allowed', hits('www.google-analytics.com', null, t0).length === 1);
    check('other categories still blocked', hits('static.hotjar.com', null, t0).length === 0);
    await msg('settings:save', { patch: { categories: { analytics: true } } });

    // ── 8. Per-site allowlist ──
    await msg('popup:setSiteProtection', { host: 'site-a.com', enabled: false });
    console.log('DEBUG', JSON.stringify(await ext.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())));
    t0 = Date.now();
    await page.goto('http://site-a.com/tracked.html');
    await sleep(1000);
    check('allowlisted site loads trackers', hits('static.hotjar.com', null, t0).length === 1 && hits('www.google-analytics.com', null, t0).length === 1, log.filter((r) => r.at >= t0).map((r) => r.host + r.path).join(' '));
    await msg('popup:setSiteProtection', { host: 'site-a.com', enabled: true });
    t0 = Date.now();
    await page.goto('http://site-a.com/tracked.html');
    await sleep(1000);
    check('protection restored after allowlist removal', hits('static.hotjar.com', null, t0).length === 0);

    // ── 9. Heuristic learning ──
    for (const site of ['site-b.org', 'site-c.net']) {
      await page.goto(`http://${site}/tracked.html`);
      await sleep(2500); // the storage probe waits for load + 1.5 s
    }
    let data = (await msg('dashboard:data')).result;
    const entry = data.learned['learnme-cdn.com'];
    check('cross-site cookie user learned on 3 sites', entry && entry.sites.length >= 3, entry ? entry.sites.join(',') : 'none');
    check('widget without cookies not learned', !data.learned['widget-ok.com']);
    await msg('settings:save', { patch: { autoBlockLearned: true } });
    t0 = Date.now();
    await page.goto('http://site-a.com/tracked.html');
    await sleep(1000);
    check('learned tracker auto-blocked', hits('px.learnme-cdn.com', null, t0).length === 0);
    res = await msg('popup:report', { tabId: tabA, url: page.url() });
    check('learned tracker shown in report', res.result.trackers.some((t) => t.domain === 'learnme-cdn.com' && t.category === 'learned' && t.blocked > 0));

    // ── 10. Dashboard totals ──
    data = (await msg('dashboard:data')).result;
    const today = Object.values(data.stats.days).pop();
    check('dashboard counts blocked requests', today.blocked > 5, String(today.blocked));
    check('dashboard counts params and banners', today.params >= 4 && today.banners >= 3, `${today.params}/${today.banners}`);
    check('dashboard grades sites', data.sites['site-a.com'] && /^[A-F]$/.test(data.sites['site-a.com'].grade));
    const dash = await ctx.newPage();
    const dashErrors = [];
    dash.on('pageerror', (e) => dashErrors.push(e.message));
    await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
    await dash.waitForSelector('#chart svg rect', { timeout: 5000 }).catch(() => {});
    check('dashboard renders chart', (await dash.$$('#chart svg rect')).length > 0 && dashErrors.length === 0, dashErrors.join('; '));
    check('dashboard lists learned tracker', (await dash.textContent('#learned')).includes('learnme-cdn.com'));

    check('no service worker errors', swErrors.length === 0, swErrors.join('; '));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    exitCode = failed ? 1 : 0;
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
