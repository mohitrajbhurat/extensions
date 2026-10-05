const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/stats.js');

const DAY = 86400000;
const now = Date.UTC(2026, 0, 31);
const h = (daysAgo, p, a = 'in_stock') => ({ t: now - daysAgo * DAY, p, a });

test('time-weighted average ignores check bursts', () => {
  const hist = [h(30, 100), h(20, 50), h(19.99, 50), h(19.98, 50), h(10, 100)];
  const s = S.computeStats(hist, { now });
  assert.equal(s.min, 50);
  assert.equal(s.max, 100);
  assert.equal(s.current, 100);
  // 10 days @100, 10 days @50, 10 days @100 -> ~83.33
  assert.ok(Math.abs(s.avg - 83.33) < 0.1, `avg ${s.avg}`);
});

test('window carries the last price before the window', () => {
  const s = S.computeStats([h(100, 80), h(5, 60)], { now, windowDays: 30 });
  assert.equal(s.max, 80);
  assert.equal(s.min, 60);
});

test('verdicts', () => {
  const base = [h(60, 100), h(40, 90), h(20, 110)];
  assert.equal(S.verdict(S.computeStats([...base, h(1, 85)], { now })).level, 'great');
  assert.equal(S.verdict(S.computeStats([...base, h(1, 92)], { now })).level, 'good');
  assert.equal(S.verdict(S.computeStats([...base, h(1, 100)], { now })).level, 'fair');
  assert.equal(S.verdict(S.computeStats([...base, h(1, 109)], { now })).level, 'high');
  assert.equal(S.verdict(S.computeStats([h(0.1, 100)], { now })).level, 'unknown');
  assert.equal(S.verdict(S.computeStats([], { now })).level, 'unknown');
});

test('saleCheck flags inflated "was" prices', () => {
  const stats = S.computeStats([h(60, 50), h(30, 50), h(1, 48)], { now });
  const r = S.saleCheck(48, 80, stats);
  assert.equal(r.honest, false);
  assert.match(r.text, /never seen|not below/);
  const stats2 = S.computeStats([h(60, 80), h(30, 80), h(1, 60)], { now });
  assert.equal(S.saleCheck(60, 80, stats2).honest, true);
  assert.equal(S.saleCheck(60, 50, stats2), null);
});

test('targetPrice', () => {
  assert.equal(S.targetPrice({ type: 'price', value: 40 }, 50), 40);
  assert.equal(S.targetPrice({ type: 'percent', value: 20 }, 50), 40);
  assert.equal(S.targetPrice({ type: 'none' }, 50), null);
  assert.equal(S.targetPrice({ type: 'percent', value: 120 }, 50), null);
});

test('evaluateAlerts: target fires once, low and stock alerts', () => {
  const item = { target: { type: 'price', value: 45 }, baselinePrice: 50, history: [h(3, 50), h(2, 49, 'out_of_stock')], alertState: {} };
  let r = S.evaluateAlerts(item, { t: now, p: 44, a: 'in_stock' });
  const kinds = r.alerts.map(a => a.kind).sort();
  assert.deepEqual(kinds, ['low', 'stock', 'target']);
  item.history.push({ t: now, p: 44, a: 'in_stock' });
  item.alertState = r.state;
  r = S.evaluateAlerts(item, { t: now + 1, p: 44, a: 'in_stock' });
  assert.deepEqual(r.alerts, []);
  r = S.evaluateAlerts({ ...item, alertState: r.state }, { t: now + 2, p: 60, a: 'in_stock' });
  assert.equal(r.state.targetHit, false);
});

test('no low alert on first observation', () => {
  const r = S.evaluateAlerts({ history: [], target: { type: 'none' } }, { t: now, p: 10, a: 'in_stock' });
  assert.deepEqual(r.alerts, []);
});
