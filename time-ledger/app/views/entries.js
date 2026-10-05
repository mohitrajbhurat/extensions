// Timer & entries: running timer, manual entries (add/edit/split/merge/delete),
// and assigning uncategorized automatic time to projects.
import * as store from '../../lib/store.js';
import { total, totalsBy, splitEntry, mergeEntries, validateEntry, findOverlaps } from '../../lib/report.js';
import { fmtDur, fmtClock, fmtTime, fmtDate, escapeHtml, startOfDay, addDays, toLocalInput, fromLocalInput, parseDuration, uid } from '../../lib/util.js';
import { $, ICONS, toast, confirmDialog, projectOptions, projectName, projectColor, loadRange, parseTags, faviconFor } from '../../shared/ui.js';
import { rangeFor, labelFor, periodControls, bindPeriod } from '../period.js';

let selected = new Set();

export function tick(ctx) {
  const t = ctx.data && ctx.data.timer;
  const c = document.getElementById('tbClock');
  if (c) c.textContent = fmtClock(t ? Date.now() - t.start : 0);
  const live = document.getElementById('liveDur');
  if (live && t) live.textContent = fmtDur(Date.now() - t.start, { seconds: true });
}

export function wantsLiveRefresh(_ctx, { onlyEngine }) {
  // Engine heartbeats only matter for the unassigned panel; skip them to keep the page calm.
  return !onlyEngine;
}

export async function render(el, ctx, alive) {
  const st = (ctx.state.entries ||= { period: 'week', anchor: Date.now() });
  const { from, to } = rangeFor(st.period, st.anchor, ctx.data.settings.weekStart);
  const { auto, data } = await loadRange(from, to, ctx.data);
  if (!alive()) return;
  const entries = data.entries.filter((e) => e.end > from && e.start < to).sort((a, b) => b.start - a.start);
  selected = new Set([...selected].filter((id) => entries.some((e) => e.id === id)));
  const overlaps = new Set(findOverlaps(data.entries).flat());
  const t = data.timer;

  // group by day (start day)
  const groups = new Map();
  if (t && t.start < to && Date.now() >= from) {
    const k = startOfDay(t.start);
    groups.set(k, [{ ...t, id: 'running', end: Date.now(), live: true }]);
  }
  for (const e of entries) {
    const k = startOfDay(e.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const days = [...groups.keys()].sort((a, b) => b - a);

  const unassigned = totalsBy(auto.filter((i) => !i.projectId), (i) => i.domain).slice(0, 25);

  el.innerHTML = `
    <div class="view-head"><h1>Timer &amp; entries</h1>
      <div class="controls"><button class="btn" type="button" id="addEntry">${ICONS.plus} Add entry</button></div></div>
    <form class="card timerbar ${t ? 'running' : ''}" id="timerbar" autocomplete="off">
      <input class="desc" id="tbDesc" placeholder="What are you working on?" aria-label="Description" value="${escapeHtml(t ? t.desc : st.draftDesc || '')}" maxlength="200">
      <select id="tbProject" aria-label="Project">${projectOptions(data, t ? t.projectId : st.draftProject || null)}</select>
      <input id="tbTags" placeholder="tags" aria-label="Tags" value="${escapeHtml(t ? (t.tags || []).join(', ') : st.draftTags || '')}">
      <label class="check small" title="Billable"><input type="checkbox" id="tbBillable" ${!t || t.billable !== false ? 'checked' : ''}> $</label>
      <span class="clock" id="tbClock">${fmtClock(t ? Date.now() - t.start : 0)}</span>
      <button class="btn go ${t ? 'stop' : 'primary'}" type="submit" aria-label="${t ? 'Stop timer' : 'Start timer'}" title="${t ? 'Stop timer' : 'Start timer'}">${t ? ICONS.stop : ICONS.play}</button>
    </form>
    <div class="view-head"><h2>Entries</h2>${periodControls(st.period, labelFor(st.period, from, to))}</div>
    <div class="card bulk ${selected.size ? '' : 'hidden'}" id="bulk">
      <strong id="bulkCount">${selected.size} selected</strong>
      <button class="btn sm" type="button" data-bulk="merge">Merge</button>
      <select class="compact" id="bulkProject" aria-label="Set project for selected"><option value="__">Set project…</option>${projectOptions(data, '__', { noneLabel: 'No project' })}</select>
      <button class="btn sm danger" type="button" data-bulk="delete">Delete</button>
      <button class="btn sm ghost" type="button" data-bulk="clear">Clear selection</button>
    </div>
    <div class="stack" id="dayList">
      ${days.length ? days.map((d) => dayGroup(d, groups.get(d), data, overlaps)).join('') : `<div class="card empty">No timer entries in this period. Start the timer above or add an entry manually.</div>`}
    </div>
    <section class="card">
      <header><h2>Unassigned automatic time</h2><span class="small muted">${labelFor(st.period, from, to)} · ${fmtDur(total(auto.filter((i) => !i.projectId)))} without a project</span></header>
      ${unassigned.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Site</th><th class="num">Time</th><th>Assign to</th></tr></thead><tbody>
        ${unassigned.map((u) => `<tr data-domain="${escapeHtml(u.key)}"><td style="width:28px">${faviconFor(u.key)}</td><td>${escapeHtml(u.key)}</td>
          <td class="num">${fmtDur(u.ms)}</td>
          <td><select class="compact" data-assign aria-label="Assign ${escapeHtml(u.key)} to project"><option value="">Choose project…</option>${projectOptions(data, null, { noneLabel: '' }).replace('<option value=""></option>', '')}</select></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">All automatic time in this period has a project. Nice.</div>'}
    </section>`;

  bindTimer(el, ctx, st);
  bindPeriod(el, st, () => render(el, ctx, alive));
  bindEntries(el, ctx, alive);
  el.querySelector('#addEntry').addEventListener('click', () => entryDialog(ctx, null));
  el.querySelectorAll('[data-assign]').forEach((sel) => sel.addEventListener('change', async () => {
    if (!sel.value) return;
    const domain = sel.closest('tr').dataset.domain;
    const n = await store.send('assign', { match: { from, to, domain, onlyUnassigned: true }, projectId: sel.value });
    toast(`Assigned ${n} block${n === 1 ? '' : 's'} on ${domain} to ${projectName(sel.value, ctx.data)}`, {
      action: { label: 'Always (add rule)', run: () => addRule(ctx, domain, sel.value) }, timeout: 7000,
    });
    await ctx.refresh();
  }));
}

async function addRule(ctx, domain, projectId) {
  const { rules = [] } = await store.get('rules');
  rules.push({ id: uid('r'), pattern: domain, kind: 'domain', projectId, enabled: true });
  await store.set({ rules });
  toast(`Rule added: ${domain} → ${projectName(projectId, ctx.data)}`);
}

function dayGroup(day, list, data, overlaps) {
  const sum = list.reduce((a, e) => a + (e.end - e.start), 0);
  const today = startOfDay(Date.now());
  const label = day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' });
  return `<section class="day-group" aria-label="${escapeHtml(label)}">
    <header><span>${label}</span><span class="mono">${fmtDur(sum)}</span></header>
    ${list.sort((a, b) => b.start - a.start).map((e) => entryRow(e, data, overlaps)).join('')}
  </section>`;
}

function entryRow(e, data, overlaps) {
  const live = e.id === 'running';
  const pc = projectColor(e.projectId, data);
  const p = data.projects.find((x) => x.id === e.projectId);
  const client = p && data.clients.find((c) => c.id === p.clientId);
  return `<div class="entry ${live ? 'live' : ''}" data-id="${escapeHtml(e.id)}">
    ${live ? '<span></span>' : `<input type="checkbox" data-sel aria-label="Select entry" ${selected.has(e.id) ? 'checked' : ''}>`}
    <div class="what">
      <span class="d">${escapeHtml(e.desc || '(no description)')}</span>
      <span class="meta"><span class="dot" style="background:${pc}"></span>${escapeHtml(projectName(e.projectId, data))}${client ? ` · ${escapeHtml(client.name)}` : ''}
        ${(e.tags || []).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
        ${e.billable === false ? '<span class="chip">non-billable</span>' : ''}
        ${overlaps.has(e.id) ? '<span class="warn" title="Overlaps another entry">overlaps</span>' : ''}</span>
    </div>
    <span class="range">${fmtTime(e.start)} – ${live ? 'now' : fmtTime(e.end)}${!live && startOfDay(e.end - 1) !== startOfDay(e.start) ? ' (+1d)' : ''}</span>
    <span class="dur" ${live ? 'id="liveDur"' : ''}>${fmtDur(e.end - e.start, { seconds: live })}</span>
    <span class="acts">
      ${live ? '' : `<button class="btn ghost sm icon" type="button" data-act="continue" title="Continue" aria-label="Continue this entry">${ICONS.play}</button>
      <button class="btn ghost sm icon" type="button" data-act="edit" title="Edit" aria-label="Edit entry">${ICONS.edit}</button>
      <button class="btn ghost sm icon" type="button" data-act="split" title="Split" aria-label="Split entry">${ICONS.split}</button>
      <button class="btn ghost sm icon" type="button" data-act="dup" title="Duplicate" aria-label="Duplicate entry">${ICONS.copy}</button>
      <button class="btn ghost sm icon danger" type="button" data-act="delete" title="Delete" aria-label="Delete entry">${ICONS.trash}</button>`}
    </span>
  </div>`;
}

function bindTimer(el, ctx, st) {
  const form = el.querySelector('#timerbar');
  const read = () => ({
    desc: $('#tbDesc', form).value.trim(),
    projectId: $('#tbProject', form).value || null,
    tags: parseTags($('#tbTags', form).value),
    billable: $('#tbBillable', form).checked,
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (ctx.data.timer) {
        const entry = await store.send('timer.stop');
        toast(entry ? `Saved ${fmtDur(entry.end - entry.start)}` : 'Timer discarded (under 1 second)');
        st.draftDesc = ''; st.draftProject = null; st.draftTags = '';
      } else {
        await store.send('timer.start', read());
      }
      await ctx.refresh();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  form.addEventListener('change', async () => {
    if (ctx.data.timer) await store.send('timer.update', { patch: read() });
    else { const r = read(); st.draftDesc = r.desc; st.draftProject = r.projectId; st.draftTags = $('#tbTags', form).value; }
  });
}

function bindEntries(el, ctx, alive) {
  const updateBulk = () => {
    const bulk = el.querySelector('#bulk');
    bulk.classList.toggle('hidden', !selected.size);
    el.querySelector('#bulkCount').textContent = `${selected.size} selected`;
  };
  el.querySelectorAll('[data-sel]').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.closest('.entry').dataset.id;
    if (cb.checked) selected.add(id); else selected.delete(id);
    updateBulk();
  }));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('.entry').dataset.id;
    const entry = ctx.data.entries.find((e) => e.id === id);
    if (!entry) return;
    const act = b.dataset.act;
    if (act === 'continue') {
      await store.send('timer.start', { desc: entry.desc, projectId: entry.projectId, tags: entry.tags, billable: entry.billable });
      await ctx.refresh();
    } else if (act === 'edit') {
      entryDialog(ctx, entry);
    } else if (act === 'split') {
      splitDialog(ctx, entry);
    } else if (act === 'dup') {
      const len = entry.end - entry.start;
      const copy = { ...entry, id: uid('e'), start: entry.end, end: entry.end + len };
      await store.upsertEntry(copy);
      toast('Duplicated after the original');
      await ctx.refresh();
    } else if (act === 'delete') {
      await store.deleteEntries([id]);
      toast('Entry deleted', { action: { label: 'Undo', run: async () => { await store.upsertEntry(entry); await ctx.refresh(); } } });
      await ctx.refresh();
    }
  }));
  el.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
    const list = ctx.data.entries.filter((e) => selected.has(e.id));
    if (b.dataset.bulk === 'clear') { selected.clear(); render(el, ctx, alive); return; }
    if (b.dataset.bulk === 'delete') {
      if (!(await confirmDialog(`Delete ${list.length} entr${list.length === 1 ? 'y' : 'ies'}?`, { okLabel: 'Delete', danger: true }))) return;
      await store.deleteEntries(list.map((e) => e.id));
      selected.clear();
      toast('Deleted', { action: { label: 'Undo', run: async () => { await store.saveEntries([...(await store.getEntries()), ...list]); await ctx.refresh(); } } });
      await ctx.refresh();
    }
    if (b.dataset.bulk === 'merge') {
      try {
        const merged = mergeEntries(list);
        const all = (await store.getEntries()).filter((e) => !selected.has(e.id));
        all.push(merged);
        await store.saveEntries(all);
        selected.clear();
        toast(`Merged into one ${fmtDur(merged.end - merged.start)} entry`, { action: { label: 'Undo', run: async () => {
          const cur = (await store.getEntries()).filter((e) => e.id !== merged.id);
          await store.saveEntries([...cur, ...list]);
          await ctx.refresh();
        } } });
        await ctx.refresh();
      } catch (e) {
        toast(e.message, { error: true });
      }
    }
  }));
  el.querySelector('#bulkProject').addEventListener('change', async (ev) => {
    const v = ev.target.value;
    if (v === '__') return;
    const all = await store.getEntries();
    for (const e of all) if (selected.has(e.id)) e.projectId = v || null;
    await store.saveEntries(all);
    toast(`Project set on ${selected.size} entr${selected.size === 1 ? 'y' : 'ies'}`);
    selected.clear();
    await ctx.refresh();
  });
}

/** Add / edit dialog. */
export function entryDialog(ctx, entry) {
  const isNew = !entry;
  const now = Date.now();
  const e = entry || { start: now - 3600e3, end: now, desc: '', projectId: null, tags: [], billable: true };
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" novalidate>
    <h2>${isNew ? 'Add time entry' : 'Edit time entry'}</h2>
    <label class="field">Description<input name="desc" value="${escapeHtml(e.desc)}" maxlength="200" autofocus></label>
    <div class="row wrap">
      <label class="field grow">Project<select name="project">${projectOptions(ctx.data, e.projectId, { includeArchived: true })}</select></label>
      <label class="field grow">Tags<input name="tags" value="${escapeHtml((e.tags || []).join(', '))}" placeholder="design, meeting"></label>
    </div>
    <div class="row wrap">
      <label class="field grow">Start<input type="datetime-local" name="start" value="${toLocalInput(e.start)}" required></label>
      <label class="field grow">End<input type="datetime-local" name="end" value="${toLocalInput(e.end)}" required></label>
      <label class="field" style="width:110px">Duration<input name="dur" value="${fmtDurInput(e.end - e.start)}" placeholder="1:30" aria-describedby="durHelp"></label>
    </div>
    <span class="help" id="durHelp">Duration accepts 1:30, 1h 30m, 90m or 1.5. Changing it moves the end time.</span>
    <label class="check"><input type="checkbox" name="billable" ${e.billable !== false ? 'checked' : ''}> Billable</label>
    <p class="error small" style="color:var(--danger)" role="alert"></p>
    <div class="actions">
      ${isNew ? '' : '<button class="btn danger" value="delete" type="submit" formnovalidate>Delete</button><span class="grow"></span>'}
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">${isNew ? 'Add entry' : 'Save'}</button>
    </div></form>`;
  document.body.appendChild(d);
  const f = d.querySelector('form');
  const sync = () => {
    const s = fromLocalInput(f.start.value), en = fromLocalInput(f.end.value);
    if (Number.isFinite(s) && Number.isFinite(en)) f.dur.value = fmtDurInput(en - s);
  };
  f.start.addEventListener('change', () => {
    const ms = parseDuration(f.dur.value);
    const s = fromLocalInput(f.start.value);
    if (Number.isFinite(ms) && Number.isFinite(s)) f.end.value = toLocalInput(s + ms); else sync();
  });
  f.end.addEventListener('change', sync);
  f.dur.addEventListener('change', () => {
    const ms = parseDuration(f.dur.value);
    const s = fromLocalInput(f.start.value);
    if (Number.isFinite(ms) && Number.isFinite(s)) f.end.value = toLocalInput(s + ms);
  });
  f.addEventListener('submit', async (ev) => {
    const action = ev.submitter && ev.submitter.value;
    if (action === 'cancel') return;
    ev.preventDefault();
    if (action === 'delete') {
      await store.deleteEntries([entry.id]);
      d.close();
      toast('Entry deleted', { action: { label: 'Undo', run: async () => { await store.upsertEntry(entry); await ctx.refresh(); } } });
      await ctx.refresh();
      return;
    }
    // Keep seconds from the original when the minute did not change.
    let start = fromLocalInput(f.start.value);
    let end = fromLocalInput(f.end.value);
    if (!isNew && toLocalInput(e.start) === f.start.value) start = e.start;
    if (!isNew && toLocalInput(e.end) === f.end.value) end = e.end;
    const next = {
      ...e, id: e.id || uid('e'), desc: f.desc.value.trim(), projectId: f.project.value || null,
      tags: parseTags(f.tags.value), billable: f.billable.checked, start, end,
    };
    const errors = validateEntry(next);
    if (errors.length) { f.querySelector('.error').textContent = errors.join(' '); return; }
    await store.upsertEntry(next);
    d.close();
    toast(isNew ? 'Entry added' : 'Entry saved');
    await ctx.refresh();
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

function fmtDurInput(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function splitDialog(ctx, entry) {
  const mid = entry.start + Math.round((entry.end - entry.start) / 2 / 60000) * 60000;
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog">
    <h2>Split entry</h2>
    <p class="muted">${escapeHtml(entry.desc || '(no description)')} · ${fmtTime(entry.start)}–${fmtTime(entry.end)} (${fmtDur(entry.end - entry.start)})</p>
    <label class="field">Split at<input type="datetime-local" name="at" value="${toLocalInput(mid)}"></label>
    <label class="field">Second part's project<select name="project">${projectOptions(ctx.data, entry.projectId)}</select></label>
    <label class="field">Second part's description<input name="desc" value="${escapeHtml(entry.desc || '')}"></label>
    <p class="error small" style="color:var(--danger)" role="alert"></p>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Split</button></div>
  </form>`;
  document.body.appendChild(d);
  const f = d.querySelector('form');
  f.addEventListener('submit', async (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    try {
      const [a, b] = splitEntry(entry, fromLocalInput(f.at.value));
      b.projectId = f.project.value || null;
      b.desc = f.desc.value.trim();
      const all = (await store.getEntries()).filter((e) => e.id !== entry.id);
      await store.saveEntries([...all, a, b]);
      d.close();
      toast('Entry split in two');
      await ctx.refresh();
    } catch (e) {
      f.querySelector('.error').textContent = e.message;
    }
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
}
