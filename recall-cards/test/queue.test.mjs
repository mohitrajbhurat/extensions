import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDue, dueCounts, nextCard, dayStart, dueForecast, newStudiedToday } from '../lib/queue.js';
import { State, DAY, MINUTE } from '../lib/fsrs.js';

const NOW = new Date(2026, 4, 10, 15, 0).getTime();
const mk = (id, state, due, extra = {}) => ({ id, deckId: 'd1', state, due, created: 0, ...extra });

test('day rolls over at the configured hour', () => {
  const at3 = new Date(2026, 4, 10, 3, 0).getTime();
  assert.equal(dayStart(at3, 4), new Date(2026, 4, 9, 4).getTime());
  assert.equal(dayStart(NOW, 4), new Date(2026, 4, 10, 4).getTime());
});

test('counts respect new-card limit, suspension, deck filter and due times', () => {
  const cards = [
    mk('n1', State.New, 0), mk('n2', State.New, 0), mk('n3', State.New, 0),
    mk('l1', State.Learning, NOW - MINUTE), mk('l2', State.Learning, NOW + 5 * MINUTE),
    mk('r1', State.Review, NOW - DAY), mk('r2', State.Review, NOW + 2 * 3600e3), mk('r3', State.Review, NOW + 3 * DAY),
    mk('s1', State.Review, NOW - DAY, { suspended: true }), mk('o1', State.Review, NOW - DAY, { deckId: 'd2' }),
  ];
  const c = dueCounts(cards, { now: NOW, newPerDay: 2, newStudied: 0, deckIds: new Set(['d1']) });
  assert.deepEqual(c, { new: 2, learning: 1, review: 2, total: 5 });
  assert.equal(dueCounts(cards, { now: NOW, newPerDay: 2, newStudied: 2, deckIds: new Set(['d1']) }).new, 0);
  assert.equal(dueCounts(cards, { now: NOW, newPerDay: 0 }).review, 3);
});

test('nextCard prefers due learning cards, then reviews, then learn-ahead', () => {
  const cards = [mk('r1', State.Review, NOW - DAY), mk('l1', State.Learning, NOW - 1000)];
  assert.equal(nextCard(cards, { now: NOW }).id, 'l1');
  assert.equal(nextCard([mk('r1', State.Review, NOW - DAY), mk('n1', State.New, 0)], { now: NOW }).id, 'r1');
  assert.equal(nextCard([mk('l2', State.Learning, NOW + 5 * MINUTE)], { now: NOW }).id, 'l2');
  assert.equal(nextCard([mk('l3', State.Learning, NOW + 60 * MINUTE)], { now: NOW }), null);
});

test('forecast buckets due cards per day and folds overdue into today', () => {
  const start = dayStart(NOW, 4);
  const cards = [mk('a', State.Review, start - 5 * DAY), mk('b', State.Review, start + 1000), mk('c', State.Review, start + DAY + 1), mk('d', State.New, 0)];
  assert.deepEqual(dueForecast(cards, 3, NOW, 4), [2, 1, 0]);
});

test('newStudiedToday counts unique new cards in today\'s log', () => {
  const start = dayStart(NOW, 4);
  const log = [{ cardId: 'a', state: State.New, ts: start + 1 }, { cardId: 'a', state: State.Learning, ts: start + 2 }, { cardId: 'b', state: State.New, ts: start - 10 }];
  assert.equal(newStudiedToday(log, NOW, 4), 1);
});

test('selectDue sorts reviews by due date', () => {
  const s = selectDue([mk('r2', State.Review, NOW - 1), mk('r1', State.Review, NOW - DAY)], { now: NOW });
  assert.deepEqual(s.review.map(c => c.id), ['r1', 'r2']);
});
