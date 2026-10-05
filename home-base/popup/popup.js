// Toolbar popup: quick add plus Today / Upcoming / Inbox lists.
import * as store from '../lib/store.js';
import { applyTheme } from '../lib/ui.js';
import { counts } from '../lib/tasks.js';
import { ymd, longLabel, addDays } from '../lib/dates.js';
import { TaskView, openEditor, wireQuickAdd } from '../lib/taskui.js';

const $ = (id) => document.getElementById(id);
const state = { tasks: [], projects: [], settings: store.DEFAULT_SETTINGS };
let view = 'today';
try { view = localStorage.getItem('hb-popup-view') || 'today'; } catch { /* ignore */ }

const tv = new TaskView($('list'), {
  compact: true,
  onOpen: (id) => openEditor(id, { tasks: state.tasks, projects: state.projects, h24: state.settings.h24 }),
});

function render() {
  applyTheme(state.settings.theme);
  for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  $('title').textContent = { today: 'Today', upcoming: 'Upcoming', inbox: 'Inbox' }[view];
  const c = counts(state.tasks, ymd(new Date()));
  $('sub').textContent = view === 'today'
    ? `${longLabel(ymd(new Date()))} · ${c.today} due${c.overdue ? `, ${c.overdue} overdue` : ''}`
    : view === 'inbox' ? `${c.inbox} open` : `${c.upcoming} scheduled`;
  tv.setData({ tasks: state.tasks, projects: state.projects, h24: state.settings.h24 });
  tv.render(view);
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  view = b.dataset.view;
  try { localStorage.setItem('hb-popup-view', view); } catch { /* ignore */ }
  render();
});
wireQuickAdd($('quick-add'), $('qa-hint'), () => (view === 'today' ? { date: ymd(new Date()) } : view === 'upcoming' ? { date: addDays(ymd(new Date()), 1) } : {}));
$('open-tasks').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL(`tasks/tasks.html#${view}`) }); window.close(); });
$('open-settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('quick-add').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); tv.moveSelection(1); }
});

(async () => {
  Object.assign(state, await store.getMany(['tasks', 'projects', 'settings']));
  render();
  $('quick-add').focus();
})();
store.watch(['tasks', 'projects', 'settings'], (vals) => { Object.assign(state, vals); render(); });
