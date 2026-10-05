// Editable citation form shared by the popup and the bibliography manager.
import { TYPES, FIELDS, fieldLabel, fieldVisible, blankItem } from '../lib/model.js';
import { h } from '../lib/dom.js';
import { parseNames, parseName } from '../lib/names.js';
import { normalizeDate } from '../lib/text.js';

const ICONS = {
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4l-4 4h8z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12l4-4H4z" fill="currentColor"/></svg>',
  remove: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  org: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 14V3h6v11M9 7h4v7M5 5h2M5 8h2M5 11h2M11 9h0M11 12h0" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  person: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
};

const PLACEHOLDERS = {
  date: 'YYYY-MM-DD', accessed: 'YYYY-MM-DD', url: 'https://…', doi: '10.xxxx/…', isbn: '978…', pages: '45–67',
  volume: '12', issue: '3', edition: '2', number: 'e.g. TR-2024-01',
};

/**
 * @param {HTMLElement} root
 * @param {{onChange?: (item) => void, idPrefix?: string}} opts
 */
export function createEditor(root, { onChange, idPrefix = 'ed' } = {}) {
  let item = blankItem();
  const emit = () => { if (onChange) onChange(getItem()); };

  function getItem() {
    return JSON.parse(JSON.stringify(item));
  }

  function setItem(next) {
    item = { ...blankItem(), ...JSON.parse(JSON.stringify(next || {})) };
    if (!Array.isArray(item.authors)) item.authors = [];
    if (!Array.isArray(item.editors)) item.editors = [];
    render();
  }

  function render() {
    const active = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    root.replaceChildren(
      h('div.editor', null,
        typeField(),
        namesBlock('authors', 'Authors', 'author'),
        (item.type === 'chapter' || item.type === 'book') ? namesBlock('editors', 'Editors', 'editor') : null,
        h('div.field-grid', null, FIELDS.filter(f => fieldVisible(f, item.type)).map(fieldInput)),
      ),
    );
    if (active) { const el = document.getElementById(active); if (el) el.focus(); }
  }

  function typeField() {
    const id = `${idPrefix}-type`;
    const sel = h('select', { id, onchange: e => { item.type = e.target.value; render(); emit(); } },
      TYPES.map(t => h('option', { value: t.id, selected: t.id === item.type }, t.label)));
    return h('div.field.field-type', null, h('label', { for: id }, 'Source type'), sel);
  }

  function namesBlock(key, label, noun) {
    const list = item[key];
    const rows = list.map((n, i) => nameRow(key, n, i, list.length, noun));
    const pasteId = `${idPrefix}-${key}-paste`;
    const pasteBox = h('div.paste-box', { hidden: true },
      h('label.sr-only', { for: pasteId }, `Paste ${label.toLowerCase()}`),
      h('textarea', { id: pasteId, rows: 2, placeholder: 'Smith, Jane; John Doe; World Health Organization' }),
      h('div.row-actions', null,
        h('button.btn.btn-sm', {
          type: 'button',
          onclick: () => {
            const ta = document.getElementById(pasteId);
            const names = parseNames(ta.value);
            if (names.length) { item[key] = item[key].concat(names); render(); emit(); }
          },
        }, 'Add names'),
        h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: e => { e.target.closest('.paste-box').hidden = true; } }, 'Cancel'),
      ),
    );
    return h('fieldset.names', null,
      h('legend', null, label, h('span.count', null, list.length ? `\u00a0(${list.length})` : '')),
      rows.length ? h('div.name-rows', null, rows) : h('p.empty-names', null, key === 'authors' ? 'No authors. Titles move to the author position in most styles.' : 'No editors.'),
      h('div.names-actions', null,
        h('button.btn.btn-sm', { type: 'button', id: `${idPrefix}-${key}-add`, onclick: () => addName(key, { given: '', family: '' }) }, `+ ${capital(noun)}`),
        h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => addName(key, { literal: '' }) }, '+ Organization'),
        h('button.btn.btn-sm.btn-ghost', {
          type: 'button',
          onclick: e => { const box = e.target.closest('fieldset').querySelector('.paste-box'); box.hidden = false; box.querySelector('textarea').focus(); },
        }, 'Paste list…'),
      ),
      pasteBox,
    );
  }

  function addName(key, n) {
    item[key].push(n);
    render();
    const idx = item[key].length - 1;
    const el = document.getElementById(`${idPrefix}-${key}-${idx}-${n.literal != null ? 'literal' : 'given'}`);
    if (el) el.focus();
    emit();
  }

  function nameRow(key, n, i, total, noun) {
    const base = `${idPrefix}-${key}-${i}`;
    const isOrg = n.literal != null;
    const upd = (field) => e => { item[key][i][field] = e.target.value; emit(); };
    const inputs = isOrg
      ? [h('input', { id: `${base}-literal`, value: n.literal || '', placeholder: 'Organization name', 'aria-label': `${capital(noun)} ${i + 1} organization name`, oninput: upd('literal'), class: 'lit' })]
      : [
        h('input', { id: `${base}-given`, value: n.given || '', placeholder: 'First / given', 'aria-label': `${capital(noun)} ${i + 1} first name`, oninput: upd('given') }),
        h('input', { id: `${base}-family`, value: n.family || '', placeholder: 'Last / family', 'aria-label': `${capital(noun)} ${i + 1} last name`, oninput: upd('family') }),
      ];
    const btn = (icon, title, onclick, disabled) => h('button.icon-btn', { type: 'button', title, 'aria-label': title, disabled, onclick, html: ICONS[icon] });
    return h('div.name-row', { class: isOrg ? 'name-row org' : 'name-row' },
      ...inputs,
      btn(isOrg ? 'person' : 'org', isOrg ? 'Make person' : 'Make organization', () => {
        const cur = item[key][i];
        item[key][i] = isOrg
          ? (parseName(cur.literal || '', { allowOrg: false }) || { given: '', family: '' })
          : { literal: [cur.given, cur.family].filter(Boolean).join(' ') };
        render(); emit();
      }),
      btn('up', 'Move up', () => { swap(item[key], i, i - 1); render(); focusRow(key, i - 1); emit(); }, i === 0),
      btn('down', 'Move down', () => { swap(item[key], i, i + 1); render(); focusRow(key, i + 1); emit(); }, i === total - 1),
      btn('remove', `Remove ${noun}`, () => { item[key].splice(i, 1); render(); emit(); }),
    );
  }

  function focusRow(key, i) {
    const el = root.querySelector(`[id^="${idPrefix}-${key}-${i}-"]`);
    if (el) el.focus();
  }

  function fieldInput(f) {
    const id = `${idPrefix}-${f.key}`;
    const input = h('input', {
      id,
      type: f.type === 'url' ? 'url' : 'text',
      value: item[f.key] || '',
      placeholder: PLACEHOLDERS[f.key] || '',
      inputmode: f.type === 'date' ? 'numeric' : null,
      spellcheck: f.key === 'title' || f.key === 'container' ? 'true' : 'false',
      oninput: e => { item[f.key] = e.target.value; emit(); },
      onblur: f.type === 'date' ? e => {
        const v = normalizeDate(e.target.value);
        if (v !== e.target.value) { e.target.value = v; item[f.key] = v; emit(); }
      } : null,
    });
    const extra = f.key === 'accessed'
      ? h('button.link-btn', { type: 'button', onclick: () => { const t = new Date(); const v = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; input.value = v; item.accessed = v; emit(); } }, 'Today')
      : null;
    return h('div.field', { class: f.wide ? 'field wide' : 'field', dataset: { key: f.key } },
      h('label', { for: id }, fieldLabel(f, item.type), extra),
      f.key === 'title' ? titleArea(id, f) : input);
  }

  function titleArea(id, f) {
    const ta = h('textarea', {
      id, rows: 2, spellcheck: 'true', value: item[f.key] || '',
      oninput: e => { item[f.key] = e.target.value.replace(/\n+/g, ' '); emit(); },
      onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) e.preventDefault(); },
    });
    ta.value = item[f.key] || '';
    return ta;
  }

  setItem(item);
  return { getItem, setItem, render, focus: () => { const el = root.querySelector('textarea, input, select'); if (el) el.focus(); } };
}

function swap(arr, a, b) {
  if (b < 0 || b >= arr.length) return;
  [arr[a], arr[b]] = [arr[b], arr[a]];
}

function capital(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
