// Unit tests for the offline text engine (lib/nlp.js) and the PDF reader (lib/pdf.js).
// Run: node --test page-assistant/test/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const load = (() => {
  let p;
  return () => (p || (p = import(path.resolve(__dirname, '..', 'lib', 'nlp.js'))));
})();

const ARTICLE = `Honeybee colonies across North America are recovering after a decade of losses. Beekeepers reported winter losses of 18 percent, the lowest since 2007.

The varroa mite is a parasite that spreads viruses between bees. Colonies with heavy mite infestations usually fail during winter. Dr. Amara Singh said that controlling mites in late summer is the single most important step a beekeeper can take.

Wildflower strips give bees a varied diet through the season. Farmers in the U.S. have planted more than two million acres of these strips. A varied diet strengthens colonies and helps them resist disease, e.g. fungal infections.

Wild bumblebee populations continue to decline. Scientists warn that the recovery of managed honeybees should not distract from the needs of native species.`;

const BLOCKS = [
  { type: 'heading', level: 1, text: 'The Return of the Honeybee' },
  { type: 'p', text: 'Honeybee colonies across North America are recovering after a decade of losses. Beekeepers reported winter losses of 18 percent, the lowest since 2007.' },
  { type: 'heading', level: 2, text: 'The varroa mite' },
  { type: 'p', text: 'The varroa mite is a parasite that spreads viruses between bees. Colonies with heavy mite infestations usually fail during winter.' },
  { type: 'heading', level: 2, text: 'Forage' },
  { type: 'p', text: 'Wildflower strips give bees a varied diet through the season. Farmers have planted more than two million acres of these strips.' },
  { type: 'li', text: 'Mite treatments based on oxalic acid are now widely available.' },
];

test('splitSentences handles abbreviations, initials and quotes', async () => {
  const { splitSentences } = await load();
  const s = splitSentences('Dr. Singh works at the U.S. lab. She studies mites, e.g. varroa. "It matters," she said. Does it? Yes!');
  assert.deepStrictEqual(s, [
    'Dr. Singh works at the U.S. lab.',
    'She studies mites, e.g. varroa.',
    '"It matters," she said.',
    'Does it?',
    'Yes!',
  ]);
});

test('splitSentences treats paragraph breaks as boundaries', async () => {
  const { splitSentences } = await load();
  assert.deepStrictEqual(splitSentences('A title with no period\n\nThen a sentence.'), ['A title with no period', 'Then a sentence.']);
});

test('Porter stemmer folds inflections together', async () => {
  const { stem } = await load();
  assert.strictEqual(stem('running'), stem('runs'));
  assert.strictEqual(stem('colonies'), stem('colony'));
  assert.strictEqual(stem('ponies'), 'poni');
  assert.strictEqual(stem('agreed'), 'agre');
  assert.strictEqual(stem('feed'), 'feed');
});

test('readingStats computes Flesch, grade and reading time', async () => {
  const { readingStats } = await load();
  const easy = readingStats('The cat sat on the mat. The dog ran to the park. We had fun.');
  const hard = readingStats('The epistemological ramifications of institutionalized methodological individualism necessitate considerable reconsideration of contemporary sociological paradigms.');
  assert.ok(easy.flesch > 85, `easy text scored ${easy.flesch}`);
  assert.ok(hard.flesch < 30, `hard text scored ${hard.flesch}`);
  assert.ok(hard.grade > easy.grade);
  assert.strictEqual(easy.sentences, 3);
  assert.strictEqual(readingStats(ARTICLE).readingMinutes, 1);
  assert.strictEqual(readingStats('').words, 0);
});

test('summarizeExtractive returns ordered, non-duplicate key points', async () => {
  const { summarizeExtractive, splitSentences } = await load();
  const r = summarizeExtractive(ARTICLE, { type: 'key-points', length: 'medium', title: 'The Return of the Honeybee' });
  const lines = r.markdown.split('\n');
  assert.ok(lines.length >= 3 && lines.length <= 6, `got ${lines.length} points`);
  assert.ok(lines.every((l) => l.startsWith('- ')));
  const all = splitSentences(ARTICLE);
  for (const s of r.sentences) assert.ok(all.includes(s.text), `not a verbatim sentence: ${s.text}`);
  assert.deepStrictEqual(r.sentences.map((s) => s.index), [...r.sentences.map((s) => s.index)].sort((a, b) => a - b));
  assert.match(r.markdown, /mite/i);
});

test('summary length and type change the output shape', async () => {
  const { summarizeExtractive } = await load();
  const short = summarizeExtractive(ARTICLE, { type: 'key-points', length: 'short' });
  const long = summarizeExtractive(ARTICLE, { type: 'key-points', length: 'long' });
  assert.ok(long.sentences.length > short.sentences.length);
  const tldr = summarizeExtractive(ARTICLE, { type: 'tldr', length: 'short' });
  assert.ok(!tldr.markdown.startsWith('- '));
  const head = summarizeExtractive(ARTICLE, { type: 'headline' });
  assert.ok(head.markdown.split(' ').length <= 16, head.markdown);
  assert.ok(!/[.!?]$/.test(head.markdown));
});

test('summarizeExtractive is safe on tiny and empty input', async () => {
  const { summarizeExtractive } = await load();
  assert.deepStrictEqual(summarizeExtractive('', {}), { markdown: '', sentences: [] });
  const one = summarizeExtractive('Only a single sentence lives here.', { length: 'long' });
  assert.strictEqual(one.sentences.length, 1);
});

test('extractKeywords prefers multi-word domain phrases over generic words', async () => {
  const { extractKeywords } = await load();
  const kws = extractKeywords(BLOCKS, { max: 8, title: 'The Return of the Honeybee' }).map((k) => k.text.toLowerCase());
  assert.ok(kws.some((k) => k.includes('varroa mite')), kws.join(', '));
  assert.ok(kws.some((k) => k.includes('honeybee') || k.includes('colonies') || k.includes('bees')), kws.join(', '));
  for (const stop of ['the', 'and', 'that', 'with', 'more']) assert.ok(!kws.includes(stop));
});

test('buildOutline uses headings, and falls back to segments without them', async () => {
  const { buildOutline } = await load();
  const o = buildOutline(BLOCKS, { title: 'The Return of the Honeybee' });
  assert.strictEqual(o.kind, 'headings');
  assert.deepStrictEqual(o.items.map((i) => i.text), ['The varroa mite', 'Forage']);
  assert.ok(o.items.every((i) => typeof i.block === 'number'));
  const auto = buildOutline(ARTICLE + '\n\n' + ARTICLE, {});
  assert.strictEqual(auto.kind, 'auto');
  assert.ok(auto.items.length >= 2);
});

test('buildPassages groups prose and keeps block references', async () => {
  const { buildPassages } = await load();
  const ps = buildPassages(BLOCKS);
  assert.ok(ps.length >= 2);
  for (const p of ps) {
    assert.ok(p.blocks.length >= 1);
    assert.ok(p.terms.length > 0);
    assert.ok(typeof p.id === 'number');
  }
  assert.ok(ps.some((p) => p.heading === 'The varroa mite'));
});

test('searchPassages ranks the answering passage first and highlights terms', async () => {
  const { buildPassages, searchPassages, highlightTerms } = await load();
  const ps = buildPassages(BLOCKS);
  const r = searchPassages(ps, 'What is the varroa mite?');
  assert.ok(r.results.length > 0);
  assert.match(r.results[0].passage.text, /varroa mite is a parasite/);
  assert.match(r.results[0].best, /parasite/);
  const forage = searchPassages(ps, 'How much land is covered by wildflower strips?');
  assert.match(forage.results[0].passage.text, /two million acres/);
  const parts = highlightTerms(r.results[0].best, new Set(r.terms));
  assert.ok(parts.some((p) => p.hit && /varroa|mite/i.test(p.text)));
  assert.strictEqual(parts.map((p) => p.text).join(''), r.results[0].best);
});

test('searchPassages returns nothing for unrelated questions', async () => {
  const { buildPassages, searchPassages } = await load();
  const r = searchPassages(buildPassages(BLOCKS), 'quantum chromodynamics lattice gauge');
  assert.strictEqual(r.results.length, 0);
});

test('makeFlashcards produces definition and cloze cards with verbatim answers', async () => {
  const { makeFlashcards } = await load();
  const cards = makeFlashcards(BLOCKS, { count: 6, title: 'The Return of the Honeybee' });
  assert.ok(cards.length >= 3);
  for (const c of cards) {
    assert.ok(c.front && c.back);
    if (c.kind === 'cloze') {
      assert.match(c.front, /_____/);
      assert.ok(c.context.toLowerCase().includes(c.back.toLowerCase()), `${c.back} not in context`);
    }
  }
  assert.ok(cards.some((c) => c.kind === 'definition'), 'expected a definitional card');
  assert.ok(cards.some((c) => /varroa/i.test(c.front + c.back)));
});

test('makeQuiz builds answerable multiple-choice questions', async () => {
  const { makeQuiz } = await load();
  const qs = makeQuiz(BLOCKS, { count: 4, title: 'The Return of the Honeybee' });
  assert.ok(qs.length >= 1);
  for (const q of qs) {
    assert.ok(q.options.length >= 3);
    assert.strictEqual(new Set(q.options.map((o) => o.toLowerCase())).size, q.options.length, 'duplicate options');
    assert.ok(q.answer >= 0 && q.answer < q.options.length);
    assert.ok(q.explanation.toLowerCase().includes(q.options[q.answer].toLowerCase()));
  }
  // Deterministic for the same input.
  assert.deepStrictEqual(makeQuiz(BLOCKS, { count: 4 }), qs);
});

test('chunkText splits long text at paragraph edges without losing content', async () => {
  const { chunkText } = await load();
  const long = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(60)).join('\n\n');
  const chunks = chunkText(long, 2000);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk too big: ${c.length}`);
  assert.strictEqual(chunks.join(' ').replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim());
  const huge = 'x'.repeat(5000);
  assert.ok(chunkText(huge, 1000).every((c) => c.length <= 1000));
});

test('compressDocument keeps order and respects the budget', async () => {
  const { compressDocument } = await load();
  const full = compressDocument(BLOCKS, { maxChars: 100000 });
  assert.ok(full.includes('varroa mite'));
  const small = compressDocument(BLOCKS, { maxChars: 200, title: 'Honeybee' });
  assert.ok(small.length <= 200, small.length);
  assert.ok(small.length > 0);
});

test('simplifyText shortens sentences and strips asides', async () => {
  const { simplifyText, readingStats } = await load();
  const hard = 'The varroa mite (Varroa destructor), which feeds on the fat bodies of developing bees, weakens their immune systems and, as a result, colonies with heavy infestations often fail during the winter months when foraging is impossible.';
  const out = simplifyText(hard);
  assert.ok(!out.includes('(Varroa destructor)'));
  assert.ok(readingStats(out).avgSentenceWords < readingStats(hard).avgSentenceWords);
});

test('normalizeUrl strips tracking parameters and fragments', async () => {
  const { normalizeUrl } = await import(path.resolve(__dirname, '..', 'lib', 'history.js'));
  assert.strictEqual(normalizeUrl('https://a.test/p?utm_source=x&id=7#top'), 'https://a.test/p?id=7');
  assert.strictEqual(normalizeUrl('not a url'), 'not a url');
});

test('renderMarkdown escapes HTML and renders lists, code and links', async () => {
  const { renderMarkdown } = await import(path.resolve(__dirname, '..', 'lib', 'markdown.js'));
  const html = renderMarkdown('# Head\n\n- one **bold**\n- two `code`\n\n<img src=x onerror=alert(1)>\n\n[link](https://e.test)');
  assert.ok(html.includes('<ul><li>one <strong>bold</strong></li>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(!html.includes('<img'), 'raw HTML must be escaped');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('<a href="https://e.test"'));
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('<a '), 'only http(s) links');
});
