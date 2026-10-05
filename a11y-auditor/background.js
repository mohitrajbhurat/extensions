// Accessibility Auditor - service worker.
// Keeps per-tab results tidy, keeps the toolbar badge in sync and handles the
// "scan current tab" keyboard command.
import { scanTab, loadResults, saveResults, clearResults, updateBadge, getSettings } from './ui/scan.js';

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar button opens the popup; the side panel is opened from there.
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

// Results from a previous browser session refer to tabs that no longer exist.
chrome.runtime.onStartup.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('scan:'));
  if (stale.length) await chrome.storage.local.remove(stale);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearResults(tabId).catch(() => {});
});

// A navigation or reload invalidates element references; flag the results as stale.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading') return;
  try {
    const report = await loadResults(tabId);
    if (report && !report.stale) {
      report.stale = true;
      await saveResults(tabId, report);
    }
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) {
    /* tab gone */
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'run-audit') return;
  const target = tab && tab.id != null ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target) return;
  try {
    await scanTab(target.id, await getSettings());
  } catch (e) {
    await chrome.action.setBadgeBackgroundColor({ tabId: target.id, color: '#555555' }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: target.id, text: '!' }).catch(() => {});
    await chrome.action.setTitle({ tabId: target.id, title: 'Accessibility Auditor: ' + String((e && e.message) || e) }).catch(() => {});
  }
});

// Keep the badge after the service worker restarts.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const report = await loadResults(tabId).catch(() => null);
  if (report && !report.stale) updateBadge(tabId, report);
});
