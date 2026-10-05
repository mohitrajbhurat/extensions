#!/usr/bin/env node
// Loads an unpacked extension in headless Chromium, checks the service worker starts
// without errors, opens each extension page listed in the manifest and reports console errors.
// Usage: node tools/smoke-test.js <extension-folder> [extra-page.html ...]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

(async () => {
  const dir = path.resolve(process.argv[2] || '.');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const errors = [];
  let id;
  if (manifest.background && manifest.background.service_worker) {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    id = sw.url().split('/')[2];
  } else {
    // No service worker: find the id from chrome://extensions is not possible headless, so require one.
    console.error('FAIL: smoke test expects a background service worker');
    process.exit(1);
  }
  const pages = new Set();
  if (manifest.action && manifest.action.default_popup) pages.add(manifest.action.default_popup);
  if (manifest.options_page) pages.add(manifest.options_page);
  if (manifest.options_ui && manifest.options_ui.page) pages.add(manifest.options_ui.page);
  if (manifest.side_panel && manifest.side_panel.default_path) pages.add(manifest.side_panel.default_path);
  for (const k of ['newtab', 'history', 'bookmarks']) if (manifest.chrome_url_overrides && manifest.chrome_url_overrides[k]) pages.add(manifest.chrome_url_overrides[k]);
  for (const extra of process.argv.slice(3)) pages.add(extra);
  for (const p of pages) {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${p}: pageerror ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${p}: console ${m.text()}`); });
    await page.goto(`chrome-extension://${id}/${p}`);
    await page.waitForTimeout(800);
    console.log(`opened ${p} (title: ${await page.title()})`);
    await page.close();
  }
  await ctx.close();
  if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
  console.log(`PASS ${manifest.name} (${id})`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
