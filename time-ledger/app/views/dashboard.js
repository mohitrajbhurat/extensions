// Screen time: today / week / month by site and category, goals.
import * as store from '../../lib/store.js';
import { CATEGORIES, CATEGORY_META } from '../../lib/rules.js';
import { total, totalsBy, hourly, timesheet, siteTotals } from '../../lib/report.js';
import { evaluateGoals, goalLabel } from '../../lib/goals.js';
import { fmtDur, fmtDate, escapeHtml, startOfDay, addDays, uid } from '../../lib/util.js';
import { stackedBars, donut } from '../../shared/charts.js';
import { toast, projectOptions, projectName, loadRange, faviconFor } from '../../shared/ui.js';
import { rangeFor, labelFor, periodControls, bindPeriod } from '../period.js';

const ALL_LIMIT = 40;

export function wantsLiveRefresh(ctx) {
  // Only live-refresh when looking at a range that includes now.
  const st = ctx.state.dash;
  if (!st) return true;
  const { from, to } = rangeFor(st.period, st.anchor, ctx.data.settings.weekStart);
  const now = Date.now();
  return now >= from && now < to;
}

export async function render(el, ctx, alive) {
  const st = (ctx.state.dash ||= { period: 'day', anchor: Date.now(), showAll: false, open: {} });
  const { settings } = ctx.data;
  const { from, to } = rangeFor(st.period, st.anchor, settings.weekStart);
  const { auto, manual, data } = await loadRange(from, to, ctx.data);
  if (!alive()) return;

  const totalMs = total(auto);
  const byCat = Object.fromEntries(totalsBy(auto, (i) => i.category).map((r) => [r.key, r.ms]));
  const prod = byCat.productive || 0;
  const dist = byCat.distracting || 0;
  const sites = siteTotals(auto, data.categoryMap);
  const elapsedDays = Math.max(1, Math.round((Math.min(to, addDays(startOfDay(Date.now()), 1)) - from) / 864e5));
  const score = totalMs ? Math.round(((prod + (byCat.neutral || 0) * 0.5) / totalMs) * 100) : 0;

  el.innerHTML = `
    <div class="view-head">
      <h1>Screen time</h1>
      ${periodControls(st.period, labelFor(st.period, from, to))}
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="label">Browsing</div><div class="value">${fmtDur(totalMs)}</div>
        <div class="sub">${st.period === 'day' ? `${sites.length} sites` : `${fmtDur(totalMs / elapsedDays)} per day`}</div></div>
      <div class="card kpi"><div class="label">Productive</div><div class="value" style="color:var(--productive)">${fmtDur(prod)}</div>
        <div class="sub">${pct(prod, totalMs)} of browsing</div></div>
      <div class="card kpi"><div class="label">Distracting</div><div class="value" style="color:var(--distracting)">${fmtDur(dist)}</div>
        <div class="sub">${pct(dist, totalMs)} of browsing</div></div>
      <div class="card kpi"><div class="label">Focus score</div><div class="value">${totalMs ? score : '–'}</div>
        <div class="sub">productive + half of neutral</div></div>
      <div class="card kpi"><div class="label">Timer</div><div class="value">${fmtDur(total(manual))}</div>
        <div class="sub">${manual.length} entr${manual.length === 1 ? 'y' : 'ies'}</div></div>
    </div>
    <div class="grid main-side">
      <section class="card">
        <header><h2>${st.period === 'day' ? 'By hour' : 'By day'}</h2>
          <div class="legend">${CATEGORIES.map((c) => `<span><span class="dot" style="background:${CATEGORY_META[c].color}"></span>${CATEGORY_META[c].label}</span>`).join('')}</div></header>
        <div class="chart-wrap"><canvas id="timeChart"></canvas></div>
      </section>
      <section class="card">
        <header><h2>By category</h2></header>
        <div class="chart-wrap"><canvas id="catDonut"></canvas></div>
        <div class="legend" style="justify-content:center;margin-top:8px">
          ${CATEGORIES.map((c) => `<span><span class="dot" style="background:${CATEGORY_META[c].color}"></span>${CATEGORY_META[c].label} ${fmtDur(byCat[c] || 0)}</span>`).join('')}
        </div>
      </section>
    </div>
    ${st.period === 'day' ? goalsCard(data, [...auto, ...manual]) : ''}
    <section class="card">
      <header><h2>Sites</h2><span class="small muted">Change a category or assign a site's time to a project. Assignments apply to this ${st.period}.</span></header>
      ${sites.length ? sitesTable(sites, auto, data, totalMs, st) : '<div class="empty">No browsing recorded in this period. Keep Time Ledger running and visit some sites.</div>'}
    </section>`;

  // Charts
  const canvas = el.querySelector('#timeChart');
  if (st.period === 'day') {
    const b = hourly(auto, from);
    stackedBars(canvas, {
      labels: [...Array(24)].map((_, h) => String(h)),
      tipLabels: [...Array(24)].map((_, h) => `${String(h).padStart(2, '0')}:00`),
      series: CATEGORIES.map((c) => ({ label: CATEGORY_META[c].label, color: CATEGORY_META[c].color, values: b[c] || new Array(24).fill(0) })),
      fmt: (v) => fmtDur(v), ariaLabel: 'Browsing time by hour and category',
    });
  } else {
    const ts = timesheet(auto, from, to, (i) => i.category);
    const rowFor = (c) => (ts.rows.find((r) => r.key === c) || { cells: ts.days.map(() => 0) }).cells;
    stackedBars(canvas, {
      labels: ts.days.map((d) => st.period === 'week' ? fmtDate(d, { weekday: 'short' }) : String(new Date(d).getDate())),
      tipLabels: ts.days.map((d) => fmtDate(d)),
      series: CATEGORIES.map((c) => ({ label: CATEGORY_META[c].label, color: CATEGORY_META[c].color, values: rowFor(c) })),
      fmt: (v) => fmtDur(v), ariaLabel: 'Browsing time by day and category',
    });
  }
  donut(el.querySelector('#catDonut'), {
    slices: CATEGORIES.map((c) => ({ label: CATEGORY_META[c].label, color: CATEGORY_META[c].color, value: byCat[c] || 0 })),
    center: fmtDur(totalMs), sub: 'browsing', fmt: (v) => fmtDur(v), ariaLabel: 'Browsing time by category',
  });

  bindPeriod(el, st, () => render(el, ctx, alive));
  bindSites(el, ctx, st, from, to, alive);
}

function pct(a, b) {
  return b ? `${Math.round((a / b) * 100)}%` : '0%';
}

function goalsCard(data, items) {
  const results = evaluateGoals(data.goals, items);
  if (!results.length) return '';
  return `<section class="card"><header><h2>Goals &amp; limits</h2><a href="#goals" class="small">Edit</a></header>
    <div class="goal-cards">${results.map((r) => {
      const p = Math.min(100, r.pct * 100);
      const color = r.goal.kind === 'limit'
        ? (r.status === 'exceeded' ? 'var(--danger)' : r.status === 'warning' ? 'var(--warning)' : 'var(--accent)')
        : (r.status === 'reached' ? 'var(--success)' : 'var(--accent)');
      const statusText = { exceeded: 'Over limit', warning: 'Close to limit', ok: 'Within limit', reached: 'Goal reached', progress: `${fmtDur(Math.max(0, r.targetMs - r.ms))} to go` }[r.status];
      return `<div class="goal-card"><strong>${escapeHtml(goalLabel(r.goal, data.projects))}</strong>
        <div class="row between"><span class="mono">${fmtDur(r.ms)} / ${fmtDur(r.targetMs)}</span><span class="status ${r.status}">${statusText}</span></div>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><span style="width:${p}%;background:${color}"></span></div></div>`;
    }).join('')}</div></section>`;
}

function sitesTable(sites, auto, data, totalMs, st) {
  const list = st.showAll ? sites : sites.slice(0, ALL_LIMIT);
  const rows = list.map((s) => {
    const items = auto.filter((i) => i.domain === s.domain);
    const projs = totalsBy(items, (i) => i.projectId || '');
    const single = projs.length === 1 ? projs[0].key : null;
    const sel = single === null ? '__mixed' : single;
    const pages = st.open[s.domain] ? totalsBy(items, (i) => i.url).slice(0, 12) : [];
    const titleOf = (url) => (items.find((i) => i.url === url && i.title) || {}).title || '';
    return `<tr class="site-row" data-domain="${escapeHtml(s.domain)}">
        <td>${faviconFor(s.domain)}</td>
        <td><div class="site-name"><button class="btn ghost sm" type="button" data-pages aria-expanded="${!!st.open[s.domain]}" style="justify-content:flex-start;padding:0">
          <strong class="t">${escapeHtml(s.domain)}</strong></button></div></td>
        <td><select class="cat-select" data-cat aria-label="Category for ${escapeHtml(s.domain)}">
          ${['productive', 'neutral', 'distracting'].map((c) => `<option value="${c}"${c === s.category ? ' selected' : ''}>${CATEGORY_META[c].label}</option>`).join('')}
        </select></td>
        <td><select class="compact" data-assign aria-label="Project for ${escapeHtml(s.domain)}">
          ${sel === '__mixed' ? '<option value="__mixed" selected disabled>Mixed projects</option>' : ''}
          ${projectOptions(data, sel === '__mixed' ? undefined : sel, { noneLabel: 'No project' })}
          <option value="__rules">Reset to rules</option>
        </select></td>
        <td class="pct-bar"><div class="bar"><span style="width:${(s.ms / sites[0].ms) * 100}%;background:${CATEGORY_META[s.category].color}"></span></div></td>
        <td class="num">${pct(s.ms, totalMs)}</td>
        <td class="num"><strong>${fmtDur(s.ms)}</strong></td>
      </tr>
      ${pages.map((p) => `<tr class="page-row"><td></td><td colspan="4"><div class="site-name"><span class="t small">${escapeHtml(titleOf(p.key) || p.key)}</span>
        <span class="t small muted">${escapeHtml(p.key)}</span></div></td><td></td><td class="num small">${fmtDur(p.ms)}</td></tr>`).join('')}`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th></th><th>Site</th><th>Category</th><th>Project</th><th></th><th class="num">Share</th><th class="num">Time</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${sites.length > ALL_LIMIT ? `<div class="row" style="justify-content:center;margin-top:8px"><button class="btn sm" type="button" data-showall>${st.showAll ? 'Show fewer' : `Show all ${sites.length} sites`}</button></div>` : ''}`;
}

function bindSites(el, ctx, st, from, to, alive) {
  el.querySelectorAll('[data-pages]').forEach((b) => b.addEventListener('click', () => {
    const d = b.closest('tr').dataset.domain;
    st.open[d] = !st.open[d];
    render(el, ctx, alive);
  }));
  const showAll = el.querySelector('[data-showall]');
  if (showAll) showAll.addEventListener('click', () => { st.showAll = !st.showAll; render(el, ctx, alive); });

  el.querySelectorAll('[data-cat]').forEach((sel) => sel.addEventListener('change', async () => {
    const domain = sel.closest('tr').dataset.domain;
    const { categoryMap = {} } = await store.get('categoryMap');
    categoryMap[domain] = sel.value;
    await store.set({ categoryMap });
    toast(`${domain} is now ${CATEGORY_META[sel.value].label.toLowerCase()}`);
    await ctx.refresh();
  }));

  el.querySelectorAll('[data-assign]').forEach((sel) => sel.addEventListener('change', async () => {
    const domain = sel.closest('tr').dataset.domain;
    const v = sel.value;
    const projectId = v === '__rules' ? null : v;
    try {
      const n = await store.send('assign', { match: { from, to, domain }, projectId });
      const name = projectId ? projectName(projectId, ctx.data) : projectId === '' ? 'No project' : 'rules';
      toast(`Assigned ${n} block${n === 1 ? '' : 's'} on ${domain} to ${name}`, projectId ? {
        action: {
          label: 'Always (add rule)',
          run: async () => {
            const { rules = [] } = await store.get('rules');
            rules.push({ id: uid('r'), pattern: domain, kind: 'domain', projectId, enabled: true });
            await store.set({ rules });
            toast(`Rule added: ${domain} → ${projectName(projectId, ctx.data)}`);
          },
        },
        timeout: 7000,
      } : {});
      await ctx.refresh();
    } catch (e) {
      toast(e.message, { error: true });
    }
  }));
}
