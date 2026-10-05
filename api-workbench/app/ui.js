// Generic UI building blocks: toasts, popup menus, modal dialogs and key/value tables.
import { h, clear, uid } from '../lib/util.js';
import { kv } from '../lib/model.js';
import { putFile } from '../lib/idb.js';

/* ---------- toasts ---------- */
export function toast(msg, kind = '', ms = 3200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = h('div.toast', { class: kind }, msg);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- popup menus ---------- */
let openMenu = null;
export function closeMenu() {
  if (openMenu) { const { el, restore } = openMenu; openMenu = null; el.remove(); restore?.focus?.(); }
}
/** items: [{label, onClick, danger, key, disabled} | 'sep' | {head}] */
export function showMenu(anchor, items, { x, y } = {}) {
  closeMenu();
  const el = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { el.append(h('div.sep', { role: 'separator' })); continue; }
    if (it.head) { el.append(h('div.menu-head', it.head)); continue; }
    el.append(h('button', {
      type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', disabled: !!it.disabled,
      on: { click: () => { closeMenu(); it.onClick(); } },
    }, it.label, it.key ? h('span.key', it.key) : null));
  }
  document.body.append(el);
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, bottom: y, right: x };
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let left = x ?? r.left, top = y ?? r.bottom + 4;
  if (left + mw > innerWidth - 8) left = Math.max(8, (anchor ? r.right : left) - mw);
  if (top + mh > innerHeight - 8) top = Math.max(8, (anchor ? r.top - mh - 4 : top - mh));
  el.style.left = left + 'px'; el.style.top = top + 'px';
  openMenu = { el, restore: anchor };
  const btns = () => [...el.querySelectorAll('button:not(:disabled)')];
  btns()[0]?.focus();
  el.addEventListener('keydown', e => {
    const list = btns(); const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    else if (e.key === 'Tab') closeMenu();
  });
  return el;
}
document.addEventListener('mousedown', e => { if (openMenu && !openMenu.el.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

/* ---------- modal ---------- */
/**
 * openModal({ title, body: Node, actions: [{label, primary, danger, onClick(close) -> false keeps open}], wide, onClose })
 */
export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  const dlg = document.getElementById('modal');
  if (dlg.open) dlg.close();
  clear(dlg);
  dlg.style.width = wide ? 'min(960px, 94vw)' : '';
  const close = () => { if (dlg.open) dlg.close(); };
  const foot = h('div.modal-foot');
  for (const a of actions) {
    const b = h('button.btn', {
      type: 'button', class: a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : '',
      on: { click: async () => { const r = await a.onClick?.(close); if (r !== false) close(); } },
    }, a.label);
    foot.append(b);
  }
  if (!actions.length) foot.append(h('button.btn', { type: 'button', on: { click: close } }, 'Close'));
  dlg.append(
    h('div.modal-head', h('h2', title), h('button.btn.btn-icon.btn-ghost', { type: 'button', 'aria-label': 'Close', on: { click: close } }, '✕')),
    h('div.modal-body', body),
    foot,
  );
  dlg.onclose = () => { onClose?.(); };
  dlg.showModal();
  const first = dlg.querySelector('.modal-body input, .modal-body textarea, .modal-body select, .modal-body button');
  first?.focus();
  return { close, dialog: dlg };
}

export function prompt({ title, label, value = '', okLabel = 'OK' }) {
  return new Promise(resolve => {
    let done = false;
    const inp = h('input', { type: 'text', value });
    const form = h('form', { on: { submit: e => { e.preventDefault(); finish(inp.value); } } }, h('div.field', h('label', label), inp));
    const finish = v => { done = true; resolve(v); m.close(); };
    const m = openModal({
      title, body: form,
      actions: [{ label: 'Cancel', onClick: () => { done = true; resolve(null); } }, { label: okLabel, primary: true, onClick: () => { done = true; resolve(inp.value); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    inp.select();
  });
}

export function confirmDialog({ title, message, okLabel = 'Delete', danger = true }) {
  return new Promise(resolve => {
    let done = false;
    openModal({
      title, body: h('p', message),
      actions: [{ label: 'Cancel', onClick: () => { done = true; resolve(false); } }, { label: okLabel, primary: !danger, danger, onClick: () => { done = true; resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/* ---------- key/value table ---------- */
/**
 * Edits `list` (array of kv rows) in place. A trailing blank row turns into a real row as you type.
 * opts: { onChange(structural), keyPh, valPh, desc, files, secret, datalist }
 */
export function kvTable(list, opts = {}) {
  const { onChange = () => {}, keyPh = 'Key', valPh = 'Value', desc = true, files = false, secret = false } = opts;
  const tbody = h('tbody');
  const table = h('table.kvt',
    h('colgroup', h('col', { style: { width: '28px' } }), h('col'), files ? h('col', { style: { width: '72px' } }) : null, h('col'), desc ? h('col', { style: { width: '28%' } }) : null, h('col', { style: { width: '54px' } })),
    h('thead', h('tr', h('th', h('span.hidden', 'Enabled')), h('th', 'Key'), files ? h('th', 'Type') : null, h('th', 'Value'), desc ? h('th', 'Description') : null, h('th', h('span.hidden', 'Actions')))),
    tbody);

  function valueCell(row, tr) {
    if (files && row.type === 'file') {
      const name = h('span.name', row.fileName || 'No file');
      const pick = h('button.btn.btn-sm', {
        type: 'button', on: {
          click: () => {
            const inp = h('input', { type: 'file', style: { display: 'none' } });
            inp.addEventListener('change', async () => {
              const f = inp.files[0]; inp.remove(); if (!f) return;
              const id = row.fileId || uid();
              try { await putFile(id, f); } catch (e) { toast('Could not store file: ' + e.message, 'bad'); return; }
              row.fileId = id; row.fileName = f.name; name.textContent = f.name; onChange(false);
            });
            document.body.append(inp); inp.click();
          },
        },
      }, 'Choose file');
      return h('td', h('div.kv-file', pick, name));
    }
    const isSecret = secret && row.secret;
    const inp = h('input', { type: isSecret ? 'password' : 'text', value: row.value ?? '', placeholder: valPh, 'aria-label': 'Value', spellcheck: 'false', list: opts.datalist || null });
    inp.addEventListener('input', () => { row.value = inp.value; onChange(false); });
    void tr;
    return h('td', inp);
  }

  function rowEl(row, isNew) {
    const tr = h('tr', { class: (isNew ? 'row-new' : '') + (row.enabled === false ? ' off' : '') });
    const chk = h('input', { type: 'checkbox', checked: row.enabled !== false, 'aria-label': 'Enabled', disabled: isNew });
    chk.addEventListener('change', () => { row.enabled = chk.checked; tr.classList.toggle('off', !chk.checked); onChange(false); });
    const key = h('input', { type: 'text', value: row.key ?? '', placeholder: isNew ? `Add ${keyPh.toLowerCase()}` : keyPh, 'aria-label': 'Key', spellcheck: 'false', list: opts.keyList || null });
    const promote = () => {
      if (!isNew) return;
      isNew = false; list.push(row); tr.classList.remove('row-new'); chk.disabled = false;
      key.placeholder = keyPh; del.disabled = false;
      tbody.append(rowEl(kv(), true));
      onChange(true);
    };
    key.addEventListener('input', () => { row.key = key.value; promote(); onChange(false); });
    const cells = [h('td.col-check', chk), h('td', key)];
    let valTd;
    if (files) {
      const sel = h('select', { 'aria-label': 'Field type' }, h('option', { value: 'text' }, 'Text'), h('option', { value: 'file' }, 'File'));
      sel.value = row.type || 'text';
      sel.addEventListener('change', () => {
        row.type = sel.value; promote();
        const n = valueCell(row, tr); valTd.replaceWith(n); valTd = n; onChange(false);
      });
      cells.push(h('td', sel));
    }
    valTd = valueCell(row, tr);
    // typing a value in the blank row also creates the row
    valTd.querySelector('input')?.addEventListener('input', promote);
    cells.push(valTd);
    if (desc) {
      const d = h('input', { type: 'text', value: row.description ?? '', placeholder: 'Description', 'aria-label': 'Description' });
      d.addEventListener('input', () => { row.description = d.value; promote(); onChange(false); });
      cells.push(h('td', d));
    }
    const lock = secret ? h('button.kv-del', {
      type: 'button', title: 'Mask value', 'aria-label': 'Toggle secret', 'aria-pressed': String(!!row.secret),
      on: { click: () => { row.secret = !row.secret; lock.setAttribute('aria-pressed', String(row.secret)); lock.textContent = row.secret ? '◉' : '○'; const n = valueCell(row, tr); valTd.replaceWith(n); valTd = n; onChange(false); } },
    }, row.secret ? '◉' : '○') : null;
    const del = h('button.kv-del', {
      type: 'button', title: 'Delete row', 'aria-label': 'Delete row', disabled: isNew,
      on: {
        click: () => {
          const i = list.indexOf(row); if (i >= 0) list.splice(i, 1);
          const next = tr.nextElementSibling; tr.remove();
          next?.querySelector('input[type=text]')?.focus();
          onChange(true);
        },
      },
    }, '✕');
    cells.push(h('td.col-act', lock, del));
    tr.append(...cells);
    return tr;
  }

  for (const row of list) tbody.append(rowEl(row, false));
  tbody.append(rowEl(kv(), true));
  return table;
}

/** Bulk editor text <-> rows ("key: value" per line, "//" prefix disables). */
export function rowsToBulk(list, sep = ':') {
  return list.filter(r => r.key || r.value).map(r => `${r.enabled === false ? '//' : ''}${r.key}${sep} ${r.value}`).join('\n');
}
export function bulkToRows(text, old = [], sep = ':') {
  return text.split(/\r?\n/).filter(l => l.trim()).map(line => {
    let enabled = true;
    if (line.startsWith('//')) { enabled = false; line = line.slice(2); }
    const i = line.indexOf(sep);
    const key = (i >= 0 ? line.slice(0, i) : line).trim();
    const value = i >= 0 ? line.slice(i + 1).replace(/^ /, '') : '';
    const prev = old.find(o => o.key === key);
    return kv(key, value, { enabled, description: prev?.description || '' });
  });
}

/** Segmented control. options: [[value,label]] */
export function seg(options, value, onPick, label) {
  const el = h('div.seg', { role: 'radiogroup', 'aria-label': label || null });
  for (const [v, l] of options) {
    el.append(h('button', {
      type: 'button', role: 'radio', class: v === value ? 'active' : '', 'aria-checked': String(v === value),
      on: { click: () => { el.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); }); const b = el.querySelector(`[data-v="${CSS.escape(v)}"]`); b.classList.add('active'); b.setAttribute('aria-checked', 'true'); onPick(v); } },
      dataset: { v },
    }, l));
  }
  return el;
}

export function selectEl(options, value, onChange, attrs = {}) {
  const s = h('select', attrs, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Textarea that inserts two spaces on Tab (Esc then Tab leaves the field). */
export function codeArea(attrs = {}) {
  const ta = h('textarea.code', { spellcheck: 'false', ...attrs });
  let escaped = false;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { escaped = true; return; }
    if (e.key === 'Tab' && !escaped && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = ta;
      if (e.shiftKey) {
        const ls = value.lastIndexOf('\n', s - 1) + 1;
        if (value.slice(ls, ls + 2) === '  ') { ta.setRangeText('', ls, ls + 2, 'end'); ta.dispatchEvent(new Event('input')); }
        return;
      }
      ta.setRangeText('  ', s, en, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    escaped = false;
  });
  return ta;
}
