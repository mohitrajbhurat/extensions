// Markdown scratchpad: edit / preview, task-list checkboxes toggle in preview, autosave.
import { h } from '../../lib/ui.js';
import { renderMarkdown, toggleTaskLine } from '../../lib/markdown.js';
import { debounce } from '../../lib/ui.js';
import * as store from '../../lib/store.js';

export function mount(frame, app) {
  let mode = sessionStorage.getItem('hb-notes-mode') || 'preview';
  const ta = h('textarea.notes-input', { 'aria-label': 'Notes (Markdown)', spellcheck: 'true', placeholder: '# Notes\n\nMarkdown works: **bold**, - lists, - [ ] tasks' });
  const preview = h('div.md.notes-preview.widget-scroll', { tabindex: '0', 'aria-label': 'Notes preview' });
  const status = h('span.small.muted.notes-status', { 'aria-live': 'polite' });
  const toggle = h('button.btn.small', { type: 'button' });
  frame.head.querySelector('.widget-actions').prepend(toggle);
  frame.body.append(ta, preview, status);

  const save = debounce(async (v) => {
    await store.set('notes', v);
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 1200);
  }, 400);
  ta.addEventListener('input', () => { status.textContent = 'Saving…'; save(ta.value); });
  ta.addEventListener('blur', () => { if (status.textContent === 'Saving…') save.flush(ta.value); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setMode('preview'); }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
      // Indent list items with Tab inside the editor; plain Tab elsewhere keeps focus moving.
      const line = ta.value.slice(ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1, ta.selectionStart);
      if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
  });
  preview.addEventListener('change', async (e) => {
    const box = e.target.closest('input[type=checkbox][data-line]');
    if (!box) return;
    const next = toggleTaskLine(app.state.notes, +box.dataset.line);
    app.state.notes = next;
    await store.set('notes', next);
  });
  preview.addEventListener('dblclick', (e) => { if (!e.target.closest('a, input')) setMode('edit'); });

  function setMode(m) {
    mode = m;
    sessionStorage.setItem('hb-notes-mode', m);
    ta.hidden = m !== 'edit';
    preview.hidden = m === 'edit';
    toggle.textContent = m === 'edit' ? 'Preview' : 'Edit';
    toggle.setAttribute('aria-label', m === 'edit' ? 'Show preview' : 'Edit notes');
    if (m === 'edit') { ta.value = app.state.notes; ta.focus(); } else renderPreview();
  }
  toggle.addEventListener('click', () => setMode(mode === 'edit' ? 'preview' : 'edit'));

  function renderPreview() {
    preview.innerHTML = renderMarkdown(app.state.notes) || '<p class="muted">Empty. Double-click or press Edit to write.</p>';
  }
  setMode(mode);
  if (mode === 'edit') ta.blur();
  return {
    keys: ['notes'],
    update() {
      if (document.activeElement !== ta) ta.value = app.state.notes;
      if (mode !== 'edit') renderPreview();
    },
  };
}
