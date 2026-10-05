import { h, svgIcon, toast, modal, confirmDialog, cardEditor, relTime } from '../ui.js';
import { FSRS, Rating, State, STATE_NAMES, formatInterval } from '../../lib/fsrs.js';
import { nextCard, selectDue, dueCounts, newStudiedToday, LEARN_AHEAD_MS } from '../../lib/queue.js';
import { renderFront, renderBack } from '../../lib/render.js';
import { recordReview, undoReview, saveCards, updateNote, deleteCards, getAll, onChanged } from '../../lib/db.js';
import { schedulerOptions } from '../../lib/settings.js';

const LABELS = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const CLASSES = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
const MAX_ANSWER_MS = 5 * 60 * 1000;

export async function render(root, ctx) {
  const { data } = ctx;
  const settings = data.settings;
  const fsrs = new FSRS(schedulerOptions(settings));
  let cards = data.cards.slice();
  let revlogToday = data.revlogToday.slice();
  let decks = data.decks;
  const deckParam = ctx.params.get('deck');
  let deckIds = deckParam && decks.find(d => d.id === deckParam) ? new Set([deckParam]) : null;

  let current = null;
  let flipped = false;
  let shownAt = 0;
  let previews = null;
  let busy = false;
  let reviewed = 0;
  let waitTimer = null;
  const history = [];

  const page = h('div', { class: 'page' });
  root.append(page);

  const deckSel = h('select', { 'aria-label': 'Deck to study' }, new Option('All decks', ''), ...decks.map(d => new Option(d.name, d.id)));
  deckSel.value = deckIds ? deckParam : '';
  deckSel.addEventListener('change', () => { ctx.navigate(deckSel.value ? `#review?deck=${deckSel.value}` : '#review'); });
  const cNew = h('span', { class: 'chip n-new', title: 'New' });
  const cLearn = h('span', { class: 'chip n-learn', title: 'Learning' });
  const cRev = h('span', { class: 'chip n-review', title: 'Review' });
  const progressBar = h('div');
  const top = h('div', { class: 'review-top' },
    h('h1', { style: { fontSize: '20px' } }, 'Review'), deckSel,
    h('div', { class: 'counts', 'aria-label': 'Remaining cards' }, cNew, cLearn, cRev));
  const stage = h('div', { style: { display: 'grid', gap: '16px', alignContent: 'start' } });
  const bar = h('div', { class: 'review-bar' });
  page.append(h('div', { style: { display: 'grid', gap: '12px' } }, top, h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Session progress' }, progressBar)), stage, bar);

  const opts = () => ({ now: Date.now(), rolloverHour: settings.rolloverHour, newPerDay: settings.newPerDay, newStudied: newStudiedToday(revlogToday, Date.now(), settings.rolloverHour), deckIds, reviewedThisSession: reviewed });
  const deckName = id => decks.find(d => d.id === id)?.name || '—';

  function updateCounts() {
    const c = dueCounts(cards, opts());
    cNew.textContent = `${c.new} new`;
    cLearn.textContent = `${c.learning} learning`;
    cRev.textContent = `${c.review} review`;
    for (const el of [cNew, cLearn, cRev]) el.classList.remove('active');
    if (current) {
      const el = current.state === State.New ? cNew : current.state === State.Review ? cRev : cLearn;
      el.classList.add('active');
    }
    const remaining = c.total + (current && current.due > Date.now() ? 1 : 0);
    const pct = reviewed + remaining ? (reviewed / (reviewed + remaining)) * 100 : 100;
    progressBar.style.width = `${pct}%`;
    progressBar.parentElement.setAttribute('aria-valuenow', Math.round(pct));
  }

  function showNext() {
    clearTimeout(waitTimer);
    current = nextCard(cards, opts());
    flipped = false;
    if (!current) return showDone();
    shownAt = Date.now();
    previews = fsrs.preview(current, shownAt);
    drawCard();
  }

  function drawCard() {
    updateCounts();
    const c = current;
    const meta = h('div', { class: 'meta' },
      h('span', { class: `state s${c.state}` }, STATE_NAMES[c.state]),
      h('span', { class: 'chip' }, deckName(c.deckId)),
      ...(c.tags || []).slice(0, 6).map(t => h('span', { class: 'chip' }, '#' + t)));
    const face = h('div', { class: 'face', html: flipped ? renderBack(c) : renderFront(c) });
    stage.replaceChildren(h('article', { class: 'review-card card-surface', 'aria-live': 'polite' }, meta, face));
    if (flipped) {
      const answer = face.querySelector('#answer');
      if (answer) answer.scrollIntoView({ block: 'nearest' });
    }
    drawBar();
  }

  function drawBar() {
    const tools = h('div', { class: 'review-tools' },
      h('button', { class: 'btn sm ghost', disabled: !history.length, onclick: undo, title: 'Undo last rating (Z)' }, svgIcon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 14), 'Undo'),
      h('button', { class: 'btn sm ghost', onclick: edit, title: 'Edit card (E)' }, svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>', 14), 'Edit'),
      h('button', { class: 'btn sm ghost', onclick: suspend, title: 'Suspend card (S)' }, svgIcon('<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>', 14), 'Suspend'),
      h('button', { class: 'btn sm ghost', onclick: del, title: 'Delete card (Shift+Delete)' }, svgIcon('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>', 14), 'Delete'));
    if (!flipped) {
      bar.replaceChildren(
        h('button', { class: 'btn primary lg flip-btn', onclick: flip }, 'Show answer ', h('span', { class: 'kbd' }, 'Space')),
        tools);
    } else {
      const ratings = h('div', { class: 'ratings', role: 'group', 'aria-label': 'Rate your recall' },
        ...[1, 2, 3, 4].map(g => h('button', { class: `rate ${CLASSES[g]}`, onclick: () => rate(g), 'aria-keyshortcuts': String(g) },
          h('span', { class: 'lbl' }, LABELS[g]),
          settings.showIntervals ? h('span', { class: 'ivl' }, formatInterval(previews[g].intervalMs)) : null,
          h('span', { class: 'key' }, String(g)))));
      bar.replaceChildren(ratings, tools);
      const good = ratings.querySelector('.good');
      if (good && document.activeElement && document.activeElement.classList.contains('flip-btn')) good.focus();
    }
  }

  function flip() {
    if (!current || flipped) return;
    flipped = true;
    drawCard();
  }

  async function rate(g) {
    if (!current || !flipped || busy) return;
    busy = true;
    try {
      const now = Date.now();
      const prev = { ...current };
      const { card: next, log } = fsrs.review(current, g, now);
      const entry = await recordReview(next, { ...log, cardId: current.id, deckId: current.deckId, durationMs: Math.min(now - shownAt, MAX_ANSWER_MS) });
      history.push({ prev, logId: entry.id });
      if (history.length > 50) history.shift();
      cards = cards.map(c => (c.id === next.id ? next : c));
      revlogToday.push(entry);
      reviewed++;
      showNext();
    } catch (err) {
      toast('Could not save review: ' + (err.message || err), 'error');
    } finally {
      busy = false;
    }
  }

  async function undo() {
    const last = history.pop();
    if (!last || busy) return;
    busy = true;
    try {
      await undoReview(last.prev, last.logId);
      cards = cards.map(c => (c.id === last.prev.id ? last.prev : c));
      revlogToday = revlogToday.filter(r => r.id !== last.logId);
      reviewed = Math.max(0, reviewed - 1);
      current = last.prev;
      flipped = false;
      shownAt = Date.now();
      previews = fsrs.preview(current, shownAt);
      drawCard();
      toast('Undid last rating');
    } finally { busy = false; }
  }

  async function edit() {
    if (!current) return;
    const card = current;
    const saved = await modal(close => {
      const ed = cardEditor({
        decks, card, submitText: 'Save changes', onCancel: () => close(null),
        onSubmit: async note => {
          const deckId = await ctx.resolveDeckId(note, decks);
          await updateNote(card, { ...note, deckId });
          close(true);
        },
      });
      return h('div', { class: 'edit-modal' }, h('div', { class: 'edit-head' }, h('h2', {}, 'Edit card')), ed.el);
    }, { label: 'Edit card', wide: true });
    if (saved) {
      const fresh = await ctx.reload();
      decks = fresh.decks;
      cards = fresh.cards;
      current = cards.find(c => c.id === card.id) || null;
      if (!current) return showNext();
      previews = fsrs.preview(current, Date.now());
      drawCard();
      toast('Card updated');
    }
  }

  async function suspend() {
    if (!current) return;
    const c = { ...current, suspended: true, modified: Date.now() };
    await saveCards([c]);
    cards = cards.map(x => (x.id === c.id ? c : x));
    toast('Card suspended. Unsuspend it from Browse.');
    showNext();
  }

  async function del() {
    if (!current) return;
    const ok = await confirmDialog('Delete this card?', current.type === 'cloze' ? 'Only this cloze card is deleted; sibling cards from the same note are kept.' : 'This cannot be undone.', { okText: 'Delete', danger: true });
    if (!ok) return;
    await deleteCards([current.id]);
    const id = current.id;
    cards = cards.filter(c => c.id !== id);
    history.splice(0, history.length, ...history.filter(x => x.prev.id !== id));
    toast('Card deleted');
    showNext();
  }

  function showDone() {
    updateCounts();
    const s = selectDue(cards, opts());
    const pending = s.learningLater[0];
    const inDeck = c => !deckIds || deckIds.has(c.deckId);
    const upcoming = cards.filter(c => !c.suspended && c.state !== State.New && inDeck(c)).sort((a, b) => a.due - b.due)[0];
    const msg = reviewed
      ? `You reviewed ${reviewed} card${reviewed === 1 ? '' : 's'} this session.`
      : cards.some(inDeck) ? 'Nothing is due right now.' : 'This deck has no cards yet.';
    const next = pending
      ? `A learning card returns ${relTime(pending.due)}. This page will show it automatically.`
      : upcoming ? `Next review ${relTime(upcoming.due)}.` : '';
    const newLeft = s.newTotal - s.newCards.length;
    stage.replaceChildren(h('section', { class: 'card-surface done-card' },
      h('div', { class: 'emoji' }, svgIcon('<path d="M20 6 9 17l-5-5"/>', 32)),
      h('h2', {}, reviewed ? 'Session complete' : 'All caught up'),
      h('p', { class: 'muted', style: { margin: 0 } }, msg),
      next ? h('p', { class: 'small muted', style: { margin: 0 } }, next) : null,
      newLeft > 0 && s.newCards.length === 0 ? h('p', { class: 'small muted', style: { margin: 0 } }, `Daily new-card limit reached (${settings.newPerDay}). ${newLeft} new card${newLeft === 1 ? '' : 's'} waiting — change the limit in Settings.`) : null,
      h('div', { class: 'export-row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary', onclick: () => ctx.navigate('#decks') }, 'Back to decks'),
        h('button', { class: 'btn', onclick: () => ctx.navigate('#stats') }, 'Statistics'),
        h('button', { class: 'btn', onclick: () => ctx.navigate('#add') }, 'Add cards'))));
    bar.replaceChildren(history.length ? h('div', { class: 'review-tools' }, h('button', { class: 'btn sm ghost', onclick: undo }, 'Undo last rating')) : '');
    ctx.refreshSidebar();
    if (pending) {
      const wait = Math.max(1000, pending.due - LEARN_AHEAD_MS - Date.now());
      waitTimer = setTimeout(showNext, Math.min(wait, 60000));
    }
  }

  function onKey(e) {
    if (document.getElementById('modal').open) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.altKey || e.metaKey || (e.ctrlKey && e.key.toLowerCase() !== 'z')) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (!current) return;
      if (t && t.tagName === 'BUTTON' && k === 'Enter') return; // let focused buttons act
      e.preventDefault();
      if (!flipped) flip(); else rate(Rating.Good);
    } else if (flipped && /^[1-4]$/.test(k)) { e.preventDefault(); rate(Number(k)); }
    else if (k.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (k.toLowerCase() === 'e' && current) { e.preventDefault(); edit(); }
    else if (k.toLowerCase() === 's' && current) { e.preventDefault(); suspend(); }
    else if (k === 'Delete' && e.shiftKey && current) { e.preventDefault(); del(); }
  }
  document.addEventListener('keydown', onKey);

  // Pick up cards added elsewhere (e.g. captured from another tab) when idle.
  let alive = true;
  onChanged(async what => {
    if (!alive || what === 'review' || current) return;
    const fresh = await getAll('cards');
    cards = fresh;
    showNext();
  });

  page.append(h('div', { class: 'shortcut-hint' },
    h('span', {}, h('span', { class: 'kbd' }, 'Space'), ' flip / Good'),
    h('span', {}, h('span', { class: 'kbd' }, '1'), '–', h('span', { class: 'kbd' }, '4'), ' rate'),
    h('span', {}, h('span', { class: 'kbd' }, 'Z'), ' undo'),
    h('span', {}, h('span', { class: 'kbd' }, 'E'), ' edit'),
    h('span', {}, h('span', { class: 'kbd' }, 'S'), ' suspend')));

  showNext();

  return () => {
    alive = false;
    clearTimeout(waitTimer);
    document.removeEventListener('keydown', onKey);
  };
}
