#!/usr/bin/env node
// End-to-end check for Mindful Gate: gate redirect, pass, expiry overlay, focus timer, strict schedule.
// Usage: node mindful-gate/test/e2e.js   (needs Playwright and python3)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ext = path.resolve(__dirname, '..');
const PORT = 8700 + Math.floor(Math.random() * 200);
const SITE = `http://localhost:${PORT}/site.html`;
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: __dirname, stdio: 'ignore' });
  await wait(800);
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-e2e-')), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    await wait(1000);
    // Configure: localhost in a gated group, short pauses.
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      settings.groups = [{ id: 'test', name: 'Test', sites: ['localhost'], mode: 'gate', blockDuringFocus: true, strict: false, schedules: [] }];
      settings.gate.breathBase = 1; settings.gate.breathStep = 1;
      await chrome.storage.local.set({ settings });
      await self.mindfulGate.syncRules();
    });
    const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    check('gate redirect rule installed', rules.length === 1 && rules[0].condition.requestDomains[0] === 'localhost');

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(SITE);
    await page.waitForURL(/gate\/gate\.html/, { timeout: 5000 });
    check('navigation redirected to gate page', page.url().startsWith(`chrome-extension://${id}/gate/gate.html?u=${SITE}`), page.url());
    await page.waitForSelector('#gateView:not(.hidden)');
    check('pass buttons locked during breathing pause', await page.locator('#passButtons .btn').first().isDisabled());
    await page.fill('#intention', 'Check one thing');
    await page.waitForSelector('#passButtons .btn:not([disabled])', { timeout: 5000 });
    await page.click('#passButtons .btn >> text=5 min');
    await page.waitForURL(SITE, { timeout: 5000 });
    check('pass grants access to the site', (await page.textContent('#hello')) === 'Endless feed');
    let st = await sw.evaluate(() => chrome.storage.local.get(['passes', 'stats', 'intentions']));
    const today = Object.values(st.stats)[0];
    check('pass stored for 5 minutes', st.passes.localhost && Math.abs(st.passes.localhost.until - Date.now() - 300000) < 10000);
    check('prompt and intention recorded', today.prompts.localhost === 1 && st.intentions[0].text === 'Check one thing');
    check('gate rule lifted while pass active', (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0);

    // Expire the pass: overlay should appear on the open tab.
    await sw.evaluate(() => self.mindfulGate.endPass('localhost'));
    await page.waitForSelector('text=Your time is up.', { timeout: 5000 });
    check('expiry overlay shown with intention', await page.locator('text=Check one thing').isVisible());
    check('extend button waits before enabling', await page.locator('button:has-text("Extend")').isDisabled());
    await page.click('button:has-text("Leave site")');
    await page.waitForURL(/gate\.html\?left=1/, { timeout: 5000 });
    check('leave sends tab to the turned-back view', await page.locator('#leftView').isVisible());

    // Second visit: breathing pause grows, turning back is recorded.
    await page.goto(SITE);
    await page.waitForURL(/gate\/gate\.html/);
    await page.waitForSelector('#gateView:not(.hidden)');
    check('second visit counted', /visit 2 today/.test(await page.textContent('#siteMeta')));
    await page.click('#backBtn');
    await page.waitForSelector('#leftView:not(.hidden)');
    st = await sw.evaluate(() => chrome.storage.local.get('stats'));
    check('turn-backs recorded', Object.values(st.stats)[0].turnedBack.localhost === 2);

    // Focus timer: hard block + badge.
    await sw.evaluate(() => self.mindfulGate.focusStart('Write tests'));
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    check('badge shows focus countdown', badge === '25m', badge);
    await page.goto(SITE);
    await page.waitForURL(/block\/block\.html\?r=focus/, { timeout: 5000 });
    check('site hard blocked during focus', true);
    await page.waitForSelector('#task:not(.hidden)');
    check('block page shows task and reasons', /Write tests/.test(await page.textContent('#task')) && (await page.locator('#reasons li').count()) > 0);
    await sw.evaluate(() => self.mindfulGate.completePhase(false));
    st = await sw.evaluate(() => chrome.storage.local.get(['focus', 'focusLog', 'stats']));
    check('work phase completes into short break', st.focus.phase === 'short' && !st.focus.paused);
    check('focus log and minutes recorded', st.focusLog.length === 1 && st.focusLog[0].completed && Object.values(st.stats)[0].focusMinutes === 25);
    check('badge shows break countdown', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '5m');
    await page.goto(SITE);
    await page.waitForURL(/gate\/gate\.html/, { timeout: 5000 });
    check('during break the site is gated, not blocked', true);
    await sw.evaluate(() => self.mindfulGate.focusStop());
    check('badge cleared after stop', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '');

    // Strict all-day schedule: blocked and cannot be loosened.
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      settings.groups[0].strict = true;
      settings.groups[0].schedules = [{ id: 's', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' }];
      await chrome.storage.local.set({ settings });
      await self.mindfulGate.syncRules();
    });
    await page.goto(SITE);
    await page.waitForURL(/block\/block\.html\?r=schedule/, { timeout: 5000 });
    check('strict schedule blocks the site', true);
    await page.waitForTimeout(500);
    check('strict block offers no snooze', await page.locator('#snooze').isHidden() && await page.locator('#strictNote').isVisible());
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${id}/options/options.html`);
    const res = await opt.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'getState' }, s => {
      s.settings.groups[0].sites = [];
      chrome.runtime.sendMessage({ type: 'saveSettings', settings: s.settings }, r);
    })));
    check('strict mode refuses removing sites', res && /strict mode/.test(res.error || ''), JSON.stringify(res));
    await opt.waitForSelector('.group.locked');
    check('options page shows group as locked', await opt.locator('.g-delete').isDisabled());

    const dash = await ctx.newPage();
    await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
    await dash.waitForTimeout(800);
    check('dashboard summarizes the week', /turned back/.test(await dash.textContent('#summaryText')));
    check('no page errors', errors.length === 0, errors.join('; '));
  } catch (e) {
    fail++;
    console.log('FAIL exception', e.message);
  } finally {
    await ctx.close();
    server.kill();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
