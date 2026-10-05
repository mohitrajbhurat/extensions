#!/usr/bin/env node
// End-to-end checks for Request Rewriter: loads the unpacked extension in Playwright's Chromium,
// serves a local echo server, installs rules through the real storage -> service worker -> DNR
// pipeline and verifies what the browser actually sends and receives.
// Usage: node request-rewriter/test/e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}

(async () => {
  const R = await import(path.join(EXT, 'lib', 'rules.js'));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>page</title><p>test page</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ path: u.pathname, query: u.search, host: req.headers.host, headers: req.headers }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let failed = false;
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = sw.url().split('/')[2];
    await sleep(800);
    // Close the welcome tab opened on install.
    for (const p of ctx.pages()) if (p.url().includes('welcome=1')) { check('welcome page opens on install', true); await p.close(); }

    const setState = async state => {
      await sw.evaluate(async s => { await chrome.storage.local.set({ state: s }); await self.requestRewriter.syncRules(); }, state);
    };
    const installed = () => sw.evaluate(async () => ({
      dyn: (await chrome.declarativeNetRequest.getDynamicRules()).length,
      ses: (await chrome.declarativeNetRequest.getSessionRules()).length,
      status: (await chrome.storage.local.get('syncStatus')).syncStatus,
    }));

    const cond = p => ({ ...R.defaultCondition(), ...p });
    const rules = [
      R.newRule('requestHeaders', { name: 'debug header', condition: cond({ matchType: 'contains', value: '/echo' }), action: { headers: [{ op: 'set', name: 'X-Debug', value: 'e2e' }] } }),
      R.newRule('responseHeaders', { name: 'resp header', condition: cond({ matchType: 'contains', value: '/echo' }), action: { headers: [{ op: 'set', name: 'X-Resp', value: 'added' }] } }),
      R.newRule('redirect', { name: 'wildcard redirect', condition: cond({ matchType: 'wildcard', value: `${base}/old/*` }), action: { url: `${base}/new/$1` } }),
      R.newRule('redirect', { name: 'regex redirect', condition: cond({ matchType: 'regex', value: '^http://127\\.0\\.0\\.1:\\d+/rx/(\\w+)/(\\w+)$' }), action: { url: `${base}/swapped/$2/$1` } }),
      R.newRule('replace', { name: 'v1 to v2', action: { find: '/v1/', replaceWith: '/v2/' } }),
      R.newRule('query', { name: 'query', condition: cond({ matchType: 'contains', value: '/q' }), action: { add: [{ key: 'debug', value: '1' }], remove: 'utm_source' } }),
      R.newRule('block', { name: 'block', condition: cond({ matchType: 'contains', value: '/blocked' }) }),
      R.newRule('block', { name: 'block POST only', condition: cond({ matchType: 'contains', value: '/postonly', methods: ['post'] }) }),
      R.newRule('mock', { name: 'mock', condition: cond({ matchType: 'exact', value: `${base}/mock/flags` }), action: { contentType: 'application/json', charset: 'utf-8', body: '{"mocked":true,"name":"é"}' } }),
      R.newRule('userAgent', { name: 'ua', condition: cond({ matchType: 'contains', value: '/ua' }), action: { preset: 'curl', value: 'curl/8.9.1', dropClientHints: true } }),
      // Only iframes, so the test page itself stays on 127.0.0.1.
      R.newRule('host', { name: 'host swap', condition: cond({ matchType: 'domain', value: '127.0.0.1', resourceTypes: ['sub_frame'] }), action: { fromHost: '127.0.0.1', toHost: 'localhost' } }),
    ];
    const bad = R.newRule('block', { name: 'bad regex', condition: cond({ matchType: 'regex', value: '(a{1000}){1000}' }) });
    const main = R.newGroup('E2E', { rules: [...rules, bad] });
    const state = { format: 'request-rewriter', version: 1, paused: false, groups: [main] };
    await setState(state);
    const inst = await installed();
    check('rules installed in DNR', inst.dyn === rules.length, `${inst.dyn} dynamic`);
    check('an RE2-incompatible rule is reported, the others still install', inst.status.errors.length === 1 && inst.status.errors[0].ruleId === bad.id, JSON.stringify(inst.status.errors.map(e => e.messages)));

    const page = await ctx.newPage();
    await page.goto(`${base}/page`);
    const fetchJson = (url, opts) => page.evaluate(async ([u, o]) => {
      try {
        const r = await fetch(u, o);
        return { ok: true, url: r.url, headers: Object.fromEntries(r.headers), body: await r.text() };
      } catch (e) { return { ok: false, error: String(e) }; }
    }, [url, opts || {}]);

    let r = await fetchJson(`${base}/echo`);
    let body = JSON.parse(r.body);
    check('request header set', body.headers['x-debug'] === 'e2e');
    check('response header set', r.headers['x-resp'] === 'added');

    r = await fetchJson(`${base}/old/a/b?c=1`);
    check('wildcard redirect with $1', JSON.parse(r.body).path === '/new/a/b' && JSON.parse(r.body).query === '?c=1', r.url);
    r = await fetchJson(`${base}/rx/one/two`);
    check('regex redirect with groups', JSON.parse(r.body).path === '/swapped/two/one', r.url);
    r = await fetchJson(`${base}/api/v1/users`);
    check('replace text in URL', JSON.parse(r.body).path === '/api/v2/users', r.url);
    r = await fetchJson(`${base}/q?utm_source=x&keep=1`);
    check('query params add/remove', JSON.parse(r.body).query === '?keep=1&debug=1', JSON.parse(r.body).query);
    r = await fetchJson(`${base}/blocked`);
    check('block', !r.ok);
    r = await fetchJson(`${base}/postonly`);
    const r2 = await fetchJson(`${base}/postonly`, { method: 'POST', body: 'x' });
    check('method condition', r.ok && !r2.ok);
    r = await fetchJson(`${base}/mock/flags`);
    let mock = null;
    try { mock = JSON.parse(r.body); } catch { /* not json */ }
    check('mock response via data: URL', r.ok && mock && mock.mocked === true && mock.name === 'é', r.ok ? r.body.slice(0, 80) : r.error);
    r = await fetchJson(`${base}/ua`);
    body = JSON.parse(r.body);
    check('user-agent override + client hints removed', body.headers['user-agent'] === 'curl/8.9.1' && !body.headers['sec-ch-ua']);
    const hostSwap = await page.evaluate(src => new Promise(res => {
      const f = document.createElement('iframe');
      f.onload = () => { try { res(f.contentWindow.location.href); } catch { res('cross-origin (swapped)'); } };
      f.src = src;
      document.body.append(f);
    }), `${base}/page-frame`);
    check('host replace (127.0.0.1 -> localhost)', hostSwap === 'cross-origin (swapped)', hostSwap);

    // Match tracking + badge.
    await sleep(500);
    const tabInfo = await sw.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ url: url + '/*' });
      const text = await chrome.action.getBadgeText({ tabId: tab.id });
      const e = self.requestRewriter.tabMatches.get(tab.id);
      return { id: tab.id, text, hits: e ? Object.values(e.counts).reduce((a, b) => a + b, 0) : 0, global: await chrome.action.getBadgeText({}) };
    }, base);
    check('matches recorded per tab', tabInfo.hits >= 8, `${tabInfo.hits} hits`);
    check('badge shows matches on the tab', Number(tabInfo.text) === tabInfo.hits, `tab badge ${tabInfo.text}`);
    check('global badge shows active rule count', tabInfo.global === String(rules.length + 1), `global ${tabInfo.global}`);

    // Tab-scoped session rules.
    const page2 = await ctx.newPage();
    await page2.goto(`${base}/page2`);
    const tabGroup = R.newGroup('Tab only', { tabScope: tabInfo.id, rules: [R.newRule('requestHeaders', { condition: cond({ matchType: 'contains', value: '/echo' }), action: { headers: [{ op: 'set', name: 'X-Tab', value: 'yes' }] } })] });
    state.groups.push(tabGroup);
    await setState(state);
    const inst2 = await installed();
    check('tab-scoped group installs as session rule', inst2.ses === 1, `${inst2.ses} session`);
    const a = JSON.parse((await fetchJson(`${base}/echo`)).body);
    const b = JSON.parse(await page2.evaluate(async u => (await fetch(u)).text(), `${base}/echo`));
    check('session rule applies only to its tab', a.headers['x-tab'] === 'yes' && !b.headers['x-tab']);
    await page2.close();

    // Group toggle and global pause.
    state.groups[0].enabled = false;
    await setState(state);
    body = JSON.parse((await fetchJson(`${base}/echo`)).body);
    check('disabled group stops applying', !body.headers['x-debug'] && body.headers['x-tab'] === 'yes');
    state.groups[0].enabled = true;
    state.paused = true;
    await setState(state);
    const inst3 = await installed();
    body = JSON.parse((await fetchJson(`${base}/echo`)).body);
    check('global pause removes every rule', inst3.dyn === 0 && inst3.ses === 0 && !body.headers['x-debug']);
    const pausedBadge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    check('badge shows "off" when paused', pausedBadge === 'off');
    state.paused = false;
    state.groups = [R.newGroup('UI', { rules: [] })];
    await setState(state);

    // Editor UI: add a rule through the dialog.
    const ed = await ctx.newPage();
    const edErrors = [];
    ed.on('pageerror', e => edErrors.push(e.message));
    await ed.goto(`chrome-extension://${extId}/editor/editor.html`);
    await ed.waitForSelector('#addRule');
    await ed.selectOption('#addType', 'block');
    await ed.click('#addRule');
    await ed.waitForSelector('#ruleDialog[open]');
    await ed.selectOption('#f-match', 'regex');
    await ed.fill('#f-value', '(a{1000}){1000}');
    await sleep(400);
    const saveDisabled = await ed.$eval('#ruleSave', b => b.disabled);
    const msg = await ed.$eval('#msgs', n => n.textContent);
    check('editor flags regex Chrome rejects (isRegexSupported)', saveDisabled && /cannot use/.test(msg), msg.slice(0, 100));
    await ed.selectOption('#f-match', 'contains');
    await ed.fill('#f-value', '/ui-blocked');
    await ed.fill('#f-name', 'UI block');
    await ed.fill('#f-try', `${base}/ui-blocked?x=1`);
    const tryText = await ed.$eval('#tryResult', n => n.textContent);
    check('editor "try it" shows a match', /Matches/.test(tryText), tryText);
    await ed.click('#ruleSave');
    await ed.waitForSelector('#ruleDialog:not([open])');
    await sleep(600);
    r = await fetchJson(`${base}/ui-blocked`);
    check('rule saved from the editor applies', !r.ok);
    const rowText = await ed.textContent('.rule-list');
    check('editor lists the new rule', rowText.includes('UI block'));

    // Tester view.
    await ed.goto(`chrome-extension://${extId}/editor/editor.html#tester?url=${encodeURIComponent(base + '/ui-blocked')}`);
    await ed.waitForSelector('.verdict');
    const verdict = await ed.textContent('.verdict');
    check('URL tester reports the verdict', /Blocked/.test(verdict), verdict);

    // Import ModHeader profile through the UI (paste).
    await ed.goto(`chrome-extension://${extId}/editor/editor.html#settings`);
    await ed.waitForSelector('#s-paste');
    await ed.fill('#s-paste', JSON.stringify([{ title: 'MH', headers: [{ enabled: true, name: 'X-MH', value: '1' }] }]));
    await ed.click('text=Import pasted JSON');
    await ed.waitForSelector('#importDialog[open]');
    await ed.click('#importAdd');
    await sleep(600);
    body = JSON.parse((await fetchJson(`${base}/echo`)).body);
    check('ModHeader import applies headers', body.headers['x-mh'] === '1');
    check('editor has no page errors', !edErrors.length, edErrors.join('; '));

    // Popup quick header.
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
    await pop.waitForSelector('#quickForm');
    await pop.selectOption('#quickScope', 'all');
    await pop.fill('#quickName', 'X-Quick');
    await pop.fill('#quickValue', 'popup');
    await pop.click('#quickAdd');
    await sleep(700);
    body = JSON.parse((await fetchJson(`${base}/echo`)).body);
    check('popup quick header rule applies', body.headers['x-quick'] === 'popup');
    const groupsInPopup = await pop.$$eval('.group-row', n => n.length);
    check('popup lists groups with toggles', groupsInPopup >= 2);
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  const bad = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad || failed ? 1 : 0);
})();
