// Run: node --test home-base/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTask, buildView, toggleComplete, removeTask, moveTask, counts, reminderTime, ensureProject } from '../lib/tasks.js';
import { currentStreak, bestStreak } from '../lib/habits.js';
import * as pomo from '../lib/pomodoro.js';
import { renderMarkdown, toggleTaskLine } from '../lib/markdown.js';
import { validateBackup, withDefaults } from '../lib/store.js';

const T = '2026-10-05';
const mk = (id, f) => makeTask({ order: Number(id.replace(/\D/g, '')) || 1, ...f }, id);

test('buildView today includes overdue section and hides subtasks under parents', () => {
  const tasks = [mk('t1', { title: 'a', date: T }), mk('t2', { title: 'b', date: '2026-10-01' }), mk('t3', { title: 'c', parentId: 't1', date: T }), mk('t4', { title: 'd', date: '2026-10-09' })];
  const v = buildView(tasks, 'today', T);
  assert.deepEqual(v.map((s) => s.key), ['overdue', T]);
  assert.deepEqual(v[1].tasks.map((t) => t.id), ['t1']);
  const up = buildView(tasks, 'upcoming', T);
  assert.equal(up.length, 7);
  assert.ok(up.find((s) => s.key === '2026-10-09').tasks.some((t) => t.id === 't4'));
});

test('completing a parent completes subtasks; recurring tasks roll forward', () => {
  const tasks = [mk('t1', { title: 'p' }), mk('t2', { title: 'c', parentId: 't1' }),
    mk('t3', { title: 'r', date: T, recur: { kind: 'weekly', interval: 1, weekdays: [1], anchor: T } })];
  const a = toggleComplete(tasks, 't1', T, 1);
  assert.ok(a.tasks.every((t) => t.id === 't3' || t.done));
  const b = toggleComplete(tasks, 't3', T, 1);
  assert.equal(b.rolledTo, '2026-10-12');
  assert.equal(b.tasks.find((t) => t.id === 't3').done, false);
  const back = toggleComplete(a.tasks, 't1', T);
  assert.equal(back.tasks.find((t) => t.id === 't1').done, false);
});

test('overdue recurring task skips to the next occurrence on or after today', () => {
  const tasks = [mk('t1', { title: 'r', date: '2026-09-01', recur: { kind: 'daily', interval: 1, anchor: '2026-09-01' } })];
  assert.equal(toggleComplete(tasks, 't1', T).rolledTo, T);
});

test('removeTask removes descendants; moveTask reorders', () => {
  const tasks = [mk('t1', {}), mk('t2', { parentId: 't1' }), mk('t3', { parentId: 't2' }), mk('t4', {})];
  assert.deepEqual(removeTask(tasks, 't1').map((t) => t.id), ['t4']);
  const list = [mk('a1', { order: 1 }), mk('a2', { order: 2 }), mk('a3', { order: 3 })];
  const moved = moveTask(list, 'a3', list, 'a1');
  const sorted = moved.slice().sort((x, y) => x.order - y.order).map((t) => t.id);
  assert.deepEqual(sorted, ['a3', 'a1', 'a2']);
});

test('counts and reminder time', () => {
  const tasks = [mk('t1', { date: T }), mk('t2', { date: '2026-10-01' }), mk('t3', { date: T, done: true })];
  const c = counts(tasks, T);
  assert.equal(c.today, 1);
  assert.equal(c.overdue, 1);
  assert.equal(c.badge, 2);
  const t = mk('t9', { date: T, time: '17:00' });
  assert.equal(reminderTime(t, 10), new Date(2026, 9, 5, 16, 50).getTime());
  assert.equal(reminderTime(mk('x', { date: T }), 0), null);
});

test('ensureProject matches case-insensitively or creates', () => {
  const ps = [{ id: 'inbox', name: 'Inbox' }, { id: 'work', name: 'Work' }];
  assert.equal(ensureProject(ps, 'WORK', () => 'n').project.id, 'work');
  const r = ensureProject(ps, 'garden', () => 'p1');
  assert.equal(r.project.name, 'Garden');
  assert.equal(r.projects.length, 3);
});

test('habit streaks', () => {
  const days = { '2026-10-03': 1, '2026-10-04': 1, '2026-10-05': 1, '2026-09-01': 1, '2026-09-02': 1, '2026-09-03': 1, '2026-09-04': 1 };
  assert.equal(currentStreak(days, T), 3);
  assert.equal(currentStreak({ '2026-10-04': 1 }, T), 1); // today not done yet still counts yesterday
  assert.equal(currentStreak({ '2026-10-03': 1 }, T), 0);
  assert.equal(bestStreak(days), 4);
});

test('pomodoro cycles to a long break every N sessions', () => {
  const cfg = { work: 25, short: 5, long: 15, every: 2, autoStart: false };
  let s = { mode: 'work', running: false, endsAt: 0, remaining: 0, cycle: 0, day: '', doneToday: 0 };
  s = pomo.start(s, cfg, 0);
  assert.equal(s.endsAt, 25 * 60000);
  assert.ok(pomo.isDue(s, 25 * 60000));
  s = pomo.advance(s, cfg, T, 25 * 60000);
  assert.equal(s.mode, 'short');
  assert.equal(s.doneToday, 1);
  s = pomo.advance(s, cfg, T);
  assert.equal(s.mode, 'work');
  s = pomo.advance(s, cfg, T);
  assert.equal(s.mode, 'long');
  const p = pomo.pause(pomo.start(s, cfg, 0), cfg, 60000);
  assert.equal(p.remaining, 14 * 60000);
  assert.equal(pomo.fmt(61000), '01:01');
});

test('markdown escapes HTML and renders task lists', () => {
  const html = renderMarkdown('# Hi <script>\n- [ ] one\n- [x] two\n[x](javascript:alert(1))');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-line="1"'));
  assert.ok(!html.includes('href="javascript'));
  assert.equal(toggleTaskLine('- [ ] a\n- [x] b', 0), '- [x] a\n- [x] b');
});

test('backup validation', () => {
  assert.throws(() => validateBackup({ app: 'other', data: {} }));
  assert.throws(() => validateBackup({ app: 'home-base', data: { tasks: {} } }));
  const ok = validateBackup({ app: 'home-base', data: { tasks: [{ id: 'a', title: 'x' }], junk: 1 } });
  assert.deepEqual(Object.keys(ok), ['tasks']);
  assert.deepEqual(withDefaults({ a: 1, b: { c: 2 } }, { b: {} }), { a: 1, b: { c: 2 } });
});
