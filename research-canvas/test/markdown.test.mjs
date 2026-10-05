// Unit tests for lib/markdown.js and the pure parts of lib/store.js.
// Usage: node research-canvas/test/markdown.test.mjs
import assert from 'node:assert/strict';
import {
  renderMarkdown, extractWikilinks, safeFilename, noteTitle, noteToMarkdown, clipToMarkdown, projectToMarkdown, pageToMarkdown,
} from '../lib/markdown.js';
import { normalizeUrl, cleanTags, parseSnapshot } from '../lib/store.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

test('extractWikilinks: distinct targets, aliases, case-insensitive dedupe', () => {
  assert.deepEqual(extractWikilinks('See [[Alpha]], [[beta|the B]] and [[alpha]] again. [[ ]] [not]'), ['Alpha', 'beta']);
  assert.deepEqual(extractWikilinks(''), []);
});

test('renderMarkdown: escapes raw HTML', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold**');
  assert.ok(!html.includes('<img src=x'), html);
  assert.ok(html.includes('&lt;img'), html);
  assert.ok(html.includes('<strong>bold</strong>'), html);
});

test('renderMarkdown: wikilinks marked missing or existing', () => {
  const html = renderMarkdown('Go to [[Known]] or [[Unknown|other]]', { wikiExists: t => t === 'Known' });
  assert.match(html, /class="wikilink" data-wikilink="Known">Known<\/a>/);
  assert.match(html, /class="wikilink missing" data-wikilink="Unknown">other<\/a>/);
});

test('renderMarkdown: blocks (headings, lists, code, quotes)', () => {
  const html = renderMarkdown('# Title\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n```\n<b>x</b>\n```');
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<blockquote>/);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), html);
});

test('renderMarkdown: rejects javascript: links', () => {
  const html = renderMarkdown('[x](javascript:alert(1)) [ok](https://example.com)');
  assert.ok(!/href="javascript/i.test(html), html);
  assert.ok(html.includes('href="https://example.com"'), html);
});

test('safeFilename strips path and reserved characters', () => {
  assert.equal(safeFilename('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(safeFilename('   '), 'untitled');
});

test('noteTitle and noteToMarkdown front matter', () => {
  const n = { type: 'note', title: '', content: '## My note\nbody [[Link]]', tags: ['x'], url: '', createdAt: 0, updatedAt: 0 };
  assert.equal(noteTitle(n), 'My note');
  const md = noteToMarkdown(n, { name: 'Proj' });
  assert.ok(md.startsWith('---\ntitle: "My note"\nproject: "Proj"\ntags: ["x"]'), md);
  assert.ok(md.includes('body [[Link]]'));
});

test('clipToMarkdown for each clip type', () => {
  const base = { url: 'https://e.com/a', pageTitle: 'Page [1]', tags: ['t'], createdAt: 0, updatedAt: 0, comment: '' };
  assert.match(clipToMarkdown({ ...base, type: 'highlight', content: 'line1\nline2', color: 'green', comment: 'why' }), /> line1\n> line2[\s\S]*_Highlight: green_[\s\S]*\*\*Comment:\*\* why[\s\S]*Source: \[Page 1\]\(https:\/\/e.com\/a\)/);
  assert.match(clipToMarkdown({ ...base, type: 'image', content: 'https://e.com/i.png', title: '' }), /!\[image\]\(https:\/\/e.com\/i.png\)/);
  assert.match(clipToMarkdown({ ...base, type: 'link', content: 'https://x.org', title: 'X' }), /\[X\]\(https:\/\/x.org\)/);
  assert.match(clipToMarkdown({ ...base, type: 'page', content: '', title: 'Whole page' }), /\[Whole page\]\(https:\/\/e.com\/a\)/);
});

test('projectToMarkdown and pageToMarkdown', () => {
  const md = projectToMarkdown({ name: 'P' }, [
    { type: 'text', content: 'hello', tags: [], createdAt: 0, updatedAt: 0 },
    { type: 'note', title: 'N', content: 'note body', tags: [], createdAt: 0, updatedAt: 0 },
  ]);
  assert.match(md, /^# P/);
  assert.match(md, /## Clips[\s\S]*> hello[\s\S]*## Notes[\s\S]*### N/);
  const pm = pageToMarkdown({ url: 'https://e.com', title: 'E', highlights: [{ quote: { exact: 'q' }, comment: 'c' }], stickies: [{ text: 's' }] });
  assert.match(pm, /## \[E\]\(https:\/\/e.com\)\n\n> q\n\nc/);
  assert.match(pm, /\*\*Sticky note:\*\* s/);
});

test('normalizeUrl drops hash, tracking params and trailing slash', () => {
  assert.equal(normalizeUrl('https://e.com/a/?utm_source=x&id=2#frag'), 'https://e.com/a?id=2');
  assert.equal(normalizeUrl('https://e.com/'), 'https://e.com/');
});

test('cleanTags normalizes and dedupes', () => {
  assert.deepEqual(cleanTags(['#Foo', 'foo', ' two words ', '', 3]), ['foo', 'two-words', '3']);
  assert.deepEqual(cleanTags('nope'), []);
});

test('parseSnapshot groups and sorts records', () => {
  const s = parseSnapshot({
    'project:b': { id: 'b', order: 1, createdAt: 1 }, 'project:a': { id: 'a', order: 0, createdAt: 2 },
    'clip:1': { id: '1', order: 5 }, 'clip:2': { id: '2', order: -1 },
    'page:x': { url: 'x', updatedAt: 1 }, settings: { defaultColor: 'blue' }, junk: 3,
  });
  assert.deepEqual(s.projects.map(p => p.id), ['a', 'b']);
  assert.deepEqual(s.clips.map(c => c.id), ['2', '1']);
  assert.equal(s.pages.length, 1);
  assert.equal(s.settings.defaultColor, 'blue');
  assert.equal(s.settings.showToolbar, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
