// Password generator and text statistics tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePassword, generatePronounceable, generatePassphrase, countValid, log2Big,
  randomInt, strengthLabel, crackSeconds, humanDuration, CHARSETS, AMBIGUOUS, passwordEntropy,
} from '../lib/password.js';
import { WORDS } from '../lib/wordlist.js';
import { analyze, syllables, convertCase, splitWords, toTitleCase, keywords } from '../lib/textstats.js';

test('word list has 1,000+ unique lowercase words', () => {
  assert.ok(WORDS.length >= 1000);
  assert.equal(new Set(WORDS).size, WORDS.length);
  for (const w of WORDS) assert.match(w, /^[a-z]{2,10}$/);
});

test('randomInt is in range and roughly uniform', () => {
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) counts[randomInt(6)]++;
  for (const c of counts) assert.ok(c > 9000 && c < 11000, String(counts));
  assert.throws(() => randomInt(0));
});

test('passwords honour length and character classes', () => {
  for (let i = 0; i < 200; i++) {
    const { value } = generatePassword({ length: 12, upper: true, lower: true, digits: true, symbols: true });
    assert.equal(value.length, 12);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[a-z]/);
    assert.match(value, /\d/);
    assert.ok([...value].some(c => CHARSETS.symbols.includes(c)));
  }
  const digitsOnly = generatePassword({ length: 8, upper: false, lower: false, digits: true, symbols: false });
  assert.match(digitsOnly.value, /^\d{8}$/);
  const noAmb = generatePassword({ length: 128, excludeAmbiguous: true });
  for (const c of noAmb.value) assert.ok(!AMBIGUOUS.includes(c), c);
  assert.throws(() => generatePassword({ upper: false, lower: false, digits: false, symbols: false }));
});

test('entropy is exact for constrained passwords', () => {
  // Digits-only, length 4: 10^4 strings.
  assert.equal(countValid(['0123456789'], 4), 10000n);
  // Two classes of size 1 ("a","b"), length 3: 2^3 - 2 strings contain both.
  assert.equal(countValid(['a', 'b'], 3), 6n);
  close(log2Big(2n ** 200n), 200);
  close(passwordEntropy({ length: 10, upper: false, lower: true, digits: false, symbols: false }), 10 * Math.log2(26));
  const full = passwordEntropy({ length: 20 });
  assert.ok(full > 125 && full < 20 * Math.log2(89));
});

function close(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`); }

test('pronounceable passwords alternate consonants and vowels', () => {
  const { value, entropy } = generatePronounceable({ length: 14, upper: false, digits: true, symbols: true });
  assert.equal(value.length, 14);
  const letters = value.slice(0, 11);
  assert.match(letters, /^[a-z]+$/);
  for (let i = 1; i < letters.length; i++) {
    assert.notEqual('aeiou'.includes(letters[i]), 'aeiou'.includes(letters[i - 1]));
  }
  assert.match(value.slice(11), /^\d\d[^\w]$/);
  assert.ok(entropy > 30);
});

test('passphrases use the word list and report entropy', () => {
  const { value, entropy } = generatePassphrase({ words: 6, separator: '.', capitalize: false, includeNumber: false }, WORDS);
  const parts = value.split('.');
  assert.equal(parts.length, 6);
  for (const p of parts) assert.ok(WORDS.includes(p), p);
  close(entropy, 6 * Math.log2(WORDS.length));
  const withNum = generatePassphrase({ words: 4, capitalize: true, includeNumber: true }, WORDS);
  assert.match(withNum.value, /\d/);
  assert.match(withNum.value, /^[A-Z]/);
});

test('strength labels and crack-time wording', () => {
  assert.equal(strengthLabel(20).label, 'Very weak');
  assert.equal(strengthLabel(50).label, 'Fair');
  assert.equal(strengthLabel(100).label, 'Very strong');
  close(crackSeconds(11, 1), 1024);
  assert.equal(humanDuration(0.2), 'instantly');
  assert.equal(humanDuration(90), '2 minutes');
  assert.equal(humanDuration(86400 * 2), '2 days');
  assert.equal(humanDuration(31557600 * 5e6), '5 million years');
});

// ----------------------------------------------------------------- text

test('text statistics', () => {
  const text = 'The cat sat on the mat. It was happy!\n\nDon’t panic: e-mail me at 9am.';
  const a = analyze(text);
  assert.equal(a.words, 15);
  assert.equal(a.sentences, 3);
  assert.equal(a.paragraphs, 2);
  assert.equal(a.characters, text.length);
  assert.equal(a.charactersNoSpaces, text.replace(/\s/g, '').length);
  assert.ok(a.fleschEase > 80);
  assert.equal(analyze('').words, 0);
  assert.equal(analyze('').fleschEase, null);
  assert.equal(analyze('👍🏽 ok').characters, 4); // one grapheme for the emoji
});

test('reading and speaking time', () => {
  const a = analyze('word '.repeat(238));
  assert.equal(a.readingSeconds, 60);
  assert.equal(a.speakingSeconds, Math.round((238 / 150) * 60));
});

test('syllable estimates', () => {
  const cases = { cat: 1, happy: 2, banana: 3, table: 2, created: 3, beautiful: 3, the: 1, readability: 5 };
  for (const [w, n] of Object.entries(cases)) assert.ok(Math.abs(syllables(w) - n) <= 1, `${w}: ${syllables(w)}`);
});

test('keywords skip stop words', () => {
  const k = keywords('The browser extension makes the browser better. Browser tools!');
  assert.equal(k[0].word, 'browser');
  assert.equal(k[0].count, 3);
  assert.ok(!k.some(x => x.word === 'the'));
});

test('case conversion', () => {
  assert.equal(convertCase('hello world', 'upper'), 'HELLO WORLD');
  assert.equal(convertCase('Hello World', 'lower'), 'hello world');
  assert.equal(toTitleCase('the lord of the rings'), 'The Lord of the Rings');
  assert.equal(convertCase('hello there. how are you? i am fine', 'sentence'), 'Hello there. How are you? I am fine');
  assert.equal(convertCase('Hello big World', 'camel'), 'helloBigWorld');
  assert.equal(convertCase('hello big world', 'pascal'), 'HelloBigWorld');
  assert.equal(convertCase('helloBigWorld', 'snake'), 'hello_big_world');
  assert.equal(convertCase('XMLHttpRequest parser', 'kebab'), 'xml-http-request-parser');
  assert.equal(convertCase('some-value here', 'constant'), 'SOME_VALUE_HERE');
  assert.deepEqual(splitWords('user_ID-number2Go'), ['user', 'id', 'number2', 'go']);
});
