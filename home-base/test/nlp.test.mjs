// Run: node --test home-base/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, parseDateText, matchesRecur, firstOccurrence, nextOccurrence, describeRecur } from '../lib/nlp.js';
import { ymd } from '../lib/dates.js';

// Monday, 5 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 5, 10, 0, 0);
const p = (s, now = NOW) => parseTask(s, now);

test('plain text stays a plain title', () => {
  const r = p('Buy milk');
  assert.equal(r.title, 'Buy milk');
  assert.equal(r.date, null);
  assert.equal(r.time, null);
  assert.equal(r.recur, null);
  assert.equal(r.priority, 4);
});

test('today / tomorrow / yesterday / tonight', () => {
  assert.equal(p('pay rent today').date, '2026-10-05');
  assert.equal(p('pay rent tomorrow').date, '2026-10-06');
  assert.equal(p('tmr standup').date, '2026-10-06');
  assert.equal(p('call mum yesterday').date, '2026-10-04');
  const t = p('dinner tonight');
  assert.equal(t.date, '2026-10-05');
  assert.equal(t.time, '20:00');
  assert.equal(t.title, 'Dinner');
  assert.equal(p('ship it day after tomorrow').date, '2026-10-07');
});

test('tomorrow 5pm sets date and time and strips both', () => {
  const r = p('submit report tomorrow 5pm');
  assert.equal(r.title, 'Submit report');
  assert.equal(r.date, '2026-10-06');
  assert.equal(r.time, '17:00');
});

test('time formats', () => {
  assert.equal(p('x at 9am').time, '09:00');
  assert.equal(p('x 9:30am').time, '09:30');
  assert.equal(p('x 5:45 pm').time, '17:45');
  assert.equal(p('x at 17:00').time, '17:00');
  assert.equal(p('x at 7').time, '19:00');
  assert.equal(p('x at 11').time, '11:00');
  assert.equal(p('x at noon').time, '12:00');
  assert.equal(p('x midnight').time, '00:00');
  assert.equal(p('yoga in the morning').time, '09:00');
  assert.equal(p('yoga in the morning').title, 'Yoga');
  assert.equal(p('x 12pm').time, '12:00');
  assert.equal(p('x 12am').time, '00:00');
});

test('a bare time rolls to tomorrow once it has passed', () => {
  assert.equal(p('standup 9am').date, '2026-10-06');
  assert.equal(p('standup 11am').date, '2026-10-05');
});

test('weekday names pick the coming weekday; "next" jumps a week', () => {
  assert.equal(p('gym friday').date, '2026-10-09');
  assert.equal(p('gym fri').date, '2026-10-09');
  assert.equal(p('review next fri').date, '2026-10-16');
  assert.equal(p('review next friday').date, '2026-10-16');
  assert.equal(p('team sync monday').date, '2026-10-05');
  assert.equal(p('team sync next monday').date, '2026-10-12');
  assert.equal(p('x on thursday').date, '2026-10-08');
  assert.equal(p('x this coming sun').date, '2026-10-11');
  assert.equal(p('1:1 with sam on tues at 3pm').date, '2026-10-06');
  assert.equal(p('1:1 with sam on tues at 3pm').time, '15:00');
});

test('relative offsets', () => {
  assert.equal(p('ping in 3 days').date, '2026-10-08');
  assert.equal(p('ping in two weeks').date, '2026-10-19');
  assert.equal(p('renew in 1 month').date, '2026-11-05');
  assert.equal(p('passport in 2 years').date, '2028-10-05');
  const h = p('tea in 90 minutes');
  assert.equal(h.date, '2026-10-05');
  assert.equal(h.time, '11:30');
  assert.equal(p('break in 2 hours').time, '12:00');
});

test('next week / month / year and end-of periods', () => {
  assert.equal(p('plan next week').date, '2026-10-12');
  assert.equal(p('invoice next month').date, '2026-11-05');
  assert.equal(p('taxes next year').date, '2027-10-05');
  assert.equal(p('report end of week').date, '2026-10-11');
  assert.equal(p('close books end of month').date, '2026-10-31');
  assert.equal(p('wrap up end of the year').date, '2026-12-31');
  assert.equal(p('kpis end of quarter').date, '2026-12-31');
});

test('explicit calendar dates, with year roll-forward', () => {
  assert.equal(p('conference oct 12').date, '2026-10-12');
  assert.equal(p('conference October 12th').date, '2026-10-12');
  assert.equal(p('party 12 oct').date, '2026-10-12');
  assert.equal(p('party on 3rd of january').date, '2027-01-03');
  assert.equal(p('flight jan 5 2028').date, '2028-01-05');
  assert.equal(p('deadline 2026-12-01').date, '2026-12-01');
  assert.equal(p('deadline 12/1').date, '2026-12-01');
  assert.equal(p('deadline 12/1/2027').date, '2027-12-01');
  assert.equal(p('deadline 2026-12-01').title, 'Deadline');
});

test('an out-of-range day clamps to a valid one', () => {
  assert.equal(p('x feb 30').date, '2027-02-28');
});

test('priority, project and labels', () => {
  const r = p('Email the board p1 #work @email');
  assert.equal(r.title, 'Email the board');
  assert.equal(r.priority, 1);
  assert.equal(r.project, 'work');
  assert.deepEqual(r.labels, ['email']);
  assert.equal(p('urgent thing !!!').priority, 1);
  assert.equal(p('mild thing !').priority, 3);
  assert.equal(p('x !2').priority, 2);
  const multi = p('ship #app @dev @ops');
  assert.deepEqual(multi.labels, ['dev', 'ops']);
  assert.equal(multi.title, 'Ship');
});

test('recurrence: daily, weekly, monthly, yearly', () => {
  assert.deepEqual(p('water plants every day').recur,
    { kind: 'daily', interval: 1, anchor: '2026-10-05' });
  assert.equal(p('water plants every day').title, 'Water plants');
  assert.equal(p('standup daily').recur.kind, 'daily');
  assert.equal(p('x every 3 days').recur.interval, 3);
  assert.equal(p('x every other day').recur.interval, 2);
  const w = p('team sync every monday');
  assert.equal(w.recur.kind, 'weekly');
  assert.deepEqual(w.recur.weekdays, [1]);
  assert.equal(w.date, '2026-10-05');
  const wd = p('standup every weekday');
  assert.deepEqual(wd.recur.weekdays, [1, 2, 3, 4, 5]);
  const two = p('groceries every mon and thu');
  assert.deepEqual(two.recur.weekdays, [1, 4]);
  assert.equal(p('rent every month').recur.kind, 'monthly');
  assert.equal(p('rent every 15th').recur.day, 15);
  assert.equal(p('rent every 15th').date, '2026-10-15');
  assert.equal(p('payroll every last day of month').recur.day, -1);
  assert.equal(p('payroll every last day of month').date, '2026-10-31');
  assert.equal(p('x every 2 weeks').recur.interval, 2);
  assert.equal(p('x biweekly').recur.interval, 2);
  assert.equal(p('review quarterly').recur.interval, 3);
  const y = p('birthday every jan 5');
  assert.equal(y.recur.kind, 'yearly');
  assert.equal(y.date, '2027-01-05');
});

test('recurrence with a start date and time', () => {
  const r = p('pay card every month starting oct 20 at 9am');
  assert.equal(r.date, '2026-10-20');
  assert.equal(r.time, '09:00');
  assert.equal(r.recur.kind, 'monthly');
  assert.equal(r.title, 'Pay card');
});

test('nextOccurrence walks the series', () => {
  const daily = { kind: 'daily', interval: 2, anchor: '2026-10-05' };
  assert.equal(nextOccurrence(daily, '2026-10-05'), '2026-10-07');
  assert.equal(nextOccurrence(daily, '2026-10-06'), '2026-10-07');
  const weekly = { kind: 'weekly', interval: 1, weekdays: [1, 5], anchor: '2026-10-05' };
  assert.equal(nextOccurrence(weekly, '2026-10-05'), '2026-10-09');
  assert.equal(nextOccurrence(weekly, '2026-10-09'), '2026-10-12');
  const fort = { kind: 'weekly', interval: 2, weekdays: [1], anchor: '2026-10-05' };
  assert.equal(nextOccurrence(fort, '2026-10-05'), '2026-10-19');
  const monthly = { kind: 'monthly', interval: 1, day: 31, anchor: '2026-10-31' };
  assert.equal(nextOccurrence(monthly, '2026-10-31'), '2026-11-30');
  const lastDay = { kind: 'monthly', interval: 1, day: -1, anchor: '2026-10-31' };
  assert.equal(nextOccurrence(lastDay, '2026-10-31'), '2026-11-30');
  const yearly = { kind: 'yearly', interval: 1, month: 1, day: 29, anchor: '2028-02-29' };
  assert.equal(nextOccurrence(yearly, '2028-02-29'), '2029-02-28');
});

test('matchesRecur respects the anchor week for intervals', () => {
  const r = { kind: 'weekly', interval: 2, weekdays: [3], anchor: '2026-10-07' };
  assert.equal(matchesRecur(r, '2026-10-07'), true);
  assert.equal(matchesRecur(r, '2026-10-14'), false);
  assert.equal(matchesRecur(r, '2026-10-21'), true);
});

test('firstOccurrence never moves backwards', () => {
  const r = { kind: 'weekly', interval: 1, weekdays: [5] };
  assert.equal(firstOccurrence(r, '2026-10-05', '2026-10-05'), '2026-10-09');
});

test('describeRecur reads naturally', () => {
  assert.equal(describeRecur({ kind: 'daily', interval: 1 }), 'daily');
  assert.equal(describeRecur({ kind: 'daily', interval: 2 }), 'every other day');
  assert.equal(describeRecur({ kind: 'weekly', interval: 1, weekdays: [1] }), 'every Monday');
  assert.equal(describeRecur({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }), 'every weekday');
  assert.equal(describeRecur({ kind: 'monthly', interval: 1, day: 15 }), 'monthly on the 15th');
  assert.equal(describeRecur({ kind: 'monthly', interval: 1, day: -1 }), 'monthly on the last day');
  assert.equal(describeRecur({ kind: 'weekly', interval: 2 }), 'every other week');
});

test('parseDateText leaves unmatched text alone', () => {
  const r = parseDateText('read chapter 4 of the book', NOW);
  assert.equal(r.date, null);
  assert.equal(r.rest, 'read chapter 4 of the book');
});

test('a hash number becomes a project, not a date', () => {
  const r = p('Fix bug #1234 in v2 parser');
  assert.equal(r.date, null);
  assert.equal(r.project, '1234');
});

test('accepts a YYYY-MM-DD string as "now"', () => {
  assert.equal(parseTask('x tomorrow', '2026-12-31').date, '2027-01-01');
});

test('title keeps internal punctuation and casing of later words', () => {
  const r = p('Call Dr. Lee about MRI tomorrow at 2pm p2 @health');
  assert.equal(r.title, 'Call Dr. Lee about MRI');
  assert.equal(r.date, '2026-10-06');
  assert.equal(r.time, '14:00');
  assert.equal(r.priority, 2);
});

test('fuzzing: random phrases never throw and never yield invalid values', () => {
  const words = ['milk', 'every', 'monday', 'tomorrow', '5pm', 'p1', '#home', '@fast', 'in', '3',
    'weeks', 'oct', '31', 'next', 'noon', '12/40', '99:99', 'days'];
  for (let i = 0; i < 500; i++) {
    const n = 1 + (i % 6);
    let s = '';
    for (let j = 0; j < n; j++) s += words[(i * 7 + j * 13) % words.length] + ' ';
    const r = p(s);
    if (r.date) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    if (r.time) assert.match(r.time, /^([01]\d|2[0-3]):[0-5]\d$/);
    if (r.recur) assert.ok(firstOccurrence(r.recur, ymd(NOW), r.recur.anchor));
  }
});
