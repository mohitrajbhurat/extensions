// Run: node --test time-ledger/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialState, splitByDay, mergeInto, liveSegment, desiredActivity, trimSegments } from '../lib/engine.js';

const T0 = new Date(2026, 9, 5, 9, 0, 0).getTime();
const S = 1000;
const tab = (url, title = 'Page', audible = false) => ({ url, title, audible });

/** Feed a list of [offsetMs, event] and collect all segments. */
function run(events, opts = {}, start = initialState()) {
  let state = start;
  let segs = [];
  for (const [t, ev] of events) {
    const r = reduce(state, ev, T0 + t, opts);
    state = r.state;
    if (r.trimAfter != null) segs = trimSegments(segs, r.trimAfter);
    segs.push(...r.segments);
  }
  return { state, segs };
}

/** Heartbeats every 30s from `from` to `to` (exclusive), like chrome.alarms. */
const beats = (from, to) => {
  const out = [];
  for (let t = from + 30 * S; t < to; t += 30 * S) out.push([t, { type: 'beat' }]);
  return out;
};

test('records time on the active tab and switches on tab change', () => {
  const { segs, state } = run([
    [0, { type: 'tab', tab: tab('https://github.com/acme/app') }],
    [30 * S, { type: 'tab', tab: tab('https://www.youtube.com/watch?v=1') }],
    [50 * S, { type: 'focus', focused: false }],
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].domain, 'github.com');
  assert.equal(segs[0].end - segs[0].start, 30 * S);
  assert.equal(segs[1].domain, 'youtube.com');
  assert.equal(segs[1].url, 'https://www.youtube.com/watch');
  assert.equal(segs[1].end - segs[1].start, 20 * S);
  assert.equal(state.cur, null);
});

test('strips query strings unless disabled', () => {
  const a = run([[0, { type: 'tab', tab: tab('https://example.com/a?q=secret#x') }], [5 * S, { type: 'focus', focused: false }]]);
  assert.equal(a.segs[0].url, 'https://example.com/a');
  const b = run([[0, { type: 'tab', tab: tab('https://example.com/a?q=1#x') }], [5 * S, { type: 'focus', focused: false }]], { stripQuery: false });
  assert.equal(b.segs[0].url, 'https://example.com/a?q=1');
});

test('does not track while the browser is unfocused', () => {
  const { segs } = run([
    [0, { type: 'focus', focused: false }],
    [1 * S, { type: 'tab', tab: tab('https://example.com') }],
    [60 * S, { type: 'focus', focused: true }],
    [90 * S, { type: 'focus', focused: false }],
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].start, T0 + 60 * S);
  assert.equal(segs[0].end, T0 + 90 * S);
});

test('idle trims the idle threshold back off the segment', () => {
  const { segs } = run([
    [0, { type: 'tab', tab: tab('https://example.com') }],
    ...beats(0, 300 * S),
    [300 * S, { type: 'idle', idle: 'idle' }],
    ...beats(300 * S, 400 * S),
    [400 * S, { type: 'idle', idle: 'active' }],
    [410 * S, { type: 'focus', focused: false }],
  ], { idleSeconds: 120 });
  const merged = mergeInto([], segs);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end - merged[0].start, 180 * S); // 300 - 120, checkpoints retracted
  assert.equal(merged[1].start, T0 + 400 * S);
  assert.equal(merged[1].end - merged[1].start, 10 * S);
});

test('locked screen stops tracking', () => {
  const { segs, state } = run([
    [0, { type: 'tab', tab: tab('https://example.com') }],
    [100 * S, { type: 'idle', idle: 'locked' }],
  ], { idleSeconds: 60 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].end - segs[0].start, 40 * S);
  assert.equal(state.cur, null);
});

test('audible tab keeps counting while idle (video), but not when locked', () => {
  const { segs, state } = run([
    [0, { type: 'tab', tab: tab('https://youtube.com/watch', 'Video', true) }],
    ...beats(0, 300 * S),
    [300 * S, { type: 'idle', idle: 'idle' }],
    [330 * S, { type: 'beat' }],
  ]);
  assert.ok(state.cur, 'still tracking');
  const tracked = segs.reduce((a, s) => a + s.end - s.start, 0);
  assert.equal(tracked, 330 * S);
  const off = run([
    [0, { type: 'tab', tab: tab('https://youtube.com/watch', 'Video', true) }],
    ...beats(0, 300 * S),
    [300 * S, { type: 'idle', idle: 'idle' }],
  ], { countAudible: false });
  assert.equal(off.segs.reduce((a, s) => a + s.end - s.start, 0), 180 * S);
  assert.equal(off.state.cur, null);
});

test('heartbeat checkpoints progress without losing time', () => {
  const { segs, state } = run([
    [0, { type: 'tab', tab: tab('https://example.com/x') }],
    [30 * S, { type: 'beat' }],
    [60 * S, { type: 'beat' }],
    [90 * S, { type: 'beat' }],
  ]);
  assert.equal(segs.length, 3);
  assert.equal(segs.reduce((a, s) => a + s.end - s.start, 0), 90 * S);
  assert.equal(state.cur.start, T0 + 90 * S);
  const merged = mergeInto([], segs);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end - merged[0].start, 90 * S);
});

test('service worker restart: state round-trips through JSON and continues', () => {
  const first = run([[0, { type: 'tab', tab: tab('https://example.com') }], [30 * S, { type: 'beat' }]]);
  const persisted = JSON.parse(JSON.stringify(first.state));
  // worker restarts 20s later and syncs
  const second = run([[50 * S, { type: 'sync', tab: tab('https://example.com'), focused: true, idle: 'active' }]], {}, persisted);
  const total = [...first.segs, ...second.segs].reduce((a, s) => a + s.end - s.start, 0);
  assert.equal(total, 50 * S);
});

test('sleep / browser closed: closes at last heartbeat instead of counting the gap', () => {
  const { segs, state } = run([
    [0, { type: 'tab', tab: tab('https://example.com') }],
    [30 * S, { type: 'beat' }],
    [2 * 3600 * S, { type: 'sync', tab: tab('https://example.com'), focused: true, idle: 'active' }],
    [2 * 3600 * S + 10 * S, { type: 'focus', focused: false }],
  ]);
  const total = segs.reduce((a, s) => a + s.end - s.start, 0);
  assert.equal(total, 40 * S);
  assert.equal(state.cur, null);
});

test('ignores chrome://, extension pages and excluded domains', () => {
  const { segs } = run([
    [0, { type: 'tab', tab: tab('chrome://extensions') }],
    [10 * S, { type: 'tab', tab: tab('https://bank.example.com/acct') }],
    [20 * S, { type: 'tab', tab: tab('https://news.site/a') }],
    [25 * S, { type: 'focus', focused: false }],
  ], { exclude: ['example.com'] });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].domain, 'news.site');
});

test('pausing tracking closes the segment and resume restarts it', () => {
  const { segs } = run([
    [0, { type: 'tab', tab: tab('https://a.com') }],
    [10 * S, { type: 'enabled', enabled: false }],
    [20 * S, { type: 'tab', tab: tab('https://b.com') }],
    [30 * S, { type: 'enabled', enabled: true }],
    [35 * S, { type: 'focus', focused: false }],
  ]);
  assert.deepEqual(segs.map((s) => [s.domain, (s.end - s.start) / S]), [['a.com', 10], ['b.com', 5]]);
});

test('title updates within the same URL do not split the segment', () => {
  const { segs } = run([
    [0, { type: 'tab', tab: tab('https://mail.example.org/inbox', 'Inbox (3)') }],
    [10 * S, { type: 'tab', tab: tab('https://mail.example.org/inbox', 'Inbox (4)') }],
    [20 * S, { type: 'focus', focused: false }],
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].title, 'Inbox (4)');
});

test('drops blips shorter than the minimum', () => {
  const { segs } = run([
    [0, { type: 'tab', tab: tab('https://a.com') }],
    [300, { type: 'tab', tab: tab('https://b.com') }],
    [5 * S, { type: 'focus', focused: false }],
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].domain, 'b.com');
});

test('clock moving backwards never produces negative time', () => {
  let r = reduce(initialState(), { type: 'tab', tab: tab('https://a.com') }, T0, {});
  r = reduce(r.state, { type: 'beat' }, T0 - 60 * S, {});
  assert.ok(r.segments.every((s) => s.end >= s.start));
});

test('splitByDay splits segments across midnight', () => {
  const start = new Date(2026, 9, 5, 23, 50).getTime();
  const end = new Date(2026, 9, 6, 0, 20).getTime();
  const parts = splitByDay([{ start, end, url: 'u', domain: 'd' }]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].end, new Date(2026, 9, 6).getTime());
  assert.equal(parts[1].end - parts[1].start, 20 * 60 * S);
});

test('mergeInto keeps different URLs and assigned projects apart', () => {
  const a = { start: 0, end: 10, url: 'x', domain: 'd' };
  const b = { start: 10, end: 20, url: 'y', domain: 'd' };
  const c = { start: 20, end: 30, url: 'y', domain: 'd', p: 'proj' };
  assert.equal(mergeInto([], [a, b, c]).length, 3);
  assert.equal(mergeInto([a], [{ ...a, start: 10, end: 15 }]).length, 1);
});

test('liveSegment stops counting when the worker went quiet', () => {
  const state = { ...initialState(), cur: { url: 'u', domain: 'd', title: '', start: T0 }, lastBeat: T0 + 30 * S };
  const live = liveSegment(state, T0 + 3600 * S, 180 * S);
  assert.equal(live.end, T0 + 210 * S);
});

test('desiredActivity requires focus, active idle state and http(s)/file URL', () => {
  const base = { ...initialState(), tab: tab('file:///home/me/notes.html') };
  assert.equal(desiredActivity(base, { exclude: [] }).domain, 'file');
  assert.equal(desiredActivity({ ...base, focused: false }, {}), null);
});
