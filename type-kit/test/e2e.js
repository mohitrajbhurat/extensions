#!/usr/bin/env node
// End-to-end check for Type Kit: loads the extension in Chromium (Playwright, like
// tools/smoke-test.js), serves test/fixture.html locally and drives the content script.
// Usage: node type-kit/test/e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''}`);
  if (!ok) failures++;
}
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

(async () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/fixture.html`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let browserClosed = false;
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    const errors = [];
    // Make sure starter data exists, then add two snippets that share a prefix.
    await sw.evaluate(async () => {
      await self.TKStore.loadAll();
      await self.TKStore.upsertSnippet({ name: 'Bye', shortcut: '/bye', body: 'Goodbye!' });
      await self.TKStore.upsertSnippet({ name: 'Bye bye', shortcut: '/byebye', body: 'Bye for now!' });
      await self.TKStore.upsertSnippet({ name: 'Rich', shortcut: '/rich', format: 'rich', body: '<b>Bold</b> and {cursor}<i>end</i>' });
    });
    await new Promise((r) => setTimeout(r, 300));
    for (const p of ctx.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => {});

    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.bringToFront();
    await page.waitForTimeout(600);
    const val = (sel) => page.$eval(sel, (el) => el.value);
    const delay = { delay: 25 };

    // 1. input expansion + Backspace undo
    await page.click('#plain');
    await page.keyboard.type('Hello ;addr', delay);
    await page.waitForTimeout(250);
    check('expands ;addr in <input> (newlines flattened)', (await val('#plain')) === 'Hello 100 Congress Ave Austin, TX 78701 United States', await val('#plain'));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    check('Backspace right after restores the shortcut', (await val('#plain')) === 'Hello ;addr', await val('#plain'));
    await page.keyboard.press('Backspace');
    check('second Backspace deletes normally', (await val('#plain')) === 'Hello ;add', await val('#plain'));

    // 2. instant mode with a longer shortcut sharing the prefix
    await page.fill('#plain', '');
    await page.click('#plain');
    await page.keyboard.type('ok /bye ', delay);
    await page.waitForTimeout(250);
    check('/bye waits for /byebye, expands on space', (await val('#plain')) === 'ok Goodbye! ', await val('#plain'));
    await page.fill('#plain', '');
    await page.keyboard.type('/byebye', delay);
    await page.waitForTimeout(250);
    check('/byebye expands instantly', (await val('#plain')) === 'Bye for now!', await val('#plain'));

    // 3. textarea + fill-in dialog + {cursor} + nested snippet
    await page.click('#ta');
    await page.keyboard.type('/followup', delay);
    await page.waitForTimeout(400);
    await page.keyboard.type('Ana');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const ta = await page.$eval('#ta', (el) => ({ v: el.value, s: el.selectionStart }));
    check('fill-in value inserted', ta.v.startsWith('Hi Ana,\n\nThanks for the call on'), ta.v);
    check('nested {snippet:/sig} rendered', ta.v.includes('Best regards,\nYour Name'), ta.v);
    check('{cursor} positions the caret', ta.s === ta.v.indexOf('\n\nI will send'), ta);
    check('{date:+2d:dddd} rendered', ta.v.includes('I will send notes by ' + new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-US', { weekday: 'long' })), ta.v);

    // 4. select field, cancel with Escape
    await page.fill('#ta', '');
    await page.click('#ta');
    await page.keyboard.type('/status', delay);
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('Escape cancels the fill-in dialog and keeps the text', (await val('#ta')) === '/status', await val('#ta'));
    await page.fill('#ta', '');
    await page.click('#ta');
    await page.keyboard.type('/status', delay);
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('select placeholder value inserted', (await val('#ta')).startsWith('Status: At risk\nUpdated ' + today()), await val('#ta'));

    // 5. React-style controlled input
    await page.click('#react');
    await page.keyboard.type('/date', delay);
    await page.waitForTimeout(250);
    check('React-style input state updated', (await page.evaluate(() => window.reactState)) === today(), await page.evaluate(() => window.reactState));

    // 6. password fields never expand
    await page.click('#pw');
    await page.keyboard.type(';addr', delay);
    await page.waitForTimeout(250);
    check('no expansion in password fields', (await val('#pw')) === ';addr');

    // 7. contenteditable + undo
    await page.click('#ce');
    await page.keyboard.type('Hi /sig', delay);
    await page.waitForTimeout(300);
    let ce = await page.$eval('#ce', (el) => el.innerText);
    check('expands in contenteditable (multi-line)', ce.includes('Hi Best regards,') && ce.includes('your.name@example.com'), ce);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    ce = await page.$eval('#ce', (el) => el.innerText.replace(/ /g, ' ').trim());
    check('Backspace undo in contenteditable', ce === 'Hi /sig', ce);

    // 8. rich snippet in contenteditable with {cursor}
    await page.$eval('#ce', (el) => { el.innerHTML = ''; });
    await page.click('#ce');
    await page.keyboard.type('/rich', delay);
    await page.waitForTimeout(300);
    await page.keyboard.type('X');
    const rich = await page.$eval('#ce', (el) => ({ html: el.innerHTML, text: el.innerText }));
    check('rich snippet keeps formatting', /<b>Bold<\/b>/.test(rich.html) && /<i>end<\/i>/.test(rich.html), rich.html);
    check('rich {cursor} placement', rich.text.replace(/\s+/g, ' ').trim() === 'Bold and Xend' && !rich.text.includes('⁣'), rich.text);

    // 9. editor that owns paste (Slack/Notion style)
    await page.click('#fake');
    await page.keyboard.type(';addr', delay);
    await page.waitForTimeout(300);
    const fake = await page.evaluate(() => ({ pasted: window.pasted, text: document.getElementById('fake').innerText }));
    check('multi-line text goes through the editor paste handler', fake.pasted.length === 1 && fake.text.includes('100 Congress Ave | Austin'), fake);

    // 10. clipboard history capture
    const clips = () => sw.evaluate(async () => (await chrome.storage.local.get('tk.clips'))['tk.clips'] || []);
    await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('para')); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(300);
    let c = await clips();
    check('copy event recorded with source URL', c.some((x) => x.text === 'The quick brown fox copies text.' && x.url === base && x.host === '127.0.0.1'), c.map((x) => x.text));
    await page.click('#copybtn');
    await page.waitForTimeout(300);
    c = await clips();
    check('page-provided clipboard data recorded', c[0] && c[0].text === 'BUTTON DATA 42', c.map((x) => x.text));
    await page.click('#card');
    await page.$eval('#card', (el) => el.select());
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(300);
    c = await clips();
    check('card number field not recorded', !c.some((x) => x.text.includes('4111')), c.map((x) => x.text));
    await sw.evaluate(() => self.TKStore.saveSettings({ excludedSites: ['127.0.0.1'] }));
    await page.waitForTimeout(300);
    await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('h1')); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(300);
    c = await clips();
    check('excluded site not recorded', !c.some((x) => x.text === 'Type Kit fixture'), c.map((x) => x.text));
    await sw.evaluate(() => self.TKStore.saveSettings({ excludedSites: [] }));
    await page.waitForTimeout(200);

    // 11. {clipboard} placeholder uses the latest clip
    await page.click('#plain2');
    await page.keyboard.type('/clip', delay);
    await page.waitForTimeout(300);
    check('{clipboard} inserts the latest clipboard item', (await val('#plain2')) === 'BUTTON DATA 42', await val('#plain2'));

    // 12. picker (Alt+Shift+V is delivered by chrome.commands; send the same message here)
    await page.bringToFront();
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    const openPicker = () => sw.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'tk:open-picker' }), tabId);
    await page.click('#plain3');
    await openPicker();
    await page.waitForTimeout(300);
    check('picker opens (focus moves into the overlay)', await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'TYPE-KIT-UI'));
    await page.keyboard.type('signature');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('picker inserts the chosen snippet', (await val('#plain3')).startsWith('Best regards, Your Name'), await val('#plain3'));
    await page.fill('#plain3', '');
    await page.click('#plain3');
    await openPicker();
    await page.waitForTimeout(300);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');           // All -> Snippets -> Clipboard
    await page.keyboard.type('quick brown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('picker pastes a clipboard item', (await val('#plain3')) === 'The quick brown fox copies text.', await val('#plain3'));
    await openPicker();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('Escape closes the picker and returns focus', await page.evaluate(() => document.activeElement.id) === 'plain3');

    // 13. "after space" trigger mode
    await sw.evaluate(() => self.TKStore.saveSettings({ triggerMode: 'space' }));
    await page.waitForTimeout(300);
    await page.fill('#plain2', '');
    await page.click('#plain2');
    await page.keyboard.type('x ;addr', delay);
    await page.waitForTimeout(200);
    const notYet = await val('#plain2');
    await page.keyboard.type(', ', delay);
    await page.waitForTimeout(250);
    check('space mode waits for a delimiter', notYet === 'x ;addr', notYet);
    check('space mode keeps the delimiter', (await val('#plain2')) === 'x 100 Congress Ave Austin, TX 78701 United States, ', await val('#plain2'));
    await sw.evaluate(() => self.TKStore.saveSettings({ triggerMode: 'instant', expanderEnabled: false }));
    await page.waitForTimeout(300);
    await page.fill('#plain2', '');
    await page.click('#plain2');
    await page.keyboard.type(';addr', delay);
    await page.waitForTimeout(200);
    check('expansion can be paused', (await val('#plain2')) === ';addr');
    await sw.evaluate(() => self.TKStore.saveSettings({ expanderEnabled: true }));

    // 14. usage stats recorded
    const stats = await sw.evaluate(() => self.TKStore.stats());
    check('usage stats recorded', stats.uses >= 8 && stats.charsSaved > 100, stats);

    // 15. popup → insert into page field via the background
    await page.fill('#plain3', '');
    await page.click('#plain3');
    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForTimeout(400);
    check('popup lists recent clipboard items', (await popup.$$eval('#list .row', (r) => r.length)) >= 2);
    await popup.fill('#q', 'button');
    await popup.waitForTimeout(100);
    check('popup search filters clips', (await popup.$$eval('#list .row', (r) => r.length)) === 1);
    const res = await popup.evaluate((t) => chrome.runtime.sendMessage({ type: 'tk:insert-in-tab', tabId: t, kind: 'clip', text: 'FROM POPUP' }), tabId);
    await popup.close();
    await page.bringToFront();
    await page.waitForTimeout(400);
    check('popup insert reaches the focused field', res && res.ok && (await val('#plain3')) === 'FROM POPUP', { res, v: await val('#plain3') });

    // 16. manager page works
    const mgr = await ctx.newPage();
    mgr.on('pageerror', (e) => errors.push('manager: ' + e.message));
    await mgr.goto(`chrome-extension://${id}/manager/manager.html#snippets`);
    await mgr.waitForTimeout(400);
    await mgr.click('#snip-new');
    await mgr.fill('#f-name', 'E2E');
    await mgr.fill('#f-shortcut', '/e2e');
    await mgr.fill('#f-body', 'From the manager {date:YYYY}');
    await mgr.keyboard.press('Control+s');
    await mgr.waitForTimeout(300);
    const saved = await sw.evaluate(async () => (await self.TKStore.getSnippets()).find((s) => s.shortcut === '/e2e'));
    check('manager saves a new snippet', saved && saved.body === 'From the manager {date:YYYY}', saved);
    await mgr.fill('#f-shortcut', '/sig');
    await mgr.waitForTimeout(100);
    check('manager flags duplicate shortcuts', /already uses/.test(await mgr.textContent('#shortcut-msg')));
    await mgr.click('#snip-revert');
    await mgr.click('a[data-view=stats]');
    await mgr.waitForTimeout(400);
    check('stats view shows uses', (await mgr.$$eval('#top-table tbody tr', (r) => r.length)) >= 3);
    await mgr.close();
    await page.bringToFront();
    await page.fill('#plain2', '');
    await page.click('#plain2');
    await page.keyboard.type('/e2e', delay);
    await page.waitForTimeout(250);
    check('new snippet expands without reload', (await val('#plain2')) === 'From the manager ' + new Date().getFullYear(), await val('#plain2'));

    check('no page errors', errors.length === 0, errors);
    await ctx.close();
    browserClosed = true;
  } finally {
    if (!browserClosed) await ctx.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
