// Auto-grouping rules: domain / URL pattern -> named, colored tab group.
import * as store from './store.js';
import { matchPattern, uid, GROUP_COLORS } from './util.js';
import { quiet, tabUrl } from './tabs.js';

export function findRule(url, rules) {
  return (rules || []).find(r => r.enabled !== false && r.pattern && matchPattern(url, r.pattern, r.type || 'auto'));
}

/** Put a tab into the group its first matching rule names. Returns the rule applied, if any. */
export async function applyToTab(tab, { force = false } = {}) {
  if (!chrome.tabGroups) return null;
  const s = await store.getSettings();
  if (!s.groupingEnabled && !force) return null;
  if (tab.pinned || quiet.opening.has(tab.id) || quiet.windows.has(tab.windowId)) return null;
  const rules = await store.get('rules', []);
  const rule = findRule(tabUrl(tab), rules);
  if (!rule) return null;
  return store.withLock('group:' + tab.windowId, async () => {
    let fresh;
    try { fresh = await chrome.tabs.get(tab.id); } catch { return null; }
    const title = rule.title || rule.pattern;
    if (fresh.groupId > -1) {
      if (!s.regroupGrouped && !force) return null;
      try { const g = await chrome.tabGroups.get(fresh.groupId); if (g.title === title) return null; } catch {}
    }
    try {
      const [existing] = await chrome.tabGroups.query({ windowId: fresh.windowId, title });
      if (existing) {
        await chrome.tabs.group({ tabIds: [fresh.id], groupId: existing.id });
      } else {
        const groupId = await chrome.tabs.group({ tabIds: [fresh.id], createProperties: { windowId: fresh.windowId } });
        await chrome.tabGroups.update(groupId, { title, color: GROUP_COLORS.includes(rule.color) ? rule.color : 'grey' });
      }
      return rule;
    } catch (e) {
      // Tabs can't be grouped while the user drags them, or in popup/app windows.
      return null;
    }
  });
}

export async function applyAll() {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  let n = 0;
  for (const t of tabs) if (await applyToTab(t, { force: true })) n++;
  return n;
}

export async function saveRule(rule) {
  await store.update('rules', [], list => {
    const clean = {
      id: rule.id || uid('r_'),
      pattern: String(rule.pattern || '').trim(),
      type: ['auto', 'domain', 'contains', 'wildcard', 'regex'].includes(rule.type) ? rule.type : 'auto',
      title: String(rule.title || '').trim().slice(0, 60),
      color: GROUP_COLORS.includes(rule.color) ? rule.color : 'blue',
      enabled: rule.enabled !== false,
    };
    if (!clean.pattern) throw new Error('Pattern is required');
    const i = list.findIndex(r => r.id === clean.id);
    if (i >= 0) list[i] = clean; else list.push(clean);
  });
}

export async function deleteRule(id) {
  await store.update('rules', [], list => list.filter(r => r.id !== id));
}

export async function reorderRules(ids) {
  await store.update('rules', [], list => {
    const pos = new Map(ids.map((id, i) => [id, i]));
    return list.slice().sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  });
}

/** Group the current window's tabs by domain in one shot (helper for messy windows). */
export async function groupByDomain(windowId) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned && t.groupId === -1);
  const byHost = new Map();
  for (const t of tabs) {
    let h = '';
    try { h = new URL(tabUrl(t)).hostname.replace(/^www\./, ''); } catch {}
    if (!h) continue;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(t.id);
  }
  let i = 0, made = 0;
  for (const [host, ids] of byHost) {
    if (ids.length < 2) continue;
    const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
    await chrome.tabGroups.update(gid, { title: host.split('.').slice(-2, -1)[0] || host, color: GROUP_COLORS[(i++ % 8) + 1] });
    made++;
  }
  return made;
}
