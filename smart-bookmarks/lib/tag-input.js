// Chip-style tag editor with autocomplete from the library's tag vocabulary.
import { normalizeTag } from './meta.js';
import { icon, esc } from './icons.js';

export function createTagInput({ value = [], vocab = new Map(), placeholder = 'Add tags…', onChange = () => {}, label = 'Tags' } = {}) {
  let tags = [];
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  const box = document.createElement('div');
  box.className = 'tag-input';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div');
  list.className = 'tag-suggest-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.append(box, list);
  let active = -1;
  let options = [];

  const getVocab = () => (typeof vocab === 'function' ? vocab() : vocab) || new Map();

  function render() {
    box.querySelectorAll('.chip').forEach(c => c.remove());
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${esc(t)}<button type="button" aria-label="Remove tag ${esc(t)}">${icon('x')}</button>`;
      chip.querySelector('button').addEventListener('click', e => { e.stopPropagation(); remove(t); input.focus(); });
      box.insertBefore(chip, input);
    }
    input.placeholder = tags.length ? '' : placeholder;
  }

  function add(raw, silent) {
    let changed = false;
    for (const part of String(raw).split(/[,;]/)) {
      const t = normalizeTag(part);
      if (t && !tags.includes(t)) { tags.push(t); changed = true; }
    }
    if (changed) { render(); if (!silent) onChange([...tags]); }
    return changed;
  }
  function remove(t) {
    tags = tags.filter(x => x !== t);
    render();
    onChange([...tags]);
  }

  function closeList() { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); }
  function openList() {
    const q = normalizeTag(input.value);
    const v = getVocab();
    if (!q) { closeList(); return; }
    options = [...v.entries()]
      .filter(([t]) => !tags.includes(t) && t.includes(q))
      .sort((a, b) => (b[0].startsWith(q) - a[0].startsWith(q)) || b[1] - a[1])
      .slice(0, 8);
    if (!options.length) { closeList(); return; }
    active = 0;
    list.innerHTML = options.map(([t, n], i) => `<div role="option" data-i="${i}" aria-selected="${i === active}">${esc(t)}<span>${n}</span></div>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function highlight() { [...list.children].forEach((c, i) => c.setAttribute('aria-selected', String(i === active))); }

  list.addEventListener('mousedown', e => {
    const d = e.target.closest('[data-i]');
    if (!d) return;
    e.preventDefault();
    add(options[+d.dataset.i][0]);
    input.value = '';
    closeList();
  });
  box.addEventListener('click', () => input.focus());
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) { add(input.value); input.value = ''; closeList(); return; }
    openList();
  });
  input.addEventListener('keydown', e => {
    if (!list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      highlight();
      return;
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && input.value.trim())) {
      if (!list.hidden && active >= 0) { e.preventDefault(); add(options[active][0]); input.value = ''; closeList(); return; }
      if (input.value.trim()) { e.preventDefault(); add(input.value); input.value = ''; closeList(); return; }
    }
    if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); e.preventDefault(); closeList(); return; }
    if (e.key === 'Backspace' && !input.value && tags.length) { remove(tags[tags.length - 1]); }
  });
  input.addEventListener('blur', () => {
    setTimeout(closeList, 120);
    if (input.value.trim()) { add(input.value); input.value = ''; }
  });

  box.append(input);
  add(value.join(','), true);
  render();

  return {
    el: wrap,
    input,
    get value() { if (input.value.trim()) { add(input.value, true); input.value = ''; } return [...tags]; },
    set(next) { tags = []; add((next || []).join(','), true); render(); },
    add: t => add(t),
    remove,
    has: t => tags.includes(normalizeTag(t)),
    focus: () => input.focus()
  };
}
