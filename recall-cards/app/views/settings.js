import { h, toast, confirmDialog } from '../ui.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../../lib/settings.js';
import { parseSteps, formatSteps, DEFAULT_WEIGHTS } from '../../lib/fsrs.js';
import { importBackup } from '../../lib/db.js';

const ALL_URLS = { origins: ['<all_urls>'] };

export async function render(root, ctx) {
  let s = await getSettings();
  const page = h('div', { class: 'page' });
  root.append(page);

  async function save(patch, msg = 'Saved') {
    s = await saveSettings(patch);
    try { await chrome.runtime.sendMessage({ type: 'settingsChanged' }); } catch {}
    toast(msg);
    ctx.refreshSidebar();
  }

  const row = (title, desc, ...ctl) => h('div', { class: 'set-row' }, h('div', { class: 'desc' }, h('b', {}, title), desc ? h('span', {}, desc) : null), h('div', { class: 'ctl' }, ...ctl));
  const toggle = (checked, onchange, label) => {
    const input = h('input', { type: 'checkbox', checked, 'aria-label': label, role: 'switch' });
    input.addEventListener('change', () => onchange(input.checked, input));
    return h('label', { class: 'switch' }, input, h('span'));
  };

  // Desired retention
  const ret = h('input', { type: 'range', min: '0.75', max: '0.97', step: '0.01', value: String(s.desiredRetention), 'aria-label': 'Desired retention' });
  const retOut = h('output', {}, `${Math.round(s.desiredRetention * 100)}%`);
  ret.addEventListener('input', () => { retOut.textContent = `${Math.round(ret.value * 100)}%`; });
  ret.addEventListener('change', () => save({ desiredRetention: Number(ret.value) }));

  const stepsInput = (key, label) => {
    const input = h('input', { type: 'text', value: formatSteps(s[key]), 'aria-label': label, style: { width: '160px' } });
    input.addEventListener('change', () => {
      const v = parseSteps(input.value);
      if (!v) { toast('Use values like “1m 10m” or “10m 1h”.', 'error'); input.value = formatSteps(s[key]); return; }
      save({ [key]: v }).then(() => { input.value = formatSteps(v); });
    });
    return input;
  };
  const num = (key, min, max, label) => {
    const input = h('input', { type: 'number', min: String(min), max: String(max), value: String(s[key]), 'aria-label': label, style: { width: '110px' } });
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v < min || v > max) { toast(`Enter a number from ${min} to ${max}.`, 'error'); input.value = s[key]; return; }
      save({ [key]: v });
    });
    return input;
  };
  const rollover = h('select', { 'aria-label': 'Next day starts at', style: { width: '110px' } }, ...Array.from({ length: 24 }, (_, i) => new Option(`${String(i).padStart(2, '0')}:00`, i)));
  rollover.value = String(s.rolloverHour);
  rollover.addEventListener('change', () => save({ rolloverHour: Number(rollover.value) }));
  const reminderTime = h('input', { type: 'time', value: s.reminderTime, 'aria-label': 'Reminder time', style: { width: '120px' } });
  reminderTime.addEventListener('change', () => { if (reminderTime.value) save({ reminderTime: reminderTime.value }, 'Reminder time saved'); });

  const floatToggle = toggle(s.floatingButton, async (on, input) => {
    if (on) {
      let granted = false;
      try { granted = await chrome.permissions.request(ALL_URLS); } catch {}
      if (!granted) { input.checked = false; toast('Permission is needed to show the button on pages.', 'error'); return; }
      await save({ floatingButton: true }, 'Floating button on. Reload open tabs to see it.');
    } else {
      await save({ floatingButton: false }, 'Floating button off');
      try { await chrome.permissions.remove(ALL_URLS); } catch {}
    }
  }, 'Floating button on text selection');

  page.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Settings')),
    h('section', { class: 'card-surface section' }, h('h2', {}, 'Scheduling (FSRS-5)'),
      h('div', {},
        row('Desired retention', 'Probability of remembering a card when it comes due. Higher means more frequent reviews. 90% is a good default.', h('div', { class: 'range-row' }, ret, retOut)),
        row('New cards per day', 'Maximum number of new cards introduced each day.', num('newPerDay', 0, 9999, 'New cards per day')),
        row('Learning steps', 'Short intervals for new cards before they graduate, e.g. “1m 10m”. Leave empty to graduate immediately.', stepsInput('learningSteps', 'Learning steps')),
        row('Relearning steps', 'Steps after you forget a review card (rate Again).', stepsInput('relearningSteps', 'Relearning steps')),
        row('Maximum interval', 'Longest gap between reviews, in days.', num('maximumInterval', 1, 36500, 'Maximum interval')),
        row('Interval fuzz', 'Slightly randomize intervals so cards added together don’t always come due together.', toggle(s.enableFuzz, v => save({ enableFuzz: v }), 'Interval fuzz')),
        row('Show next intervals on buttons', 'Display the time until the next review under Again / Hard / Good / Easy.', toggle(s.showIntervals, v => save({ showIntervals: v }), 'Show intervals')),
        row('Next day starts at', 'When the study day rolls over (cards due “today” and daily limits).', rollover))),
    h('section', { class: 'card-surface section' }, h('h2', {}, 'Reminders & capture'),
      h('div', {},
        row('Daily reminder', 'A notification when cards are due.', toggle(s.reminderEnabled, v => save({ reminderEnabled: v }), 'Daily reminder')),
        row('Reminder time', null, reminderTime),
        row('Due count on toolbar icon', 'Show a badge with the number of cards due.', toggle(s.showBadge, v => save({ showBadge: v }), 'Badge')),
        row('Floating button on text selection', 'Shows a small “Make flashcard” button when you select text. Needs permission to run on all sites; the right-click menu works without it.', floatToggle))),
    h('section', { class: 'card-surface section' }, h('h2', {}, 'Keyboard shortcuts'),
      h('table', { class: 'kbd-table small' }, h('tbody', {},
        ...[['Space / Enter', 'Show answer, then rate Good'], ['1 2 3 4', 'Again, Hard, Good, Easy'], ['Z', 'Undo last rating'], ['E', 'Edit current card'], ['S', 'Suspend current card'], ['Shift+Delete', 'Delete current card'], ['Ctrl+Enter', 'Save card in any editor'], ['Ctrl+Shift+C', 'Wrap selection in a cloze'], ['/', 'Focus search in Browse']]
          .map(([k, d]) => h('tr', {}, h('td', {}, h('span', { class: 'kbd' }, k)), h('td', {}, d))))),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Global shortcuts for “Make flashcard from selection” and “Start review” can be assigned at ',
        h('a', { href: '#', onclick: e => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); } }, 'chrome://extensions/shortcuts'), '.')),
    h('section', { class: 'card-surface section' }, h('h2', {}, 'Data'),
      h('p', { class: 'small muted', style: { margin: 0 } }, `All cards and review history are stored locally in this browser (IndexedDB). FSRS-5 default weights: ${DEFAULT_WEIGHTS.join(', ')}.`),
      h('div', { class: 'export-row' },
        h('button', { class: 'btn', onclick: () => ctx.navigate('#io') }, 'Export a backup'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmDialog('Restore default settings?', 'Scheduling, reminder and capture settings return to their defaults. Cards are not affected.', { okText: 'Restore' }))) return;
          if (s.floatingButton) { try { await chrome.permissions.remove(ALL_URLS); } catch {} }
          await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
          await save({}, 'Defaults restored');
          ctx.navigate('#settings');
        } }, 'Restore default settings'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog('Delete all data?', 'Every deck, card and review will be permanently deleted. Export a backup first.', { okText: 'Delete everything', danger: true }))) return;
          await importBackup({ decks: [], cards: [], revlog: [] }, true);
          toast('All data deleted');
          ctx.navigate('#decks');
        } }, 'Delete all data'))));
}
