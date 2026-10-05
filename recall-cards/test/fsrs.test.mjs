// Unit tests for the FSRS-5 scheduler. Run: node --test recall-cards/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { FSRS, State, Rating, DAY, MINUTE, DEFAULT_WEIGHTS, forgettingCurve, newCardState, parseSteps, formatSteps, formatInterval } from '../lib/fsrs.js';

const T0 = Date.UTC(2026, 0, 1, 12);
const noFuzz = opts => new FSRS({ enableFuzz: false, ...opts });
const fresh = () => ({ id: 'card-1', ...newCardState(T0) });

test('default weights are the 19 FSRS-5 parameters', () => {
  assert.equal(DEFAULT_WEIGHTS.length, 19);
  assert.equal(DEFAULT_WEIGHTS[0], 0.40255);
  assert.equal(DEFAULT_WEIGHTS[18], 0.6621);
});

test('forgetting curve: R(S, S) = 0.9 and R(0) = 1, monotone decreasing', () => {
  assert.ok(Math.abs(forgettingCurve(10, 10) - 0.9) < 1e-9);
  assert.equal(forgettingCurve(0, 5), 1);
  assert.ok(forgettingCurve(20, 10) < forgettingCurve(10, 10));
});

test('initial stability equals w[0..3] and difficulty follows D0 formula', () => {
  const f = noFuzz();
  const p = f.preview(fresh(), T0);
  for (const g of [1, 2, 3, 4]) {
    assert.ok(Math.abs(p[g].card.stability - DEFAULT_WEIGHTS[g - 1]) < 1e-9, `S0(${g})`);
    const d0 = Math.min(10, Math.max(1, DEFAULT_WEIGHTS[4] - Math.exp(DEFAULT_WEIGHTS[5] * (g - 1)) + 1));
    assert.ok(Math.abs(p[g].card.difficulty - d0) < 1e-9, `D0(${g})`);
  }
  assert.ok(p[1].card.difficulty > p[3].card.difficulty && p[3].card.difficulty > p[4].card.difficulty);
});

test('new card with learning steps [1m,10m]: Again 1m, Hard 5.5m, Good 10m, Easy graduates', () => {
  const p = noFuzz().preview(fresh(), T0);
  assert.equal(p[1].intervalMs, 1 * MINUTE);
  assert.equal(p[2].intervalMs, 5.5 * MINUTE);
  assert.equal(p[3].intervalMs, 10 * MINUTE);
  assert.equal(p[1].card.state, State.Learning);
  assert.equal(p[3].card.state, State.Learning);
  assert.equal(p[3].card.step, 1);
  assert.equal(p[4].card.state, State.Review);
  // Easy: S0(4)=15.69 days at 90% retention -> 16 days
  assert.equal(p[4].card.scheduledDays, 16);
});

test('Good on the last learning step graduates to Review', () => {
  const f = noFuzz();
  let c = f.review(fresh(), Rating.Good, T0).card;
  assert.equal(c.step, 1);
  const t1 = T0 + 10 * MINUTE;
  c = f.review(c, Rating.Good, t1).card;
  assert.equal(c.state, State.Review);
  assert.ok(c.scheduledDays >= 1);
  assert.equal(c.due, t1 + c.scheduledDays * DAY);
  assert.equal(c.reps, 2);
});

test('same-day learning reviews use the short-term stability formula', () => {
  const f = noFuzz();
  const c = f.review(fresh(), Rating.Good, T0).card;
  const next = f.review(c, Rating.Good, T0 + 10 * MINUTE).card;
  const expected = c.stability * Math.exp(DEFAULT_WEIGHTS[17] * (0 + DEFAULT_WEIGHTS[18]));
  assert.ok(Math.abs(next.stability - expected) < 1e-9);
});

test('review card: intervals ordered Again < Hard <= Good < Easy, stability grows on success', () => {
  const f = noFuzz();
  const card = { id: 'r', state: State.Review, due: T0, stability: 10, difficulty: 5, step: 0, reps: 5, lapses: 0, lastReview: T0 - 10 * DAY, scheduledDays: 10 };
  const p = f.preview(card, T0);
  assert.equal(p[1].card.state, State.Relearning);
  assert.equal(p[1].intervalMs, 10 * MINUTE);
  assert.equal(p[1].card.lapses, 1);
  assert.ok(p[1].card.stability < card.stability, 'lapse lowers stability');
  assert.ok(p[2].card.scheduledDays <= p[3].card.scheduledDays);
  assert.ok(p[3].card.scheduledDays < p[4].card.scheduledDays);
  for (const g of [2, 3, 4]) assert.ok(p[g].card.stability > card.stability, `S grows for ${g}`);
  assert.ok(p[2].card.difficulty > card.difficulty && p[4].card.difficulty < card.difficulty);
});

test('recall stability matches the FSRS formula', () => {
  const f = noFuzz();
  const w = DEFAULT_WEIGHTS;
  const S = 10, D = 5, elapsed = 10;
  const R = forgettingCurve(elapsed, S);
  const expected = S * (1 + Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) * (Math.exp(w[10] * (1 - R)) - 1));
  const card = { id: 'x', state: State.Review, due: T0, stability: S, difficulty: D, step: 0, reps: 3, lapses: 0, lastReview: T0 - elapsed * DAY };
  const out = f.review(card, Rating.Good, T0).card;
  assert.ok(Math.abs(out.stability - expected) < 1e-9);
});

test('relearning: Good after relearning step returns card to Review', () => {
  const f = noFuzz();
  const card = { id: 'r', state: State.Review, due: T0, stability: 20, difficulty: 6, step: 0, reps: 6, lapses: 0, lastReview: T0 - 25 * DAY };
  const lapsed = f.review(card, Rating.Again, T0).card;
  assert.equal(lapsed.state, State.Relearning);
  const back = f.review(lapsed, Rating.Good, T0 + 10 * MINUTE).card;
  assert.equal(back.state, State.Review);
  assert.equal(back.lapses, 1);
});

test('no learning steps: new card graduates immediately', () => {
  const f = noFuzz({ learningSteps: [], relearningSteps: [] });
  const p = f.preview(fresh(), T0);
  for (const g of [1, 2, 3, 4]) assert.equal(p[g].card.state, State.Review);
  assert.ok(p[1].card.scheduledDays <= p[3].card.scheduledDays);
});

test('higher desired retention gives shorter intervals', () => {
  const card = { id: 'r', state: State.Review, due: T0, stability: 30, difficulty: 5, step: 0, reps: 4, lapses: 0, lastReview: T0 - 30 * DAY };
  const lo = noFuzz({ desiredRetention: 0.8 }).review(card, Rating.Good, T0).card.scheduledDays;
  const hi = noFuzz({ desiredRetention: 0.95 }).review(card, Rating.Good, T0).card.scheduledDays;
  assert.ok(hi < lo, `${hi} < ${lo}`);
});

test('maximum interval is respected', () => {
  const f = noFuzz({ maximumInterval: 30 });
  const card = { id: 'r', state: State.Review, due: T0, stability: 400, difficulty: 2, step: 0, reps: 9, lapses: 0, lastReview: T0 - 400 * DAY };
  const p = f.preview(card, T0);
  for (const g of [2, 3, 4]) assert.ok(p[g].card.scheduledDays <= 30);
});

test('fuzz is deterministic and stays within range', () => {
  const f = new FSRS({ enableFuzz: true });
  const card = { id: 'fuzzy', state: State.Review, due: T0, stability: 50, difficulty: 5, step: 0, reps: 4, lapses: 0, lastReview: T0 - 50 * DAY };
  const a = f.review(card, Rating.Good, T0).card.scheduledDays;
  const b = f.review(card, Rating.Good, T0).card.scheduledDays;
  assert.equal(a, b);
  const base = noFuzz().review(card, Rating.Good, T0).card.scheduledDays;
  assert.ok(Math.abs(a - base) <= Math.ceil(base * 0.1) + 1, `${a} near ${base}`);
});

test('difficulty stays within [1, 10] after many Again / Easy ratings', () => {
  const f = noFuzz();
  let c = fresh();
  let t = T0;
  for (let i = 0; i < 30; i++) { c = f.review(c, Rating.Again, t).card; t += DAY * 2; }
  assert.ok(c.difficulty <= 10 && c.difficulty >= 1);
  for (let i = 0; i < 30; i++) { c = f.review(c, Rating.Easy, t).card; t = c.due; }
  assert.ok(c.difficulty >= 1 && c.difficulty <= 10);
});

test('review does not mutate the input card and rejects bad ratings', () => {
  const f = noFuzz();
  const c = fresh();
  const snapshot = JSON.stringify(c);
  f.review(c, Rating.Good, T0);
  assert.equal(JSON.stringify(c), snapshot);
  assert.throws(() => f.review(c, 5, T0), RangeError);
});

test('log entry records previous state and rating', () => {
  const { log } = noFuzz().review(fresh(), Rating.Hard, T0);
  assert.equal(log.rating, 2);
  assert.equal(log.state, State.New);
  assert.equal(log.newState, State.Learning);
});

test('retrievability: 0 for new cards, ~0.9 after S days', () => {
  const f = noFuzz();
  assert.equal(f.retrievability(fresh(), T0), 0);
  const c = { state: State.Review, stability: 7, lastReview: T0 };
  assert.ok(Math.abs(f.retrievability(c, T0 + 7 * DAY) - 0.9) < 1e-9);
});

test('step parsing and formatting', () => {
  assert.deepEqual(parseSteps('1m 10m'), [1, 10]);
  assert.deepEqual(parseSteps('30s, 1h 1d'), [0.5, 60, 1440]);
  assert.deepEqual(parseSteps(''), []);
  assert.equal(parseSteps('ten'), null);
  assert.equal(formatSteps([1, 10, 60, 1440]), '1m 10m 1h 1d');
});

test('interval labels', () => {
  assert.equal(formatInterval(MINUTE), '1m');
  assert.equal(formatInterval(10 * MINUTE), '10m');
  assert.equal(formatInterval(3 * 60 * MINUTE), '3h');
  assert.equal(formatInterval(4 * DAY), '4d');
  assert.equal(formatInterval(61 * DAY), '2mo');
  assert.equal(formatInterval(400 * DAY), '1.1y');
});
