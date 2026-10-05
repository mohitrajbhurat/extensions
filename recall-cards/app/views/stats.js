import { h } from '../ui.js';
import { heatmap, barChart } from '../charts.js';
import { getAll } from '../../lib/db.js';
import { State, FSRS } from '../../lib/fsrs.js';
import { dueForecast, dayStart } from '../../lib/queue.js';
import { schedulerOptions } from '../../lib/settings.js';

const DAYMS = 86400000;
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** True retention over review-state reviews: share not rated Again. */
export function retention(logs, filter = () => true) {
  const rel = logs.filter(l => l.state === State.Review && filter(l));
  if (!rel.length) return { n: 0, pct: null };
  const pass = rel.filter(l => l.rating > 1).length;
  return { n: rel.length, pct: pass / rel.length };
}

export async function render(root, ctx) {
  const { data } = ctx;
  const deckSel = h('select', { 'aria-label': 'Deck', style: { width: 'auto' } }, new Option('All decks', ''), ...data.decks.map(d => new Option(d.name, d.id)));
  deckSel.value = ctx.params.get('deck') || '';
  deckSel.addEventListener('change', () => ctx.navigate(deckSel.value ? `#stats?deck=${deckSel.value}` : '#stats'));
  const deckId = deckSel.value || null;

  const allLogs = await getAll('revlog');
  const cards = data.cards.filter(c => !deckId || c.deckId === deckId);
  const cardIds = new Set(cards.map(c => c.id));
  const logs = deckId ? allLogs.filter(l => cardIds.has(l.cardId) || l.deckId === deckId) : allLogs;
  const now = Date.now();
  const today0 = dayStart(now, data.settings.rolloverHour);
  const fsrs = new FSRS(schedulerOptions(data.settings));
  const destroyers = [];

  // per-day counts (calendar days)
  const perDay = new Map();
  for (const l of logs) { const k = dayKey(new Date(l.ts)); perDay.set(k, (perDay.get(k) || 0) + 1); }
  // streak: consecutive days with reviews ending today (or yesterday if none yet today)
  let streak = 0;
  const d = new Date();
  if (!perDay.get(dayKey(d))) d.setDate(d.getDate() - 1);
  while (perDay.get(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  const todayLogs = logs.filter(l => l.ts >= today0);
  const todayTime = todayLogs.reduce((a, l) => a + (l.durationMs || 0), 0);
  const counts = ctx.countsFor(data, deckId ? new Set([deckId]) : null);
  const ret30 = retention(logs, l => l.ts >= now - 30 * DAYMS);
  const reviewCards = cards.filter(c => c.state === State.Review && !c.suspended);
  const avgR = reviewCards.length ? reviewCards.reduce((a, c) => a + fsrs.retrievability(c, now), 0) / reviewCards.length : null;
  const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

  const page = h('div', { class: 'page' });
  root.append(page);
  const kpi = (v, l, title) => h('div', { class: 'kpi card-surface', title }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
  page.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Statistics'), deckSel),
    h('div', { class: 'kpis' },
      kpi(cards.length, 'Cards'),
      kpi(counts.total, 'Due today'),
      kpi(todayLogs.length, `Reviews today${todayTime ? ` · ${Math.round(todayTime / 60000)} min` : ''}`),
      kpi(`${streak}d`, 'Study streak'),
      kpi(pct(ret30.pct), `Retention, 30 days (${ret30.n})`, 'Share of review-state cards you recalled (not rated Again)'),
      kpi(pct(avgR), 'Avg. recall probability now', 'Mean FSRS retrievability across review cards')));

  // Heatmap
  const hm = heatmap(perDay, { weeks: 53 });
  destroyers.push(hm.destroy);
  const total365 = logs.filter(l => l.ts >= now - 365 * DAYMS).length;
  const activeDays = [...perDay.keys()].length;
  page.append(h('section', { class: 'card-surface section' },
    h('div', { class: 'page-head' }, h('h2', { style: { flex: 1 } }, 'Reviews per day'), h('span', { class: 'small muted' }, `${total365} reviews in the last year · ${activeDays} active day${activeDays === 1 ? '' : 's'}`)),
    hm.el,
    h('div', { class: 'legend' }, 'Less', ...[0, 1, 2, 3, 4].map(i => h('i', { style: { background: `var(--heat-${i})`, marginRight: 0 } })), 'More')));

  // Forecast
  const days = 30;
  const fc = dueForecast(cards, days, now, data.settings.rolloverHour);
  const dateOf = i => new Date(today0 + i * DAYMS);
  const labels = fc.map((v, i) => `${v} card${v === 1 ? '' : 's'} due ${i === 0 ? 'today (incl. overdue)' : i === 1 ? 'tomorrow' : dateOf(i).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`);
  const bars = barChart(fc, {
    labels, highlightFirst: true,
    tick: i => (i === 0 ? 'Today' : i % 7 === 0 ? dateOf(i).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''),
    ariaLabel: `Due forecast for the next ${days} days. Today: ${fc[0]}. Next 7 days: ${fc.slice(0, 7).reduce((a, b) => a + b, 0)}.`,
  });
  destroyers.push(bars.destroy);
  const fcTable = h('table', { class: 'ret-table small' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Due'))),
    h('tbody', {}, ...fc.map((v, i) => h('tr', {}, h('td', {}, i === 0 ? 'Today' : dateOf(i).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', {}, v)))));
  page.append(h('section', { class: 'card-surface section' },
    h('div', { class: 'page-head' }, h('h2', { style: { flex: 1 } }, 'Due forecast'), h('span', { class: 'small muted' }, `${fc.slice(0, 7).reduce((a, b) => a + b, 0)} in the next 7 days · ${fc.reduce((a, b) => a + b, 0)} in ${days} days`)),
    bars.el,
    h('details', { class: 'more' }, h('summary', {}, 'Show as table'), fcTable)));

  // Retention table
  const periods = [['Today', today0], ['Last 7 days', now - 7 * DAYMS], ['Last 30 days', now - 30 * DAYMS], ['Last 365 days', now - 365 * DAYMS], ['All time', 0]];
  const young = l => (l.stability || 0) < 21;
  const rows = periods.map(([name, since]) => {
    const inP = l => l.ts >= since;
    const all = retention(logs, inP);
    const y = retention(logs, l => inP(l) && young(l));
    const m = retention(logs, l => inP(l) && !young(l));
    const learned = new Set(logs.filter(l => inP(l) && l.state === State.New).map(l => l.cardId)).size;
    return h('tr', {}, h('td', {}, name), h('td', {}, logs.filter(inP).length), h('td', {}, learned),
      h('td', {}, pct(y.pct), h('span', { class: 'muted small' }, ` (${y.n})`)),
      h('td', {}, pct(m.pct), h('span', { class: 'muted small' }, ` (${m.n})`)),
      h('td', {}, h('b', {}, pct(all.pct))));
  });
  page.append(h('section', { class: 'card-surface section' },
    h('h2', {}, 'Retention'),
    h('p', { class: 'small muted', style: { margin: 0 } }, `Share of review cards recalled (rated Hard, Good or Easy). Young = stability under 21 days, mature = 21+. Your target is ${Math.round(data.settings.desiredRetention * 100)}%.`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'ret-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Period'), h('th', {}, 'Reviews'), h('th', {}, 'New learned'), h('th', {}, 'Young'), h('th', {}, 'Mature'), h('th', {}, 'Total'))),
      h('tbody', {}, ...rows)))));

  // Card states + answer buttons
  const st = { New: 0, Learning: 0, Review: 0, Suspended: 0 };
  for (const c of cards) {
    if (c.suspended) st.Suspended++;
    else if (c.state === State.New) st.New++;
    else if (c.state === State.Review) st.Review++;
    else st.Learning++;
  }
  const colors = { New: 'var(--new)', Learning: 'var(--learn)', Review: 'var(--review)', Suspended: 'var(--muted)' };
  const totalCards = Math.max(1, cards.length);
  const recent = logs.filter(l => l.ts >= now - 30 * DAYMS);
  const btn = [1, 2, 3, 4].map(g => recent.filter(l => l.rating === g).length);
  const btnTotal = Math.max(1, recent.length);
  const btnColors = ['var(--again)', 'var(--hard)', 'var(--good)', 'var(--easy)'];
  const btnNames = ['Again', 'Hard', 'Good', 'Easy'];
  const stack = (parts) => h('div', { class: 'stack', role: 'img', 'aria-label': parts.map(p => `${p.name} ${p.v}`).join(', ') },
    ...parts.filter(p => p.v > 0).map(p => h('div', { style: { width: `${(p.v / p.total) * 100}%`, background: p.color, borderRight: '2px solid var(--surface)' }, title: `${p.name}: ${p.v}` })));
  page.append(h('div', { class: 'grid2' },
    h('section', { class: 'card-surface section' },
      h('h2', {}, 'Card states'),
      stack(Object.entries(st).map(([name, v]) => ({ name, v, total: totalCards, color: colors[name] }))),
      h('div', { class: 'legend' }, ...Object.entries(st).map(([name, v]) => h('span', {}, h('i', { style: { background: colors[name] } }), `${name} ${v} (${Math.round((v / totalCards) * 100)}%)`)))),
    h('section', { class: 'card-surface section' },
      h('h2', {}, 'Answer buttons, last 30 days'),
      stack(btn.map((v, i) => ({ name: btnNames[i], v, total: btnTotal, color: btnColors[i] }))),
      h('div', { class: 'legend' }, ...btn.map((v, i) => h('span', {}, h('i', { style: { background: btnColors[i] } }), `${btnNames[i]} ${v} (${Math.round((v / btnTotal) * 100)}%)`))))));

  return () => destroyers.forEach(f => f());
}
