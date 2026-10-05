// node --test pocket-tools/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, parseQuantity, findUnit, CATEGORIES, quantityConversions, formatNumber } from '../lib/units.js';
import {
  parseTimeWithZone, zoneOffset, zonedTimeToUtc, meetingPlanner, parseUnixTimestamp,
  parseInBase, toBase, parsePrefixedInteger, groupDigits, parseZone, formatOffset,
} from '../lib/timeutil.js';
import { convertText } from '../lib/convert.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

test('length, mass, volume, area, speed, data and time conversions', () => {
  close(convert(5, 'length', 'mi', 'km'), 8.04672);
  close(convert(1, 'length', 'ft', 'cm'), 30.48);
  close(convert(1, 'length', 'nmi', 'm'), 1852);
  close(convert(1, 'mass', 'lb', 'kg'), 0.45359237);
  close(convert(1, 'mass', 'st', 'lb'), 14);
  close(convert(16, 'mass', 'oz', 'lb'), 1);
  close(convert(1, 'volume', 'gal', 'l'), 3.785411784);
  close(convert(1, 'volume', 'cup', 'floz'), 8);
  close(convert(1, 'volume', 'ft3', 'l'), 28.316846592);
  close(convert(3, 'volume', 'tsp', 'tbsp'), 1);
  close(convert(1, 'area', 'acre', 'ft2'), 43560);
  close(convert(1, 'area', 'mi2', 'acre'), 640);
  close(convert(1, 'area', 'ha', 'm2'), 10000);
  close(convert(100, 'speed', 'kmh', 'mph'), 62.13711922373339);
  close(convert(1, 'speed', 'kn', 'kmh'), 1.852);
  close(convert(1, 'data', 'GiB', 'MB'), 1073.741824);
  close(convert(1, 'data', 'B', 'bit'), 8);
  close(convert(1, 'time', 'd', 'h'), 24);
  close(convert(1, 'time', 'yr', 'd'), 365.2425);
});

test('temperature formulas', () => {
  close(convert(72, 'temperature', 'f', 'c'), 22.22222222222222);
  close(convert(-40, 'temperature', 'c', 'f'), -40);
  close(convert(0, 'temperature', 'k', 'c'), -273.15);
  close(convert(100, 'temperature', 'c', 'k'), 373.15);
  close(convert(212, 'temperature', 'f', 'k'), 373.15);
});

test('round trips between every pair of units are lossless', () => {
  for (const [cat, def] of Object.entries(CATEGORIES)) {
    for (const a of def.units) for (const b of def.units) {
      close(convert(convert(12.5, cat, a.id, b.id), cat, b.id, a.id), 12.5, 1e-9);
    }
  }
});

test('every unit lists valid default targets in its own category', () => {
  for (const def of Object.values(CATEGORIES)) {
    for (const u of def.units) {
      assert.ok(u.to.length > 0, u.id);
      for (const t of u.to) assert.ok(def.units.some(x => x.id === t), `${u.id} -> ${t}`);
    }
  }
});

test('parses quantities as people write them', () => {
  const cases = [
    ['5 miles', 'length', 'mi', 5],
    ['72°F', 'temperature', 'f', 72],
    ['72 °F', 'temperature', 'f', 72],
    ['72 degrees Fahrenheit', 'temperature', 'f', 72],
    ['-3.5 °C', 'temperature', 'c', -3.5],
    ['1,200 sq ft', 'area', 'ft2', 1200],
    ['20 m²', 'area', 'm2', 20],
    ['3.5kg', 'mass', 'kg', 3.5],
    ['2 cups', 'volume', 'cup', 2],
    ['12 fl oz', 'volume', 'floz', 12],
    ['65 mph', 'speed', 'mph', 65],
    ['100 km/h', 'speed', 'kmh', 100],
    ['4 GB', 'data', 'GB', 4],
    ['90 min', 'time', 'min', 90],
    ['2½ hours', 'time', 'h', 2.5],
    ['.5 in', 'length', 'in', 0.5],
  ];
  for (const [text, cat, unit, value] of cases) {
    const q = parseQuantity(text);
    assert.ok(q, text);
    assert.equal(q.category, cat, text);
    assert.equal(q.unit.id, unit, text);
    close(q.value, value);
  }
  const fi = parseQuantity('5\'11"');
  assert.equal(fi.unit.id, 'in');
  assert.equal(fi.value, 71);
  assert.equal(parseQuantity('5 ft 11 in').value, 71);
});

test('ignores text that is not a quantity', () => {
  for (const t of ['hello', '12 apples', 'miles', '', '5', 'version 2.0', 'x'.repeat(100)]) {
    assert.equal(parseQuantity(t), null, t);
  }
  assert.equal(findUnit('parsecs'), null);
});

test('quantity conversions pick the opposite system', () => {
  const q = parseQuantity('10 km');
  const out = quantityConversions(q);
  assert.equal(out[0].unit.id, 'mi');
  close(out[0].value, 6.213711922373339);
});

test('formatNumber trims noise', () => {
  assert.equal(formatNumber(8.04672, { locale: 'en-US' }), '8.04672');
  assert.equal(formatNumber(1234567.891, { locale: 'en-US' }), '1,234,570');
  assert.equal(formatNumber(0), '0');
  assert.match(formatNumber(1e-9), /e-9$/);
});

// ------------------------------------------------------------- time zones

const NOW = Date.UTC(2024, 6, 15, 12, 0); // 15 July 2024 12:00 UTC (northern summer)
const WINTER = Date.UTC(2024, 0, 15, 12, 0);

test('zone offsets follow daylight saving time', () => {
  assert.equal(zoneOffset(NOW, 'America/New_York'), -240);
  assert.equal(zoneOffset(WINTER, 'America/New_York'), -300);
  assert.equal(zoneOffset(NOW, 'Asia/Kolkata'), 330);
  assert.equal(zoneOffset(NOW, 'Australia/Sydney'), 600);
  assert.equal(zoneOffset(WINTER, 'Australia/Sydney'), 660);
  assert.equal(formatOffset(-210), 'UTC-3:30');
  assert.equal(formatOffset(345), 'UTC+5:45');
});

test('wall time to UTC, including DST edges', () => {
  assert.equal(zonedTimeToUtc({ year: 2024, month: 7, day: 15, hour: 9 }, 'Europe/Paris'), Date.UTC(2024, 6, 15, 7));
  assert.equal(zonedTimeToUtc({ year: 2024, month: 1, day: 15, hour: 9 }, 'Europe/Paris'), Date.UTC(2024, 0, 15, 8));
  // 2024-03-10 03:30 New York is after the spring-forward gap (EDT).
  assert.equal(zonedTimeToUtc({ year: 2024, month: 3, day: 10, hour: 3, minute: 30 }, 'America/New_York'), Date.UTC(2024, 2, 10, 7, 30));
});

test('parses "3pm PST" style times', () => {
  const t = parseTimeWithZone('3pm PST', NOW);
  assert.equal(t.ms, Date.UTC(2024, 6, 15, 23, 0));
  assert.equal(parseTimeWithZone('15:30 CET', NOW).ms, Date.UTC(2024, 6, 15, 14, 30));
  assert.equal(parseTimeWithZone('9:15 a.m. ET', NOW).ms, Date.UTC(2024, 6, 15, 13, 15));
  assert.equal(parseTimeWithZone('12am UTC', NOW).ms, Date.UTC(2024, 6, 15, 0, 0));
  assert.equal(parseTimeWithZone('noon IST', NOW).ms, Date.UTC(2024, 6, 15, 6, 30));
  assert.equal(parseTimeWithZone('8pm UTC+5:30', NOW).ms, Date.UTC(2024, 6, 15, 14, 30));
  assert.equal(parseTimeWithZone('7 pm Europe/London', NOW).ms, Date.UTC(2024, 6, 15, 18, 0));
  assert.equal(parseTimeWithZone('10am Tokyo', NOW).ms, Date.UTC(2024, 6, 15, 1, 0));
  for (const bad of ['3pm', '5 m', '25:00 UTC', '13pm PST', '3pm XYZ', 'hello']) assert.equal(parseTimeWithZone(bad, NOW), null, bad);
  assert.equal(parseZone('PT').zone, 'America/Los_Angeles');
});

test('meeting planner flags shared working hours', () => {
  const rows = meetingPlanner(['Europe/London', 'America/New_York'], '2024-07-15');
  assert.equal(rows.length, 24);
  const shared = rows.filter(r => r.allWorking).map(r => r.cells[0].hour);
  assert.deepEqual(shared, [14, 15, 16]); // 9:00–11:59 in New York
  const tokyo = meetingPlanner(['America/Los_Angeles', 'Asia/Tokyo'], '2024-07-15');
  assert.ok(tokyo.every(r => !r.allWorking));
  assert.equal(tokyo[17].cells[1].dayShift, 1);
  // Spring-forward day in New York has 23 distinct hours.
  assert.equal(meetingPlanner(['America/New_York'], '2024-03-10').length, 23);
});

// ------------------------------------------------------- timestamps & bases

test('unix timestamps by magnitude', () => {
  assert.deepEqual(parseUnixTimestamp('1700000000'), { ms: 1700000000000, unit: 'seconds' });
  assert.deepEqual(parseUnixTimestamp('1700000000123'), { ms: 1700000000123, unit: 'milliseconds' });
  assert.equal(parseUnixTimestamp('1700000000123456').unit, 'microseconds');
  assert.equal(parseUnixTimestamp('1700000000123456789').unit, 'nanoseconds');
  assert.equal(parseUnixTimestamp('0').ms, 0);
  assert.equal(parseUnixTimestamp('abc'), null);
});

test('number bases with BigInt precision', () => {
  assert.equal(parseInBase('ff', 16), 255n);
  assert.equal(parseInBase('0xFF', 16), 255n);
  assert.equal(parseInBase('1010_1010', 2), 170n);
  assert.equal(parseInBase('-777', 8), -511n);
  assert.equal(parseInBase('zz', 36), 1295n);
  assert.equal(parseInBase('12', 2), null);
  assert.equal(parseInBase('', 10), null);
  assert.equal(toBase(2n ** 64n, 16), '10000000000000000');
  assert.equal(toBase(-255n, 2), '-11111111');
  assert.equal(parseInBase('18446744073709551617', 10), 2n ** 64n + 1n);
  assert.deepEqual(parsePrefixedInteger('0b101'), { value: 5n, base: 2 });
  assert.equal(groupDigits('1234567', 3, ','), '1,234,567');
  assert.equal(groupDigits('-101101', 4), '-10 1101');
});

// ----------------------------------------------------------- free-form text

test('convertText recognises each kind of selection', () => {
  const ctx = { now: NOW, homeZone: 'America/Chicago', zones: ['Europe/London'], locale: 'en-US' };
  const miles = convertText('5 miles', ctx);
  assert.equal(miles.kind, 'unit');
  assert.equal(miles.items[0].value, '8.04672 km');
  const temp = convertText('72°F', ctx);
  assert.equal(temp.items[0].value, '22.2222 °C');
  const time = convertText('3pm PST', ctx);
  assert.equal(time.kind, 'time');
  assert.match(time.items[0].value, /6:00\s?PM/);
  assert.match(time.items[1].value, /12:00\s?AM/); // London, next day
  assert.equal(convertText('0xFF', ctx).items[0].value, '255');
  assert.equal(convertText('1700000000', ctx).kind, 'timestamp');
  assert.equal(convertText('1234567890123456', ctx), null);
  assert.equal(convertText('just words', ctx), null);
  assert.equal(convertText('', ctx), null);
});
