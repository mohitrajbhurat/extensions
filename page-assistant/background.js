// Page Assistant service worker: opens the side panel (or a popup window where the
// Side Panel API is missing), registers the selection context menu, and hands pending
// actions to the panel through chrome.storage.session.

const PANEL_PATH = 'sidepanel/sidepanel.html';
const hasSidePanel = () => !!(chrome.sidePanel && typeof chrome.sidePanel.open === 'function');

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = (props) => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
    add({ id: 'pa-root', title: 'Page Assistant', contexts: ['selection', 'page'] });
    add({ id: 'pa-explain', parentId: 'pa-root', title: 'Explain “%s”', contexts: ['selection'] });
    add({ id: 'pa-summarize', parentId: 'pa-root', title: 'Summarize selection', contexts: ['selection'] });
    add({ id: 'pa-ask', parentId: 'pa-root', title: 'Ask about this…', contexts: ['selection'] });
    add({ id: 'pa-simplify', parentId: 'pa-root', title: 'Simplify selection', contexts: ['selection'] });
    add({ id: 'pa-page-summary', parentId: 'pa-root', title: 'Summarize this page', contexts: ['page'] });
    add({ id: 'pa-page-ask', parentId: 'pa-root', title: 'Ask about this page…', contexts: ['page'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  // We open the panel ourselves so the click also grants activeTab and works with the fallback.
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(setupMenus);

async function setPending(action) {
  try {
    await chrome.storage.session.set({ 'pa:pending': { ...action, ts: Date.now() } });
  } catch (e) {
    // storage.session missing (very old builds): fall back to local storage.
    await chrome.storage.local.set({ 'pa:pending': { ...action, ts: Date.now() } });
  }
}

// Fallback: a small popup window bound to the tab the user was on.
async function openPopupWindow(tab) {
  const url = chrome.runtime.getURL(`${PANEL_PATH}?mode=window&tab=${tab ? tab.id : ''}`);
  const { 'pa:popupWin': winId } = await chrome.storage.session.get('pa:popupWin').catch(() => ({}));
  if (winId) {
    try {
      const w = await chrome.windows.get(winId, { populate: true });
      if (w) {
        const t = w.tabs && w.tabs[0];
        if (t && tab) await chrome.tabs.update(t.id, { url });
        await chrome.windows.update(winId, { focused: true });
        return;
      }
    } catch (e) { /* window closed */ }
  }
  let left;
  try {
    const cur = tab ? await chrome.windows.get(tab.windowId) : null;
    if (cur && cur.left != null && cur.width) left = Math.max(0, cur.left + cur.width - 440);
  } catch (e) { /* ignore */ }
  const w = await chrome.windows.create({ url, type: 'popup', width: 420, height: 760, left, focused: true });
  await chrome.storage.session.set({ 'pa:popupWin': w.id }).catch(() => {});
}

// Must be called synchronously inside the user gesture handler.
function openPanel(tab) {
  if (hasSidePanel() && tab && tab.windowId != null) {
    return chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => openPopupWindow(tab));
  }
  return openPopupWindow(tab);
}

chrome.action.onClicked.addListener((tab) => {
  openPanel(tab);
  setPending({ action: 'refresh', tabId: tab && tab.id });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openPanel(tab);
  const map = {
    'pa-explain': 'explain',
    'pa-summarize': 'summarize-selection',
    'pa-ask': 'ask-selection',
    'pa-simplify': 'simplify',
    'pa-page-summary': 'summarize-page',
    'pa-page-ask': 'ask-page',
  };
  const action = map[info.menuItemId];
  if (action) setPending({ action, text: info.selectionText || '', tabId: tab && tab.id, frameUrl: info.frameUrl || info.pageUrl });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'summarize-page' || command === 'explain-selection') {
    openPanel(tab);
    setPending({ action: command === 'summarize-page' ? 'summarize-page' : 'explain', text: '', tabId: tab && tab.id });
  }
});

chrome.windows && chrome.windows.onRemoved.addListener(async (id) => {
  const { 'pa:popupWin': winId } = await chrome.storage.session.get('pa:popupWin').catch(() => ({}));
  if (winId === id) chrome.storage.session.remove('pa:popupWin').catch(() => {});
});
