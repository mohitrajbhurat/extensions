#!/usr/bin/env node
// Unit tests for the pure engine and the storage layer (chrome.storage mocked).
// Usage: node type-kit/test/unit.test.js
'use strict';
const path = require('path');
const assert = require('assert');

const mem = {};
global.self = global;
global.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (k in mem) out[k] = JSON.parse(JSON.stringify(mem[k]));
        cb(out);
      },
      set(obj, cb) { for (const [k, v] of Object.entries(obj)) mem[k] = JSON.parse(JSON.stringify(v)); cb && cb(); },
    },
  },
};
require(path.join(__dirname, '..', 'shared', 'engine.js'));
require(path.join(__dirname, '..', 'shared', 'store.js'));
const E = global.TKEngine, S = global.TKStore;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const NOW = new Date(2026, 2, 14, 9, 5, 7); // Sat 14 Mar 2026 09:05:07 local

/* ---------- engine ---------- */

test('formatDate tokens', () => {
  assert.strictEqual(E.formatDate(NOW, 'YYYY-MM-DD'), '2026-03-14');
  assert.strictEqual(E.formatDate(NOW, 'dddd, MMMM Do YYYY'), 'Saturday, March 14th 2026');
  assert.strictEqual(E.formatDate(NOW, 'h:mm A'), '9:05 AM');
  assert.strictEqual(E.formatDate(NOW, 'HH:mm:ss'), '09:05:07');
  assert.strictEqual(E.formatDate(NOW, '[Week] WW'), 'Week 11');
});

test('date offsets', () => {
  assert.strictEqual(E.render('{date:+3d:YYYY-MM-DD}', { now: NOW }).text, '2026-03-17');
  assert.strictEqual(E.render('{date:-1w:YYYY-MM-DD}', { now: NOW }).text, '2026-03-07');
  assert.strictEqual(E.render('{date:+1M-1d:YYYY-MM-DD}', { now: NOW }).text, '2026-04-13');
  assert.strictEqual(E.render('{time:+90m:HH:mm}', { now: NOW }).text, '10:35');
  assert.strictEqual(E.render('{date}', { now: NOW, settings: { dateFormat: 'DD/MM/YYYY' } }).text, '14/03/2026');
  assert.strictEqual(E.render('{time}', { now: NOW }).text, '09:05');
});

test('cursor, clipboard, literal braces, unknown placeholders', () => {
  const r = E.render('Hi {cursor}there', {});
  assert.strictEqual(r.text, 'Hi there');
  assert.strictEqual(r.cursor, 3);
  assert.strictEqual(E.render('[{clipboard}]', { clips: [{ text: 'abc' }, { text: 'old' }] }).text, '[abc]');
  assert.strictEqual(E.render('{clipboard:2}', { clips: [{ text: 'abc' }, { text: 'old' }] }).text, 'old');
  assert.strictEqual(E.render('{{x}} {nope}', {}).text, '{x} {nope}');
  assert.strictEqual(E.render('a { b }', {}).text, 'a { b }');
});

test('fill-in fields and select', () => {
  const body = 'Hi {input:First name}, status {select:Status:Green|Red}. Bye {input:First name}. {select:A|B}';
  const fields = E.collectFields(body, {});
  assert.deepStrictEqual(fields.map((f) => [f.type, f.label]), [['input', 'First name'], ['select', 'Status'], ['select', 'Choose']]);
  assert.deepStrictEqual(fields[1].options, ['Green', 'Red']);
  const r = E.render(body, { values: { 'first name': 'Ana', status: 'Red', choose: 'B' } });
  assert.strictEqual(r.text, 'Hi Ana, status Red. Bye Ana. B');
  assert.strictEqual(r.missingFields.length, 0);
  const multi = E.collectFields('{input:Notes:multiline}', {})[0];
  assert.strictEqual(multi.multiline, true);
  const def = E.collectFields('{input:City:Austin}', {})[0];
  assert.strictEqual(def.default, 'Austin');
});

test('nested snippets, cycles and fields through nesting', () => {
  const snippets = [
    { id: 'a', shortcut: '/sig', body: 'Regards, {input:Sender}' },
    { id: 'b', shortcut: '/mail', body: 'Hello\n{snippet:/sig}' },
    { id: 'c', shortcut: '/loop', body: 'x{snippet:/loop}' },
    { id: 'd', shortcut: '/rich', format: 'rich', body: '<b>Bold</b>' },
  ];
  assert.deepStrictEqual(E.collectFields('{snippet:/mail}', { snippets }).map((f) => f.label), ['Sender']);
  assert.strictEqual(E.render('{snippet:/mail}', { snippets, values: { sender: 'Mo' } }).text, 'Hello\nRegards, Mo');
  assert.strictEqual(E.render('{snippet:/loop}', { snippets }).text, 'x');
  assert.strictEqual(E.render('{snippet:/rich}', { snippets }).text, 'Bold');
  assert.strictEqual(E.render('{snippet:/rich}', { snippets, rich: true }).text, '<b>Bold</b>');
});

test('rich rendering escapes inserted values', () => {
  const r = E.render('<p>{input:X}</p>', { rich: true, values: { x: '<script>&' } });
  assert.strictEqual(r.text, '<p>&lt;script&gt;&amp;</p>');
});

test('findShortcut: instant mode, prefixes, word boundary, case', () => {
  const sn = [
    { id: '1', shortcut: '/sig' }, { id: '2', shortcut: '/signature' }, { id: '3', shortcut: ';addr' },
    { id: '4', shortcut: 'brb' }, { id: '5', shortcut: '/off', enabled: false },
  ];
  assert.strictEqual(E.findShortcut('hello ;addr', sn, {}).snippet.id, '3');
  assert.strictEqual(E.findShortcut('x /sig', sn, {}), null, 'waits because /signature is longer');
  assert.strictEqual(E.findShortcut('x /sig', sn, {}, { force: true }).snippet.id, '1');
  assert.strictEqual(E.findShortcut('x /signature', sn, {}).snippet.id, '2');
  assert.strictEqual(E.findShortcut('abrb', sn, {}), null, 'word boundary');
  assert.strictEqual(E.findShortcut('ok brb', sn, {}).snippet.id, '4');
  assert.strictEqual(E.findShortcut('ok BRB', sn, {}).snippet.id, '4');
  assert.strictEqual(E.findShortcut('ok BRB', sn, { caseSensitive: true }), null);
  assert.strictEqual(E.findShortcut('/off', sn, {}), null, 'disabled snippets never expand');
  const m = E.findShortcut('see ;addr ', sn, { triggerMode: 'space' });
  assert.strictEqual(m.snippet.id, '3');
  assert.strictEqual(m.trailing, ' ');
  assert.strictEqual(E.findShortcut('see ;addr', sn, { triggerMode: 'space' }), null);
});

test('fuzzy search ranks prefix/word starts first', () => {
  const items = [{ n: 'Meeting follow-up' }, { n: 'Signature' }, { n: 'Status update' }];
  const res = E.search('sig', items, (x) => [x.n]);
  assert.strictEqual(res[0].item.n, 'Signature');
  assert.strictEqual(E.fuzzy('zz', 'abc'), null);
  assert.strictEqual(E.search('fu', items, (x) => [x.n])[0].item.n, 'Meeting follow-up');
});

test('htmlToText and textToHTML', () => {
  assert.strictEqual(E.htmlToText('<p>a</p><p>b &amp; c</p>'), 'a\nb & c');
  assert.strictEqual(E.textToHTML('a<\nb'), 'a&lt;<br>b');
});

/* ---------- store ---------- */

test('starter data is seeded once', async () => {
  const d = await S.loadAll();
  assert.ok(d.snippets.length >= 5);
  assert.ok(d.snippets.some((s) => s.shortcut === '/sig'));
  assert.strictEqual(d.settings.expanderEnabled, true);
  const again = await S.loadAll();
  assert.deepStrictEqual(again.snippets.map((s) => s.id), d.snippets.map((s) => s.id));
});

test('snippet CRUD and usage stats', async () => {
  const s = await S.upsertSnippet({ name: 'Test', shortcut: '/t', body: 'hello world' });
  await S.recordUse(s.id, 11, 2);
  await S.recordUse(s.id, 11, 2);
  const got = (await S.getSnippets()).find((x) => x.id === s.id);
  assert.strictEqual(got.uses, 2);
  assert.strictEqual(got.charsSaved, 18);
  const st = await S.stats();
  assert.ok(st.uses >= 2);
  assert.ok(st.secondsSaved > 0);
  const dup = await S.duplicateSnippet(s.id);
  assert.strictEqual(dup.shortcut, '/t2');
  await S.deleteSnippet(dup.id);
  assert.ok(!(await S.getSnippets()).some((x) => x.id === dup.id));
});

test('folders: delete moves snippets to General', async () => {
  const f = await S.addFolder('Temp');
  const s = await S.upsertSnippet({ name: 'In temp', shortcut: '/tmp', body: 'x', folderId: f.id });
  await S.deleteFolder(f.id);
  assert.strictEqual((await S.getSnippets()).find((x) => x.id === s.id).folderId, 'f_general');
  assert.ok(!(await S.getFolders()).some((x) => x.id === f.id));
});

test('clipboard history: dedupe, limit, pin, exclusions, expiry', async () => {
  await S.saveSettings({ historyLimit: 5, excludedSites: ['*.bank.com'], minClipLength: 2 });
  for (let i = 0; i < 8; i++) await S.addClip({ text: 'item ' + i, url: 'https://example.com/' });
  let clips = await S.getClips();
  assert.strictEqual(clips.length, 5);
  assert.strictEqual(clips[0].text, 'item 7');
  await S.updateClip(clips[4].id, { pinned: true });
  await S.addClip({ text: 'item 3', url: 'https://example.com/' });      // duplicate moves to top
  clips = await S.getClips();
  assert.strictEqual(clips.filter((c) => c.text === 'item 3').length, 1);
  assert.ok(clips[0].pinned, 'pinned first');
  assert.strictEqual((await S.addClip({ text: 'secret', url: 'https://online.bank.com/x' })).skipped, 'excluded');
  assert.strictEqual((await S.addClip({ text: 'a', url: 'https://example.com/' })).skipped, 'too-short');
  // expiry
  const raw = await S.getClips();
  raw.forEach((c) => { if (!c.pinned) c.createdAt = new Date(Date.now() - 5 * 86400000).toISOString(); });
  mem['tk.clips'] = raw;
  await S.saveSettings({ historyExpiryDays: 2 });
  clips = await S.getClips();
  assert.ok(clips.every((c) => c.pinned), 'expired unpinned items removed');
  assert.strictEqual(await S.clearClips(true), clips.length);
  await S.clearClips(false);
  assert.strictEqual((await S.getClips()).length, 0);
  await S.saveSettings({ historyExpiryDays: 0, historyLimit: 100 });
  await S.saveSettings({ historyEnabled: false });
  assert.strictEqual((await S.addClip({ text: 'off now' })).skipped, 'disabled');
  await S.saveSettings({ historyEnabled: true });
});

test('hostMatches', () => {
  assert.ok(S.hostMatches('a.bank.com', '*.bank.com'));
  assert.ok(S.hostMatches('bank.com', '*.bank.com'));
  assert.ok(S.hostMatches('mail.google.com', 'google.com'));
  assert.ok(!S.hostMatches('notbank.com', 'bank.com'));
  assert.ok(S.hostMatches('x.corp.internal', 'x.*.internal'));
});

test('CSV round trip with quotes, commas and newlines', async () => {
  const csv = S.toCSV([['shortcut', 'body'], ['/q', 'He said "hi", then\nleft']]);
  assert.deepStrictEqual(S.parseCSV(csv), [['shortcut', 'body'], ['/q', 'He said "hi", then\nleft']]);
  const r = await S.importData('shortcut,name,folder,body\n/csv1,From CSV,Imported,"line1\nline2"\n', 'merge');
  assert.strictEqual(r.added, 1);
  const s = (await S.getSnippets()).find((x) => x.shortcut === '/csv1');
  assert.strictEqual(s.body, 'line1\nline2');
  assert.strictEqual((await S.getFolders()).find((f) => f.id === s.folderId).name, 'Imported');
  const out = await S.exportCSV();
  assert.ok(out.includes('/csv1'));
});

test('JSON export/import: merge, skip and replace', async () => {
  const json = await S.exportJSON();
  const data = JSON.parse(json);
  assert.strictEqual(data.app, 'type-kit');
  const before = (await S.getSnippets()).length;
  const sig = data.snippets.find((x) => x.shortcut === '/sig');
  sig.body = 'Changed signature';
  let r = await S.importData(JSON.stringify(data), 'skip');
  assert.strictEqual(r.added, 0);
  assert.notStrictEqual((await S.getSnippets()).find((x) => x.shortcut === '/sig').body, 'Changed signature');
  r = await S.importData(JSON.stringify(data), 'merge');
  assert.strictEqual(r.updated, before);
  assert.strictEqual((await S.getSnippets()).find((x) => x.shortcut === '/sig').body, 'Changed signature');
  r = await S.importData(JSON.stringify([{ shortcut: '/only', body: 'one' }]), 'replace');
  assert.strictEqual(r.total, 1);
  assert.throws(() => JSON.parse('{bad'), SyntaxError);
  await assert.rejects(S.importData('{bad json', 'merge'));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
