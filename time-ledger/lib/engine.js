// Tracking engine: a pure state machine that turns browser events into closed
// time segments. The service worker persists `state` after every event, so the
// engine survives service-worker restarts, browser restarts and system sleep.
//
// Events (all carry an implicit `now` passed to reduce):
//   { type: 'tab', tab: { url, title, audible } | null }   active tab changed / navigated
//   { type: 'focus', focused: boolean }                     browser window focus
//   { type: 'idle', idle: 'active' | 'idle' | 'locked' }    chrome.idle state
//   { type: 'enabled', enabled: boolean }                   user paused / resumed tracking
//   { type: 'sync', tab, focused, idle }                    full snapshot (heartbeat / startup)
//   { type: 'beat' }                                        heartbeat checkpoint
//
// Output segments: { start, end, url, domain, title }

import { domainOf, isTrackableUrl, normalizeUrl, addDays, startOfDay } from './util.js';

export const ENGINE_DEFAULTS = {
  idleSeconds: 120,          // chrome.idle detection interval
  maxGapMs: 3 * 60 * 1000,   // heartbeats further apart than this mean sleep / browser closed
  minSegmentMs: 1000,        // drop blips shorter than this
  countAudible: true,        // keep counting while idle if the active tab is playing audio
  stripQuery: true,          // store URLs without query string
  exclude: [],               // domains never tracked
};

export function initialState() {
  return { enabled: true, focused: true, idle: 'active', tab: null, cur: null, lastBeat: 0 };
}

function isExcluded(domain, exclude) {
  if (!domain || !exclude || !exclude.length) return false;
  return exclude.some((d) => {
    const x = String(d).trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
    return x && (domain === x || domain.endsWith('.' + x));
  });
}

/** What should be recorded right now, or null. */
export function desiredActivity(state, opts) {
  const { tab } = state;
  if (!state.enabled || !state.focused || !tab || !isTrackableUrl(tab.url)) return null;
  const engaged = state.idle === 'active' || (opts.countAudible && state.idle === 'idle' && tab.audible);
  if (!engaged) return null;
  const domain = domainOf(tab.url);
  if (!domain || isExcluded(domain, opts.exclude)) return null;
  return {
    url: normalizeUrl(tab.url, opts.stripQuery),
    domain,
    title: String(tab.title || '').slice(0, 200),
  };
}

function close(cur, end, opts, out) {
  if (!cur) return;
  const e = Math.max(cur.start, end);
  if (e - cur.start >= opts.minSegmentMs) {
    out.push({ start: cur.start, end: e, url: cur.url, domain: cur.domain, title: cur.title });
  }
}

/**
 * Apply one event. Returns { state, segments, trimAfter? } without mutating the input.
 * When trimAfter is set, previously stored segments must be cut at that time
 * (see trimSegments) because the user turned out to be idle.
 */
export function reduce(prev, event, now, options = {}) {
  const opts = { ...ENGINE_DEFAULTS, ...options };
  const s = { ...initialState(), ...prev };
  const out = [];

  // 1. Gap detection: if we have not heard from the browser for too long, the
  //    machine slept or the browser/worker was gone. Close at the last beat.
  if (s.cur && s.lastBeat && now - s.lastBeat > opts.maxGapMs) {
    close(s.cur, s.lastBeat, opts, out);
    s.cur = null;
  }
  // Clock went backwards: close what we have at its own start to avoid negative time.
  if (s.cur && now < s.cur.start) {
    s.cur = null;
  }

  // 2. Apply the event to the environment snapshot.
  let closeAt = now;
  let trimAfter = null;
  switch (event.type) {
    case 'tab':
      s.tab = event.tab || null;
      break;
    case 'focus':
      s.focused = !!event.focused;
      break;
    case 'idle': {
      const wasActive = s.idle === 'active';
      s.idle = event.idle;
      // chrome.idle reports "idle" only after idleSeconds of no input, so the
      // last idleSeconds were not really worked. Trim them, unless audio kept us engaged.
      if (wasActive && event.idle !== 'active' && s.cur) {
        const audibleKeeps = event.idle === 'idle' && opts.countAudible && s.tab && s.tab.audible;
        if (!audibleKeeps) {
          const idleSince = now - opts.idleSeconds * 1000;
          closeAt = Math.max(s.cur.start, idleSince);
          // Earlier heartbeat checkpoints may already have stored part of the
          // idle stretch; ask the caller to cut stored time after idleSince.
          if (idleSince < s.cur.start) trimAfter = idleSince;
        }
      }
      break;
    }
    case 'enabled':
      s.enabled = !!event.enabled;
      break;
    case 'sync':
      if ('tab' in event) s.tab = event.tab || null;
      if ('focused' in event) s.focused = !!event.focused;
      if ('idle' in event && event.idle) s.idle = event.idle;
      break;
    case 'beat':
      break;
    default:
      break;
  }

  // 3. Reconcile: start / stop / switch / checkpoint.
  const want = desiredActivity(s, opts);
  const isCheckpoint = event.type === 'beat' || event.type === 'sync';
  if (s.cur && (!want || want.url !== s.cur.url)) {
    close(s.cur, closeAt, opts, out);
    s.cur = null;
  } else if (s.cur && want) {
    s.cur = { ...s.cur, title: want.title || s.cur.title };
    if (isCheckpoint) {
      // Persist progress so a crash loses at most one heartbeat interval.
      close(s.cur, now, opts, out);
      if (now - s.cur.start >= opts.minSegmentMs) s.cur = { ...s.cur, start: now };
    }
  }
  if (!s.cur && want) s.cur = { ...want, start: now };

  s.lastBeat = now;
  return trimAfter !== null ? { state: s, segments: out, trimAfter } : { state: s, segments: out };
}

/** Split segments that cross local midnight so each piece belongs to one day. */
export function splitByDay(segments) {
  const out = [];
  for (const seg of segments) {
    let start = seg.start;
    while (start < seg.end) {
      const nextMidnight = addDays(startOfDay(start), 1);
      const end = Math.min(seg.end, nextMidnight);
      out.push({ ...seg, start, end });
      start = end;
    }
  }
  return out;
}

/**
 * Append new segments to a day's list, merging with the previous one when it
 * is the same URL and (nearly) contiguous. Returns a new array.
 */
export function mergeInto(list, segs, joinGapMs = 5000) {
  const out = list.slice();
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.url === seg.url && seg.start >= last.end - 1 && seg.start - last.end <= joinGapMs
        && (last.p ?? null) === (seg.p ?? null)) {
      out[out.length - 1] = { ...last, end: Math.max(last.end, seg.end), title: seg.title || last.title };
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** The in-progress segment as of `now`, for live UI totals. */
export function liveSegment(state, now, maxGapMs = ENGINE_DEFAULTS.maxGapMs) {
  if (!state || !state.cur) return null;
  // If the worker has not checkpointed for too long, do not keep counting.
  const end = state.lastBeat ? Math.min(now, state.lastBeat + maxGapMs) : now;
  return { ...state.cur, end: Math.max(state.cur.start, end), live: true };
}

/**
 * Cut a stored day list at `ts`: drop segments starting at/after it and
 * shorten those that cross it. Returns a new array.
 */
export function trimSegments(list, ts) {
  const out = [];
  for (const seg of list) {
    if (seg.start >= ts) continue;
    out.push(seg.end > ts ? { ...seg, end: ts } : seg);
  }
  return out;
}
