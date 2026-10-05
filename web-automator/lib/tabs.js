// Tab helpers: agent injection, messaging with timeouts and navigation tracking.
const navigating = new Map(); // tabId -> timestamp of pending main-frame navigation

export function trackNavigation() {
  chrome.webNavigation.onBeforeNavigate.addListener(d => { if (d.frameId === 0) navigating.set(d.tabId, Date.now()); });
  const done = d => { if (d.frameId === 0) navigating.delete(d.tabId); };
  chrome.webNavigation.onCompleted.addListener(done);
  chrome.webNavigation.onErrorOccurred.addListener(done);
  chrome.tabs.onRemoved.addListener(id => navigating.delete(id));
}

export function isNavigating(tabId) {
  const t = navigating.get(tabId);
  if (!t) return false;
  if (Date.now() - t > 60000) { navigating.delete(tabId); return false; }
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitForTabSettled(tabId, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('The tab was closed'); }
    if (tab.status === 'complete' && !isNavigating(tabId)) return tab;
    if (Date.now() > end) return tab; // give up waiting; later steps have their own timeouts
    await sleep(150);
  }
}

export function sendToTab(tabId, msg, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response from page within ${Math.round(timeout / 1000)} s`)), timeout);
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}

export function isRestrictedUrl(url) {
  return !url || /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|chrome-search):/i.test(url) && url !== 'about:blank'
    || /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url);
}

/** Makes sure the page agent is present in the tab's top frame. */
export async function ensureAgent(tabId) {
  await waitForTabSettled(tabId, 30000);
  try {
    const r = await sendToTab(tabId, { type: 'wa:ping' }, 1200);
    if (r && r.ok) return;
  } catch { /* not injected yet */ }
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) throw new Error(`The browser does not allow extensions to automate this page (${tab.url || 'unknown URL'}).`);
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/agent.js'] });
  } catch (e) {
    if (/permission|Cannot access/i.test(e.message)) throw new Error('Web Automator needs site access to automate this page. Open the popup and click "Allow on all sites".');
    throw e;
  }
}
