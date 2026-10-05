import { ensureDefaultDeck, getAll, addNote, revlogSince } from '../lib/db.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { dueCounts, dayStart, newStudiedToday } from '../lib/queue.js';
import { hasCloze, wrapCloze } from '../lib/cloze.js';
import { splitTags } from '../lib/io.js';

const $ = id => document.getElementById(id);

async function openApp(hash) {
  try { await chrome.runtime.sendMessage({ type: 'openApp', hash }); }
  catch { await chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') + hash }); }
  window.close();
}

async function refresh() {
  const s = await getSettings();
  const now = Date.now();
  const [cards, revlog] = await Promise.all([getAll('cards'), revlogSince(dayStart(now, s.rolloverHour))]);
  const c = dueCounts(cards, { now, rolloverHour: s.rolloverHour, newPerDay: s.newPerDay, newStudied: newStudiedToday(revlog, now, s.rolloverHour) });
  $('dueTotal').textContent = c.total;
  $('dueLabel').textContent = cards.length === 0 ? 'no cards yet' : c.total === 1 ? 'card due' : c.total ? 'cards due' : 'all caught up';
  $('cNew').textContent = c.new;
  $('cLearn').textContent = c.learning;
  $('cReview').textContent = c.review;
  $('startReview').disabled = c.total === 0;
  $('startReview').textContent = c.total ? 'Start review' : cards.length ? 'Nothing due' : 'Add a card first';
}

async function fillDecks() {
  const decks = await ensureDefaultDeck();
  const s = await getSettings();
  const sel = $('qDeck');
  sel.replaceChildren(...decks.map(d => new Option(d.name, d.id)));
  if (decks.find(d => d.id === s.lastDeckId)) sel.value = s.lastDeckId;
}

function setStatus(text, cls = '') {
  const el = $('qStatus');
  el.textContent = text;
  el.className = 'small ' + (cls || 'muted');
}

$('quickForm').addEventListener('submit', async e => {
  e.preventDefault();
  const front = $('qFront').value.trim();
  const back = $('qBack').value.trim();
  if (!front) { setStatus('Front is required.', 'err'); $('qFront').focus(); return; }
  try {
    const cards = await addNote({ type: hasCloze(front) ? 'cloze' : 'basic', front, back, deckId: $('qDeck').value, tags: splitTags($('qTags').value) });
    await saveSettings({ lastDeckId: $('qDeck').value });
    $('qFront').value = '';
    $('qBack').value = '';
    setStatus(`Added ${cards.length} card${cards.length === 1 ? '' : 's'}.`, 'ok');
    $('qFront').focus();
    refresh();
  } catch (err) {
    setStatus(err.message || String(err), 'err');
  }
});

function clozeWrap() {
  const ta = $('qFront');
  const { text, cursor } = wrapCloze(ta.value, ta.selectionStart, ta.selectionEnd);
  ta.value = text;
  ta.focus();
  ta.setSelectionRange(cursor, cursor);
}
$('qCloze').addEventListener('click', clozeWrap);
$('quickForm').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('quickForm').requestSubmit(); }
  if (e.key.toLowerCase() === 'c' && e.shiftKey && (e.ctrlKey || e.metaKey) && e.target.id === 'qFront') { e.preventDefault(); clozeWrap(); }
});

$('startReview').addEventListener('click', () => openApp('#review'));
$('openApp').addEventListener('click', () => openApp('#decks'));
$('capture').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'captureActiveTab' }).catch(() => null);
  if (r && r.error) setStatus(r.error, 'err');
  else window.close();
});
for (const a of document.querySelectorAll('.links a')) a.addEventListener('click', e => { e.preventDefault(); openApp(a.dataset.hash); });

fillDecks();
refresh();
