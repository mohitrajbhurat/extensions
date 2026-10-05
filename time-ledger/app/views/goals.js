// Daily goals and limits with today's progress.
import * as store from '../../lib/store.js';
import { evaluateGoals, goalLabel } from '../../lib/goals.js';
import { CATEGORY_META } from '../../lib/rules.js';
import { fmtDur, escapeHtml, uid, startOfDay, addDays } from '../../lib/util.js';
import { ICONS, toast, loadRange, projectOptions } from '../../shared/ui.js';

export function wantsLiveRefresh(_ctx, { keys }) {
  return keys.some((k) => k === 'goals' || k === 'projects') || keys.includes('engine');
}

function targetField(scope, target, data, name = 'target') {
  if (scope === 'category') {
    return `<select data-f="${name}" name="${name}" aria-label="Category">${Object.entries(CATEGORY_META).map(([k, v]) => `<option value="${k}"${k === target ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
  }
  if (scope === 'domain') return `<input data-f="${name}" name="${name}" value="${escapeHtml(target || '')}" placeholder="youtube.com" aria-label="Site">`;
  if (scope === 'project') return `<select data-f="${name}" name="${name}" aria-label="Project">${projectOptions(data, target || null, { noneLabel: 'Choose project…' })}</select>`;
  return '<span class="muted small">All browsing</span>';
}

const SCOPES = { total: 'All browsing', category: 'Category', domain: 'Site', project: 'Project' };

export async function render(el, ctx) {
  const data = ctx.data;
  const st = (ctx.state.goals ||= { scope: 'category' });
  const from = startOfDay(Date.now());
  const { auto, manual } = await loadRange(from, addDays(from, 1), data);
  const results = evaluateGoals(data.goals, [...auto, ...manual]);

  el.innerHTML = `
    <div class="view-head"><h1>Goals &amp; limits</h1></div>
    <section class="card">
      <header><h2>Today</h2><span class="small muted">Notifications fire once per day when a limit is near (80%) or exceeded, and when a goal is reached.</span></header>
      ${results.length ? `<div class="goal-cards">${results.map((r) => {
        const p = Math.min(100, r.pct * 100);
        const color = r.goal.kind === 'limit'
          ? (r.status === 'exceeded' ? 'var(--danger)' : r.status === 'warning' ? 'var(--warning)' : 'var(--accent)')
          : (r.status === 'reached' ? 'var(--success)' : 'var(--accent)');
        const text = { exceeded: `Over by ${fmtDur(r.ms - r.targetMs)}`, warning: `${fmtDur(r.targetMs - r.ms)} left`, ok: `${fmtDur(r.targetMs - r.ms)} left`, reached: 'Reached', progress: `${fmtDur(r.targetMs - r.ms)} to go` }[r.status];
        return `<div class="goal-card"><strong>${escapeHtml(goalLabel(r.goal, data.projects))}</strong>
          <div class="row between"><span class="mono">${fmtDur(r.ms)} / ${fmtDur(r.targetMs)}</span><span class="status ${r.status}">${text}</span></div>
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><span style="width:${p}%;background:${color}"></span></div></div>`;
      }).join('')}</div>` : '<div class="empty">No active goals or limits.</div>'}
    </section>
    <section class="card goals-list">
      <header><h2>All goals and limits</h2></header>
      <form class="row wrap" id="addGoal" autocomplete="off">
        <select name="kind" aria-label="Type"><option value="limit">Limit (at most)</option><option value="goal">Goal (at least)</option></select>
        <select name="scope" aria-label="Applies to">${Object.entries(SCOPES).map(([k, v]) => `<option value="${k}"${k === st.scope ? ' selected' : ''}>${v}</option>`).join('')}</select>
        ${targetField(st.scope, st.scope === 'category' ? 'distracting' : '', data)}
        <input name="minutes" type="number" min="1" max="1440" value="60" style="width:90px" aria-label="Minutes per day"> <span class="muted small">min/day</span>
        <button class="btn primary" type="submit">${ICONS.plus} Add</button>
      </form>
      <div class="list-row list-head"><span>Type</span><span>Applies to</span><span>Target</span><span>Min/day</span><span>Notify</span><span>On</span><span></span></div>
      ${data.goals.length ? data.goals.map((g) => `<div class="list-row" data-id="${escapeHtml(g.id)}">
        <select data-f="kind" aria-label="Type"><option value="limit"${g.kind === 'limit' ? ' selected' : ''}>Limit</option><option value="goal"${g.kind === 'goal' ? ' selected' : ''}>Goal</option></select>
        <select data-f="scope" aria-label="Applies to">${Object.entries(SCOPES).map(([k, v]) => `<option value="${k}"${k === g.scope ? ' selected' : ''}>${v}</option>`).join('')}</select>
        ${targetField(g.scope, g.target, data)}
        <input data-f="minutes" type="number" min="1" max="1440" value="${+g.minutes}" aria-label="Minutes per day">
        <label class="check"><input type="checkbox" data-f="notify" ${g.notify !== false ? 'checked' : ''}><span class="sr-only">Notify</span></label>
        <label class="check"><input type="checkbox" data-f="enabled" ${g.enabled !== false ? 'checked' : ''}><span class="sr-only">Enabled</span></label>
        <button class="btn ghost sm icon danger" type="button" data-del aria-label="Delete">${ICONS.trash}</button>
      </div>`).join('') : '<div class="empty">Add a limit such as "Distracting sites, 60 min" or a goal such as "Project Thesis, 120 min".</div>'}
    </section>`;

  const form = el.querySelector('#addGoal');
  form.scope.addEventListener('change', () => { st.scope = form.scope.value; render(el, ctx); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = form.scope.value;
    const target = scope === 'total' ? '' : (form.elements.target ? form.elements.target.value.trim().toLowerCase().replace(/^www\./, '') : '');
    const t = scope === 'project' && form.elements.target ? form.elements.target.value : target;
    if (scope !== 'total' && !t) { toast('Choose what the goal applies to', { error: true }); return; }
    const minutes = Math.round(+form.minutes.value);
    if (!(minutes > 0)) { toast('Enter minutes per day', { error: true }); return; }
    await store.set({ goals: [...data.goals, { id: uid('g'), kind: form.kind.value, scope, target: t, minutes, enabled: true, notify: true }] });
    toast('Added');
    await ctx.refresh();
  });
  el.querySelectorAll('.goals-list .list-row[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', async () => {
      const f = inp.dataset.f;
      const goals = ctx.data.goals.map((g) => {
        if (g.id !== id) return g;
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (f === 'minutes') v = Math.max(1, Math.round(+v || 1));
        const next = { ...g, [f]: v };
        if (f === 'scope') next.target = v === 'category' ? 'distracting' : '';
        if (f === 'target' && g.scope === 'domain') next.target = String(v).trim().toLowerCase().replace(/^www\./, '');
        return next;
      });
      await store.set({ goals });
      if (f === 'scope') await ctx.refresh(); else await ctx.reload();
    }));
    row.querySelector('[data-del]').addEventListener('click', async () => {
      await store.set({ goals: ctx.data.goals.filter((g) => g.id !== id) });
      await ctx.refresh();
    });
  });
}
