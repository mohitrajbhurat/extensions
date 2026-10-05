// Habit tracker: a streak grid per habit (last 12 weeks), click any past day to toggle it.
import { h, icon, confirmDialog } from '../../lib/ui.js';
import { ymd, addDays, longLabel, startOfWeek } from '../../lib/dates.js';
import { currentStreak, bestStreak } from '../../lib/habits.js';
import * as store from '../../lib/store.js';

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444'];
const WEEKS = 12;

export function mount(frame, app) {
  const list = h('div.habit-list');
  const input = h('input.input', { type: 'text', placeholder: 'New habit, e.g. Read 20 minutes', 'aria-label': 'New habit', maxlength: '60' });
  const form = h('form.row', input, h('button.btn.small.primary', { type: 'submit', 'aria-label': 'Add habit' }, icon('plus', 14)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    await store.update('habits', (hs) => [...hs, { id: store.uid('h'), name, color: COLORS[hs.length % COLORS.length], created: ymd(new Date()), days: {} }]);
    input.value = '';
  });
  frame.body.append(h('div.widget-scroll', list, form));

  const toggleDay = (id, day) => store.update('habits', (hs) => hs.map((x) => {
    if (x.id !== id) return x;
    const days = { ...x.days };
    if (days[day]) delete days[day]; else days[day] = 1;
    return { ...x, days };
  }));

  list.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-day]');
    if (cell) toggleDay(cell.closest('[data-habit]').dataset.habit, cell.dataset.day);
  });

  function render() {
    const today = ymd(new Date());
    const ws = app.state.settings.weekStart;
    const start = addDays(startOfWeek(today, ws), -(WEEKS - 1) * 7);
    list.replaceChildren(...app.state.habits.map((hb) => {
      const streak = currentStreak(hb.days, today);
      const best = bestStreak(hb.days);
      const doneToday = !!hb.days[today];
      const cells = [];
      for (let i = 0; i < WEEKS * 7; i++) {
        const d = addDays(start, i);
        const future = d > today;
        cells.push(h('button', {
          type: 'button',
          class: `hcell${hb.days[d] ? ' on' : ''}${d === today ? ' today' : ''}`,
          dataset: future ? {} : { day: d },
          disabled: future,
          'aria-pressed': String(!!hb.days[d]),
          'aria-label': `${hb.name}, ${longLabel(d)}${hb.days[d] ? ', done' : ''}`,
          tabindex: d === today ? '0' : '-1',
        }));
      }
      return h('div.habit', { dataset: { habit: hb.id }, style: { '--hc': hb.color } },
        h('div.habit-head',
          h('button', { type: 'button', class: `habit-check${doneToday ? ' on' : ''}`, dataset: { day: today }, 'aria-pressed': String(doneToday), 'aria-label': `Mark ${hb.name} done today` }, icon('check', 14)),
          h('div.grow', h('div.habit-name', hb.name),
            h('div.small.muted', streak ? `${streak}-day streak` : 'No streak yet', best > streak ? ` · best ${best}` : '')),
          h('button.icon-btn', { type: 'button', 'aria-label': `Delete habit ${hb.name}`, onclick: async () => {
            if (await confirmDialog(`Delete the habit “${hb.name}” and its history?`)) await store.update('habits', (hs) => hs.filter((x) => x.id !== hb.id));
          } }, icon('trash', 14))),
        h('div.hgrid', { role: 'group', 'aria-label': `${hb.name}, last ${WEEKS} weeks` }, cells));
    }));
    if (!app.state.habits.length) list.append(h('p.small.muted', 'Track a daily habit. Each square is a day; click to fill it in.'));
  }
  // Arrow keys move between day cells in a grid (columns are weeks).
  list.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.hcell');
    if (!cell) return;
    const moves = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const cells = [...cell.parentElement.children];
    const next = cells[cells.indexOf(cell) + moves[e.key]];
    if (next && !next.disabled) { cell.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  });
  render();
  return { keys: ['habits', 'settings'], update: render };
}
