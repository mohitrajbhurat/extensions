// Run: node --test price-tracker/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePrice, detectCurrency, formatPrice, looksLikePrice, currencyFromUrl } = require('../lib/price-parse.js');

const cases = [
  // [input, opts, amount, currency]
  ['$1,299.00', {}, 1299, 'USD'],
  ['$19.99', {}, 19.99, 'USD'],
  ['$5', {}, 5, 'USD'],
  ['1.299,00 €', {}, 1299, 'EUR'],
  ['1.299,00 €', {}, 1299, 'EUR'],
  ['€ 49,95', {}, 49.95, 'EUR'],
  ['1 299,00 €', {}, 1299, 'EUR'],
  ['1 299,00 €', {}, 1299, 'EUR'],
  ['₹1,29,999', {}, 129999, 'INR'],
  ['₹ 1,29,999.00', {}, 129999, 'INR'],
  ['Rs. 2,499', {}, 2499, 'INR'],
  ['£1,049.99', {}, 1049.99, 'GBP'],
  ['¥12,800', {}, 12800, 'JPY'],
  ['12,800円', {}, 12800, 'JPY'],
  ["CHF 1'299.50", {}, 1299.5, 'CHF'],
  ['R$ 2.499,90', {}, 2499.9, 'BRL'],
  ['1.299 kr', { currency: 'NOK' }, 1299, 'NOK'],
  ['299,- kr', { currency: 'SEK' }, 299, 'SEK'],
  ['49,–', { currency: 'EUR' }, 49, 'EUR'],
  ['1.299', { currency: 'EUR' }, 1299, 'EUR'],
  ['1,299', {}, 1299, null],
  ['0,99 €', {}, 0.99, 'EUR'],
  ['12.5', {}, 12.5, null],
  ['KWD 1.250', {}, 1.25, 'KWD'],
  ['USD 1,234.56', {}, 1234.56, 'USD'],
  ['1.234.567,89 EUR', {}, 1234567.89, 'EUR'],
  ['zł 1 299,99', {}, 1299.99, 'PLN'],
  ['CA$1,099.99', {}, 1099.99, 'CAD'],
  ['C$ 89.00', {}, 89, 'CAD'],
  ['$89.00', { url: 'https://www.bestbuy.ca/en-ca/product/x' }, 89, 'CAD'],
  ['$89.00', { currency: 'AUD' }, 89, 'AUD'],
  ['Now $24.99', {}, 24.99, 'USD'],
  ['2 for $10', {}, 10, 'USD'],
  ['$1,299.00 - $1,499.00', {}, 1299, 'USD'],
  ['Price: 79,90 € inkl. MwSt.', {}, 79.9, 'EUR'],
  ['₩1,290,000', {}, 1290000, 'KRW'],
  ['1299.00', { machine: true, currency: 'EUR' }, 1299, 'EUR'],
  ['1,299.00', { machine: true }, 1299, null],
  ['12,99', { machine: true, currency: 'EUR' }, 12.99, 'EUR'],
  [1299.5, { currency: 'USD' }, 1299.5, 'USD'],
  ['−$5.00 off $40.00', {}, 5, 'USD'],
];

for (const [input, opts, amount, currency] of cases) {
  test(`parsePrice(${JSON.stringify(input)}${Object.keys(opts).length ? ', ' + JSON.stringify(opts) : ''})`, () => {
    const r = parsePrice(input, opts);
    assert.ok(r, 'expected a result');
    assert.equal(r.amount, amount);
    assert.equal(r.currency, currency);
  });
}

test('rejects non-prices', () => {
  for (const bad of ['', 'Free', 'Out of stock', null, undefined, 0, -5, 'abc', '$0.00', NaN]) {
    assert.equal(parsePrice(bad), null, `expected null for ${String(bad)}`);
  }
});

test('detectCurrency handles ISO codes after non-ISO words', () => {
  assert.equal(detectCurrency('NEW 12 USD'), 'USD');
  assert.equal(detectCurrency('kraft paper 12'), null);
  assert.equal(detectCurrency('$12', 'NZD'), 'NZD');
  assert.equal(detectCurrency('12 kr', 'DKK'), 'DKK');
});

test('currencyFromUrl uses country TLDs', () => {
  assert.equal(currencyFromUrl('https://www.amazon.de/dp/B0'), 'EUR');
  assert.equal(currencyFromUrl('https://www.amazon.co.uk/dp/B0'), 'GBP');
  assert.equal(currencyFromUrl('https://www.amazon.com/dp/B0'), null);
});

test('looksLikePrice', () => {
  assert.equal(looksLikePrice('$19.99'), true);
  assert.equal(looksLikePrice('1.299,00 €'), true);
  assert.equal(looksLikePrice('19.99'), true);
  assert.equal(looksLikePrice('Add to cart'), false);
  assert.equal(looksLikePrice('2024'), false);
});

test('formatPrice', () => {
  assert.match(formatPrice(1299, 'USD', 'en-US'), /\$1,299\.00/);
  assert.match(formatPrice(1299, 'EUR', 'de-DE'), /1\.299,00/);
  assert.match(formatPrice(12800, 'JPY', 'en-US'), /12,800/);
  assert.equal(formatPrice(null, 'USD'), '—');
  assert.match(formatPrice(5, null, 'en-US'), /5\.00/);
});
