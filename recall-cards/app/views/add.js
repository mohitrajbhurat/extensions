import { h, toast, cardEditor } from '../ui.js';
import { addNote } from '../../lib/db.js';
import { saveSettings } from '../../lib/settings.js';
import { preview } from '../../lib/render.js';

export async function render(root, ctx) {
  const { data } = ctx;
  let decks = data.decks;
  const page = h('div', { class: 'page' });
  root.append(page);

  let prefill = {};
  if (new URLSearchParams(location.search).get('prefill')) {
    try {
      const { prefill: p } = await chrome.storage.session.get('prefill');
      if (p && Date.now() - p.ts < 10 * 60 * 1000) prefill = p;
      await chrome.storage.session.remove('prefill');
    } catch {}
    history.replaceState(null, '', location.pathname + location.hash);
  }

  const deckParam = ctx.params.get('deck');
  const deckId = decks.find(d => d.id === deckParam) ? deckParam : (decks.find(d => d.id === data.settings.lastDeckId) ? data.settings.lastDeckId : decks[0]?.id);
  const recent = h('div', { class: 'preview-list' });

  const editor = cardEditor({
    decks, deckId, submitText: 'Add card',
    back: prefill.back || '',
    source: prefill.url ? { url: prefill.url, title: prefill.title } : null,
    onSubmit: async note => {
      const id = await ctx.resolveDeckId(note, decks);
      const cards = await addNote({ ...note, deckId: id });
      await saveSettings({ lastDeckId: id });
      if (note.newDeckName) decks = (await ctx.reload()).decks;
      const deckName = decks.find(d => d.id === id)?.name || '';
      for (const c of cards) recent.prepend(h('div', { class: 'item' }, h('span', {}, preview(c)), h('span', { class: 'small muted' }, deckName)));
      recentSection.classList.remove('hidden');
      editor.setStatus(`Added ${cards.length} card${cards.length === 1 ? '' : 's'} to ${deckName}.`, 'ok');
      toast(`Added ${cards.length} card${cards.length === 1 ? '' : 's'}`);
      editor.reset();
      ctx.refreshSidebar();
      if (note.newDeckName) ctx.navigate(`#add?deck=${id}`);
    },
  });

  page.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Add cards'),
      h('p', { class: 'sub small muted' }, 'Write a question and answer, or type text and press ', h('span', { class: 'kbd' }, 'Ctrl+Shift+C'), ' on a selection to make a cloze deletion. One card is created per cloze number.')),
    h('section', { class: 'card-surface section' }, editor.el));
  const recentSection = h('section', { class: 'card-surface section hidden' }, h('h2', {}, 'Added this session'), recent);
  page.append(recentSection);
  if (prefill.back) toast('Selection added to the Back field — write a question on the Front.');
  setTimeout(() => editor.focus(), 0);
}
