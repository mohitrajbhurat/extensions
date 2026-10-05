// Full-page task manager: views, projects, labels, search, keyboard shortcuts, drag reorder.
import * as store from '../lib/store.js';
import { h, icon, applyTheme, isTyping, toast, debounce } from '../lib/ui.js';
import { counts, allLabels, buildView } from '../lib/tasks.js';
import { ymd, addDays, longLabel } from '../lib/dates.js';
import { TaskView, openEditor, wireQuickAdd, toggleWithUndo, removeWithUndo } from '../lib/taskui.js';
import * as ops from '../lib/taskops.js';

const $ = (id) => document.getElementById(id);
const state = { tasks: [], projects: [], settings: store.DEFAULT_SETTINGS, view: 'today', query: '' };
const list = new TaskView($('list'), {
  onOpen: (id) => edit(id),
  onLabel: (l) => go('label:' + l),
});

const MAIN = [
  { view: 'inbox', name: 'Inbox', icon: 'inbox', key: 'i' },
  { view: 'today', name: 'Today', icon: 'sun', key: 't' },
  { view: 'upcoming', name: 'Upcoming', icon: 'calendar', key: 'u' },
  { view: 'overdue', name: 'Overdue', icon: 'alert', key: 'o' },
  { view: 'completed', name: 'Completed', icon: 'done', key: 'c' },
];

$('add-project').append(icon('plus', 16));
$('menu-btn').append(icon('list'));

function today() { return ymd(new Date()); }

function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return { view: 'today', query: '' };
  if (raw.startsWith('search')) return { view: 'search', query: raw.slice(7) };
  return { view: raw, query: '' };
}

let lastNonSearch = 'today';
function go(view, query = '') {
  if (view !== 'search') lastNonSearch = view;
  const hash = view === 'search' ? `search:${query}` : view;
  if (decodeURIComponent(location.hash.slice(1)) !== hash) history.replaceState(null, '', '#' + encodeURIComponent(hash));
  state.view = view;
  state.query = query;
  if (view !== 'search') $('search').value = '';
  closeSidebar();
  render();
}

function viewTitle() {
  const v = state.view;
  const m = MAIN.find((x) => x.view === v);
  if (m) return m.name;
  if (v === 'search') return 'Search';
  if (v.startsWith('project:')) return state.projects.find((p) => p.id === v.slice(8))?.name || 'Project';
  if (v.startsWith('label:')) return '@' + v.slice(6);
  return 'Tasks';
}

function quickAddDefaults() {
  const v = state.view;
  if (v === 'today' || v === 'overdue') return { date: today() };
  if (v === 'upcoming') return { date: addDays(today(), 1) };
  if (v.startsWith('project:')) return { projectId: v.slice(8) };
  if (v.startsWith('label:')) return { labels: [v.slice(6)] };
  return {};
}

function navLink(view, label, extra = [], count = 0, alert = false) {
  const a = h('a', {
    href: '#' + encodeURIComponent(view),
    'aria-current': state.view === view ? 'page' : null,
    dataset: { view },
    onclick: (e) => { e.preventDefault(); go(view); },
  }, extra, h('span.grow', label), count ? h('span', { class: alert ? 'count alert' : 'count' }, String(count)) : null);
  // Drop a task on a project or Today/Inbox to move it there.
  a.addEventListener('dragover', (e) => {
    if (!list.dragId || !(view === 'inbox' || view === 'today' || view.startsWith('project:'))) return;
    e.preventDefault();
    a.classList.add('drop-hover');
  });
  a.addEventListener('dragleave', () => a.classList.remove('drop-hover'));
  a.addEventListener('drop', async (e) => {
    a.classList.remove('drop-hover');
    const id = list.dragId;
    if (!id) return;
    e.preventDefault();
    list.dragId = null;
    if (view === 'today') await ops.patch(id, { date: today() });
    else {
      const r = await ops.setProject(id, view === 'inbox' ? 'inbox' : view.slice(8));
      toast(`Moved to ${label}`, { label: 'Undo', run: r.undo });
    }
  });
  return h('li', a);
}

function renderNav() {
  const t = today();
  const c = counts(state.tasks, t);
  const perView = { inbox: c.inbox, today: c.today + c.overdue, overdue: c.overdue };
  $('nav-main').replaceChildren(...MAIN.map((m) => navLink(m.view, m.name, [icon(m.icon, 16)], perView[m.view] || 0, m.view === 'overdue')));

  const open = state.tasks.filter((x) => !x.done && !x.parentId);
  $('nav-projects').replaceChildren(...state.projects.filter((p) => p.id !== 'inbox').map((p) => {
    const li = navLink('project:' + p.id, p.name, [h('span.dot', { style: { background: p.color } })], open.filter((x) => x.projectId === p.id).length);
    li.append(h('button.icon-btn.proj-edit', { type: 'button', 'aria-label': `Edit project ${p.name}`, onclick: () => projectDialog(p) }, icon('more', 16)));
    return li;
  }));
  const labels = allLabels(state.tasks).filter((l) => l.count > 0 || state.view === 'label:' + l.name);
  $('labels-head').hidden = !labels.length;
  $('nav-labels').replaceChildren(...labels.map((l) => navLink('label:' + l.name, '@' + l.name, [icon('tag', 16)], l.count)));
}

function render() {
  applyTheme(state.settings.theme);
  list.setData({ tasks: state.tasks, projects: state.projects, h24: state.settings.h24 });
  list.render(state.view, state.query);
  $('view-title').textContent = viewTitle();
  document.title = `${viewTitle()} · Tasks`;
  $('view-sub').textContent = state.view === 'today' ? longLabel(today()) : '';
  renderNav();
  const foot = $('list-foot');
  foot.replaceChildren();
  if (state.view === 'completed' && state.tasks.some((t) => t.done)) {
    foot.append(h('button.btn.small', { type: 'button', onclick: async () => {
      const r = await ops.clearCompleted();
      toast('Cleared completed tasks', { label: 'Undo', run: r.undo });
    } }, 'Clear completed'));
  }
}

async function edit(id) {
  await openEditor(id, { tasks: state.tasks, projects: state.projects, h24: state.settings.h24 });
  list.focusRow(id);
}

// ---------------------------------------------------------------- projects

function projectDialog(project) {
  const dlg = $('project-dialog');
  $('pd-title').textContent = project ? 'Edit project' : 'New project';
  $('pd-name').value = project ? project.name : '';
  $('pd-color').value = project ? project.color : ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'][state.projects.length % 6];
  $('pd-delete').hidden = !project;
  $('pd-delete').onclick = async () => {
    dlg.close('cancel');
    await ops.deleteProject(project.id);
    toast(`Deleted ${project.name}. Its tasks moved to the Inbox.`);
    if (state.view === 'project:' + project.id) go('inbox');
  };
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const name = $('pd-name').value.trim();
    if (!name) return;
    if (project) await ops.renameProject(project.id, name, $('pd-color').value);
    else {
      const p = await ops.addProject(name, $('pd-color').value);
      go('project:' + p.id);
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}
$('add-project').addEventListener('click', () => projectDialog(null));

// ---------------------------------------------------------------- sidebar (narrow screens)

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('menu-btn').setAttribute('aria-expanded', 'false');
}
$('menu-btn').addEventListener('click', () => {
  const open = !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', open);
  $('menu-btn').setAttribute('aria-expanded', String(open));
});

// ---------------------------------------------------------------- inputs

wireQuickAdd($('quick-add'), $('qa-hint'), quickAddDefaults, (task) => list.select(task.id));
const runSearch = debounce((q) => go('search', q), 150);
$('search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (q) runSearch(q);
  else go(lastNonSearch);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; go(lastNonSearch); e.target.blur(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); list.moveSelection(1); }
});
$('open-shortcuts').addEventListener('click', () => $('shortcuts').showModal());
$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------- keyboard

let pendingG = 0;
document.addEventListener('keydown', async (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (isTyping(e) || e.ctrlKey || e.metaKey) return;
  const sel = list.selectedId;
  const key = e.key;
  if (pendingG && Date.now() - pendingG < 1200) {
    pendingG = 0;
    const m = MAIN.find((x) => x.key === key);
    if (m) { e.preventDefault(); go(m.view); }
    return;
  }
  if (key === 'g') { pendingG = Date.now(); return; }
  if (key === 'q' || key === 'n') { e.preventDefault(); $('quick-add').focus(); return; }
  if (key === '/') { e.preventDefault(); $('search').focus(); return; }
  if (key === '?') { e.preventDefault(); $('shortcuts').showModal(); return; }
  if (key === 'Escape') { list.select(null); document.activeElement?.blur(); return; }
  if (key === 'j' || (key === 'ArrowDown' && !e.altKey)) { e.preventDefault(); list.moveSelection(1); return; }
  if (key === 'k' || (key === 'ArrowUp' && !e.altKey)) { e.preventDefault(); list.moveSelection(-1); return; }
  if (!sel) return;
  const task = state.tasks.find((t) => t.id === sel);
  if (!task) return;
  if (key === 'x' || key === ' ') {
    e.preventDefault();
    const ids = list.visibleIds();
    const next = ids[ids.indexOf(sel) + 1] || ids[ids.indexOf(sel) - 1] || null;
    const r = await toggleWithUndo(sel);
    if (r.completed && !r.rolledTo && state.view !== 'completed' && state.view !== 'search') list.select(next, true);
  } else if (key === 'Enter' || key === 'e') { e.preventDefault(); edit(sel); }
  else if (key === 'Delete' || key === 'Backspace') {
    e.preventDefault();
    const ids = list.visibleIds();
    const next = ids[ids.indexOf(sel) + 1] || ids[ids.indexOf(sel) - 1] || null;
    await removeWithUndo(sel);
    list.select(next, true);
  } else if (/^[1-4]$/.test(key)) { await ops.patch(sel, { priority: +key }); }
  else if (key === 't') { await ops.patch(sel, { date: today() }); toast('Due today'); }
  else if (key === 'm') { await ops.patch(sel, { date: addDays(today(), 1) }); toast('Due tomorrow'); }
  else if (key === '0') { await ops.patch(sel, { date: null, time: null, recur: null }); toast('Date removed'); }
  else if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    e.preventDefault();
    await ops.nudge(sel, list.siblingIds(sel), key === 'ArrowUp' ? -1 : 1);
  }
});

// ---------------------------------------------------------------- data

async function load() {
  await store.ensureDefaults();
  const d = await store.getMany(['tasks', 'projects', 'settings']);
  Object.assign(state, d);
  Object.assign(state, parseHash());
  if (state.view === 'search') $('search').value = state.query;
  render();
  const want = new URLSearchParams(location.search).get('task');
  if (want && state.tasks.some((t) => t.id === want)) {
    const t = state.tasks.find((x) => x.id === want);
    if (!buildView(state.tasks, state.view, today(), { projects: state.projects }).some((s) => s.tasks.some((x) => x.id === want))) {
      go(t.parentId ? 'project:' + t.projectId : (t.projectId === 'inbox' ? 'inbox' : 'project:' + t.projectId));
    }
    list.select(want, true);
    edit(want);
  } else if (new URLSearchParams(location.search).has('add')) {
    $('quick-add').focus();
  }
}

store.watch(['tasks', 'projects', 'settings'], (vals) => {
  Object.assign(state, vals);
  render();
});
window.addEventListener('hashchange', () => {
  const p = parseHash();
  state.view = p.view;
  state.query = p.query;
  $('search').value = p.view === 'search' ? p.query : '';
  if (p.view !== 'search') lastNonSearch = p.view;
  render();
});
// Re-render when the day changes so Today/Overdue stay right.
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { lastDay = today(); render(); } }, 60000);
load();
