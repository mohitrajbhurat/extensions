import { h, svgIcon, toast, confirmDialog, promptDialog } from '../ui.js';
import { createDeck, renameDeck, deleteDeck, addNote } from '../../lib/db.js';

const SAMPLE = [
  { front: 'What is the "forgetting curve"?', back: 'The exponential decline of memory retention over time without review, first described by Hermann Ebbinghaus (1885).' },
  { front: 'The {{c1::spacing effect}} is the finding that learning is more durable when study sessions are {{c2::spread out over time}}.', back: '' },
  { front: 'What is "retrieval practice"?', back: 'Actively recalling information from memory (e.g. answering flashcards) — it strengthens memory more than re-reading.' },
  { front: 'In FSRS, {{c1::stability}} is the number of days for recall probability to fall from 100% to 90%.', back: '' },
  { front: 'In FSRS, what does "difficulty" (1–10) model?', back: 'How hard it is to increase a card\'s stability after a successful review.' },
  { front: 'FSRS stands for {{c1::Free Spaced Repetition Scheduler}}.', back: '' },
  { front: 'Why prefer cloze deletions for factual sentences?', back: 'They keep the original context and test one fact at a time, which makes cards quick to write and quick to review.' },
  { front: 'What does "desired retention" control?', back: 'The target recall probability when a card comes due. Higher = more reviews, better memory.' },
];

export async function render(root, ctx) {
  const { data } = ctx;
  const page = h('div', { class: 'page' });
  root.append(page);

  const totals = ctx.countsFor(data);
  const studied = new Set(data.revlogToday.map(r => r.cardId)).size;

  page.append(h('div', { class: 'page-head' },
    h('h1', {}, 'Decks'),
    h('button', { class: 'btn', onclick: newDeck }, svgIcon('<path d="M12 5v14M5 12h14"/>'), 'New deck'),
    h('button', { class: 'btn', onclick: () => ctx.navigate('#add') }, 'Add cards')));

  if (!data.cards.length) {
    page.append(h('section', { class: 'card-surface empty' },
      h('div', { class: 'done-card', style: { padding: 0 } }, h('div', { class: 'emoji' }, svgIcon('<rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v11"/>', 28))),
      h('h2', {}, ctx.params.get('welcome') ? 'Welcome to Recall Cards' : 'No cards yet'),
      h('p', { class: 'muted' }, 'Select text on any web page, right-click and choose “Make flashcard”. Turn highlights into question/answer cards or click words to create cloze deletions. Cards are scheduled with FSRS so you review them right before you would forget.'),
      h('div', { class: 'export-row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary', onclick: () => ctx.navigate('#add') }, 'Add your first card'),
        h('button', { class: 'btn', onclick: addSamples }, 'Add a sample deck'),
        h('button', { class: 'btn ghost', onclick: () => ctx.navigate('#io') }, 'Import from Anki / CSV'))));
  } else {
    page.append(h('section', { class: 'card-surface today-strip' },
      h('div', {}, h('div', { class: 'big' }, totals.total), h('div', { class: 'small muted' }, 'due today')),
      h('div', {}, h('div', { class: 'small muted' }, h('b', { class: 'n-new' }, totals.new), ' new · ', h('b', { class: 'n-learn' }, totals.learning), ' learning · ', h('b', { class: 'n-review' }, totals.review), ' review'),
        h('div', { class: 'small muted' }, `${studied} card${studied === 1 ? '' : 's'} studied today`)),
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn primary lg', disabled: totals.total === 0, onclick: () => ctx.navigate('#review') }, totals.total ? 'Study all decks' : 'All caught up')));
  }

  const table = h('table', { class: 'deck-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Deck'), h('th', { scope: 'col' }, 'New'), h('th', { scope: 'col' }, 'Learning'), h('th', { scope: 'col' }, 'Due'), h('th', { scope: 'col' }, 'Cards'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))));
  const tbody = h('tbody');
  table.append(tbody);
  for (const d of data.decks) {
    const c = ctx.countsFor(data, new Set([d.id]));
    const total = data.cards.filter(x => x.deckId === d.id).length;
    const num = (v, cls) => h('td', { class: v ? cls : 'zero' }, v);
    tbody.append(h('tr', {},
      h('td', {}, h('button', { class: 'deck-name', title: c.total ? 'Study this deck' : 'Browse this deck', onclick: () => ctx.navigate(c.total ? `#review?deck=${d.id}` : `#browse?deck=${d.id}`) }, d.name)),
      num(c.new, 'n-new'), num(c.learning, 'n-learn'), num(c.review, 'n-review'), h('td', { class: 'muted' }, total),
      h('td', { class: 'actions' },
        h('button', { class: 'btn sm primary', disabled: !c.total, onclick: () => ctx.navigate(`#review?deck=${d.id}`) }, 'Study'), ' ',
        h('button', { class: 'icon-btn', title: 'Add card to this deck', 'aria-label': `Add card to ${d.name}`, onclick: () => ctx.navigate(`#add?deck=${d.id}`) }, svgIcon('<path d="M12 5v14M5 12h14"/>')),
        h('button', { class: 'icon-btn', title: 'Browse cards', 'aria-label': `Browse ${d.name}`, onclick: () => ctx.navigate(`#browse?deck=${d.id}`) }, svgIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')),
        h('button', { class: 'icon-btn', title: 'Rename', 'aria-label': `Rename ${d.name}`, onclick: () => rename(d) }, svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>')),
        h('button', { class: 'icon-btn', title: 'Delete deck', 'aria-label': `Delete ${d.name}`, onclick: () => remove(d, total) }, svgIcon('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>')))));
  }
  if (data.decks.length > 1) {
    tbody.append(h('tr', { class: 'total' }, h('td', {}, 'All decks'), h('td', {}, totals.new), h('td', {}, totals.learning), h('td', {}, totals.review), h('td', {}, data.cards.length), h('td')));
  }
  page.append(h('section', { class: 'card-surface', style: { overflow: 'hidden' } }, table));

  page.append(h('p', { class: 'small muted' }, 'Tip: select text on any page and right-click → ', h('b', {}, 'Make flashcard'), '. In review use ', h('span', { class: 'kbd' }, 'Space'), ' to flip and ', h('span', { class: 'kbd' }, '1'), '–', h('span', { class: 'kbd' }, '4'), ' to rate.'));

  async function newDeck() {
    const name = await promptDialog('New deck', { label: 'Name', placeholder: 'e.g. Biology' });
    if (!name) return;
    await createDeck(name);
    toast(`Deck “${name}” created`);
    ctx.navigate('#decks');
  }
  async function rename(d) {
    const name = await promptDialog('Rename deck', { label: 'Name', value: d.name });
    if (!name || name === d.name) return;
    await renameDeck(d.id, name);
    toast('Deck renamed');
    ctx.navigate('#decks');
  }
  async function remove(d, total) {
    const ok = await confirmDialog(`Delete “${d.name}”?`, total ? `This permanently deletes the deck and its ${total} card${total === 1 ? '' : 's'}. Export a backup first if unsure.` : 'The deck is empty.', { okText: 'Delete', danger: true });
    if (!ok) return;
    await deleteDeck(d.id);
    toast('Deck deleted');
    ctx.navigate('#decks');
  }
  async function addSamples() {
    const deck = await createDeck('Learning science (sample)');
    for (const s of SAMPLE) await addNote({ ...s, deckId: deck.id, tags: ['sample'], source: { url: 'https://github.com/open-spaced-repetition/fsrs4anki/wiki', title: 'FSRS wiki' } });
    toast('Sample deck added');
    ctx.navigate('#decks');
  }
}
