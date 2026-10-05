#!/usr/bin/env node
// End-to-end check with Playwright (same setup as tools/smoke-test.js).
//   python3 -m http.server 8843 --directory citation-builder/test/fixtures &
//   node citation-builder/test/e2e-check.cjs
// 1) runs the page extractor inside real fixture pages and normalizes the result,
// 2) drives the popup (via the pending hand-off used by the context menu) and saves a citation,
// 3) checks the bibliography manager renders, detects duplicates and exports.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const dir = path.resolve(__dirname, '..');
const BASE = process.env.FIXTURE_BASE || 'http://127.0.0.1:8843';

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ok -', msg);
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium', acceptDownloads: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const errors = [];
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];
  const ext = p => `chrome-extension://${id}/${p}`;

  // ---- 1. extraction on fixture pages
  const { collectPageData } = await import(path.join(dir, 'lib/extract-page.js'));
  const { normalizePage } = await import(path.join(dir, 'lib/normalize.js'));
  const page = await ctx.newPage();
  const extract = async url => {
    await page.goto(url);
    const raw = await page.evaluate(`(${collectPageData.toString()})()`);
    return normalizePage(raw);
  };
  console.log('extraction');
  let r = await extract(`${BASE}/article.html`);
  assert(r.item.type === 'article-journal', 'Highwire fixture is a journal article');
  assert(r.item.authors.length === 3 && r.item.authors[2].family === 'Parmar', 'three authors parsed');
  assert(r.item.doi === '10.5555/3295222.3295349', 'DOI from citation_doi');
  assert(r.item.pages === '5998-6008', 'page range');
  r = await extract(`${BASE}/news.html`);
  assert(r.item.title === 'How Bees Navigate Cities' && r.item.authors.length === 2, 'JSON-LD news article');
  assert(r.item.date === '2023-06-14', 'JSON-LD date');
  r = await extract(`${BASE}/dublin-core.html`);
  assert(r.item.doi === '10.3929/ethz-b-000123456' && r.item.authors[1].family === 'Brunner', 'Dublin Core');

  // ---- 2. popup via pending hand-off
  console.log('popup');
  const article = (await extract(`${BASE}/article.html`)).item;
  await sw.evaluate(async item => { await chrome.storage.local.set({ pending: { item, sources: ['Highwire meta'], at: Date.now() } }); }, article);
  const popup = await ctx.newPage();
  popup.on('pageerror', e => errors.push('popup: ' + e.message));
  popup.on('console', m => { if (m.type() === 'error') errors.push('popup: ' + m.text()); });
  await popup.goto(ext('popup/popup.html'));
  await popup.waitForSelector('#preview i');
  const preview = await popup.textContent('#preview');
  assert(preview.startsWith('Vaswani, A., Shazeer, N., & Parmar, N. (2017). Attention is all you need.'), 'APA preview: ' + preview.slice(0, 60));
  await popup.selectOption('#style', 'mla');
  await popup.waitForFunction(() => document.querySelector('#preview').textContent.includes('et al.'));
  assert((await popup.textContent('#intext')) === '(Vaswani et al.)', 'MLA in-text');
  await popup.fill('#pf-title', 'Attention Is All You Need Again');
  await popup.waitForFunction(() => document.querySelector('#preview').textContent.includes('Again'));
  assert(true, 'editing updates the preview live');
  await popup.click('#save');
  await popup.waitForFunction(() => document.querySelector('#save').textContent === 'Update');
  assert(true, 'saved to project');
  await popup.click('#pf-authors-add');
  await popup.fill('#pf-authors-3-given', 'Ada');
  await popup.fill('#pf-authors-3-family', 'Lovelace');
  await popup.waitForFunction(() => document.querySelector('#preview').textContent.includes('Vaswani, Ashish, et al.'));
  assert(true, 'added author row');

  // second save of a duplicate (same DOI) into the same project via a fresh popup
  await sw.evaluate(async item => { await chrome.storage.local.set({ pending: { item, at: Date.now() } }); }, article);
  const popup2 = await ctx.newPage();
  await popup2.goto(ext('popup/popup.html'));
  await popup2.waitForSelector('#dup-warning:not([hidden])');
  assert(true, 'popup warns about a duplicate before saving');
  await popup2.click('#save');
  await popup2.waitForFunction(() => document.querySelector('#save').textContent === 'Update');

  // ---- 3. manager
  console.log('manager');
  const mgr = await ctx.newPage();
  mgr.on('pageerror', e => errors.push('manager: ' + e.message));
  mgr.on('console', m => { if (m.type() === 'error') errors.push('manager: ' + m.text()); });
  await mgr.goto(ext('manager/manager.html'));
  await mgr.waitForSelector('.entry');
  assert((await mgr.$$('.entry')).length === 2, 'two entries listed');
  assert(await mgr.isVisible('#dup-filter'), 'duplicate badge shown');
  await mgr.selectOption('#style', 'ieee');
  await mgr.waitForFunction(() => document.querySelector('.entry .citation').textContent.startsWith('[1]'));
  assert(true, 'IEEE numbering in manager');
  const [dl] = await Promise.all([
    mgr.waitForEvent('download'),
    (async () => { await mgr.click('#export-btn'); await mgr.click('[data-export="bib"]'); })(),
  ]);
  const bib = fs.readFileSync(await dl.path(), 'utf8');
  assert(/@article\{vaswani2017attention,/.test(bib) && /@article\{vaswani2017attentionb,/.test(bib), 'BibTeX export with unique keys');
  const [dl2] = await Promise.all([
    mgr.waitForEvent('download'),
    (async () => { await mgr.click('#export-btn'); await mgr.click('[data-export="html"]'); })(),
  ]);
  assert(/<h1>References<\/h1>/.test(fs.readFileSync(await dl2.path(), 'utf8')), 'HTML export');
  // edit through dialog
  await mgr.click('.entry [data-act="edit"]');
  await mgr.waitForSelector('#edit-dialog[open]');
  await mgr.fill('#me-volume', '31');
  await mgr.click('#edit-save');
  await mgr.waitForFunction(() => [...document.querySelectorAll('.entry .citation')].some(e => e.textContent.includes('vol. 31')));
  assert(true, 'edit dialog saves changes');
  // delete with undo
  await mgr.click('.entry [data-menu]');
  await mgr.click('.entry .menu:not([hidden]) [data-act="delete"]');
  await mgr.waitForFunction(() => document.querySelectorAll('.entry').length === 1);
  await mgr.click('#toast button');
  await mgr.waitForFunction(() => document.querySelectorAll('.entry').length === 2);
  assert(true, 'delete and undo');
  // add by hand with DOI (offline)
  await mgr.click('#add');
  await mgr.fill('#quick-id', 'https://doi.org/10.1038/nature14539');
  await mgr.click('#quick-go');
  await mgr.fill('#me-title', 'Deep learning');
  await mgr.click('#edit-save');
  await mgr.waitForFunction(() => document.querySelectorAll('.entry').length === 3);
  assert(true, 'manual add with DOI');

  await ctx.close();
  if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
  console.log('E2E PASS');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
