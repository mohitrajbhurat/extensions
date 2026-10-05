// Small DOM helpers, toasts, modals and the shared card editor.
import { wrapCloze, hasCloze, clozeNumbers } from '../lib/cloze.js';
import { renderFront, renderBack } from '../lib/render.js';
import { splitTags } from '../lib/io.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export function svgIcon(path, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = path;
  return s;
}

export function toast(message, kind = 'info', ms = 3200) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/** Generic modal. Resolves with the value passed to close(), or null when dismissed. */
export function modal(build, { label = 'Dialog', wide = false } = {}) {
  const dlg = document.getElementById('modal');
  return new Promise(resolve => {
    let done = false;
    const close = v => { if (done) return; done = true; dlg.close(); dlg.replaceChildren(); dlg.classList.remove('wide'); resolve(v ?? null); };
    dlg.replaceChildren();
    dlg.classList.toggle('wide', wide);
    dlg.setAttribute('aria-label', label);
    dlg.append(build(close));
    dlg.onclose = () => close(null);
    dlg.onclick = e => { if (e.target === dlg) close(null); };
    dlg.showModal();
    const f = dlg.querySelector('[autofocus], input, textarea, select, .btn.primary');
    if (f) f.focus();
  });
}

export function confirmDialog(title, message, { okText = 'OK', danger = false } = {}) {
  return modal(close => h('form', { class: 'modal-body', method: 'dialog', onsubmit: e => { e.preventDefault(); close(true); } },
    h('h2', {}, title),
    h('p', { class: 'muted' }, message),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { type: 'submit', class: `btn primary${danger ? ' danger-fill' : ''}`, autofocus: true }, okText))), { label: title }).then(Boolean);
}

export function promptDialog(title, { label = '', value = '', okText = 'Save', placeholder = '' } = {}) {
  return modal(close => {
    const input = h('input', { type: 'text', value, placeholder, autofocus: true, maxlength: '120' });
    setTimeout(() => input.select(), 0);
    return h('form', { class: 'modal-body', onsubmit: e => { e.preventDefault(); close(input.value.trim() || null); } },
      h('h2', {}, title),
      h('label', { class: 'field' }, label, input),
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, okText)));
  }, { label: title });
}

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function relTime(ts, now = Date.now()) {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let s;
  if (mins < 1) s = 'now';
  else if (mins < 60) s = `${mins}m`;
  else if (mins < 1440) s = `${Math.round(mins / 60)}h`;
  else if (mins < 1440 * 60) s = `${Math.round(mins / 1440)}d`;
  else if (mins < 1440 * 365) s = `${Math.round(mins / 1440 / 30.4)}mo`;
  else s = `${(mins / 1440 / 365).toFixed(1)}y`;
  if (s === 'now') return s;
  return diff < 0 ? `${s} ago` : `in ${s}`;
}

export const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Card editor form. Returns {el, getNote(), focus(), setValues()}.
 * opts: { decks, card?, deckId?, onSubmit(note), submitText, onCancel }
 */
export function cardEditor(opts) {
  const card = opts.card || {};
  const front = h('textarea', { rows: 4, placeholder: 'Question — or text with {{c1::cloze deletions}}', 'aria-label': 'Front' });
  front.value = card.front || opts.front || '';
  const back = h('textarea', { rows: 4, placeholder: 'Answer (for cloze: optional extra notes)', 'aria-label': 'Back' });
  back.value = card.back || opts.back || '';
  const deck = h('select', { 'aria-label': 'Deck' });
  for (const d of opts.decks) deck.append(new Option(d.name, d.id));
  deck.append(new Option('+ New deck…', '__new'));
  deck.value = card.deckId || opts.deckId || opts.decks[0]?.id;
  if (!deck.value) deck.value = opts.decks[0]?.id || '__new';
  const newDeck = h('input', { type: 'text', placeholder: 'New deck name', class: deck.value === '__new' ? '' : 'hidden', maxlength: '120' });
  deck.addEventListener('change', () => { newDeck.classList.toggle('hidden', deck.value !== '__new'); if (deck.value === '__new') newDeck.focus(); });
  const tags = h('input', { type: 'text', placeholder: 'space or comma separated', value: (card.tags || opts.tags || []).join(' ') });
  const srcUrl = h('input', { type: 'url', placeholder: 'https://…', value: card.source?.url || opts.source?.url || '' });
  const srcTitle = h('input', { type: 'text', placeholder: 'Source title', value: card.source?.title || opts.source?.title || '' });
  const typeChip = h('span', { class: 'chip' });
  const status = h('span', { class: 'small muted editor-status', role: 'status' });
  const prevFront = h('div', { class: 'face' });
  const prevBack = h('div', { class: 'face' });
  const previewSel = h('select', { class: 'preview-sel', 'aria-label': 'Preview card' });

  const doCloze = () => {
    const { text, cursor } = wrapCloze(front.value, front.selectionStart, front.selectionEnd);
    front.value = text; front.focus(); front.setSelectionRange(cursor, cursor); update();
  };
  const doClozeSame = () => {
    const nums = clozeNumbers(front.value);
    const { text, cursor } = wrapCloze(front.value, front.selectionStart, front.selectionEnd, nums.length ? nums[nums.length - 1] : 1);
    front.value = text; front.focus(); front.setSelectionRange(cursor, cursor); update();
  };
  const clozeBtn = h('button', { type: 'button', class: 'btn sm', title: 'Wrap selection in a new cloze (Ctrl+Shift+C)', onclick: doCloze }, '[…] Cloze');
  const clozeSameBtn = h('button', { type: 'button', class: 'btn sm ghost', title: 'Wrap selection in the same cloze number (Ctrl+Shift+Alt+C)', onclick: doClozeSame }, 'Same card');

  function currentPreviewCard() {
    const isCloze = hasCloze(front.value);
    const nums = clozeNumbers(front.value);
    const n = Number(previewSel.value) || nums[0] || 1;
    return { type: isCloze ? 'cloze' : 'basic', front: front.value, back: back.value, clozeIndex: n, source: srcUrl.value ? { url: srcUrl.value, title: srcTitle.value } : null };
  }
  function update() {
    const isCloze = hasCloze(front.value);
    const nums = clozeNumbers(front.value);
    typeChip.textContent = isCloze ? `Cloze · ${nums.length} card${nums.length === 1 ? '' : 's'}` : 'Basic · 1 card';
    const cur = previewSel.value;
    previewSel.replaceChildren(...(isCloze ? nums.map(n => new Option(`Card c${n}`, n)) : [new Option('Card 1', 1)]));
    if ([...previewSel.options].some(o => o.value === cur)) previewSel.value = cur;
    previewSel.classList.toggle('hidden', !isCloze || nums.length < 2);
    const pc = currentPreviewCard();
    prevFront.innerHTML = front.value.trim() ? renderFront(pc) : '<span class="muted">Front preview</span>';
    prevBack.innerHTML = front.value.trim() ? renderBack(pc) : '<span class="muted">Back preview</span>';
  }
  front.addEventListener('input', update);
  back.addEventListener('input', update);
  srcUrl.addEventListener('input', update);
  previewSel.addEventListener('change', update);

  const form = h('form', { class: 'editor', autocomplete: 'off' },
    h('div', { class: 'editor-fields' },
      h('div', { class: 'field-head' }, h('label', { class: 'field-label', for: 'ed-front' }, 'Front'), typeChip, h('span', { style: { flex: 1 } }), clozeBtn, clozeSameBtn),
      front,
      h('label', { class: 'field' }, 'Back', back),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, 'Deck', deck, newDeck),
        h('label', { class: 'field' }, 'Tags', tags)),
      h('details', { class: 'more', open: !!(card.source?.url || opts.source?.url) },
        h('summary', {}, 'Source'),
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'URL', srcUrl), h('label', { class: 'field' }, 'Title', srcTitle))),
      h('div', { class: 'editor-actions' },
        status,
        opts.onCancel ? h('button', { type: 'button', class: 'btn', onclick: opts.onCancel }, 'Cancel') : null,
        h('button', { type: 'submit', class: 'btn primary' }, opts.submitText || 'Save', ' ', h('span', { class: 'kbd' }, 'Ctrl+Enter')))),
    h('div', { class: 'editor-preview' },
      h('div', { class: 'preview-head' }, h('span', { class: 'small muted' }, 'Preview'), previewSel),
      h('div', { class: 'preview-card card-surface' }, prevFront),
      h('div', { class: 'preview-card card-surface' }, prevBack)));
  front.id = 'ed-front';

  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    else if (e.target === front && e.key.toLowerCase() === 'c' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.altKey ? doClozeSame() : doCloze(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    status.className = 'small muted editor-status';
    const note = getNote();
    if (!note.front) { status.textContent = 'Front is required.'; status.classList.add('err'); front.focus(); return; }
    if (deck.value === '__new' && !note.newDeckName) { status.textContent = 'Name the new deck.'; status.classList.add('err'); newDeck.focus(); return; }
    try { await opts.onSubmit(note); }
    catch (err) { status.textContent = err.message || String(err); status.classList.add('err'); }
  });

  function getNote() {
    return {
      type: hasCloze(front.value) ? 'cloze' : 'basic',
      front: front.value.trim(), back: back.value.trim(),
      deckId: deck.value === '__new' ? null : deck.value,
      newDeckName: deck.value === '__new' ? newDeck.value.trim() : '',
      tags: splitTags(tags.value),
      source: srcUrl.value.trim() ? { url: srcUrl.value.trim(), title: srcTitle.value.trim() } : null,
    };
  }
  function reset({ keepDeck = true } = {}) {
    front.value = ''; back.value = '';
    if (!keepDeck) deck.value = opts.decks[0]?.id;
    update();
    front.focus();
  }
  update();
  return { el: form, getNote, reset, focus: () => front.focus(), setStatus: (t, cls = '') => { status.textContent = t; status.className = 'small editor-status ' + (cls || 'muted'); } };
}
