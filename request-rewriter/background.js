// Request Rewriter service worker: compiles rules to declarativeNetRequest, keeps the badge in
// sync, records which rules matched per tab, and answers messages from the popup and editor.
import {
  compileRule, countActiveRules, ruleDisplayName, RULE_TYPES, SESSION_ID_BASE, testRequest,
} from './lib/rules.js';
import { getState, getSettings, update, mutations, onStateChanged, onSettingsChanged } from './lib/store.js';

const STATUS_KEY = 'syncStatus';
const MATCH_KEY = 'matchLog';

// dnr rule id -> { groupId, ruleId, name, type }
let dynamicMap = {};
let sessionMap = {};
// tabId -> { url, counts: {ruleId: n}, entries: [...] }
let tabMatches = new Map();
let feedback = null;      // null = unknown, true/false after probing
let settings = null;

const isSet = v => v !== undefined && v !== null;

async function hasFeedback() {
  if (feedback !== null) return feedback;
  try {
    const perms = await chrome.permissions.getAll();
    feedback = !!(perms.permissions || []).includes('declarativeNetRequestFeedback')
      && typeof chrome.declarativeNetRequest.getMatchedRules === 'function';
  } catch { feedback = false; }
  return feedback;
}

// ---------- rule sync ----------

async function syncRules() {
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
        const useSession = !!tabIds;
        const ruleId = useSession ? sid : id;
        const res = compileRule(r, { id: ruleId, tabIds });
        if (!res.dnr) {
          errors.push({ groupId: g.id, ruleId: r.id, name: ruleDisplayName(r), messages: res.errors.map(e => e.message) });
          continue;
        }
        const meta = { groupId: g.id, groupName: g.name, color: g.color, ruleId: r.id, name: ruleDisplayName(r), type: r.type };
        if (useSession) { session.push(res.dnr); nextSession[ruleId] = meta; sid++; }
        else { dynamic.push(res.dnr); nextDynamic[ruleId] = meta; id++; }
      }
    }
  }

  let installError = '';
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map(r => r.id),
      addRules: dynamic,
    });
  } catch (e) {
    installError = String(e && e.message || e);
    // Install what we can: find and drop the offending rules one by one.
    const ok = [];
    for (const r of dynamic) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [r.id], addRules: [r] });
        ok.push(r.id);
      } catch (err) {
        const meta = nextDynamic[r.id];
        errors.push({ groupId: meta && meta.groupId, ruleId: meta && meta.ruleId, name: meta && meta.name, messages: [String(err && err.message || err)] });
        delete nextDynamic[r.id];
      }
    }
    if (ok.length) installError = '';
  }
  try {
    const existingS = (await chrome.declarativeNetRequest.getSessionRules()).filter(r => r.id >= SESSION_ID_BASE);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: existingS.map(r => r.id), addRules: session });
  } catch (e) {
    errors.push({ name: 'Tab-scoped rules', messages: [String(e && e.message || e)] });
  }

  dynamicMap = nextDynamic;
  sessionMap = nextSession;
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      at: Date.now(),
      installed: Object.keys(nextDynamic).length + Object.keys(nextSession).length,
      active: countActiveRules(state),
      errors,
      installError,
    },
  });
  await updateBadge();
  return { installed: dynamic.length + session.length, errors };
}

function metaFor(id) { return dynamicMap[id] || sessionMap[id] || null; }

// ---------- badge ----------

function tabEntry(tabId) {
  let e = tabMatches.get(tabId);
  if (!e) { e = { url: '', counts: {}, entries: [] }; tabMatches.set(tabId, e); }
  return e;
}

async function updateBadge(tabId) {
  settings = settings || await getSettings();
  const state = await getState();
  const active = countActiveRules(state);
  const mode = settings.badgeMode;
  if (mode === 'off') {
    await chrome.action.setBadgeText({ text: '' });
    await setTitle(state, active, 0);
    return;
  }
  let id = tabId;
  if (id === undefined) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      id = tab && tab.id;
    } catch { /* no tabs permission yet */ }
  }
  const hits = id !== undefined && tabMatches.has(id) ? Object.values(tabMatches.get(id).counts).reduce((a, b) => a + b, 0) : 0;
  let text = '';
  let color = '#64748b';
  if (state.paused) { text = 'off'; color = '#94a3b8'; }
  else if (mode === 'matches' && hits > 0) { text = String(Math.min(hits, 999)); color = '#15803d'; }
  else if (active > 0) { text = String(Math.min(active, 999)); color = mode === 'matches' ? '#475569' : '#0369a1'; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await setTitle(state, active, hits);
}

async function setTitle(state, active, hits) {
  const parts = ['Request Rewriter'];
  if (state.paused) parts.push('paused');
  else {
    parts.push(`${active} active rule${active === 1 ? '' : 's'}`);
    if (hits > 0) parts.push(`${hits} match${hits === 1 ? '' : 'es'} on this tab`);
  }
  await chrome.action.setTitle({ title: parts.join(' — ') });
}

// ---------- match tracking ----------

function recordMatch(info) {
  const tabId = info.request && info.request.tabId;
  const ruleId = info.rule && info.rule.ruleId;
  const meta = metaFor(ruleId);
  if (!meta || tabId === undefined || tabId < 0) return;
  const e = tabEntry(tabId);
  e.counts[meta.ruleId] = (e.counts[meta.ruleId] || 0) + 1;
  const limit = (settings && settings.logLimit) || 300;
  e.entries.unshift({
    at: Date.now(),
    url: info.request.url,
    method: info.request.method,
    type: info.request.type,
    ruleId: meta.ruleId,
    groupId: meta.groupId,
    name: meta.name,
    ruleType: meta.type,
  });
  if (e.entries.length > limit) e.entries.length = limit;
}

function attachFeedbackListener() {
  const api = chrome.declarativeNetRequest;
  if (!api.onRuleMatchedDebug) return false;
  try {
    api.onRuleMatchedDebug.addListener(info => {
      recordMatch(info);
      updateBadge(info.request && info.request.tabId).catch(() => {});
    });
    return true;
  } catch { return false; }
}

// Fallback when onRuleMatchedDebug is unavailable: poll getMatchedRules for the active tab.
async function pollMatchedRules(tabId) {
  if (!(await hasFeedback())) return;
  if (chrome.declarativeNetRequest.onRuleMatchedDebug) return;
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    const e = tabEntry(tabId);
    e.counts = {};
    e.entries = [];
    for (const m of rulesMatchedInfo || []) {
      const meta = metaFor(m.rule.ruleId);
      if (!meta) continue;
      e.counts[meta.ruleId] = (e.counts[meta.ruleId] || 0) + 1;
      e.entries.push({ at: m.timeStamp, url: '', method: '', type: '', ruleId: meta.ruleId, groupId: meta.groupId, name: meta.name, ruleType: meta.type });
    }
    await updateBadge(tabId);
  } catch { /* no feedback permission */ }
}

// ---------- events ----------

chrome.runtime.onInstalled.addListener(async details => {
  await syncRules();
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html?welcome=1') });
});
chrome.runtime.onStartup.addListener(() => { syncRules(); });

onStateChanged(() => { syncRules(); });
onSettingsChanged(s => { settings = s; updateBadge(); });

chrome.tabs.onActivated.addListener(({ tabId }) => { updateBadge(tabId); pollMatchedRules(tabId); });
chrome.tabs.onRemoved.addListener(async tabId => {
  tabMatches.delete(tabId);
  const state = await getState();
  if (state.groups.some(g => g.tabScope === tabId)) {
    await update(s => { for (const g of s.groups) if (g.tabScope === tabId) delete g.tabScope; });
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) {
    const e = tabEntry(tabId);
    if (e.url && e.url !== change.url) { e.counts = {}; e.entries = []; }
    e.url = change.url;
    updateBadge(tabId);
  }
  if (change.status === 'complete') pollMatchedRules(tabId);
});

chrome.commands && chrome.commands.onCommand.addListener(async cmd => {
  if (cmd === 'toggle-pause') {
    await update(s => mutations.setPaused(s, !s.paused));
  } else if (cmd === 'open-editor') {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'sync': respond(await syncRules()); break;
      case 'status': {
        const state = await getState();
        const got = await chrome.storage.local.get(STATUS_KEY);
        let tabId = msg.tabId;
        if (tabId === undefined) {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tabId = tab && tab.id;
        }
        const e = tabId !== undefined ? tabMatches.get(tabId) : null;
        respond({
          paused: state.paused,
          active: countActiveRules(state),
          status: got[STATUS_KEY] || null,
          feedback: await hasFeedback(),
          liveMatching: !!chrome.declarativeNetRequest.onRuleMatchedDebug,
          tabId,
          matches: e ? { counts: e.counts, entries: e.entries.slice(0, msg.limit || 50) } : { counts: {}, entries: [] },
        });
        break;
      }
      case 'clearMatches': {
        if (msg.tabId !== undefined) tabMatches.delete(msg.tabId); else tabMatches.clear();
        await updateBadge(msg.tabId);
        respond({ ok: true });
        break;
      }
      case 'installed': {
        const [dyn, ses] = await Promise.all([
          chrome.declarativeNetRequest.getDynamicRules(),
          chrome.declarativeNetRequest.getSessionRules(),
        ]);
        respond({ dynamic: dyn, session: ses, map: { ...dynamicMap, ...sessionMap } });
        break;
      }
      case 'test': {
        const state = await getState();
        respond(summarizeTest(testRequest(state, msg.request)));
        break;
      }
      case 'checkRegex': {
        try {
          const r = await chrome.declarativeNetRequest.isRegexSupported({
            regex: msg.regex, isCaseSensitive: false, requireCapturing: !!msg.requireCapturing,
          });
          respond(r);
        } catch (e) { respond({ isSupported: false, reason: String(e && e.message || e) }); }
        break;
      }
      case 'ruleTypes': respond(RULE_TYPES); break;
      default: respond({ error: 'unknown command' });
    }
  })().catch(e => respond({ error: String(e && e.message || e) }));
  return true;
});

// Strips DOM-unfriendly cycles: messages must be structured-cloneable plain data.
function summarizeTest(result) {
  const lite = c => ({
    ruleId: c.rule.id, groupId: c.group.id, groupName: c.group.name, color: c.group.color,
    name: ruleDisplayName(c.rule), type: c.rule.type, priority: c.rule.priority,
    active: c.active, matched: c.matched, reason: c.reason, dnr: c.dnr || null,
  });
  const o = result.outcome;
  return {
    checks: result.checks.map(lite),
    outcome: {
      verdict: o.verdict, redirectTo: o.redirectTo, loopWarning: o.loopWarning || '',
      winner: o.winner ? lite(o.winner) : null,
      applied: o.applied.map(lite),
      requestHeaders: o.requestHeaders.map(h => ({ header: h.header, operation: h.operation, value: h.value, rule: ruleDisplayName(h.rule) })),
      responseHeaders: o.responseHeaders.map(h => ({ header: h.header, operation: h.operation, value: h.value, rule: ruleDisplayName(h.rule) })),
    },
  };
}

// The worker can be restarted at any time; re-sync and re-attach on every boot.
attachFeedbackListener();
hasFeedback();
syncRules();

// Exposed for the end-to-end test harness.
self.requestRewriter = { syncRules, updateBadge, tabMatches, maps: () => ({ dynamicMap, sessionMap }) };
