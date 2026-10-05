#!/usr/bin/env node
// End-to-end checks for Tab Workspaces core flows, run in headless Chromium with the extension loaded.
// Usage (from the repo root): node tab-workspaces/test/e2e.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 8000, step = 150) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

(async () => {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/[^a-z0-9]/gi, '') || 'root';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1><input id="f">`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];

  const dash = await ctx.newPage();
  dash.on('pageerror', e => errors.push('dashboard: ' + e.message));
  dash.on('console', m => { if (m.type() === 'error') errors.push('dashboard console: ' + m.text()); });
  await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
  // Close the initial about:blank tab so only our tabs are in the window.
  for (const p of ctx.pages()) if (p !== dash) await p.close();

  const msg = (type, payload = {}) => dash.evaluate(async ([type, payload]) => {
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }, [type, payload]);
  const local = key => dash.evaluate(k => chrome.storage.local.get(k).then(r => r[k]), key);
  const windowId = await dash.evaluate(() => chrome.windows.getCurrent().then(w => w.id));
  const tabsInWindow = () => dash.evaluate(w => chrome.tabs.query({ windowId: w }).then(ts => ts.map(t => ({ id: t.id, url: t.url || t.pendingUrl, groupId: t.groupId, discarded: t.discarded, active: t.active }))), windowId);
  const webTabs = async () => (await tabsInWindow()).filter(t => t.url.startsWith(base));
  const openTab = (url, active = false) => dash.evaluate(([url, w, active]) => chrome.tabs.create({ url, windowId: w, active }).then(t => t.id), [url, windowId, active]);
  await msg('settings.set', { patch: { duplicateMode: 'off', lazyRestore: false, memoryEnabled: false } });

  // ---------------- Workspaces ----------------
  console.log('Workspaces');
  const a = await openTab(`${base}/alpha1`);
  const b = await openTab(`${base}/alpha2`);
  await openTab(`${base}/alpha3`);
  await waitFor(async () => (await webTabs()).length === 3);
  await dash.evaluate(async ([a, b, w]) => {
    const g = await chrome.tabs.group({ tabIds: [a, b], createProperties: { windowId: w } });
    await chrome.tabGroups.update(g, { title: 'Research', color: 'green' });
  }, [a, b, windowId]);
  await sleep(300);
  const alpha = await msg('ws.create', { name: 'Alpha', color: 'blue', source: 'window', windowId });
  let list = await local('workspaces');
  check('workspace created from window', list.length === 1 && list[0].name === 'Alpha');
  check('dashboard page is not saved into workspace', list[0].tabs.every(t => t.url.startsWith(base)), JSON.stringify(list[0].tabs.map(t => t.url)));
  check('workspace has 3 tabs and 1 group', list[0].tabs.length === 3 && list[0].groups.length === 1 && list[0].groups[0].title === 'Research');
  const bindings = await msg('state.bindings');
  check('window bound to workspace', bindings[windowId] === alpha.id);

  const beta = await msg('ws.create', { name: 'Beta', source: 'empty' });
  await msg('ws.switch', { id: beta.id, windowId });
  await waitFor(async () => (await webTabs()).length === 0);
  check('switching to empty workspace closes Alpha tabs', (await webTabs()).length === 0);
  check('dashboard survives the switch', (await tabsInWindow()).some(t => t.url.includes(id)));

  await openTab(`${base}/beta1`, true);
  await sleep(1800); // autosave debounce
  list = await local('workspaces');
  check('autosave records tabs opened in Beta', list.find(w => w.id === beta.id).tabs.some(t => t.url.endsWith('/beta1')));

  await msg('ws.switch', { id: alpha.id, windowId });
  await waitFor(async () => (await webTabs()).length === 3);
  const restored = await webTabs();
  check('switching back restores Alpha tabs', restored.length === 3 && restored.every(t => t.url.includes('alpha')), JSON.stringify(restored.map(t => t.url)));
  const groupInfo = await dash.evaluate(w => chrome.tabGroups.query({ windowId: w }), windowId);
  check('tab group restored with title and color', groupInfo.length === 1 && groupInfo[0].title === 'Research' && groupInfo[0].color === 'green');
  const grouped = restored.filter(t => t.groupId > -1).length;
  check('two tabs are back in the group', grouped === 2);
  list = await local('workspaces');
  check('Beta was saved when switching away', list.find(w => w.id === beta.id).tabs.map(t => t.url).join() === `${base}/beta1`);

  // ---------------- Stash ----------------
  console.log('Stash');
  const before = (await webTabs()).length;
  const r = await msg('stash.tabs', { windowId, which: 'all' });
  check('stash all reports count', r.count === before, JSON.stringify(r));
  await waitFor(async () => (await webTabs()).length === 0);
  check('stashed tabs are closed', (await webTabs()).length === 0);
  let stashes = await local('stashes');
  check('stash list created with all tabs', stashes.length === 1 && stashes[0].tabs.length === before);
  const archBefore = (await local('archive') || []).length;
  check('stashed tabs are not archived', archBefore === 0, String(archBefore));

  // drag-equivalent: move one tab into a new stash, rename it
  await msg('stash.move', { fromStashId: stashes[0].id, tabId: stashes[0].tabs[0].id, toStashId: 'new' });
  stashes = await local('stashes');
  check('move tab into new stash', stashes.length === 2 && stashes[0].tabs.length === 1);
  await msg('stash.update', { stashId: stashes[0].id, patch: { name: 'Later reading' } });
  stashes = await local('stashes');
  check('rename stash', stashes[0].name === 'Later reading');
  await msg('stash.restoreTab', { stashId: stashes[0].id, tabId: stashes[0].tabs[0].id, windowId });
  await waitFor(async () => (await webTabs()).length === 1);
  stashes = await local('stashes');
  check('restore single tab reopens it and empties that stash', (await webTabs()).length === 1 && stashes.length === 1);
  await msg('stash.restore', { stashId: stashes[0].id, windowId });
  await waitFor(async () => (await webTabs()).length === before);
  check('restore all reopens every tab', (await webTabs()).length === before);
  check('restored stash removed', (await local('stashes')).length === 0);

  // ---------------- Duplicates ----------------
  console.log('Duplicate guard');
  await msg('settings.set', { patch: { duplicateMode: 'auto', duplicateScope: 'window' } });
  await sleep(200);
  const countUrl = async u => (await webTabs()).filter(t => t.url === u).length;
  await openTab(`${base}/alpha1`, true);
  await sleep(2500);
  check('auto mode closes a newly opened duplicate', (await countUrl(`${base}/alpha1`)) === 1, String(await countUrl(`${base}/alpha1`)));
  await msg('settings.set', { patch: { duplicateMode: 'off' } });
  await sleep(200);
  await openTab(`${base}/alpha2?utm_source=x`);
  await openTab(`${base}/alpha2#section`);
  await sleep(800);
  const groups = await msg('dup.find', { scope: 'all' });
  check('find duplicates ignores tracking params and hash', groups.length === 1 && groups[0].tabs.length === 3, JSON.stringify(groups));
  const closed = await msg('dup.closeAll', { scope: 'all' });
  check('close all duplicates closes extras', closed === 2, String(closed));
  await sleep(500);
  check('one copy kept', (await webTabs()).filter(t => t.url.includes('alpha2')).length === 1);

  // ---------------- Archive ----------------
  console.log('Archive');
  const victim = await openTab(`${base}/archiveme`);
  await waitFor(async () => (await webTabs()).some(t => t.url.endsWith('/archiveme') && t.id === victim));
  await sleep(800);
  await dash.evaluate(id => chrome.tabs.remove(id), victim);
  const arch = await waitFor(async () => { const a = await local('archive'); return a && a.find(x => x.url.endsWith('/archiveme')) && a; }, 5000);
  check('closed tab recorded in archive', !!arch && arch.some(x => x.url.endsWith('/archiveme') && x.title === 'Page archiveme'));

  // ---------------- Sessions ----------------
  console.log('Sessions');
  await msg('session.snapshot');
  const sess = await local('sessions');
  check('manual snapshot saved', sess.length === 1 && sess[0].tabCount >= 3);

  // ---------------- Grouping rules ----------------
  console.log('Auto-grouping');
  await msg('rules.save', { rule: { pattern: '*/docs-*', type: 'wildcard', title: 'Docs', color: 'purple' } });
  const docTab = await openTab(`${base}/docs-intro`);
  const g = await waitFor(async () => {
    const t = await dash.evaluate(id => chrome.tabs.get(id), docTab);
    return t.groupId > -1 ? t.groupId : 0;
  }, 5000);
  const gInfo = g ? await dash.evaluate(id => chrome.tabGroups.get(id), g) : null;
  check('rule puts matching tab into named group', gInfo && gInfo.title === 'Docs' && gInfo.color === 'purple', JSON.stringify(gInfo));

  // ---------------- Memory saver ----------------
  // Real chrome.tabs.discard takes down Playwright-driven Chromium, so the worker's discard call is
  // replaced with a recorder; everything else (idle clock, protections, sweep) runs for real.
  console.log('Memory saver');
  const stubbed = await sw.evaluate(() => {
    globalThis.__discarded = [];
    try { chrome.tabs.discard = async id => { globalThis.__discarded.push(id); return {}; }; } catch { return false; }
    return true;
  });
  const sleepy = await openTab(`${base}/sleepy`);
  const pinned = await openTab(`${base}/pinme`);
  const white = await openTab(`${base}/whitelisted`);
  await dash.evaluate(id => chrome.tabs.update(id, { pinned: true }), pinned);
  await msg('settings.set', { patch: { memoryEnabled: true, idleMinutes: 1, whitelist: ['*/whitelisted*'] } });
  await sleep(300);
  await dash.evaluate(ids => chrome.storage.session.get('tabActivity').then(r => {
    const a = r.tabActivity || {};
    for (const id of ids) a[id] = Date.now() - 5 * 60000;
    return chrome.storage.session.set({ tabActivity: a });
  }), [sleepy, pinned, white]);
  const swept = await msg('mem.sweep');
  const discarded = await sw.evaluate(() => globalThis.__discarded);
  check('discard API stub installed', stubbed);
  check('idle sweep suspends an idle tab', discarded.includes(sleepy), JSON.stringify(discarded));
  check('idle sweep skips pinned and whitelisted tabs', !discarded.includes(pinned) && !discarded.includes(white));
  check('fresh tabs are not suspended', swept === discarded.length && discarded.length >= 1);
  const reasons = await msg('mem.reasons');
  check('protection reasons reported', reasons[pinned] === 'pinned' && reasons[white] === 'whitelisted', JSON.stringify([reasons[pinned], reasons[white]]));
  await sw.evaluate(() => { globalThis.__discarded = []; });
  await dash.evaluate(id => chrome.tabs.update(id, { active: true }), sleepy);
  await msg('mem.suspendTab', { tabId: sleepy });
  const after = await dash.evaluate(id => chrome.tabs.get(id), sleepy);
  check('suspend now on the active tab moves focus away first', !after.active && (await sw.evaluate(() => globalThis.__discarded)).includes(sleepy));
  await msg('settings.set', { patch: { memoryEnabled: false } });

  // ---------------- Import / export ----------------
  console.log('Import / export');
  const res = await msg('data.importOneTab', { text: `${base}/x | X page\n${base}/y | Y page\n\nhttps://example.com | Example\n` });
  check('OneTab import creates one stash per block', res.stashes === 2 && res.tabs === 3);
  const dump = await msg('data.export');
  check('export contains all collections', dump.format === 'tab-workspaces' && dump.workspaces.length === 2 && dump.stashes.length === 2);
  const imp = await msg('data.import', { data: JSON.stringify(dump), mode: 'merge' });
  check('JSON import merges', imp.workspaces === 2 && (await local('workspaces')).length === 4);

  // ---------------- UI renders ----------------
  console.log('UI');
  for (const view of ['workspaces', 'stash', 'tabs', 'sessions', 'archive', 'rules', 'settings']) {
    await dash.evaluate(v => { location.hash = v; }, view);
    await sleep(400);
    const h1 = await dash.textContent('h1');
    check(`dashboard view #${view} renders`, !!h1);
  }
  const popup = await ctx.newPage();
  popup.on('pageerror', e => errors.push('popup: ' + e.message));
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await sleep(600);
  const wsItems = await popup.$$eval('.ws-item', els => els.length);
  check('popup lists workspaces', wsItems === 4, String(wsItems));
  await popup.fill('#q', 'alpha');
  await sleep(300);
  check('popup search finds results', (await popup.$$eval('.res-item', els => els.length)) > 0);

  check('no page errors', errors.length === 0, errors.join('\n'));

  await ctx.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
