// Storage-backed task operations used by every page. Each mutation re-reads the latest
// tasks (store.update) and returns an `undo` function that restores only the tasks it touched.
import * as store from './store.js';
import { parseTask } from './nlp.js';
import { ymd } from './dates.js';
import {
  makeTask, normalizeTask, toggleComplete, removeTask, moveTask, ensureProject, childrenOf,
} from './tasks.js';

/** Apply fn(tasks) -> tasks and return an undo that puts back the previous versions of changed tasks. */
export async function mutate(fn) {
  let before = [];
  let after = [];
  await store.update('tasks', async (tasks) => {
    before = tasks;
    after = await fn(tasks);
    return after;
  });
  const prev = new Map(before.map((t) => [t.id, t]));
  const next = new Map(after.map((t) => [t.id, t]));
  const changed = [];
  for (const [id, t] of prev) if (next.get(id) !== t) changed.push(id);
  const added = [...next.keys()].filter((id) => !prev.has(id));
  const undo = async () => {
    await store.update('tasks', (tasks) => {
      const out = tasks.filter((t) => !added.includes(t.id) && !changed.includes(t.id));
      for (const id of changed) out.push(prev.get(id));
      return out;
    });
  };
  return { before, after, undo };
}

async function resolveProject(name) {
  let id = 'inbox';
  await store.update('projects', (list) => {
    const r = ensureProject(list, name, () => store.uid('p'));
    id = r.project.id;
    return r.projects;
  });
  return id;
}

/**
 * Add a task from natural-language text. `defaults` may set projectId, parentId, date, priority.
 * Returns the created task, or null when the text has no title.
 */
export async function addFromText(text, defaults = {}) {
  const p = parseTask(text, new Date());
  if (!p.title) return null;
  const projectId = p.project ? await resolveProject(p.project) : (defaults.projectId || 'inbox');
  const task = normalizeTask(makeTask({
    title: p.title,
    projectId,
    parentId: defaults.parentId || null,
    priority: p.priority < 4 ? p.priority : (defaults.priority || 4),
    labels: [...new Set([...(defaults.labels || []), ...p.labels])],
    date: p.date || defaults.date || null,
    time: p.time,
    recur: p.recur,
  }, store.uid('t')));
  if (task.parentId) {
    // Subtasks live in their parent's project.
    const tasks = await store.get('tasks');
    const parent = tasks.find((t) => t.id === task.parentId);
    if (parent) task.projectId = parent.projectId;
  }
  const r = await mutate((tasks) => [...tasks, task]);
  return { task, undo: r.undo };
}

export async function toggle(id) {
  let rolledTo = null;
  let wasDone = false;
  const r = await mutate((tasks) => {
    const t = tasks.find((x) => x.id === id);
    wasDone = !!(t && t.done);
    const res = toggleComplete(tasks, id, ymd(new Date()));
    rolledTo = res.rolledTo;
    return res.tasks;
  });
  return { ...r, rolledTo, completed: !wasDone };
}

export async function patch(id, fields) {
  return mutate((tasks) => tasks.map((t) => (t.id === id ? normalizeTask({ ...t, ...fields }) : t)));
}

export async function remove(id) {
  return mutate((tasks) => removeTask(tasks, id));
}

/** Reorder: move `id` before `beforeId` among `siblingIds` (ordered), optionally patching fields. */
export async function move(id, siblingIds, beforeId, fields = {}) {
  return mutate((tasks) => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const siblings = siblingIds.map((x) => byId.get(x)).filter(Boolean);
    const moved = moveTask(tasks, id, siblings, beforeId, fields);
    return moved.map((t) => (t.id === id ? normalizeTask(t) : t));
  });
}

/** Move a task one step up or down among its visible siblings. */
export async function nudge(id, siblingIds, dir) {
  const i = siblingIds.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= siblingIds.length) return null;
  const before = dir < 0 ? siblingIds[j] : siblingIds[j + 1] || null;
  return move(id, siblingIds, before);
}

export async function setProject(id, projectId) {
  return mutate((tasks) => {
    const kids = new Set();
    const walk = (pid) => { for (const c of childrenOf(tasks, pid)) { kids.add(c.id); walk(c.id); } };
    walk(id);
    return tasks.map((t) => {
      if (t.id === id) return { ...t, projectId, parentId: null };
      if (kids.has(t.id)) return { ...t, projectId };
      return t;
    });
  });
}

export async function clearCompleted() {
  return mutate((tasks) => {
    const doneIds = new Set(tasks.filter((t) => t.done).map((t) => t.id));
    // Keep a completed task if it still has open descendants.
    return tasks.filter((t) => !doneIds.has(t.id) || tasks.some((c) => c.parentId === t.id && !c.done));
  });
}

export async function addProject(name, color) {
  let project = null;
  await store.update('projects', (list) => {
    const r = ensureProject(list, name, () => store.uid('p'));
    project = r.project;
    if (color && !list.includes(project)) project.color = color;
    return r.projects;
  });
  return project;
}

export async function renameProject(id, name, color) {
  await store.update('projects', (list) => list.map((p) => (p.id === id ? { ...p, name: name || p.name, color: color || p.color } : p)));
}

/** Delete a project; its tasks move to the Inbox. */
export async function deleteProject(id) {
  if (id === 'inbox') return;
  await store.update('projects', (list) => list.filter((p) => p.id !== id));
  await mutate((tasks) => tasks.map((t) => (t.projectId === id ? { ...t, projectId: 'inbox' } : t)));
}
