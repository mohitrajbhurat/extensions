// Unit tests for the pure library modules. Run: node --test smart-bookmarks/test/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isHttpUrl, hostOf } from '../lib/url.js';
import { tokenize, buildCorpus, suggestTags } from '../lib/tagger.js';
import { normalizeTag, mergeTags } from '../lib/meta.js';
import { extractFromHtml, countWords, readingMinutes, decodeEntities } from '../lib/extract.js';
import { toNetscapeHtml, parseNetscapeHtml, toJsonBackup, parseJsonBackup, countTree } from '../lib/netscape.js';

test('normalizeUrl folds duplicates', () => {
  const a = normalizeUrl('https://www.example.com/docs/?utm_source=x&b=2&a=1');
  const b = normalizeUrl('http://example.com/docs?a=1&b=2#section');
  assert.equal(a, b);
  assert.equal(normalizeUrl('https://example.com/index.html'), normalizeUrl('https://example.com/'));
  assert.notEqual(normalizeUrl('https://example.com/a'), normalizeUrl('https://example.com/b'));
  assert.notEqual(normalizeUrl('https://example.com:8080/'), normalizeUrl('https://example.com/'));
  // SPA hash routes are kept
  assert.notEqual(normalizeUrl('https://app.example.com/#/one'), normalizeUrl('https://app.example.com/#/two'));
});

test('url helpers', () => {
  assert.ok(isHttpUrl('https://x.org'));
  assert.ok(!isHttpUrl('javascript:alert(1)'));
  assert.equal(hostOf('https://www.github.com/a'), 'github.com');
});

test('tags normalize and merge', () => {
  assert.equal(normalizeTag('  #Machine Learning '), 'machine-learning');
  assert.equal(normalizeTag('C++'), 'c++');
  assert.deepEqual(mergeTags(['A', 'b'], ['b', 'C d']), ['a', 'b', 'c-d']);
});

test('tokenize drops stop words, numbers and hashes', () => {
  const t = tokenize('The 2024 guide to Rust async programming deadbeefcafe1234 node.js');
  assert.ok(t.includes('rust') && t.includes('async') && t.includes('programming') && t.includes('node.js'));
  assert.ok(!t.includes('the') && !t.includes('2024') && !t.includes('deadbeefcafe1234'));
});

test('suggestTags uses TF-IDF, keywords and existing vocabulary', () => {
  const corpus = buildCorpus([
    'cooking pasta recipe tomato', 'javascript fetch api docs', 'javascript array docs',
    'rust ownership guide', 'python list docs', 'cooking bread recipe'
  ]);
  const page = {
    url: 'https://blog.example.com/posts/rust-borrow-checker',
    title: 'Understanding the Rust borrow checker - Example Blog',
    description: 'A deep dive into ownership and borrowing in Rust.',
    keywords: 'rust, memory safety',
    text: 'Rust ownership rules. The borrow checker enforces borrowing rules. Ownership and lifetimes. Rust compiler.'
  };
  const tags = suggestTags(page, corpus, new Map([['programming', 3], ['rust', 2]]), 6);
  assert.ok(tags.includes('rust'), tags.join());
  assert.ok(tags.includes('memory-safety') || tags.includes('ownership'), tags.join());
  assert.ok(!tags.includes('the') && tags.length <= 6);
});

test('extractFromHtml reads title, meta and body text', () => {
  const html = `<html lang="en"><head><title>Hello &amp; welcome</title>
    <meta name="description" content="A test page">
    <meta name="keywords" content="alpha, beta"><script>var x = 1;</script></head>
    <body><nav>Menu</nav><p>First paragraph.</p><p>Second &mdash; paragraph.</p></body></html>`;
  const r = extractFromHtml(html, 'https://e.com/');
  assert.equal(r.title, 'Hello & welcome');
  assert.equal(r.description, 'A test page');
  assert.equal(r.keywords, 'alpha, beta');
  assert.equal(r.lang, 'en');
  assert.match(r.text, /First paragraph\.\nSecond — paragraph\./);
  assert.ok(!/var x|Menu/.test(r.text));
  assert.equal(decodeEntities('&#x41;&#66;&lt;'), 'AB<');
});

test('reading time', () => {
  assert.equal(countWords("It's a well-known fact, isn't it?"), 6);
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(100), 1);
  assert.equal(readingMinutes(2300, 230), 10);
});

test('Netscape HTML round trip keeps folders, tags, notes and escaping', () => {
  const roots = [{
    id: '1', title: 'Bookmarks bar', parentId: '0', dateAdded: 1700000000000, children: [
      { id: '10', title: 'A & B <tools>', url: 'https://a.example/?x=1&y=2', dateAdded: 1700000001000 },
      { id: '11', title: 'Dev', dateAdded: 1700000002000, children: [
        { id: '12', title: 'Docs', url: 'https://docs.example/' }
      ] }
    ]
  }];
  const meta = { 10: { tags: ['tools', 'misc'], note: 'line 1\nline 2' }, 12: { tags: ['docs'] } };
  const html = toNetscapeHtml(roots, id => meta[id]);
  assert.match(html, /PERSONAL_TOOLBAR_FOLDER="true"/);
  const back = parseNetscapeHtml(html);
  assert.deepEqual(countTree(back), { links: 2, folders: 2 });
  const bar = back.children[0];
  assert.equal(bar.toolbar, true);
  const a = bar.children[0];
  assert.equal(a.title, 'A & B <tools>');
  assert.equal(a.url, 'https://a.example/?x=1&y=2');
  assert.deepEqual(a.tags, ['tools', 'misc']);
  assert.equal(a.note, 'line 1\nline 2');
  assert.equal(a.dateAdded, 1700000001000);
  assert.equal(bar.children[1].children[0].url, 'https://docs.example/');
});

test('parseNetscapeHtml tolerates real-world browser exports', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3 ADD_DATE="1" LAST_MODIFIED="2">Folder</H3>
<DL><p>
<DT><A HREF="https://one.example" ICON="data:image/png;base64,AAA">One</A>
<DT><A HREF='https://two.example'>Two</A>
</DL><p>
<DT><A HREF="https://top.example">Top</A>
</DL>`;
  const r = parseNetscapeHtml(html);
  assert.deepEqual(countTree(r), { links: 3, folders: 1 });
  assert.equal(r.children[1].title, 'Top');
});

test('JSON backup round trip and raw chrome tree import', () => {
  const roots = [{ id: '1', title: 'Bar', children: [{ id: '5', title: 'X', url: 'https://x.example/' }] }];
  const json = toJsonBackup(roots, id => (id === '5' ? { tags: ['t'], rl: true, read: true } : {}), id => (id === '5' ? 'saved text' : null));
  const parsed = parseJsonBackup(JSON.stringify(json));
  const x = parsed.children[0].children[0];
  assert.deepEqual(x.tags, ['t']);
  assert.equal(x.text, 'saved text');
  assert.equal(x.readLater.read, true);
  const raw = parseJsonBackup(JSON.stringify([{ id: '0', title: '', children: roots }]));
  assert.equal(countTree(raw).links, 1);
  assert.throws(() => parseJsonBackup('{"foo":1}'));
});
