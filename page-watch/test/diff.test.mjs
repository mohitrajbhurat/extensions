// node --test page-watch/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, myers, diffWords, diffStats, changeSummary, sideBySide } from '../lib/diff.js';

const rebuild = (ops, side) => ops.filter((o) => o.type === 'eq' || o.type === side).map((o) => o.text).join('');

test('tokenize round-trips text', () => {
  const s = 'Price: $1,299.99 — in stock!\nShips  tomorrow.';
  assert.equal(tokenize(s).join(''), s);
});

test('myers finds the minimal edit script', () => {
  const a = 'ABCABBA'.split('');
  const b = 'CBABAC'.split('');
  const steps = myers(a, b);
  assert.equal(steps.filter(([op]) => op !== 0).length, 5); // classic example: D = 5
});

test('myers returns null when maxD is exceeded', () => {
  assert.equal(myers('abcdef'.split(''), 'uvwxyz'.split(''), 3), null);
});

test('word diff marks only the changed words', () => {
  const ops = diffWords('The price is 100 dollars today', 'The price is 89 dollars today');
  assert.deepEqual(ops.filter((o) => o.type !== 'eq'), [{ type: 'del', text: '100' }, { type: 'add', text: '89' }]);
  assert.deepEqual(diffStats(ops), { added: 1, removed: 1, changed: true });
});

test('diff reconstructs both sides', () => {
  const a = 'alpha beta gamma\ndelta epsilon\nzeta';
  const b = 'alpha gamma beta\ndelta EPSILON eta\nzeta theta';
  const ops = diffWords(a, b);
  assert.equal(rebuild(ops, 'del'), a);
  assert.equal(rebuild(ops, 'add'), b);
});

test('identical and empty inputs', () => {
  assert.deepEqual(diffWords('same', 'same'), [{ type: 'eq', text: 'same' }]);
  assert.deepEqual(diffWords('', 'new text'), [{ type: 'add', text: 'new text' }]);
  assert.deepEqual(diffWords('old', ''), [{ type: 'del', text: 'old' }]);
  assert.equal(diffStats(diffWords('x', 'x')).changed, false);
});

test('large inputs fall back to line diff and still reconstruct', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `row ${i} value ${(i * 7919) % 1000}`);
  const a = lines.join('\n');
  const changed = lines.map((l, i) => (i % 3 === 0 ? l.replace('value', 'VALUE') : l));
  const b = changed.join('\n');
  const t0 = Date.now();
  const ops = diffWords(a, b);
  assert.ok(Date.now() - t0 < 5000, 'diff should be fast');
  assert.equal(rebuild(ops, 'del'), a);
  assert.equal(rebuild(ops, 'add'), b);
  assert.equal(diffStats(ops).added, 1000);
});

test('random edits always reconstruct', () => {
  const words = ['a', 'b', 'c', 'dd', 'ee', '\n', ' ', 'ff', '42', '.'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 200; k++) {
    const mk = () => Array.from({ length: rnd(40) }, () => words[rnd(words.length)]).join(' ');
    const a = mk();
    const b = mk();
    const ops = diffWords(a, b);
    assert.equal(rebuild(ops, 'del'), a);
    assert.equal(rebuild(ops, 'add'), b);
  }
});

test('changeSummary describes additions and removals', () => {
  assert.equal(changeSummary(diffWords('Sold out', 'In stock')), '+ In stock  − Sold out');
  assert.equal(changeSummary(diffWords('a', 'a b')), '+ b');
});

test('sideBySide keeps rows aligned', () => {
  const rows = sideBySide(diffWords('one\ntwo\nthree', 'one\n2\nthree'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].left, [{ type: 'del', text: 'two' }]);
  assert.deepEqual(rows[1].right, [{ type: 'add', text: '2' }]);
});
