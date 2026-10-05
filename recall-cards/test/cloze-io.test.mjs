import test from 'node:test';
import assert from 'node:assert/strict';
import { clozeNumbers, renderCloze, buildCloze, tokenize, wrapCloze, stripCloze, hasCloze } from '../lib/cloze.js';
import { parseDelimited, formatDelimited, importCSV, exportCSV, importAnki, exportAnki, parseJSON, exportJSON, detectFormat } from '../lib/io.js';

test('cloze numbers, render and strip', () => {
  const t = 'The {{c1::mitochondria}} is the {{c2::powerhouse::what?}} of the <cell>';
  assert.deepEqual(clozeNumbers(t), [1, 2]);
  assert.ok(hasCloze(t));
  const front = renderCloze(t, 2, false);
  assert.match(front, /\[what\?\]/);
  assert.match(front, /mitochondria/);
  assert.match(front, /&lt;cell&gt;/);
  assert.match(renderCloze(t, 1, true), /cloze-revealed">mitochondria/);
  assert.equal(stripCloze(t), 'The mitochondria is the powerhouse of the <cell>');
});

test('click-to-cloze merges adjacent selected words', () => {
  const tokens = tokenize('Paris is the capital of France.');
  const idx = w => tokens.findIndex(t => t.text === w);
  assert.equal(buildCloze(tokens, new Set([idx('Paris')]), true), '{{c1::Paris}} is the capital of France.');
  assert.equal(buildCloze(tokens, new Set([idx('capital'), idx('of'), idx('France')]), true), 'Paris is the {{c1::capital of France}}.');
  assert.equal(buildCloze(tokens, new Set([idx('Paris'), idx('France')]), true), '{{c1::Paris}} is the capital of {{c2::France}}.');
  assert.equal(buildCloze(tokens, new Set([idx('Paris'), idx('France')]), false), '{{c1::Paris}} is the capital of {{c1::France}}.');
});

test('wrapCloze picks the next number', () => {
  const r = wrapCloze('{{c1::a}} b c', 10, 11);
  assert.equal(r.text, '{{c1::a}} {{c2::b}} c');
});

test('delimited parser handles quotes, delimiters and newlines', () => {
  const rows = parseDelimited('a,"b, ""x""",c\n"multi\nline",2,3\n');
  assert.deepEqual(rows, [['a', 'b, "x"', 'c'], ['multi\nline', '2', '3']]);
  const round = parseDelimited(formatDelimited(rows, '\t'), '\t');
  assert.deepEqual(round, rows);
});

test('CSV import with header and round trip', () => {
  const cards = [{ id: '1', noteId: 'n1', deckId: 'd', type: 'basic', front: 'Q, "one"', back: 'A\nline', tags: ['x', 'y'], source: { url: 'https://e.com', title: 'E' } }];
  const csv = exportCSV(cards, () => 'Deck A');
  const notes = importCSV(csv);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].front, 'Q, "one"');
  assert.equal(notes[0].back, 'A\nline');
  assert.equal(notes[0].deck, 'Deck A');
  assert.deepEqual(notes[0].tags, ['x', 'y']);
  assert.equal(notes[0].sourceUrl, 'https://e.com');
});

test('Anki text import: headers, html and cloze; export round-trip', () => {
  const txt = '#separator:tab\n#html:true\n#tags column:3\nWhat is <b>2+2</b>?\t4<br>four\tmath easy\n{{c1::Paris}} is in France\t\tgeo\n';
  const notes = importAnki(txt);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].front, 'What is 2+2?');
  assert.equal(notes[0].back, '4\nfour');
  assert.deepEqual(notes[0].tags, ['math', 'easy']);
  assert.equal(notes[1].type, 'cloze');
  const cards = [
    { id: 'a', noteId: 'n', deckId: 'd', type: 'cloze', front: '{{c1::A}} & {{c2::B}}', back: '', tags: ['t'], clozeIndex: 1 },
    { id: 'b', noteId: 'n', deckId: 'd', type: 'cloze', front: '{{c1::A}} & {{c2::B}}', back: '', tags: ['t'], clozeIndex: 2 },
  ];
  const out = exportAnki(cards, () => 'My Deck');
  assert.match(out, /^#separator:tab/);
  const back = importAnki(out);
  assert.equal(back.length, 1, 'cloze siblings exported once');
  assert.equal(back[0].front, '{{c1::A}} & {{c2::B}}');
  assert.equal(back[0].deck, 'My Deck');
  assert.equal(back[0].type, 'cloze');
});

test('Anki import without headers: front, back, tags', () => {
  const notes = importAnki('Q1\tA1\nQ2\tA2\ttag1\n');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes[1].tags, ['tag1']);
});

test('JSON backup and plain arrays', () => {
  const backup = parseJSON(exportJSON({ decks: [{ id: 'd', name: 'D' }], cards: [{ id: 'c', front: 'f' }], revlog: [] }));
  assert.equal(backup.kind, 'backup');
  assert.equal(backup.cards.length, 1);
  const plain = parseJSON('[{"question":"q","answer":"a","tags":"x y"}]');
  assert.equal(plain.kind, 'notes');
  assert.deepEqual(plain.notes[0].tags, ['x', 'y']);
  assert.throws(() => parseJSON('{"foo":1}'));
});

test('format detection', () => {
  assert.equal(detectFormat('x.json', '{}'), 'json');
  assert.equal(detectFormat('x.csv', 'a,b'), 'csv');
  assert.equal(detectFormat('x.txt', 'a\tb'), 'anki');
  assert.equal(detectFormat('', '#separator:tab\n'), 'anki');
});
