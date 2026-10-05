import { h, svgIcon, toast, modal, confirmDialog, promptDialog, cardEditor, relTime, fmtDate } from '../ui.js';
import { State, STATE_NAMES, FSRS, newCardState } from '../../lib/fsrs.js';
import { stripCloze } from '../../lib/cloze.js';
import { preview } from '../../lib/render.js';
import { saveCards, deleteCards, updateNote, getAll } from '../../lib/db.js';
import { schedulerOptions } from '../../lib/settings.js';
import { dayEnd } from '../../lib/queue.js';

const PAGE = 100;

/** Parses a search query: plain words, "quoted phrases", deck:, tag:, is:new|learning|review|due|suspended, -negation. */
export function parseQuery(q) {
  const terms = [];
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  for (const m of String(q || '').matchAll(re)) {
    const value = (m[3] ?? m[4] ?? '').toLowerCase();
    if (!value && !m[2]) continue;
    terms.push({ neg: m[1] === '-', field: (m[2] || '').toLowerCase(), value });
  }
  return terms;
}

export async function render(root, ctx) {
  const { data } = ctx;
  let cards = data.cards;
  let decks = data.decks;
  const settings = data.settings;
  const fsrs = new FSRS(schedulerOptions(settings));
  const deckName = id => decks.find(d => d.id === id)?.name || '—';
  const selected = new Set();
  let shown = PAGE;
  let sort = { key: 'created', dir: -1 };
  let filtered = [];

  const page = h('div', { class: 'page' });
  root.append(page);

  const search = h('input', { type: 'search', placeholder: 'Search…  try deck:biology tag:paper is:due "exact phrase"', 'aria-label': 'Search cards' });
  search.value = ctx.params.get('q') || '';
  const deckSel = h('select', { 'aria-label': 'Filter by deck' }, new Option('All decks', ''), ...decks.map(d => new Option(d.name, d.id)));
  deckSel.value = ctx.params.get('deck') || '';
  const stateSel = h('select', { 'aria-label': 'Filter by state' },
    new Option('Any state', ''), new Option('New', 'new'), new Option('Learning', 'learning'), new Option('Review', 'review'), new Option('Due today', 'due'), new Option('Suspended', 'suspended'));
  const countEl = h('span', { class: 'small muted' });
  const bulk = h('div', { class: 'bulk hidden' });
  const tbody = h('tbody');
  const headCb = h('input', { type: 'checkbox', 'aria-label': 'Select all shown' });
  const moreRow = h('div', { class: 'more-row' });

  const th = (label, key, cls = '') => h('th', { scope: 'col', class: cls }, key ? h('button', { onclick: () => setSort(key), 'data-key': key }, label) : label);
  const table = h('table', { class: 'cards-table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'cb' }, headCb), th('Card', 'front'), th('Deck', 'deck'), th('State', 'state'), th('Due', 'due'), th('Stability', 'stability', 'num'), th('Recall', 'r', 'num'), th('Lapses', 'lapses', 'num'), th('Added', 'created', 'num'))),
    tbody);

  page.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Browse'), countEl),
    h('div', { class: 'browse-tools' }, h('div', { class: 'search' }, svgIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'), search), deckSel, stateSel),
    bulk,
    h('section', { class: 'card-surface table-wrap' }, table, moreRow));

  function matches(c, terms, now, end) {
    for (const t of terms) {
      let ok;
      const v = t.value;
      switch (t.field) {
        case 'deck': ok = deckName(c.deckId).toLowerCase().includes(v); break;
        case 'tag': ok = (c.tags || []).some(x => x.toLowerCase() === v || x.toLowerCase().startsWith(v + '::') || (v.endsWith('*') && x.toLowerCase().startsWith(v.slice(0, -1)))); break;
        case 'is':
          ok = v === 'new' ? c.state === State.New
            : v === 'learning' || v === 'learn' ? c.state === State.Learning || c.state === State.Relearning
            : v === 'review' ? c.state === State.Review
            : v === 'due' ? !c.suspended && c.state !== State.New && c.due < end
            : v === 'suspended' ? !!c.suspended
            : v === 'cloze' ? c.type === 'cloze'
            : v === 'basic' ? c.type === 'basic' : false;
          break;
        case 'front': ok = stripCloze(c.front).toLowerCase().includes(v); break;
        case 'back': ok = (c.back || '').toLowerCase().includes(v); break;
        case 'source': case 'url': ok = (c.source?.url || '').toLowerCase().includes(v) || (c.source?.title || '').toLowerCase().includes(v); break;
        default: {
          const hay = (stripCloze(c.front) + '\n' + c.back + '\n' + (c.tags || []).join(' ') + '\n' + (c.source?.title || '') + ' ' + (c.source?.url || '')).toLowerCase();
          ok = hay.includes(t.field ? `${t.field}:${v}` : v);
        }
      }
      if (t.neg ? ok : !ok) return false;
    }
    return true;
  }

  function sortValue(c, key, now) {
    switch (key) {
      case 'front': return stripCloze(c.front).toLowerCase();
      case 'deck': return deckName(c.deckId).toLowerCase();
      case 'state': return c.suspended ? 9 : c.state;
      case 'due': return c.state === State.New ? Infinity : c.due;
      case 'stability': return c.stability || 0;
      case 'r': return c.state === State.New ? -1 : fsrs.retrievability(c, now);
      case 'lapses': return c.lapses || 0;
      default: return c.created || 0;
    }
  }

  function setSort(key) {
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === 'front' || key === 'deck' || key === 'due' ? 1 : -1 };
    apply();
  }

  function apply(keepShown = false) {
    const now = Date.now();
    const end = dayEnd(now, settings.rolloverHour);
    const terms = parseQuery(search.value);
    if (stateSel.value) terms.push({ field: 'is', value: stateSel.value, neg: false });
    filtered = cards.filter(c => (!deckSel.value || c.deckId === deckSel.value) && matches(c, terms, now, end));
    filtered.sort((a, b) => {
      const x = sortValue(a, sort.key, now), y = sortValue(b, sort.key, now);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
    if (!keepShown) shown = PAGE;
    for (const id of [...selected]) if (!filtered.find(c => c.id === id)) selected.delete(id);
    for (const b of table.querySelectorAll('th button')) b.textContent = b.textContent.replace(/ [▲▼]$/, '') + (b.dataset.key === sort.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
    draw();
  }

  function draw() {
    const now = Date.now();
    countEl.textContent = `${filtered.length} of ${cards.length} card${cards.length === 1 ? '' : 's'}`;
    tbody.replaceChildren();
    if (!filtered.length) {
      tbody.append(h('tr', {}, h('td', { colspan: 9, class: 'muted', style: { textAlign: 'center', padding: '48px', cursor: 'default' } }, cards.length ? 'No cards match.' : 'No cards yet. Add some, or import from Anki/CSV.')));
    }
    for (const c of filtered.slice(0, shown)) {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Select card', checked: selected.has(c.id) });
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => { cb.checked ? selected.add(c.id) : selected.delete(c.id); row.classList.toggle('sel', cb.checked); drawBulk(); });
      const r = c.state === State.New ? null : fsrs.retrievability(c, now);
      const row = h('tr', { class: (selected.has(c.id) ? 'sel ' : '') + (c.suspended ? 'suspended' : ''), tabindex: '0', onclick: () => openCard(c.id), onkeydown: e => { if (e.key === 'Enter') openCard(c.id); } },
        h('td', { class: 'cb' }, cb),
        h('td', { class: 'q' }, h('div', { class: 't' }, preview(c, 160)), (c.tags || []).length ? h('div', { class: 'tags' }, ...c.tags.map(t => h('span', { class: 'chip' }, '#' + t))) : null),
        h('td', {}, deckName(c.deckId)),
        h('td', {}, c.suspended ? h('span', { class: 'state susp' }, 'Suspended') : h('span', { class: `state s${c.state}` }, STATE_NAMES[c.state])),
        h('td', { class: 'small' }, c.state === State.New ? h('span', { class: 'muted' }, '—') : relTime(c.due, now)),
        h('td', { class: 'num' }, c.state === State.New ? '—' : `${fmtNum(c.stability)}d`),
        h('td', { class: 'num' }, r == null ? '—' : `${Math.round(r * 100)}%`),
        h('td', { class: 'num' }, c.lapses || 0),
        h('td', { class: 'num small muted' }, c.created ? fmtDate(c.created) : ''));
      tbody.append(row);
    }
    moreRow.replaceChildren(filtered.length > shown ? h('button', { class: 'btn', onclick: () => { shown += PAGE * 2; draw(); } }, `Show more (${filtered.length - shown} remaining)`) : '');
    headCb.checked = filtered.length > 0 && filtered.slice(0, shown).every(c => selected.has(c.id));
    drawBulk();
  }

  headCb.addEventListener('change', () => {
    for (const c of filtered.slice(0, shown)) headCb.checked ? selected.add(c.id) : selected.delete(c.id);
    draw();
  });

  function drawBulk() {
    bulk.classList.toggle('hidden', selected.size === 0);
    if (!selected.size) return;
    const moveSel = h('select', { 'aria-label': 'Move to deck', style: { width: 'auto' } }, new Option('Move to deck…', ''), ...decks.map(d => new Option(d.name, d.id)));
    moveSel.addEventListener('change', async () => { if (moveSel.value) await bulkUpdate(c => ({ ...c, deckId: moveSel.value }), 'Moved'); });
    bulk.replaceChildren(
      h('b', {}, `${selected.size} selected`),
      selected.size < filtered.length ? h('button', { class: 'btn sm ghost', onclick: () => { for (const c of filtered) selected.add(c.id); draw(); } }, `Select all ${filtered.length}`) : null,
      h('span', { style: { flex: 1 } }),
      moveSel,
      h('button', { class: 'btn sm', onclick: addTag }, 'Add tag'),
      h('button', { class: 'btn sm', onclick: () => bulkUpdate(c => ({ ...c, suspended: true }), 'Suspended') }, 'Suspend'),
      h('button', { class: 'btn sm', onclick: () => bulkUpdate(c => ({ ...c, suspended: false }), 'Unsuspended') }, 'Unsuspend'),
      h('button', { class: 'btn sm', onclick: resetSel }, 'Reset progress'),
      h('button', { class: 'btn sm danger', onclick: deleteSel }, 'Delete'),
      h('button', { class: 'btn sm ghost', onclick: () => { selected.clear(); draw(); } }, 'Clear'));
  }

  async function bulkUpdate(fn, verb) {
    const now = Date.now();
    const changed = cards.filter(c => selected.has(c.id)).map(c => ({ ...fn(c), modified: now }));
    await saveCards(changed);
    const map = new Map(changed.map(c => [c.id, c]));
    cards = cards.map(c => map.get(c.id) || c);
    toast(`${verb} ${changed.length} card${changed.length === 1 ? '' : 's'}`);
    apply(true);
    ctx.refreshSidebar();
  }
  async function addTag() {
    const tag = await promptDialog('Add tag', { label: 'Tag', placeholder: 'e.g. chapter-3' });
    if (!tag) return;
    const tags = tag.split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean);
    await bulkUpdate(c => ({ ...c, tags: [...new Set([...(c.tags || []), ...tags])] }), 'Tagged');
  }
  async function resetSel() {
    if (!(await confirmDialog('Reset progress?', `${selected.size} card${selected.size === 1 ? '' : 's'} will become new again. Review history is kept.`, { okText: 'Reset' }))) return;
    await bulkUpdate(c => ({ ...c, ...newCardState(Date.now()) }), 'Reset');
  }
  async function deleteSel() {
    if (!(await confirmDialog('Delete cards?', `Permanently delete ${selected.size} card${selected.size === 1 ? '' : 's'}?`, { okText: 'Delete', danger: true }))) return;
    const ids = [...selected];
    await deleteCards(ids);
    cards = cards.filter(c => !selected.has(c.id));
    selected.clear();
    toast(`Deleted ${ids.length} card${ids.length === 1 ? '' : 's'}`);
    apply(true);
    ctx.refreshSidebar();
  }

  async function openCard(id) {
    const card = cards.find(c => c.id === id);
    if (!card) return;
    const logs = (await getAll('revlog')).filter(r => r.cardId === id).sort((a, b) => b.ts - a.ts);
    const now = Date.now();
    const result = await modal(close => {
      const ed = cardEditor({
        decks, card, submitText: 'Save changes', onCancel: () => close(null),
        onSubmit: async note => {
          const deckId = await ctx.resolveDeckId(note, decks);
          await updateNote(card, { ...note, deckId });
          close('saved');
        },
      });
      const info = (label, value) => h('div', {}, h('span', { class: 'muted' }, label), h('b', {}, value));
      const r = card.state === State.New ? null : fsrs.retrievability(card, now);
      const histList = logs.length ? h('details', { class: 'more' }, h('summary', {}, `Review history (${logs.length})`),
        h('table', { class: 'ret-table small' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Rating'), h('th', {}, 'State'), h('th', {}, 'Interval'), h('th', {}, 'Time'))),
          h('tbody', {}, ...logs.slice(0, 100).map(l => h('tr', {},
            h('td', {}, new Date(l.ts).toLocaleString()), h('td', {}, ['', 'Again', 'Hard', 'Good', 'Easy'][l.rating]), h('td', {}, STATE_NAMES[l.state]),
            h('td', {}, l.scheduledDays ? `${l.scheduledDays}d` : '<1d'), h('td', {}, l.durationMs ? `${Math.round(l.durationMs / 1000)}s` : '—')))))) : null;
      return h('div', { class: 'edit-modal' },
        h('div', { class: 'edit-head' },
          h('h2', {}, 'Edit card'),
          card.source?.url ? h('a', { class: 'btn sm ghost', href: card.source.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open source') : null,
          h('button', { class: 'btn sm', onclick: () => close(card.suspended ? 'unsuspend' : 'suspend') }, card.suspended ? 'Unsuspend' : 'Suspend'),
          h('button', { class: 'btn sm', onclick: () => close('reset') }, 'Reset'),
          h('button', { class: 'btn sm danger', onclick: () => close('delete') }, 'Delete'),
          h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, svgIcon('<path d="M18 6 6 18M6 6l12 12"/>'))),
        h('div', { class: 'card-info' },
          info('State', card.suspended ? 'Suspended' : STATE_NAMES[card.state]),
          info('Due', card.state === State.New ? 'New' : relTime(card.due, now)),
          info('Stability', card.state === State.New ? '—' : `${fmtNum(card.stability)} days`),
          info('Difficulty', card.state === State.New ? '—' : `${fmtNum(card.difficulty)} / 10`),
          info('Recall now', r == null ? '—' : `${Math.round(r * 100)}%`),
          info('Reviews', card.reps || 0),
          info('Lapses', card.lapses || 0),
          info('Added', card.created ? fmtDate(card.created) : '—')),
        ed.el, histList);
    }, { label: 'Edit card', wide: true });

    if (!result) return;
    if (result === 'delete') {
      if (!(await confirmDialog('Delete card?', 'This cannot be undone.', { okText: 'Delete', danger: true }))) return;
      await deleteCards([id]);
      toast('Card deleted');
    } else if (result === 'suspend' || result === 'unsuspend') {
      await saveCards([{ ...card, suspended: result === 'suspend', modified: Date.now() }]);
      toast(result === 'suspend' ? 'Card suspended' : 'Card unsuspended');
    } else if (result === 'reset') {
      await saveCards([{ ...card, ...newCardState(Date.now()), modified: Date.now() }]);
      toast('Card reset to new');
    } else toast('Card saved');
    const fresh = await ctx.reload();
    cards = fresh.cards;
    decks = fresh.decks;
    apply(true);
    ctx.refreshSidebar();
  }

  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => apply(), 150); });
  deckSel.addEventListener('change', () => apply());
  stateSel.addEventListener('change', () => apply());
  function onKey(e) {
    if (e.key === '/' && document.activeElement !== search && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !document.getElementById('modal').open) { e.preventDefault(); search.focus(); }
  }
  document.addEventListener('keydown', onKey);
  apply();
  search.focus();
  return () => document.removeEventListener('keydown', onKey);
}

function fmtNum(x) {
  const v = Number(x) || 0;
  return v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
