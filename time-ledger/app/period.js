// Period navigation shared by views.
import { startOfDay, addDays, startOfWeek, startOfMonth, addMonths, fmtDate } from '../lib/util.js';

export function rangeFor(period, anchor, weekStart = 1) {
  if (period === 'day') {
    const from = startOfDay(anchor);
    return { from, to: addDays(from, 1) };
  }
  if (period === 'week') {
    const from = startOfWeek(anchor, weekStart);
    return { from, to: addDays(from, 7) };
  }
  const from = startOfMonth(anchor);
  return { from, to: addMonths(from, 1) };
}

export function shift(period, anchor, dir) {
  if (period === 'day') return addDays(anchor, dir);
  if (period === 'week') return addDays(anchor, 7 * dir);
  return addMonths(startOfMonth(anchor), dir);
}

export function labelFor(period, from, to) {
  const today = startOfDay(Date.now());
  if (period === 'day') {
    if (from === today) return 'Today';
    if (from === addDays(today, -1)) return 'Yesterday';
    return fmtDate(from, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  if (period === 'week') {
    const end = addDays(to, -1);
    return `${fmtDate(from, { month: 'short', day: 'numeric' })} – ${fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return new Date(from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function periodControls(period, label) {
  return `<div class="controls">
    <div class="seg" role="group" aria-label="Period">
      ${['day', 'week', 'month'].map((p) => `<button type="button" data-period="${p}" aria-pressed="${p === period}">${{ day: 'Day', week: 'Week', month: 'Month' }[p]}</button>`).join('')}
    </div>
    <button class="btn icon" type="button" data-nav="-1" aria-label="Previous"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
    <span class="date-label" aria-live="polite">${label}</span>
    <button class="btn icon" type="button" data-nav="1" aria-label="Next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
    <button class="btn" type="button" data-nav="0">Today</button>
  </div>`;
}

/** Wire period controls; st = { period, anchor }; onChange re-renders. */
export function bindPeriod(root, st, onChange) {
  root.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { st.period = b.dataset.period; onChange(); }));
  root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    const dir = +b.dataset.nav;
    st.anchor = dir === 0 ? Date.now() : shift(st.period, st.anchor, dir);
    onChange();
  }));
}
