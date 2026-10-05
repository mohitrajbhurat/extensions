import { h, icon, send, act, clear, dialog, confirmDialog, toast } from '../../shared/ui.js';
import { plural } from '../../lib/util.js';
import { viewHead, download } from '../common.js';

let ctx, root;
const controls = [];
const FORM_PERMS = { permissions: ['scripting'], origins: ['<all_urls>'] };

const save = patch => act(() => send('settings.set', { patch }));

function toggle(key, label, hint) {
  const input = h('input', { type: 'checkbox', onchange: () => save({ [key]: input.checked }) });
  controls.push(() => { input.checked = !!ctx.data.settings[key]; });
  return h('label.check', input, h('span', label, hint ? h('div.hint', hint) : null));
}

function number(key, label, { min = 1, max = 100000, suffix = '' } = {}) {
  const input = h('input.input', { type: 'number', min, max, step: 1, 'aria-label': label });
  input.addEventListener('change', () => {
    const v = Math.round(+input.value);
    if (!Number.isFinite(v) || v < min || v > max) { toast(`Enter a number from ${min} to ${max}`, { error: true }); input.value = ctx.data.settings[key]; return; }
    save({ [key]: v });
  });
  controls.push(() => { if (document.activeElement !== input) input.value = ctx.data.settings[key]; });
  return h('div.setting-row', h('span', label), h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, input, suffix ? h('span.muted.small', suffix) : null));
}

function select(key, label, options) {
  const sel = h('select.input.wide', { 'aria-label': label, onchange: () => save({ [key]: sel.value }) }, options.map(([v, l]) => h('option', { value: v }, l)));
  controls.push(() => { sel.value = ctx.data.settings[key]; });
  return h('div.setting-row', h('span', label), sel);
}

function section(iconName, title, ...children) {
  return h('section.card', h('h2', icon(iconName), title), children);
}

function whitelistEditor() {
  const ta = h('textarea.input', { rows: 4, placeholder: 'mail.google.com\ncalendar.google.com\n*/admin/*', 'aria-label': 'Never suspend these sites' });
  ta.addEventListener('change', () => save({ whitelist: ta.value.split('\n').map(s => s.trim()).filter(Boolean) }));
  controls.push(() => { if (document.activeElement !== ta) ta.value = (ctx.data.settings.whitelist || []).join('\n'); });
  return h('label.field', h('span', 'Never suspend (one domain or pattern per line)'), ta);
}

function formPermission() {
  const box = h('div');
  const render = async () => {
    const granted = await chrome.permissions.contains(FORM_PERMS).catch(() => false);
    clear(box, granted
      ? h('div.setting-row', h('span.perm-ok', 'Unsaved-form protection is active'), h('button.btn.sm', { onclick: async () => { await chrome.permissions.remove(FORM_PERMS); render(); } }, 'Revoke access'))
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p.small.muted', 'To skip tabs where you typed into a form, Tab Workspaces needs to look at each page right before suspending it. This is optional and only checks form fields, nothing is stored or sent.'),
        h('div', h('button.btn.sm', { onclick: async () => { const ok = await chrome.permissions.request(FORM_PERMS).catch(() => false); toast(ok ? 'Form protection enabled' : 'Permission not granted'); render(); } }, 'Allow form checks'))));
  };
  render();
  return box;
}

async function importFile(file) {
  const text = await file.text();
  const v = await dialog({
    title: 'Import data',
    message: `“${file.name}”. Merge adds the imported workspaces, stashes, sessions, archive and rules to what you have. Replace overwrites everything, including settings.`,
    fields: [{ name: 'mode', label: 'Mode', type: 'select', value: 'merge', options: [{ value: 'merge', label: 'Merge with existing data' }, { value: 'replace', label: 'Replace all existing data' }] }],
    okLabel: 'Import',
  });
  if (!v) return;
  if (v.mode === 'replace' && !(await confirmDialog('Replace all data?', 'Your current workspaces, stashes, sessions, archive, rules and settings will be overwritten.', 'Replace'))) return;
  await act(() => send('data.import', { data: text, mode: v.mode }), r => `Imported ${plural(r.workspaces, 'workspace')}, ${plural(r.stashes, 'stash', 'stashes')}, ${plural(r.sessions, 'session')}, ${plural(r.rules, 'rule')}`);
}

async function shortcuts() {
  const box = h('div.stack', { style: { gap: '4px' } });
  try {
    const cmds = await chrome.commands.getAll();
    clear(box, cmds.map(c => h('div.setting-row.small', h('span', c.description || (c.name === '_execute_action' ? 'Open popup' : c.name)), c.shortcut ? h('kbd', c.shortcut) : h('span.faint', 'Not set'))));
  } catch {}
  return box;
}

function update(c) {
  ctx = c;
  for (const fn of controls) fn();
}

export default {
  id: 'settings', label: 'Settings', icon: 'settings', key: 'o',
  mount(el, c) {
    ctx = c;
    controls.length = 0;
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => { if (fileInput.files[0]) importFile(fileInput.files[0]); fileInput.value = ''; } });
    const shortcutBox = h('div');
    shortcuts().then(b => shortcutBox.append(b));
    root = h('div',
      viewHead('Settings', 'Everything stays on this device. Nothing is sent anywhere.'),
      h('div.settings',
        section('layers', 'Workspaces',
          toggle('autosaveWorkspaces', 'Save workspace changes automatically', 'Opening, closing and moving tabs updates the window’s workspace.'),
          toggle('keepPinnedOnSwitch', 'Keep pinned tabs when switching', 'Pinned tabs stay in every workspace instead of being swapped.'),
          toggle('stashUnsavedOnSwitch', 'Stash tabs of a window with no workspace before switching', 'So switching never loses tabs that were not part of a workspace.'),
          toggle('lazyRestore', 'Load restored tabs lazily', 'Only the active tab loads; others load when you click them. Saves memory when switching.')),
        section('moon', 'Memory saver',
          toggle('memoryEnabled', 'Suspend idle tabs automatically', 'Uses the browser’s built-in tab discarding. A suspended tab stays in the tab strip and reloads when clicked.'),
          number('idleMinutes', 'Suspend after', { min: 1, max: 1440, suffix: 'minutes idle' }),
          toggle('neverDiscardPinned', 'Never suspend pinned tabs'),
          h('p.small.muted', 'Tabs playing audio and the active tab in each window are never suspended.'),
          toggle('protectForms', 'Never suspend tabs with unsaved form input'),
          formPermission(),
          whitelistEditor()),
        section('copy', 'Duplicate guard',
          select('duplicateMode', 'When a page is opened twice', [['notify', 'Ask with a notification'], ['auto', 'Close it and switch to the open tab'], ['off', 'Do nothing']]),
          select('duplicateScope', 'Look for the open copy in', [['window', 'The same window'], ['all', 'All windows']]),
          toggle('dupIgnoreHash', 'Ignore #fragments when comparing addresses'),
          toggle('dupIgnoreTracking', 'Ignore tracking parameters (utm_*, fbclid, gclid…)')),
        section('clock', 'Sessions',
          toggle('sessionsEnabled', 'Take automatic snapshots'),
          number('sessionIntervalMin', 'Every', { min: 1, max: 1440, suffix: 'minutes' }),
          number('sessionMaxCount', 'Keep the latest', { min: 1, max: 500, suffix: 'snapshots' })),
        section('inbox', 'Stash',
          toggle('removeFromStashOnRestore', 'Remove tabs from the stash when restoring them', 'Starred stashes are always kept.'),
          toggle('stashIncludePinned', 'Include pinned tabs when stashing a window')),
        section('archive', 'Archive and badge',
          toggle('archiveEnabled', 'Record closed tabs in the archive'),
          number('archiveMax', 'Keep up to', { min: 100, max: 100000, suffix: 'entries' }),
          select('badgeMode', 'Toolbar badge shows', [['total', 'Tabs in all windows'], ['window', 'Tabs in the current window'], ['off', 'Nothing']]),
          number('badgeWarnAt', 'Turn badge red at', { min: 2, max: 10000, suffix: 'tabs' })),
        section('download', 'Backup and import',
          h('p.small.muted', 'Export a JSON backup of workspaces, stashes, sessions, archive, rules and settings. Import it on another computer or after reinstalling.'),
          h('div.toolbar', { style: { margin: 0 } },
            h('button.btn', { onclick: async () => { const d = await act(() => send('data.export')); download(`tab-workspaces-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d, null, 2)); } }, icon('download'), 'Export JSON'),
            h('button.btn', { onclick: () => fileInput.click() }, icon('upload'), 'Import JSON'),
            h('button.btn', { onclick: () => { location.hash = 'stash'; } }, 'OneTab import / export'),
            fileInput)),
        section('keyboard', 'Keyboard shortcuts',
          shortcutBox,
          h('div', h('button.btn.sm', { onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }, 'Change shortcuts'))),
        section('settings', 'Reset',
          h('p.small.muted', 'Restore all settings to their defaults. Your workspaces, stashes and history are not touched.'),
          h('div', h('button.btn.danger', { onclick: async () => { if (await confirmDialog('Reset settings?', 'All settings return to their defaults.', 'Reset')) await act(() => send('settings.reset'), 'Settings reset'); } }, 'Reset settings')))));
    el.append(root);
    update(c);
  },
  update,
};
