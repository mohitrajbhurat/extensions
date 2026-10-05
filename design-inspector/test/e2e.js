#!/usr/bin/env node
// End-to-end checks for Design Inspector with Playwright.
// Usage: node design-inspector/test/e2e.js
//
// The extension is copied to a temp folder with an added "<all_urls>" host permission,
// because tests cannot click the toolbar button to grant activeTab. Everything else is
// the shipped code. The system EyeDropper cannot be driven headless, so the screenshot
// loupe fallback is tested instead.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixture);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inspector-ext-'));
  fs.cpSync(SRC, ext, { recursive: true, filter: p => !p.includes(`${path.sep}test${path.sep}`) && !p.endsWith(`${path.sep}test`) });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inspector-profile-'));
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inspector-dl-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const errors = [];
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');

  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') });
  const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, base);
  const inject = () => sw.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/boot.js'] }), tabId);
  const ui = sel => page.locator(`design-inspector-ui ${sel}`);
  const center = async sel => {
    const b = await page.locator(sel).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  try {
    // ---- activation
    await inject();
    await ui('.bar').waitFor({ timeout: 5000 });
    check('toolbar appears in shadow DOM', await ui('.bar [data-tool="inspect"]').isVisible());
    check('inspect mode is on by default', (await ui('[data-tool="inspect"]').getAttribute('aria-pressed')) === 'true');
    const isShadow = await page.evaluate(() => !!document.querySelector('design-inspector-ui').shadowRoot);
    check('UI lives in a shadow root', isShadow);

    // ---- inspect hover
    const c1 = await center('#card');
    await page.mouse.move(c1.x, c1.y);
    await ui('.tip').waitFor({ timeout: 2000 });
    const tip = await ui('.tip').innerText();
    check('hover tooltip shows tag and size', tip.includes('div#card.card') && tip.includes('200 × 100'), tip.replace(/\n/g, ' | '));
    check('hover tooltip shows font size / line height', tip.includes('16px / 24px'));
    check('box model overlay drawn', (await ui('.box-padding').count()) === 1 && (await ui('.box-content').count()) === 1);

    // ---- click to pin (and page click suppressed)
    await page.mouse.click(c1.x, c1.y);
    await ui('.panel[data-owner="inspect"]').waitFor({ timeout: 2000 });
    const panelText = (await ui('.panel').innerText()).toLowerCase();
    check('pinned card shows grouped CSS', panelText.includes('layout & box') && panelText.includes('padding') && panelText.includes('16px') && panelText.includes('border-radius'));
    check('pinned card shows contrast', /\d+\.\d\d:1/.test(panelText));
    await ui('.panel-foot button:has-text("Copy CSS")').click();
    await sleep(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('Copy CSS puts a rule on the clipboard', clip.startsWith('#card {') && clip.includes('border: 2px solid #e5e7eb'), clip.split('\n')[0]);
    const lk = await center('#link');
    await page.mouse.click(lk.x, lk.y);
    await sleep(150);
    check('page links do not navigate while inspecting', !(await page.evaluate(() => location.hash)));
    // re-pin the card
    await page.mouse.click(c1.x, c1.y);

    // ---- Alt measure from pinned element
    const c2 = await center('#card2');
    await page.mouse.move(c2.x, c2.y);
    await page.keyboard.down('Alt');
    await page.mouse.move(c2.x + 1, c2.y);
    await sleep(120);
    const altLabels = await ui('.mlabel').allInnerTexts();
    await page.keyboard.up('Alt');
    check('Alt shows distance between pinned and hovered', altLabels.includes('24'), altLabels.join(','));

    // ---- Measure mode
    await page.keyboard.press('m');
    check('measure mode toggles on', (await ui('[data-tool="measure"]').getAttribute('aria-pressed')) === 'true');
    const sw1 = await center('#swatch');
    await page.mouse.click(c1.x, c1.y);
    await page.mouse.move(sw1.x, sw1.y);
    await sleep(120);
    const mLabels = await ui('.mlabel').allInnerTexts();
    check('measure mode distance card -> swatch', mLabels.includes('248'), mLabels.join(','));

    // ---- Rulers & guides
    await page.keyboard.press('r');
    check('rulers visible', await ui('.ruler-h').isVisible());
    await page.mouse.move(400, 6);
    await page.mouse.down();
    await page.mouse.move(400, 150, { steps: 5 });
    await page.mouse.move(400, 200, { steps: 5 });
    await page.mouse.up();
    const guidePos = await ui('.guide-h').getAttribute('data-pos').catch(() => null);
    check('dragging from ruler creates a guide', guidePos === '200', String(guidePos));
    await ui('.guide-h').dblclick();
    check('double-click removes guide', (await ui('.guide-h').count()) === 0);
    await page.keyboard.press('r');
    await page.keyboard.press('m');

    // ---- Eyedropper (loupe fallback) + formats + history
    await sw.evaluate(() => chrome.storage.local.set({ 'di.colors': { useLoupe: true, history: [], fg: '#1f2937', bg: '#ffffff' } }));
    await page.bringToFront();
    await page.keyboard.press('c');
    await ui('[data-di-loupe]').waitFor({ timeout: 5000 });
    await page.mouse.move(sw1.x - 10, sw1.y);
    await page.mouse.move(sw1.x, sw1.y, { steps: 3 });
    const loupeLabel = await ui('.loupe-label').innerText();
    check('loupe shows color under cursor', loupeLabel.startsWith('#ff6600'), loupeLabel);
    await page.mouse.click(sw1.x, sw1.y);
    await ui('.panel[data-owner="colors"]').waitFor({ timeout: 3000 });
    const colorsText = await ui('.panel').innerText();
    check('picked color in HEX/RGB/HSL/OKLCH', colorsText.includes('#ff6600') && colorsText.includes('rgb(255 102 0)') && colorsText.includes('hsl(24 100% 50%)') && /oklch\(\d/.test(colorsText));
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('di.colors'))['di.colors'].history);
    check('picked color saved to history', stored[0] === '#ff6600', JSON.stringify(stored));

    // ---- Contrast checker
    const fgInput = ui('input[aria-label="Text color"]');
    await fgInput.fill('#777777');
    const bgInput = ui('input[aria-label="Background color"]');
    await bgInput.fill('#ffffff');
    const ratio = await ui('.bigratio[data-ratio]').getAttribute('data-ratio');
    check('contrast ratio #777 on #fff = 4.48', ratio === '4.48', ratio);
    const pills = await ui('.panel .pill').allInnerTexts();
    check('WCAG verdicts (AA normal fails, AA large passes)', pills.some(p => p.includes('✕ AA normal')) && pills.some(p => p.includes('✓ AA large')), pills.join(' '));
    check('suggests nearest passing color', (await ui('.panel').innerText()).includes('Nearest AA text color'));
    await page.keyboard.press('Escape');

    // ---- Palette & typography
    await page.mouse.move(5, 790);
    await page.keyboard.press('p');
    await ui('.panel[data-owner="tokens"] .swatch').first().waitFor({ timeout: 5000 });
    const swatches = await ui('.panel .swatch').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check('palette includes brand color', swatches.some(s => s.startsWith('#ff6600')), swatches.slice(0, 6).join(' | '));
    check('declared CSS variables listed', (await ui('.panel').innerText()).includes('--brand'));
    await ui('.tabs [data-tab="type"]').click();
    const typeText = await ui('.panel').innerText();
    check('type tab lists sizes & styles', typeText.includes('32px') && typeText.includes('16px') && typeText.includes('Font families'));
    await ui('.tabs [data-tab="spacing"]').click();
    check('spacing tab detects 8px grid', (await ui('.panel').innerText()).includes('8px grid'));
    await ui('.tabs [data-tab="export"]').click();
    const cssOut = await ui('.panel textarea').inputValue();
    check('export CSS variables', cssOut.includes(':root {') && /--color-orange-\d+: #ff6600;/.test(cssOut) && cssOut.includes('--text-base: 16px;'), cssOut.split('\n').slice(0, 4).join(' '));
    await ui('.panel select[aria-label="Export format"]').selectOption('json');
    const jsonOut = await ui('.panel textarea').inputValue();
    let parsed = null;
    try { parsed = JSON.parse(jsonOut); } catch {}
    check('export DTCG JSON tokens', parsed && parsed.color && Object.values(parsed.color).some(v => v.$value === '#ff6600' && v.$type === 'color'));
    await ui('.panel select[aria-label="Export format"]').selectOption('tailwind');
    const twOut = await ui('.panel textarea').inputValue();
    check('export Tailwind config', twOut.includes('module.exports = {') && twOut.includes('borderRadius'));
    await page.keyboard.press('p');

    // ---- Live edit
    await page.keyboard.press('e');
    await ui('.panel[data-owner="edit"]').waitFor({ timeout: 2000 });
    const t = await center('#title');
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(100);
    const mbBefore = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('title')).marginBottom));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowLeft');
    const after = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('title'));
      return { mb: parseFloat(cs.marginBottom), pl: parseFloat(cs.paddingLeft) };
    });
    check('arrow keys nudge margin, Shift+arrow nudges padding', after.mb === mbBefore + 2 && after.pl === 1, JSON.stringify(after));
    await ui('input[aria-label="Text color picker"]').evaluate(el => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const titleColor = await page.evaluate(() => getComputedStyle(document.getElementById('title')).color);
    check('color change applies live', titleColor === 'rgb(255, 0, 0)', titleColor);
    await ui('input[aria-label="Font family"]').fill('Courier New, monospace');
    const fam = await page.evaluate(() => getComputedStyle(document.getElementById('title')).fontFamily);
    check('font change applies live', fam.includes('Courier New'), fam);
    await ui('.panel button:has-text("Edit text")').click();
    await page.keyboard.type(' edited');
    await page.keyboard.press('Escape');
    const title = await page.evaluate(() => document.getElementById('title').textContent);
    check('text can be edited in place', title === 'Design fixture edited', title);
    const out = await ui('textarea[aria-label="Resulting CSS"]').inputValue();
    check('resulting CSS lists edits', out.includes('#title {') && out.includes('margin-bottom: 26px;') && out.includes('color: #ff0000;') && out.includes('Text in #title'), out.replace(/\n/g, ' '));
    await ui('.panel-foot button:has-text("Reset all")').click();
    const reset = await page.evaluate(() => ({ text: document.getElementById('title').textContent, style: document.getElementById('title').getAttribute('style') || '' }));
    check('reset all restores the page', reset.text === 'Design fixture' && reset.style === '', JSON.stringify(reset));
    await page.keyboard.press('Escape');
    await page.keyboard.press('e');

    // ---- Assets
    await page.keyboard.press('a');
    await ui('.panel[data-owner="assets"] .item').first().waitFor({ timeout: 3000 });
    const kinds = await ui('.panel .item').evaluateAll(els => els.map(e => e.dataset.kind));
    check('assets: image, inline SVG, background, icon', ['image', 'inline-svg', 'background', 'icon'].every(k => kinds.includes(k)), kinds.join(','));
    await ui('.tabs [data-filter="svg"]').click();
    const svgCount = await ui('.panel .item').count();
    check('SVG filter', svgCount >= 3, String(svgCount));
    await ui('.panel .item[data-kind="inline-svg"] button[aria-label^="Download"]').first().click();
    let dl = [];
    for (let i = 0; i < 20 && !dl.length; i++) {
      await sleep(150);
      dl = await sw.evaluate(() => chrome.downloads.search({}));
    }
    // Playwright stores downloads under GUID names, so check the request and its state.
    check('download via downloads API', dl.length > 0 && dl[0].url.startsWith('data:image/svg+xml') && dl[0].state !== 'interrupted' && !dl[0].error, dl[0] && `${dl[0].state} ${dl[0].error || ''}`);

    // ---- Close & toggle
    for (let i = 0; i < 4; i++) await page.keyboard.press('Escape');
    check('Esc chain closes the inspector', (await page.locator('design-inspector-ui').count()) === 0);
    await inject();
    await ui('.bar').waitFor({ timeout: 3000 });
    check('toolbar button reopens', (await page.locator('design-inspector-ui').count()) === 1);
    await inject();
    await sleep(100);
    check('toolbar button toggles off', (await page.locator('design-inspector-ui').count()) === 0);
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('unexpected exception', false, e && e.stack);
  } finally {
    await ctx.close();
    server.close();
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
