// Privacy Shield service worker.
//
// Blocking itself is done by declarativeNetRequest (static rulesets per category plus a few
// dynamic rules for the allowlist and learned trackers). This worker only *observes* traffic
// through non-blocking webRequest events to build the per-tab report, the dashboard totals
// and the heuristic learning data, and keeps the rule state in sync with the settings.

import { CATEGORY_IDS, RULESET_ID, categoryOf, trackerDomainOf } from './lib/trackers.js';
import { registrableDomain, hostFromUrl, isWebUrl, hostMatchesDomain, parseSiteInput } from './lib/domain.js';
import { isSameEntity } from './lib/entities.js';
import { stripTrackingParams } from './lib/params.js';
import { buildDynamicRules } from './lib/rules-builder.js';
import { KEYS, getSettings, saveSettings, getList, setList, mergeSettings, dayKey, COOKIE_MODES } from './lib/store.js';
import { gradeSite } from './lib/grade.js';
import { learnableDomain, recordObservation, learnedBlockList, isFlagged, pruneLearned } from './lib/learning.js';

const GPC_SCRIPT_ID = 'privacy-shield-gpc';
const MAX_SITES = 1000;
const MAX_DAYS = 400;
const MAX_TRACKER_STATS = 2000;

// ───────────────────────────── in-memory state ─────────────────────────────

const mem = {
  settings: mergeSettings(null),
  allowlist: [],
  trusted: [],
  userBlocked: [],
  learned: {},
  stats: { days: {}, domains: {}, since: Date.now() },
  sites: {},
  tabs: new Map(), // tabId -> TabReport
};

/** @returns {object} a fresh per-tab report */
function newTab(url, requestId) {
  const host = hostFromUrl(url);
  return {
    url,
    host,
    site: registrableDomain(host),
    navRequestId: requestId ?? null,
    started: Date.now(),
    trackers: {}, // domain -> { category, requests, blocked }
    params: 0,
    paramNames: [],
    banner: null, // { cmp, name, action, ok }
  };
}

const ready = (async () => {
  const data = await chrome.storage.local.get([KEYS.settings, KEYS.allowlist, KEYS.trusted, KEYS.userBlocked, KEYS.learned, KEYS.stats, KEYS.sites]);
  mem.settings = mergeSettings(data[KEYS.settings]);
  mem.allowlist = Array.isArray(data[KEYS.allowlist]) ? data[KEYS.allowlist] : [];
  mem.trusted = Array.isArray(data[KEYS.trusted]) ? data[KEYS.trusted] : [];
  mem.userBlocked = Array.isArray(data[KEYS.userBlocked]) ? data[KEYS.userBlocked] : [];
  mem.learned = data[KEYS.learned] && typeof data[KEYS.learned] === 'object' ? data[KEYS.learned] : {};
  const stats = data[KEYS.stats];
  if (stats && typeof stats === 'object') mem.stats = { days: stats.days || {}, domains: stats.domains || {}, since: stats.since || Date.now() };
  mem.sites = data[KEYS.sites] && typeof data[KEYS.sites] === 'object' ? data[KEYS.sites] : {};
  try {
    const { tabs } = await chrome.storage.session.get('tabs');
    if (tabs && typeof tabs === 'object') {
      for (const [id, t] of Object.entries(tabs)) mem.tabs.set(Number(id), t);
    }
  } catch (e) {
    console.warn('Privacy Shield: could not restore tab reports', e);
  }
})();

// ───────────────────────────── persistence ─────────────────────────────

const dirty = new Set();
let flushTimer = null;

function markDirty(...keys) {
  for (const k of keys) dirty.add(k);
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

async function flush() {
  flushTimer = null;
  const keys = [...dirty];
  dirty.clear();
  const local = {};
  for (const k of keys) {
    if (k === KEYS.stats) local[k] = mem.stats;
    else if (k === KEYS.sites) local[k] = mem.sites;
    else if (k === KEYS.learned) local[k] = mem.learned;
  }
  try {
    if (Object.keys(local).length) await chrome.storage.local.set(local);
    if (keys.includes('tabs')) await chrome.storage.session.set({ tabs: Object.fromEntries(mem.tabs) });
  } catch (e) {
    console.warn('Privacy Shield: save failed', e);
  }
}

// ───────────────────────────── rule sync ─────────────────────────────

let syncChain = Promise.resolve();

/** Serialises rule updates so overlapping setting changes cannot interleave. */
function syncRules() {
  syncChain = syncChain.then(doSyncRules).catch((e) => console.error('Privacy Shield: rule sync failed', e));
  return syncChain;
}

async function doSyncRules() {
  const s = mem.settings;
  const enable = [];
  const disable = [];
  for (const c of CATEGORY_IDS) (s.categories[c] ? enable : disable).push(RULESET_ID[c]);
  (s.stripParams ? enable : disable).push('params');
  (s.gpc ? enable : disable).push('gpc');
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });

  const rules = buildDynamicRules({
    allowlist: mem.allowlist,
    trusted: mem.trusted,
    learnedBlocked: learnedBlockList(mem.learned, { autoBlock: s.autoBlockLearned, threshold: s.learnThreshold }),
    userBlocked: mem.userBlocked,
  });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });

  await syncGpcScript(s.gpc);
}

async function syncGpcScript(enabled) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [GPC_SCRIPT_ID] });
  if (enabled && registered.length) return;
  if (!enabled && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] });
    return;
  }
  if (enabled) {
    await chrome.scripting.registerContentScripts([{
      id: GPC_SCRIPT_ID,
      js: ['content/gpc.js'],
      matches: ['http://*/*', 'https://*/*'],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true,
    }]);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function isAllowlisted(host) {
  return !!host && mem.allowlist.some((d) => hostMatchesDomain(host, d));
}

function today() {
  const key = dayKey();
  let d = mem.stats.days[key];
  if (!d) {
    d = mem.stats.days[key] = { blocked: 0, seen: 0, params: 0, banners: 0, pages: 0, byCategory: {} };
    const keys = Object.keys(mem.stats.days).sort();
    while (keys.length > MAX_DAYS) delete mem.stats.days[keys.shift()];
  }
  return d;
}

function getTab(tabId, fallbackUrl) {
  let t = mem.tabs.get(tabId);
  if (!t && fallbackUrl) {
    t = newTab(fallbackUrl);
    mem.tabs.set(tabId, t);
  }
  return t;
}

/** Classifies a request host for the report: { domain, category } or null. */
function classify(host, siteHost) {
  const listed = trackerDomainOf(host);
  if (listed) {
    if (isSameEntity(listed, siteHost)) return null;
    return { domain: listed, category: categoryOf(host) };
  }
  const base = registrableDomain(host);
  if (mem.userBlocked.some((d) => hostMatchesDomain(host, d))) return { domain: base, category: 'custom' };
  const entry = mem.learned[base];
  if (isFlagged(entry, mem.settings.learnThreshold)) return { domain: base, category: 'learned' };
  return null;
}

function tabTrackerList(tab) {
  return Object.entries(tab.trackers).map(([domain, r]) => ({
    domain,
    category: r.category,
    requests: r.requests,
    blocked: r.blocked,
    allowed: Math.max(0, r.requests - r.blocked),
  }));
}

function updateSiteRecord(tab) {
  if (!tab.site || !isWebUrl(tab.url)) return;
  const list = tabTrackerList(tab);
  const rec = mem.sites[tab.site] || (mem.sites[tab.site] = { visits: 0, first: Date.now(), last: Date.now(), trackers: {}, blocked: 0 });
  rec.last = Date.now();
  for (const t of list) rec.trackers[t.domain] = t.category;
  const names = Object.keys(rec.trackers);
  if (names.length > 80) for (const n of names.slice(0, names.length - 80)) delete rec.trackers[n];
  const g = gradeSite(Object.entries(rec.trackers).map(([domain, category]) => ({ domain, category, blocked: 1, allowed: 0 })));
  rec.grade = g.grade;
  markDirty(KEYS.sites);
}

function pruneSites() {
  const entries = Object.entries(mem.sites);
  if (entries.length <= MAX_SITES) return;
  entries.sort((a, b) => a[1].last - b[1].last);
  for (const [k] of entries.slice(0, entries.length - MAX_SITES)) delete mem.sites[k];
}

const badgeTimers = new Map();
function scheduleBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(tabId, setTimeout(() => {
    badgeTimers.delete(tabId);
    updateBadge(tabId);
  }, 250));
}

async function updateBadge(tabId) {
  const tab = mem.tabs.get(tabId);
  let text = '';
  if (tab && mem.settings.showBadge) {
    if (isAllowlisted(tab.host)) text = 'off';
    else {
      const blocked = Object.values(tab.trackers).reduce((n, r) => n + r.blocked, 0);
      text = blocked ? (blocked > 999 ? '999+' : String(blocked)) : '';
    }
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: text === 'off' ? '#6b7280' : '#0f766e' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
  } catch {
    // Tab closed in the meantime.
  }
}

// ───────────────────────────── webRequest observers ─────────────────────────────

const WEB = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

chrome.webRequest.onBeforeRequest.addListener((details) => {
  handle(async () => {
    const { tabId, type } = details;
    if (tabId < 0) return;
    if (type === 'main_frame') {
      const existing = mem.tabs.get(tabId);
      // A DNR redirect (parameter stripping) keeps the requestId: keep the same report.
      if (existing && existing.navRequestId === details.requestId) {
        existing.url = details.url;
        return;
      }
      if (existing) updateSiteRecord(existing);
      const t = newTab(details.url, details.requestId);
      mem.tabs.set(tabId, t);
      if (t.site) {
        const rec = mem.sites[t.site] || (mem.sites[t.site] = { visits: 0, first: Date.now(), last: Date.now(), trackers: {}, blocked: 0 });
        rec.visits++;
        rec.last = Date.now();
        pruneSites();
        today().pages++;
        markDirty(KEYS.sites, KEYS.stats);
      }
      markDirty('tabs');
      scheduleBadge(tabId);
      return;
    }
    const tab = getTab(tabId, details.initiator);
    if (!tab || !tab.host) return;
    const host = hostFromUrl(details.url);
    if (!host || registrableDomain(host) === tab.site) return;
    const hit = classify(host, tab.host);
    if (!hit) return;
    const rec = tab.trackers[hit.domain] || (tab.trackers[hit.domain] = { category: hit.category, requests: 0, blocked: 0 });
    rec.requests++;
    today().seen++;
    markDirty('tabs', KEYS.stats);
  });
}, WEB);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  handle(async () => {
    if (details.error !== 'net::ERR_BLOCKED_BY_CLIENT' || details.tabId < 0 || details.type === 'main_frame') return;
    const tab = mem.tabs.get(details.tabId);
    if (!tab) return;
    const host = hostFromUrl(details.url);
    const hit = classify(host, tab.host);
    if (!hit) return;
    const rec = tab.trackers[hit.domain] || (tab.trackers[hit.domain] = { category: hit.category, requests: 1, blocked: 0 });
    rec.blocked = Math.min(rec.requests, rec.blocked + 1);
    const day = today();
    day.blocked++;
    day.byCategory[hit.category] = (day.byCategory[hit.category] || 0) + 1;
    const ds = mem.stats.domains[hit.domain] || (mem.stats.domains[hit.domain] = { category: hit.category, blocked: 0, sites: [] });
    ds.blocked++;
    if (tab.site && !ds.sites.includes(tab.site)) {
      ds.sites.push(tab.site);
      if (ds.sites.length > 50) ds.sites.shift();
    }
    const domainKeys = Object.keys(mem.stats.domains);
    if (domainKeys.length > MAX_TRACKER_STATS) {
      domainKeys.sort((a, b) => mem.stats.domains[a].blocked - mem.stats.domains[b].blocked);
      for (const k of domainKeys.slice(0, domainKeys.length - MAX_TRACKER_STATS)) delete mem.stats.domains[k];
    }
    if (tab.site && mem.sites[tab.site]) mem.sites[tab.site].blocked = (mem.sites[tab.site].blocked || 0) + 1;
    markDirty('tabs', KEYS.stats, KEYS.sites);
    scheduleBadge(details.tabId);
  });
}, WEB);

chrome.webRequest.onBeforeRedirect.addListener((details) => {
  handle(async () => {
    if (details.tabId < 0 || (details.type !== 'main_frame' && details.type !== 'sub_frame')) return;
    const { removed } = stripTrackingParams(details.url);
    if (!removed.length || !details.redirectUrl) return;
    let target;
    try {
      target = new URL(details.redirectUrl);
    } catch {
      return;
    }
    const actuallyRemoved = removed.filter((p) => !target.searchParams.has(p));
    if (!actuallyRemoved.length) return;
    const tab = mem.tabs.get(details.tabId) || getTab(details.tabId, details.redirectUrl);
    tab.params += actuallyRemoved.length;
    for (const p of actuallyRemoved) if (!tab.paramNames.includes(p)) tab.paramNames.push(p);
    today().params += actuallyRemoved.length;
    markDirty('tabs', KEYS.stats);
  });
}, WEB);

// Heuristic learning: third-party requests that carry or set cookies.
function observeCookies(details, headers, name) {
  if (!mem.settings.learning || details.tabId < 0 || details.type === 'main_frame') return;
  if (!headers || !headers.some((h) => h.name.toLowerCase() === name)) return;
  handle(async () => {
    const tab = mem.tabs.get(details.tabId);
    if (!tab || !tab.host || isAllowlisted(tab.host)) return;
    learn(hostFromUrl(details.url), tab.host);
  });
}

try {
  chrome.webRequest.onSendHeaders.addListener(
    (d) => observeCookies(d, d.requestHeaders, 'cookie'), WEB, ['requestHeaders', 'extraHeaders']);
  chrome.webRequest.onHeadersReceived.addListener(
    (d) => observeCookies(d, d.responseHeaders, 'set-cookie'), WEB, ['responseHeaders', 'extraHeaders']);
} catch (e) {
  // Very old Chromium without extraHeaders: fall back to what is visible without it.
  chrome.webRequest.onSendHeaders.addListener((d) => observeCookies(d, d.requestHeaders, 'cookie'), WEB, ['requestHeaders']);
  chrome.webRequest.onHeadersReceived.addListener((d) => observeCookies(d, d.responseHeaders, 'set-cookie'), WEB, ['responseHeaders']);
}

function learn(requestHost, siteHost) {
  const domain = learnableDomain(requestHost, siteHost);
  if (!domain) return;
  const { changed, newlyFlagged } = recordObservation(mem.learned, domain, siteHost, mem.settings.learnThreshold);
  if (!changed) return;
  if (Object.keys(mem.learned).length > 3500) pruneLearned(mem.learned, mem.settings.learnThreshold);
  markDirty(KEYS.learned);
  if (newlyFlagged && mem.settings.autoBlockLearned) syncRules();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handle(async () => {
    const t = mem.tabs.get(tabId);
    if (t) updateSiteRecord(t);
    mem.tabs.delete(tabId);
    markDirty('tabs');
  });
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  handle(async () => {
    const t = mem.tabs.get(removed);
    if (t) {
      mem.tabs.set(added, t);
      mem.tabs.delete(removed);
      markDirty('tabs');
    }
  });
});

// ───────────────────────────── lifecycle ─────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  handle(async () => {
    await syncRules();
    if (details.reason === 'install') {
      await chrome.storage.local.set({ [KEYS.settings]: mem.settings });
    }
  });
});

chrome.runtime.onStartup.addListener(() => handle(syncRules));

chrome.commands.onCommand.addListener((command) => {
  handle(async () => {
    if (command === 'open-dashboard') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    } else if (command === 'toggle-site-protection') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !isWebUrl(tab.url)) return;
      const host = hostFromUrl(tab.url);
      await setSiteProtection(host, isAllowlisted(host));
      await chrome.tabs.reload(tab.id);
    }
  });
});

function handle(fn) {
  ready.then(fn).catch((e) => console.error('Privacy Shield:', e));
}

// ───────────────────────────── actions used by the UI ─────────────────────────────

async function setSiteProtection(host, enabled) {
  const site = registrableDomain(host);
  if (!site) throw new Error('Not a web page');
  if (enabled) mem.allowlist = mem.allowlist.filter((d) => !hostMatchesDomain(host, d));
  else mem.allowlist = [...mem.allowlist, site];
  mem.allowlist = await setList(KEYS.allowlist, mem.allowlist);
  await syncRules();
  return !isAllowlisted(host);
}

function tabReport(tabId, url) {
  const tab = mem.tabs.get(tabId);
  const host = hostFromUrl(url || (tab && tab.url));
  const web = isWebUrl(url || (tab && tab.url));
  const sameDoc = tab && tab.host === host;
  const trackers = sameDoc ? tabTrackerList(tab) : [];
  const grade = gradeSite(trackers, { params: sameDoc ? tab.params : 0 });
  const siteRec = mem.sites[registrableDomain(host)];
  return {
    web,
    host,
    site: registrableDomain(host),
    protected: web && !isAllowlisted(host),
    trackers: trackers.sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain)),
    params: sameDoc ? tab.params : 0,
    paramNames: sameDoc ? tab.paramNames : [],
    banner: sameDoc ? tab.banner : null,
    grade,
    history: siteRec ? { visits: siteRec.visits, grade: siteRec.grade, trackers: Object.keys(siteRec.trackers).length } : null,
    settings: mem.settings,
    learned: Object.fromEntries(trackers.filter((t) => t.category === 'learned').map((t) => [t.domain, mem.learned[t.domain]])),
    trusted: mem.trusted,
    userBlocked: mem.userBlocked,
  };
}

async function setLearnedState(domain, action) {
  const entry = mem.learned[domain];
  if (!entry && action !== 'block') throw new Error('Unknown domain');
  const e = entry || (mem.learned[domain] = { sites: [], first: Date.now(), last: Date.now() });
  if (action === 'block') { e.blocked = true; e.ignored = false; }
  else if (action === 'unblock') e.blocked = false;
  else if (action === 'ignore') { e.ignored = true; e.blocked = false; }
  else if (action === 'unignore') { e.ignored = false; delete e.blocked; }
  else if (action === 'forget') delete mem.learned[domain];
  else throw new Error('Unknown action');
  await chrome.storage.local.set({ [KEYS.learned]: mem.learned });
  await syncRules();
}

async function updateList(key, list) {
  if (![KEYS.allowlist, KEYS.trusted, KEYS.userBlocked].includes(key)) throw new Error('Unknown list');
  const clean = (Array.isArray(list) ? list : []).map((s) => parseSiteInput(s)).filter(Boolean)
    .map((h) => (key === KEYS.allowlist ? registrableDomain(h) : h));
  const saved = await setList(key, clean);
  if (key === KEYS.allowlist) mem.allowlist = saved;
  if (key === KEYS.trusted) mem.trusted = saved;
  if (key === KEYS.userBlocked) mem.userBlocked = saved;
  await syncRules();
  return saved;
}

const handlers = {
  async 'popup:report'({ tabId, url }) {
    return tabReport(tabId, url);
  },
  async 'popup:setSiteProtection'({ host, enabled }) {
    return { protected: await setSiteProtection(host, enabled) };
  },
  async 'settings:get'() {
    return mem.settings;
  },
  async 'settings:save'({ patch }) {
    if (patch && patch.cookieMode && !COOKIE_MODES.includes(patch.cookieMode)) throw new Error('Bad cookie mode');
    mem.settings = await saveSettings(patch || {});
    await syncRules();
    for (const id of mem.tabs.keys()) scheduleBadge(id);
    return mem.settings;
  },
  async 'lists:update'({ key, list }) {
    return updateList(key, list);
  },
  async 'learned:set'({ domain, action }) {
    await setLearnedState(domain, action);
    return true;
  },
  async 'dashboard:data'() {
    await flush();
    return {
      settings: mem.settings,
      stats: mem.stats,
      sites: mem.sites,
      learned: mem.learned,
      allowlist: mem.allowlist,
      trusted: mem.trusted,
      userBlocked: mem.userBlocked,
      rules: await chrome.declarativeNetRequest.getEnabledRulesets(),
    };
  },
  async 'stats:reset'() {
    mem.stats = { days: {}, domains: {}, since: Date.now() };
    mem.sites = {};
    await chrome.storage.local.set({ [KEYS.stats]: mem.stats, [KEYS.sites]: mem.sites });
    return true;
  },
  async 'learned:reset'() {
    mem.learned = {};
    await chrome.storage.local.set({ [KEYS.learned]: {} });
    await syncRules();
    return true;
  },
  // ── content scripts ──
  async 'cs:config'(_msg, sender) {
    const topUrl = sender.tab ? sender.tab.url : sender.url;
    const host = hostFromUrl(topUrl);
    return { cookieMode: mem.settings.cookieMode, enabled: !isAllowlisted(host), learning: mem.settings.learning };
  },
  async 'cs:banner'({ cmp, name, action, ok }, sender) {
    if (!sender.tab || sender.tab.id < 0) return false;
    const tab = getTab(sender.tab.id, sender.tab.url);
    const first = !tab.banner;
    // A frame result (e.g. Sourcepoint's iframe) wins over the top frame's fallback hide.
    if (first || (ok && !tab.banner.ok) || (action !== 'hide' && tab.banner.action === 'hide')) {
      tab.banner = { cmp: String(cmp).slice(0, 40), name: String(name).slice(0, 60), action, ok: !!ok };
    }
    if (first) today().banners++;
    markDirty('tabs', KEYS.stats);
    return true;
  },
  async 'cs:storage'({ frameHost }, sender) {
    if (!mem.settings.learning || !sender.tab || !sender.tab.url) return false;
    const siteHost = hostFromUrl(sender.tab.url);
    if (isAllowlisted(siteHost)) return false;
    learn(String(frameHost || ''), siteHost);
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  // Only our own pages may use the management messages.
  if (!msg.type.startsWith('cs:') && sender.id !== chrome.runtime.id) return false;
  if (!msg.type.startsWith('cs:') && sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  ready
    .then(() => fn(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
