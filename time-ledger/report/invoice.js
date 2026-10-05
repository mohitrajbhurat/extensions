// Printable invoice-style report for a date range and filters passed in the URL.
import * as store from '../lib/store.js';
import { billing, totalsBy, dur, rateFor } from '../lib/report.js';
import { fmtHours, fmtMoney, fmtDate, fmtTime, escapeHtml, parseDay, addDays, startOfDay, dayKey, fmtDur } from '../lib/util.js';
import { projectName, projectColor } from '../shared/ui.js';
import { reportItems } from '../app/views/reports.js';

const q = new URLSearchParams(location.search);
const today = startOfDay(Date.now());
const from = q.get('from') ? parseDay(q.get('from')) : addDays(today, -6);
const to = q.get('to') ? addDays(parseDay(q.get('to')), 1) : addDays(today, 1);
const st = {
  from, to,
  source: q.get('source') || 'manual',
  clientId: q.get('client') || '',
  projectId: q.get('project') || '',
  billableOnly: q.get('billable') === '1',
};

async function main() {
  const data = await store.getData();
  const items = await reportItems({ data }, st);
  const s = data.settings;
  const cur = s.currency;
  const bill = billing(items, data);
  const client = data.clients.find((c) => c.id === st.clientId)
    || (() => {
      // If every project in the report belongs to one client, bill that client.
      const ids = [...new Set(items.map((i) => (data.projects.find((p) => p.id === i.projectId) || {}).clientId).filter(Boolean))];
      return ids.length === 1 ? data.clients.find((c) => c.id === ids[0]) : null;
    })();
  const asInvoice = document.getElementById('asInvoice').checked;
  const showDetails = document.getElementById('details').checked;
  const number = `${s.invoice.prefix || ''}${dayKey(Date.now()).replace(/-/g, '')}`;
  const period = `${fmtDate(from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(addDays(to, -1), { month: 'short', day: 'numeric', year: 'numeric' })}`;
  document.title = `${asInvoice ? 'Invoice' : 'Time report'} ${client ? '· ' + client.name : ''} · ${period}`;

  const lines = bill.rows.filter((r) => r.ms > 0);
  const lineRows = lines.map((r) => {
    const p = data.projects.find((x) => x.id === r.projectId);
    const n = items.filter((i) => (i.projectId || null) === r.projectId).length;
    const billable = r.billableMs > 0;
    return `<tr>
      <td><span class="dot" style="background:${projectColor(r.projectId, data)}"></span><strong>${escapeHtml(projectName(r.projectId, data))}</strong>
        <div class="soft">${n} entr${n === 1 ? 'y' : 'ies'}${p && p.billable === false ? ' · non-billable' : ''}</div></td>
      <td class="num">${fmtHours(asInvoice ? r.billableMs : r.ms)}</td>
      ${asInvoice ? `<td class="num">${billable ? fmtMoney(r.rate, cur) : '–'}</td><td class="num">${fmtMoney(r.amount, cur)}</td>` : `<td class="num">${fmtHours(r.billableMs)}</td>`}
    </tr>`;
  }).join('');

  // Detail rows: timer entries individually, automatic time aggregated per day/project/site.
  const detail = [];
  const days = new Map();
  for (const it of items) {
    const d = startOfDay(it.start);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(it);
  }
  for (const d of [...days.keys()].sort((a, b) => a - b)) {
    const list = days.get(d);
    const manual = list.filter((i) => i.source === 'manual').sort((a, b) => a.start - b.start);
    const auto = totalsBy(list.filter((i) => i.source === 'auto'), (i) => `${i.projectId || ''}|${i.domain}`);
    detail.push(`<tr class="day"><td colspan="4">${fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })}</td><td class="num">${fmtHours(list.reduce((a, i) => a + dur(i), 0))}</td></tr>`);
    for (const m of manual) {
      detail.push(`<tr><td>${fmtTime(m.start)}–${fmtTime(m.end)}</td><td>${escapeHtml(m.desc || '—')}${(m.tags || []).length ? ` <span class="soft">#${m.tags.map(escapeHtml).join(' #')}</span>` : ''}</td>
        <td>${escapeHtml(projectName(m.projectId, data))}</td><td class="num">${asInvoice && m.billable !== false && m.projectId ? fmtMoney(rateFor(m.projectId, data), cur) : ''}</td><td class="num">${fmtHours(dur(m))}</td></tr>`);
    }
    for (const a of auto) {
      const [pid, domain] = a.key.split('|');
      detail.push(`<tr><td class="soft">auto</td><td>${escapeHtml(domain)}</td><td>${escapeHtml(projectName(pid || null, data))}</td><td></td><td class="num">${fmtHours(a.ms)}</td></tr>`);
    }
  }

  document.getElementById('paper').innerHTML = `
    <div class="head">
      <div>
        <h1>${asInvoice ? 'Invoice' : 'Time report'}</h1>
        <p class="from"><strong>${escapeHtml(s.invoice.fromName || '')}</strong>${s.invoice.fromDetails ? '\n' + escapeHtml(s.invoice.fromDetails) : ''}</p>
      </div>
      <div class="meta">
        ${asInvoice ? `<div><span class="soft">Invoice #</span> <strong>${escapeHtml(number)}</strong></div>` : ''}
        <div><span class="soft">Issued</span> ${fmtDate(Date.now(), { year: 'numeric', month: 'short', day: 'numeric' })}</div>
        <div><span class="soft">Period</span> ${period}</div>
      </div>
    </div>
    <div class="parties">
      ${client ? `<div><h3>Bill to</h3><p><strong>${escapeHtml(client.name)}</strong>${client.details ? '\n' + escapeHtml(client.details) : ''}</p></div>` : ''}
      <div><h3>Summary</h3><p>${fmtHours(bill.totalMs)} hours tracked\n${fmtHours(bill.billableMs)} hours billable</p></div>
    </div>
    ${lines.length ? `<table>
      <thead><tr><th>Project</th><th class="num">${asInvoice ? 'Billable hours' : 'Hours'}</th>${asInvoice ? '<th class="num">Rate</th><th class="num">Amount</th>' : '<th class="num">Billable hours</th>'}</tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <table class="totals">
      <tr><td>Total hours</td><td class="num">${fmtHours(bill.totalMs)}</td></tr>
      ${asInvoice ? `<tr><td>Billable hours</td><td class="num">${fmtHours(bill.billableMs)}</td></tr>
      ${s.roundMinutes ? `<tr><td class="soft" colspan="2">Timer entries rounded up to ${s.roundMinutes} min</td></tr>` : ''}
      <tr class="grand"><td>Amount due</td><td class="num">${fmtMoney(bill.amount, cur)}</td></tr>` : `<tr class="grand"><td>Total</td><td class="num">${fmtDur(bill.totalMs)}</td></tr>`}
    </table>` : '<p class="soft" style="margin-top:24px">No time recorded for this period and filters.</p>'}
    ${showDetails && detail.length ? `<h2>Details</h2><table>
      <thead><tr><th>Time</th><th>Description</th><th>Project</th><th class="num">${asInvoice ? 'Rate' : ''}</th><th class="num">Hours</th></tr></thead>
      <tbody>${detail.join('')}</tbody></table>` : ''}
    ${s.invoice.notes ? `<p class="notes">${escapeHtml(s.invoice.notes)}</p>` : ''}
    <p class="footer">Generated with Time Ledger on ${fmtDate(Date.now(), { year: 'numeric', month: 'long', day: 'numeric' })}</p>`;
}

document.getElementById('print').addEventListener('click', () => window.print());
document.getElementById('details').addEventListener('change', main);
document.getElementById('asInvoice').addEventListener('change', main);
main().catch((e) => {
  document.getElementById('paper').innerHTML = `<p>Could not build the report: ${escapeHtml(e.message)}</p>`;
});
