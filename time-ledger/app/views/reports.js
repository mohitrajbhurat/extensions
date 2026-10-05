// Reports: date range, filters, charts, weekly timesheet grid, billing, exports.
import { total, totalsBy, timesheet, billing, itemsToCSV, clip } from '../../lib/report.js';
import { fmtDur, fmtHours, fmtMoney, fmtDate, escapeHtml, startOfDay, addDays, startOfWeek, startOfMonth, addMonths, dayKey, parseDay } from '../../lib/util.js';
import { stackedBars, donut, PALETTE } from '../../shared/charts.js';
import { toast, download, loadRange, projectName, projectColor } from '../../shared/ui.js';

const PRESETS = {
  today: 'Today', thisWeek: 'This week', lastWeek: 'Last week', thisMonth: 'This month',
  lastMonth: 'Last month', last30: 'Last 30 days', custom: 'Custom range',
};

export function presetRange(preset, weekStart = 1, now = Date.now()) {
  const today = startOfDay(now);
  switch (preset) {
    case 'today': return { from: today, to: addDays(today, 1) };
    case 'lastWeek': { const f = addDays(startOfWeek(now, weekStart), -7); return { from: f, to: addDays(f, 7) }; }
    case 'thisMonth': { const f = startOfMonth(now); return { from: f, to: addMonths(f, 1) }; }
    case 'lastMonth': { const f = addMonths(startOfMonth(now), -1); return { from: f, to: startOfMonth(now) }; }
    case 'last30': return { from: addDays(today, -29), to: addDays(today, 1) };
    case 'thisWeek':
    default: { const f = startOfWeek(now, weekStart); return { from: f, to: addDays(f, 7) }; }
  }
}

export function wantsLiveRefresh(_ctx, { onlyEngine }) {
  return !onlyEngine;
}

/** Items for the current report state; shared with the invoice page through URL params. */
export async function reportItems(ctx, st) {
  const { auto, manual } = await loadRange(st.from, st.to, ctx.data);
  let items = [];
  if (st.source !== 'auto') items.push(...manual);
  if (st.source !== 'manual') items.push(...auto);
  const pmap = new Map(ctx.data.projects.map((p) => [p.id, p]));
  if (st.clientId) items = items.filter((i) => (pmap.get(i.projectId) || {}).clientId === st.clientId);
  if (st.projectId) items = items.filter((i) => (st.projectId === '__none' ? !i.projectId : i.projectId === st.projectId));
  if (st.billableOnly) items = items.filter((i) => i.projectId && i.billable !== false && (pmap.get(i.projectId) || {}).billable !== false);
  return clip(items, st.from, st.to);
}

export async function render(el, ctx, alive) {
  const s = ctx.data.settings;
  const st = (ctx.state.reports ||= { preset: 'thisWeek', source: s.includeAuto ? 'both' : 'manual', clientId: '', projectId: '', billableOnly: false });
  if (st.preset !== 'custom') Object.assign(st, presetRange(st.preset, s.weekStart));
  const items = await reportItems(ctx, st);
  if (!alive()) return;
  const data = ctx.data;
  const days = Math.round((st.to - st.from) / 864e5);
  const byWeek = days > 35;
  const keyFn = (i) => i.projectId || null;
  const ts = timesheet(items, st.from, st.to, keyFn);
  const bill = billing(items, data);
  const colorOf = (id, idx) => (id ? projectColor(id, data) : '#94a3b8') || PALETTE[idx % PALETTE.length];
  const tags = totalsBy(items.flatMap((i) => (i.tags || []).map((t) => ({ ...i, tag: t }))), (i) => i.tag);
  const elapsedDays = Math.max(1, Math.round((Math.min(st.to, addDays(startOfDay(Date.now()), 1)) - st.from) / 864e5));
  const cur = s.currency;

  el.innerHTML = `
    <div class="view-head"><h1>Reports</h1>
      <div class="controls">
        <button class="btn" type="button" id="csv">Export CSV</button>
        <button class="btn" type="button" id="tsCsv">Timesheet CSV</button>
        <button class="btn primary" type="button" id="invoice">Invoice / print</button>
      </div></div>
    <section class="card row wrap" aria-label="Filters" style="align-items:flex-end;gap:12px">
      <label class="field">Range<select id="preset">${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}"${k === st.preset ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">From<input type="date" id="from" value="${dayKey(st.from)}"></label>
      <label class="field">To<input type="date" id="to" value="${dayKey(addDays(st.to, -1))}"></label>
      <label class="field">Source<select id="source">
        <option value="both"${st.source === 'both' ? ' selected' : ''}>Timer + automatic</option>
        <option value="manual"${st.source === 'manual' ? ' selected' : ''}>Timer entries only</option>
        <option value="auto"${st.source === 'auto' ? ' selected' : ''}>Automatic only</option></select></label>
      <label class="field">Client<select id="client"><option value="">All clients</option>${data.clients.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === st.clientId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>
      <label class="field">Project<select id="project"><option value="">All projects</option><option value="__none"${st.projectId === '__none' ? ' selected' : ''}>No project</option>${data.projects.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === st.projectId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>
      <label class="check" style="min-height:32px"><input type="checkbox" id="billableOnly" ${st.billableOnly ? 'checked' : ''}> Billable only</label>
    </section>
    <div class="kpis">
      <div class="card kpi"><div class="label">Total</div><div class="value">${fmtDur(ts.total)}</div><div class="sub">${fmtHours(ts.total)} h</div></div>
      <div class="card kpi"><div class="label">Billable</div><div class="value">${fmtDur(bill.billableMs)}</div><div class="sub">${ts.total ? Math.round((bill.billableMs / ts.total) * 100) : 0}% of total</div></div>
      <div class="card kpi"><div class="label">Amount</div><div class="value">${fmtMoney(bill.amount, cur)}</div><div class="sub">${s.roundMinutes ? `timer entries rounded up to ${s.roundMinutes} min` : 'unrounded'}</div></div>
      <div class="card kpi"><div class="label">Daily average</div><div class="value">${fmtDur(ts.total / elapsedDays)}</div><div class="sub">over ${elapsedDays} day${elapsedDays === 1 ? '' : 's'}</div></div>
    </div>
    <div class="grid main-side">
      <section class="card"><header><h2>Per day by project</h2></header><div class="chart-wrap"><canvas id="bars"></canvas></div>
        <div class="legend" style="margin-top:8px">${ts.rows.slice(0, 12).map((r, i) => `<span><span class="dot" style="background:${colorOf(r.key, i)}"></span>${escapeHtml(projectName(r.key, data))}</span>`).join('')}</div></section>
      <section class="card"><header><h2>By project</h2></header><div class="chart-wrap"><canvas id="donut"></canvas></div></section>
    </div>
    <section class="card">
      <header><h2>Timesheet</h2><span class="small muted">${byWeek ? 'Weeks' : 'Days'} · ${fmtDate(st.from, { month: 'short', day: 'numeric' })} – ${fmtDate(addDays(st.to, -1), { month: 'short', day: 'numeric', year: 'numeric' })}</span></header>
      ${ts.rows.length ? timesheetTable(ts, data, byWeek, s.weekStart) : '<div class="empty">Nothing tracked in this range with these filters.</div>'}
    </section>
    <div class="grid two">
      <section class="card"><header><h2>Billing</h2></header>
        ${bill.rows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Project</th><th>Client</th><th class="num">Hours</th><th class="num">Billable</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
          <tbody>${bill.rows.map((r) => {
            const p = data.projects.find((x) => x.id === r.projectId);
            const c = p && data.clients.find((x) => x.id === p.clientId);
            return `<tr><td><span class="row"><span class="dot" style="background:${colorOf(r.projectId, 0)}"></span>${escapeHtml(projectName(r.projectId, data))}</span></td>
              <td>${escapeHtml(c ? c.name : '')}</td><td class="num">${fmtHours(r.ms)}</td><td class="num">${fmtHours(r.billableMs)}</td>
              <td class="num">${r.billableMs ? fmtMoney(r.rate, cur) : ''}</td><td class="num">${fmtMoney(r.amount, cur)}</td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr><td colspan="2">Total</td><td class="num">${fmtHours(bill.totalMs)}</td><td class="num">${fmtHours(bill.billableMs)}</td><td></td><td class="num">${fmtMoney(bill.amount, cur)}</td></tr></tfoot>
        </table></div>` : '<div class="empty">No time yet.</div>'}
      </section>
      <section class="card"><header><h2>By tag</h2></header>
        ${tags.length ? `<table><tbody>${tags.map((t) => `<tr><td><span class="tag">#${escapeHtml(t.key)}</span></td><td class="num">${t.count}</td><td class="num">${fmtDur(t.ms)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No tagged entries. Add tags to timer entries to see a breakdown.</div>'}
      </section>
    </div>`;

  // Charts
  const series = ts.rows.slice(0, 12).map((r, i) => ({ label: projectName(r.key, data), color: colorOf(r.key, i), values: r.cells }));
  if (ts.rows.length > 12) {
    const rest = ts.rows.slice(12);
    series.push({ label: 'Other', color: '#cbd5e1', values: ts.days.map((_, i) => rest.reduce((a, r) => a + r.cells[i], 0)) });
  }
  stackedBars(el.querySelector('#bars'), {
    labels: ts.days.map((d) => (days <= 7 ? fmtDate(d, { weekday: 'short' }) : String(new Date(d).getDate()))),
    tipLabels: ts.days.map((d) => fmtDate(d)),
    series, fmt: (v) => fmtDur(v), height: 260, ariaLabel: 'Time per day stacked by project',
  });
  donut(el.querySelector('#donut'), {
    slices: ts.rows.map((r, i) => ({ label: projectName(r.key, data), color: colorOf(r.key, i), value: r.total })),
    center: fmtDur(ts.total), sub: `${ts.rows.length} project${ts.rows.length === 1 ? '' : 's'}`, fmt: (v) => fmtDur(v), height: 260,
    ariaLabel: 'Time by project',
  });

  // Filters
  const rerender = () => render(el, ctx, alive);
  el.querySelector('#preset').addEventListener('change', (e) => { st.preset = e.target.value; rerender(); });
  const setCustom = () => {
    const f = el.querySelector('#from').value, t = el.querySelector('#to').value;
    if (!f || !t) return;
    let from = parseDay(f), to = addDays(parseDay(t), 1);
    if (to <= from) [from, to] = [addDays(to, -1), addDays(from, 1)];
    if (to - from > 366 * 864e5) { toast('Choose a range of a year or less', { error: true }); return; }
    Object.assign(st, { preset: 'custom', from, to });
    rerender();
  };
  el.querySelector('#from').addEventListener('change', setCustom);
  el.querySelector('#to').addEventListener('change', setCustom);
  el.querySelector('#source').addEventListener('change', (e) => { st.source = e.target.value; rerender(); });
  el.querySelector('#client').addEventListener('change', (e) => { st.clientId = e.target.value; rerender(); });
  el.querySelector('#project').addEventListener('change', (e) => { st.projectId = e.target.value; rerender(); });
  el.querySelector('#billableOnly').addEventListener('change', (e) => { st.billableOnly = e.target.checked; rerender(); });

  const fname = (k) => `time-ledger-${k}-${dayKey(st.from)}_${dayKey(addDays(st.to, -1))}.csv`;
  el.querySelector('#csv').addEventListener('click', () => {
    if (!items.length) { toast('Nothing to export'); return; }
    download(fname('entries'), itemsToCSV(items, data), 'text/csv');
  });
  el.querySelector('#tsCsv').addEventListener('click', () => {
    download(fname('timesheet'), timesheetCSV(ts, data), 'text/csv');
  });
  el.querySelector('#invoice').addEventListener('click', () => {
    const q = new URLSearchParams({ from: dayKey(st.from), to: dayKey(addDays(st.to, -1)), source: st.source, client: st.clientId, project: st.projectId, billable: st.billableOnly ? '1' : '' });
    chrome.tabs.create({ url: chrome.runtime.getURL(`report/invoice.html?${q}`) });
  });
}

function weekBuckets(ts, weekStart) {
  const cols = [];
  ts.days.forEach((d, i) => {
    const w = startOfWeek(d, weekStart);
    let col = cols.find((c) => c.start === w);
    if (!col) { col = { start: w, idx: [] }; cols.push(col); }
    col.idx.push(i);
  });
  return cols;
}

function timesheetTable(ts, data, byWeek, weekStart) {
  const today = startOfDay(Date.now());
  const cols = byWeek
    ? weekBuckets(ts, weekStart).map((c) => ({ label: `Wk ${fmtDate(c.start, { month: 'short', day: 'numeric' })}`, idx: c.idx, today: false }))
    : ts.days.map((d, i) => ({ label: fmtDate(d, { weekday: 'short', day: 'numeric' }), idx: [i], today: d === today }));
  const cell = (ms) => `<td class="num ${ms ? '' : 'zero'}">${ms ? fmtDur(ms) : '–'}</td>`;
  const sum = (arr, idx) => idx.reduce((a, i) => a + arr[i], 0);
  return `<div class="table-wrap"><table class="ts">
    <thead><tr><th>Project</th>${cols.map((c) => `<th class="num ${c.today ? 'today' : ''}">${c.label}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>${ts.rows.map((r) => {
      const p = data.projects.find((x) => x.id === r.key);
      const c = p && data.clients.find((x) => x.id === p.clientId);
      return `<tr><td><span class="proj"><span class="dot" style="background:${projectColor(r.key, data)}"></span>${escapeHtml(projectName(r.key, data))}${c ? `<span class="muted small">${escapeHtml(c.name)}</span>` : ''}</span></td>
        ${cols.map((col) => cell(sum(r.cells, col.idx))).join('')}<td class="num"><strong>${fmtDur(r.total)}</strong></td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>Total</td>${cols.map((col) => `<td class="num">${fmtDur(sum(ts.dayTotals, col.idx))}</td>`).join('')}<td class="num">${fmtDur(ts.total)}</td></tr></tfoot>
  </table></div>`;
}

function timesheetCSV(ts, data) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['Project', 'Client', ...ts.days.map((d) => dayKey(d)), 'Total (h)'].map(q).join(',')];
  for (const r of ts.rows) {
    const p = data.projects.find((x) => x.id === r.key);
    const c = p && data.clients.find((x) => x.id === p.clientId);
    lines.push([projectName(r.key, data), c ? c.name : '', ...r.cells.map((ms) => (ms / 3600000).toFixed(2)), (r.total / 3600000).toFixed(2)].map(q).join(','));
  }
  lines.push(['Total', '', ...ts.dayTotals.map((ms) => (ms / 3600000).toFixed(2)), (ts.total / 3600000).toFixed(2)].map(q).join(','));
  return lines.join('\r\n') + '\r\n';
}

export { total };
