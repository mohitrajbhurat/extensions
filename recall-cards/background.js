// Recall Cards service worker: context menu capture, badge, daily reminder, messaging.
import { ensureDefaultDeck, listDecks, getAll, addNote, createDeck, revlogSince } from './lib/db.js';
import { getSettings, saveSettings } from './lib/settings.js';
import { dueCounts, dayStart, newStudiedToday } from './lib/queue.js';

const APP_URL = chrome.runtime.getURL('app/app.html');
const MENU_ID = 'recall-make-card';
const ALL_URLS = { origins: ['<all_urls>'] };

// ---------- setup ----------
chrome.runtime.onInstalled.addListener(async details => {
  await setupMenus();
  await ensureDefaultDeck();
  await scheduleAlarms();
  await syncFloatingButton();
  await updateBadge();
  if (details.reason === 'install') openApp('#decks?welcome=1');
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await updateBadge();
});

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: 'Make flashcard from "%s"', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'recall-review', title: 'Review due flashcards', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'recall-open-app', title: 'Open Recall Cards app', contexts: ['action'] });
}

async function scheduleAlarms() {
  const s = await getSettings();
  await chrome.alarms.clear('reminder');
  if (s.reminderEnabled) {
    const [h, m] = String(s.reminderTime || '09:00').split(':').map(Number);
    const next = new Date();
    next.setHours(h || 0, m || 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    chrome.alarms.create('reminder', { when: next.getTime(), periodInMinutes: 24 * 60 });
  }
  const badge = await chrome.alarms.get('badge');
  if (!badge) chrome.alarms.create('badge', { periodInMinutes: 5 });
}

// ---------- badge ----------
async function computeCounts() {
  const s = await getSettings();
  const now = Date.now();
  const [cards, revlog] = await Promise.all([getAll('cards'), revlogSince(dayStart(now, s.rolloverHour))]);
  return dueCounts(cards, { now, rolloverHour: s.rolloverHour, newPerDay: s.newPerDay, newStudied: newStudiedToday(revlog, now, s.rolloverHour) });
}

let badgeTimer = null;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => updateBadge().catch(() => {}), 250);
}

async function updateBadge() {
  const s = await getSettings();
  const c = await computeCounts();
  const text = !s.showBadge || c.total === 0 ? '' : c.total > 999 ? '999+' : String(c.total);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: c.total ? `Recall Cards: ${c.total} due (${c.review} review, ${c.learning} learning, ${c.new} new)` : 'Recall Cards: nothing due' });
  return c;
}

// ---------- reminder ----------
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'badge') return updateBadge();
  if (alarm.name === 'reminder') {
    const s = await getSettings();
    if (!s.reminderEnabled) return;
    const c = await updateBadge();
    if (c.total > 0) {
      chrome.notifications.create('recall-reminder', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Time to review',
        message: `${c.total} flashcard${c.total === 1 ? '' : 's'} due: ${c.review} review, ${c.learning} learning, ${c.new} new.`,
        buttons: [{ title: 'Start review' }, { title: 'Later' }],
        priority: 1,
      });
    }
  }
});

chrome.notifications.onClicked.addListener(id => {
  if (id === 'recall-reminder') { chrome.notifications.clear(id); openApp('#review'); }
});
chrome.notifications.onButtonClicked.addListener((id, idx) => {
  chrome.notifications.clear(id);
  if (id === 'recall-reminder' && idx === 0) openApp('#review');
});

// ---------- open app ----------
async function openApp(hash = '#decks', extraQuery = '') {
  const url = APP_URL + (extraQuery ? `?${extraQuery}` : '') + hash;
  const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
  if (tabs.length && !extraQuery) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true, url });
    if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

// ---------- capture ----------
async function openCapture(tab, selectionText = '') {
  const fallback = async () => {
    await chrome.storage.session.set({ prefill: { back: selectionText, url: tab?.url || '', title: tab?.title || '', ts: Date.now() } }).catch(() => {});
    openApp('#add', 'prefill=1');
  };
  if (!tab || tab.id == null || tab.id < 0) return fallback();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/capture.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: text => window.__recallCards && window.__recallCards.open({ text }),
      args: [selectionText],
    });
  } catch {
    // Restricted page (browser pages, web store, PDF viewer): fall back to the app's add form.
    await fallback();
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) openCapture(tab, info.selectionText || '');
  else if (info.menuItemId === 'recall-review') openApp('#review');
  else if (info.menuItemId === 'recall-open-app') openApp('#decks');
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'make-flashcard') {
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    openCapture(tab, '');
  } else if (command === 'start-review') openApp('#review');
});

// ---------- floating selection button (optional host permission) ----------
async function syncFloatingButton() {
  const s = await getSettings();
  const granted = await chrome.permissions.contains(ALL_URLS).catch(() => false);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ['recall-capture'] }).catch(() => []);
  const want = s.floatingButton && granted;
  if (want && !registered.length) {
    await chrome.scripting.registerContentScripts([{ id: 'recall-capture', matches: ['<all_urls>'], js: ['content/capture.js'], runAt: 'document_idle', persistAcrossSessions: true }]).catch(() => {});
  } else if (!want && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: ['recall-capture'] }).catch(() => {});
  }
  if (s.floatingButton && !granted) await saveSettings({ floatingButton: false });
}

chrome.permissions.onRemoved.addListener(() => syncFloatingButton());
chrome.permissions.onAdded.addListener(() => syncFloatingButton());

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    switch (msg?.type) {
      case 'getCaptureContext': {
        const decks = await ensureDefaultDeck();
        const s = await getSettings();
        return { decks, settings: { lastDeckId: s.lastDeckId, captureMode: s.captureMode, clozeSeparate: s.clozeSeparate } };
      }
      case 'createNote': {
        const n = msg.note || {};
        let deckId = n.deckId;
        if (n.newDeckName) deckId = (await createDeck(n.newDeckName)).id;
        const decks = await listDecks();
        if (!decks.find(d => d.id === deckId)) deckId = (await ensureDefaultDeck())[0].id;
        const cards = await addNote({ type: n.type, front: n.front, back: n.back, deckId, tags: n.tags, source: n.source });
        await saveSettings({ lastDeckId: deckId, captureMode: n.type === 'cloze' ? 'cloze' : 'basic', ...(typeof n.clozeSeparate === 'boolean' ? { clozeSeparate: n.clozeSeparate } : {}) });
        scheduleBadge();
        const deck = (await listDecks()).find(d => d.id === deckId);
        return { ok: true, count: cards.length, deckName: deck?.name || '' };
      }
      case 'dataChanged':
        scheduleBadge();
        return { ok: true };
      case 'settingsChanged':
        await scheduleAlarms();
        await syncFloatingButton();
        await updateBadge();
        return { ok: true };
      case 'getCounts':
        return computeCounts();
      case 'openApp':
        await openApp(msg.hash || '#decks');
        return { ok: true };
      case 'captureActiveTab': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await openCapture(tab, '');
        return { ok: true };
      }
      default:
        return undefined;
    }
  };
  handle().then(r => sendResponse(r), e => sendResponse({ error: String(e?.message || e) }));
  return true;
});

// Refresh the badge when the service worker wakes for any reason.
updateBadge().catch(() => {});
