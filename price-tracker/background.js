// Price Tracker service worker: storage, scheduled re-checks, alerts and messaging.
import './lib/price-parse.js';
import './lib/stats.js';
import './lib/detect.js';

const { productKey, isBlockedHtml, detectFromHtmlString } = globalThis.PriceDetect;
const { evaluateAlerts, computeStats } = globalThis.PriceStats;
const { formatPrice } = globalThis.PriceParse;

const ALARM = 'pt-check';
const OFFSCREEN_URL = 'offscreen/offscreen.html';
const CONTENT_SCRIPT_ID = 'pt-visit';
const HOUR = 3600000;
const MAX_EVENTS = 60;

export const DEFAULT_SETTINGS = {
  intervalHours: 6,
  notifyTarget: true,
  notifyLow: true,
  notifyStock: true,
  goodDealPct: 5,
  recordVisits: true,
  defaultTargetType: 'percent',
  defaultTargetValue: 10,
  maxHistory: 3000,
};

// ---------------------------------------------------------------------------------------
// Storage helpers (all item writes go through a single queue to avoid lost updates)

let queue = Promise.resolve();
function withItems(mutator) {
  const run = queue.then(async () => {
    const { items = {} } = await chrome.storage.local.get('items');
    const result = await mutator(items);
    await chrome.storage.local.set({ items });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

async function getItems() {
  const { items = {} } = await chrome.storage.local.get('items');
  return items;
}

async function getSettings() {
  try {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return null;
  }
}

function findItem(items, url, canonical) {
  const keys = new Set([url, canonical].filter(Boolean).map(productKey));
  return Object.values(items).find(it => keys.has(it.key) || (it.canonicalKey && keys.has(it.canonicalKey))) || null;
}

function addEvent(item, kind, text) {
  item.events = item.events || [];
  item.events.push({ t: Date.now(), kind, text });
  if (item.events.length > MAX_EVENTS) item.events.splice(0, item.events.length - MAX_EVENTS);
}

// ---------------------------------------------------------------------------------------
// Scheduling

async function scheduleAlarm() {
  const { intervalHours } = await getSettings();
  const period = Math.max(0.5, Number(intervalHours) || 6) * 60;
  const existing = await chrome.alarms.get(ALARM);
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(ALARM, { delayInMinutes: Math.min(period, 5), periodInMinutes: period });
  }
}

async function originAllowed(url) {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try { return await chrome.permissions.contains({ origins: [pattern] }); } catch (_) { return false; }
}

/** Register the "record on visit" content script for every tracked origin we have access to. */
async function syncContentScripts() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  const settings = await getSettings();
  const items = await getItems();
  const patterns = [...new Set(Object.values(items).map(i => originPattern(i.url)).filter(Boolean))];
  const matches = [];
  for (const p of patterns) if (await originAllowed(p.replace('/*', '/'))) matches.push(p);
  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }); } catch (_) { /* none */ }
  try {
    if (!matches.length || !settings.recordVisits) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      return;
    }
    const def = {
      id: CONTENT_SCRIPT_ID,
      js: ['lib/price-parse.js', 'lib/detect.js', 'content/visit.js'],
      matches,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    };
    if (existing.length) await chrome.scripting.updateContentScripts([def]);
    else await chrome.scripting.registerContentScripts([def]);
  } catch (e) {
    console.warn('Price Tracker: could not register content script', e);
  }
}

// ---------------------------------------------------------------------------------------
// Offscreen parsing

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] });
      if (ctx.length) return true;
    }
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_PARSER'],
        justification: 'Parse fetched product pages to read their current price.',
      }).catch(e => { if (!/single offscreen|already/i.test(String(e && e.message))) throw e; });
    }
    await creatingOffscreen;
    return true;
  } catch (e) {
    console.warn('Price Tracker: offscreen unavailable', e);
    return false;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  try { if (chrome.offscreen && chrome.offscreen.closeDocument) await chrome.offscreen.closeDocument(); } catch (_) { /* not open */ }
}

async function parseHtml(html, url, selector) {
  if (await ensureOffscreen()) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse', html, url, selector });
      if (res && res.ok) return res.product;
    } catch (e) {
      console.warn('Price Tracker: offscreen parse failed', e);
    }
  }
  return detectFromHtmlString(html, url);
}

// ---------------------------------------------------------------------------------------
// Checking

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and parse one item, then record the result. Returns the updated item. */
async function checkItem(id) {
  const items = await getItems();
  const item = items[id];
  if (!item) return null;
  const allowed = await originAllowed(item.url);
  let page;
  try {
    page = await fetchPage(item.url);
  } catch (e) {
    return setStatus(id, allowed ? 'error' : 'no_permission',
      allowed ? (e.name === 'AbortError' ? 'Timed out' : 'Network error: ' + e.message) : 'Allow access to this site to check it in the background.');
  }
  if (isBlockedHtml(page.text, page.status)) {
    return setStatus(id, 'needs_visit', page.status >= 400 ? `Store blocked the check (HTTP ${page.status}). Visit the page to update.` : 'Store asked for a captcha. Visit the page to update.');
  }
  if (page.status >= 400) {
    return setStatus(id, page.status === 404 || page.status === 410 ? 'error' : 'needs_visit', `HTTP ${page.status}`);
  }
  const product = await parseHtml(page.text, page.finalUrl || item.url, item.selector);
  if (!product || product.price == null) {
    return setStatus(id, 'needs_visit', 'Price not found in the page the store returned. Visit the page to update.');
  }
  return recordObservation(id, product, 'background');
}

async function setStatus(id, status, reason) {
  return withItems(items => {
    const it = items[id];
    if (!it) return null;
    const changed = it.lastStatus !== status;
    it.lastStatus = status;
    it.statusReason = reason || '';
    it.lastChecked = Date.now();
    if (changed && status !== 'ok') addEvent(it, 'status', reason || status);
    return it;
  }).then(async it => { await updateGlobalBadge(); return it; });
}

/**
 * Record a price observation. `via` is 'background', 'visit', 'popup' or 'picked'.
 */
async function recordObservation(id, product, via) {
  const settings = await getSettings();
  const fired = [];
  const item = await withItems(items => {
    const it = items[id];
    if (!it) return null;
    const now = Date.now();
    if (it.currency && product.currency && it.currency !== product.currency) {
      it.lastStatus = 'needs_visit';
      it.statusReason = `Store showed ${product.currency} instead of ${it.currency} (region or currency switch). Visit the page to update.`;
      it.lastChecked = now;
      return it;
    }
    const obs = { t: now, p: product.price != null ? product.price : null, a: product.availability || 'unknown' };
    if (obs.p == null && obs.a === 'unknown') return it;
    const { alerts, state } = evaluateAlerts(it, obs);
    it.alertState = state;
    const history = it.history || (it.history = []);
    const last = history[history.length - 1];
    if (!last || last.p !== obs.p || last.a !== obs.a || now - last.t > 20 * HOUR) {
      history.push({ ...obs, v: via[0] });
      if (history.length > settings.maxHistory) history.splice(0, history.length - settings.maxHistory);
    }
    if (!it.title && product.title) it.title = product.title;
    if (!it.image && product.image) it.image = product.image;
    if (!it.currency && product.currency) it.currency = product.currency;
    if (product.listPrice) it.listPrice = product.listPrice;
    else if (product.price != null) it.listPrice = null;
    if (product.canonical && !it.canonicalKey) it.canonicalKey = productKey(product.canonical);
    it.availability = obs.a;
    it.lastChecked = now;
    it.lastSeen = now;
    it.lastVia = via;
    it.lastStatus = 'ok';
    it.statusReason = '';
    for (const a of alerts) {
      const text = alertText(it, a, obs.p);
      addEvent(it, a.kind, text.message);
      fired.push({ ...a, ...text });
    }
    if (last && last.p != null && obs.p != null && last.p !== obs.p && !alerts.length) {
      addEvent(it, obs.p < last.p ? 'drop' : 'rise', `${formatPrice(last.p, it.currency)} → ${formatPrice(obs.p, it.currency)}`);
    }
    return it;
  });
  if (!item) return null;
  for (const a of fired) {
    if ((a.kind === 'target' && settings.notifyTarget) || (a.kind === 'low' && settings.notifyLow) || (a.kind === 'stock' && settings.notifyStock)) {
      await notify(item, a);
    }
  }
  await updateGlobalBadge();
  return item;
}

function alertText(item, alert, price) {
  const p = formatPrice(price, item.currency);
  const name = item.title || 'Tracked item';
  if (alert.kind === 'target') return { title: `Target price reached: ${p}`, message: `${name} is at or below your target of ${formatPrice(alert.targetPrice, item.currency)}.` };
  if (alert.kind === 'low') return { title: `New all-time low: ${p}`, message: `${name} dropped below its previous low of ${formatPrice(alert.previousLow, item.currency)}.` };
  return { title: 'Back in stock', message: `${name} is available again${price ? ' at ' + p : ''}.` };
}

async function notify(item, alert) {
  if (!chrome.notifications) return;
  let host = '';
  try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch (_) { /* ignore */ }
  const opts = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: alert.title,
    message: alert.message,
    contextMessage: host,
    priority: alert.kind === 'target' ? 2 : 1,
    buttons: [{ title: 'Open product' }, { title: 'Price history' }],
  };
  try {
    await chrome.notifications.create(`pt|${item.id}|${alert.kind}|${Date.now()}`, opts);
  } catch (e) {
    // Some platforms do not support buttons.
    delete opts.buttons;
    try { await chrome.notifications.create(`pt|${item.id}|${alert.kind}|${Date.now()}`, opts); } catch (_) { /* ignore */ }
  }
}

let checkingAll = null;
async function checkDue(force) {
  if (checkingAll) return checkingAll;
  checkingAll = (async () => {
    const settings = await getSettings();
    const items = Object.values(await getItems());
    const interval = settings.intervalHours * HOUR;
    const now = Date.now();
    const due = items.filter(it => {
      if (it.paused) return false;
      if (force) return true;
      const wait = it.lastStatus === 'needs_visit' ? interval * 2 : interval;
      return !it.lastChecked || now - it.lastChecked >= wait * 0.9;
    });
    // Interleave hosts and pause between requests to the same store.
    const lastHit = {};
    let done = 0;
    for (const it of due) {
      let host = '';
      try { host = new URL(it.url).hostname; } catch (_) { /* ignore */ }
      const since = Date.now() - (lastHit[host] || 0);
      const gap = 2500 + Math.random() * 2500;
      if (since < gap) await new Promise(r => setTimeout(r, gap - since));
      try { await checkItem(it.id); } catch (e) { console.warn('Price Tracker: check failed', it.url, e); }
      lastHit[host] = Date.now();
      done++;
    }
    await chrome.storage.local.set({ lastRun: { at: Date.now(), checked: done } });
    await closeOffscreen();
    return done;
  })();
  try { return await checkingAll; } finally { checkingAll = null; }
}

async function updateGlobalBadge() {
  try {
    const items = Object.values(await getItems());
    const hits = items.filter(i => i.alertState && i.alertState.targetHit).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#0f8a5f' });
    await chrome.action.setBadgeText({ text: hits ? String(hits) : '' });
    await chrome.action.setTitle({ title: hits ? `Price Tracker: ${hits} item${hits > 1 ? 's' : ''} at target price` : 'Price Tracker' });
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------------------
// Commands from UI and content scripts

function sanitizeTarget(t) {
  if (!t || !['price', 'percent', 'any', 'none'].includes(t.type)) return { type: 'none', value: null };
  const value = t.type === 'price' || t.type === 'percent' ? Number(t.value) : null;
  if ((t.type === 'price' || t.type === 'percent') && !(value > 0)) return { type: 'none', value: null };
  if (t.type === 'percent' && value >= 100) return { type: 'none', value: null };
  return { type: t.type, value };
}

async function trackProduct({ product, url, target, selector }) {
  if (!product || product.price == null) throw new Error('No price to track');
  const key = productKey(url);
  const created = await withItems(items => {
    let it = findItem(items, url, product.canonical);
    const now = Date.now();
    if (!it) {
      it = {
        id: uid(), url, key,
        canonicalKey: product.canonical ? productKey(product.canonical) : null,
        title: product.title || url,
        image: product.image || null,
        currency: product.currency || null,
        store: product.store || null,
        source: product.source || null,
        selector: selector || null,
        baselinePrice: product.price,
        createdAt: now,
        history: [],
        events: [],
        alertState: {},
        lastStatus: 'ok',
        lastChecked: null,
        paused: false,
      };
      addEvent(it, 'track', `Started tracking at ${formatPrice(product.price, product.currency)}`);
      items[it.id] = it;
    }
    it.target = sanitizeTarget(target);
    if (selector) it.selector = selector;
    return it;
  });
  await recordObservation(created.id, product, selector ? 'picked' : 'popup');
  await syncContentScripts();
  return (await getItems())[created.id];
}

async function importItems(list, mode) {
  if (!Array.isArray(list)) throw new Error('Expected an array of items');
  let added = 0, merged = 0;
  await withItems(items => {
    if (mode === 'replace') for (const k of Object.keys(items)) delete items[k];
    for (const raw of list) {
      if (!raw || typeof raw.url !== 'string' || !/^https?:/i.test(raw.url)) continue;
      const history = (Array.isArray(raw.history) ? raw.history : [])
        .filter(h => h && typeof h.t === 'number')
        .map(h => ({ t: h.t, p: typeof h.p === 'number' ? h.p : null, a: ['in_stock', 'out_of_stock'].includes(h.a) ? h.a : 'unknown' }));
      const existing = findItem(items, raw.url);
      if (existing) {
        const seen = new Set(existing.history.map(h => h.t));
        for (const h of history) if (!seen.has(h.t)) existing.history.push(h);
        existing.history.sort((a, b) => a.t - b.t);
        merged++;
        continue;
      }
      const id = uid();
      items[id] = {
        id, url: raw.url, key: productKey(raw.url), canonicalKey: raw.canonicalKey || null,
        title: String(raw.title || raw.url).slice(0, 300), image: typeof raw.image === 'string' ? raw.image : null,
        currency: typeof raw.currency === 'string' ? raw.currency.slice(0, 3).toUpperCase() : null,
        selector: typeof raw.selector === 'string' ? raw.selector : null,
        target: sanitizeTarget(raw.target), baselinePrice: Number(raw.baselinePrice) || (history.find(h => h.p) || {}).p || null,
        createdAt: Number(raw.createdAt) || Date.now(), history, events: [], alertState: {},
        lastStatus: 'ok', lastChecked: Number(raw.lastChecked) || null, paused: !!raw.paused, notes: typeof raw.notes === 'string' ? raw.notes : '',
      };
      added++;
    }
  });
  await syncContentScripts();
  return { added, merged };
}

const handlers = {
  async 'find'({ url, canonical }) {
    return findItem(await getItems(), url, canonical);
  },
  async 'visit'({ url, canonical }) {
    const settings = await getSettings();
    if (!settings.recordVisits) return null;
    const it = findItem(await getItems(), url, canonical);
    return it && !it.paused ? { id: it.id, selector: it.selector || null } : null;
  },
  async 'observe'({ id, url, product, via }, sender) {
    const items = await getItems();
    const it = id ? items[id] : findItem(items, url, product && product.canonical);
    if (!it || !product) return null;
    if (product.price == null && (!product.availability || product.availability === 'unknown')) return it;
    const updated = await recordObservation(it.id, product, via || 'visit');
    if (sender && sender.tab && sender.tab.id != null && updated) {
      const stats = computeStats(updated.history);
      const good = stats.avg && stats.current < stats.avg * 0.97;
      try {
        await chrome.action.setBadgeText({ tabId: sender.tab.id, text: good ? '↓' : '✓' });
        await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: good ? '#0f8a5f' : '#5b6472' });
      } catch (_) { /* tab gone */ }
    }
    return updated;
  },
  async 'track'(msg) { return trackProduct(msg); },
  async 'update'({ id, patch }) {
    const it = await withItems(items => {
      const item = items[id];
      if (!item) return null;
      if (patch.target) {
        item.target = sanitizeTarget(patch.target);
        item.alertState = { ...(item.alertState || {}), targetHit: false };
        const last = (item.history || []).filter(h => h.p != null).pop();
        const tp = globalThis.PriceStats.targetPrice(item.target, item.baselinePrice);
        if (last && tp != null && last.p <= tp) item.alertState.targetHit = true;
      }
      if ('selector' in patch) item.selector = patch.selector || null;
      if ('paused' in patch) item.paused = !!patch.paused;
      if ('notes' in patch) item.notes = String(patch.notes || '').slice(0, 2000);
      if ('title' in patch && patch.title) item.title = String(patch.title).slice(0, 300);
      if ('baselinePrice' in patch && Number(patch.baselinePrice) > 0) item.baselinePrice = Number(patch.baselinePrice);
      return item;
    });
    await updateGlobalBadge();
    return it;
  },
  async 'delete'({ ids }) {
    await withItems(items => { for (const id of ids || []) delete items[id]; });
    await syncContentScripts();
    await updateGlobalBadge();
    return true;
  },
  async 'check'({ id }) {
    const it = await checkItem(id);
    await closeOffscreen();
    return it;
  },
  async 'check-all'() { return checkDue(true); },
  async 'import'({ items, mode }) { return importItems(items, mode); },
  async 'permissions-changed'() { await syncContentScripts(); return true; },
  async 'picked'({ url, selector, text, product }, sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    const pick = { url, selector, text, product, at: Date.now() };
    if (tabId != null && chrome.storage.session) await chrome.storage.session.set({ ['pick:' + tabId]: pick });
    const it = findItem(await getItems(), url, product && product.canonical);
    if (it) {
      await handlers.update({ id: it.id, patch: { selector } });
      if (product && product.price != null) await recordObservation(it.id, product, 'picked');
    }
    try { if (chrome.action.openPopup) await chrome.action.openPopup(); } catch (_) { /* needs user gesture on some versions */ }
    return { tracked: !!it };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || !handlers[msg.type]) return false;
  handlers[msg.type](msg, sender).then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: String(error && error.message || error) }),
  );
  return true;
});

// ---------------------------------------------------------------------------------------
// Lifecycle

chrome.runtime.onInstalled.addListener(async details => {
  await scheduleAlarm();
  await syncContentScripts();
  await updateGlobalBadge();
  if (details.reason === 'install') {
    const { settings } = await chrome.storage.sync.get('settings').catch(() => ({}));
    if (!settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await syncContentScripts();
  await updateGlobalBadge();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) checkDue(false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (before.intervalHours !== after.intervalHours) scheduleAlarm();
    if (before.recordVisits !== after.recordVisits) syncContentScripts();
  }
});

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => syncContentScripts());
  chrome.permissions.onRemoved.addListener(() => syncContentScripts());
}

if (chrome.notifications) {
  const openFor = async (notificationId, button) => {
    const [, id] = notificationId.split('|');
    const it = (await getItems())[id];
    chrome.notifications.clear(notificationId);
    if (!it) return;
    if (button === 1) chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#item=' + encodeURIComponent(id)) });
    else chrome.tabs.create({ url: it.url });
  };
  chrome.notifications.onClicked.addListener(id => { if (id.startsWith('pt|')) openFor(id, 0); });
  chrome.notifications.onButtonClicked.addListener((id, idx) => { if (id.startsWith('pt|')) openFor(id, idx); });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) chrome.storage.session && chrome.storage.session.remove('pick:' + tabId).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (chrome.storage.session) chrome.storage.session.remove('pick:' + tabId).catch(() => {});
});

// Exposed for automated tests (service worker console only).
globalThis.__priceTracker = { checkItem, checkDue, recordObservation, trackProduct, handlers, getItems, syncContentScripts };

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(cmd => {
    if (cmd === 'open-dashboard') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });
}
