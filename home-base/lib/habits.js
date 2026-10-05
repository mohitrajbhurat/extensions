// Habit streak maths. A habit stores the days it was done as { 'YYYY-MM-DD': 1 }.
import { addDays } from './dates.js';

/** Current streak: consecutive done days ending today (or yesterday, if today is not done yet). */
export function currentStreak(days, today) {
  const done = days || {};
  let d = done[today] ? today : addDays(today, -1);
  let n = 0;
  while (done[d] && n < 100000) { n++; d = addDays(d, -1); }
  return n;
}

export function bestStreak(days) {
  const list = Object.keys(days || {}).filter((k) => days[k]).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of list) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/** Share of the last `span` days that were done (0..1). */
export function rate(days, today, span = 30) {
  let n = 0;
  for (let i = 0; i < span; i++) if ((days || {})[addDays(today, -i)]) n++;
  return n / span;
}
