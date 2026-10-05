import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, extractNumber, parseNumberToken, validateCondition, normalizeText } from '../lib/conditions.js';

test('extractNumber handles common price formats', () => {
  assert.equal(extractNumber('Now $1,299.99!'), 1299.99);
  assert.equal(extractNumber('Prix : 1.299,99 €'), 1299.99);
  assert.equal(extractNumber('49.99'), 49.99);
  assert.equal(extractNumber('3.14159'), 3.14159);
  assert.equal(extractNumber('12,5 kg'), 12.5);
  assert.equal(extractNumber('Only 3 left'), 3);
  assert.equal(extractNumber('-7 °C'), -7);
  assert.equal(extractNumber('1 299 kr'), 1299);
  assert.equal(extractNumber('no digits'), null);
  assert.equal(parseNumberToken('1,000,000'), 1000000);
});

test('contains / not contains', () => {
  assert.equal(evaluateCondition({ type: 'contains', value: 'in stock' }, 'Status: In Stock').met, true);
  assert.equal(evaluateCondition({ type: 'contains', value: 'in stock', caseSensitive: true }, 'Status: In Stock').met, false);
  assert.equal(evaluateCondition({ type: 'not_contains', value: 'sold out' }, 'Sold Out').met, false);
  assert.equal(evaluateCondition({ type: 'not_contains', value: 'sold out' }, 'Add to cart').met, true);
});

test('number thresholds', () => {
  assert.deepEqual(evaluateCondition({ type: 'below', value: '50' }, 'Price $49.99'), { met: true, value: 49.99 });
  assert.equal(evaluateCondition({ type: 'below', value: '50' }, 'Price $59.99').met, false);
  assert.equal(evaluateCondition({ type: 'above', value: '90' }, 'Grade: 93/100').met, true);
  assert.equal(evaluateCondition({ type: 'above', value: '90' }, 'Grade pending').met, false);
});

test('regex', () => {
  assert.equal(evaluateCondition({ type: 'regex', value: 'grade:\\s*A' }, 'Grade: A-').met, true);
  assert.equal(evaluateCondition({ type: 'regex', value: '/^New/' }, 'new posting').met, false);
  assert.equal(evaluateCondition({ type: 'regex', value: '/^New/i' }, 'new posting').met, true);
  assert.equal(evaluateCondition({ type: 'any' }, 'x').met, true);
});

test('validateCondition', () => {
  assert.equal(validateCondition({ type: 'any' }), '');
  assert.match(validateCondition({ type: 'above', value: 'abc' }), /number/);
  assert.match(validateCondition({ type: 'regex', value: '(' }), /Invalid regex/);
  assert.match(validateCondition({ type: 'contains', value: ' ' }), /Enter a value/);
});

test('normalizeText collapses whitespace noise', () => {
  assert.equal(normalizeText('  a \t b \r\n\n\n\n c  '), 'a b\n\nc');
  assert.equal(normalizeText('x\n \ny'), 'x\n\ny');
});
