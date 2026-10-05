// Storage layer: one JSON state object in chrome.storage.local, plus small settings.
import { defaultState, normalizeState, clone, uid, normalizeRule, normalizeGroup } from './rules.js';

export const STATE_KEY = 'state';
export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  badgeMode: 'matches',       // 'matches' | 'count' | 'off'
  logMatches: true,
  logLimit: 300,
  showExamples: true,
  theme: 'system',            // 'system' | 'light' | 'dark'
};

let cache = null;

export async function getState() {
  if (cache) return cache;
  const got = await chrome.storage.local.get(STATE_KEY);
  cache = got[STATE_KEY] ? normalizeState(got[STATE_KEY]) : defaultState();
  return cache;
}

export async function setState(state) {
  cache = normalizeState(state);
  cache.updatedAt = Date.now();
  await chrome.storage.local.set({ [STATE_KEY]: cache });
  return cache;
}

/** Read-modify-write. The mutator gets a deep copy and may return a replacement. */
export async function update(mutator) {
  const current = await getState();
  const draft = clone(current);
  const result = await mutator(draft);
  return setState(result || draft);
}

export async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, got[SETTINGS_KEY] || {});
}

export async function setSettings(patch) {
  const next = Object.assign(await getSettings(), patch);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Fires cb(state) whenever the state changes anywhere (other pages, the worker). */
export function onStateChanged(cb) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    if (changes[STATE_KEY]) { cache = normalizeState(changes[STATE_KEY].newValue); cb(cache); }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function onSettingsChanged(cb) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) cb(Object.assign({}, DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {}));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---------- mutation helpers used by the popup, editor and worker ----------

export const mutations = {
  toggleGroup(state, groupId, enabled) {
    const g = state.groups.find(x => x.id === groupId);
    if (g) g.enabled = enabled === undefined ? !g.enabled : !!enabled;
  },
  toggleRule(state, ruleId, enabled) {
    for (const g of state.groups) {
      const r = g.rules.find(x => x.id === ruleId);
      if (r) { r.enabled = enabled === undefined ? !r.enabled : !!enabled; return; }
    }
  },
  setPaused(state, paused) { state.paused = !!paused; },
  addGroup(state, group) { const g = normalizeGroup(group || {}); state.groups.push(g); return g; },
  removeGroup(state, groupId) { state.groups = state.groups.filter(g => g.id !== groupId); },
  updateGroup(state, groupId, patch) {
    const g = state.groups.find(x => x.id === groupId);
    if (g) Object.assign(g, patch);
  },
  addRule(state, groupId, rule) {
    let g = state.groups.find(x => x.id === groupId);
    if (!g) { g = normalizeGroup({ name: 'My rules' }); state.groups.push(g); }
    const r = normalizeRule(rule || {});
    g.rules.push(r);
    return r;
  },
  saveRule(state, groupId, rule) {
    const r = normalizeRule(rule);
    for (const g of state.groups) {
      const i = g.rules.findIndex(x => x.id === r.id);
      if (i >= 0) {
        if (g.id === groupId || !groupId) { g.rules[i] = r; return r; }
        g.rules.splice(i, 1);
        break;
      }
    }
    const target = state.groups.find(g => g.id === groupId) || state.groups[0];
    if (target) target.rules.push(r);
    return r;
  },
  removeRule(state, ruleId) {
    for (const g of state.groups) {
      const i = g.rules.findIndex(x => x.id === ruleId);
      if (i >= 0) { g.rules.splice(i, 1); return; }
    }
  },
  duplicateRule(state, ruleId) {
    for (const g of state.groups) {
      const i = g.rules.findIndex(x => x.id === ruleId);
      if (i >= 0) {
        const copy = normalizeRule(Object.assign(clone(g.rules[i]), { id: uid('r'), name: (g.rules[i].name || 'Rule') + ' copy' }));
        g.rules.splice(i + 1, 0, copy);
        return copy;
      }
    }
  },
  moveRule(state, ruleId, targetGroupId, index) {
    let moved = null;
    for (const g of state.groups) {
      const i = g.rules.findIndex(x => x.id === ruleId);
      if (i >= 0) { moved = g.rules.splice(i, 1)[0]; break; }
    }
    if (!moved) return;
    const g = state.groups.find(x => x.id === targetGroupId) || state.groups[0];
    if (!g) return;
    if (index === undefined || index < 0 || index > g.rules.length) g.rules.push(moved);
    else g.rules.splice(index, 0, moved);
  },
  moveGroup(state, groupId, delta) {
    const i = state.groups.findIndex(g => g.id === groupId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.groups.length) return;
    const [g] = state.groups.splice(i, 1);
    state.groups.splice(j, 0, g);
  },
};
