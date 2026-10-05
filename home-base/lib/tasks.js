// Pure task logic shared by the popup, the new tab widget, the full tasks page and
// the service worker. No browser APIs, so node:test can cover it.
import { addDays, diffDays, isYmd } from './dates.js';
import { nextOccurrence } from './nlp.js';

export const PRIORITY_NAMES = { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'No priority' };

export function makeTask(fields = {}, id) {
  const now = Date.now();
  return {
    id,
    title: '',
    notes: '',
    projectId: 'inbox',
    priority: 4,
    labels: [],
    date: null,
    time: null,
    recur: null,
    parentId: null,
    done: false,
    doneAt: null,
    order: now,
    createdAt: now,
    completions: 0,
    collapsed: false,
    ...fields,
  };
}

/** Tidy a task that may come from user input or an import. */
export function normalizeTask(t) {
  const out = makeTask(t, t.id);
  out.title = String(out.title || '').slice(0, 500);
  out.notes = String(out.notes || '');
  out.priority = [1, 2, 3, 4].includes(+out.priority) ? +out.priority : 4;
  out.labels = Array.isArray(out.labels) ? [...new Set(out.labels.map((l) => String(l).toLowerCase().trim()).filter(Boolean))] : [];
  if (!isYmd(out.date)) out.date = null;
  if (!out.date || !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.time || '')) out.time = null;
  if (!out.date) out.recur = null;
  return out;
}

export const byOrder = (a, b) => (a.order - b.order) || (a.createdAt - b.createdAt);

export function childrenOf(tasks, id) {
  return tasks.filter((t) => t.parentId === id).sort(byOrder);
}

/** Ids of a task and all of its descendants. */
export function subtreeIds(tasks, id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) { ids.add(t.id); grew = true; }
    }
  }
  return ids;
}

export function isOverdue(t, today) {
  return !t.done && !!t.date && diffDays(today, t.date) < 0;
}

export function isDueToday(t, today) {
  return !t.done && t.date === today;
}

export function counts(tasks, today) {
  let today_ = 0, overdue = 0, upcoming = 0, inbox = 0;
  for (const t of tasks) {
    if (t.done) continue;
    if (t.date === today) today_++;
    else if (t.date && t.date < today) overdue++;
    else if (t.date) upcoming++;
    if (t.projectId === 'inbox' && !t.parentId) inbox++;
  }
  return { today: today_, overdue, upcoming, inbox, badge: today_ + overdue };
}

function matchesQuery(t, q) {
  if (!q) return true;
  const hay = `${t.title} ${t.notes} ${t.labels.map((l) => '@' + l).join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Build the sections for a view.
 * view: today | upcoming | overdue | inbox | all | completed | search | project:<id> | label:<name>
 * Returns [{ key, title, date?, tasks: [rootTask...] }]. Subtasks are rendered by the UI under
 * their parent via childrenOf(); a subtask whose parent is not shown appears as a root.
 */
export function buildView(tasks, view, today, { query = '', projects = [] } = {}) {
  const open = tasks.filter((t) => !t.done);
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const pick = (pred) => {
    const hits = open.filter(pred);
    const ids = new Set(hits.map((t) => t.id));
    // keep only roots: a hit whose ancestor is also a hit is rendered under that ancestor
    return hits.filter((t) => !t.parentId || !ancestorIn(byId, t, ids));
  };
  const byDateThenOrder = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99') || byOrder(a, b);
  const sortSection = (list, dated) => list.sort(dated ? byDateThenOrder : byOrder);

  if (view === 'today') {
    const overdue = pick((t) => t.date && t.date < today);
    const due = pick((t) => t.date === today);
    const out = [];
    if (overdue.length) out.push({ key: 'overdue', title: 'Overdue', tasks: sortSection(overdue, true) });
    out.push({ key: today, title: 'Today', date: today, tasks: due.sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || byOrder(a, b)) });
    return out;
  }
  if (view === 'overdue') {
    return [{ key: 'overdue', title: 'Overdue', tasks: sortSection(pick((t) => t.date && t.date < today), true) }];
  }
  if (view === 'upcoming') {
    const list = pick((t) => t.date && t.date > today);
    const groups = new Map();
    // Always show the next 7 days, even when empty, so tasks can be dropped onto them.
    for (let i = 1; i <= 7; i++) { const d = addDays(today, i); groups.set(d, []); }
    for (const t of list) {
      const key = diffDays(today, t.date) <= 30 ? t.date : 'later';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const keys = [...groups.keys()].filter((k) => k !== 'later').sort();
    if (groups.has('later')) keys.push('later');
    return keys.map((k) => ({
      key: k,
      title: k === 'later' ? 'Later' : null,
      date: k === 'later' ? null : k,
      tasks: groups.get(k).sort(k === 'later' ? byDateThenOrder : (a, b) => (a.time || '99').localeCompare(b.time || '99') || byOrder(a, b)),
    }));
  }
  if (view === 'completed') {
    const done = tasks.filter((t) => t.done && matchesQuery(t, query)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    return [{ key: 'completed', title: 'Completed', tasks: done, flat: true }];
  }
  if (view === 'search') {
    const hits = tasks.filter((t) => matchesQuery(t, query)).sort((a, b) => (a.done - b.done) || byDateThenOrder(a, b));
    return [{ key: 'search', title: query ? `Results for “${query}”` : 'Search', tasks: query ? hits : [], flat: true }];
  }
  if (view === 'all') {
    return projects.map((p) => ({
      key: 'p:' + p.id, title: p.name, projectId: p.id,
      tasks: sortSection(pick((t) => t.projectId === p.id && !t.parentId), false),
    })).filter((s) => s.tasks.length);
  }
  if (view.startsWith('label:')) {
    const label = view.slice(6);
    return [{ key: view, title: '@' + label, tasks: sortSection(pick((t) => t.labels.includes(label)), true) }];
  }
  const projectId = view === 'inbox' ? 'inbox' : view.startsWith('project:') ? view.slice(8) : 'inbox';
  return [{ key: 'p:' + projectId, projectId, title: null, tasks: sortSection(pick((t) => t.projectId === projectId && !t.parentId), false) }];
}

function ancestorIn(byId, t, ids) {
  let p = t.parentId;
  let guard = 0;
  while (p && guard++ < 50) {
    if (ids.has(p)) return true;
    p = byId.get(p) && byId.get(p).parentId;
  }
  return false;
}

/**
 * Complete (or reopen) a task. Recurring tasks roll forward to their next occurrence on or
 * after today instead of being marked done. Completing a parent completes its subtasks.
 * Returns { tasks, rolledTo } where rolledTo is the new date of a recurring task.
 */
export function toggleComplete(tasks, id, today, now = Date.now()) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return { tasks, rolledTo: null };
  if (t.done) {
    return { tasks: tasks.map((x) => (x.id === id ? { ...x, done: false, doneAt: null } : x)), rolledTo: null };
  }
  if (t.recur && t.date) {
    let next = nextOccurrence(t.recur, t.date, t.recur.anchor || t.date);
    let guard = 0;
    while (next && next < today && guard++ < 5000) next = nextOccurrence(t.recur, next, t.recur.anchor || t.date);
    if (next) {
      const kids = subtreeIds(tasks, id);
      return {
        tasks: tasks.map((x) => {
          if (x.id === id) return { ...x, date: next, completions: (x.completions || 0) + 1, lastDoneAt: now };
          if (kids.has(x.id)) return { ...x, done: false, doneAt: null };
          return x;
        }),
        rolledTo: next,
      };
    }
  }
  const ids = subtreeIds(tasks, id);
  return {
    tasks: tasks.map((x) => (ids.has(x.id) && !x.done ? { ...x, done: true, doneAt: now } : x)),
    rolledTo: null,
  };
}

/** Remove a task and its subtasks. */
export function removeTask(tasks, id) {
  const ids = subtreeIds(tasks, id);
  return tasks.filter((t) => !ids.has(t.id));
}

/**
 * Move `id` so it sits just before `beforeId` (or at the end of `siblings` when beforeId is null).
 * `siblings` is the ordered list of tasks the drop happened in. Only `order` (and optional patch) change.
 */
export function moveTask(tasks, id, siblings, beforeId, patch = {}) {
  const list = siblings.filter((t) => t.id !== id);
  const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : list.length;
  const at = idx < 0 ? list.length : idx;
  const prev = list[at - 1];
  const next = list[at];
  let order;
  if (prev && next) order = (prev.order + next.order) / 2;
  else if (prev) order = prev.order + 1024;
  else if (next) order = next.order - 1024;
  else order = Date.now();
  // Fractional orders eventually lose precision; renumber the siblings when they get too close.
  if (prev && next && Math.abs(next.order - prev.order) < 1e-6) {
    const ordered = [...list.slice(0, at), { id }, ...list.slice(at)];
    const map = new Map(ordered.map((t, i) => [t.id, (i + 1) * 1024]));
    return tasks.map((t) => (map.has(t.id) ? { ...t, ...(t.id === id ? patch : {}), order: map.get(t.id) } : t));
  }
  return tasks.map((t) => (t.id === id ? { ...t, ...patch, order } : t));
}

/** Find a project by name (case-insensitive) or create one. Returns { projects, project }. */
export function ensureProject(projects, name, makeId) {
  const n = String(name || '').trim();
  if (!n) return { projects, project: projects.find((p) => p.id === 'inbox') };
  const found = projects.find((p) => p.name.toLowerCase() === n.toLowerCase() || p.id === n.toLowerCase());
  if (found) return { projects, project: found };
  const palette = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#84cc16'];
  const project = { id: makeId(), name: n[0].toUpperCase() + n.slice(1), color: palette[projects.length % palette.length] };
  return { projects: [...projects, project], project };
}

export function allLabels(tasks) {
  const set = new Map();
  for (const t of tasks) for (const l of t.labels || []) set.set(l, (set.get(l) || 0) + (t.done ? 0 : 1));
  return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
}

/** When a reminder for task t should fire (ms epoch) or null. */
export function reminderTime(t, offsetMin = 0) {
  if (t.done || !t.date || !t.time) return null;
  const [y, m, d] = t.date.split('-').map(Number);
  const [hh, mm] = t.time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime() - offsetMin * 60000;
}
