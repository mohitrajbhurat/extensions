// Language Immersion - service worker.
// Owns all writes to the vocabulary and activity log (serialized through a queue so
// concurrent tabs never clobber each other), serves the bundled dictionaries,
// keeps the toolbar badge in sync with due reviews and handles keyboard commands.
import './lib/common.js';

const LIM = globalThis.LIM;
const dictCache = new Map();

// ---------- Settings ----------
async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...LIM.DEFAULT_SETTINGS, ...(settings || {}) };
}
async function patchSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

// ---------- Dictionaries ----------
async function loadJson(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error('Failed to load ' + path);
  return res.json();
}
async function getDictionary(lang) {
  if (!dictCache.has('en')) dictCache.set('en', await loadJson('data/en.json'));
  const en = dictCache.get('en');
  if (!LIM.DICTIONARY_LANGS.includes(lang)) return { en, target: null };
  if (!dictCache.has(lang)) dictCache.set(lang, await loadJson(`data/${lang}.json`));
  return { en, target: dictCache.get(lang) };
}

// ---------- Serialized vocabulary store ----------
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
async function readStore() {
  const { vocab = {}, activity = {} } = await chrome.storage.local.get(['vocab', 'activity']);
  return { vocab, activity };
}
function bumpActivity(activity, field, n) {
  const k = LIM.todayKey();
  const day = activity[k] || (activity[k] = { seen: 0, reviewed: 0, learned: 0 });
  day[field] = (day[field] || 0) + n;
  // Keep about a year of history.
  const keys = Object.keys(activity).sort();
  while (keys.length > 400) delete activity[keys.shift()];
}

function newEntry(item, now) {
  return {
    key: item.key, lang: item.lang, en: item.en, tr: item.tr, pos: item.pos || '', g: item.g || '',
    state: 'new', saved: false, seen: 0, box: 1, due: 0, firstSeen: now, lastSeen: now,
    correct: 0, wrong: 0, context: item.context || '', url: item.url || '', source: item.source || 'dict',
  };
}

async function recordSeen(items) {
  if (!items || !items.length) return { ok: true };
  return serial(async () => {
    const settings = await getSettings();
    const { vocab, activity } = await readStore();
    const now = Date.now();
    for (const item of items.slice(0, 200)) {
      if (!item || !item.key || !item.tr) continue;
      const e = vocab[item.key] || (vocab[item.key] = newEntry(item, now));
      e.seen += 1;
      e.lastSeen = now;
      if (item.tr) e.tr = item.tr;
      if (item.context) { e.context = String(item.context).slice(0, 240); e.url = item.url || e.url; }
      if (e.state === 'new' && settings.autoLearnAfter > 0 && e.seen >= settings.autoLearnAfter) {
        e.state = 'learning'; e.box = 1; e.due = now;
      }
    }
    bumpActivity(activity, 'seen', items.length);
    await chrome.storage.local.set({ vocab, activity });
    return { ok: true };
  });
}

async function setWordState(item, state) {
  return serial(async () => {
    const { vocab, activity } = await readStore();
    const now = Date.now();
    const e = vocab[item.key] || (vocab[item.key] = newEntry(item, now));
    if (item.tr) e.tr = item.tr;
    if (state === 'known') {
      if (e.state !== 'known') bumpActivity(activity, 'learned', 1);
      e.state = 'known'; e.box = 5; e.due = now + 30 * LIM.DAY_MS;
    } else if (state === 'learning') {
      e.state = 'learning'; e.saved = true;
      if (!e.due || e.box >= 5) { e.box = 1; e.due = now; }
    } else if (state === 'new') {
      e.state = 'new'; e.saved = false; e.box = 1; e.due = 0;
    }
    await chrome.storage.local.set({ vocab, activity });
    return { ok: true, entry: e };
  });
}

async function reviewResult(key, correct) {
  return serial(async () => {
    const { vocab, activity } = await readStore();
    const e = vocab[key];
    if (!e) return { ok: false };
    const now = Date.now();
    if (correct) {
      e.correct += 1;
      if (e.box >= 5) {
        if (e.state !== 'known') bumpActivity(activity, 'learned', 1);
        e.state = 'known';
        e.due = now + 30 * LIM.DAY_MS;
      } else {
        e.box += 1;
        if (e.state === 'new') e.state = 'learning';
        e.due = now + LIM.LEITNER_DAYS[e.box] * LIM.DAY_MS;
      }
    } else {
      e.wrong += 1;
      e.box = 1;
      if (e.state === 'known' || e.state === 'new') e.state = 'learning';
      e.due = now;
    }
    e.lastReviewed = now;
    bumpActivity(activity, 'reviewed', 1);
    await chrome.storage.local.set({ vocab, activity });
    return { ok: true, entry: e };
  });
}

async function deleteWord(key) {
  return serial(async () => {
    const { vocab } = await readStore();
    delete vocab[key];
    await chrome.storage.local.set({ vocab });
    return { ok: true };
  });
}

async function importData(data) {
  return serial(async () => {
    if (!data || typeof data !== 'object' || typeof data.vocab !== 'object') throw new Error('Not a Language Immersion backup');
    const { vocab, activity } = await readStore();
    let added = 0;
    for (const [k, v] of Object.entries(data.vocab)) {
      if (!v || typeof v !== 'object' || !v.tr || !v.en) continue;
      const cur = vocab[k];
      if (!cur || (v.lastSeen || 0) > (cur.lastSeen || 0)) { vocab[k] = { ...newEntry(v, Date.now()), ...v, key: k }; added++; }
    }
    for (const [d, v] of Object.entries(data.activity || {})) {
      const cur = activity[d] || {};
      activity[d] = { seen: Math.max(cur.seen || 0, v.seen || 0), reviewed: Math.max(cur.reviewed || 0, v.reviewed || 0), learned: Math.max(cur.learned || 0, v.learned || 0) };
    }
    await chrome.storage.local.set({ vocab, activity });
    if (data.settings) await patchSettings(data.settings);
    return { ok: true, added };
  });
}

async function getStats() {
  const { vocab, activity } = await readStore();
  return LIM.computeStats(vocab, activity);
}

// ---------- Badge ----------
async function updateBadge() {
  try {
    const stats = await getStats();
    await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
    await chrome.action.setBadgeText({ text: stats.due > 0 ? String(Math.min(stats.due, 999)) : '' });
    await chrome.action.setTitle({ title: stats.due > 0 ? `Language Immersion - ${stats.due} word${stats.due === 1 ? '' : 's'} due for review` : 'Language Immersion' });
  } catch (e) { /* badge is cosmetic */ }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.vocab) updateBadge();
});

// ---------- Messaging ----------
const handlers = {
  getState: async () => ({ settings: await getSettings(), stats: await getStats() }),
  getDictionary: async (m) => getDictionary(m.lang),
  recordSeen: async (m) => recordSeen(m.items),
  setWordState: async (m) => setWordState(m.item, m.state),
  reviewResult: async (m) => reviewResult(m.key, !!m.correct),
  deleteWord: async (m) => deleteWord(m.key),
  getVocab: async () => readStore(),
  patchSettings: async (m) => patchSettings(m.patch || {}),
  exportData: async () => ({ ...(await readStore()), settings: await getSettings(), exportedAt: new Date().toISOString(), app: 'language-immersion', version: 1 }),
  importData: async (m) => importData(m.data),
  resetProgress: async () => serial(async () => { await chrome.storage.local.set({ vocab: {}, activity: {}, translationCache: {} }); return { ok: true }; }),
  openReview: async (m) => { await chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html' + (m.hash ? '#' + m.hash : '')) }); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  h(msg, sender).then((r) => sendResponse(r), (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});

// ---------- Commands ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-review') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });
  } else if (command === 'toggle-site') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'lim:toggleSite' }).catch(() => {});
  }
});

// ---------- Lifecycle ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) await chrome.storage.sync.set({ settings: { ...LIM.DEFAULT_SETTINGS } });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') }).catch(() => {});
  }
  updateBadge();
});
chrome.runtime.onStartup.addListener(updateBadge);
updateBadge();
