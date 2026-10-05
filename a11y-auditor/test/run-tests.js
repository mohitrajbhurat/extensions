#!/usr/bin/env node
// Tests for Accessibility Auditor (Playwright + headless Chromium).
// Usage: node a11y-auditor/test/run-tests.js
//
// 1. Engine: injects the same page scripts the extension uses into fixture pages and checks
//    that every expected rule fires on violations.html and that clean.html has no violations.
// 2. Extension: loads a temporary copy with an added "<all_urls>" host permission (tests
//    cannot click the toolbar button to grant activeTab), scans a fixture tab through the
//    shipped ui/scan.js, drives the overlays and checks that the results UI renders and exports.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const PAGE_FILES = ['lib/color.js', 'lib/aria.js', 'lib/accname.js', 'content/engine.js', 'content/overlay.js'];
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}

const EXPECTED = [
  'color-contrast', 'image-alt', 'image-alt-suspicious', 'input-image-alt', 'area-alt', 'role-img-alt',
  'object-alt', 'server-side-image-map', 'link-name', 'link-ambiguous', 'skip-link', 'button-name',
  'nested-interactive', 'label-content-name-mismatch', 'label', 'label-placeholder-only', 'label-title-only',
  'form-field-multiple-labels', 'autocomplete-valid', 'empty-heading', 'heading-order',
  'landmark-one-main', 'landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo', 'landmark-unique',
  'region', 'duplicate-id', 'aria-roles', 'aria-valid-attr', 'aria-valid-attr-value', 'aria-allowed-attr',
  'aria-prohibited-attr', 'presentation-role-conflict', 'aria-required-attr', 'aria-required-children',
  'aria-required-parent', 'aria-hidden-focus', 'aria-widget-name', 'tabindex', 'click-events-keyboard',
  'scrollable-region-focusable', 'focus-visible', 'html-lang-valid', 'valid-lang', 'document-title',
  'meta-viewport', 'meta-refresh', 'blink-marquee', 'no-autoplay-audio', 'video-caption', 'list', 'listitem',
  'definition-list', 'table-headers', 'td-headers-attr', 'empty-table-header', 'frame-title',
  'frame-title-unique', 'target-size', 'accesskeys',
];

async function injectEngine(page) {
  for (const f of PAGE_FILES) await page.addScriptTag({ content: fs.readFileSync(path.join(SRC, f), 'utf8') });
}

(async () => {
  const server = http.createServer((req, res) => {
    const name = path.basename(req.url.split('?')[0]) || 'violations.html';
    const file = path.join(FIX, name);
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  // ---------------------------------------------------------------- engine
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(base + 'violations.html');
  await injectEngine(page);
  const bad = await page.evaluate(() => window.A11Y.engine.run({ includeAAA: true, includeBestPractice: true }));
  const fired = new Set(bad.issues.map((i) => i.rule));
  const total = await page.evaluate(() => window.A11Y.engine.ruleList().length);
  check('rule count is 40+', total >= 40, `${total} rules`);
  check('engine reported no rule errors', bad.errors.length === 0, JSON.stringify(bad.errors));
  const missing = EXPECTED.filter((id) => !fired.has(id));
  check('every expected rule fires on violations.html', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : `${EXPECTED.length} rules`);
  check('AAA contrast fires when enabled', fired.has('color-contrast-enhanced'));
  check('identical-links fires when AAA enabled', fired.has('identical-links-same-purpose'));
  const contrast = bad.issues.filter((i) => i.rule === 'color-contrast');
  const low = contrast.find((i) => /Low contrast/.test(i.snippet));
  check('contrast ratio for #aaa on #fff is 2.32', low && Math.abs(low.data.ratio - 2.32) < 0.02, low && JSON.stringify(low.data));
  const faded = contrast.find((i) => /Faded/.test(i.snippet));
  check('opacity is applied to contrast', !!faded, faded && faded.message);
  check('issues carry selector, snippet and WCAG metadata',
    bad.issues.every((i) => i.selector && i.snippet && bad.rules[i.rule] && bad.rules[i.rule].wcag.length));
  check('WCAG links point at WCAG 2.2 Understanding docs', Object.values(bad.rules).every((r) => r.wcag.every((w) => /WCAG22\/Understanding\//.test(w.url))));
  check('outline lists headings and landmarks', bad.outline.headings.length >= 2 && bad.outline.landmarks.length >= 4);
  const noAAA = await page.evaluate(() => window.A11Y.engine.run({}));
  check('AAA rules are skipped by default', !noAAA.issues.some((i) => i.rule === 'color-contrast-enhanced'));

  // Overlay API on the plain page
  const ov = await page.evaluate(() => {
    const O = window.A11Y.overlay;
    const order = O.showTabOrder();
    const host = document.getElementById('__a11y-auditor-root');
    const nums = host.shadowRoot.querySelectorAll('.tab-num').length;
    const ref = window.A11Y.engine.run({}).issues[0].ref;
    const hl = O.highlight(ref, 'x');
    const markers = O.showMarkers([{ ref, impact: 'critical', kind: 'violation', title: 'T' }]);
    const v = O.setVision('deuteranopia');
    const filter = document.documentElement.style.filter;
    O.clear();
    return { order: order.length, nums, hl, markers, v, filter, after: !!document.getElementById('__a11y-auditor-root'), filterAfter: document.documentElement.style.filter };
  });
  check('tab order overlay numbers every stop', ov.order > 5 && ov.nums === ov.order, `${ov.order} stops`);
  check('tab order puts positive tabindex first', await page.evaluate(() => /Positive/.test(window.A11Y.overlay.tabSequence()[0].textContent)));
  check('highlight and markers render', ov.hl === true && ov.markers === 1);
  check('colour-vision filter applies and clears', /url\(.*deuteranopia/.test(ov.filter) && !ov.filterAfter && !ov.after, ov.filter);

  await page.goto(base + 'clean.html');
  await injectEngine(page);
  const good = await page.evaluate(() => window.A11Y.engine.run({ includeAAA: false, includeBestPractice: true }));
  const violations = good.issues.filter((i) => i.kind === 'violation');
  check('clean.html has no violations', violations.length === 0, violations.map((i) => `${i.rule}: ${i.message} @ ${i.selector}`).join(' | '));
  const reviews = good.issues.filter((i) => i.kind === 'review');
  check('clean.html has no review items', reviews.length === 0, reviews.map((i) => `${i.rule}: ${i.message}`).join(' | '));
  check('pages threw no errors', pageErrors.length === 0, pageErrors.join(' | '));

  // accname unit checks
  const names = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="acc">
        <button id="b1"><img src="x.gif" alt="Search"></button>
        <a id="a1" href="#"><span aria-hidden="true">X</span><span class="sr">Close menu</span></a>
        <span id="lb1">First</span><span id="lb2">Last</span><input id="i1" aria-labelledby="lb1 lb2">
        <label>Age <input id="i2" type="number"></label>
        <button id="b2" aria-label="  ">Text</button>
        <a id="a2" href="#"><svg><title>Home</title></svg></a>
      </div>`);
    const n = (id) => window.A11Y.dom.accessibleName(document.getElementById(id));
    const out = {};
    for (const id of ['b1', 'a1', 'i1', 'i2', 'b2', 'a2']) out[id] = n(id);
    document.getElementById('acc').remove();
    return out;
  });
  check('accname: img alt inside button', names.b1.name === 'Search');
  check('accname: aria-hidden content is skipped', names.a1.name === 'Close menu', names.a1.name);
  check('accname: aria-labelledby joins ids', names.i1.name === 'First Last' && names.i1.source === 'aria-labelledby');
  check('accname: wrapping label', names.i2.name === 'Age' && names.i2.source === 'label', JSON.stringify(names.i2));
  check('accname: blank aria-label falls back to content', names.b2.name === 'Text');
  check('accname: svg title inside link', names.a2.name === 'Home', names.a2.name);
  await browser.close();

  // ---------------------------------------------------------------- extension
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-auditor-ext-'));
  fs.cpSync(SRC, ext, { recursive: true, filter: (p) => !p.split(path.sep).includes('test') || p === SRC });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-auditor-profile-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1200, height: 900 },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const extErrors = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = sw.url().split('/')[2];

    const target = await ctx.newPage();
    await target.goto(base + 'violations.html');
    const ui = await ctx.newPage();
    ui.on('pageerror', (e) => extErrors.push(e.message));
    ui.on('console', (m) => { if (m.type() === 'error') extErrors.push(m.text()); });
    await ui.goto(`chrome-extension://${id}/panel/panel.html`);
    await ui.waitForSelector('#scan');

    const scan = await ui.evaluate(async (url) => {
      const m = await import('../ui/scan.js');
      const [tab] = await chrome.tabs.query({ url: url + '*' });
      const report = await m.scanTab(tab.id);
      const stored = await m.loadResults(tab.id);
      const badge = await chrome.action.getBadgeText({ tabId: tab.id });
      return { tabId: tab.id, report, stored: !!stored, badge };
    }, base + 'violations.html');
    const rep = scan.report;
    check('extension scan returns violations', rep.counts.violations > 40, `${rep.counts.violations} violations, ${rep.counts.review} review`);
    check('extension scan covers frames', rep.frames.length >= 1, `${rep.frames.length} frame(s), allFrames=${rep.allFrames}`);
    check('results are stored per tab', scan.stored);
    check('badge shows violation count', scan.badge === String(rep.counts.violations), scan.badge);

    // Overlays through the extension's page-call path
    const overlay = await ui.evaluate(async ({ tabId, ref }) => {
      const m = await import('../ui/scan.js');
      const hl = await m.pageCall(tabId, [0], 'highlight', [ref, 'Test']);
      const tab = await m.pageCall(tabId, [0], 'showTabOrder', []);
      const vis = await m.pageCall(tabId, [0], 'setVision', ['protanopia']);
      return { hl: hl[0].value, tab: tab[0].value.length, vis: vis[0].value };
    }, { tabId: scan.tabId, ref: rep.issues[0].ref });
    const hostExists = await target.evaluate(() => !!document.getElementById('__a11y-auditor-root'));
    const filter = await target.evaluate(() => document.documentElement.style.filter);
    check('highlight works from the extension', overlay.hl === true && hostExists);
    check('tab order works from the extension', overlay.tab > 5);
    check('colour filter works from the extension', overlay.vis === 'protanopia' && /protanopia/.test(filter));
    await ui.evaluate(async (tabId) => (await import('../ui/scan.js')).pageCall(tabId, [0], 'clear', []), scan.tabId);
    check('clear removes overlays', await target.evaluate(() => !document.getElementById('__a11y-auditor-root') && !document.documentElement.style.filter));

    // Render the results UI: copy the report to the panel's own tab key (its "active tab").
    await ui.evaluate(async (report) => {
      const m = await import('../ui/scan.js');
      const own = await m.activeTab();
      await m.saveResults(own.id, Object.assign({}, report, { tabId: own.id }));
    }, rep);
    await ui.waitForSelector('details.rule', { timeout: 5000 });
    const chips = await ui.locator('.chip').count();
    check('summary chips render', chips >= 4, `${chips} chips`);
    const groups = await ui.locator('details.rule').count();
    check('rule groups render', groups >= 20, `${groups} groups`);
    await ui.locator('details.rule summary').first().click();
    check('expanding a rule shows nodes with WCAG link', await ui.locator('details.rule[open] ol.nodes li').count() > 0 &&
      await ui.locator('details.rule[open] a[href*="WCAG22"]').count() > 0);
    await ui.fill('#search', 'contrast');
    const filtered = await ui.locator('details.rule').count();
    check('search filters rules', filtered >= 1 && filtered < groups, `${filtered} groups`);
    await ui.fill('#search', '');
    await ui.locator('.chip.critical').click();
    const crit = await ui.locator('#issues .pill').allTextContents();
    check('severity chip filters', crit.length > 0 && crit.every((t) => t === 'critical'), crit.slice(0, 5).join(','));
    await ui.locator('.chip.critical').click();
    await ui.selectOption('#group-by', 'rule');
    check('group by rule hides severity headings', await ui.locator('.group-h').count() === 0);
    await ui.click('#tab-structure');
    check('structure tab lists headings', await ui.locator('#structure ul.outline li').count() >= 3);
    await ui.click('#tab-tools');
    check('tools tab renders toggles', await ui.locator('#tools input.toggle').count() >= 6);
    await ui.click('#tab-issues');

    for (const [kind, re] of [['html', /<!doctype html>[\s\S]*Accessibility report/i], ['json', /"issues"/], ['csv', /^﻿?Impact,Type,Rule/]]) {
      const [dl] = await Promise.all([ui.waitForEvent('download'), ui.click(`[data-export="${kind}"]`)]);
      const file = await dl.path();
      const text = fs.readFileSync(file, 'utf8');
      check(`export ${kind.toUpperCase()}`, re.test(text) && /a11y-report-127\.0\.0\.1-/.test(dl.suggestedFilename()), dl.suggestedFilename());
      if (kind === 'json') {
        const j = JSON.parse(text);
        check('JSON export has all issues', j.issues.length === rep.issues.length);
      }
      if (kind === 'csv') check('CSV export has a row per issue', text.trim().split(/\r\n/).length === rep.issues.length + 1);
    }

    // Navigation marks results stale.
    await target.reload();
    await target.waitForTimeout(500);
    const stale = await ui.evaluate(async (tabId) => (await (await import('../ui/scan.js')).loadResults(tabId)).stale, scan.tabId);
    check('navigation marks results stale', stale === true);

    // Popup page renders.
    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => extErrors.push(e.message));
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForSelector('#scan');
    check('popup renders', await popup.locator('#tab-issues').count() === 1);
    check('extension pages had no errors', extErrors.length === 0, extErrors.join(' | '));
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
