// Request Rewriter service worker: compiles rules to declarativeNetRequest, keeps the badge in
// sync, records which rules matched per tab, and answers messages from the popup and editor.
import {
  compileRule, countActiveRules, ruleDisplayName, RULE_TYPES, SESSION_ID_BASE, testRequest,
} from './lib/rules.js';
import { getState, getSettings, update, mutations, onStateChanged, onSettingsChanged } from './lib/store.js';

const STATUS_KEY = 'syncStatus';
const MATCH_KEY = 'tabMatches';       // chrome.storage.session: survives worker restarts
const dnr = chrome.declarativeNetRequest;

// dnr rule id -> { groupId, groupName, color, ruleId, name, type }
let dynamicMap = {};
let sessionMap = {};
// tabId -> { url, freshAt, counts: {ruleId: n}, entries: [...] }
const tabMatches = new Map();
const badgedTabs = new Set();          // tabs that carry a tab-specific badge override
let feedback = null;                   // null = unknown, true/false after probing
let settings = null;

const isSet = v => v !== undefined && v !== null;
const errText = e => String((e && e.message) || e);

async function hasFeedback() {
  if (feedback !== null) return feedback;
  try {
    const perms = await chrome.permissions.getAll();
    feedback = (perms.permissions || []).includes('declarativeNetRequestFeedback')
      && typeof dnr.getMatchedRules === 'function';
  } catch { feedback = false; }
  return feedback;
}

async function getSettingsCached() {
  if (!settings) settings = await getSettings();
  return settings;
}

// ---------- rule sync (serialized: overlapping updates would fight over rule ids) ----------

let syncChain = Promise.resolve();
let syncQueued = null;

function syncRules() {
  if (syncQueued) return syncQueued;
  syncQueued = syncChain.then(() => { syncQueued = null; return doSync(); });
  syncChain = syncQueued.catch(() => {});
  return syncQueued;
}

async function doSync() {
  const state = await getState();
  const dynamic = [];
  const session = [];
  const nextDynamic = {};
  const nextSession = {};
  const errors = [];
  let id = 1;
  let sid = SESSION_ID_BASE;
  if (!state.paused) {
    for (const g of state.groups) {
      if (!g.enabled) continue;
      const tabIds = isSet(g.tabScope) ? [g.tabScope] : null;
      for (const r of g.rules) {
        if (!r.enabled) continue;
        const ruleId = tabIds ? sid : id;
        const res = compileRule(r, { id: ruleId, tabIds });
        if (!res.dnr) {
          errors.push({ groupId: g.id, ruleId: r.id, name: ruleDisplayName(r), messages: res.errors.map(e => e.message) });
          continue;
        }
        const meta = { groupId: g.id, groupName: g.name, color: g.color, ruleId: r.id, name: ruleDisplayName(r), type: r.type };
        if (tabIds) { session.push(res.dnr); nextSession[ruleId] = meta; sid++; }
        else { dynamic.push(res.dnr); nextDynamic[ruleId] = meta; id++; }
      }
    }
  }

  let installError = '';
  const existing = await dnr.getDynamicRules();
  try {
    await dnr.updateDynamicRules({ removeRuleIds: existing.map(r => r.id), addRules: dynamic });
  } catch (e) {
    // The batch is atomic, so nothing changed. Clear everything, then add rule by rule so one
    // bad rule (for example an RE2-incompatible regex) does not take the rest down with it.
    installError = errText(e);
    try { await dnr.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) }); } catch { /* ignore */ }
    let ok = 0;
    for (const r of dynamic) {
      try { await dnr.updateDynamicRules({ addRules: [r] }); ok++; }
      catch (err) {
        const meta = nextDynamic[r.id] || {};
        errors.push({ groupId: meta.groupId, ruleId: meta.ruleId, name: meta.name, messages: [errText(err)] });
        delete nextDynamic[r.id];
      }
    }
    if (ok || !dynamic.length) installError = '';
  }

  try {
    const existingS = (await dnr.getSessionRules()).filter(r => r.id >= SESSION_ID_BASE);
    await dnr.updateSessionRules({ removeRuleIds: existingS.map(r => r.id), addRules: session });
  } catch (e) {
    try {
      const existingS = (await dnr.getSessionRules()).filter(r => r.id >= SESSION_ID_BASE);
      await dnr.updateSessionRules({ removeRuleIds: existingS.map(r => r.id) });
    } catch { /* ignore */ }
    for (const r of session) {
      try { await dnr.updateSessionRules({ addRules: [r] }); }
      catch (err) {
        const meta = nextSession[r.id] || {};
        errors.push({ groupId: meta.groupId, ruleId: meta.ruleId, name: meta.name, messages: [errText(err)] });
        delete nextSession[r.id];
      }
    }
  }

  dynamicMap = nextDynamic;
  sessionMap = nextSession;
  const result = {
    at: Date.now(),
    installed: Object.keys(nextDynamic).length + Object.keys(nextSession).length,
    active: countActiveRules(state),
    errors,
    installError,
  };
  await chrome.storage.local.set({ [STATUS_KEY]: result });
  await refreshAllBadges();
  return result;
}

function metaFor(id) { return dynamicMap[id] || sessionMap[id] || null; }

// ---------- badge ----------
// Global badge: active rule count (or "off"). Per tab, in "matches" mode: number of matches.

function tabEntry(tabId) {
  let e = tabMatches.get(tabId);
  if (!e) { e = { url: '', freshAt: 0, counts: {}, entries: [] }; tabMatches.set(tabId, e); }
  return e;
}

function hitsFor(tabId) {
  const e = tabMatches.get(tabId);
  return e ? Object.values(e.counts).reduce((a, b) => a + b, 0) : 0;
}

async function globalBadge() {
  const s = await getSettingsCached();
  const state = await getState();
  const active = countActiveRules(state);
  if (s.badgeMode === 'off') return { text: '', color: '#64748b', active, state };
  if (state.paused) return { text: 'off', color: '#94a3b8', active, state };
  return { text: active > 0 ? String(Math.min(active, 999)) : '', color: '#2743b8', active, state };
}

async function refreshAllBadges() {
  const g = await globalBadge();
  try {
    await chrome.action.setBadgeText({ text: g.text });
    await chrome.action.setBadgeBackgroundColor({ color: g.color });
    await chrome.action.setTitle({ title: titleText(g.state, g.active, 0) });
  } catch { /* ignore */ }
  const tabs = new Set([...badgedTabs, ...tabMatches.keys()]);
  for (const tabId of tabs) await updateTabBadge(tabId, g);
}

async function updateTabBadge(tabId, g) {
  if (!isSet(tabId) || tabId < 0) return;
  g = g || await globalBadge();
  const s = await getSettingsCached();
  const hits = hitsFor(tabId);
  try {
    if (s.badgeMode === 'matches' && !g.state.paused && hits > 0) {
      await chrome.action.setBadgeText({ tabId, text: String(Math.min(hits, 999)) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#15803d' });
      badgedTabs.add(tabId);
    } else if (badgedTabs.has(tabId)) {
      await chrome.action.setBadgeText({ tabId, text: null });   // falls back to the global text
      await chrome.action.setBadgeBackgroundColor({ tabId, color: g.color });
      badgedTabs.delete(tabId);
    }
    await chrome.action.setTitle({ tabId, title: titleText(g.state, g.active, hits) });
  } catch {
    badgedTabs.delete(tabId);   // tab is gone
  }
}

function titleText(state, active, hits) {
  const parts = ['Request Rewriter'];
  if (state.paused) parts.push('paused');
  else {
    parts.push(`${active} active rule${active === 1 ? '' : 's'}`);
    if (hits > 0) parts.push(`${hits} match${hits === 1 ? '' : 'es'} on this tab`);
  }
  return parts.join(' — ');
}

// ---------- match tracking ----------

let saveTimer = null;
function persistMatches() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const obj = {};
    for (const [k, v] of tabMatches) obj[k] = v;
    chrome.storage.session.set({ [MATCH_KEY]: obj }).catch(() => {});
  }, 400);
}

async function restoreMatches() {
  try {
    const got = await chrome.storage.session.get(MATCH_KEY);
    for (const [k, v] of Object.entries(got[MATCH_KEY] || {})) if (!tabMatches.has(+k)) tabMatches.set(+k, v);
  } catch { /* storage.session unavailable */ }
}

function resetTab(tabId, url) {
  const e = tabEntry(tabId);
  e.counts = {};
  e.entries = [];
  if (url !== undefined) e.url = url;
  return e;
}

const badgeTimers = new Map();
function scheduleTabBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(tabId, setTimeout(() => { badgeTimers.delete(tabId); updateTabBadge(tabId).catch(() => {}); }, 150));
}

function recordMatch(info) {
  const req = info.request || {};
  const tabId = req.tabId;
  const meta = metaFor(info.rule && info.rule.ruleId);
  if (!meta || !isSet(tabId) || tabId < 0) return;
  let e = tabEntry(tabId);
  if (req.type === 'main_frame') { e = resetTab(tabId, req.url); e.freshAt = Date.now(); }
  e.counts[meta.ruleId] = (e.counts[meta.ruleId] || 0) + 1;
  if (!settings || settings.logMatches !== false) {
    const limit = (settings && settings.logLimit) || 300;
    e.entries.unshift({
      at: Date.now(), url: req.url, method: req.method, type: req.type,
      ruleId: meta.ruleId, groupId: meta.groupId, name: meta.name, ruleType: meta.type,
    });
    if (e.entries.length > limit) e.entries.length = limit;
  }
  persistMatches();
  scheduleTabBadge(tabId);
}

function attachFeedbackListener() {
  if (!dnr.onRuleMatchedDebug) return false;   // only for unpacked installs
  try { dnr.onRuleMatchedDebug.addListener(recordMatch); return true; } catch { return false; }
}

// Fallback when onRuleMatchedDebug is unavailable (packed installs): ask getMatchedRules.
async function pollMatchedRules(tabId) {
  if (!isSet(tabId) || tabId < 0 || dnr.onRuleMatchedDebug) return;
  if (!(await hasFeedback())) return;
  try {
    const { rulesMatchedInfo } = await dnr.getMatchedRules({ tabId });
    const e = resetTab(tabId);
    for (const m of rulesMatchedInfo || []) {
      const meta = metaFor(m.rule.ruleId);
      if (!meta) continue;
      e.counts[meta.ruleId] = (e.counts[meta.ruleId] || 0) + 1;
      e.entries.push({ at: m.timeStamp, url: '', method: '', type: '', ruleId: meta.ruleId, groupId: meta.groupId, name: meta.name, ruleType: meta.type });
    }
    persistMatches();
    await updateTabBadge(tabId);
  } catch { /* quota exceeded or no permission */ }
}

// ---------- events ----------

chrome.runtime.onInstalled.addListener(async details => {
  await syncRules();
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html?welcome=1') });
});

// Tab ids do not survive a browser restart, so tab-scoped groups are turned off on startup.
chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  if (state.groups.some(g => isSet(g.tabScope))) await update(s => detachTabScopes(s, () => true));
  else syncRules();
});

function detachTabScopes(s, pred) {
  for (const g of s.groups) {
    if (isSet(g.tabScope) && pred(g.tabScope)) {
      delete g.tabScope;
      g.enabled = false;
      if (!/tab closed/.test(g.description || '')) g.description = `${g.description ? g.description + ' ' : ''}(Its tab closed; turn it on to apply it everywhere.)`;
    }
  }
}

onStateChanged(() => { syncRules(); });
onSettingsChanged(s => { settings = s; refreshAllBadges(); });

chrome.tabs.onActivated.addListener(({ tabId }) => { pollMatchedRules(tabId); });
chrome.tabs.onRemoved.addListener(async tabId => {
  tabMatches.delete(tabId);
  badgedTabs.delete(tabId);
  persistMatches();
  const state = await getState();
  if (state.groups.some(g => g.tabScope === tabId)) await update(s => detachTabScopes(s, t => t === tabId));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) {
    const e = tabEntry(tabId);
    // A main_frame match already reset the list for this navigation a moment ago.
    if (e.url !== change.url && Date.now() - (e.freshAt || 0) > 3000) { resetTab(tabId, change.url); persistMatches(); }
    e.url = change.url;
    updateTabBadge(tabId);
  }
  if (change.status === 'complete') pollMatchedRules(tabId);
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd === 'toggle-pause') await update(s => mutations.setPaused(s, !s.paused));
  else if (cmd === 'open-editor') chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(respond, e => respond({ error: errText(e) }));
  return true;
});

async function handle(msg) {
  switch (msg && msg.cmd) {
    case 'sync': return syncRules();
    case 'status': {
      const state = await getState();
      const got = await chrome.storage.local.get(STATUS_KEY);
      let tabId = msg.tabId;
      if (!isSet(tabId)) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tab && tab.id;
      }
      if (msg.poll) await pollMatchedRules(tabId);
      const e = isSet(tabId) ? tabMatches.get(tabId) : null;
      return {
        paused: state.paused,
        active: countActiveRules(state),
        status: got[STATUS_KEY] || null,
        feedback: await hasFeedback(),
        liveMatching: !!dnr.onRuleMatchedDebug,
        tabId,
        matches: e ? { counts: e.counts, entries: e.entries.slice(0, msg.limit || 50) } : { counts: {}, entries: [] },
      };
    }
    case 'clearMatches': {
      if (isSet(msg.tabId)) resetTab(msg.tabId); else tabMatches.clear();
      persistMatches();
      await refreshAllBadges();
      return { ok: true };
    }
    case 'installed': {
      const [dyn, ses] = await Promise.all([dnr.getDynamicRules(), dnr.getSessionRules()]);
      return { dynamic: dyn, session: ses.filter(r => r.id >= SESSION_ID_BASE), map: { ...dynamicMap, ...sessionMap } };
    }
    case 'test': return summarizeTest(testRequest(await getState(), msg.request));
    case 'checkRegex': {
      try {
        return await dnr.isRegexSupported({ regex: msg.regex, isCaseSensitive: false, requireCapturing: !!msg.requireCapturing });
      } catch (e) { return { isSupported: false, reason: errText(e) }; }
    }
    case 'ruleTypes': return RULE_TYPES;
    default: return { error: 'unknown command' };
  }
}

// Messages must be structured-cloneable plain data, so drop the group/rule object graph.
function summarizeTest(result) {
  const lite = c => ({
    ruleId: c.rule.id, groupId: c.group.id, groupName: c.group.name, color: c.group.color,
    name: ruleDisplayName(c.rule), type: c.rule.type, priority: c.rule.priority,
    active: c.active, matched: c.matched, reason: c.reason, dnr: c.dnr || null,
  });
  const o = result.outcome;
  const hdr = h => ({ header: h.header, operation: h.operation, value: h.value, rule: ruleDisplayName(h.rule) });
  return {
    checks: result.checks.map(lite),
    outcome: {
      verdict: o.verdict, redirectTo: o.redirectTo, loopWarning: o.loopWarning || '',
      winner: o.winner ? lite(o.winner) : null,
      applied: o.applied.map(lite),
      requestHeaders: o.requestHeaders.map(hdr),
      responseHeaders: o.responseHeaders.map(hdr),
    },
  };
}

// The worker can be restarted at any time; re-attach listeners and re-sync on every boot.
attachFeedbackListener();
hasFeedback();
restoreMatches().then(() => syncRules());

// Exposed for the end-to-end test harness.
self.requestRewriter = { syncRules, refreshAllBadges, tabMatches, maps: () => ({ dynamicMap, sessionMap }) };
