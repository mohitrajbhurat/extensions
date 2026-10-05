import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, projectFor, categoryFor, segmentProject, inferKind } from '../lib/rules.js';
import { autoItems, manualItems, timesheet, billing, itemsToCSV, splitEntry, mergeEntries, clip, hourly, roundUp, findOverlaps, validateEntry } from '../lib/report.js';
import { evaluateGoals, pendingNotifications } from '../lib/goals.js';
import { parseDuration, fmtDur, startOfWeek, dayKey } from '../lib/util.js';

const H = 3600 * 1000;
const D0 = new Date(2026, 9, 5).getTime(); // Monday

test('URL glob rules: github.com/acme/* maps to Acme', () => {
  const rule = { pattern: 'github.com/acme/*', projectId: 'acme' };
  assert.ok(matchRule(rule, { url: 'https://github.com/acme/app/pulls', domain: 'github.com' }));
  assert.ok(matchRule(rule, { url: 'https://www.github.com/acme/x', domain: 'github.com' }));
  assert.ok(!matchRule(rule, { url: 'https://github.com/other/app', domain: 'github.com' }));
  assert.ok(matchRule({ pattern: 'github.com/acme' }, { url: 'https://github.com/acme/app' }));
});

test('domain rules match subdomains, wildcards and kinds are inferred', () => {
  assert.equal(inferKind('acme.atlassian.net'), 'domain');
  assert.equal(inferKind('github.com/acme'), 'url');
  assert.equal(inferKind('invoice, quarterly'), 'title');
  assert.ok(matchRule({ pattern: 'atlassian.net' }, { domain: 'acme.atlassian.net' }));
  assert.ok(matchRule({ pattern: '*.acme.io' }, { domain: 'acme.io' }));
  assert.ok(!matchRule({ pattern: 'acme.io' }, { domain: 'notacme.io' }));
});

test('title keyword rules and rule order', () => {
  const rules = [
    { pattern: 'thesis, chapter', kind: 'title', projectId: 'thesis' },
    { pattern: 'docs.google.com', projectId: 'docs' },
    { pattern: 'off', projectId: 'never', enabled: false },
  ];
  assert.equal(projectFor({ domain: 'docs.google.com', title: 'Thesis draft - Google Docs' }, rules), 'thesis');
  assert.equal(projectFor({ domain: 'docs.google.com', title: 'Budget' }, rules), 'docs');
  assert.equal(projectFor({ domain: 'example.com', title: 'off topic' }, rules), null);
});

test('explicit assignment beats rules; empty string means no project', () => {
  const rules = [{ pattern: 'a.com', projectId: 'r' }];
  assert.equal(segmentProject({ domain: 'a.com' }, rules), 'r');
  assert.equal(segmentProject({ domain: 'a.com', p: 'x' }, rules), 'x');
  assert.equal(segmentProject({ domain: 'a.com', p: '' }, rules), null);
});

test('categories: user overrides, parent domains, defaults', () => {
  assert.equal(categoryFor('m.youtube.com'), 'distracting');
  assert.equal(categoryFor('github.com'), 'productive');
  assert.equal(categoryFor('youtube.com', { 'youtube.com': 'productive' }), 'productive');
  assert.equal(categoryFor('unknown.example'), 'neutral');
  assert.equal(categoryFor('localhost'), 'productive');
});

test('timesheet grid spreads time across days and projects', () => {
  const items = [
    { start: D0 + 9 * H, end: D0 + 11 * H, projectId: 'a' },
    { start: D0 + 23 * H, end: D0 + 25 * H, projectId: 'b' }, // crosses midnight
    { start: D0 + 30 * H, end: D0 + 31 * H, projectId: null },
  ];
  const from = startOfWeek(D0, 1);
  const ts = timesheet(items, from, from + 7 * 24 * H);
  assert.equal(ts.days.length, 7);
  assert.equal(ts.total, 5 * H);
  const b = ts.rows.find((r) => r.key === 'b');
  assert.deepEqual(b.cells.slice(0, 2), [H, H]);
  assert.equal(ts.dayTotals[0], 3 * H);
  assert.equal(ts.dayTotals[1], 2 * H);
});

test('billing uses project, client, then default rate and respects billable flags', () => {
  const ctx = {
    projects: [
      { id: 'a', name: 'Acme', clientId: 'c1', rate: 100, billable: true },
      { id: 'b', name: 'Beta', clientId: 'c1', rate: '', billable: true },
      { id: 'n', name: 'Internal', billable: false },
    ],
    clients: [{ id: 'c1', name: 'Client One', rate: 50 }],
    settings: { defaultRate: 10, roundMinutes: 15 },
  };
  const items = manualItems([
    { id: '1', start: 0, end: 1.5 * H, projectId: 'a' },
    { id: '2', start: 0, end: 10 * 60 * 1000, projectId: 'b' }, // rounds to 15m
    { id: '3', start: 0, end: H, projectId: 'n' },
    { id: '4', start: 0, end: H, projectId: 'a', billable: false },
  ]);
  const bill = billing(items, ctx);
  const a = bill.rows.find((r) => r.projectId === 'a');
  assert.equal(a.amount, 150);
  assert.equal(a.ms, 2.5 * H);
  const b = bill.rows.find((r) => r.projectId === 'b');
  assert.equal(b.amount, 12.5);
  assert.equal(bill.rows.find((r) => r.projectId === 'n').amount, 0);
  assert.equal(bill.amount, 162.5);
  assert.equal(roundUp(1, 6), 6 * 60 * 1000);
});

test('CSV export escapes and includes amounts', () => {
  const ctx = { projects: [{ id: 'a', name: 'Acme, Inc', rate: 60, billable: true }], clients: [], settings: {} };
  const csv = itemsToCSV(manualItems([{ id: '1', start: D0 + 9 * H, end: D0 + 10 * H, projectId: 'a', desc: 'Said "hi"', tags: ['x', 'y'] }]), ctx);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"Acme, Inc"/);
  assert.match(lines[1], /"Said ""hi"""/);
  assert.match(lines[1], /,1\.00,1:00:00,manual,/);
  assert.match(lines[1], /,60,60\.00$/);
});

test('split and merge entries', () => {
  const e = { id: 'e1', start: 0, end: 2 * H, desc: 'Design', projectId: 'a', tags: ['ui'] };
  const [x, y] = splitEntry(e, H);
  assert.equal(x.end, H);
  assert.equal(y.start, H);
  assert.notEqual(y.id, x.id);
  assert.throws(() => splitEntry(e, 3 * H));
  const m = mergeEntries([y, { ...x, desc: 'Review', tags: ['qa'] }]);
  assert.equal(m.start, 0);
  assert.equal(m.end, 2 * H);
  assert.equal(m.desc, 'Review; Design');
  assert.deepEqual(m.tags.sort(), ['qa', 'ui']);
  assert.deepEqual(findOverlaps([{ id: 1, start: 0, end: 10 }, { id: 2, start: 5, end: 20 }]), [[1, 2]]);
  assert.equal(validateEntry({ start: 10, end: 5 }).length, 1);
});

test('auto items, clipping and hourly buckets', () => {
  const items = autoItems([{ start: D0 + 9.5 * H, end: D0 + 10.25 * H, url: 'https://youtube.com/w', domain: 'youtube.com' }], []);
  assert.equal(items[0].category, 'distracting');
  const h = hourly(items, D0);
  assert.equal(h.distracting[9], 0.5 * H);
  assert.equal(h.distracting[10], 0.25 * H);
  assert.equal(clip(items, D0 + 10 * H, D0 + 11 * H)[0].start, D0 + 10 * H);
});

test('goals and limits produce notifications once', () => {
  const items = autoItems([
    { start: 0, end: 70 * 60 * 1000, url: 'u', domain: 'reddit.com' },
    { start: 0, end: 30 * 60 * 1000, url: 'u2', domain: 'github.com' },
  ], []);
  const goals = [
    { id: 'l', kind: 'limit', scope: 'category', target: 'distracting', minutes: 60 },
    { id: 'g', kind: 'goal', scope: 'domain', target: 'github.com', minutes: 30 },
    { id: 'w', kind: 'limit', scope: 'total', minutes: 120 },
  ];
  const res = evaluateGoals(goals, items);
  assert.deepEqual(res.map((r) => r.status), ['exceeded', 'reached', 'warning']);
  const n1 = pendingNotifications(res, {});
  assert.equal(n1.length, 3);
  const notified = Object.fromEntries(n1.map((n) => [n.key, 1]));
  assert.equal(pendingNotifications(res, notified).length, 0);
});

test('duration parsing and formatting', () => {
  assert.equal(parseDuration('1:30'), 1.5 * H);
  assert.equal(parseDuration('1h 15m'), 1.25 * H);
  assert.equal(parseDuration('45m'), 0.75 * H);
  assert.equal(parseDuration('2.5'), 2.5 * H);
  assert.ok(Number.isNaN(parseDuration('abc')));
  assert.equal(fmtDur(3.5 * H), '3h 30m');
  assert.equal(dayKey(D0), '2026-10-05');
});
