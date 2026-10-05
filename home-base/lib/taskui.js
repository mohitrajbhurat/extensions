// Task list rendering + editor dialog, shared by the tasks page, the new tab widget and the popup.
import { h, icon, toast, confirmDialog } from './ui.js';
import { buildView, childrenOf, isOverdue, subtreeIds, byOrder, PRIORITY_NAMES } from './tasks.js';
import { ymd, relativeLabel, formatTime, longLabel, parseYmd, WEEKDAY_SHORT, MONTH_SHORT } from './dates.js';
import { describeRecur, parseDateText, firstOccurrence } from './nlp.js';
import { inline, renderMarkdown } from './markdown.js';
import * as ops from './taskops.js';

const today = () => ymd(new Date());

/** Toggle with a toast that offers Undo. */
export async function toggleWithUndo(id) {
  const r = await ops.toggle(id);
  if (r.rolledTo) toast(`Done. Next one ${relativeLabel(r.rolledTo, today()).toLowerCase()}`, { label: 'Undo', run: r.undo });
  else if (r.completed) toast('Task completed', { label: 'Undo', run: r.undo });
  return r;
}

export async function removeWithUndo(id) {
  const r = await ops.remove(id);
  const n = r.before.length - r.after.length;
  toast(n > 1 ? `Deleted task and ${n - 1} subtask${n > 2 ? 's' : ''}` : 'Task deleted', { label: 'Undo', run: r.undo });
  return r;
}

export class TaskView {
  /**
   * @param {HTMLElement} root
   * @param {{compact?:boolean, showProject?:boolean, onOpen?:(id:string)=>void, emptyText?:string}} opts
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.tasks = [];
    this.projects = [];
    this.view = 'today';
    this.query = '';
    this.selectedId = null;
    this.dragId = null;
    root.classList.add('task-view');
    if (opts.compact) root.classList.add('compact');
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('dblclick', (e) => {
      const li = e.target.closest('li.task');
      if (li && !e.target.closest('button, a, input')) this.open(li.dataset.id);
    });
    root.addEventListener('keydown', (e) => this.onKey(e));
    this.wireDrag();
  }

  setData({ tasks, projects, h24 }) {
    if (tasks) this.tasks = tasks;
    if (projects) this.projects = projects;
    if (h24 !== undefined) this.h24 = h24;
  }

  open(id) {
    if (this.opts.onOpen) this.opts.onOpen(id);
  }

  projectOf(id) {
    return this.projects.find((p) => p.id === id);
  }

  render(view = this.view, query = this.query) {
    this.view = view;
    this.query = query;
    const t = today();
    const sections = buildView(this.tasks, view, t, { query, projects: this.projects });
    const focusedId = document.activeElement && this.root.contains(document.activeElement)
      ? document.activeElement.closest('li.task')?.dataset.id : null;
    const frag = document.createDocumentFragment();
    let total = 0;
    for (const s of sections) {
      total += s.tasks.length;
      const isUpcomingDay = view === 'upcoming' && s.date;
      if (isUpcomingDay && !s.tasks.length && this.opts.compact) continue;
      const sec = h('section.task-section', { dataset: { key: s.key } });
      const title = s.title || (s.date ? this.dateHeading(s.date, t) : null);
      if (title && !(this.opts.compact && sections.length === 1)) {
        sec.append(h('h3.section-title', title, s.tasks.length && !s.flat ? h('span.count', String(s.tasks.length)) : null));
      }
      const ul = h('ul.task-list', { role: 'list', dataset: { date: s.date || '', flat: s.flat ? '1' : '', project: s.projectId || '' } });
      for (const task of s.tasks) ul.append(this.row(task, t, !!s.flat));
      if (isUpcomingDay && !s.tasks.length) ul.classList.add('empty-day');
      sec.append(ul);
      frag.append(sec);
    }
    this.root.replaceChildren(frag);
    if (!total) {
      this.root.append(h('div.empty', this.opts.emptyText || this.defaultEmpty(view, query)));
    }
    if (this.selectedId && !this.root.querySelector(`li.task[data-id="${CSS.escape(this.selectedId)}"]`)) this.selectedId = null;
    this.paintSelection();
    if (focusedId) this.focusRow(focusedId, false);
  }

  defaultEmpty(view, query) {
    if (view === 'search') return query ? 'No tasks match.' : 'Type to search tasks, notes and @labels.';
    if (view === 'today') return 'Nothing due today. Enjoy the space.';
    if (view === 'overdue') return 'Nothing overdue. Nicely kept.';
    if (view === 'completed') return 'No completed tasks yet.';
    if (view === 'upcoming') return 'Nothing scheduled.';
    return 'No tasks here yet.';
  }

  dateHeading(date, t) {
    const d = parseYmd(date);
    const rel = relativeLabel(date, t);
    const base = `${WEEKDAY_SHORT[d.getDay()]} ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
    return rel === 'Today' || rel === 'Tomorrow' ? `${base} · ${rel}` : base;
  }

  row(task, t, flat) {
    const kids = flat ? [] : childrenOf(this.tasks, task.id);
    const openKids = kids.filter((k) => !k.done);
    const overdue = isOverdue(task, t);
    const li = h('li.task', {
      dataset: { id: task.id },
      draggable: !flat && !task.done ? 'true' : null,
      class: `task${task.done ? ' done' : ''} prio-${task.priority}`,
    });
    const check = h('button.check', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': String(task.done),
      'aria-label': `${task.done ? 'Reopen' : 'Complete'}: ${task.title}`,
      title: PRIORITY_NAMES[task.priority],
      dataset: { act: 'toggle' },
    }, icon('check', 12));
    const toggleKids = openKids.length
      ? h('button.twisty', {
        type: 'button', dataset: { act: 'collapse' },
        'aria-expanded': String(!task.collapsed),
        'aria-label': task.collapsed ? 'Show subtasks' : 'Hide subtasks',
      }, icon(task.collapsed ? 'chevronR' : 'chevronD', 14))
      : h('span.twisty-space');

    const meta = h('div.task-meta');
    if (task.date) {
      const label = relativeLabel(task.date, t) + (task.time ? ' ' + formatTime(task.time, this.h24) : '');
      const cls = overdue ? 'chip date overdue' : task.date === t ? 'chip date today' : 'chip date';
      meta.append(h('span', { class: cls, title: longLabel(task.date) }, icon('calendar', 12), label));
    }
    if (task.recur) meta.append(h('span.chip', { title: 'Repeats' }, icon('repeat', 12), describeRecur(task.recur)));
    if (kids.length) {
      const done = kids.filter((k) => k.done).length;
      meta.append(h('span.chip', { title: 'Subtasks done' }, icon('list', 12), `${done}/${kids.length}`));
    }
    if (task.notes) meta.append(h('span.chip', { title: 'Has notes' }, icon('note', 12)));
    for (const l of task.labels) meta.append(h('button.chip.label', { type: 'button', dataset: { act: 'label', label: l } }, '@' + l));
    const showProject = this.opts.showProject !== false && !task.parentId &&
      !(this.view === 'inbox' || this.view.startsWith('project:'));
    if (showProject) {
      const p = this.projectOf(task.projectId);
      if (p && !(p.id === 'inbox' && this.opts.compact)) {
        meta.append(h('span.chip.project', h('span.dot', { style: { background: p.color } }), p.name));
      }
    }

    const titleEl = h('div.task-title');
    titleEl.innerHTML = inline(task.title); // inline() escapes everything first
    const main = h('div.task-main', titleEl, meta.childNodes.length ? meta : null);
    const actions = h('div.task-actions',
      h('button.icon-btn', { type: 'button', dataset: { act: 'edit' }, 'aria-label': 'Edit task', title: 'Edit (Enter)' }, icon('edit', 16)),
      h('button.icon-btn', { type: 'button', dataset: { act: 'delete' }, 'aria-label': 'Delete task', title: 'Delete (Del)' }, icon('trash', 16)));
    li.append(h('div.task-row', { tabindex: '0' }, toggleKids, check, main, actions));
    if (openKids.length && !task.collapsed) {
      const ul = h('ul.task-list.subtasks', { role: 'list', dataset: { parent: task.id } });
      for (const k of openKids.sort(byOrder)) ul.append(this.row(k, t, false));
      li.append(ul);
    }
    return li;
  }

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    const li = e.target.closest('li.task');
    if (li && !btn && !e.target.closest('a')) this.select(li.dataset.id);
    if (!btn || !li) return;
    const id = li.dataset.id;
    const act = btn.dataset.act;
    if (act === 'toggle') {
      if (!li.classList.contains('done')) li.classList.add('completing');
      await toggleWithUndo(id);
    } else if (act === 'edit') this.open(id);
    else if (act === 'delete') await removeWithUndo(id);
    else if (act === 'collapse') {
      const task = this.tasks.find((x) => x.id === id);
      await ops.patch(id, { collapsed: !task.collapsed });
    } else if (act === 'label' && this.opts.onLabel) this.opts.onLabel(btn.dataset.label);
  }

  onKey(e) {
    if (e.target.matches('.task-row') && (e.key === 'Enter') && !e.altKey) {
      e.preventDefault();
      this.open(e.target.closest('li.task').dataset.id);
    }
    if (this.opts.compact && e.target.matches('.task-row')) {
      if (e.key === ' ' || e.key === 'x') { e.preventDefault(); toggleWithUndo(e.target.closest('li.task').dataset.id); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    }
  }

  // ---- selection (used by keyboard shortcuts)
  visibleIds() {
    return [...this.root.querySelectorAll('li.task')].map((li) => li.dataset.id);
  }

  select(id, focus = false) {
    this.selectedId = id;
    this.paintSelection();
    if (focus && id) this.focusRow(id);
  }

  focusRow(id, scroll = true) {
    const row = this.root.querySelector(`li.task[data-id="${CSS.escape(id)}"] > .task-row`);
    if (row) { row.focus({ preventScroll: !scroll }); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
  }

  paintSelection() {
    for (const li of this.root.querySelectorAll('li.task.selected')) li.classList.remove('selected');
    if (!this.selectedId) return;
    const li = this.root.querySelector(`li.task[data-id="${CSS.escape(this.selectedId)}"]`);
    if (li) li.classList.add('selected');
  }

  moveSelection(dir) {
    const ids = this.visibleIds();
    if (!ids.length) return;
    let i = ids.indexOf(this.selectedId);
    i = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + dir));
    this.select(ids[i], true);
  }

  /** Ids of the selected task's siblings as rendered (for keyboard reorder). */
  siblingIds(id) {
    const li = this.root.querySelector(`li.task[data-id="${CSS.escape(id)}"]`);
    if (!li) return [];
    return [...li.parentElement.children].filter((x) => x.matches('li.task')).map((x) => x.dataset.id);
  }

  // ---- drag and drop reordering
  wireDrag() {
    const root = this.root;
    let marker = null;
    const clear = () => {
      if (marker) marker.classList.remove('drop-before', 'drop-after', 'drop-into');
      for (const ul of root.querySelectorAll('.drop-target')) ul.classList.remove('drop-target');
      marker = null;
    };
    root.addEventListener('dragstart', (e) => {
      const li = e.target.closest && e.target.closest('li.task[draggable="true"]');
      if (!li) return;
      this.dragId = li.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-home-base-task', li.dataset.id);
      e.dataTransfer.setData('text/plain', li.querySelector('.task-title').textContent);
      requestAnimationFrame(() => li.classList.add('dragging'));
    });
    root.addEventListener('dragend', (e) => {
      const li = e.target.closest && e.target.closest('li.task');
      if (li) li.classList.remove('dragging');
      this.dragId = null;
      clear();
    });
    root.addEventListener('dragover', (e) => {
      if (!this.dragId) return;
      const target = this.dropTarget(e);
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clear();
      if (target.li) {
        marker = target.li;
        marker.classList.add(target.after ? 'drop-after' : 'drop-before');
      } else target.ul.classList.add('drop-target');
    });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) clear(); });
    root.addEventListener('drop', async (e) => {
      if (!this.dragId) return;
      const target = this.dropTarget(e);
      clear();
      if (!target) return;
      e.preventDefault();
      const id = this.dragId;
      this.dragId = null;
      const ul = target.ul;
      const siblingIds = [...ul.children].filter((x) => x.matches('li.task')).map((x) => x.dataset.id);
      let beforeId = null;
      if (target.li) {
        const i = siblingIds.indexOf(target.li.dataset.id);
        beforeId = target.after ? siblingIds[i + 1] || null : siblingIds[i];
      }
      if (beforeId === id) return;
      const fields = {};
      const parent = ul.dataset.parent || null;
      const task = this.tasks.find((x) => x.id === id);
      if (!task) return;
      if (parent !== (task.parentId || null)) {
        if (parent && subtreeIds(this.tasks, id).has(parent)) return; // cannot drop into own subtree
        fields.parentId = parent;
        if (parent) fields.projectId = this.tasks.find((x) => x.id === parent)?.projectId || task.projectId;
      }
      if (ul.dataset.date && ul.dataset.date !== task.date) {
        fields.date = ul.dataset.date;
        if (task.recur) fields.recur = { ...task.recur, anchor: ul.dataset.date };
      }
      if (ul.dataset.project && ul.dataset.project !== task.projectId && !parent) fields.projectId = ul.dataset.project;
      await ops.move(id, siblingIds.filter((x) => x !== id), beforeId, fields);
    });
  }

  dropTarget(e) {
    const li = e.target.closest('li.task');
    if (li && this.root.contains(li)) {
      if (li.dataset.id === this.dragId || li.closest('li.dragging')) return null;
      const ul = li.parentElement;
      if (ul.dataset.flat) return null;
      const rowRect = li.querySelector('.task-row').getBoundingClientRect();
      const after = e.clientY > rowRect.top + rowRect.height / 2;
      return { ul, li, after };
    }
    const ul = e.target.closest('ul.task-list');
    if (ul && !ul.dataset.flat && this.root.contains(ul)) return { ul, li: null };
    const sec = e.target.closest('.task-section');
    if (sec) {
      const top = sec.querySelector(':scope > ul.task-list');
      if (top && !top.dataset.flat) return { ul: top, li: null };
    }
    return null;
  }
}

// ---------------------------------------------------------------- editor

/**
 * Open the task editor dialog. Resolves when it closes.
 * @param {string} id
 * @param {{tasks:Array, projects:Array, h24:boolean}} ctx
 */
export function openEditor(id, ctx) {
  const task = ctx.tasks.find((t) => t.id === id);
  if (!task) return Promise.resolve();
  return new Promise((resolve) => {
    const t = today();
    const title = h('input.input', { type: 'text', value: task.title, required: true, 'aria-label': 'Title', maxlength: '500' });
    const notes = h('textarea.input', { rows: '3', placeholder: 'Notes (Markdown)', 'aria-label': 'Notes' });
    notes.value = task.notes || '';
    const date = h('input.input', { type: 'date', value: task.date || '' });
    const time = h('input.input', { type: 'time', value: task.time || '' });
    const originalRecur = task.recur ? describeRecur(task.recur) : '';
    const repeat = h('input.input', { type: 'text', value: originalRecur, placeholder: 'e.g. every monday, every 2 weeks, monthly' });
    const repeatHint = h('div.small.muted', { 'aria-live': 'polite' });
    const smart = h('input.input', { type: 'text', placeholder: 'Type “next fri 3pm”, “in 2 weeks”, “every weekday”…' });
    const smartHint = h('div.small.muted', { 'aria-live': 'polite' });
    const priority = h('select.input', { 'aria-label': 'Priority' },
      [1, 2, 3, 4].map((p) => h('option', { value: String(p), selected: task.priority === p }, PRIORITY_NAMES[p])));
    const project = h('select.input', { 'aria-label': 'Project', disabled: !!task.parentId },
      ctx.projects.map((p) => h('option', { value: p.id, selected: task.projectId === p.id }, p.name)));
    const labels = h('input.input', { type: 'text', value: task.labels.join(', '), placeholder: 'comma, separated' });

    const updateRepeatHint = () => {
      const v = repeat.value.trim();
      if (!v) { repeatHint.textContent = 'Does not repeat.'; return; }
      if (v === originalRecur) { repeatHint.textContent = `Repeats ${originalRecur}.`; return; }
      const r = parseDateText(/^every|daily|weekly|monthly|yearly|annually|fortnightly|biweekly|quarterly/i.test(v) ? v : 'every ' + v, t);
      repeatHint.textContent = r.recur ? `Repeats ${describeRecur(r.recur)}.` : 'Not understood. Try “every tuesday” or “every 3 days”.';
    };
    repeat.addEventListener('input', updateRepeatHint);
    updateRepeatHint();
    smart.addEventListener('input', () => {
      const r = parseDateText(smart.value, new Date());
      if (!smart.value.trim()) { smartHint.textContent = ''; return; }
      if (!r.date && !r.recur) { smartHint.textContent = 'No date found yet.'; return; }
      if (r.date) date.value = r.date;
      if (r.time) time.value = r.time;
      if (r.recur) { repeat.value = describeRecur(r.recur); updateRepeatHint(); }
      smartHint.textContent = `${longLabel(r.date)}${r.time ? ' at ' + formatTime(r.time, ctx.h24) : ''}${r.recur ? ', ' + describeRecur(r.recur) : ''}`;
    });

    // Subtasks
    const subList = h('ul.sub-edit', { role: 'list' });
    const renderSubs = (tasks) => {
      subList.replaceChildren(...childrenOf(tasks, id).map((s) => h('li',
        h('label.row',
          h('input', { type: 'checkbox', checked: s.done, onchange: () => ops.toggle(s.id) }),
          h('span', { class: s.done ? 'grow struck' : 'grow' }, s.title)),
        h('button.icon-btn', { type: 'button', 'aria-label': `Delete subtask ${s.title}`, onclick: () => ops.remove(s.id) }, icon('x', 14)))));
    };
    renderSubs(ctx.tasks);
    const subInput = h('input.input', { type: 'text', placeholder: 'Add a subtask and press Enter', 'aria-label': 'New subtask' });
    subInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (subInput.value.trim()) {
          await ops.addFromText(subInput.value, { parentId: id, projectId: task.projectId });
          subInput.value = '';
        }
      }
    });
    const unwatch = (() => {
      const l = (changes, area) => { if (area === 'local' && changes.tasks) renderSubs(changes.tasks.newValue || []); };
      chrome.storage.onChanged.addListener(l);
      return () => chrome.storage.onChanged.removeListener(l);
    })();

    const preview = h('div.md-preview', { hidden: true });
    const previewBtn = h('button.btn.small', { type: 'button', onclick: () => {
      const show = preview.hidden;
      preview.hidden = !show;
      notes.hidden = show;
      previewBtn.textContent = show ? 'Edit' : 'Preview';
      if (show) preview.innerHTML = renderMarkdown(notes.value) || '<p class="muted">Nothing yet.</p>';
    } }, 'Preview');

    const form = h('form.dialog-body.task-editor', { method: 'dialog' },
      h('div.dialog-head', h('h2', { style: { fontSize: '16px' } }, 'Edit task'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => dlg.close('cancel') }, icon('x'))),
      h('label.field', h('span', 'Title'), title),
      h('div.field', h('div.row', h('span.grow.small.muted', { style: { fontWeight: 500 } }, 'Notes'), previewBtn), notes, preview),
      h('label.field', h('span', 'Quick schedule'), smart, smartHint),
      h('div.grid-2', h('label.field', h('span', 'Due date'), date), h('label.field', h('span', 'Time'), time)),
      h('label.field', h('span', 'Repeat'), repeat, repeatHint),
      h('div.grid-2', h('label.field', h('span', 'Priority'), priority), h('label.field', h('span', 'Project'), project)),
      h('label.field', h('span', 'Labels'), labels),
      h('div.field', h('span.small.muted', { style: { fontWeight: 500 } }, 'Subtasks'), subList, subInput),
      h('div.dialog-foot',
        h('button.btn.danger', { type: 'button', style: { marginRight: 'auto' }, onclick: async () => {
          if (await confirmDialog(`Delete “${task.title}”${childrenOf(ctx.tasks, id).length ? ' and its subtasks' : ''}?`)) {
            dlg.close('deleted');
            await removeWithUndo(id);
          }
        } }, icon('trash', 16), 'Delete'),
        h('button.btn', { type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel'),
        h('button.btn.primary', { type: 'submit', value: 'save' }, 'Save')));
    const dlg = h('dialog.editor-dialog', { 'aria-label': 'Edit task' }, form);
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dlg.close('save'); }
    });
    dlg.addEventListener('close', async () => {
      unwatch();
      dlg.remove();
      if (dlg.returnValue === 'save' && title.value.trim()) {
        const fields = {
          title: title.value.trim(),
          notes: notes.value,
          date: date.value || null,
          time: date.value && time.value ? time.value : null,
          priority: +priority.value,
          labels: labels.value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean),
        };
        if (!task.parentId) fields.projectId = project.value;
        const rv = repeat.value.trim();
        if (!rv) fields.recur = null;
        else if (rv === originalRecur) fields.recur = task.recur ? { ...task.recur, anchor: fields.date || task.recur.anchor } : null;
        else {
          const r = parseDateText(/^every|daily|weekly|monthly|yearly|annually|fortnightly|biweekly|quarterly/i.test(rv) ? rv : 'every ' + rv, t);
          if (r.recur) {
            const rule = { ...r.recur };
            delete rule.anchor;
            if (!fields.date) fields.date = firstOccurrence(rule, t, t);
            rule.anchor = fields.date;
            fields.recur = rule;
          }
        }
        if (fields.recur && !fields.date) fields.date = firstOccurrence(fields.recur, t, t);
        await ops.patch(id, fields);
      }
      resolve(dlg.returnValue);
    });
    document.body.append(dlg);
    dlg.showModal();
    title.focus();
    title.select();
  });
}

/** Wire a quick-add input with a live parse hint. `getDefaults()` supplies project/date defaults. */
export function wireQuickAdd(input, hint, getDefaults = () => ({}), onAdded) {
  const describe = async () => {
    const { parseTask, describeParse } = await import('./nlp.js');
    const v = input.value.trim();
    if (!v) { hint.textContent = ''; hint.hidden = true; return; }
    const p = parseTask(v, new Date());
    const d = describeParse(p, today());
    hint.hidden = !d;
    hint.textContent = d ? `${p.title || '…'} → ${d}` : '';
  };
  input.addEventListener('input', describe);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { input.value = ''; describe(); input.blur(); return; }
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const res = await ops.addFromText(text, getDefaults());
    if (!res) { toast('Add a title for the task.'); return; }
    input.value = '';
    describe();
    const when = res.task.date ? ` for ${relativeLabel(res.task.date, today()).toLowerCase()}` : '';
    toast(`Added “${res.task.title}”${when}`, { label: 'Undo', run: res.undo }, 3500);
    if (onAdded) onAdded(res.task);
  });
}

