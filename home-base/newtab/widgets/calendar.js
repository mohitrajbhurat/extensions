// Month calendar with events and countdowns. Events: { id, title, date, time?, yearly? }.
import { h, icon, confirmDialog } from '../../lib/ui.js';
import { ymd, parseYmd, addDays, diffDays, daysInMonth, startOfWeek, WEEKDAY_SHORT, MONTH_LONG, formatTime, longLabel } from '../../lib/dates.js';
import * as store from '../../lib/store.js';

/** Next date (>= today) on which an event happens, or null when it is in the past. */
export function nextEventDate(ev, today) {
  if (!ev.yearly) return ev.date >= today ? ev.date : null;
  const d = parseYmd(ev.date);
  const t = parseYmd(today);
  for (let y = Math.max(t.getFullYear(), d.getFullYear()); y < t.getFullYear() + 2; y++) {
    const day = Math.min(d.getDate(), daysInMonth(y, d.getMonth()));
    const s = ymd(new Date(y, d.getMonth(), day));
    if (s >= today && s >= ev.date) return s;
  }
  return null;
}

function eventsOn(events, date) {
  return events.filter((e) => {
    if (!e.yearly) return e.date === date;
    if (date < e.date) return false;
    const a = parseYmd(e.date), b = parseYmd(date);
    const last = daysInMonth(b.getFullYear(), a.getMonth());
    return a.getMonth() === b.getMonth() && Math.min(a.getDate(), last) === b.getDate();
  });
}

export function countdownLabel(date, today) {
  const n = diffDays(today, date);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n < 7) return `In ${n} days`;
  if (n < 60) return `In ${n} days`;
  const months = Math.round(n / 30.4);
  return `In ${months} months`;
}

export function mount(frame, app) {
  const t0 = ymd(new Date());
  let cursor = t0.slice(0, 8) + '01';
  let selected = t0;
  const title = h('div.cal-title', { 'aria-live': 'polite' });
  const grid = h('div.cal-grid', { role: 'grid', 'aria-label': 'Month' });
  const dayList = h('div.cal-day');
  const countdowns = h('div.cal-countdowns');
  const nav = h('div.cal-nav',
    h('button.icon-btn', { type: 'button', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('chevronL', 16)),
    title,
    h('button.btn.small', { type: 'button', onclick: () => { cursor = ymd(new Date()).slice(0, 8) + '01'; selected = ymd(new Date()); render(); } }, 'Today'),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Next month', onclick: () => shift(1) }, icon('chevronR', 16)));
  const evTitle = h('input.input', { type: 'text', placeholder: 'New event or countdown', 'aria-label': 'Event title', maxlength: '120', required: true });
  const evDate = h('input.input', { type: 'date', 'aria-label': 'Event date', required: true });
  const evTime = h('input.input', { type: 'time', 'aria-label': 'Event time (optional)' });
  const evYearly = h('input', { type: 'checkbox' });
  const form = h('form.cal-form',
    evTitle,
    h('div.row', evDate, evTime),
    h('div.row', h('label.row.small.grow', evYearly, 'Every year'), h('button.btn.small.primary', { type: 'submit' }, icon('plus', 14), 'Add')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = evTitle.value.trim();
    if (!title || !evDate.value) return;
    const ev = { id: store.uid('e'), title, date: evDate.value, time: evTime.value || null, yearly: evYearly.checked };
    await store.update('events', (list) => [...list, ev]);
    evTitle.value = '';
    evTime.value = '';
    evYearly.checked = false;
    selected = ev.date;
    cursor = ev.date.slice(0, 8) + '01';
  });
  frame.body.append(h('div.widget-scroll', nav, grid, dayList, form, countdowns));

  function shift(n) {
    const d = parseYmd(cursor);
    d.setMonth(d.getMonth() + n);
    cursor = ymd(d);
    render();
  }

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-date]');
    if (!cell) return;
    selected = cell.dataset.date;
    if (selected.slice(0, 7) !== cursor.slice(0, 7)) cursor = selected.slice(0, 8) + '01';
    render();
    grid.querySelector(`[data-date="${selected}"]`)?.focus();
  });
  grid.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    selected = addDays(selected, moves[e.key]);
    if (selected.slice(0, 7) !== cursor.slice(0, 7)) cursor = selected.slice(0, 8) + '01';
    render();
    grid.querySelector(`[data-date="${selected}"]`)?.focus();
  });

  async function removeEvent(ev) {
    if (await confirmDialog(`Delete “${ev.title}”?`)) await store.update('events', (list) => list.filter((x) => x.id !== ev.id));
  }

  function render() {
    const today = ymd(new Date());
    const ws = app.state.settings.weekStart;
    const events = app.state.events;
    const due = new Set(app.state.tasks.filter((x) => !x.done && x.date).map((x) => x.date));
    const c = parseYmd(cursor);
    title.textContent = `${MONTH_LONG[c.getMonth()]} ${c.getFullYear()}`;
    const first = startOfWeek(cursor, ws);
    const heads = [];
    for (let i = 0; i < 7; i++) heads.push(h('div.cal-head', { role: 'columnheader' }, WEEKDAY_SHORT[(ws + i) % 7].slice(0, 2)));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(first, i);
      if (i === 35 && d.slice(0, 7) !== cursor.slice(0, 7)) break;
      const evs = eventsOn(events, d);
      const cls = ['cal-cell'];
      if (d.slice(0, 7) !== cursor.slice(0, 7)) cls.push('other');
      if (d === today) cls.push('today');
      if (d === selected) cls.push('selected');
      cells.push(h('button', {
        type: 'button', class: cls.join(' '), role: 'gridcell', dataset: { date: d },
        tabindex: d === selected ? '0' : '-1',
        'aria-selected': String(d === selected),
        'aria-label': `${longLabel(d)}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}${due.has(d) ? ', tasks due' : ''}`,
      }, String(parseYmd(d).getDate()), h('span.dots', evs.length ? h('i.ev') : null, due.has(d) ? h('i.tk') : null)));
    }
    grid.replaceChildren(...heads, ...cells);

    const evs = eventsOn(events, selected);
    const tasks = app.state.tasks.filter((x) => !x.done && x.date === selected);
    dayList.replaceChildren(
      h('div.cal-day-title', longLabel(selected)),
      evs.length || tasks.length ? h('ul.cal-items',
        evs.map((ev) => h('li', h('span.ev-dot'), h('span.grow', ev.time ? `${formatTime(ev.time, app.state.settings.h24)} ` : '', ev.title, ev.yearly ? ' (yearly)' : ''),
          h('button.icon-btn', { type: 'button', 'aria-label': `Delete event ${ev.title}`, onclick: () => removeEvent(ev) }, icon('trash', 14)))),
        tasks.map((x) => h('li', h('span.tk-dot'), h('span.grow', x.time ? `${formatTime(x.time, app.state.settings.h24)} ` : '', x.title))))
        : h('div.small.muted', 'Nothing planned.'));
    evDate.value = selected;

    const upcoming = events.map((ev) => ({ ev, next: nextEventDate(ev, today) }))
      .filter((x) => x.next).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 5);
    countdowns.replaceChildren(...[
      upcoming.length ? h('div.cal-day-title', 'Countdowns') : null,
      upcoming.length ? h('ul.cal-items', upcoming.map(({ ev, next }) => h('li',
        h('span.countdown', countdownLabel(next, today)), h('span.grow', ev.title),
        h('button.icon-btn', { type: 'button', 'aria-label': `Delete event ${ev.title}`, onclick: () => removeEvent(ev) }, icon('trash', 14))))) : null].filter(Boolean));
  }
  render();
  return { keys: ['events', 'tasks', 'settings'], update: render };
}
