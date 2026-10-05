import { h, icon, send, act, clear, dialog, confirmDialog } from '../../shared/ui.js';
import { COLOR_HEX, GROUP_COLORS, hostOf, matchPattern } from '../../lib/util.js';
import { viewHead, emptyState } from '../common.js';

let ctx, tableEl, suggestEl, testOut, testInput, toggleEl;

const TYPES = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'domain', label: 'Domain (includes subdomains)' },
  { value: 'contains', label: 'URL contains' },
  { value: 'wildcard', label: 'Wildcard (* matches anything)' },
  { value: 'regex', label: 'Regular expression' },
];

async function editRule(rule = {}) {
  const v = await dialog({
    title: rule.id ? 'Edit rule' : 'New grouping rule',
    message: 'Tabs whose address matches go into a tab group with this name, created if needed.',
    fields: [
      { name: 'pattern', label: 'Match', value: rule.pattern || '', placeholder: 'github.com  ·  */docs/*  ·  /jira|confluence/', required: true },
      { name: 'type', label: 'Match type', type: 'select', value: rule.type || 'auto', options: TYPES },
      { name: 'title', label: 'Group name', value: rule.title || '', placeholder: 'e.g. Code' },
      { name: 'color', label: 'Group color', type: 'color', value: rule.color || GROUP_COLORS[1 + (ctx.data.rules.length % 8)] },
    ],
    okLabel: rule.id ? 'Save' : 'Add rule',
  });
  if (!v) return;
  if (v.type === 'regex' || (v.type === 'auto' && /^\/.+\/[a-z]*$/i.test(v.pattern))) {
    try { const m = v.pattern.match(/^\/(.+)\/([a-z]*)$/i); new RegExp(m ? m[1] : v.pattern, m ? m[2] : ''); } catch (e) { await dialog({ title: 'Invalid regular expression', message: e.message, okLabel: 'OK' }); return; }
  }
  await act(() => send('rules.save', { rule: { ...rule, ...v, title: v.title || hostOf('https://' + v.pattern) || v.pattern } }), 'Rule saved');
}

function move(id, delta) {
  const ids = ctx.data.rules.map(r => r.id);
  const i = ids.indexOf(id), j = i + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  act(() => send('rules.reorder', { ids }));
}

function renderTable() {
  const rules = ctx.data.rules;
  if (!rules.length) {
    clear(tableEl, emptyState('folder', 'No rules yet', 'Add a rule like “github.com → Code” and new tabs from that site are grouped automatically.',
      h('button.btn.primary', { onclick: () => editRule() }, icon('plus'), 'Add rule')));
    return;
  }
  clear(tableEl, h('div.card', h('table.rules-table',
    h('thead', h('tr', h('th', { style: { width: '56px' } }, 'On'), h('th', 'Match'), h('th', 'Type'), h('th', 'Group'), h('th', { style: { width: '150px' } }, h('span.sr-only', 'Actions')))),
    h('tbody', rules.map((r, i) => h('tr' + (r.enabled === false ? '.off' : ''),
      h('td', h('input', { type: 'checkbox', checked: r.enabled !== false, 'aria-label': 'Enabled', style: { accentColor: 'var(--accent)' }, onchange: e => act(() => send('rules.save', { rule: { ...r, enabled: e.target.checked } })) })),
      h('td', h('code', r.pattern)),
      h('td.muted.small', TYPES.find(t => t.value === r.type)?.label || 'Auto-detect'),
      h('td', h('span.group-chip', { style: { background: COLOR_HEX[r.color] } }, r.title || r.pattern)),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        h('button.icon-btn', { title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(r.id, -1), style: { transform: 'rotate(-90deg)' } }, icon('chevron')),
        h('button.icon-btn', { title: 'Move down', 'aria-label': 'Move down', disabled: i === rules.length - 1, onclick: () => move(r.id, 1), style: { transform: 'rotate(90deg)' } }, icon('chevron')),
        h('button.icon-btn', { title: 'Edit', 'aria-label': 'Edit rule', onclick: () => editRule(r) }, icon('edit')),
        h('button.icon-btn.danger', { title: 'Delete', 'aria-label': 'Delete rule', onclick: async () => { if (await confirmDialog('Delete this rule?', `Tabs matching ${r.pattern} will no longer be grouped automatically. Existing groups stay.`)) act(() => send('rules.delete', { id: r.id })); } }, icon('trash')))))))));
}

function renderSuggestions() {
  const counts = new Map();
  for (const t of ctx.tabs) { const host = hostOf(t.url); if (host && /^https?:/.test(t.url)) counts.set(host, (counts.get(host) || 0) + 1); }
  const covered = host => ctx.data.rules.some(r => matchPattern('https://' + host + '/', r.pattern, r.type));
  const top = [...counts].filter(([host, n]) => n >= 2 && !covered(host)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  clear(suggestEl, top.length ? [h('span.small.muted', 'Suggested from your open tabs:'), ...top.map(([host, n]) =>
    h('button.btn.sm', { onclick: () => editRule({ pattern: host, type: 'domain', title: host.split('.').slice(-2, -1)[0] || host }) }, icon('plus'), `${host} (${n})`))] : []);
}

function runTest() {
  const url = testInput.value.trim();
  if (!url) { testOut.hidden = true; return; }
  testOut.hidden = false;
  const full = /^[a-z]+:/i.test(url) ? url : 'https://' + url;
  const rule = ctx.data.rules.find(r => r.enabled !== false && matchPattern(full, r.pattern, r.type || 'auto'));
  clear(testOut, rule ? ['Goes to group ', h('span.group-chip', { style: { background: COLOR_HEX[rule.color] } }, rule.title || rule.pattern), ' via rule ', h('code', rule.pattern)] : 'No rule matches. The tab stays ungrouped.');
}

function update(c) {
  ctx = c;
  toggleEl.checked = !!ctx.data.settings.groupingEnabled;
  renderTable();
  renderSuggestions();
  runTest();
}

export default {
  id: 'rules', label: 'Grouping rules', icon: 'folder', key: 'r',
  count: c => c.data.rules.filter(r => r.enabled !== false).length,
  mount(el, c) {
    ctx = c;
    tableEl = h('div');
    suggestEl = h('div.suggest', { style: { margin: '16px 0' } });
    testInput = h('input.input', { type: 'text', placeholder: 'Paste a URL to see which group it would join', style: { flex: 1, maxWidth: '520px' }, oninput: () => runTest() });
    testOut = h('div.test-result', { hidden: true });
    toggleEl = h('input', { type: 'checkbox', onchange: e => act(() => send('settings.set', { patch: { groupingEnabled: e.target.checked } })) });
    el.append(
      viewHead('Grouping rules', 'Send tabs into named, colored tab groups by site or address pattern. Rules are checked top to bottom; the first match wins.',
        h('button.btn', { onclick: () => act(() => send('rules.applyAll'), r => `Grouped ${r} tab${r === 1 ? '' : 's'}`) }, icon('wand'), 'Apply to open tabs'),
        h('button.btn.primary', { onclick: () => editRule() }, icon('plus'), 'Add rule')),
      h('div.toolbar', h('label.check', toggleEl, h('span', 'Group new tabs automatically')), ),
      tableEl, suggestEl,
      h('h2', { style: { fontSize: '15px', margin: '24px 0 8px' } }, 'Test a URL'),
      h('div.toolbar', testInput), testOut);
    update(c);
  },
  update,
};
