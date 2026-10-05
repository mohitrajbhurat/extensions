// FSRS-5 spaced repetition scheduler (Free Spaced Repetition Scheduler).
// Pure module: no browser APIs, so it runs in the service worker, extension pages and node:test.
// Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm

export const State = Object.freeze({ New: 0, Learning: 1, Review: 2, Relearning: 3 });
export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
export const RATINGS = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
export const STATE_NAMES = ['New', 'Learning', 'Review', 'Relearning'];

// FSRS-5 default weights (19 parameters).
export const DEFAULT_WEIGHTS = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
]);

export const DECAY = -0.5;
export const FACTOR = 19 / 81; // chosen so that R(S, S) = 0.9
export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;
const S_MIN = 0.01;

export const DEFAULT_OPTIONS = Object.freeze({
  weights: DEFAULT_WEIGHTS,
  desiredRetention: 0.9,
  learningSteps: [1, 10], // minutes
  relearningSteps: [10], // minutes
  maximumInterval: 36500, // days
  enableFuzz: true,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** A fresh, never-reviewed card's scheduling fields. */
export function newCardState(now = Date.now()) {
  return { state: State.New, due: now, stability: 0, difficulty: 0, step: 0, reps: 0, lapses: 0, lastReview: null, scheduledDays: 0 };
}

/** Probability of recall after `elapsedDays` for a memory of stability `stability`. */
export function forgettingCurve(elapsedDays, stability) {
  if (!(stability > 0)) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
}

// Deterministic PRNG (mulberry32) seeded from a string, so fuzz is reproducible per card+review.
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const FUZZ_RANGES = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Infinity, factor: 0.05 },
];

export class FSRS {
  constructor(options = {}) {
    const o = { ...DEFAULT_OPTIONS, ...options };
    const w = Array.isArray(o.weights) && o.weights.length >= 19 ? o.weights.slice(0, 19).map(Number) : DEFAULT_WEIGHTS.slice();
    this.w = w;
    this.desiredRetention = clamp(Number(o.desiredRetention) || 0.9, 0.7, 0.99);
    this.learningSteps = sanitizeSteps(o.learningSteps, DEFAULT_OPTIONS.learningSteps);
    this.relearningSteps = sanitizeSteps(o.relearningSteps, DEFAULT_OPTIONS.relearningSteps);
    this.maximumInterval = clamp(Math.round(Number(o.maximumInterval) || 36500), 1, 36500);
    this.enableFuzz = o.enableFuzz !== false;
  }

  // ----- core formulas -----
  initStability(g) { return Math.max(this.w[g - 1], S_MIN); }

  initDifficulty(g) { return clamp(this.w[4] - Math.exp(this.w[5] * (g - 1)) + 1, 1, 10); }

  nextDifficulty(d, g) {
    const delta = -this.w[6] * (g - 3);
    const damped = d + delta * (10 - d) / 9; // linear damping (FSRS-5)
    const reverted = this.w[7] * this.initDifficulty(Rating.Easy) + (1 - this.w[7]) * damped; // mean reversion
    return clamp(reverted, 1, 10);
  }

  nextRecallStability(d, s, r, g) {
    const w = this.w;
    const hardPenalty = g === Rating.Hard ? w[15] : 1;
    const easyBonus = g === Rating.Easy ? w[16] : 1;
    return Math.max(S_MIN, s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hardPenalty * easyBonus));
  }

  nextForgetStability(d, s, r) {
    const w = this.w;
    const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
    return clamp(sf, S_MIN, s); // after a lapse, stability never grows
  }

  nextShortTermStability(s, g) {
    return Math.max(S_MIN, s * Math.exp(this.w[17] * (g - 3 + this.w[18])));
  }

  /** Interval in whole days that brings recall probability down to desiredRetention. */
  nextInterval(stability, seed = '', elapsedDays = 0) {
    const raw = (stability / FACTOR) * (Math.pow(this.desiredRetention, 1 / DECAY) - 1);
    let ivl = clamp(Math.round(raw), 1, this.maximumInterval);
    if (this.enableFuzz && ivl >= 2.5 && seed) ivl = this.applyFuzz(ivl, seed, elapsedDays);
    return ivl;
  }

  applyFuzz(ivl, seed, elapsedDays = 0) {
    let delta = 1;
    for (const r of FUZZ_RANGES) delta += r.factor * Math.max(Math.min(ivl, r.end) - r.start, 0);
    let minIvl = Math.max(2, Math.round(ivl - delta));
    const maxIvl = Math.min(Math.round(ivl + delta), this.maximumInterval);
    if (ivl > elapsedDays) minIvl = Math.max(minIvl, Math.round(elapsedDays) + 1);
    minIvl = Math.min(minIvl, maxIvl);
    return Math.floor(seededRandom(seed) * (maxIvl - minIvl + 1) + minIvl);
  }

  /** Current probability of recall for a card (1 for unseen cards). */
  retrievability(card, now = Date.now()) {
    if (!card || card.state === State.New || !card.lastReview || !(card.stability > 0)) return 0;
    return forgettingCurve((now - card.lastReview) / DAY, card.stability);
  }

  // ----- scheduling -----

  /** Returns {1: {card, log}, 2: ..., 3: ..., 4: ...} without mutating `card`. */
  preview(card, now = Date.now()) {
    const out = {};
    for (const g of RATINGS) out[g] = this._next(card, g, now);
    this._orderReviewIntervals(card, out, now);
    return out;
  }

  /** Applies a rating; returns {card, log}. */
  review(card, rating, now = Date.now()) {
    const g = Number(rating);
    if (!RATINGS.includes(g)) throw new RangeError('rating must be 1-4');
    return this.preview(card, now)[g];
  }

  _next(card, g, now) {
    const prev = { ...newCardState(now), ...card };
    const c = { ...prev };
    const elapsedDays = prev.lastReview ? Math.max(0, (now - prev.lastReview) / DAY) : 0;
    const seed = `${prev.id || ''}:${prev.reps}:${g}`;
    let intervalMs;

    if (prev.state === State.New) {
      c.stability = this.initStability(g);
      c.difficulty = this.initDifficulty(g);
    } else {
      const sameDay = elapsedDays < 1;
      const r = forgettingCurve(elapsedDays, prev.stability);
      c.difficulty = this.nextDifficulty(prev.difficulty, g);
      if (sameDay && prev.state !== State.Review) {
        c.stability = this.nextShortTermStability(prev.stability, g);
      } else if (sameDay && prev.state === State.Review && g !== Rating.Again) {
        // A review card seen again on the same day (e.g. after undo/cram): use short-term update.
        c.stability = Math.max(prev.stability, this.nextShortTermStability(prev.stability, g));
      } else if (g === Rating.Again) {
        c.stability = this.nextForgetStability(prev.difficulty, prev.stability, r);
      } else {
        c.stability = this.nextRecallStability(prev.difficulty, prev.stability, r, g);
      }
    }

    if (prev.state === State.New || prev.state === State.Learning || prev.state === State.Relearning) {
      const steps = prev.state === State.Relearning ? this.relearningSteps : this.learningSteps;
      const learnState = prev.state === State.Relearning ? State.Relearning : State.Learning;
      const step = prev.state === State.New ? 0 : Math.min(prev.step || 0, Math.max(0, steps.length - 1));
      const graduate = () => {
        c.state = State.Review; c.step = 0;
        const days = this.nextInterval(c.stability, seed, elapsedDays);
        c.scheduledDays = days; intervalMs = days * DAY;
      };
      if (steps.length === 0 || g === Rating.Easy) {
        graduate();
      } else if (g === Rating.Again) {
        c.state = learnState; c.step = 0; c.scheduledDays = 0; intervalMs = steps[0] * MINUTE;
      } else if (g === Rating.Hard) {
        c.state = learnState; c.step = step; c.scheduledDays = 0;
        let mins;
        if (step === 0 && steps.length === 1) mins = Math.min(steps[0] * 1.5, steps[0] + 1440);
        else if (step === 0) mins = (steps[0] + steps[1]) / 2;
        else mins = steps[step];
        intervalMs = mins * MINUTE;
      } else { // Good
        if (prev.state === State.New ? steps.length <= 1 : step + 1 >= steps.length) {
          graduate();
        } else {
          const next = prev.state === State.New ? 1 : step + 1;
          c.state = learnState; c.step = next; c.scheduledDays = 0; intervalMs = steps[next] * MINUTE;
        }
      }
    } else { // Review
      if (g === Rating.Again) {
        c.lapses = prev.lapses + 1;
        if (this.relearningSteps.length) {
          c.state = State.Relearning; c.step = 0; c.scheduledDays = 0;
          intervalMs = this.relearningSteps[0] * MINUTE;
        } else {
          c.state = State.Review;
          const days = this.nextInterval(c.stability, seed, elapsedDays);
          c.scheduledDays = days; intervalMs = days * DAY;
        }
      } else {
        c.state = State.Review; c.step = 0;
        const days = this.nextInterval(c.stability, seed, elapsedDays);
        c.scheduledDays = days; intervalMs = days * DAY;
      }
    }

    c.reps = prev.reps + 1;
    c.lastReview = now;
    c.due = now + intervalMs;
    const log = {
      rating: g, state: prev.state, due: prev.due, stability: prev.stability, difficulty: prev.difficulty,
      elapsedDays, scheduledDays: c.scheduledDays, newState: c.state, ts: now,
    };
    return { card: c, log, intervalMs };
  }

  // Keep Hard <= Good < Easy for cards already in Review (mirrors ts-fsrs/Anki behaviour).
  _orderReviewIntervals(card, out, now) {
    const isRev = g => out[g].card.state === State.Review && out[g].card.scheduledDays > 0;
    const set = (g, days) => {
      const c = out[g].card;
      c.scheduledDays = days; c.due = now + days * DAY; out[g].intervalMs = days * DAY; out[g].log.scheduledDays = days;
    };
    if (isRev(Rating.Hard) && isRev(Rating.Good)) {
      if (out[2].card.scheduledDays > out[3].card.scheduledDays) set(2, out[3].card.scheduledDays);
      if (out[3].card.scheduledDays <= out[2].card.scheduledDays) set(3, Math.min(out[2].card.scheduledDays + 1, this.maximumInterval));
    }
    if (isRev(Rating.Good) && isRev(Rating.Easy) && out[4].card.scheduledDays <= out[3].card.scheduledDays) {
      set(4, Math.min(out[3].card.scheduledDays + 1, this.maximumInterval));
    }
  }
}

function sanitizeSteps(steps, fallback) {
  if (typeof steps === 'string') steps = parseSteps(steps);
  if (!Array.isArray(steps)) return fallback.slice();
  return steps.map(Number).filter(x => Number.isFinite(x) && x > 0).map(x => Math.min(x, 1440 * 30));
}

/** Parses "1m 10m 1h 1d" (or bare minutes) into minutes. Returns null on invalid input. */
export function parseSteps(text) {
  const parts = String(text || '').trim().split(/[\s,]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(p);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 'm').toLowerCase();
    out.push(unit === 's' ? n / 60 : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n);
  }
  return out;
}

export function formatSteps(steps) {
  return (steps || []).map(m => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${+m.toFixed(2)}m`)).join(' ');
}

/** Short human label for an interval in ms: "1m", "10m", "3h", "4d", "2.1mo", "1.3y". */
export function formatInterval(ms) {
  const mins = ms / MINUTE;
  if (mins < 1) return '<1m';
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${+(days / 30.4375).toFixed(1)}mo`;
  return `${+(days / 365.25).toFixed(1)}y`;
}
