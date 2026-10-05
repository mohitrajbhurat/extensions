// Popup: global pause, per-group toggles, what matched on this tab, and a one-line header rule.
import { getState, update, mutations, onStateChanged } from '../lib/store.js';
import {
  newRule, newGroup, defaultCondition, countActiveRules, normalizeDomain,
  COMMON_REQUEST_HEADERS, COMMON_RESPONSE_HEADERS, APPENDABLE_REQUEST_HEADERS, RULE_TYPES,
} from '../lib/rules.js';
import { $, el, clear, toast, send, applyTheme } from '../shared/ui.js';

const QUICK_GROUP = 'Quick rules';
let state = null;
let status = null;
let tab = null;

applyTheme();

init().catch(e => {
  const n = $('#statusNotice');
  n.textContent = String(e && e.message || e);
  n.classList.remove('hidden');
});

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state = await getState();
  wire();
  render();
  await refreshStatus(true);
  onStateChanged(s => { state = s; render(); refreshStatus(); });
  setInterval(() => refreshStatus(false), 2000);
}

function wire() {
  $('#pauseToggle').addEventListener('change', async e => {
    const on = e.target.checked;
    await update(s => mutations.setPaused(s, !on));
    toast(on ? 'Rules on' : 'All rules paused');
  });
  $('#clearMatches').addEventListener('click', async () => {
    await send({ cmd: 'clearMatches', tabId: tab && tab.id });
    await refreshStatus();
  });
  const openEditor = (hash = '') => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html' + hash) });
    window.close();
  };
  $('#openEditor').addEventListener('click', () => openEditor());
  $('#openEditorTop').addEventListener('click', () => openEditor());
  $('#openTester').addEventListener('click', () => openEditor('#tester' + (tab && tab.url ? '?url=' + encodeURIComponent(tab.url) : '')));
  $('#openShortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });
  $('#quickKind').addEventListener('change', fillHeaderNames);
  $('#quickOp').addEventListener('change', () => {
    const remove = $('#quickOp').value === 'remove';
    $('#quickValue').disabled = remove;
    if (remove) $('#quickValue').value = '';
  });
  $('#quickForm').addEventListener('submit', addQuickRule);
  fillHeaderNames();
}

function fillHeaderNames() {
  const list = $('#headerNames');
  clear(list);
  const names = $('#quickKind').value === 'requestHeaders' ? COMMON_REQUEST_HEADERS : COMMON_RESPONSE_HEADERS;
  for (const n of names) list.append(el('option', { value: n }));
}

function hostOfTab() {
  try { return new URL(tab.url).hostname; } catch { return ''; }
}

function render() {
  const active = countActiveRules(state);
  $('#pauseToggle').checked = !state.paused;
  $('#pauseText').textContent = state.paused ? 'Paused' : 'On';
  $('#activeLine').textContent = state.paused
    ? 'Paused — nothing is being rewritten'
    : `${active} active rule${active === 1 ? '' : 's'} in ${state.groups.filter(g => g.enabled).length} group${state.groups.filter(g => g.enabled).length === 1 ? '' : 's'}`;

  const host = hostOfTab();
  $('#tabHost').textContent = host || (tab && tab.url ? tab.url.slice(0, 60) : 'no page');
  $('#quickTargetHint').textContent = host ? `scope: ${host}` : '';

  const list = $('#groupList');
  clear(list);
  if (!state.groups.length) {
    list.append(el('div', { class: 'empty', text: 'No groups yet. Open the rule editor to add one.' }));
  }
  for (const g of state.groups) {
    const counts = g.rules.filter(r => r.enabled).length;
    const row = el('div', { class: 'group-row' + (g.enabled ? '' : ' off') }, [
      el('span', { class: 'dot', style: `background:${g.color || 'var(--accent)'}` }),
      el('span', { class: 'g-name', text: g.name, title: g.description || g.name }),
      el('span', { class: 'spacer' }),
      g.tabScope !== undefined && g.tabScope !== null ? el('span', { class: 'pill accent', text: 'tab' }) : null,
      el('span', { class: 'g-meta', text: `${counts}/${g.rules.length}` }),
      el('button', {
        class: 'ghost sm icon g-edit', title: `Edit ${g.name}`, text: '✎',
        onclick: () => { chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html#group=${g.id}`) }); window.close(); },
      }),
      el('label', { class: 'switch' }, [
        el('input', {
          type: 'checkbox', checked: g.enabled, 'aria-label': `Enable ${g.name}`,
          onchange: async e => { await update(s => mutations.toggleGroup(s, g.id, e.target.checked)); },
        }),
        el('span', {}),
      ]),
    ]);
    list.append(row);
  }
}

async function refreshStatus(poll = false) {
  status = await send({ cmd: 'status', tabId: tab && tab.id, limit: 60, poll });
  if (!status || status.error) return;
  const notice = $('#statusNotice');
  const errs = (status.status && status.status.errors) || [];
  const installError = status.status && status.status.installError;
  if (errs.length || installError) {
    notice.classList.remove('hidden');
    clear(notice);
    notice.append(el('div', { text: installError || `${errs.length} rule${errs.length === 1 ? '' : 's'} could not be installed` }));
    if (errs.length) notice.append(el('div', { class: 'tiny', text: `${errs[0].name}: ${errs[0].messages[0]}` }));
  } else notice.classList.add('hidden');

  const note = $('#feedbackNote');
  if (!status.feedback) {
    note.textContent = 'Match tracking needs the declarativeNetRequestFeedback permission (dev mode only).';
    note.classList.remove('hidden');
  } else if (!status.liveMatching) {
    note.textContent = 'Live match events are unavailable here; the list refreshes when the page finishes loading.';
    note.classList.remove('hidden');
  } else note.classList.add('hidden');

  renderMatches(status.matches || { counts: {}, entries: [] });
}

function renderMatches(matches) {
  const host = $('#matchList');
  clear(host);
  const counts = matches.counts || {};
  const ids = Object.keys(counts);
  if (!ids.length) {
    host.append(el('div', { class: 'empty', text: state.paused ? 'Rules are paused.' : 'No rules have matched on this tab yet. Reload the page to check.' }));
    return;
  }
  const byRule = new Map();
  for (const e of matches.entries || []) if (!byRule.has(e.ruleId)) byRule.set(e.ruleId, e);
  const rows = ids.map(id => ({ id, n: counts[id], last: byRule.get(id) }))
    .sort((a, b) => b.n - a.n);
  for (const r of rows) {
    const g = state.groups.find(x => x.id === (r.last && r.last.groupId));
    const name = (r.last && r.last.name) || r.id;
    host.append(el('div', { class: 'match-row' }, [
      el('span', { class: 'dot', style: `background:${(g && g.color) || 'var(--accent)'}` }),
      el('div', { class: 'col gap0', style: 'min-width:0;flex:1' }, [
        el('span', { class: 'm-name', text: name, title: name }),
        el('span', { class: 'm-url', text: (r.last && r.last.url) || (r.last && RULE_TYPES[r.last.ruleType] ? RULE_TYPES[r.last.ruleType].short : ''), title: (r.last && r.last.url) || '' }),
      ]),
      el('span', { class: 'm-count', text: `×${r.n}` }),
    ]));
  }
}

async function addQuickRule(ev) {
  ev.preventDefault();
  const err = $('#quickError');
  err.classList.add('hidden');
  const kind = $('#quickKind').value;
  const op = $('#quickOp').value;
  const name = $('#quickName').value.trim();
  const value = $('#quickValue').value;
  const scope = $('#quickScope').value;
  if (!name) return;
  if (op === 'append' && kind === 'requestHeaders' && !APPENDABLE_REQUEST_HEADERS.includes(name.toLowerCase())) {
    err.textContent = `Chrome does not allow appending to the request header ${name}. Use Set.`;
    err.classList.remove('hidden');
    return;
  }
  const host = hostOfTab();
  if ((scope === 'site' || scope === 'tab') && !host) {
    err.textContent = 'This tab has no http(s) page, so pick "All URLs".';
    err.classList.remove('hidden');
    return;
  }
  const condition = defaultCondition();
  if (scope === 'site') { condition.matchType = 'domain'; condition.value = normalizeDomain(host); }
  const rule = newRule(kind, {
    name: `${op === 'remove' ? 'Remove' : op === 'append' ? 'Append' : 'Set'} ${name}${scope === 'all' ? '' : ' on ' + host}`,
    condition,
    action: { headers: [{ op, name, value: op === 'remove' ? '' : value }] },
  });
  await update(s => {
    let g = s.groups.find(x => x.name === QUICK_GROUP && (scope === 'tab' ? x.tabScope === tab.id : x.tabScope === undefined || x.tabScope === null));
    if (!g) {
      g = newGroup(QUICK_GROUP, { color: '#0ea5e9', description: 'Added from the popup.' });
      if (scope === 'tab') { g.name = `${QUICK_GROUP} (tab)`; g.tabScope = tab.id; }
      s.groups.unshift(g);
    }
    g.enabled = true;
    g.rules.push(rule);
  });
  $('#quickName').value = '';
  $('#quickValue').value = '';
  toast(scope === 'tab' ? 'Rule added for this tab' : 'Rule added');
}
