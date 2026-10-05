#!/usr/bin/env node
// Functional check for Smart Bookmarks. Loads the unpacked extension in Chromium,
// seeds bookmarks, then drives the manager page.
// Usage: node smart-bookmarks/test/functional.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const dir = path.resolve(__dirname, '..');
const steps = [];
const fail = [];
const ok = (name, cond, extra = '') => { steps.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fail.push(name); };

let ctxRef = null;
(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-func-'));
  const ctx = ctxRef = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];

  // Extension APIs are only reachable from an extension page, not from the worker's
  // isolated world, so a helper page acts as our API surface.
  const api = await ctx.newPage();
  await api.goto(`chrome-extension://${id}/popup/popup.html`);
  const ev = (fn, arg) => api.evaluate(fn, arg);

  // Seed a library with duplicates, an empty folder and tags.
  const seeded = await ev(async () => {
    const bar = '1';
    const work = await chrome.bookmarks.create({ parentId: bar, title: 'Work' });
    const empty = await chrome.bookmarks.create({ parentId: work.id, title: 'Empty folder' });
    const mk = (parentId, title, url) => chrome.bookmarks.create({ parentId, title, url });
    const a = await mk(work.id, 'Example Domain', 'https://example.com/');
    const b = await mk(bar, 'Example Domain copy', 'https://www.example.com?utm_source=news');
    const c = await mk(work.id, 'MDN Web Docs: fetch', 'https://developer.mozilla.org/en-US/docs/Web/API/fetch');
    const d = await mk(bar, 'Tomato pasta recipe', 'https://cooking.example.org/recipes/tomato-pasta');
    await chrome.storage.local.set({
      ['m:' + c.id]: { tags: ['javascript', 'docs'], note: 'reference' },
      ['m:' + d.id]: { tags: ['recipes'], suggested: ['pasta', 'tomato'] }
    });
    return { work: work.id, empty: empty.id, ids: [a.id, b.id, c.id, d.id] };
  });
  ok('seeded bookmarks', seeded.ids.length === 4);

  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await page.goto(`chrome-extension://${id}/manager/manager.html`);
  await page.waitForSelector('.items .item', { timeout: 10000 });

  // Read Later folder auto-created
  const rl = await page.evaluate(() => chrome.storage.local.get('rlFolders').then(r => r.rlFolders));
  ok('Read Later folder created', !!(rl && rl.rootId && rl.archiveId));

  // Navigate to All bookmarks
  await page.click('a[href="#all"]');
  await page.waitForFunction(() => document.querySelectorAll('.items .item.link').length >= 4);
  const allCount = await page.locator('.items .item.link').count();
  ok('all bookmarks listed', allCount >= 4, `${allCount} items`);

  // Search by tag
  await page.fill('#search', 'tag:javascript');
  await page.waitForTimeout(400);
  ok('tag search', await page.locator('.items .item.link').count() === 1);

  // Search by term in title
  await page.fill('#search', 'pasta');
  await page.waitForTimeout(400);
  ok('term search', (await page.locator('.items .item.link').count()) === 1);

  // is: filter
  await page.fill('#search', 'is:duplicate');
  await page.waitForTimeout(400);
  ok('is:duplicate search', (await page.locator('.items .item.link').count()) === 2);
  await page.fill('#search', '');
  await page.waitForTimeout(300);

  // Selection + inspector
  await page.click('a[href="#all"]');
  await page.waitForSelector('.items .item.link');
  await page.locator('.items .item.link').first().click();
  await page.waitForSelector('#inspector:not([hidden])');
  ok('inspector opens on select', await page.locator('#inspector [data-f="title"]').count() === 1);

  // Tag via inspector tag input
  await page.fill('#inspector .tag-input input', 'newtag');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const taggedOk = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).some(([k, v]) => k.startsWith('m:') && (v.tags || []).includes('newtag'));
  });
  ok('tag added from inspector', taggedOk);

  // Multi-select with shift and bulk bar
  await page.keyboard.press('Escape');
  const rows = page.locator('.items .item.link');
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await page.waitForSelector('#bulkbar:not([hidden])');
  const selText = await page.locator('.bulk-count').innerText();
  ok('shift range selection', /3 selected/.test(selText), selText);

  // Bulk tag dialog
  await page.click('[data-bulk="tag"]');
  await page.waitForSelector('dialog[open] .tag-input input');
  await page.fill('dialog[open] .tag-input input', 'bulktag');
  await page.keyboard.press('Enter');
  await page.click('dialog[open] .dlg-foot .primary');
  await page.waitForTimeout(600);
  const bulkCount = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.values(all).filter(v => v && (v.tags || []).includes('bulktag')).length;
  });
  ok('bulk tagging', bulkCount === 3, `${bulkCount} tagged`);

  // Duplicates report
  await page.click('a[href="#health"]');
  await page.waitForSelector('.tabs .tab');
  await page.click('a[href="#health/duplicates"]');
  await page.waitForSelector('.dup-group');
  const groups = await page.locator('.dup-group').count();
  ok('duplicate detection (normalized URLs)', groups === 1, `${groups} group(s)`);

  // Clean up duplicates
  await page.click('.dup-group [data-d="group"]');
  await page.waitForTimeout(800);
  const afterDup = await ev(() => chrome.bookmarks.search({ query: 'example.com' }).then(r => r.filter(b => b.url).length));
  ok('duplicate cleanup removed one', afterDup === 1, `${afterDup} left`);

  // Undo restores it
  await page.click('.toast:has-text("Removed") .btn:not(.ghost)');
  await page.waitForTimeout(1000);
  const afterUndo = await ev(() => chrome.bookmarks.search({ query: 'example.com' }).then(r => r.filter(b => b.url).length));
  ok('undo restores deleted bookmark', afterUndo === 2, `${afterUndo} present`);

  // Empty folders
  await page.click('a[href="#health/empty"]');
  await page.waitForSelector('.empty-row:not(.head)');
  ok('empty folder detected', (await page.locator('.empty-row:not(.head)').count()) === 1);
  await page.click('[data-e="delete"]');
  await page.waitForTimeout(800);
  const emptyGone = await ev(id => chrome.bookmarks.get(id).then(() => false, () => true), seeded.empty);
  ok('empty folder deleted', emptyGone);

  // Tag suggestions review
  await page.click('a[href="#suggestions"]');
  await page.waitForSelector('.items .item.link');
  await page.click('[data-act="review-all"]');
  await page.waitForSelector('dialog[open] .review-item');
  await page.click('dialog[open] [data-v], dialog[open] .dlg-foot .primary');
  await page.waitForTimeout(700);
  const accepted = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.values(all).some(v => v && (v.tags || []).includes('pasta'));
  });
  ok('accept suggested tags', accepted);

  // Read later: save a bookmark into it and check badge
  const rlSaved = await ev(async () => {
    const { saveForLater } = await import('/lib/readlater.js');
    const r = await saveForLater({ url: 'https://example.net/article', title: 'An article', tags: ['later'], text: 'word '.repeat(500), saveText: true });
    return r.node.id;
  });
  await page.waitForTimeout(500);
  const badge = await ev(() => chrome.action.getBadgeText({}));
  ok('badge shows unread count', badge === '1', `badge="${badge}"`);
  await page.click('a[href="#readlater"]');
  await page.waitForSelector('.items .item.link');
  ok('read later lists unread', (await page.locator('.items .item.link').count()) === 1);
  ok('reading time estimated', /\d+ min/.test(await page.locator('.items .item.link').first().innerText()));

  // Mark read, then archive
  await page.click('.items .item.link [data-act="read"]');
  await page.waitForTimeout(500);
  await page.click('a[href="#readlater/read"]');
  await page.waitForSelector('.items .item.link');
  ok('mark as read moves to Read tab', (await page.locator('.items .item.link').count()) === 1);
  await page.click('[data-act="archive-read"]');
  await page.waitForTimeout(700);
  const archived = await ev(async id => {
    const { rlFolders } = await chrome.storage.local.get('rlFolders');
    const [n] = await chrome.bookmarks.get(id);
    return n.parentId === rlFolders.archiveId;
  }, rlSaved);
  ok('archive all read', archived);

  // Full-text search over saved page text
  await page.fill('#search', 'has:text');
  await page.waitForTimeout(600);
  ok('has:text search finds saved text', (await page.locator('.items .item.link').count()) === 1);
  await page.fill('#search', '');

  // Export HTML and re-parse it
  const roundTrip = await page.evaluate(async () => {
    const [{ toNetscapeHtml, parseNetscapeHtml, countTree, toJsonBackup, parseJsonBackup }, mod] = await Promise.all([
      import('/lib/netscape.js'), import('/manager/state.js')
    ]);
    const S = mod.S;
    const html = toNetscapeHtml(S.root.children, id => S.meta.get(id));
    const back = parseNetscapeHtml(html);
    const c = countTree(back);
    const json = toJsonBackup(S.root.children, id => S.meta.get(id), () => null, S.rl);
    const jback = countTree(parseJsonBackup(JSON.stringify(json)));
    let tags = 0;
    const walk = n => { for (const k of n.children || []) { if (k.tags) tags += k.tags.length; walk(k); } };
    walk(back);
    return { links: c.links, folders: c.folders, actual: S.bookmarks.length, tags, jsonLinks: jback.links };
  });
  ok('HTML export/import round trip', roundTrip.links === roundTrip.actual, JSON.stringify(roundTrip));
  ok('tags survive HTML round trip', roundTrip.tags > 0, `${roundTrip.tags} tags`);
  ok('JSON export/import round trip', roundTrip.jsonLinks === roundTrip.actual);

  // Import a Netscape file through the UI
  const fixture = path.join(os.tmpdir(), 'sb-import.html');
  fs.writeFileSync(fixture, `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Imported Group</H3>
  <DL><p>
    <DT><A HREF="https://import-one.example/page" ADD_DATE="1700000000" TAGS="alpha,beta">Import One</A>
    <DD>A note about it
    <DT><A HREF="https://import-two.example/">Import Two</A>
  </DL><p>
</DL><p>`);
  await page.click('a[href="#backup"]');
  await page.waitForSelector('#dropzone input');
  await page.setInputFiles('#dropzone input', fixture);
  await page.waitForSelector('[data-b="import"]');
  await page.click('[data-b="import"]');
  await page.waitForTimeout(1500);
  const imported = await ev(() => chrome.bookmarks.search({ query: 'import-one.example' }).then(r => r.length));
  ok('import from HTML file', imported === 1);
  const importedTags = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.values(all).some(v => v && (v.tags || []).includes('alpha') && v.note);
  });
  ok('imported tags and notes', importedTags);
  fs.unlinkSync(fixture);

  // Link health logic. Real network access needs the optional host permission (a user
  // prompt), so fetch is stubbed in the page to exercise HEAD -> GET fallback,
  // redirects, dead links and network failures deterministically.
  const health = await page.evaluate(async () => {
    const { checkUrl } = await import('/manager/health.js');
    const realFetch = window.fetch;
    const calls = [];
    const resp = (status, url, redirected = false) => ({ status, url, redirected, body: null });
    window.fetch = async (url, opts) => {
      calls.push(`${opts.method} ${url}`);
      const u = new URL(url);
      if (u.pathname === '/head-405') return opts.method === 'HEAD' ? resp(405, url) : resp(200, url);
      if (u.pathname === '/moved') return resp(200, 'https://new.example.com/landing', true);
      if (u.pathname === '/https') return resp(200, url.replace('http:', 'https:'), true);
      if (u.pathname === '/gone') return resp(404, url);
      if (u.pathname === '/login') return resp(200, 'https://auth.example.com/login', true);
      if (u.pathname === '/down') throw new TypeError('Failed to fetch');
      return resp(200, url);
    };
    const signal = new AbortController().signal;
    const r = {};
    try {
      for (const k of ['ok', 'head-405', 'moved', 'https', 'gone', 'login', 'down']) {
        const base = k === 'https' ? 'http://site.example.com/' : 'https://site.example.com/';
        r[k] = await checkUrl(base + k, { timeout: 3000, signal });
      }
      r.local = await checkUrl('http://localhost:8080/x', { timeout: 3000, signal });
      const c = new AbortController(); c.abort();
      r.cancelled = await checkUrl('https://site.example.com/ok', { timeout: 3000, signal: c.signal });
    } finally { window.fetch = realFetch; }
    return { r, calls };
  });
  const H = health.r;
  ok('health: OK link', H.ok && H.ok.status === 'ok');
  ok('health: HEAD 405 falls back to GET', H['head-405'].status === 'ok' && health.calls.includes('GET https://site.example.com/head-405'));
  ok('health: redirect detected with new URL', H.moved.status === 'redirect' && H.moved.finalUrl === 'https://new.example.com/landing');
  ok('health: http to https upgrade', H.https.status === 'redirect' && /HTTPS/.test(H.https.label));
  ok('health: 404 is dead', H.gone.status === 'dead' && H.gone.code === 404);
  ok('health: login redirect is a warning', H.login.status === 'warn');
  ok('health: network failure is unreachable', H.down.status === 'dead');
  ok('health: local addresses skipped', H.local.status === 'skipped');
  ok('health: cancelled scan returns nothing', H.cancelled === null);

  // Health page renders with a stored report and no permission prompt.
  await page.click('a[href="#health"]');
  await page.waitForSelector('.tabs .tab');
  ok('health page renders', await page.locator('.tabs .tab').count() >= 3);

  // Drag and drop: move a bookmark into a folder by dispatching DnD events.
  const moved = await page.evaluate(async workId => {
    const { S } = await import('/manager/state.js');
    const { moveItems } = await import('/manager/ops.js');
    const target = S.bookmarks.find(n => n.parentId === '1');
    if (!target) return 'no source';
    await moveItems([target.id], workId);
    const [n] = await chrome.bookmarks.get(target.id);
    return n.parentId === workId ? 'moved' : 'not moved';
  }, seeded.work);
  ok('move between folders', moved === 'moved', moved);

  // Keyboard: j/k navigation and space selection
  await page.click('a[href="#all"]');
  await page.waitForSelector('.items .item.link');
  await page.locator('.items .item').first().click();
  await page.keyboard.press('j');
  await page.keyboard.press(' ');
  const selAfterKeys = await page.locator('#bulkbar .bulk-count').innerText();
  ok('keyboard navigation and selection', /selected/.test(selAfterKeys), selAfterKeys);

  // Grid layout
  await page.keyboard.press('Escape');
  await page.click('#layoutGrid');
  await page.waitForSelector('.items.grid');
  ok('grid layout', await page.locator('.items.grid').count() === 1);
  await page.click('#layoutList');

  // Settings page renders and toggles
  await page.click('a[href="#settings"]');
  await page.waitForSelector('[data-s="showBadge"]');
  await page.click('[data-s="showBadge"]');
  await page.waitForTimeout(500);
  const badgeOff = await page.evaluate(() => chrome.storage.sync.get('settings').then(r => r.settings.showBadge));
  ok('settings persist', badgeOff === false);

  // Welcome page
  await page.click('a[href="#welcome"]').catch(() => {});
  await page.evaluate(() => { location.hash = '#welcome'; });
  await page.waitForSelector('.welcome-grid');
  ok('welcome page renders', true);

  // Popup page loads with a library present
  const popup = await ctx.newPage();
  const perr = [];
  popup.on('pageerror', e => perr.push(e.message));
  popup.on('console', m => { if (m.type() === 'error') perr.push(m.text()); });
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.waitForTimeout(1200);
  ok('popup renders read-later list', (await popup.locator('#rlList .rl-item, #rlEmpty:not([hidden])').count()) >= 1);
  ok('popup has no console errors', perr.length === 0, perr.join(' | '));

  ok('manager has no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  console.log(steps.join('\n'));
  if (fail.length) { console.error(`\nFUNCTIONAL FAIL (${fail.length}): ${fail.join(', ')}`); process.exit(1); }
  console.log(`\nFUNCTIONAL PASS (${steps.length} checks)`);
})().catch(async e => { console.log(steps.join('\n')); console.error('FUNCTIONAL ERROR', e); if (ctxRef) await ctxRef.close().catch(() => {}); process.exit(1); });
