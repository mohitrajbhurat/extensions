import { h, svgIcon, toast, download, confirmDialog } from '../ui.js';
import { getAll, putMany, importBackup, cardsFromNote, deckByName, notifyChanged } from '../../lib/db.js';
import { exportJSON, exportCSV, exportAnki, parseJSON, importCSV, importAnki, detectFormat } from '../../lib/io.js';
import { stripCloze } from '../../lib/cloze.js';

const stamp = () => new Date().toISOString().slice(0, 10);
const MAX_FILE = 50 * 1024 * 1024;

export async function render(root, ctx) {
  const { data } = ctx;
  const decks = data.decks;
  const page = h('div', { class: 'page' });
  root.append(page);
  page.append(h('div', { class: 'page-head' }, h('h1', {}, 'Import / export')));

  // ---------- Export ----------
  const scope = h('select', { 'aria-label': 'Deck to export' }, new Option('All decks', ''), ...decks.map(d => new Option(d.name, d.id)));
  const deckName = id => decks.find(d => d.id === id)?.name || 'Default';
  const pick = async () => {
    const cards = await getAll('cards');
    return scope.value ? cards.filter(c => c.deckId === scope.value) : cards;
  };
  const slug = () => (scope.value ? deckName(scope.value).replace(/[^\w-]+/g, '-').toLowerCase() : 'all');
  async function exportAs(kind) {
    const cards = await pick();
    if (!cards.length) { toast('Nothing to export', 'error'); return; }
    if (kind === 'json') {
      const revlog = await getAll('revlog');
      const ids = new Set(cards.map(c => c.id));
      download(`recall-cards-${slug()}-${stamp()}.json`, exportJSON({ decks: scope.value ? decks.filter(d => d.id === scope.value) : decks, cards, revlog: revlog.filter(r => ids.has(r.cardId)) }), 'application/json');
    } else if (kind === 'csv') {
      download(`recall-cards-${slug()}-${stamp()}.csv`, exportCSV(cards, deckName), 'text/csv');
    } else {
      download(`recall-cards-${slug()}-${stamp()}.txt`, exportAnki(cards, deckName), 'text/plain');
    }
    toast('Export ready');
  }
  page.append(h('section', { class: 'card-surface section' },
    h('h2', {}, 'Export'),
    h('div', { class: 'export-row' }, scope,
      h('button', { class: 'btn primary', onclick: () => exportAs('json') }, svgIcon('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'), 'Full backup (JSON)'),
      h('button', { class: 'btn', onclick: () => exportAs('csv') }, 'CSV'),
      h('button', { class: 'btn', onclick: () => exportAs('anki') }, 'Anki text (.txt)')),
    h('ul', { class: 'small muted', style: { margin: 0, paddingLeft: '20px' } },
      h('li', {}, h('b', {}, 'JSON'), ' keeps everything — scheduling, review history, sources. Use it for backups and moving between browsers.'),
      h('li', {}, h('b', {}, 'CSV'), ' has columns front, back, deck, tags, type, source_url, source_title — opens in any spreadsheet.'),
      h('li', {}, h('b', {}, 'Anki text'), ' is tab-separated with Anki file headers: in Anki choose File → Import; note type (Basic/Cloze), deck and tags are picked up automatically.'))));

  // ---------- Import ----------
  const fileInput = h('input', { type: 'file', accept: '.json,.csv,.txt,.tsv,application/json,text/csv,text/plain', class: 'sr-only', id: 'importFile' });
  const drop = h('label', { class: 'drop', for: 'importFile', tabindex: '0' },
    svgIcon('<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>', 28),
    h('b', {}, 'Choose a file or drop it here'),
    h('span', { class: 'small muted' }, 'Recall Cards JSON backup, CSV (front, back, …), or Anki “Notes in Plain Text” (.txt)'));
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  const result = h('div', { style: { display: 'grid', gap: '16px' } });
  page.append(h('section', { class: 'card-surface section' }, h('h2', {}, 'Import'), fileInput, drop, result));

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); fileInput.value = ''; });

  async function handleFile(file) {
    result.replaceChildren();
    if (file.size > MAX_FILE) { toast('File is too large (max 50 MB).', 'error'); return; }
    let text;
    try { text = await file.text(); } catch { toast('Could not read the file.', 'error'); return; }
    const format = detectFormat(file.name, text);
    try {
      if (format === 'json') {
        const parsed = parseJSON(text);
        if (parsed.kind === 'backup') return showBackup(file.name, parsed);
        return showNotes(file.name, 'JSON', parsed.notes);
      }
      const notes = format === 'csv' ? importCSV(text) : importAnki(text);
      return showNotes(file.name, format === 'csv' ? 'CSV' : 'Anki text', notes);
    } catch (err) {
      result.replaceChildren(h('p', { class: 'err' }, `Could not parse ${file.name}: ${err.message || err}`));
    }
  }

  function showBackup(name, backup) {
    const mode = h('select', { style: { width: 'auto' }, 'aria-label': 'Import mode' }, new Option('Merge (keep existing, update matching)', 'merge'), new Option('Replace all my data', 'replace'));
    result.replaceChildren(
      h('p', { style: { margin: 0 } }, h('b', {}, name), ` — Recall Cards backup with ${backup.cards.length} cards, ${backup.decks.length} decks, ${backup.revlog.length} reviews.`),
      h('div', { class: 'export-row' }, mode,
        h('button', { class: 'btn primary', onclick: async () => {
          if (mode.value === 'replace' && !(await confirmDialog('Replace all data?', 'All current decks, cards and review history will be deleted and replaced by this backup.', { okText: 'Replace', danger: true }))) return;
          await importBackup(backup, mode.value === 'replace');
          toast(`Imported ${backup.cards.length} cards`);
          ctx.refreshSidebar();
          result.replaceChildren(h('p', { class: 'ok' }, `Done: ${backup.cards.length} cards imported.`), h('button', { class: 'btn', onclick: () => ctx.navigate('#decks') }, 'Go to decks'));
        } }, 'Import backup')));
  }

  function showNotes(name, label, notes) {
    if (!notes.length) { result.replaceChildren(h('p', { class: 'err' }, `No cards found in ${name}.`)); return; }
    const withDeck = notes.filter(n => n.deck).length;
    const target = h('select', { style: { width: 'auto' }, 'aria-label': 'Target deck' }, ...decks.map(d => new Option(d.name, d.id)));
    const useCol = h('input', { type: 'checkbox', checked: withDeck > 0 });
    const tagInput = h('input', { type: 'text', placeholder: 'extra tag (optional)', style: { width: '200px' } });
    const dedupe = h('input', { type: 'checkbox', checked: true });
    const cloze = notes.filter(n => n.type === 'cloze').length;
    result.replaceChildren(
      h('p', { style: { margin: 0 } }, h('b', {}, name), ` — ${label}, ${notes.length} note${notes.length === 1 ? '' : 's'}${cloze ? ` (${cloze} cloze)` : ''}.`),
      h('div', { class: 'preview-list' }, ...notes.slice(0, 6).map(n => h('div', { class: 'item' },
        h('span', {}, stripCloze(n.front).slice(0, 200)),
        n.back ? h('span', { class: 'small muted' }, n.back.slice(0, 200)) : null,
        h('span', { class: 'small muted' }, [n.deck && `Deck: ${n.deck}`, n.tags.length && `Tags: ${n.tags.join(' ')}`].filter(Boolean).join(' · '))))),
      notes.length > 6 ? h('p', { class: 'small muted', style: { margin: 0 } }, `…and ${notes.length - 6} more`) : null,
      h('div', { class: 'export-row' },
        h('span', { class: 'small' }, 'Into deck'), target,
        withDeck ? h('label', { class: 'check small' }, useCol, `Use the file's deck column (${withDeck} rows)`) : null,
        tagInput),
      h('label', { class: 'check small' }, dedupe, 'Skip cards whose front already exists'),
      h('div', {}, h('button', { class: 'btn primary', onclick: run }, `Import ${notes.length} note${notes.length === 1 ? '' : 's'}`)));

    async function run(e) {
      e.target.disabled = true;
      try {
        const existing = dedupe.checked ? new Set((await getAll('cards')).map(c => c.front.trim())) : new Set();
        const cache = new Map();
        const extra = tagInput.value.split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean);
        const all = [];
        let skipped = 0, failed = 0;
        const now = Date.now();
        for (let i = 0; i < notes.length; i++) {
          const n = notes[i];
          if (existing.has(n.front)) { skipped++; continue; }
          existing.add(n.front);
          const deckId = useCol.checked && n.deck ? (await deckByName(n.deck, cache)).id : target.value;
          try {
            all.push(...cardsFromNote({ type: n.type, front: n.front, back: n.back, deckId, tags: [...new Set([...n.tags, ...extra])], source: n.sourceUrl ? { url: n.sourceUrl, title: n.sourceTitle } : null }, now + i * 3));
          } catch { failed++; }
        }
        for (let i = 0; i < all.length; i += 500) await putMany('cards', all.slice(i, i + 500));
        notifyChanged('cards');
        ctx.refreshSidebar();
        toast(`Imported ${all.length} card${all.length === 1 ? '' : 's'}`);
        result.replaceChildren(
          h('p', { class: 'ok', style: { margin: 0 } }, `Imported ${all.length} card${all.length === 1 ? '' : 's'}.`
            + (skipped ? ` Skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}.` : '') + (failed ? ` ${failed} row${failed === 1 ? '' : 's'} could not be read.` : '')),
          h('div', { class: 'export-row' }, h('button', { class: 'btn', onclick: () => ctx.navigate('#decks') }, 'Go to decks'), h('button', { class: 'btn', onclick: () => ctx.navigate('#browse') }, 'Browse cards')));
      } catch (err) {
        e.target.disabled = false;
        toast('Import failed: ' + (err.message || err), 'error');
      }
    }
  }
}
