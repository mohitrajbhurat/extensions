// Due-card selection and counting. Pure module (no browser APIs).
import { State, DAY, MINUTE } from './fsrs.js';

export const LEARN_AHEAD_MS = 20 * MINUTE;

/** Start of the "study day" containing `now` (the day rolls over at `rolloverHour`, default 4am). */
export function dayStart(now = Date.now(), rolloverHour = 4) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), rolloverHour, 0, 0, 0);
  if (d < start) start.setDate(start.getDate() - 1);
  return start.getTime();
}

export function dayEnd(now = Date.now(), rolloverHour = 4) {
  const s = new Date(dayStart(now, rolloverHour));
  s.setDate(s.getDate() + 1);
  return s.getTime();
}

/** Number of new cards first studied today, from today's review log. */
export function newStudiedToday(revlog, now = Date.now(), rolloverHour = 4) {
  const start = dayStart(now, rolloverHour);
  const seen = new Set();
  for (const r of revlog) if (r.ts >= start && r.state === State.New) seen.add(r.cardId);
  return seen.size;
}

function isLearning(c) { return c.state === State.Learning || c.state === State.Relearning; }

/**
 * Splits cards into what is studyable now.
 * opts: { now, rolloverHour, newPerDay, newStudied, deckIds (Set|null), learnAhead (bool) }
 */
export function selectDue(cards, opts = {}) {
  const now = opts.now ?? Date.now();
  const end = dayEnd(now, opts.rolloverHour ?? 4);
  const deckIds = opts.deckIds || null;
  const learning = [];
  const learningLater = [];
  const review = [];
  const fresh = [];
  for (const c of cards) {
    if (c.suspended) continue;
    if (deckIds && !deckIds.has(c.deckId)) continue;
    if (c.state === State.New) fresh.push(c);
    else if (isLearning(c)) {
      if (c.due <= now) learning.push(c);
      else if (c.due < end) learningLater.push(c);
    } else if (c.due < end) review.push(c);
  }
  learning.sort((a, b) => a.due - b.due);
  learningLater.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
  fresh.sort((a, b) => (a.created || 0) - (b.created || 0) || String(a.id).localeCompare(String(b.id)));
  const newLimit = Math.max(0, (opts.newPerDay ?? 20) - (opts.newStudied ?? 0));
  const newCards = fresh.slice(0, newLimit);
  return { learning, learningLater, review, newCards, newTotal: fresh.length };
}

/** Counts for badges and deck lists: {new, learning, review, total}. */
export function dueCounts(cards, opts = {}) {
  const s = selectDue(cards, opts);
  const counts = { new: s.newCards.length, learning: s.learning.length, review: s.review.length };
  counts.total = counts.new + counts.learning + counts.review;
  return counts;
}

/**
 * Picks the next card to show: learning cards due now, then reviews interleaved with new cards,
 * then (if nothing else) learning cards due within the learn-ahead window.
 */
export function nextCard(cards, opts = {}) {
  const now = opts.now ?? Date.now();
  const s = selectDue(cards, opts);
  if (s.learning.length) return s.learning[0];
  const reviewed = opts.reviewedThisSession ?? 0;
  // Interleave: one new card after every few reviews, so new cards don't all land at the end.
  const showNewFirst = s.newCards.length && (!s.review.length || (reviewed % 4 === 3));
  if (showNewFirst) return s.newCards[0];
  if (s.review.length) return s.review[0];
  if (s.newCards.length) return s.newCards[0];
  const soon = s.learningLater.find(c => c.due <= now + LEARN_AHEAD_MS);
  return soon || null;
}

/** Due forecast: number of cards falling due on each of the next `days` days (index 0 = today, incl. overdue). */
export function dueForecast(cards, days = 30, now = Date.now(), rolloverHour = 4) {
  const start = dayStart(now, rolloverHour);
  const out = new Array(days).fill(0);
  for (const c of cards) {
    if (c.suspended || c.state === State.New) continue;
    const idx = Math.max(0, Math.floor((c.due - start) / DAY));
    if (idx < days) out[idx]++;
  }
  return out;
}
