// Full-page rule editor: groups, rules, validation, URL tester, installed-rule inspector,
// settings, import/export (including ModHeader profiles).
import {
  getState, update, mutations, onStateChanged, getSettings, setSettings, STATE_KEY,
} from '../lib/store.js';
import {
  RULE_TYPES, MATCH_TYPES, RESOURCE_TYPES, RESOURCE_LABELS, METHODS, UA_PRESETS, MOCK_CONTENT_TYPES,
  COMMON_REQUEST_HEADERS, COMMON_RESPONSE_HEADERS, GROUP_COLORS, MOCK_MAX_BYTES,
  newRule, newGroup, defaultAction, defaultState, normalizeRule, compileRule, conditionMatches, applyRedirect,
  conditionSummary, actionSummary, ruleDisplayName, findRule, testRequest, exportState, parseImport,
  clone, byteLength, formatBytes, buildMockDataUrl, splitList,
} from '../lib/rules.js';
import { $, $$, el, clear, toast, send, applyTheme, download, pickFile } from '../shared/ui.js';

const STATUS_KEY = 'syncStatus';
const isSet = v => v !== undefined && v !== null;

let state = null;
let syncStatus = null;
let route = { view: 'group', id: null, params: new URLSearchParams() };
let searchText = '';
let welcome = new URLSearchParams(location.search).has('welcome');

applyTheme();
init().catch(e => { console.warn(e); toast(String(e && e.message || e), 'error'); });

async function init() {
  state = await getState();
  syncStatus = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || null;
  wireChrome();
  parseRoute();
  renderAll();
  onStateChanged(s => { state = s; renderAll(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATUS_KEY]) { syncStatus = changes[STATUS_KEY].newValue || null; renderSyncPill(); if (route.view === 'group' || route.view === 'status') renderMain(); }
  });
  window.addEventListener('hashchange', () => { parseRoute(); renderAll(); });
  // Ask the worker to sync once, in case it was asleep when the state changed.
  send({ cmd: 'sync' });
}

// ---------- routing ----------

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const [path, query = ''] = h.split('?');
  const params = new URLSearchParams(query);
  const [key, val] = path.split('=');
  if (key === 'tester' || key === 'status' || key === 'settings') route = { view: key, id: null, params };
  else if (key === 'rule' && val) {
    const found = findRule(state, decodeURIComponent(val));
    route = { view: 'group', id: found ? found.group.id : firstGroupId(), params };
    if (found) setTimeout(() => openRule(found.rule.id), 0);
  } else if (key === 'group' && val) route = { view: 'group', id: decodeURIComponent(val), params };
  else route = { view: 'group', id: firstGroupId(), params };
}

function firstGroupId() { return state.groups[0] ? state.groups[0].id : null; }

function go(hash) {
  if (location.hash === hash) { parseRoute(); renderAll(); }
  else location.hash = hash;
}

// ---------- top bar ----------

function wireChrome() {
  $('#pauseToggle').addEventListener('change', async e => {
    await update(s => mutations.setPaused(s, !e.target.checked));
    toast(e.target.checked ? 'Rules on' : 'All rules paused');
  });
  $('#newGroup').addEventListener('click', addGroup);
  $('#importBtn').addEventListener('click', startImport);
  $('#exportBtn').addEventListener('click', () => exportGroups(null));
  $('#search').addEventListener('input', e => { searchText = e.target.value.trim().toLowerCase(); renderMain(); });
  for (const b of $$('.nav-item[data-view]')) b.addEventListener('click', () => go('#' + b.dataset.view));
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
    if (e.key === '/' && !typing && !$('#ruleDialog').open) { e.preventDefault(); $('#search').focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && $('#ruleDialog').open) { e.preventDefault(); saveRule(); }
  });
  wireRuleDialog();
  wireImportDialog();
}

function renderAll() {
  renderTop();
  renderNav();
  renderMain();
}

function renderTop() {
  $('#pauseToggle').checked = !state.paused;
  $('#pauseText').textContent = state.paused ? 'Paused' : 'On';
  renderSyncPill();
}

function renderSyncPill() {
  const pill = $('#syncPill');
  const errs = (syncStatus && syncStatus.errors) || [];
  if (state.paused) { pill.className = 'pill amber'; pill.textContent = 'Paused'; pill.title = 'No rule is applied while paused.'; return; }
  if (errs.length || (syncStatus && syncStatus.installError)) {
    pill.className = 'pill red';
    pill.textContent = `${errs.length || 1} rule error${errs.length === 1 ? '' : 's'}`;
    pill.title = 'Open "Installed rules" for details';
    return;
  }
  const n = syncStatus ? syncStatus.installed : 0;
  pill.className = 'pill green';
  pill.textContent = `${n} rule${n === 1 ? '' : 's'} active`;
  pill.title = syncStatus ? `Synced ${new Date(syncStatus.at).toLocaleTimeString()}` : '';
}

function renderNav() {
  const nav = $('#groupNav');
  clear(nav);
  for (const g of state.groups) {
    const on = g.rules.filter(r => r.enabled).length;
    const btn = el('button', {
      class: 'nav-item' + (g.enabled ? '' : ' off'),
      title: g.enabled ? g.name : `${g.name} (off)`,
      onclick: () => go('#group=' + encodeURIComponent(g.id)),
    }, [
      el('span', { class: 'dot', style: `background:${g.color || 'var(--accent)'}` }),
      el('span', { class: 'n-name', text: g.name }),
      isSet(g.tabScope) ? el('span', { class: 'pill accent', text: 'tab' }) : null,
      el('span', { class: 'n-count', text: `${on}/${g.rules.length}` }),
    ]);
    if (route.view === 'group' && route.id === g.id && !searchText) btn.setAttribute('aria-current', 'page');
    nav.append(el('li', {}, btn));
  }
  for (const b of $$('.nav-item[data-view]')) {
    if (route.view === b.dataset.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

function renderMain() {
  const main = $('#main');
  clear(main);
  let view;
  if (searchText) view = searchView();
  else if (route.view === 'tester') view = testerView();
  else if (route.view === 'status') view = statusView();
  else if (route.view === 'settings') view = settingsView();
  else view = groupView();
  if (welcome && !searchText) view.prepend(welcomeCard());
  main.append(view);
}

function welcomeCard() {
  return el('div', { class: 'card welcome' }, [
    el('div', { class: 'row' }, [el('h3', { text: 'Welcome to Request Rewriter' }), el('div', { class: 'spacer' }),
      el('button', { class: 'ghost sm', text: 'Dismiss', onclick: () => { welcome = false; history.replaceState(null, '', location.pathname + location.hash); renderMain(); } })]),
    el('ol', {}, [
      el('li', { text: 'Create a group for a scenario (for example "Staging"), then add rules to it.' }),
      el('li', { text: 'Rules can change headers, redirect, swap hosts, edit query strings, block, mock responses or override the user agent.' }),
      el('li', { text: 'Toggle whole groups from the toolbar popup, or pause everything at once.' }),
      el('li', { text: 'Use "Test a URL" to see exactly what would happen to a request before you load it.' }),
    ]),
    el('p', { class: 'small muted', text: 'The Examples group is off. Turn it on or copy from it.' }),
  ]);
}

// ---------- groups ----------

async function addGroup() {
  const g = newGroup('New group', { color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length] });
  await update(s => { s.groups.push(g); });
  go('#group=' + encodeURIComponent(g.id));
  setTimeout(() => { const t = $('.g-title'); if (t) { t.focus(); t.select(); } }, 30);
}

function errorsFor(ruleId) {
  return ((syncStatus && syncStatus.errors) || []).filter(e => e.ruleId === ruleId);
}

function groupView() {
  const g = state.groups.find(x => x.id === route.id) || state.groups[0];
  const view = el('div', { class: 'view' });
  if (!g) {
    view.append(el('div', { class: 'card empty-state' }, [
      el('h2', { text: 'No groups yet' }),
      el('p', { text: 'Groups hold related rules so you can switch a whole scenario on or off.' }),
      el('button', { class: 'primary', text: 'Create a group', onclick: addGroup }),
    ]));
    return view;
  }
  route.id = g.id;
  const idx = state.groups.indexOf(g);
  const patch = p => update(s => mutations.updateGroup(s, g.id, p));

  const title = el('input', { type: 'text', class: 'g-title', value: g.name, 'aria-label': 'Group name', maxLength: 80 });
  title.addEventListener('change', () => patch({ name: title.value.trim() || 'Untitled group' }));
  title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur(); });
  const color = el('input', { type: 'color', value: g.color || '#2743b8', 'aria-label': 'Group color', title: 'Group color' });
  color.addEventListener('change', () => patch({ color: color.value }));
  const desc = el('input', { type: 'text', value: g.description || '', placeholder: 'Description (optional)', 'aria-label': 'Group description' });
  desc.addEventListener('change', () => patch({ description: desc.value }));

  const toggle = el('label', { class: 'check', title: 'Turn the whole group on or off' }, [
    el('span', { text: g.enabled ? 'On' : 'Off' }),
    el('span', { class: 'switch' }, [
      el('input', { type: 'checkbox', checked: g.enabled, 'aria-label': `Enable group ${g.name}`, onchange: e => update(s => mutations.toggleGroup(s, g.id, e.target.checked)) }),
      el('span'),
    ]),
  ]);

  const head = el('div', { class: 'card group-head' }, [
    el('div', { class: 'title-row' }, [color, title, toggle]),
    desc,
    tabScopeRow(g),
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'sm', text: '↑ Move up', disabled: idx === 0, onclick: () => update(s => mutations.moveGroup(s, g.id, -1)) }),
      el('button', { class: 'sm', text: '↓ Move down', disabled: idx === state.groups.length - 1, onclick: () => update(s => mutations.moveGroup(s, g.id, 1)) }),
      el('button', { class: 'sm', text: 'Export group', onclick: () => exportGroups([g.id]) }),
      el('button', { class: 'sm', text: 'Duplicate group', onclick: () => duplicateGroup(g.id) }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'sm danger', text: 'Delete group', onclick: () => deleteGroup(g) }),
    ]),
  ]);

  const typeSel = el('select', { 'aria-label': 'Rule type to add', id: 'addType' },
    Object.entries(RULE_TYPES).map(([k, v]) => el('option', { value: k, text: v.label })));
  const addBar = el('div', { class: 'view-head' }, [
    el('h2', { text: `Rules (${g.rules.length})` }),
    el('div', { class: 'spacer' }),
    typeSel,
    el('button', { class: 'primary', id: 'addRule', text: '+ Add rule', onclick: () => openRule(null, { groupId: g.id, type: typeSel.value }) }),
  ]);
  typeSel.style.width = 'auto';

  const list = el('div', { class: 'rule-list' });
  if (!g.rules.length) {
    list.append(el('div', { class: 'card empty-state' }, [
      el('p', { text: 'No rules in this group yet. Pick a type and press "Add rule".' }),
    ]));
  }
  for (const r of g.rules) list.append(ruleRow(r, g));
  view.append(head, addBar, list);
  return view;
}

function tabScopeRow(g) {
  const row = el('div', { class: 'row wrap small' });
  if (isSet(g.tabScope)) {
    row.append(el('span', { class: 'pill accent', text: `Only tab #${g.tabScope}` }),
      el('span', { class: 'muted', id: 'tabScopeTitle', text: '' }),
      el('button', { class: 'sm', text: 'Apply to all tabs', onclick: () => update(s => { const x = s.groups.find(y => y.id === g.id); if (x) delete x.tabScope; }) }));
    chrome.tabs.get(g.tabScope).then(t => { const n = $('#tabScopeTitle'); if (n) n.textContent = t.title || t.url || ''; }, () => {
      const n = $('#tabScopeTitle'); if (n) n.textContent = '(tab no longer open)';
    });
    return row;
  }
  const sel = el('select', { 'aria-label': 'Limit this group to one tab' }, [el('option', { value: '', text: 'All tabs' })]);
  sel.style.width = 'auto';
  sel.style.maxWidth = '420px';
  chrome.tabs.query({}).then(tabs => {
    for (const t of tabs) {
      if (!t.url || !/^https?:/.test(t.url)) continue;
      sel.append(el('option', { value: String(t.id), text: `${(t.title || t.url).slice(0, 70)}` }));
    }
  }).catch(() => {});
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    const tabId = +sel.value;
    update(s => { const x = s.groups.find(y => y.id === g.id); if (x) x.tabScope = tabId; });
    toast('Group now applies to that tab only (session rule)');
  });
  row.append(el('span', { class: 'muted', text: 'Applies to' }), sel,
    el('span', { class: 'tiny muted', text: 'Limiting to a tab installs the rules as session rules for that tab only.' }));
  return row;
}

function ruleRow(r, g) {
  const errs = errorsFor(r.id);
  const active = !state.paused && g.enabled && r.enabled;
  return el('div', { class: 'card rule-row' + (r.enabled ? '' : ' off'), dataset: { ruleId: r.id } }, [
    el('span', { class: 'switch' }, [
      el('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `Enable ${ruleDisplayName(r)}`, onchange: e => update(s => mutations.toggleRule(s, r.id, e.target.checked)) }),
      el('span'),
    ]),
    el('div', { class: 'r-main' }, [
      el('div', { class: 'r-title' }, [
        el('button', { type: 'button', class: 'r-name', text: ruleDisplayName(r), title: 'Edit rule', onclick: () => openRule(r.id) }),
        el('span', { class: 'pill', text: RULE_TYPES[r.type].short }),
        r.priority > 1 ? el('span', { class: 'pill', text: `p${r.priority}`, title: 'Priority' }) : null,
        active ? null : el('span', { class: 'tiny muted', text: !g.enabled ? 'group off' : state.paused ? 'paused' : '' }),
      ]),
      el('div', { class: 'r-sum', text: `${conditionSummary(r.condition)}  →  ${actionSummary(r)}`, title: `${conditionSummary(r.condition)} → ${actionSummary(r)}` }),
      errs.length ? el('div', { class: 'r-err', text: errs.map(e => e.messages.join(' ')).join(' ') }) : null,
    ]),
    el('div', { class: 'r-actions' }, [
      el('button', { class: 'sm', text: 'Edit', onclick: () => openRule(r.id) }),
      el('button', { class: 'sm ghost', text: 'Duplicate', onclick: () => update(s => { mutations.duplicateRule(s, r.id); }) }),
      el('button', { class: 'sm ghost danger', text: 'Delete', 'aria-label': `Delete ${ruleDisplayName(r)}`, onclick: () => deleteRule(r) }),
    ]),
  ]);
}

async function deleteRule(r) {
  const snapshot = clone(state);
  await update(s => mutations.removeRule(s, r.id));
  undoToast(`Deleted "${ruleDisplayName(r)}"`, snapshot);
}

async function deleteGroup(g) {
  if (g.rules.length && !window.confirm(`Delete the group "${g.name}" and its ${g.rules.length} rule${g.rules.length === 1 ? '' : 's'}?`)) return;
  const snapshot = clone(state);
  await update(s => mutations.removeGroup(s, g.id));
  go('#');
  undoToast(`Deleted group "${g.name}"`, snapshot);
}

function undoToast(message, snapshot) {
  toast(message);
  const t = $('#toast');
  const btn = el('button', { class: 'sm', text: 'Undo', style: 'margin-left:8px;pointer-events:auto', onclick: async () => { await update(() => snapshot); toast('Restored'); } });
  t.append(btn);
  t.style.pointerEvents = 'auto';
  setTimeout(() => { t.style.pointerEvents = ''; }, 2500);
}

async function duplicateGroup(groupId) {
  await update(s => {
    const i = s.groups.findIndex(g => g.id === groupId);
    if (i < 0) return;
    const copy = parseImport({ groups: [s.groups[i]] }).groups[0];
    copy.name = s.groups[i].name + ' copy';
    delete copy.tabScope;
    s.groups.splice(i + 1, 0, copy);
  });
}

function searchView() {
  const view = el('div', { class: 'view' }, [el('div', { class: 'view-head' }, [el('h2', { text: `Search: "${searchText}"` })])]);
  const list = el('div', { class: 'rule-list' });
  let n = 0;
  for (const g of state.groups) {
    for (const r of g.rules) {
      const hay = [ruleDisplayName(r), r.notes, g.name, conditionSummary(r.condition), actionSummary(r), RULE_TYPES[r.type].label].join(' ').toLowerCase();
      if (!hay.includes(searchText)) continue;
      n++;
      const row = ruleRow(r, g);
      row.querySelector('.r-title').append(el('span', { class: 'tiny muted', text: `in ${g.name}` }));
      list.append(row);
    }
  }
  if (!n) list.append(el('div', { class: 'card empty-state', text: 'No rule matches.' }));
  view.append(list);
  return view;
}

// ---------- rule dialog ----------

let draft = null;          // the rule being edited
let draftGroupId = null;
let draftIsNew = false;
let validation = { errors: [], warnings: [], dnr: null, regex: null };
let validateToken = 0;

function wireRuleDialog() {
  const dlg = $('#ruleDialog');
  $('#ruleClose').addEventListener('click', () => dlg.close());
  $('#ruleCancel').addEventListener('click', () => dlg.close());
  $('#ruleForm').addEventListener('submit', e => { e.preventDefault(); saveRule(); });
}

function openRule(ruleId, opts = {}) {
  if (ruleId) {
    const found = findRule(state, ruleId);
    if (!found) { toast('That rule no longer exists'); return; }
    draft = normalizeRule(clone(found.rule));
    draftGroupId = found.group.id;
    draftIsNew = false;
  } else {
    draft = newRule(opts.type || 'requestHeaders');
    draftGroupId = opts.groupId || firstGroupId();
    draftIsNew = true;
  }
  $('#ruleDialogTitle').textContent = draftIsNew ? `New rule: ${RULE_TYPES[draft.type].label}` : 'Edit rule';
  renderRuleForm();
  $('#ruleDialog').showModal();
  const first = $('#f-name');
  if (first) first.focus();
}

function renderRuleForm() {
  const body = $('#ruleBody');
  clear(body);
  body.append(basicsSection(), conditionSection(), actionSection(), validationSection());
  validate();
}

const field = (label, input, hint, id) => {
  if (id) input.id = id;
  return el('div', { class: 'field' }, [el('label', { for: id || undefined, text: label }), input, hint ? el('div', { class: 'hint', text: hint }) : null]);
};

function bindText(input, setter, rerender = false) {
  input.addEventListener('input', () => { setter(input.value); if (rerender) renderActionOnly(); validate(); });
  return input;
}

function basicsSection() {
  const typeSel = el('select', {}, Object.entries(RULE_TYPES).map(([k, v]) => el('option', { value: k, text: v.label })));
  typeSel.value = draft.type;
  typeSel.addEventListener('change', () => {
    const prev = draft.type;
    draft.type = typeSel.value;
    const headerTypes = ['requestHeaders', 'responseHeaders'];
    if (!(headerTypes.includes(prev) && headerTypes.includes(draft.type))) draft.action = defaultAction(draft.type);
    if (draft.type === 'mock' && draft.condition.matchType === 'all') draft.condition.matchType = 'exact';
    renderRuleForm();
    $('#f-type').focus();
  });
  const groupSel = el('select', {}, state.groups.map(g => el('option', { value: g.id, text: g.name })));
  if (!state.groups.length) groupSel.append(el('option', { value: '', text: 'New group: My rules' }));
  groupSel.value = draftGroupId || '';
  groupSel.addEventListener('change', () => { draftGroupId = groupSel.value; });
  const prio = el('input', { type: 'number', min: 1, max: 1000, value: draft.priority });
  prio.addEventListener('input', () => { draft.priority = Math.min(1000, Math.max(1, parseInt(prio.value, 10) || 1)); validate(); });
  const name = bindText(el('input', { type: 'text', value: draft.name, placeholder: ruleDisplayName({ ...draft, name: '' }), maxLength: 120 }), v => { draft.name = v; });
  const enabled = el('input', { type: 'checkbox', checked: draft.enabled });
  enabled.addEventListener('change', () => { draft.enabled = enabled.checked; });
  const notes = bindText(el('textarea', { rows: 2, value: draft.notes || '', placeholder: 'Why this rule exists, ticket links…' }), v => { draft.notes = v; });
  notes.style.fontFamily = 'inherit';
  return el('div', { class: 'col' }, [
    el('div', { class: 'grid c2' }, [field('Name', name, null, 'f-name'), field('Type', typeSel, RULE_TYPES[draft.type].hint, 'f-type')]),
    el('div', { class: 'grid c3' }, [
      field('Group', groupSel, null, 'f-group'),
      field('Priority', prio, 'Higher wins when rules conflict (1–1000).', 'f-priority'),
      el('div', { class: 'field' }, [el('label', { text: 'Status' }), el('label', { class: 'check' }, [enabled, 'Enabled'])]),
    ]),
    el('details', {}, [el('summary', { text: 'Notes' }), notes]),
  ]);
}

const MATCH_PLACEHOLDERS = {
  all: '', contains: '/api/', exact: 'https://api.example.com/v1/users',
  wildcard: '*://api.example.com/v1/*', regex: '^https://(\\w+)\\.example\\.com/(.*)$',
  domain: 'example.com, api.example.org', urlFilter: '||example.com/ads^',
};
const MATCH_HINTS = {
  all: 'Every request (narrow it with the conditions below).',
  contains: 'Case-insensitive substring of the full URL.',
  exact: 'The whole URL, including query string.',
  wildcard: '* matches anything. In redirects, $1 $2 … refer to each *.',
  regex: 'RE2 syntax (no lookaround or backreferences). Use $1 … in a redirect destination.',
  domain: 'Comma-separated. Subdomains are included.',
  urlFilter: 'Chrome urlFilter syntax: || domain anchor, | start/end anchor, ^ separator, * wildcard.',
};

function conditionSection() {
  const c = draft.condition;
  const replaceOnly = draft.type === 'replace' || draft.type === 'host';
  const mt = el('select', {}, Object.entries(MATCH_TYPES).map(([k, v]) => el('option', { value: k, text: v })));
  mt.value = c.matchType;
  const value = el('input', { type: 'text', value: c.value || '', placeholder: MATCH_PLACEHOLDERS[c.matchType], spellcheck: false, autocomplete: 'off' });
  value.disabled = c.matchType === 'all';
  mt.addEventListener('change', () => {
    c.matchType = mt.value;
    value.disabled = c.matchType === 'all';
    value.placeholder = MATCH_PLACEHOLDERS[c.matchType];
    $('#f-match-hint').textContent = MATCH_HINTS[c.matchType];
    validate();
  });
  bindText(value, v => { c.value = v; });

  const types = el('div', { class: 'checks' }, RESOURCE_TYPES.map(t => {
    const cb = el('input', { type: 'checkbox', checked: c.resourceTypes.includes(t), value: t });
    cb.addEventListener('change', () => {
      c.resourceTypes = $$('input', types).filter(x => x.checked).map(x => x.value);
      validate();
    });
    return el('label', { class: 'check' }, [cb, RESOURCE_LABELS[t]]);
  }));
  const methods = el('div', { class: 'checks' }, METHODS.map(m => {
    const cb = el('input', { type: 'checkbox', checked: c.methods.includes(m), value: m });
    cb.addEventListener('change', () => { c.methods = $$('input', methods).filter(x => x.checked).map(x => x.value); validate(); });
    return el('label', { class: 'check' }, [cb, m.toUpperCase()]);
  }));
  const listInput = key => bindText(el('input', { type: 'text', value: splitList(c[key]).join(', '), placeholder: 'example.com, localhost', spellcheck: false }), v => { c[key] = v; });
  const advancedCount = c.resourceTypes.length + c.methods.length + splitList(c.initiatorDomains).length + splitList(c.excludedInitiatorDomains).length + splitList(c.excludedRequestDomains).length;

  return el('fieldset', { class: 'fieldset' }, [
    el('legend', { text: 'When the request…' }),
    el('div', { class: 'grid c2' }, [
      field('Match', mt, null, 'f-match'),
      field('Pattern', value, null, 'f-value'),
    ]),
    el('div', { class: 'hint tiny muted', id: 'f-match-hint', text: replaceOnly && draft.type === 'replace' ? 'Replace rules match any URL that contains the text; only a domain filter is combined.' : MATCH_HINTS[c.matchType] }),
    el('details', { open: advancedCount > 0 }, [
      el('summary', { text: `More conditions${advancedCount ? ` (${advancedCount})` : ''}` }),
      el('div', { class: 'col' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Resource types (none checked = all' + (draft.type === 'mock' ? ' except pages' : '') + ')' }), types]),
        el('div', { class: 'field' }, [el('label', { text: 'Methods (none checked = all)' }), methods]),
        el('div', { class: 'grid c3' }, [
          field('Only from initiator domains', listInput('initiatorDomains'), 'The page that made the request.', 'f-ini'),
          field('Not from initiator domains', listInput('excludedInitiatorDomains'), null, 'f-exini'),
          field('Exclude request domains', listInput('excludedRequestDomains'), null, 'f-exreq'),
        ]),
      ]),
    ]),
  ]);
}

function actionSection() {
  return el('fieldset', { class: 'fieldset', id: 'actionSection' }, [el('legend', { text: 'Then…' }), ...actionFields()]);
}

function renderActionOnly() {
  const sec = $('#actionSection');
  if (!sec) return;
  const focusedId = document.activeElement && document.activeElement.id;
  clear(sec);
  sec.append(el('legend', { text: 'Then…' }), ...actionFields());
  if (focusedId) { const f = document.getElementById(focusedId); if (f) f.focus(); }
}

function actionFields() {
  const a = draft.action;
  switch (draft.type) {
    case 'requestHeaders':
    case 'responseHeaders': return headerFields(a, draft.type === 'requestHeaders');
    case 'redirect':
      return [field('Destination URL', bindText(el('input', { type: 'text', value: a.url || '', placeholder: 'https://staging.example.com/$1', spellcheck: false }), v => { a.url = v; }),
        'Absolute URL. With Wildcard or Regex matching, $1 $2 … insert the captured parts.', 'f-url')];
    case 'replace':
      return [el('div', { class: 'grid c2' }, [
        field('Find', bindText(el('input', { type: 'text', value: a.find || '', placeholder: '/api/v1/', spellcheck: false }), v => { a.find = v; }), 'Plain text, first occurrence.', 'f-find'),
        field('Replace with', bindText(el('input', { type: 'text', value: a.replaceWith || '', placeholder: '/api/v2/', spellcheck: false }), v => { a.replaceWith = v; }), null, 'f-replace'),
      ])];
    case 'host': {
      const scheme = el('select', {}, [['', 'Keep scheme'], ['http', 'http'], ['https', 'https']].map(([v, t]) => el('option', { value: v, text: t })));
      scheme.value = a.scheme || '';
      scheme.addEventListener('change', () => { a.scheme = scheme.value; validate(); });
      return [el('div', { class: 'grid c3' }, [
        field('From host', bindText(el('input', { type: 'text', value: a.fromHost || '', placeholder: 'api.example.com', spellcheck: false }), v => { a.fromHost = v; }), 'Subdomains are included. Add :port to match one port only.', 'f-from'),
        field('To host', bindText(el('input', { type: 'text', value: a.toHost || '', placeholder: 'localhost:3000', spellcheck: false }), v => { a.toHost = v; }), 'Optionally with :port.', 'f-to'),
        field('Scheme', scheme, null, 'f-scheme'),
      ])];
    }
    case 'query': return queryFields(a);
    case 'block': return [el('p', { class: 'small muted', text: 'Matching requests are cancelled. The page sees a network error (net::ERR_BLOCKED_BY_CLIENT).' })];
    case 'allow': return [el('p', { class: 'small muted', text: 'Matching requests skip every lower-priority rule (block, redirect and header rules with a lower or equal priority). Give it a higher priority than the rules it should override.' })];
    case 'mock': return mockFields(a);
    case 'userAgent': return uaFields(a);
    default: return [];
  }
}

function headerFields(a, isRequest) {
  const listId = isRequest ? 'reqHeaderNames' : 'resHeaderNames';
  const rows = el('div', { class: 'col' });
  const datalist = el('datalist', { id: listId }, (isRequest ? COMMON_REQUEST_HEADERS : COMMON_RESPONSE_HEADERS).map(n => el('option', { value: n })));
  a.headers = a.headers && a.headers.length ? a.headers : [{ op: 'set', name: '', value: '' }];
  a.headers.forEach((h, i) => {
    const op = el('select', { 'aria-label': 'Operation' }, [['set', 'Set'], ['append', 'Append'], ['remove', 'Remove']].map(([v, t]) => el('option', { value: v, text: t })));
    op.value = h.op;
    op.id = `f-hop-${i}`;
    const name = el('input', { type: 'text', value: h.name, placeholder: 'Header name', list: listId, 'aria-label': 'Header name', spellcheck: false, autocomplete: 'off', id: `f-hname-${i}` });
    name.setAttribute('list', listId);
    const value = el('input', { type: 'text', value: h.value, placeholder: h.op === 'remove' ? '(removed)' : 'Value', 'aria-label': 'Header value', spellcheck: false, disabled: h.op === 'remove', id: `f-hval-${i}` });
    op.addEventListener('change', () => { h.op = op.value; if (h.op === 'remove') h.value = ''; renderActionOnly(); validate(); });
    bindText(name, v => { h.name = v; });
    bindText(value, v => { h.value = v; });
    const del = el('button', { type: 'button', class: 'ghost icon', text: '✕', 'aria-label': 'Remove header row', onclick: () => { a.headers.splice(i, 1); renderActionOnly(); validate(); } });
    rows.append(el('div', { class: 'kv-row' }, [op, name, value, del]));
  });
  return [
    rows, datalist,
    el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'sm', text: '+ Header', onclick: () => { a.headers.push({ op: 'set', name: '', value: '' }); renderActionOnly(); const n = $(`#f-hname-${a.headers.length - 1}`); if (n) n.focus(); } }),
      el('span', { class: 'tiny muted', text: isRequest ? 'Append only works for a few headers (Accept, Cookie, User-Agent …).' : 'Tip: CORS needs Access-Control-Allow-Origin and often -Headers / -Methods.' }),
    ]),
  ];
}

function queryFields(a) {
  const rows = el('div', { class: 'col' });
  a.add = a.add || [];
  a.add.forEach((p, i) => {
    const key = bindText(el('input', { type: 'text', value: p.key, placeholder: 'key', 'aria-label': 'Parameter name', spellcheck: false, id: `f-qk-${i}` }), v => { p.key = v; });
    const val = bindText(el('input', { type: 'text', value: p.value, placeholder: 'value', 'aria-label': 'Parameter value', spellcheck: false, id: `f-qv-${i}` }), v => { p.value = v; });
    const only = el('input', { type: 'checkbox', checked: !!p.replaceOnly });
    only.addEventListener('change', () => { p.replaceOnly = only.checked; validate(); });
    rows.append(el('div', { class: 'kv-row q' }, [key, val, el('label', { class: 'check', title: 'Only change it when the parameter is already present' }, [only, 'only if present']),
      el('button', { type: 'button', class: 'ghost icon', text: '✕', 'aria-label': 'Remove parameter', onclick: () => { a.add.splice(i, 1); renderActionOnly(); validate(); } })]));
  });
  return [
    el('label', { text: 'Add or replace parameters' }), rows,
    el('div', {}, el('button', { type: 'button', class: 'sm', text: '+ Parameter', onclick: () => { a.add.push({ key: '', value: '', replaceOnly: false }); renderActionOnly(); const n = $(`#f-qk-${a.add.length - 1}`); if (n) n.focus(); } })),
    field('Remove parameters', bindText(el('input', { type: 'text', value: splitList(a.remove).join(', '), placeholder: 'utm_source, utm_medium, fbclid', spellcheck: false }), v => { a.remove = v; }), 'Comma-separated names.', 'f-qremove'),
  ];
}

function mockFields(a) {
  const ct = bindText(el('input', { type: 'text', value: a.contentType || '', placeholder: 'application/json', spellcheck: false }), v => { a.contentType = v; updateMeter(); });
  ct.setAttribute('list', 'mockTypes');
  const charset = bindText(el('input', { type: 'text', value: a.charset || '', placeholder: 'utf-8', spellcheck: false }), v => { a.charset = v; updateMeter(); });
  const body = bindText(el('textarea', { rows: 12, value: a.body || '', spellcheck: false }), v => { a.body = v; updateMeter(); });
  body.id = 'f-body';
  body.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      const s = body.selectionStart;
      body.setRangeText('  ', s, body.selectionEnd, 'end');
      body.dispatchEvent(new Event('input'));
    }
  });
  const meter = el('div', { class: 'meter', id: 'mockMeter' });
  const fmt = el('button', { type: 'button', class: 'sm', text: 'Format JSON', onclick: () => {
    try { a.body = JSON.stringify(JSON.parse(a.body), null, 2); body.value = a.body; updateMeter(); validate(); }
    catch (e) { toast('Not valid JSON: ' + e.message, 'error'); }
  } });
  const loadFile = el('button', { type: 'button', class: 'sm', text: 'Load from file…', onclick: async () => {
    const f = await pickFile('*/*');
    if (!f) return;
    a.body = f.text;
    body.value = a.body;
    updateMeter();
    validate();
  } });
  setTimeout(updateMeter, 0);
  return [
    el('div', { class: 'grid c2' }, [field('Content type', ct, null, 'f-ct'), field('Charset', charset, 'Leave empty for binary-safe types.', 'f-charset')]),
    el('datalist', { id: 'mockTypes' }, MOCK_CONTENT_TYPES.map(t => el('option', { value: t }))),
    el('div', { class: 'field' }, [el('label', { for: 'f-body', text: 'Response body' }), body]),
    el('div', { class: 'row wrap' }, [fmt, loadFile, el('div', { class: 'spacer' }), meter]),
    el('p', { class: 'tiny muted', text: `Mocks are served by redirecting to a data: URL, so the response status is always 200, response headers cannot be set, and the body is limited to ${formatBytes(MOCK_MAX_BYTES)} (Chrome caps URLs at 2 MB). Top-level page loads cannot be mocked. Use "URL equals" or a regex so only the endpoint you mean is mocked.` }),
  ];
}

function updateMeter() {
  const m = $('#mockMeter');
  if (!m || draft.type !== 'mock') return;
  const bytes = byteLength(draft.action.body);
  const urlLen = buildMockDataUrl(draft.action).length;
  m.textContent = `Body ${formatBytes(bytes)} · data URL ${formatBytes(urlLen)} of ${formatBytes(MOCK_MAX_BYTES)} max`;
  m.style.color = bytes > MOCK_MAX_BYTES ? 'var(--red)' : '';
}

function uaFields(a) {
  const preset = el('select', {}, [...UA_PRESETS.map(p => el('option', { value: p.id, text: p.label })), el('option', { value: 'custom', text: 'Custom…' })]);
  preset.value = UA_PRESETS.some(p => p.id === a.preset) ? a.preset : 'custom';
  const value = bindText(el('textarea', { rows: 3, value: a.value || '', spellcheck: false }), v => {
    a.value = v;
    const p = UA_PRESETS.find(x => x.value === v);
    a.preset = p ? p.id : 'custom';
    preset.value = a.preset;
  });
  value.id = 'f-ua';
  preset.addEventListener('change', () => {
    a.preset = preset.value;
    const p = UA_PRESETS.find(x => x.id === preset.value);
    if (p) { a.value = p.value; value.value = p.value; }
    else value.focus();
    validate();
  });
  const hints = el('input', { type: 'checkbox', checked: a.dropClientHints !== false });
  hints.addEventListener('change', () => { a.dropClientHints = hints.checked; validate(); });
  return [
    field('Preset', preset, null, 'f-ua-preset'),
    el('div', { class: 'field' }, [el('label', { for: 'f-ua', text: 'User-Agent header' }), value]),
    el('label', { class: 'check' }, [hints, 'Remove Sec-CH-UA client hint headers so servers do not see the real browser']),
  ];
}

function validationSection() {
  const tryUrl = el('input', { type: 'text', id: 'f-try', placeholder: 'https://example.com/some/path?x=1', spellcheck: false, value: route.params.get('url') || '' });
  tryUrl.addEventListener('input', renderTry);
  return el('div', { class: 'col' }, [
    el('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' }),
    el('fieldset', { class: 'fieldset' }, [
      el('legend', { text: 'Try it' }),
      field('URL', tryUrl, 'Checks this rule alone against the URL (as a request of any type and method).', 'f-try'),
      el('div', { class: 'try-result', id: 'tryResult' }),
    ]),
    el('details', {}, [el('summary', { text: 'Compiled declarativeNetRequest rule' }), el('pre', { class: 'code', id: 'dnrPreview' })]),
  ]);
}

async function validate() {
  const token = ++validateToken;
  const rule = normalizeRule(clone(draft));
  const res = compileRule(rule, { id: 1 });
  validation = { errors: res.errors.slice(), warnings: res.warnings.slice(), dnr: res.dnr, regex: null };
  renderValidation();
  const re = res.dnr && res.dnr.condition.regexFilter;
  if (re) {
    const capture = !!(res.dnr.action.redirect && res.dnr.action.redirect.regexSubstitution);
    const r = await send({ cmd: 'checkRegex', regex: re, requireCapturing: capture });
    if (token !== validateToken) return;
    if (r && r.isSupported === false) {
      const why = r.reason === 'memoryLimitExceeded' ? 'it is too complex (memory limit exceeded)' : r.reason === 'syntaxError' ? 'it is not valid RE2 syntax' : (r.reason || 'unknown reason');
      validation.errors.push({ field: 'condition.value', message: `Chrome cannot use this regular expression: ${why}.` });
      validation.regex = false;
    } else if (r && r.isSupported) validation.regex = true;
    renderValidation();
  }
}

function renderValidation() {
  const box = $('#msgs');
  if (!box) return;
  clear(box);
  for (const e of validation.errors) box.append(el('div', { class: 'notice error', text: e.message }));
  for (const w of validation.warnings) box.append(el('div', { class: 'notice warn', text: w.message }));
  if (!validation.errors.length && validation.regex) box.append(el('div', { class: 'tiny muted', text: 'Regular expression accepted by Chrome.' }));
  for (const inp of $$('#ruleBody .invalid')) inp.classList.remove('invalid');
  const fieldMap = { 'condition.value': '#f-value', 'action.url': '#f-url', 'action.find': '#f-find', 'action.fromHost': '#f-from', 'action.toHost': '#f-to', 'action.contentType': '#f-ct', 'action.body': '#f-body', 'action.value': '#f-ua', 'condition.initiatorDomains': '#f-ini', 'condition.excludedInitiatorDomains': '#f-exini', 'condition.excludedRequestDomains': '#f-exreq' };
  for (const e of validation.errors) {
    let sel = fieldMap[e.field];
    const m = /^action\.headers\.(\d+)\.(name|value|op)$/.exec(e.field || '');
    if (m) sel = `#f-h${m[2] === 'name' ? 'name' : m[2] === 'value' ? 'val' : 'op'}-${m[1]}`;
    const n = sel && $(sel);
    if (n) n.classList.add('invalid');
  }
  const pre = $('#dnrPreview');
  if (pre) {
    let text = validation.dnr ? JSON.stringify(validation.dnr, null, 2) : '(fix the errors above to see the compiled rule)';
    if (text.length > 6000) text = text.slice(0, 6000) + '\n…';
    pre.textContent = text;
  }
  $('#ruleSave').disabled = validation.errors.length > 0;
  renderTry();
}

function renderTry() {
  const out = $('#tryResult');
  const input = $('#f-try');
  if (!out || !input) return;
  clear(out);
  const url = input.value.trim();
  if (!url) return;
  try { new URL(url); } catch { out.append(el('span', { class: 'muted', text: 'Enter an absolute URL.' })); return; }
  const d = validation.dnr;
  if (!d) { out.append(el('span', { class: 'muted', text: 'Fix the errors first.' })); return; }
  const m = conditionMatches(d.condition, { url });
  if (!m.ok) { out.append(el('span', { class: 'pill', text: 'No match' }), ' ', el('span', { class: 'muted', text: m.reason })); return; }
  out.append(el('span', { class: 'pill green', text: 'Matches' }), ' ');
  if (d.action.type === 'redirect') {
    const to = applyRedirect(d, url);
    if (draft.type === 'mock') out.append(el('span', { text: `Answered with the mock body (${draft.action.contentType}).` }));
    else out.append('→ ', el('code', { text: to === url ? '(URL unchanged)' : to }));
  } else if (d.action.type === 'block') out.append(el('span', { text: 'Request is blocked.' }));
  else if (d.action.type === 'allow') out.append(el('span', { text: 'Lower-priority rules are skipped.' }));
  else {
    const hs = [...(d.action.requestHeaders || []).map(h => ['request', h]), ...(d.action.responseHeaders || []).map(h => ['response', h])];
    out.append(el('span', { text: hs.map(([k, h]) => `${k} ${h.operation} ${h.header}${h.operation === 'remove' ? '' : ': ' + h.value}`).join(' · ') }));
  }
}

async function saveRule() {
  if (!draft) return;
  await validate();
  if (validation.errors.length) { toast('Fix the highlighted problems first', 'error'); return; }
  const rule = normalizeRule(clone(draft));
  const gid = draftGroupId;
  await update(s => {
    if (!s.groups.length) s.groups.push(newGroup('My rules'));
    const target = s.groups.find(g => g.id === gid) || s.groups[0];
    mutations.saveRule(s, target.id, rule);
  });
  $('#ruleDialog').close();
  toast(draftIsNew ? 'Rule added' : 'Rule saved');
  const g = state.groups.find(x => x.rules.some(r => r.id === rule.id));
  if (g && route.view === 'group' && route.id !== g.id) go('#group=' + encodeURIComponent(g.id));
  setTimeout(() => {
    const row = document.querySelector(`.rule-row[data-rule-id="${CSS.escape(rule.id)}"] .r-name`);
    if (row) row.focus();
  }, 50);
}

// ---------- tester ----------

function testerView() {
  const view = el('div', { class: 'view' });
  const url = el('input', { type: 'text', id: 't-url', value: route.params.get('url') || '', placeholder: 'https://api.example.com/v1/users?id=7', spellcheck: false });
  const type = el('select', { id: 't-type' }, RESOURCE_TYPES.map(t => el('option', { value: t, text: RESOURCE_LABELS[t] })));
  type.value = route.params.get('type') || 'main_frame';
  const method = el('select', { id: 't-method' }, METHODS.filter(m => m !== 'other').map(m => el('option', { value: m, text: m.toUpperCase() })));
  const initiator = el('input', { type: 'text', id: 't-init', placeholder: 'https://app.example.com (optional)', spellcheck: false });
  const results = el('div', { class: 'col', id: 'testResults' });
  const run = () => runTest(results);
  for (const n of [url, initiator]) n.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  for (const n of [type, method]) n.addEventListener('change', run);
  view.append(
    el('div', { class: 'view-head' }, [el('h2', { text: 'Test a URL' })]),
    el('div', { class: 'card section' }, [
      el('p', { class: 'small muted', text: 'Evaluates your rules against a request description the way Chrome does: highest priority wins, then allow > block > redirect, and header changes stack.' }),
      field('URL', url, null, 't-url'),
      el('div', { class: 'grid c3' }, [field('Resource type', type, null, 't-type'), field('Method', method, null, 't-method'), field('Initiator (the page making the request)', initiator, null, 't-init')]),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', id: 't-run', text: 'Run test', onclick: run }),
        el('button', { text: 'Open URL in a new tab', onclick: () => { try { new URL(url.value); chrome.tabs.create({ url: url.value }); } catch { toast('Enter an absolute URL'); } } }),
      ]),
    ]),
    results,
  );
  if (url.value) setTimeout(run, 0);
  else setTimeout(() => url.focus(), 0);
  return view;
}

function runTest(results) {
  clear(results);
  const url = $('#t-url').value.trim();
  try { new URL(url); } catch { results.append(el('div', { class: 'notice error', text: 'Enter an absolute URL, for example https://example.com/path' })); return; }
  const req = { url, type: $('#t-type').value, method: $('#t-method').value, initiator: $('#t-init').value.trim() || undefined };
  const { checks, outcome } = testRequest(state, req);
  const labels = {
    unchanged: 'No active rule changes this request', blocked: 'Blocked', redirected: 'Redirected',
    mocked: 'Answered with a mock response', modified: 'Headers modified', allowed: 'Allowed by an exception rule',
  };
  const verdict = el('div', { class: `verdict ${outcome.verdict}`, role: 'status' }, [el('span', { text: labels[outcome.verdict] || outcome.verdict })]);
  if (outcome.winner) verdict.append(el('span', { class: 'small', text: `by "${ruleDisplayName(outcome.winner.rule)}" (${outcome.winner.group.name})` }));
  if (outcome.redirectTo) verdict.append(el('span', { class: 'v-url', text: outcome.redirectTo.length > 400 ? outcome.redirectTo.slice(0, 400) + '…' : outcome.redirectTo }));
  results.append(verdict);
  if (state.paused) results.append(el('div', { class: 'notice warn', text: 'Rules are paused, so nothing is applied right now.' }));
  if (outcome.loopWarning) results.append(el('div', { class: 'notice warn', text: outcome.loopWarning }));
  if (outcome.verdict === 'redirected' && req.type === 'main_frame') results.append(el('div', { class: 'tiny muted', text: 'Header rules are evaluated again for the new URL after a redirect.' }));
  const hdrRows = [...outcome.requestHeaders.map(h => ['Request', h]), ...outcome.responseHeaders.map(h => ['Response', h])];
  if (hdrRows.length) {
    results.append(el('div', { class: 'card section' }, [
      el('h3', { text: 'Header changes (applied in this order)' }),
      el('table', { class: 'tbl' }, [
        el('thead', {}, el('tr', {}, ['Direction', 'Operation', 'Header', 'Value', 'Rule'].map(t => el('th', { text: t })))),
        el('tbody', {}, hdrRows.map(([d, h]) => el('tr', {}, [el('td', { text: d }), el('td', { text: h.operation }), el('td', { class: 'mono', text: h.header }), el('td', { class: 'mono', text: h.value ?? '' }), el('td', { text: ruleDisplayName(h.rule) })]))),
      ]),
    ]));
  }
  const appliedIds = new Set(outcome.applied.map(c => c.rule.id));
  results.append(el('div', { class: 'card section' }, [
    el('h3', { text: `Every rule (${checks.length})` }),
    checks.length ? el('table', { class: 'tbl' }, [
      el('thead', {}, el('tr', {}, ['Rule', 'Group', 'Result', ''].map(t => el('th', { text: t })))),
      el('tbody', {}, checks.map(c => {
        let res;
        if (appliedIds.has(c.rule.id)) res = el('span', { class: 'pill green', text: 'applied' });
        else if (c.matched && !c.active) res = el('span', { class: 'pill', text: 'matches, but off' });
        else if (c.matched) res = el('span', { class: 'pill amber', text: 'matches, overridden' });
        else res = el('span', { class: 'small muted', text: c.reason });
        return el('tr', { class: c.matched ? '' : 'miss' }, [
          el('td', { text: ruleDisplayName(c.rule) }), el('td', { text: c.group.name }), el('td', {}, res),
          el('td', {}, el('button', { class: 'sm ghost', text: 'Edit', onclick: () => openRule(c.rule.id) })),
        ]);
      })),
    ]) : el('p', { class: 'muted', text: 'No rules yet.' }),
  ]));
}

// ---------- installed rules ----------

function statusView() {
  const view = el('div', { class: 'view' });
  const errs = (syncStatus && syncStatus.errors) || [];
  const head = el('div', { class: 'view-head' }, [el('h2', { text: 'Installed rules' }), el('div', { class: 'spacer' }),
    el('button', { text: 'Re-sync now', onclick: async () => { await send({ cmd: 'sync' }); toast('Rules re-synced'); renderMain(); } })]);
  const summary = el('div', { class: 'card section' }, [
    el('div', { text: syncStatus ? `${syncStatus.installed} rule${syncStatus.installed === 1 ? '' : 's'} installed in Chrome, last synced ${new Date(syncStatus.at).toLocaleString()}.` : 'Not synced yet.' }),
    syncStatus && syncStatus.installError ? el('div', { class: 'notice error', text: syncStatus.installError }) : null,
    ...errs.map(e => el('div', { class: 'notice error row' }, [
      el('span', { text: `${e.name || 'Rule'}: ${(e.messages || []).join(' ')}` }), el('div', { class: 'spacer' }),
      e.ruleId ? el('button', { class: 'sm', text: 'Edit', onclick: () => openRule(e.ruleId) }) : null,
    ])),
  ]);
  const feedbackNote = el('p', { class: 'small muted', id: 'feedbackNote' });
  const table = el('div', { class: 'card section' }, [el('p', { class: 'muted', text: 'Loading…' })]);
  view.append(head, summary, feedbackNote, table);
  send({ cmd: 'status' }).then(s => {
    feedbackNote.textContent = s.liveMatching
      ? 'Live match tracking is on: the toolbar badge counts matches on each tab.'
      : s.feedback ? 'This install cannot receive live match events (only unpacked installs can). The popup asks Chrome for matched rules instead.' : 'Match tracking is unavailable.';
  });
  send({ cmd: 'installed' }).then(res => {
    clear(table);
    const all = [...(res.dynamic || []).map(r => ['dynamic', r]), ...(res.session || []).map(r => ['tab', r])];
    table.append(el('h3', { text: `Chrome rule set (${all.length})` }));
    if (!all.length) { table.append(el('p', { class: 'muted', text: state.paused ? 'Paused: no rules are installed.' : 'Nothing installed. Enable a group with rules.' })); return; }
    table.append(el('table', { class: 'tbl' }, [
      el('thead', {}, el('tr', {}, ['ID', 'Rule', 'Action', 'Condition'].map(t => el('th', { text: t })))),
      el('tbody', {}, all.map(([kind, r]) => {
        const meta = (res.map || {})[r.id] || {};
        const cond = { ...r.condition };
        if (cond.resourceTypes && cond.resourceTypes.length === RESOURCE_TYPES.length) delete cond.resourceTypes;
        let condText = JSON.stringify(cond);
        if (condText.length > 300) condText = condText.slice(0, 300) + '…';
        return el('tr', {}, [
          el('td', { text: `${r.id}${kind === 'tab' ? ' (tab)' : ''}` }),
          el('td', {}, meta.ruleId ? el('button', { class: 'sm ghost', text: meta.name || meta.ruleId, onclick: () => openRule(meta.ruleId) }) : el('span', { class: 'muted', text: '—' })),
          el('td', { text: r.action.type + (r.priority > 1 ? ` (p${r.priority})` : '') }),
          el('td', { class: 'mono', text: condText }),
        ]);
      })),
    ]));
    table.append(el('details', {}, [el('summary', { text: 'Raw JSON' }), el('pre', { class: 'code', text: JSON.stringify(all.map(x => x[1]), (k, v) => typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v, 2) })]));
  });
  return view;
}

// ---------- settings & data ----------

function settingsView() {
  const view = el('div', { class: 'view' }, [el('div', { class: 'view-head' }, [el('h2', { text: 'Settings & data' })])]);
  const theme = el('select', { id: 's-theme' }, [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => el('option', { value: v, text: t })));
  const badge = el('select', { id: 's-badge' }, [['matches', 'Matches on the current tab (falls back to active rule count)'], ['count', 'Active rule count'], ['off', 'Nothing']].map(([v, t]) => el('option', { value: v, text: t })));
  const log = el('input', { type: 'checkbox', id: 's-log' });
  getSettings().then(s => { theme.value = s.theme; badge.value = s.badgeMode; log.checked = s.logMatches !== false; });
  theme.addEventListener('change', () => setSettings({ theme: theme.value }));
  badge.addEventListener('change', () => setSettings({ badgeMode: badge.value }));
  log.addEventListener('change', () => setSettings({ logMatches: log.checked }));

  const paste = el('textarea', { rows: 6, id: 's-paste', placeholder: 'Paste a Request Rewriter export or ModHeader profiles JSON here', spellcheck: false });
  view.append(
    el('div', { class: 'card section' }, [
      el('h3', { text: 'Appearance' }),
      el('div', { class: 'grid c2' }, [field('Theme', theme, null, 's-theme'), field('Toolbar badge shows', badge, null, 's-badge')]),
      el('label', { class: 'check' }, [log, 'Keep a per-tab list of matched requests (in memory for this browser session only)']),
    ]),
    el('div', { class: 'card section' }, [
      el('h3', { text: 'Import & export' }),
      el('p', { class: 'small muted', text: 'Exports are plain JSON you can commit next to your project. Import accepts Request Rewriter exports and, best effort, ModHeader profile exports (headers, response headers, cookies, CSP, URL filters, resource filters and URL replacements).' }),
      el('div', { class: 'row wrap' }, [
        el('button', { class: 'primary', text: 'Export all groups', onclick: () => exportGroups(null) }),
        el('button', { text: 'Import from file…', onclick: startImport }),
      ]),
      paste,
      el('div', {}, el('button', { text: 'Import pasted JSON', onclick: () => { if (paste.value.trim()) previewImport(paste.value, 'pasted JSON'); } })),
    ]),
    el('div', { class: 'card section' }, [
      el('h3', { text: 'Keyboard shortcuts' }),
      el('p', { class: 'small' }, ['In the editor: ', el('kbd', { text: '/' }), ' search rules, ', el('kbd', { text: 'Ctrl+S' }), ' save the open rule, ', el('kbd', { text: 'Esc' }), ' close a dialog.']),
      el('p', { class: 'small muted', text: '"Pause or resume all rules" and "Open the rule editor" have no default keys; assign them in Chrome.' }),
      el('div', {}, el('button', { text: 'Set browser shortcuts', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) })),
    ]),
    el('div', { class: 'card section' }, [
      el('h3', { text: 'Reset' }),
      el('p', { class: 'small muted', text: 'Removes every group and rule and restores the disabled Examples group. Export first if you want a backup.' }),
      el('div', {}, el('button', { class: 'danger', text: 'Reset everything', onclick: async () => {
        if (!window.confirm('Delete all groups and rules?')) return;
        const snapshot = clone(state);
        await update(() => defaultState());
        go('#');
        undoToast('Everything reset', snapshot);
      } })),
    ]),
  );
  return view;
}

function exportGroups(ids) {
  const data = exportState(state, ids);
  const g = ids && ids.length === 1 ? state.groups.find(x => x.id === ids[0]) : null;
  const slug = g ? g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group' : 'all';
  download(`request-rewriter-${slug}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  toast(`Exported ${data.groups.length} group${data.groups.length === 1 ? '' : 's'}`);
}

// ---------- import ----------

let pendingImport = null;

function wireImportDialog() {
  const dlg = $('#importDialog');
  $('#importCancel').addEventListener('click', () => dlg.close());
  $('#importAdd').addEventListener('click', () => applyImport(false));
  $('#importReplace').addEventListener('click', () => applyImport(true));
}

async function startImport() {
  const f = await pickFile();
  if (f) previewImport(f.text, f.name);
}

function previewImport(text, name) {
  let parsed;
  try { parsed = parseImport(text); }
  catch (e) { toast(e.message, 'error'); return; }
  pendingImport = parsed;
  const body = $('#importBody');
  clear(body);
  const rules = parsed.groups.reduce((n, g) => n + g.rules.length, 0);
  const invalid = parsed.groups.flatMap(g => g.rules.filter(r => !compileRule(r, { id: 1 }).dnr).map(r => ruleDisplayName(r)));
  body.append(
    el('p', { text: `${name}: ${parsed.groups.length} group${parsed.groups.length === 1 ? '' : 's'} with ${rules} rule${rules === 1 ? '' : 's'} (format: ${parsed.source}).` }),
    el('ul', { class: 'small' }, parsed.groups.map(g => el('li', { text: `${g.name} — ${g.rules.length} rule${g.rules.length === 1 ? '' : 's'}${g.enabled ? '' : ' (off)'}` }))),
    ...parsed.warnings.map(w => el('div', { class: 'notice warn', text: w })),
    invalid.length ? el('div', { class: 'notice warn', text: `${invalid.length} rule${invalid.length === 1 ? ' needs' : 's need'} fixing before it can apply: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}` }) : null,
  );
  $('#importDialog').showModal();
  $('#importAdd').focus();
}

async function applyImport(replace) {
  if (!pendingImport) return;
  if (replace && !window.confirm('Replace all existing groups with the imported ones?')) return;
  const groups = pendingImport.groups.map(g => { const c = clone(g); delete c.tabScope; return c; });
  await update(s => { s.groups = replace ? groups : [...s.groups, ...groups]; });
  $('#importDialog').close();
  toast(`Imported ${groups.length} group${groups.length === 1 ? '' : 's'}`);
  pendingImport = null;
  if (groups[0]) go('#group=' + encodeURIComponent(groups[0].id));
}

// Exposed for tests and debugging from DevTools.
window.requestRewriterEditor = { openRule, go, get state() { return state; }, STATE_KEY };
