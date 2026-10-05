// Citation Builder service worker: context menus, keyboard command, hand-off to the popup.
import { collectPageData } from './lib/extract-page.js';
import { normalizePage, itemFromIdentifier } from './lib/normalize.js';
import { detectIdentifier } from './lib/identifiers.js';
import { blankItem } from './lib/model.js';
import { todayISO } from './lib/text.js';
import { ensureDefaultProject, getSettings, setPending } from './lib/storage.js';
import { hasLookupPermission, lookupIdentifier, mergeLookup } from './lib/lookup.js';

const MENU_PAGE = 'cb-cite-page';
const MENU_LINK = 'cb-cite-link';
const MENU_SELECTION = 'cb-cite-selection';
const MENU_MANAGER = 'cb-open-manager';

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'Cite this page', contexts: ['page', 'frame', 'image', 'video'] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Cite selected DOI/ISBN “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_LINK, title: 'Cite DOI/arXiv link', contexts: ['link'], targetUrlPatterns: ['*://doi.org/*', '*://dx.doi.org/*', '*://arxiv.org/abs/*', '*://*/doi/*'] });
    chrome.contextMenus.create({ id: MENU_MANAGER, title: 'Open bibliography manager', contexts: ['action'] });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  createMenus();
  await ensureDefaultProject();
});

chrome.runtime.onStartup.addListener(() => { ensureDefaultProject(); });

function openManager() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
}

/** Show the editor: the toolbar popup when the browser allows it, else a small popup window. */
async function openEditor() {
  try {
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      return;
    }
  } catch { /* not supported from this context (older Chrome, Edge, Brave) */ }
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup/popup.html?window=1'),
    type: 'popup', width: 440, height: 720, focused: true,
  });
}

async function citePage(tab) {
  let payload;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageData });
    const { item, sources } = normalizePage(res.result);
    payload = { item, sources, tabId: tab.id };
  } catch {
    payload = {
      item: blankItem({ title: tab.title || '', url: tab.url || '', accessed: todayISO() }),
      message: 'Couldn’t read this page’s metadata, so only the title and URL were filled in.',
      tone: 'warn',
    };
  }
  await setPending(payload);
  await openEditor();
}

async function citeIdentifier(text) {
  const id = detectIdentifier(text);
  if (!id) {
    await setPending({
      item: blankItem({ accessed: todayISO() }),
      message: 'No DOI, ISBN or arXiv ID was found in the selected text. Fill in the fields by hand.',
      tone: 'warn',
    });
    await openEditor();
    return;
  }
  let item = itemFromIdentifier(id);
  let message = `${id.kind.toUpperCase()} ${id.value} detected. Offline mode: fill in the remaining fields, or enable online lookup in Options.`;
  let tone = 'warn';
  const settings = await getSettings();
  if (settings.onlineLookup && await hasLookupPermission()) {
    try {
      item = mergeLookup(item, await lookupIdentifier(id));
      message = `Filled from the online ${id.kind === 'isbn' ? 'Open Library' : id.kind === 'arxiv' ? 'arXiv' : 'Crossref'} record. Review before saving.`;
      tone = 'ok';
    } catch (err) {
      message = `Online lookup failed (${err.message}). Fill in the remaining fields by hand.`;
    }
  }
  await setPending({ item, message, tone });
  await openEditor();
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case MENU_PAGE:
      if (tab) citePage(tab);
      break;
    case MENU_SELECTION:
      citeIdentifier(info.selectionText || '');
      break;
    case MENU_LINK:
      citeIdentifier(info.linkUrl || '');
      break;
    case MENU_MANAGER:
      openManager();
      break;
  }
});

chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open-manager') openManager();
});
