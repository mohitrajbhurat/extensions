// Memory saver: discard idle tabs with chrome.tabs.discard, with safety rules.
import * as store from './store.js';
import { matchPattern } from './util.js';
import { tabUrl } from './tabs.js';

const ACT = 'tabActivity';

export async function touch(tabId) {
  await store.supdate(ACT, {}, a => { a[tabId] = Date.now(); });
}

export async function forget(tabId) {
  await store.supdate(ACT, {}, a => { delete a[tabId]; });
}

export async function hasFormPermission() {
  try { return await chrome.permissions.contains({ permissions: ['scripting'], origins: ['<all_urls>'] }); } catch { return false; }
}

// Injected into a page: true if the user typed something that has not been submitted.
function pageHasUnsavedInput() {
  try {
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'search', 'password'].includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') { if (el.checked !== el.defaultChecked) return true; continue; }
      if (el.tagName === 'SELECT') { for (const o of el.options) if (o.selected !== o.defaultSelected) return true; continue; }
      if (el.value && el.value !== el.defaultValue) return true;
    }
    for (const el of document.querySelectorAll('[contenteditable=""], [contenteditable="true"]')) {
      if (el === document.activeElement && el.textContent.trim()) return true;
    }
  } catch {}
  return false;
}

async function isFormDirty(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: pageHasUnsavedInput });
    return !!res?.result;
  } catch { return false; }
}

export function isWhitelisted(url, whitelist) {
  return (whitelist || []).some(p => matchPattern(url, p));
}

/** Why a tab must not be discarded, or '' if it may be. */
export async function protectionReason(tab, s, canCheckForms) {
  const url = tabUrl(tab);
  if (tab.active) return 'active';
  if (tab.discarded) return 'already suspended';
  if (tab.audible) return 'playing audio';
  if (s.neverDiscardPinned && tab.pinned) return 'pinned';
  if (tab.autoDiscardable === false) return 'site opted out';
  if (!/^(https?|file|ftp):/.test(url)) return 'browser page';
  if (isWhitelisted(url, s.whitelist)) return 'whitelisted';
  if (s.protectForms && canCheckForms && await isFormDirty(tab.id)) return 'unsaved form';
  return '';
}

async function discard(tab) {
  try { await chrome.tabs.discard(tab.id); return true; } catch { return false; }
}

/** Periodic sweep: discard tabs idle longer than the threshold. */
export async function sweep() {
  const s = await store.getSettings();
  const now = Date.now();
  const tabs = await chrome.tabs.query({ discarded: false });
  // Refresh the idle clock: active tabs are busy now, new tabs start counting now, closed tabs drop out.
  const activity = await store.supdate(ACT, {}, a => {
    const next = {};
    for (const t of tabs) next[t.id] = t.active ? now : (a[t.id] || now);
    return next;
  });
  if (!s.memoryEnabled) return 0;
  const idleMs = Math.max(1, +s.idleMinutes || 30) * 60000;
  const canForms = s.protectForms && await hasFormPermission();
  let n = 0;
  for (const t of tabs) {
    if (now - activity[t.id] < idleMs) continue;
    if (await protectionReason(t, s, canForms)) continue;
    if (await discard(t)) n++;
  }
  if (n) await store.update('stats', {}, st => { st.discarded = (st.discarded || 0) + n; });
  return n;
}

/** Suspend one tab now. Active tabs are swapped for a neighbour first. */
export async function suspendTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) return false;
  if (tab.active) {
    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    const others = siblings.filter(t => t.id !== tab.id);
    if (!others.length) return false;
    const next = others.find(t => t.index === tab.index + 1) || others.find(t => t.index === tab.index - 1) || others[0];
    await chrome.tabs.update(next.id, { active: true });
  }
  return discard(tab);
}

/** Suspend background tabs in a window (or everywhere). Manual: ignores idle time but keeps safety rules. */
export async function suspendMany({ windowId } = {}) {
  const s = await store.getSettings();
  const canForms = s.protectForms && await hasFormPermission();
  const q = { discarded: false, active: false };
  if (windowId) q.windowId = windowId;
  const tabs = await chrome.tabs.query(q);
  let n = 0;
  for (const t of tabs) {
    if (await protectionReason(t, s, canForms)) continue;
    if (await discard(t)) n++;
  }
  if (n) await store.update('stats', {}, st => { st.discarded = (st.discarded || 0) + n; });
  return n;
}

export async function ensureAlarm() {
  if (!(await chrome.alarms.get('memory-sweep'))) await chrome.alarms.create('memory-sweep', { periodInMinutes: 1 });
}
