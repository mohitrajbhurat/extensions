#!/usr/bin/env node
// End-to-end check for Research Canvas.
// Usage: node research-canvas/test/e2e.js   (needs Playwright, like tools/smoke-test.js)
//
// The real extension injects its content script through activeTab (toolbar click, menu or shortcut),
// which Playwright cannot trigger. The test therefore runs against a temporary copy that also has a
// host permission for the local test server, and injects with the same chrome.scripting call.
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

async function poll(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  return v;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-e2e-'));
  const ext = path.join(tmp, 'ext');
  copyDir(SRC, ext);
  const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

  const html = fs.readFileSync(path.join(SRC, 'test', 'test-page.html'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const URL_ = `http://127.0.0.1:${server.address().port}/article`;

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const errors = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = sw.url().split('/')[2];
    // Extension APIs are bound to the worker shortly after it starts.
    await poll(() => sw.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => false), 10000);
    const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
    const pageRec = async () => Object.entries(await storage()).find(([k]) => k.startsWith('page:'))?.[1];
    const clips = async () => Object.entries(await storage()).filter(([k]) => k.startsWith('clip:')).map(([, v]) => v);
    const inject = () => sw.evaluate(async u => {
      const [tab] = await chrome.tabs.query({ url: u });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      return tab.id;
    }, URL_);

    // Defaults are created on install.
    const projects = await poll(async () => Object.keys(await storage()).filter(k => k.startsWith('project:')).length);
    check('default Inbox project created', projects === 1);

    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror ' + e.message));
    await page.goto(URL_);
    await inject();

    const select = (sel, text) => page.evaluate(([sel, text]) => {
      const p = document.querySelector(sel);
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = text ? n.data.indexOf(text) : -1;
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i); r.setEnd(n, i + text.length);
          getSelection().removeAllRanges(); getSelection().addRange(r);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
          return true;
        }
      }
      // Selection across elements: whole element.
      const r = document.createRange();
      r.selectNodeContents(p);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      return false;
    }, [sel, text]);

    // 1. Highlight via the floating toolbar.
    await select('#p3', 'compile');
    await select('#p1', 'compile knowledge');
    await page.locator('rc-ui .toolbar button[aria-label="Highlight green"]').click();
    const hlText = await page.locator('#p1 rc-highlight').textContent();
    check('toolbar highlight wraps the selection', hlText === 'compile knowledge', hlText);
    let rec = await poll(async () => { const r = await pageRec(); return r && r.highlights.length ? r : null; });
    check('highlight persisted with quote + context', rec && rec.highlights[0].color === 'green' && rec.highlights[0].quote.prefix.endsWith('a way to ') && rec.highlights[0].position.start > 0);
    let cl = await poll(async () => (await clips()).find(c => c.type === 'highlight'));
    check('highlight added to the active project as a clip', cl && cl.content === 'compile knowledge' && cl.url === URL_);

    // 2. Comment and recolor through the popover.
    await page.locator('#p1 rc-highlight').click();
    await page.locator('rc-ui .pop textarea').fill('Key definition');
    await page.locator('rc-ui .pop button[aria-label="Change color to blue"]').click();
    await page.keyboard.press('Escape');
    rec = await poll(async () => { const r = await pageRec(); return r && r.highlights[0].comment === 'Key definition' && r.highlights[0].color === 'blue' ? r : null; });
    check('comment and recolor saved', !!rec);
    cl = await poll(async () => (await clips()).find(c => c.type === 'highlight' && c.comment === 'Key definition' && c.color === 'blue'));
    check('highlight clip kept in sync', !!cl);

    // 3. Sticky note.
    await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); await chrome.tabs.sendMessage(t.id, { type: 'rc:addSticky' }); }, URL_);
    await page.locator('rc-stickies textarea').fill('Remember to cite this');
    rec = await poll(async () => { const r = await pageRec(); return r && r.stickies[0] && r.stickies[0].text === 'Remember to cite this' ? r : null; });
    check('sticky note saved', !!rec);
    await page.locator('rc-stickies button[aria-label="Collapse note"]').click();
    rec = await poll(async () => { const r = await pageRec(); return r && r.stickies[0].collapsed ? r : null; });
    check('sticky collapse persisted', !!rec);
    const box = await page.locator('rc-stickies .head').boundingBox();
    const before = rec.stickies[0];
    await page.mouse.move(box.x + 20, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 70, { steps: 5 });
    await page.mouse.up();
    rec = await poll(async () => { const r = await pageRec(); return r && r.stickies[0].x === before.x + 100 && r.stickies[0].y === before.y + 60 ? r : null; });
    check('sticky drag persisted', !!rec);

    // 4. Clip a selection with formatting.
    await select('#p2', null); // whole paragraph, spanning the <em>
    await page.locator('rc-ui .toolbar button[aria-label="Clip selection to project"]').click();
    cl = await poll(async () => (await clips()).find(c => c.type === 'text'));
    check('selection clipped as Markdown', cl && cl.content.includes('*scrapbooks*'), cl && cl.content.slice(0, 60));

    // 5. Re-anchor after the page changed (new content above, same text elsewhere).
    await page.reload();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = 'An added intro that also mentions how people compile knowledge today.';
      document.body.insertBefore(p, document.body.firstChild);
    });
    await inject();
    const re = await poll(() => page.evaluate(() => {
      const m = document.querySelector('rc-highlight');
      return m && { inP1: !!m.closest('#p1'), text: m.textContent, count: document.querySelectorAll('rc-highlight').length };
    }));
    check('highlight re-anchored to the right occurrence', re && re.inP1 && re.text === 'compile knowledge' && re.count === 1, JSON.stringify(re));
    const sticky = await page.locator('rc-stickies .sticky.collapsed .title').textContent().catch(() => '');
    check('sticky note restored on revisit', sticky === 'Remember to cite this', sticky);

    // 6. Side panel (full-tab mode): clips, search, notes with wikilinks and backlinks, export/import.
    const app = await ctx.newPage();
    app.on('pageerror', e => errors.push('panel pageerror ' + e.message));
    app.on('console', m => { if (m.type() === 'error') errors.push('panel console ' + m.text()); });
    await app.goto(`chrome-extension://${id}/sidepanel/sidepanel.html?mode=tab`);
    await app.waitForSelector('.card');
    check('panel lists the project clips', (await app.locator('.card').count()) === 2);
    await app.fill('#searchInput', 'scrapbooks');
    const results = await poll(async () => app.locator('.result').count());
    check('search across everything finds the clip', results >= 1, String(results));
    await app.fill('#searchInput', 'cite');
    const stickyHit = await poll(async () => (await app.locator('.result').allTextContents()).some(t => t.includes('Sticky note')));
    check('search finds sticky notes', stickyHit);
    await app.fill('#searchInput', '');

    await app.evaluate(async () => {
      const send = m => chrome.runtime.sendMessage(m);
      await send({ type: 'clip:add', clip: { type: 'note', title: 'Alpha', content: 'Builds on [[Beta]] heavily.', tags: ['theory'] } });
      await send({ type: 'clip:add', clip: { type: 'note', title: 'Beta', content: '# Beta\nBase idea.' } });
    });
    await app.click('#tab-notes');
    await app.locator('.note-item .t', { hasText: /^Beta$/ }).click();
    const back = await poll(async () => (await app.locator('.backlink').allTextContents()).join('|'));
    check('backlinks show the linking note', back.includes('Alpha'), back);
    await app.locator('.note-item .t', { hasText: /^Alpha$/ }).click();
    const seg = app.locator('.seg button', { hasText: /Preview/i });
    if (await seg.count()) await seg.first().click();
    const wl = await poll(async () => app.locator('.preview a.wikilink[data-wikilink="Beta"]').count());
    check('wikilink rendered in preview', wl >= 1);

    const exported = await app.evaluate(async () => (await import('/lib/store.js')).exportJSON());
    check('JSON export includes everything', exported.projects.length === 1 && exported.clips.length === 4 && exported.pages[0].highlights.length === 1 && exported.pages[0].stickies.length === 1);
    exported.projects[0] = { ...exported.projects[0], id: 'imported', name: 'Imported', updatedAt: Date.now() };
    exported.clips = exported.clips.map(c => ({ ...c, id: 'i' + c.id, projectId: 'imported' }));
    const imp = await app.evaluate(async data => chrome.runtime.sendMessage({ type: 'import', data }), exported);
    check('JSON import merges a project', imp.ok && imp.stats.projects === 1 && imp.stats.clips === 4, JSON.stringify(imp.stats));
    const bad = await app.evaluate(async () => chrome.runtime.sendMessage({ type: 'import', data: { hello: 1 } }));
    check('import rejects foreign JSON', !bad.ok && /not a Research Canvas export/.test(bad.error));

    // 7. Deleting a highlight removes its clip.
    await page.locator('#p1 rc-highlight').click();
    await page.locator('rc-ui .pop button[aria-label="Delete highlight"]').click();
    rec = await poll(async () => { const r = await pageRec(); return r && r.highlights.length === 0 ? r : null; });
    const hlClips = (await clips()).filter(c => c.type === 'highlight' && c.projectId !== 'imported');
    check('highlight deleted with its clip', !!rec && hlClips.length === 0 && (await page.locator('rc-highlight').count()) === 0);

    check('no page errors', errors.length === 0, errors.join(' / '));
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
