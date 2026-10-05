// Research Canvas service worker: context menus, commands, content-script injection and all data writes.
import * as store from './lib/store.js';

const CONTENT_JS = 'content/content.js';
const AUTO_SCRIPT_ID = 'rc-auto-restore';
const HAS_SIDE_PANEL = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
const HOST_ORIGINS = ['http://*/*', 'https://*/*'];

// ---------- action: side panel or popup fallback ----------
async function configureAction() {
  if (HAS_SIDE_PANEL) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      await chrome.action.setPopup({ popup: '' });
      return;
    } catch (e) {
      console.warn('sidePanel unavailable, using popup', e);
    }
  }
  await chrome.action.setPopup({ popup: 'sidepanel/sidepanel.html?mode=popup' });
}

chrome.runtime.onInstalled.addListener(async () => {
  await store.locked(() => store.ensureDefaults());
  await configureAction();
  await rebuildMenus();
  await syncAutoRestore();
});
chrome.runtime.onStartup.addListener(async () => {
  await configureAction();
  await syncAutoRestore();
});

// ---------- content script injection ----------
function injectable(url) {
  return /^(https?|file):/i.test(url || '') && !/^https:\/\/chrome(webstore)?\.google\.com\/webstore/i.test(url) && !/^https:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url);
}

async function ensureInjected(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'rc:ping' });
    if (r && r.ok) return true;
  } catch { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_JS] });
    return true;
  } catch (e) {
    return false;
  }
}

async function sendToTab(tabId, msg) {
  if (!(await ensureInjected(tabId))) return { ok: false, error: 'Research Canvas cannot run on this page.' };
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) || { ok: false };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Register (or remove) the always-on content script depending on granted host permissions + setting. */
async function syncAutoRestore() {
  const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS }).catch(() => false);
  const settings = await store.getSettings();
  const want = granted && settings.autoRestore;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] }).catch(() => []);
  if (want && !existing.length) {
    await chrome.scripting.registerContentScripts([{
      id: AUTO_SCRIPT_ID,
      matches: HOST_ORIGINS,
      js: [CONTENT_JS],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    }]).catch(e => console.warn('registerContentScripts failed', e));
  } else if (!want && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] }).catch(() => {});
  }
  if (!granted && settings.autoRestore) await store.locked(() => store.setSettings({ autoRestore: false }));
}
chrome.permissions.onAdded.addListener(syncAutoRestore);
chrome.permissions.onRemoved.addListener(syncAutoRestore);

// ---------- context menus ----------
let menuTimer = null;
function scheduleMenus() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(rebuildMenus, 300);
}

async function rebuildMenus() {
  const snap = await store.snapshot();
  await chrome.contextMenus.removeAll();
  const mk = props => new Promise(res => chrome.contextMenus.create(props, () => { void chrome.runtime.lastError; res(); }));
  await mk({ id: 'rc', title: 'Research Canvas', contexts: ['page', 'selection', 'image', 'link'] });
  await mk({ id: 'hl', parentId: 'rc', title: 'Highlight selection', contexts: ['selection'] });
  for (const c of store.COLORS) await mk({ id: 'hl:' + c.id, parentId: 'hl', title: c.name, contexts: ['selection'] });
  const projects = snap.projects.slice(0, 30);
  const active = snap.settings.activeProjectId;
  const groups = [
    ['clipsel', 'Clip selection to project', 'selection'],
    ['clipimg', 'Clip image to project', 'image'],
    ['cliplink', 'Clip link to project', 'link'],
    ['clippage', 'Clip page to project', 'page'],
  ];
  for (const [id, title, ctx] of groups) {
    await mk({ id, parentId: 'rc', title, contexts: [ctx] });
    for (const p of projects) {
      await mk({ id: `${id}:${p.id}`, parentId: id, title: (p.id === active ? '★ ' : '') + p.name, contexts: [ctx] });
    }
  }
  await mk({ id: 'sep1', parentId: 'rc', type: 'separator', contexts: ['page', 'selection'] });
  await mk({ id: 'sticky', parentId: 'rc', title: 'Add sticky note here', contexts: ['page', 'selection'] });
  await mk({ id: 'open', parentId: 'rc', title: 'Open Research Canvas', contexts: ['page', 'selection', 'image', 'link'] });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some(k => k.startsWith('project:')) ||
    (changes.settings && (changes.settings.oldValue || {}).activeProjectId !== (changes.settings.newValue || {}).activeProjectId)) {
    scheduleMenus();
  }
});

async function projectName(id) {
  const snap = await store.snapshot();
  return (snap.projects.find(p => p.id === id) || {}).name || 'project';
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  const tabId = tab && tab.id;
  const pageUrl = store.normalizeUrl(info.pageUrl || (tab && tab.url) || '');
  const pageTitle = (tab && tab.title) || '';
  const [kind, arg] = id.split(':');
  const notify = text => tabId != null && tabId >= 0 && sendToTab(tabId, { type: 'rc:toast', text });

  try {
    if (kind === 'hl') {
      if (arg) await sendToTab(tabId, { type: 'rc:highlight', color: arg });
      return;
    }
    if (kind === 'sticky') {
      const r = await sendToTab(tabId, { type: 'rc:addSticky', atContext: true, text: info.selectionText ? `> ${info.selectionText}\n\n` : '' });
      if (!r.ok) console.warn(r.error);
      return;
    }
    if (kind === 'open') {
      await openPanel(tab);
      return;
    }
    if (!arg) return;
    let clip;
    if (kind === 'clipsel') {
      let content = info.selectionText || '';
      const r = await sendToTab(tabId, { type: 'rc:selection' });
      if (r && r.ok && r.markdown) content = r.markdown;
      clip = { type: 'text', content, url: pageUrl, pageTitle };
    } else if (kind === 'clipimg') {
      clip = { type: 'image', content: info.srcUrl, title: '', url: pageUrl, pageTitle };
    } else if (kind === 'cliplink') {
      clip = { type: 'link', content: info.linkUrl, title: info.linkText || info.selectionText || '', url: pageUrl, pageTitle };
    } else if (kind === 'clippage') {
      clip = { type: 'page', title: pageTitle || pageUrl, content: '', url: pageUrl, pageTitle };
    }
    if (!clip) return;
    clip.projectId = arg;
    await store.locked(() => store.createClip(clip));
    notify(`Clipped to ${await projectName(arg)}`);
  } catch (e) {
    console.error(e);
    notify('Research Canvas: ' + (e.message || e));
  }
});

async function openPanel(tab) {
  if (HAS_SIDE_PANEL && tab) {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); return; } catch { /* fall through */ }
  }
  if (chrome.action.openPopup) {
    try { await chrome.action.openPopup(); return; } catch { /* fall through */ }
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html?mode=tab') });
}

// ---------- commands ----------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const settings = await store.getSettings();
  if (command === 'highlight-selection') await sendToTab(tab.id, { type: 'rc:highlight', color: settings.defaultColor });
  else if (command === 'add-sticky-note') await sendToTab(tab.id, { type: 'rc:addSticky' });
  else if (command === 'clip-selection') {
    const r = await sendToTab(tab.id, { type: 'rc:selection' });
    if (r.ok && (r.markdown || r.text)) {
      const pid = await store.activeProjectId();
      await store.locked(() => store.createClip({ type: 'text', content: r.markdown || r.text, url: r.url, pageTitle: r.title, projectId: pid }));
      await sendToTab(tab.id, { type: 'rc:toast', text: `Clipped to ${await projectName(pid)}` });
    } else {
      await sendToTab(tab.id, { type: 'rc:toast', text: 'Select some text to clip' });
    }
  }
});

// ---------- messages from content scripts and extension pages ----------
const handlers = {
  async 'hl:add'(m) { return { highlight: await store.addHighlight(m) }; },
  async 'hl:update'(m) { return { highlight: await store.updateHighlight(m) }; },
  async 'hl:delete'(m) { await store.deleteHighlight(m); return {}; },
  async 'sticky:upsert'(m) { return { sticky: await store.upsertSticky(m) }; },
  async 'sticky:delete'(m) { await store.deleteSticky(m); return {}; },
  async 'page:delete'(m) { await store.deletePage(m.url); return {}; },
  async 'clip:selection'(m) {
    const clip = await store.createClip({ type: 'text', content: m.content || m.text, url: m.url, pageTitle: m.title });
    return { clip, projectName: await projectName(clip.projectId) };
  },
  async 'clip:add'(m) {
    const clip = await store.createClip(m.clip || {});
    return { clip, projectName: await projectName(clip.projectId) };
  },
  async 'clip:update'(m) { return { clip: await store.updateClip(m.id, m.patch || {}) }; },
  async 'clip:delete'(m) { await store.deleteClip(m.id); return {}; },
  async 'clip:deleteMany'(m) { for (const id of m.ids || []) await store.deleteClip(id); return {}; },
  async 'project:create'(m) {
    const project = await store.createProject(m);
    if (m.activate) await store.setSettings({ activeProjectId: project.id });
    return { project };
  },
  async 'project:update'(m) { return { project: await store.updateProject(m.id, m.patch || {}) }; },
  async 'project:delete'(m) { await store.deleteProject(m.id, m.moveTo); return {}; },
  async 'settings:set'(m) {
    const settings = await store.setSettings(m.patch || {});
    return { settings };
  },
  async 'import'(m) { return { stats: await store.importJSON(m.data) }; },
};

const unlocked = {
  async badge(m, sender) {
    if (sender.tab && sender.tab.id >= 0) {
      const text = m.count ? String(m.count) : '';
      await chrome.action.setBadgeBackgroundColor({ color: '#6741d9', tabId: sender.tab.id }).catch(() => {});
      await chrome.action.setBadgeText({ text, tabId: sender.tab.id }).catch(() => {});
    }
    return {};
  },
  async inject(m) {
    const ok = await ensureInjected(m.tabId);
    return { injected: ok };
  },
  async 'tab:send'(m) { return await sendToTab(m.tabId, m.msg); },
  async 'autoRestore:sync'() { await syncAutoRestore(); return {}; },
  async 'open:highlight'(m) {
    // Open (or focus) the page and scroll to a highlight/sticky once it has loaded.
    let tabId = m.tabId;
    if (tabId == null) {
      const tab = await chrome.tabs.create({ url: m.url });
      tabId = tab.id;
      await new Promise(resolve => {
        const t = setTimeout(done, 15000);
        function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(); }
        function l(id, info) { if (id === tabId && info.status === 'complete') done(); }
        chrome.tabs.onUpdated.addListener(l);
      });
    }
    if (!m.id) return {};
    for (let i = 0; i < 6; i++) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'rc:scrollTo', id: m.id });
        if (r && r.ok) return {};
      } catch { /* content script not present (no host permission) */ }
      await new Promise(r => setTimeout(r, 700));
    }
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const h = handlers[msg.type];
  const u = unlocked[msg.type];
  if (!h && !u) return;
  const run = h ? store.locked(() => h(msg, sender)) : u(msg, sender);
  run.then(r => sendResponse({ ok: true, ...r }), e => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true;
});
