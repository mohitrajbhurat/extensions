import { lastNDays, emptyDay, fmtDuration, fmtHourMin, escapeHtml } from '../lib/core.js';
import { $, $$, el } from '../lib/ui.js';
import { barChart, legend } from '../lib/charts.js';

let data = { stats: {}, intentions: [], focusLog: [], settings: null };
let range = 7;
let intLimit = 50;
const charts = [];

try { range = Number(localStorage.getItem('mg-range')) === 30 ? 30 : 7; } catch { /* storage blocked */ }

const sum = obj => Object.values(obj || {}).reduce((a, b) => a + b, 0);
const day = k => ({ ...emptyDay(), ...(data.stats[k] || {}) });
const color = i => `var(--series-${i + 1})`;
const cssColor = v => v.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() : v;

async function load() {
  data = await chrome.storage.local.get(['stats', 'intentions', 'focusLog', 'settings']);
  data.stats = data.stats || {};
  data.intentions = data.intentions || [];
  data.focusLog = data.focusLog || [];
  render();
}

function labelFor(k, short) {
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return short ? `${m}/${d}` : dt.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}
function longLabel(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function totals(keys) {
  const t = { focus: 0, sessions: 0, distract: 0, prompts: 0, back: 0, passes: 0, blocked: 0, sites: {} };
  for (const k of keys) {
    const d = day(k);
    t.focus += d.focusMinutes;
    t.sessions += d.focusSessions;
    t.distract += sum(d.sites);
    t.prompts += sum(d.prompts);
    t.back += sum(d.turnedBack);
    t.passes += sum(d.passes);
    t.blocked += d.blockedHits || 0;
    for (const [s, v] of Object.entries(d.sites)) t.sites[s] = (t.sites[s] || 0) + v;
  }
  return t;
}

function pctDelta(cur, prev) {
  if (!prev) return cur ? 'new this week' : 'no change';
  const p = Math.round(((cur - prev) / prev) * 100);
  return `${p > 0 ? '+' : ''}${p}% vs last week`;
}

function renderSummary() {
  const all = lastNDays(14);
  const prevKeys = all.slice(0, 7), curKeys = all.slice(7);
  const cur = totals(curKeys), prev = totals(prevKeys);
  $('#sumRange').textContent = `${longLabel(curKeys[0])} to ${longLabel(curKeys[6])}`;
  const topSite = Object.entries(cur.sites).sort((a, b) => b[1] - a[1])[0];
  const rate = cur.prompts ? Math.round((cur.back / cur.prompts) * 100) : 0;
  const parts = [];
  parts.push(cur.focus
    ? `You focused <strong>${fmtDuration(cur.focus * 60)}</strong> across <strong>${cur.sessions}</strong> completed session${cur.sessions === 1 ? '' : 's'}.`
    : 'No focus sessions yet this week. Start one from the toolbar button.');
  if (cur.distract) parts.push(`You spent <strong>${fmtDuration(cur.distract)}</strong> on distracting sites${topSite ? `, most of it on <strong>${escapeHtml(topSite[0])}</strong>` : ''}.`);
  if (cur.prompts) parts.push(`The gate asked <strong>${cur.prompts}</strong> time${cur.prompts === 1 ? '' : 's'} and you turned back <strong>${cur.back}</strong> (${rate}%).`);
  if (cur.blocked) parts.push(`Blocks stopped <strong>${cur.blocked}</strong> visit${cur.blocked === 1 ? '' : 's'}.`);
  $('#summaryText').innerHTML = parts.join(' ');

  const kpis = [
    { label: 'Focus time', value: fmtDuration(cur.focus * 60), delta: pctDelta(cur.focus, prev.focus), good: cur.focus >= prev.focus },
    { label: 'Distraction time', value: fmtDuration(cur.distract), delta: pctDelta(cur.distract, prev.distract), good: cur.distract <= prev.distract },
    { label: 'Gate prompts', value: String(cur.prompts), delta: pctDelta(cur.prompts, prev.prompts), good: cur.prompts <= prev.prompts },
    { label: 'Turned back', value: cur.prompts ? `${rate}%` : '-', delta: `${cur.back} of ${cur.prompts} prompts`, good: null },
    { label: 'Blocked visits', value: String(cur.blocked), delta: 'during schedules and focus', good: null },
  ];
  const wrap = $('#kpis');
  wrap.textContent = '';
  for (const k of kpis) {
    const cls = k.good == null || /no change|new/.test(k.delta) ? 'delta' : `delta ${k.good ? 'good' : 'bad'}`;
    wrap.append(el('div', { class: 'kpi' }, el('span', { class: 'label' }, k.label), el('span', { class: 'value' }, k.value), el('span', { class: cls }, k.delta)));
  }
}

function table(container, head, rows, numCols = []) {
  const t = el('table', { class: 'data' });
  t.append(el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { class: numCols.includes(i) ? 'num' : '' }, h)))));
  const tb = el('tbody');
  if (!rows.length) tb.append(el('tr', {}, el('td', { class: 'empty', colspan: head.length }, 'Nothing recorded yet')));
  for (const r of rows) tb.append(el('tr', {}, r.map((c, i) => el('td', { class: numCols.includes(i) ? 'num' : '' }, c))));
  container.textContent = '';
  container.append(t);
}

function renderCharts() {
  charts.forEach(c => c.destroy());
  charts.length = 0;
  const keys = lastNDays(range);
  const labels = keys.map(k => labelFor(k, range > 7));
  const titles = keys.map(longLabel);

  // Stable site colors: rank by the last 30 days so toggling range never repaints a site.
  const ranking = totals(lastNDays(30)).sites;
  const top = Object.entries(ranking).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([s]) => s);
  const rangeSites = totals(keys).sites;
  const series = top.filter(s => rangeSites[s]).map(s => ({ name: s, color: cssColor(color(top.indexOf(s))), values: keys.map(k => (day(k).sites[s] || 0)) }));
  const otherVals = keys.map(k => Object.entries(day(k).sites).filter(([s]) => !top.includes(s)).reduce((a, [, v]) => a + v, 0));
  if (otherVals.some(Boolean)) series.push({ name: 'Other', color: cssColor('var(--series-other)'), values: otherVals });
  const minFmt = v => (v >= 3600 ? `${(v / 3600).toFixed(v % 3600 ? 1 : 0)}h` : `${Math.round(v / 60)}m`);
  charts.push(barChart($('#c1'), { labels, tipTitles: titles, series: series.length ? series : [{ name: 'Time', color: cssColor('var(--series-1)'), values: keys.map(() => 0) }], stacked: true, format: minFmt, minMax: 600, height: 260, ariaLabel: 'Stacked bar chart of time on distracting sites per day' }));
  legend($('#c1Legend'), series);
  table($('#c1Table'), ['Day', ...series.map(s => s.name), 'Total'],
    keys.map((k, i) => [titles[i], ...series.map(s => fmtDuration(s.values[i])), fmtDuration(series.reduce((a, s) => a + s.values[i], 0))]),
    series.map((_, i) => i + 1).concat(series.length + 1));

  const goal = data.settings && data.settings.pomodoro ? data.settings.pomodoro.dailyGoal * data.settings.pomodoro.work : 0;
  const focusVals = keys.map(k => day(k).focusMinutes);
  charts.push(barChart($('#c2'), { labels, tipTitles: titles, series: [{ name: 'Focus', color: cssColor('var(--series-3)'), values: focusVals }], format: v => fmtDuration(v * 60), minMax: 60, goal, goalLabel: `Goal ${fmtDuration(goal * 60)}`, ariaLabel: 'Bar chart of focus minutes per day' }));
  $('#c2Sub').textContent = goal ? `Per day. Dashed line is your daily goal (${data.settings.pomodoro.dailyGoal} sessions).` : 'Per day';
  table($('#c2Table'), ['Day', 'Focus', 'Sessions'], keys.map((k, i) => [titles[i], fmtDuration(focusVals[i] * 60), String(day(k).focusSessions)]), [1, 2]);

  const pSeries = [
    { name: 'Prompts', color: cssColor('var(--series-1)'), values: keys.map(k => sum(day(k).prompts)) },
    { name: 'Turned back', color: cssColor('var(--series-2)'), values: keys.map(k => sum(day(k).turnedBack)) },
  ];
  charts.push(barChart($('#c3'), { labels, tipTitles: titles, series: pSeries, format: v => String(Math.round(v)), minMax: 4, ariaLabel: 'Bar chart of gate prompts and turn-backs per day' }));
  legend($('#c3Legend'), pSeries);
  table($('#c3Table'), ['Day', 'Prompts', 'Turned back'], keys.map((k, i) => [titles[i], String(pSeries[0].values[i]), String(pSeries[1].values[i])]), [1, 2]);

  renderSites(keys);
}

function renderSites(keys) {
  const agg = {};
  for (const k of keys) {
    const d = day(k);
    for (const field of ['sites', 'prompts', 'turnedBack', 'passes']) {
      for (const [s, v] of Object.entries(d[field] || {})) {
        agg[s] = agg[s] || { sites: 0, prompts: 0, turnedBack: 0, passes: 0 };
        agg[s][field] += v;
      }
    }
  }
  const rows = Object.entries(agg).sort((a, b) => b[1].sites - a[1].sites || b[1].prompts - a[1].prompts);
  const max = Math.max(1, ...rows.map(([, v]) => v.sites));
  table($('#sitesTable'), ['Site', 'Time', 'Prompts', 'Passes', 'Turned back'], rows.map(([s, v]) => [
    s,
    el('span', { class: 'bar-cell' }, el('span', { class: 'mini', style: `width:${Math.round((v.sites / max) * 80)}px` }), fmtDuration(v.sites)),
    String(v.prompts), String(v.passes),
    v.prompts ? `${v.turnedBack} (${Math.round((v.turnedBack / v.prompts) * 100)}%)` : String(v.turnedBack),
  ]), [2, 3, 4]);
  // right-align the time column contents too
  $$('#sitesTable td:nth-child(2)').forEach(td => { td.classList.add('num'); });
}

function renderFocusLog() {
  const since = Date.now() - range * 86400000;
  const rows = data.focusLog.filter(f => f.end >= since).slice().reverse().slice(0, 200);
  table($('#focusTable'), ['When', 'Task', 'Minutes', ''], rows.map(f => [
    `${new Date(f.start).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtHourMin(f.start)}`,
    f.task || el('span', { class: 'muted' }, 'Untitled'),
    String(f.minutes),
    f.completed ? el('span', { class: 'pill accent outcome' }, 'Complete') : el('span', { class: 'pill outcome' }, 'Stopped early'),
  ]), [2]);
}

const OUTCOME = { pass: ['Pass', 'accent'], extend: ['Extended', 'warn'], back: ['Turned back', 'focus'], snooze: ['Snoozed block', 'warn'] };

function renderIntentions() {
  const q = $('#intSearch').value.trim().toLowerCase();
  const f = $('#intFilter').value;
  const rows = data.intentions.slice().reverse().filter(i =>
    (!f || i.outcome === f) && (!q || (i.text || '').toLowerCase().includes(q) || (i.domain || '').toLowerCase().includes(q)));
  const shown = rows.slice(0, intLimit);
  table($('#intTable'), ['When', 'Site', 'Intention', 'Outcome'], shown.map(i => {
    const [name, cls] = OUTCOME[i.outcome] || [i.outcome, ''];
    return [
      `${new Date(i.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtHourMin(i.ts)}`,
      i.domain,
      i.text || el('span', { class: 'muted' }, 'No intention written'),
      el('span', { class: `pill outcome ${cls}` }, i.minutes && i.outcome !== 'back' ? `${name} · ${i.minutes}m` : name),
    ];
  }));
  $('#moreInt').classList.toggle('hidden', rows.length <= intLimit);
}

function render() {
  for (const b of $$('[data-range]')) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range));
  renderSummary();
  renderCharts();
  renderFocusLog();
  renderIntentions();
}

for (const b of $$('[data-range]')) {
  b.addEventListener('click', () => {
    range = Number(b.dataset.range);
    try { localStorage.setItem('mg-range', String(range)); } catch { /* ignore */ }
    render();
  });
}
$('#intSearch').addEventListener('input', () => { intLimit = 50; renderIntentions(); });
$('#intFilter').addEventListener('change', () => { intLimit = 50; renderIntentions(); });
$('#moreInt').addEventListener('click', () => { intLimit += 100; renderIntentions(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderCharts());

let reloadTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.stats || changes.intentions || changes.focusLog)) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 1000);
  }
});

load();
