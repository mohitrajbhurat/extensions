// Tests for the built-in PDF text extractor. The fixture PDF is generated once with
// Chromium so the repo stays free of binary blobs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
let bytes;

test.before(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(EXT, 'test', 'fixtures', 'article.html'));
  bytes = new Uint8Array(await page.pdf({ format: 'A4' }));
  await browser.close();
});

const lib = () => import(path.resolve(EXT, 'lib', 'pdf.js'));

test('reads text, headings and paragraphs out of a real PDF', async () => {
  const { extractPdf } = await lib();
  const r = await extractPdf(bytes);
  assert.ok(r.pageCount >= 1);
  const text = r.blocks.map((b) => b.text).join('\n');
  assert.match(text, /varroa mite feeds on the fat bodies of developing bees/);
  assert.match(text, /lowest figure since the survey began in 2007/);
  const heads = r.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.ok(heads.includes('The Quiet Return of the Honeybee'), heads.join(' | '));
  assert.ok(heads.includes('Why the varroa mite mattered'), heads.join(' | '));
  // Paragraphs must be rejoined, not one block per visual line.
  const para = r.blocks.find((b) => b.text.startsWith('After more than a decade'));
  assert.ok(para && para.text.endsWith('since the survey began in 2007.'), para && para.text.slice(-60));
  assert.strictEqual(r.title, 'The Quiet Return of the Honeybee | Daily Planet');
});

test('PDF text feeds the offline summarizer', async () => {
  const { extractPdf } = await lib();
  const { summarizeExtractive } = await import(path.resolve(EXT, 'lib', 'nlp.js'));
  const r = await extractPdf(bytes);
  const s = summarizeExtractive(r.blocks, { type: 'key-points', length: 'medium', title: r.title });
  assert.ok(s.sentences.length >= 3);
  assert.match(s.markdown, /mite|bee/i);
});

test('rejects files that are not PDFs', async () => {
  const { extractPdf, isPdfBytes } = await lib();
  const junk = new TextEncoder().encode('hello world, definitely not a pdf');
  assert.strictEqual(isPdfBytes(junk), false);
  await assert.rejects(() => extractPdf(junk), /not a PDF/);
});

test('inflateSync matches zlib for deflate streams', async () => {
  const { inflateSync } = await lib();
  const zlib = require('zlib');
  const data = Buffer.from('The varroa mite is a parasite. '.repeat(400));
  const out = Buffer.from(inflateSync(new Uint8Array(zlib.deflateSync(data))));
  assert.strictEqual(out.toString(), data.toString());
  const raw = Buffer.from(inflateSync(new Uint8Array(zlib.deflateRawSync(data))));
  assert.strictEqual(raw.toString(), data.toString());
});

test('handles truncated streams without throwing', async () => {
  const { inflateSync } = await lib();
  const zlib = require('zlib');
  const full = zlib.deflateSync(Buffer.from('x'.repeat(5000)));
  const cut = new Uint8Array(full.subarray(0, Math.floor(full.length / 2)));
  const out = inflateSync(cut);
  assert.ok(out.length >= 0);
});
