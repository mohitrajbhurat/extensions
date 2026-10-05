// Mindful Gate service worker: rules, passes, schedules, focus timer, time tracking.
import {
  defaultSettings, normalizeSettings, normalizeDomain, hostOf, hostMatches, rootDomain,
  matchingDomains, groupsForHost, gatedDomains, activeSchedule, dayKey, emptyDay,
  breathSeconds, fmtHourMin, uid,
} from './lib/core.js';

const EXT = chrome.runtime.getURL('');
const GATE_URL = EXT + 'gate/gate.html';
const BLOCK_URL = EXT + 'block/block.html';
const MAX_INTENTIONS = 2000;
const MAX_FOCUS_LOG = 3000;
const STATS_KEEP_DAYS = 400;

// ---------------------------------------------------------------- storage helpers

let chain = Promise.resolve();
/** Serialize read-modify-write operations on chrome.storage. */
function locked(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

async function getLocal(keys) { return chrome.storage.local.get(keys); }

async function getSettings() {
  const { settings } = await getLocal('settings');
  return normalizeSettings(settings);
}

async function getFocus() {
  const { focus } = await getLocal('focus');
  return focus && focus.phase ? focus : { phase: 'idle' };
}

async function getPasses() {
  const { passes } = await getLocal('passes');
  const now = Date.now();
  const out = {};
  for (const [d, p] of Object.entries(passes || {})) if (p && p.until > now) out[d] = p;
  return out;
}

async function getSnoozes() {
  const { snoozes } = await getLocal('snoozes');
  const now = Date.now();
  const out = {};
  for (const [g, until] of Object.entries(snoozes || {})) if (until > now) out[g] = until;
  return out;
}

/** Mutate today's stats (or another day's) inside the lock. */
function updateStats(mutator, ts = Date.now()) {
  return locked(async () => {
    const { stats = {} } = await getLocal('stats');
    const key = dayKey(ts);
    const day = { ...emptyDay(), ...(stats[key] || {}) };
    mutator(day);
    stats[key] = day;
    // prune very old days
    const keys = Object.keys(stats).sort();
    while (keys.length > STATS_KEEP_DAYS) delete stats[keys.shift()];
    await chrome.storage.local.set({ stats });
  });
}

function bump(obj, k, n = 1) { obj[k] = (obj[k] || 0) + n; }

function addIntention(entry) {
  return locked(async () => {
    const { intentions = [] } = await getLocal('intentions');
    intentions.push({ id: uid(), ts: Date.now(), ...entry });
    if (intentions.length > MAX_INTENTIONS) intentions.splice(0, intentions.length - MAX_INTENTIONS);
    await chrome.storage.local.set({ intentions });
  });
}

// ---------------------------------------------------------------- block computation

function focusBlocking(focus) {
  return focus.phase === 'work' && !focus.paused && focus.endsAt > Date.now();
}

/** Map of groupId -> {reason, until, strict} for every group that is hard blocked now. */
function computeBlocked(settings, focus, snoozes, now = new Date()) {
  const out = {};
  for (const g of settings.groups) {
    const sch = activeSchedule(g, now);
    if (sch && !(snoozes[g.id] && !g.strict)) {
      out[g.id] = { reason: 'schedule', until: sch.until, strict: g.strict, group: g.name };
      continue;
    }
    if (g.blockDuringFocus && focusBlocking(focus)) {
      out[g.id] = { reason: 'focus', until: focus.endsAt, strict: !!settings.pomodoro.strict, group: g.name };
    }
  }
  return out;
}

async function loadContext() {
  const [settings, focus, passes, snoozes] = await Promise.all([getSettings(), getFocus(), getPasses(), getSnoozes()]);
  const blocked = computeBlocked(settings, focus, snoozes);
  return { settings, focus, passes, snoozes, blocked };
}

function blockForHost(ctx, host) {
  let best = null;
  for (const g of groupsForHost(ctx.settings, host)) {
    const b = ctx.blocked[g.id];
    if (!b) continue;
    if (!best || (b.strict && !best.strict) || b.until > best.until) best = { ...b, groupId: g.id };
  }
  return best;
}

function passForHost(ctx, host) {
  for (const d of matchingDomains(ctx.settings, host)) if (ctx.passes[d]) return { domain: d, ...ctx.passes[d] };
  return null;
}

function isGated(ctx, host) {
  return gatedDomains(ctx.settings).some(d => hostMatches(host, d));
}

function blockPageUrl(b, url) {
  return `${BLOCK_URL}?r=${b.reason}&g=${encodeURIComponent(b.groupId || '')}&u=${url}`;
}

// ---------------------------------------------------------------- declarativeNetRequest rules

function desiredRules(ctx) {
  const rules = [];
  let id = 1;
  const blockedSites = new Set();
  for (const g of ctx.settings.groups) {
    const b = ctx.blocked[g.id];
    if (!b) continue;
    for (const d of g.sites) {
      if (blockedSites.has(d)) continue;
      blockedSites.add(d);
      rules.push({
        id: id++,
        priority: 3,
        action: { type: 'redirect', redirect: { regexSubstitution: `${BLOCK_URL}?r=${b.reason}&g=${encodeURIComponent(g.id)}&u=\\0` } },
        condition: { regexFilter: '^https?://.*', requestDomains: [d], resourceTypes: ['main_frame'] },
      });
    }
  }
  for (const d of gatedDomains(ctx.settings)) {
    if (ctx.passes[d]) continue;
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${GATE_URL}?u=\\0` } },
      condition: { regexFilter: '^https?://.*', requestDomains: [d], resourceTypes: ['main_frame'] },
    });
  }
  return rules;
}

function ruleKey(r) {
  return JSON.stringify([r.priority, r.action.redirect.regexSubstitution, r.condition.requestDomains]);
}

/** Bring dynamic rules in line with current state. Returns true if anything changed. */
async function syncRules(ctx) {
  ctx = ctx || await loadContext();
  const want = desiredRules(ctx);
  const have = await chrome.declarativeNetRequest.getDynamicRules();
  const a = want.map(ruleKey).sort().join('\n');
  const b = have.map(ruleKey).sort().join('\n');
  if (a !== b) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: have.map(r => r.id), addRules: want });
  }
  await updateBadge(ctx.focus, ctx.settings);
  const sig = JSON.stringify(Object.keys(ctx.blocked).sort());
  const { blockSig } = await chrome.storage.session.get('blockSig');
  if (sig !== blockSig) {
    await chrome.storage.session.set({ blockSig: sig });
    await enforceOpenTabs(ctx);
  }
  return a !== b;
}

const syncSoon = (() => {
  let p = null;
  return () => {
    if (!p) p = locked(() => syncRules()).finally(() => { p = null; });
    return p;
  };
})();

/** Redirect already-open tabs on hard-blocked sites to the block page. */
async function enforceOpenTabs(ctx) {
  if (!Object.keys(ctx.blocked).length) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    const host = hostOf(t.url);
    const b = host && blockForHost(ctx, host);
    if (b) {
      chrome.tabs.update(t.id, { url: blockPageUrl(b, t.url) }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- passes

async function grantPass(domain, minutes, intention, kind = 'pass') {
  minutes = Math.max(1, Math.min(240, Number(minutes) || 5));
  const until = Date.now() + minutes * 60000;
  await locked(async () => {
    const { passes = {} } = await getLocal('passes');
    passes[domain] = { until, minutes, intention, grantedAt: Date.now() };
    await chrome.storage.local.set({ passes });
  });
  chrome.alarms.create('pass:' + domain, { when: until });
  const settings = await getSettings();
  if (settings.gate.warnBeforeEnd && minutes > 1) chrome.alarms.create('warn:' + domain, { when: until - 60000 });
  await updateStats(day => { bump(day.passes, domain); });
  await addIntention({ domain, text: intention, minutes, outcome: kind });
  await locked(() => syncRules());
  return { until };
}

async function endPass(domain, { inject = true } = {}) {
  await locked(async () => {
    const { passes = {} } = await getLocal('passes');
    delete passes[domain];
    await chrome.storage.local.set({ passes });
  });
  chrome.alarms.clear('pass:' + domain);
  chrome.alarms.clear('warn:' + domain);
  await locked(() => syncRules());
  if (inject) await injectIntoDomainTabs(domain);
}

async function injectIntoDomainTabs(domain) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (!hostMatches(hostOf(t.url), domain)) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/overlay.js'] });
    } catch (e) {
      // No access (e.g. a restricted page): fall back to sending the tab through the gate.
      chrome.tabs.update(t.id, { url: `${GATE_URL}?u=${t.url}` }).catch(() => {});
    }
  }
}

async function expireStalePasses() {
  const { passes = {} } = await getLocal('passes');
  const now = Date.now();
  const stale = Object.keys(passes).filter(d => !(passes[d] && passes[d].until > now));
  for (const d of stale) await endPass(d);
}

// ---------------------------------------------------------------- focus timer

function phaseMinutes(settings, phase) {
  const p = settings.pomodoro;
  return phase === 'work' ? p.work : phase === 'short' ? p.short : p.long;
}

async function setFocus(focus) {
  await chrome.storage.local.set({ focus });
  chrome.alarms.clear('focus');
  if (focus.phase !== 'idle' && !focus.paused) chrome.alarms.create('focus', { when: focus.endsAt });
  await locked(() => syncRules());
  return focus;
}

async function focusStart(task) {
  const settings = await getSettings();
  const cur = await getFocus();
  const now = Date.now();
  const focus = {
    phase: 'work',
    paused: false,
    startedAt: now,
    endsAt: now + phaseMinutes(settings, 'work') * 60000,
    duration: phaseMinutes(settings, 'work') * 60000,
    cycle: cur.phase === 'idle' ? 0 : (cur.cycle || 0),
    task: (task || cur.task || '').slice(0, 140),
  };
  await setFocus(focus);
  sound('start');
  return focus;
}

function assertNotStrictFocus(settings, focus) {
  if (settings.pomodoro.strict && focus.phase === 'work' && !focus.paused) {
    throw new Error('Strict focus is on: this session cannot be paused or stopped until it ends.');
  }
}

async function focusPause() {
  const [settings, focus] = await Promise.all([getSettings(), getFocus()]);
  if (focus.phase === 'idle' || focus.paused) return focus;
  assertNotStrictFocus(settings, focus);
  focus.paused = true;
  focus.remaining = Math.max(0, focus.endsAt - Date.now());
  return setFocus(focus);
}

async function focusResume() {
  const focus = await getFocus();
  if (focus.phase === 'idle' || !focus.paused) return focus;
  focus.paused = false;
  const now = Date.now();
  if (!focus.startedAt || focus.remaining >= focus.duration) focus.startedAt = now;
  focus.endsAt = now + (focus.remaining || focus.duration);
  delete focus.remaining;
  sound('start');
  return setFocus(focus);
}

async function logFocus(focus, minutes, completed) {
  if (minutes < 1) return;
  await locked(async () => {
    const { focusLog = [] } = await getLocal('focusLog');
    focusLog.push({ id: uid(), start: focus.startedAt || Date.now(), end: Date.now(), minutes: Math.round(minutes), task: focus.task || '', completed });
    if (focusLog.length > MAX_FOCUS_LOG) focusLog.splice(0, focusLog.length - MAX_FOCUS_LOG);
    await chrome.storage.local.set({ focusLog });
  });
  await updateStats(day => { day.focusMinutes += Math.round(minutes); if (completed) day.focusSessions++; });
}

function workedMinutes(focus) {
  if (focus.phase !== 'work') return 0;
  const left = focus.paused ? (focus.remaining ?? focus.duration) : Math.max(0, focus.endsAt - Date.now());
  return (focus.duration - left) / 60000;
}

async function focusStop() {
  const [settings, focus] = await Promise.all([getSettings(), getFocus()]);
  if (focus.phase === 'idle') return focus;
  assertNotStrictFocus(settings, focus);
  await logFocus(focus, workedMinutes(focus), false);
  return setFocus({ phase: 'idle', task: focus.task || '' });
}

async function focusSkip() {
  const [settings, focus] = await Promise.all([getSettings(), getFocus()]);
  if (focus.phase === 'idle') return focus;
  assertNotStrictFocus(settings, focus);
  return completePhase(true);
}

/** Current phase finished (timer ran out, or skipped). Move on to the next phase. */
async function completePhase(skipped = false) {
  const settings = await getSettings();
  const focus = await getFocus();
  if (focus.phase === 'idle') return focus;
  const p = settings.pomodoro;
  let next;
  if (focus.phase === 'work') {
    const mins = skipped ? workedMinutes(focus) : focus.duration / 60000;
    await logFocus(focus, mins, !skipped);
    const done = (focus.cycle || 0) + 1;
    const phase = done % Math.max(1, p.cycles) === 0 ? 'long' : 'short';
    next = { phase, cycle: done, task: focus.task, auto: p.autoStartBreaks };
    if (!skipped) notify('focus-done', 'Focus session complete', `Nice work${focus.task ? ` on "${focus.task}"` : ''}. Time for a ${phase === 'long' ? 'long' : 'short'} break (${phaseMinutes(settings, phase)} min).`, !p.autoStartBreaks ? 'Start break' : null);
    if (!skipped) sound('done');
  } else {
    const cycle = focus.phase === 'long' ? 0 : focus.cycle || 0;
    next = { phase: 'work', cycle, task: focus.task, auto: p.autoStartWork };
    if (!skipped) notify('break-done', 'Break is over', 'Ready for another focus session?', !p.autoStartWork ? 'Start focus' : null);
    if (!skipped) sound('break');
  }
  const dur = phaseMinutes(settings, next.phase) * 60000;
  const now = Date.now();
  const nf = { phase: next.phase, cycle: next.cycle, task: next.task, duration: dur, startedAt: now };
  if (next.auto) { nf.paused = false; nf.endsAt = now + dur; } else { nf.paused = true; nf.remaining = dur; nf.endsAt = now + dur; }
  return setFocus(nf);
}

async function updateBadge(focus, settings) {
  focus = focus || await getFocus();
  settings = settings || await getSettings();
  if (focus.phase === 'idle' || !settings.pomodoro.badge) {
    chrome.alarms.clear('badge');
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const work = focus.phase === 'work';
  await chrome.action.setBadgeBackgroundColor({ color: work ? '#c2413a' : '#1f8a5b' });
  try { if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' }); } catch { /* older browsers */ }
  let text;
  if (focus.paused) text = work ? 'II' : '...';
  else {
    const left = Math.max(0, focus.endsAt - Date.now());
    const mins = Math.ceil(left / 60000);
    text = left < 60000 ? `${Math.ceil(left / 1000)}s` : `${mins}m`;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title: `Mindful Gate: ${work ? 'focus' : 'break'} ${focus.paused ? '(paused)' : text + ' left'}` });
  if (!focus.paused) {
    const a = await chrome.alarms.get('badge');
    if (!a) chrome.alarms.create('badge', { periodInMinutes: 0.5 });
  } else chrome.alarms.clear('badge');
}

// ---------------------------------------------------------------- notifications & sound

async function notify(id, title, message, button) {
  const settings = await getSettings();
  if (!settings.pomodoro.notifications || !chrome.notifications) return;
  const opts = { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 };
  if (button) opts.buttons = [{ title: button }];
  try { chrome.notifications.create(id + ':' + Date.now(), opts); } catch { /* ignore */ }
}

let creatingOffscreen = null;
async function sound(kind) {
  const settings = await getSettings();
  if (!settings.pomodoro.sound || !chrome.offscreen) return;
  try {
    const has = chrome.runtime.getContexts
      ? (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0
      : false;
    if (!has) {
      creatingOffscreen = creatingOffscreen || chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play focus timer chimes generated with WebAudio.',
      });
      await creatingOffscreen;
      creatingOffscreen = null;
    }
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'play', kind, volume: settings.pomodoro.volume });
  } catch {
    creatingOffscreen = null;
  }
}

// ---------------------------------------------------------------- active-tab time tracking

async function flushTracking(now = Date.now(), subtractMs = 0) {
  const { track } = await chrome.storage.session.get('track');
  if (!track || !track.domain) return;
  let ms = Math.min(now - track.since, 120000) - subtractMs;
  await chrome.storage.session.set({ track: { ...track, since: now } });
  if (ms < 500) return;
  await updateStats(day => { bump(day.sites, track.domain, Math.round(ms / 1000)); }, track.since);
}

async function retrack({ subtractMs = 0 } = {}) {
  await flushTracking(Date.now(), subtractMs);
  const settings = await getSettings();
  let domain = '';
  if (settings.tracking.enabled) {
    try {
      const state = await chrome.idle.queryState(Math.max(15, settings.tracking.idleSeconds));
      const win = await chrome.windows.getLastFocused();
      if (state === 'active' && win && win.focused) {
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (tab && tab.url) domain = rootDomain(settings, hostOf(tab.url));
      }
    } catch { /* no window */ }
  }
  await chrome.storage.session.set({ track: domain ? { domain, since: Date.now() } : null });
}

// Tracking has its own queue: retrack() writes stats through locked(), so it must not run inside it.
let trackChain = Promise.resolve();
function trackLocked(fn) {
  const run = trackChain.then(() => fn());
  trackChain = run.catch(() => {});
  return run;
}

const retrackSoon = (() => {
  let t = null;
  return (opts) => { clearTimeout(t); t = setTimeout(() => trackLocked(() => retrack(opts)).catch(() => {}), 150); };
})();

chrome.tabs.onActivated.addListener(() => retrackSoon());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.url && tab.active) retrackSoon(); });
chrome.windows.onFocusChanged.addListener(() => retrackSoon());
chrome.idle.onStateChanged.addListener(async state => {
  const settings = await getSettings();
  retrackSoon(state === 'active' ? {} : { subtractMs: settings.tracking.idleSeconds * 1000 });
});

// ---------------------------------------------------------------- settings with strict-mode guard

function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** Throws if `next` loosens a group that is currently in a strict block. */
function validateStrict(prev, next, focus) {
  const now = new Date();
  for (const g of prev.groups) {
    const sch = activeSchedule(g, now);
    const strictFocus = prev.pomodoro.strict && focusBlocking(focus) && g.blockDuringFocus;
    if (!(g.strict && sch) && !strictFocus) continue;
    const n = next.groups.find(x => x.id === g.id);
    const until = sch && g.strict ? sch.until : focus.endsAt;
    const msg = `"${g.name}" is locked by strict mode until ${fmtHourMin(until)}. You can add sites, but not remove or loosen anything.`;
    if (!n) throw new Error(msg);
    if (!g.sites.every(d => n.sites.includes(d))) throw new Error(msg);
    if (g.strict && sch) {
      if (!n.strict || n.mode !== g.mode || !sameJSON(n.schedules, g.schedules)) throw new Error(msg);
    }
    if (strictFocus && !n.blockDuringFocus) throw new Error(msg);
  }
  if (prev.pomodoro.strict && focusBlocking(focus) && !next.pomodoro.strict) {
    throw new Error('Strict focus cannot be turned off during a focus session.');
  }
}

async function saveSettings(next) {
  return locked(async () => {
    const prev = await getSettings();
    const focus = await getFocus();
    const n = normalizeSettings(next);
    validateStrict(prev, n, focus);
    await chrome.storage.local.set({ settings: n });
    if (n.tracking.idleSeconds) chrome.idle.setDetectionInterval(Math.max(15, n.tracking.idleSeconds));
    await syncRules();
    return n;
  });
}

async function addSite(domain, groupId) {
  const d = normalizeDomain(domain);
  if (!d) throw new Error('That does not look like a website address.');
  const s = await getSettings();
  let g = s.groups.find(x => x.id === groupId) || s.groups[0];
  if (!g) {
    g = { id: uid(), name: 'Distractions', sites: [], mode: 'gate', blockDuringFocus: true, strict: false, schedules: [] };
    s.groups.push(g);
  }
  if (!g.sites.includes(d)) g.sites.push(d);
  await saveSettings(s);
  return { domain: d, groupId: g.id };
}

async function removeSite(domain) {
  const s = await getSettings();
  for (const g of s.groups) g.sites = g.sites.filter(x => x !== domain);
  await saveSettings(s);
  return { ok: true };
}

// ---------------------------------------------------------------- message API

async function tabStatus(url) {
  const ctx = await loadContext();
  const host = hostOf(url);
  if (!host) return { host: '', trackable: false };
  const groups = groupsForHost(ctx.settings, host).map(g => ({ id: g.id, name: g.name }));
  return {
    host,
    trackable: true,
    domain: rootDomain(ctx.settings, host) || normalizeDomain(host),
    listed: groups.length > 0,
    groups,
    gated: isGated(ctx, host),
    pass: passForHost(ctx, host),
    blocked: blockForHost(ctx, host),
  };
}

async function gateOpened(url, count) {
  const ctx = await loadContext();
  const host = hostOf(url);
  const domain = rootDomain(ctx.settings, host) || host;
  const blocked = host ? blockForHost(ctx, host) : null;
  const { stats = {}, intentions = [] } = await getLocal(['stats', 'intentions']);
  const today = stats[dayKey()] || emptyDay();
  const visits = today.prompts[domain] || 0;
  if (count && domain && !blocked) await updateStats(day => { bump(day.prompts, domain); });
  const pass = host ? passForHost(ctx, host) : null;
  return {
    domain,
    host,
    blocked: blocked ? { ...blocked, url: blockPageUrl(blocked, url) } : null,
    pass,
    visitsToday: visits,
    breath: breathSeconds(ctx.settings.gate, visits),
    passOptions: ctx.settings.gate.passOptions,
    minIntention: ctx.settings.gate.minIntention,
    reasons: ctx.settings.reasons,
    timeToday: today.sites[domain] || 0,
    turnedBackToday: today.turnedBack[domain] || 0,
    recent: intentions.filter(i => i.domain === domain).slice(-3).reverse(),
  };
}

async function recordTurnBack(domain, text) {
  await updateStats(day => { bump(day.turnedBack, domain); });
  await addIntention({ domain, text: text || '', minutes: 0, outcome: 'back' });
}

async function blockInfo(groupId, reason, url) {
  const ctx = await loadContext();
  const g = ctx.settings.groups.find(x => x.id === groupId);
  const host = hostOf(url);
  const b = (groupId && ctx.blocked[groupId]) ? { ...ctx.blocked[groupId], groupId } : (host ? blockForHost(ctx, host) : null);
  return {
    group: g ? { id: g.id, name: g.name, strict: g.strict } : null,
    blocked: b,
    focus: ctx.focus,
    reasons: ctx.settings.reasons,
    host,
    canSnooze: !!(b && b.reason === 'schedule' && !b.strict),
  };
}

async function snoozeGroup(groupId, intention) {
  const ctx = await loadContext();
  const g = ctx.settings.groups.find(x => x.id === groupId);
  const b = ctx.blocked[groupId];
  if (!g || !b || b.reason !== 'schedule' || g.strict) throw new Error('This block cannot be snoozed.');
  const until = Date.now() + 5 * 60000;
  await locked(async () => {
    const { snoozes = {} } = await getLocal('snoozes');
    snoozes[groupId] = until;
    await chrome.storage.local.set({ snoozes });
  });
  chrome.alarms.create('snooze:' + groupId, { when: until });
  await addIntention({ domain: g.name, text: intention || '', minutes: 5, outcome: 'snooze' });
  await locked(() => syncRules());
  return { until };
}

async function exportData() {
  return chrome.storage.local.get(['settings', 'stats', 'intentions', 'focusLog']);
}

async function importData(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid backup file.');
  const out = {};
  if (data.stats && typeof data.stats === 'object') out.stats = data.stats;
  if (Array.isArray(data.intentions)) out.intentions = data.intentions.slice(-MAX_INTENTIONS);
  if (Array.isArray(data.focusLog)) out.focusLog = data.focusLog.slice(-MAX_FOCUS_LOG);
  await chrome.storage.local.set(out);
  if (data.settings) await saveSettings(data.settings);
  return { ok: true };
}

async function clearData() {
  await locked(() => chrome.storage.local.remove(['stats', 'intentions', 'focusLog']));
  return { ok: true };
}

const handlers = {
  async getState() {
    const ctx = await loadContext();
    return { settings: ctx.settings, focus: ctx.focus, passes: ctx.passes, blocked: ctx.blocked, snoozes: ctx.snoozes, now: Date.now() };
  },
  tabStatus: m => tabStatus(m.url),
  saveSettings: m => saveSettings(m.settings),
  addSite: m => addSite(m.domain, m.groupId),
  removeSite: m => removeSite(m.domain),
  gateOpened: m => gateOpened(m.url, m.count),
  async grantPass(m) {
    const ctx = await loadContext();
    const host = hostOf(m.url);
    if (!host) throw new Error('Unknown site.');
    if (blockForHost(ctx, host)) throw new Error('This site is hard blocked right now.');
    const domain = rootDomain(ctx.settings, host) || host;
    const text = String(m.intention || '').trim().slice(0, 280);
    if (text.length < ctx.settings.gate.minIntention) throw new Error('Write your intention first.');
    return grantPass(domain, m.minutes, text, 'pass');
  },
  async turnBack(m, sender) {
    const ctx = await loadContext();
    const host = hostOf(m.url);
    const domain = rootDomain(ctx.settings, host) || host;
    if (domain) await recordTurnBack(domain, String(m.intention || '').slice(0, 280));
    return { ok: true };
  },
  async closeTab(m, sender) {
    if (sender.tab) {
      const tabs = await chrome.tabs.query({ windowId: sender.tab.windowId });
      if (tabs.length <= 1) await chrome.tabs.create({ windowId: sender.tab.windowId });
      await chrome.tabs.remove(sender.tab.id);
    }
    return { ok: true };
  },
  endPass: m => endPass(m.domain).then(() => ({ ok: true })),
  async overlayInfo(m, sender) {
    const ctx = await loadContext();
    const host = sender.tab ? hostOf(sender.tab.url) : '';
    const pass = host ? passForHost(ctx, host) : null;
    const domain = rootDomain(ctx.settings, host) || host;
    if (!domain || !isGated(ctx, host)) return { mode: 'none' };
    const blocked = blockForHost(ctx, host);
    if (blocked) return { mode: 'none' };
    if (pass) return { mode: 'warn', domain, until: pass.until, intention: pass.intention };
    const { intentions = [] } = await getLocal('intentions');
    const last = intentions.filter(i => i.domain === domain && (i.outcome === 'pass' || i.outcome === 'extend')).pop();
    return { mode: 'expired', domain, intention: last ? last.text : '', extendMinutes: ctx.settings.gate.extendMinutes, pause: 5 };
  },
  async extendPass(m, sender) {
    const ctx = await loadContext();
    const host = sender.tab ? hostOf(sender.tab.url) : '';
    const domain = rootDomain(ctx.settings, host);
    if (!domain) throw new Error('Site is no longer on your list.');
    if (blockForHost(ctx, host)) throw new Error('This site is hard blocked right now.');
    await updateStats(day => { bump(day.prompts, domain); });
    return grantPass(domain, ctx.settings.gate.extendMinutes, String(m.intention || 'Extended').slice(0, 280), 'extend');
  },
  async leaveSite(m, sender) {
    const host = sender.tab ? hostOf(sender.tab.url) : '';
    const settings = await getSettings();
    const domain = rootDomain(settings, host) || host;
    if (domain) await recordTurnBack(domain, 'Left when the pass ended');
    if (sender.tab) await chrome.tabs.update(sender.tab.id, { url: `${GATE_URL}?left=1&u=${sender.tab.url}` });
    return { ok: true };
  },
  blockInfo: m => blockInfo(m.groupId, m.reason, m.url),
  snooze: m => snoozeGroup(m.groupId, m.intention),
  async blockHit() { await updateStats(day => { day.blockedHits++; }); return { ok: true }; },
  focusStart: m => focusStart(m.task),
  focusPause: () => focusPause(),
  focusResume: () => focusResume(),
  focusStop: () => focusStop(),
  focusSkip: () => focusSkip(),
  async setTask(m) {
    const f = await getFocus();
    f.task = String(m.task || '').slice(0, 140);
    await chrome.storage.local.set({ focus: f });
    return f;
  },
  exportData: () => exportData(),
  importData: m => importData(m.data),
  clearData: () => clearData(),
  testSound: m => sound(m.kind || 'done').then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(res => sendResponse(res === undefined ? { ok: true } : res))
    .catch(e => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ---------------------------------------------------------------- alarms, commands, lifecycle

chrome.alarms.onAlarm.addListener(async alarm => {
  const n = alarm.name;
  if (n === 'tick') {
    await trackLocked(() => retrack());
    await expireStalePasses();
    await syncSoon();
  } else if (n === 'badge') {
    await updateBadge();
  } else if (n === 'focus') {
    const f = await getFocus();
    if (f.phase !== 'idle' && !f.paused && f.endsAt <= Date.now() + 1000) await completePhase(false);
  } else if (n.startsWith('pass:')) {
    await endPass(n.slice(5));
  } else if (n.startsWith('warn:')) {
    await injectIntoDomainTabs(n.slice(5));
  } else if (n.startsWith('snooze:')) {
    await syncSoon();
  }
});

chrome.notifications?.onButtonClicked.addListener(async () => {
  const f = await getFocus();
  if (f.phase !== 'idle' && f.paused) await focusResume();
});

chrome.commands?.onCommand.addListener(async cmd => {
  const f = await getFocus();
  if (cmd === 'toggle-focus') {
    try {
      if (f.phase === 'idle') await focusStart();
      else if (f.paused) await focusResume();
      else await focusPause();
    } catch (e) {
      notify('strict', 'Strict focus', e.message);
    }
  } else if (cmd === 'open-dashboard') {
    chrome.tabs.create({ url: 'dashboard/dashboard.html' });
  }
});

async function init() {
  const { settings } = await getLocal('settings');
  if (!settings) await chrome.storage.local.set({ settings: defaultSettings() });
  const s = await getSettings();
  chrome.idle.setDetectionInterval(Math.max(15, s.tracking.idleSeconds));
  const tick = await chrome.alarms.get('tick');
  if (!tick) chrome.alarms.create('tick', { periodInMinutes: 1 });
  await chrome.storage.session.remove('blockSig');
  await expireStalePasses();
  await locked(() => syncRules());
  const f = await getFocus();
  if (f.phase !== 'idle' && !f.paused && f.endsAt <= Date.now()) await completePhase(false);
}

chrome.runtime.onInstalled.addListener(async details => {
  await init();
  if (details.reason === 'install') chrome.tabs.create({ url: 'options/options.html#welcome' });
});
chrome.runtime.onStartup.addListener(() => { init(); });

// Exposed for debugging from the service worker console and for automated tests.
self.mindfulGate = { syncRules: () => locked(() => syncRules()), endPass, grantPass, loadContext, completePhase, focusStart, focusStop };
