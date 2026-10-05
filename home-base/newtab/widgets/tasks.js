// Tasks widget: quick add with natural-language dates, Today / Upcoming / Inbox lists.
import { h, icon, openPage } from '../../lib/ui.js';
import { TaskView, openEditor, wireQuickAdd } from '../../lib/taskui.js';
import { ymd, addDays } from '../../lib/dates.js';

const VIEWS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['inbox', 'Inbox']];

export function mount(frame, app) {
  let view = sessionStorage.getItem('hb-task-widget-view') || 'today';
  const input = h('input.input', { type: 'text', placeholder: 'Add a task… “pay rent every 1st”', 'aria-label': 'Add a task', autocomplete: 'off' });
  const hint = h('div.hint', { hidden: true, 'aria-live': 'polite' });
  const tabs = h('div.seg', { role: 'tablist', 'aria-label': 'Task list' });
  const listEl = h('div.widget-scroll');
  const tv = new TaskView(listEl, {
    compact: true,
    onOpen: (id) => openEditor(id, { tasks: app.state.tasks, projects: app.state.projects, h24: app.state.settings.h24 }),
  });
  const renderTabs = () => {
    tabs.replaceChildren(...VIEWS.map(([v, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(v === view),
      onclick: () => { view = v; sessionStorage.setItem('hb-task-widget-view', v); renderTabs(); render(); },
    }, label)));
  };
  const open = h('button.icon-btn', { type: 'button', 'aria-label': 'Open task manager', title: 'Open task manager', onclick: () => openPage('tasks/tasks.html#' + view, { newTab: false }) }, icon('external', 16));
  frame.head.querySelector('.widget-actions').prepend(open);
  wireQuickAdd(input, hint, () => (view === 'today' ? { date: ymd(new Date()) } : view === 'upcoming' ? { date: addDays(ymd(new Date()), 1) } : {}));
  frame.body.append(h('div.quick-add', input, hint), tabs, listEl);
  renderTabs();

  function render() {
    tv.setData({ tasks: app.state.tasks, projects: app.state.projects, h24: app.state.settings.h24 });
    tv.render(view);
  }
  render();
  return {
    keys: ['tasks', 'projects', 'settings'],
    update: render,
    focusInput: () => input.focus(),
  };
}
