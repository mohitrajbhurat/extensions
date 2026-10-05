#!/usr/bin/env node
// Functional test for Point-and-Click Scraper. Usage: node page-scraper/test/run-tests.js
// Copies the extension to a temp dir with <all_urls> host access (so the test can inject the
// content scripts from the service worker, as the popup does with activeTab), serves the test
// pages locally, and drives detection, manual picking, pagination and the results viewer.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const PORT = 8765 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); }

function copyExt() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ext-'));
  fs.cpSync(SRC, dst, { recursive: true, filter: (p) => !p.includes(`${path.sep}test${path.sep}`) && !p.endsWith(`${path.sep}test`) });
  const m = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  m.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(m, null, 2));
  return dst;
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: __dirname, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const ext = copyExt();
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-prof-')), {
    headless: true, channel: 'chromium', viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const pageErrors = [];

  async function open(file) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${file}: ${e.message}`));
    await page.goto(`${BASE}/${file}`);
    return page;
  }
  async function inject(page, message) {
    const url = page.url();
    await sw.evaluate(async ({ url, message }) => {
      const [t] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/core.js', 'content/panel.js'] });
      await chrome.tabs.sendMessage(t.id, message);
    }, { url, message });
    await page.waitForTimeout(600);
  }
  const ui = (page, sel) => page.locator('page-scraper-ui').locator(sel);
  async function previewHeaders(page) { return ui(page, '#preview th').allInnerTexts(); }
  async function waitResults() {
    const p = await ctx.waitForEvent('page', { predicate: (pg) => pg.url().includes('results/results.html'), timeout: 30000 });
    await p.waitForLoadState();
    await p.waitForSelector('#tbody tr', { timeout: 10000 });
    return p;
  }

  try {
    // 1. Table detection
    {
      const page = await open('table.html');
      await inject(page, { type: 'ps:open', action: 'detect' });
      const label = await ui(page, '#candLabel').innerText();
      check('table: best candidate is the table', /^Table: 25 rows/.test(label), label);
      const heads = await previewHeaders(page);
      check('table: header names used as columns', ['ID', 'Name', 'Name link', 'City', 'Age', 'Salary'].every((h) => heads.includes(h)), heads.join(','));
      const firstRow = await ui(page, '#preview tbody tr').first().locator('td').allInnerTexts();
      check('table: first row extracted', firstRow[1] === '1' && firstRow.includes('Person 1') && firstRow.some((v) => v.endsWith('/people/1')), firstRow.join(' | '));
      const boxes = await ui(page, '.layer .box').evaluateAll((els) => els.filter((e) => e.style.display !== 'none').length);
      check('table: matches outlined on the page', boxes >= 10, `${boxes} boxes`);
      // Cycle candidates
      await ui(page, '#candNext').click();
      const second = await ui(page, '#candSub').innerText();
      check('table: can cycle candidates', /Candidate 2 of/.test(second), second);
      await ui(page, '#candPrev').click();
      // Scrape single page and check results viewer
      const [res] = await Promise.all([waitResults(), ui(page, '#scrapeBtn').click()]);
      const rows = await res.locator('#tbody tr').count();
      check('table: results viewer shows 25 rows', rows === 25, `${rows}`);
      // Sorting by Age descending (numeric)
      const ageBtn = res.locator('th button.h', { hasText: /^Age/ });
      await ageBtn.click(); await ageBtn.click();
      const ages = await res.locator('#tbody tr').evaluateAll((trs, idx) => trs.map((tr) => +tr.children[idx].textContent), await res.locator('th').evaluateAll((ths) => ths.findIndex((t) => t.textContent.trim().startsWith('Age'))));
      check('results: numeric sort descending', ages.every((v, i) => i === 0 || ages[i - 1] >= v), ages.slice(0, 5).join(','));
      // Column reorder via keyboard
      const before = await res.locator('th button.h').allInnerTexts();
      await ageBtn.focus(); await res.keyboard.press('Alt+ArrowLeft');
      const after = await res.locator('th button.h').allInnerTexts();
      check('results: keyboard column reorder', before.findIndex((t) => t.startsWith('Age')) - 1 === after.findIndex((t) => t.startsWith('Age')), after.join(','));
      // Exports
      await res.locator('#exportBtn').click();
      const [dl] = await Promise.all([res.waitForEvent('download'), res.locator('[data-export="excel"]').click()]);
      const buf = fs.readFileSync(await dl.path());
      check('export: Excel CSV has UTF-8 BOM and header', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf && buf.toString('utf8').includes('ID,Name'), buf.toString('utf8').slice(1, 50).replace(/\r?\n/g, '⏎'));
      await res.locator('#exportBtn').click();
      const [dj] = await Promise.all([res.waitForEvent('download'), res.locator('[data-export="json"]').click()]);
      const json = JSON.parse(fs.readFileSync(await dj.path(), 'utf8'));
      check('export: JSON array of 25 objects', Array.isArray(json) && json.length === 25 && 'City' in json[0]);
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(res.url()).origin });
      await res.locator('#copyTsv').click();
      await res.waitForTimeout(300);
      const clip = await res.evaluate(() => navigator.clipboard.readText());
      check('export: TSV copied to clipboard', clip.split('\n').length === 26 && clip.split('\n')[0].includes('\t'), clip.split('\n')[0]);
      await res.close(); await page.close();
    }

    // 2. Card grid detection + link pagination (fetched in background) + recipe save
    {
      const page = await open('cards-1.html');
      await inject(page, { type: 'ps:open', action: 'detect' });
      const label = await ui(page, '#candLabel').innerText();
      check('cards: best candidate is the product grid', /12 items/.test(label) && /card/.test(label), label);
      const heads = await previewHeaders(page);
      check('cards: inferred title/price/image/link columns', heads.some((h) => /title/i.test(h)) && heads.some((h) => /price/i.test(h)) && heads.some((h) => /image/i.test(h)) && heads.some((h) => /link/i.test(h)), heads.join(','));
      check('cards: constant "Add to cart" column dropped', !heads.some((h) => /button|add/i.test(h)));
      // Rename + delete a column live
      const firstName = ui(page, '#cols .col input[data-f="name"]').first();
      await firstName.fill('Product URL');
      const renamed = await previewHeaders(page);
      check('cards: rename column updates preview', renamed.includes('Product URL'), renamed.join(','));
      const nCols = await ui(page, '#cols .col').count();
      await ui(page, '#cols .col button[data-a="del"]').last().click();
      check('cards: delete column', (await ui(page, '#cols .col').count()) === nCols - 1);
      // Pagination
      await ui(page, '#pgMode').selectOption('next');
      await ui(page, '#pickNext').click();
      await page.locator('a.next-link').click();
      const info = await ui(page, '#nextInfo').innerText();
      check('cards: next button taught by clicking', /Next/.test(info) && /Found/.test(info), info);
      await ui(page, '#maxPages').fill('5'); await ui(page, '#maxPages').dispatchEvent('change');
      await ui(page, '#delay').fill('0.2'); await ui(page, '#delay').dispatchEvent('change');
      await ui(page, '#recipeName').fill('Catalog test');
      await ui(page, '#saveRecipe').click();
      await page.waitForTimeout(300);
      const recipes = await sw.evaluate(async () => (await chrome.storage.local.get('recipes')).recipes);
      check('recipes: saved with selectors and pagination', recipes.length === 1 && recipes[0].pagination.mode === 'next' && recipes[0].pagination.next && recipes[0].host.startsWith('127.0.0.1'));
      const [res] = await Promise.all([waitResults(), ui(page, '#scrapeBtn').click()]);
      await res.waitForTimeout(300);
      const rows = await res.locator('#tbody tr').count();
      check('cards: crawled 3 pages = 36 rows', rows === 36, `${rows}`);
      const meta = await res.locator('#meta').innerText();
      check('cards: results meta shows 3 pages', /3 pages/.test(meta), meta);
      const lastTitle = await res.locator('#tbody').innerText();
      check('cards: page 3 data present', lastTitle.includes('Product 036'));
      check('cards: still on page 1 (background fetch)', page.url().endsWith('cards-1.html'));
      // Re-run the saved recipe: dedupe must keep counts stable within one run
      await res.close();
      await inject(page, { type: 'ps:open', action: 'recipe', recipe: recipes[0], run: true });
      const res2 = await waitResults();
      await res2.waitForTimeout(300);
      check('recipes: re-run from saved recipe gives 36 rows', (await res2.locator('#tbody tr').count()) === 36);
      await res2.close(); await page.close();
    }

    // 3. Manual point-and-click + add column by clicking
    {
      const page = await open('cards-2.html');
      await inject(page, { type: 'ps:open', action: 'manual' });
      await page.locator('.price').nth(3).hover();
      await page.locator('.price').nth(3).click();
      const lvl = await ui(page, '#levelInfo').innerText();
      check('manual: click on a price generalizes to the 12 cards', /^12 matches/.test(lvl) && /div/.test(lvl), lvl);
      check('manual: page click was not followed', page.url().endsWith('cards-2.html'));
      await ui(page, '#clearCols').click();
      await ui(page, '#addCol').click();
      await page.locator('.product-title a').nth(5).click();
      await ui(page, '#addCol').click();
      await page.locator('.stock').nth(0).click();
      const heads = await previewHeaders(page);
      check('manual: columns added by clicking', heads.length === 3 && /title/i.test(heads[1]) && /stock/i.test(heads[2]), heads.join(','));
      await ui(page, '#chips button[data-chip]').first().waitFor({ timeout: 2000 }).catch(() => {});
      // add href of title via type switch
      await ui(page, '#cols .col select').first().selectOption('href');
      const cell = await ui(page, '#preview tbody tr').first().locator('td').nth(1).innerText();
      check('manual: switch column type to Link URL', /\/products\/13$/.test(cell), cell);
      // Wider / narrower
      await ui(page, '#wider').click();
      const wider = await ui(page, '#levelInfo').innerText();
      check('manual: wider selects container level', !/^12 matches/.test(wider), wider);
      await ui(page, '#narrower').click();
      await page.close();
    }

    // 4. Load more button (same-document click pagination)
    {
      const page = await open('loadmore.html');
      await inject(page, { type: 'ps:open', action: 'detect' });
      const label = await ui(page, '#candLabel').innerText();
      check('loadmore: detects article list', /10 items/.test(label), label);
      await ui(page, '#pgMode').selectOption('next');
      await ui(page, '#autoNext').click();
      await ui(page, '#maxPages').fill('10'); await ui(page, '#maxPages').dispatchEvent('change');
      await ui(page, '#delay').fill('0.2'); await ui(page, '#delay').dispatchEvent('change');
      const [res] = await Promise.all([waitResults(), ui(page, '#scrapeBtn').click()]);
      await res.waitForTimeout(300);
      const rows = await res.locator('#tbody tr').count();
      check('loadmore: clicked "Load more" until done, 35 unique rows', rows === 35, `${rows}`);
      await res.close(); await page.close();
    }

    // 5. Recipe import/export round trip in the manager page
    {
      const id = sw.url().split('/')[2];
      const page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(`manager: ${e.message}`));
      await page.goto(`chrome-extension://${id}/manager/manager.html`);
      await page.waitForSelector('#recipeRows tr');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportAll').click()]);
      const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
      check('manager: export recipes JSON', data.format === 'page-scraper-recipes' && data.recipes.length === 1);
      data.recipes[0].id = 'imported1'; data.recipes[0].name = 'Imported copy';
      const tmp = path.join(os.tmpdir(), 'ps-import.json'); fs.writeFileSync(tmp, JSON.stringify(data));
      await page.locator('#importFile').setInputFiles(tmp);
      await page.waitForTimeout(500);
      const count = await page.locator('#recipeRows tr').count();
      check('manager: import recipes JSON', count === 2, `${count}`);
      await page.locator('#tabResults').click();
      const resCount = await page.locator('#resultRows tr').count();
      check('manager: results history listed', resCount >= 4, `${resCount}`);
      await page.close();
    }
  } catch (e) {
    check('unexpected error', false, e.stack || String(e));
  }
  check('no page errors', pageErrors.length === 0, pageErrors.join(' / '));
  await ctx.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
