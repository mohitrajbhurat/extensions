// Clients, projects, rules (URL/domain/title -> project) and category overrides.
import * as store from '../../lib/store.js';
import { matchRule, inferKind, categoryFor, CATEGORY_META, DEFAULT_CATEGORY_MAP } from '../../lib/rules.js';
import { escapeHtml, uid, domainOf } from '../../lib/util.js';
import { PALETTE } from '../../shared/charts.js';
import { ICONS, toast, confirmDialog, projectOptions, projectName } from '../../shared/ui.js';

export function wantsLiveRefresh(_ctx, { keys }) {
  // Only re-render for changes to the lists shown here (made in another tab).
  return keys.some((k) => ['projects', 'clients', 'rules', 'categoryMap'].includes(k));
}

const KIND_LABEL = { auto: 'Auto', domain: 'Domain', url: 'URL pattern', title: 'Title keywords' };

export async function render(el, ctx) {
  const data = ctx.data;
  const st = (ctx.state.projects ||= { testUrl: '', testTitle: '', showArchived: false });
  const projects = [...data.projects].sort((a, b) => (a.archived - b.archived) || a.name.localeCompare(b.name));
  const visible = projects.filter((p) => st.showArchived || !p.archived);
  const cats = Object.entries(data.categoryMap).sort((a, b) => a[0].localeCompare(b[0]));

  el.innerHTML = `
    <div class="view-head"><h1>Projects &amp; rules</h1></div>
    <div class="stack" style="gap:16px">
      <section class="card projects">
        <header><h2>Projects</h2>
          <label class="check small"><input type="checkbox" id="showArchived" ${st.showArchived ? 'checked' : ''}> Show archived</label></header>
        <form class="row wrap" id="addProject" autocomplete="off">
          <input type="color" name="color" value="${PALETTE[data.projects.length % PALETTE.length]}" aria-label="Color">
          <input name="name" class="grow" placeholder="New project name" required aria-label="Project name" maxlength="80">
          <select name="client" aria-label="Client"><option value="">No client</option>${clientOpts(data, '')}</select>
          <input name="rate" type="number" min="0" step="0.01" placeholder="Rate/h" style="width:96px" aria-label="Hourly rate">
          <button class="btn primary" type="submit">${ICONS.plus} Add</button>
        </form>
        <div class="list-row list-head"><span>Color</span><span>Name</span><span>Client</span><span>Rate/h</span><span>Billable</span><span></span><span></span></div>
        ${visible.length ? visible.map((p) => `<div class="list-row" data-id="${escapeHtml(p.id)}" ${p.archived ? 'style="opacity:.6"' : ''}>
          <input type="color" data-f="color" value="${escapeHtml(p.color || '#0f766e')}" aria-label="Color for ${escapeHtml(p.name)}">
          <input data-f="name" value="${escapeHtml(p.name)}" aria-label="Project name" maxlength="80">
          <select data-f="clientId" aria-label="Client"><option value="">No client</option>${clientOpts(data, p.clientId)}</select>
          <input data-f="rate" type="number" min="0" step="0.01" value="${p.rate ?? ''}" placeholder="${escapeHtml(inheritRate(p, data))}" aria-label="Hourly rate">
          <label class="check" title="Billable"><input type="checkbox" data-f="billable" ${p.billable !== false ? 'checked' : ''}><span class="sr-only">Billable</span></label>
          <button class="btn sm" type="button" data-archive>${p.archived ? 'Restore' : 'Archive'}</button>
          <button class="btn ghost sm icon danger" type="button" data-del aria-label="Delete ${escapeHtml(p.name)}">${ICONS.trash}</button>
        </div>`).join('') : '<div class="empty">No projects yet. Add one above, for example "Acme website" or "Thesis".</div>'}
      </section>

      <section class="card clients">
        <header><h2>Clients</h2><span class="small muted">Client rate applies to projects without their own rate.</span></header>
        <form class="row wrap" id="addClient" autocomplete="off">
          <input name="name" class="grow" placeholder="New client name" required aria-label="Client name" maxlength="80">
          <input name="rate" type="number" min="0" step="0.01" placeholder="Rate/h" style="width:96px" aria-label="Hourly rate">
          <button class="btn primary" type="submit">${ICONS.plus} Add</button>
        </form>
        <div class="list-row list-head"><span>Name</span><span>Rate/h</span><span>Invoice details</span><span></span></div>
        ${data.clients.length ? data.clients.map((c) => `<div class="list-row" data-id="${escapeHtml(c.id)}">
          <input data-f="name" value="${escapeHtml(c.name)}" aria-label="Client name" maxlength="80">
          <input data-f="rate" type="number" min="0" step="0.01" value="${c.rate ?? ''}" placeholder="${ctx.data.settings.defaultRate || 0}" aria-label="Hourly rate">
          <textarea data-f="details" rows="2" style="min-height:32px" placeholder="Address, email (shown on invoices)" aria-label="Invoice details">${escapeHtml(c.details || '')}</textarea>
          <button class="btn ghost sm icon danger" type="button" data-del aria-label="Delete ${escapeHtml(c.name)}">${ICONS.trash}</button>
        </div>`).join('') : '<div class="empty">No clients yet.</div>'}
      </section>
    </div>

    <section class="card rules">
      <header><h2>Tracking rules</h2><span class="small muted">The first matching rule assigns automatic time to a project. Rules apply to past time too, except time you assigned by hand.</span></header>
      <form class="row wrap" id="addRule" autocomplete="off">
        <input name="pattern" class="grow" placeholder="github.com/acme/*  ·  acme.atlassian.net  ·  thesis, chapter" required aria-label="Pattern" style="min-width:260px">
        <select name="kind" aria-label="Match on">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <select name="project" aria-label="Project" required>${projectOptions(data, null, { noneLabel: 'Choose project…' })}</select>
        <button class="btn primary" type="submit">${ICONS.plus} Add rule</button>
      </form>
      <div class="list-row list-head"><span>On</span><span>Pattern</span><span>Match on</span><span>Project</span><span></span></div>
      ${data.rules.length ? data.rules.map((r, i) => `<div class="list-row" data-id="${escapeHtml(r.id)}">
        <input type="checkbox" data-f="enabled" ${r.enabled !== false ? 'checked' : ''} aria-label="Enabled">
        <input data-f="pattern" value="${escapeHtml(r.pattern)}" aria-label="Pattern">
        <select data-f="kind" aria-label="Match on">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}"${(r.kind || 'auto') === k ? ' selected' : ''}>${v}${k === 'auto' && (r.kind || 'auto') === 'auto' ? ` (${inferKind(r.pattern)})` : ''}</option>`).join('')}</select>
        <select data-f="projectId" aria-label="Project">${projectOptions(data, r.projectId, { includeArchived: true })}</select>
        <span class="row" style="gap:2px">
          <button class="btn ghost sm icon" type="button" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ICONS.up}</button>
          <button class="btn ghost sm icon" type="button" data-move="1" ${i === data.rules.length - 1 ? 'disabled' : ''} aria-label="Move down">${ICONS.down}</button>
          <button class="btn ghost sm icon danger" type="button" data-del aria-label="Delete rule">${ICONS.trash}</button>
        </span>
      </div>`).join('') : '<div class="empty">No rules yet. Example: <code>github.com/acme/*</code> → Acme.</div>'}
      <h3 style="margin-top:16px">Test a page</h3>
      <div class="row wrap" style="margin-top:8px">
        <input id="testUrl" class="grow" placeholder="https://github.com/acme/app/pull/12" value="${escapeHtml(st.testUrl)}" aria-label="Test URL">
        <input id="testTitle" class="grow" placeholder="Page title (optional)" value="${escapeHtml(st.testTitle)}" aria-label="Test page title">
      </div>
      <div id="testResult" class="test-result small" style="margin-top:8px" aria-live="polite"></div>
    </section>

    <section class="card cats">
      <header><h2>Site categories</h2><span class="small muted">Your overrides. ${Object.keys(DEFAULT_CATEGORY_MAP).length} common sites have built-in defaults; everything else is neutral.</span></header>
      <form class="row wrap" id="addCat" autocomplete="off">
        <input name="domain" class="grow" placeholder="example.com" required aria-label="Domain">
        <select name="cat" aria-label="Category">${Object.entries(CATEGORY_META).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <button class="btn primary" type="submit">${ICONS.plus} Add</button>
      </form>
      ${cats.length ? cats.map(([d, c]) => `<div class="list-row" data-domain="${escapeHtml(d)}">
        <span>${escapeHtml(d)}</span>
        <select data-cat aria-label="Category for ${escapeHtml(d)}">${Object.entries(CATEGORY_META).map(([k, v]) => `<option value="${k}"${k === c ? ' selected' : ''}>${v.label}</option>`).join('')}</select>
        <button class="btn ghost sm icon danger" type="button" data-del aria-label="Remove override">${ICONS.trash}</button>
      </div>`).join('') : '<div class="empty">No overrides. Change categories here or from the Sites list on the Screen time page.</div>'}
    </section>`;

  bind(el, ctx, st);
  runTest(el, ctx, st);
}

function clientOpts(data, selected) {
  return data.clients.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === selected ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function inheritRate(p, data) {
  const c = data.clients.find((x) => x.id === p.clientId);
  if (c && c.rate !== '' && c.rate != null) return `${c.rate} (client)`;
  return `${data.settings.defaultRate || 0} (default)`;
}

async function saveList(key, list) {
  await store.set({ [key]: list });
}

function bind(el, ctx, st) {
  const rerender = async () => { await ctx.reload(); await render(el, ctx); };
  el.querySelector('#showArchived').addEventListener('change', (e) => { st.showArchived = e.target.checked; render(el, ctx); });

  // ---- projects
  el.querySelector('#addProject').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.elements.name.value.trim();
    if (!name) return;
    if (ctx.data.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast('A project with that name exists', { error: true }); return; }
    const p = { id: uid('p'), name, color: f.color.value, clientId: f.client.value || null, rate: f.rate.value === '' ? '' : +f.rate.value, billable: true, archived: false };
    await saveList('projects', [...ctx.data.projects, p]);
    toast(`Project "${name}" added`);
    await rerender();
    el.querySelector('#addProject [name=name]').focus();
  });
  el.querySelectorAll('.projects .list-row[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', async () => {
      const list = ctx.data.projects.map((p) => {
        if (p.id !== id) return p;
        const f = inp.dataset.f;
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (f === 'rate') v = v === '' ? '' : Math.max(0, +v);
        if (f === 'name') { v = v.trim(); if (!v) { inp.value = p.name; return p; } }
        if (f === 'clientId') v = v || null;
        return { ...p, [f]: v };
      });
      await saveList('projects', list);
      await ctx.reload();
    }));
    row.querySelector('[data-archive]').addEventListener('click', async () => {
      await saveList('projects', ctx.data.projects.map((p) => (p.id === id ? { ...p, archived: !p.archived } : p)));
      await rerender();
    });
    row.querySelector('[data-del]').addEventListener('click', async () => {
      const p = ctx.data.projects.find((x) => x.id === id);
      const used = ctx.data.entries.filter((e) => e.projectId === id).length;
      const ok = await confirmDialog(`Delete project "${p.name}"? ${used ? `${used} entr${used === 1 ? 'y' : 'ies'} will become "No project". ` : ''}Rules for it will be removed. Archive instead to keep history.`, { okLabel: 'Delete', danger: true });
      if (!ok) return;
      await store.set({
        projects: ctx.data.projects.filter((x) => x.id !== id),
        rules: ctx.data.rules.filter((r) => r.projectId !== id),
        entries: ctx.data.entries.map((e) => (e.projectId === id ? { ...e, projectId: null } : e)),
        goals: ctx.data.goals.filter((g) => !(g.scope === 'project' && g.target === id)),
      });
      toast('Project deleted');
      await rerender();
    });
  });

  // ---- clients
  el.querySelector('#addClient').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.elements.name.value.trim();
    if (!name) return;
    await saveList('clients', [...ctx.data.clients, { id: uid('c'), name, rate: f.rate.value === '' ? '' : +f.rate.value, details: '' }]);
    toast(`Client "${name}" added`);
    await rerender();
  });
  el.querySelectorAll('.clients .list-row[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', async () => {
      const f = inp.dataset.f;
      await saveList('clients', ctx.data.clients.map((c) => {
        if (c.id !== id) return c;
        let v = inp.value;
        if (f === 'rate') v = v === '' ? '' : Math.max(0, +v);
        if (f === 'name' && !v.trim()) { inp.value = c.name; return c; }
        return { ...c, [f]: typeof v === 'string' ? v.trim() : v };
      }));
      await ctx.reload();
    }));
    row.querySelector('[data-del]').addEventListener('click', async () => {
      const c = ctx.data.clients.find((x) => x.id === id);
      if (!(await confirmDialog(`Delete client "${c.name}"? Its projects are kept without a client.`, { okLabel: 'Delete', danger: true }))) return;
      await store.set({
        clients: ctx.data.clients.filter((x) => x.id !== id),
        projects: ctx.data.projects.map((p) => (p.clientId === id ? { ...p, clientId: null } : p)),
      });
      await rerender();
    });
  });

  // ---- rules
  el.querySelector('#addRule').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const pattern = f.pattern.value.trim();
    if (!pattern) return;
    if (!f.project.value) { toast('Choose a project for the rule', { error: true }); f.project.focus(); return; }
    await saveList('rules', [...ctx.data.rules, { id: uid('r'), pattern, kind: f.kind.value, projectId: f.project.value, enabled: true }]);
    toast(`Rule added → ${projectName(f.project.value, ctx.data)}`);
    await rerender();
  });
  el.querySelectorAll('.rules .list-row[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', async () => {
      const f = inp.dataset.f;
      await saveList('rules', ctx.data.rules.map((r) => (r.id === id ? { ...r, [f]: inp.type === 'checkbox' ? inp.checked : (f === 'projectId' ? inp.value || null : inp.value.trim()) } : r)));
      await ctx.reload();
      runTest(el, ctx, st);
    }));
    row.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
      const list = [...ctx.data.rules];
      const i = list.findIndex((r) => r.id === id);
      const j = i + +b.dataset.move;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      await saveList('rules', list);
      await rerender();
      const btn = el.querySelector(`.rules .list-row[data-id="${CSS.escape(id)}"] [data-move="${b.dataset.move}"]`);
      if (btn && !btn.disabled) btn.focus();
    }));
    row.querySelector('[data-del]').addEventListener('click', async () => {
      const rule = ctx.data.rules.find((r) => r.id === id);
      await saveList('rules', ctx.data.rules.filter((r) => r.id !== id));
      toast('Rule deleted', { action: { label: 'Undo', run: async () => { const { rules = [] } = await store.get('rules'); await saveList('rules', [...rules, rule]); await rerender(); } } });
      await rerender();
    });
  });
  const test = () => { st.testUrl = el.querySelector('#testUrl').value; st.testTitle = el.querySelector('#testTitle').value; runTest(el, ctx, st); };
  el.querySelector('#testUrl').addEventListener('input', test);
  el.querySelector('#testTitle').addEventListener('input', test);

  // ---- categories
  el.querySelector('#addCat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = e.target.domain.value.trim();
    const domain = (raw.includes('/') ? domainOf(/^[a-z]+:/i.test(raw) ? raw : 'https://' + raw) : raw.toLowerCase().replace(/^www\./, ''));
    if (!domain) { toast('Enter a domain like example.com', { error: true }); return; }
    await store.set({ categoryMap: { ...ctx.data.categoryMap, [domain]: e.target.cat.value } });
    await rerender();
  });
  el.querySelectorAll('.cats .list-row[data-domain]').forEach((row) => {
    const d = row.dataset.domain;
    row.querySelector('[data-cat]').addEventListener('change', async (e) => {
      await store.set({ categoryMap: { ...ctx.data.categoryMap, [d]: e.target.value } });
      await ctx.reload();
    });
    row.querySelector('[data-del]').addEventListener('click', async () => {
      const m = { ...ctx.data.categoryMap };
      delete m[d];
      await store.set({ categoryMap: m });
      await rerender();
    });
  });
}

function runTest(el, ctx, st) {
  const out = el.querySelector('#testResult');
  const raw = st.testUrl.trim();
  if (!raw && !st.testTitle.trim()) { out.textContent = 'Type a URL or title to see which rule and category apply.'; return; }
  const url = raw && !/^[a-z]+:/i.test(raw) ? 'https://' + raw : raw;
  const act = { url, domain: domainOf(url), title: st.testTitle };
  const idx = ctx.data.rules.findIndex((r) => matchRule(r, act));
  const cat = categoryFor(act.domain, ctx.data.categoryMap);
  out.innerHTML = idx >= 0
    ? `Rule #${idx + 1} <code>${escapeHtml(ctx.data.rules[idx].pattern)}</code> matches → <strong>${escapeHtml(projectName(ctx.data.rules[idx].projectId, ctx.data))}</strong>. Category: ${CATEGORY_META[cat].label}.`
    : `No rule matches; time stays unassigned. Category: ${CATEGORY_META[cat].label}.`;
}
