// Design Inspector service worker.
// Injects the toolbar on user action (activeTab + scripting), captures the visible
// tab for the eyedropper fallback and runs asset downloads.

const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|devtools|view-source|chrome-search|chrome-untrusted|moz-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

async function toggleOnTab(tab) {
  if (!tab || !tab.id) return;
  if (tab.url && RESTRICTED.test(tab.url)) {
    await badge(tab.id, 'no');
    setTimeout(() => badge(tab.id, ''), 2000);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ['content/boot.js'],
    });
  } catch (e) {
    console.warn('Design Inspector could not attach:', e && e.message);
    await badge(tab.id, 'no');
    setTimeout(() => badge(tab.id, ''), 2000);
  }
}

async function badge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d28d9' });
  } catch {}
}

chrome.action.onClicked.addListener(toggleOnTab);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'di-capture') {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs
      .captureVisibleTab(windowId, { format: 'png' })
      .then(dataUrl => respond({ ok: true, dataUrl }))
      .catch(e => respond({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'di-download') {
    chrome.downloads
      .download({ url: msg.url, filename: msg.filename || undefined, saveAs: false })
      .then(id => respond({ ok: true, id }))
      .catch(e => respond({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'di-active') {
    if (sender.tab && sender.tab.id) badge(sender.tab.id, msg.active ? 'on' : '');
    respond({ ok: true });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#6d28d9' }).catch(() => {});
});
