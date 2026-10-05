// PDF Studio service worker: context menus, toolbar action and the tools command.
// All PDF work happens in the extension pages (viewer/ and tools/); nothing is uploaded.

const VIEWER = 'viewer/viewer.html';
const TOOLS = 'tools/tools.html';

const PDF_LINK_PATTERNS = [
  '*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*',
  '*://*/*.PDF', '*://*/*.PDF?*',
  '*://*/pdf/*', '*://*/*/pdf/*',
  'file:///*.pdf', 'file:///*.PDF'
];

function looksLikePdfUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^(https?|file):$/.test(u.protocol)) return false;
    return /\.pdf$/i.test(u.pathname) || /\/pdf\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function openViewer(pdfUrl, openerTab) {
  const url = chrome.runtime.getURL(VIEWER) + (pdfUrl ? '?url=' + encodeURIComponent(pdfUrl) : '');
  const props = { url };
  if (openerTab && openerTab.index !== undefined) props.index = openerTab.index + 1;
  if (openerTab && openerTab.id !== undefined && openerTab.id >= 0) props.openerTabId = openerTab.id;
  return chrome.tabs.create(props);
}

function openTools() {
  return chrome.tabs.create({ url: chrome.runtime.getURL(TOOLS) });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-link',
      title: 'Open in PDF Studio',
      contexts: ['link'],
      targetUrlPatterns: PDF_LINK_PATTERNS
    });
    chrome.contextMenus.create({
      id: 'open-page',
      title: 'Open this PDF in PDF Studio',
      contexts: ['page', 'frame'],
      documentUrlPatterns: PDF_LINK_PATTERNS
    });
    chrome.contextMenus.create({
      id: 'open-viewer',
      title: 'Open a PDF from this computer',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'open-tools',
      title: 'Page tools: merge, split, organize, compress',
      contexts: ['action']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'open-link':
      openViewer(info.linkUrl, tab);
      break;
    case 'open-page':
      openViewer(info.frameUrl || info.pageUrl, tab);
      break;
    case 'open-viewer':
      openViewer(null, tab);
      break;
    case 'open-tools':
      openTools();
      break;
  }
});

// Toolbar button: if the active tab shows a PDF, open it in the studio; otherwise open a blank session.
// activeTab gives us the tab URL for this click without the broad "tabs" permission.
chrome.action.onClicked.addListener((tab) => {
  const url = tab && tab.url;
  openViewer(looksLikePdfUrl(url) ? url : null, tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-tools') openTools();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'open-tools') {
    openTools().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
