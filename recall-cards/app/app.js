// Recall Cards app shell: hash router, shared data loading, sidebar counts.
import { ensureDefaultDeck, getAll, revlogSince, onChanged, createDeck } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';
import { dueCounts, dayStart, newStudiedToday } from '../lib/queue.js';
import { h } from './ui.js';

const views = {
  decks: () => import('./views/decks.js'),
  review: () => import('./views/review.js'),
  add: () => import('./views/add.js'),
  browse: () => import('./views/browse.js'),
  stats: () => import('./views/stats.js'),
  io: () => import('./views/io.js'),
  settings: () => import('./views/settings.js'),
};
const TITLES = { decks: 'Decks', review: 'Review', add: 'Add cards', browse: 'Browse', stats: 'Statistics', io: 'Import / export', settings: 'Settings' };

const view = document.getElementById('view');
let cleanup = null;
let currentRoute = null;
let renderToken = 0;

export async function loadData() {
  const settings = await getSettings();
  const now = Date.now();
  const [decks, cards, revlogToday] = await Promise.all([ensureDefaultDeck(), getAll('cards'), revlogSince(dayStart(now, settings.rolloverHour))]);
  return { decks, cards, settings, revlogToday, now };
}

export function countsFor(data, deckIds = null, now = Date.now()) {
  return dueCounts(data.cards, {
    now, rolloverHour: data.settings.rolloverHour, newPerDay: data.settings.newPerDay,
    newStudied: newStudiedToday(data.revlogToday, now, data.settings.rolloverHour), deckIds,
  });
}

/** Resolves a deck choice from the editor (existing id or new name) into a deck id. */
export async function resolveDeckId(note, decks) {
  if (note.newDeckName) return (await createDeck(note.newDeckName)).id;
  return decks.find(d => d.id === note.deckId) ? note.deckId : decks[0].id;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || 'decks';
  const [route, query = ''] = raw.split('?');
  return { route: views[route] ? route : 'decks', params: new URLSearchParams(query) };
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const { route: name, params } = parseHash();
  const token = ++renderToken;
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${TITLES[name]} · Recall Cards`;
  try {
    const [mod, data] = await Promise.all([views[name](), loadData()]);
    if (token !== renderToken) return;
    view.replaceChildren();
    view.className = `view view-${name}`;
    const ctx = { data, params, navigate, reload: loadData, countsFor, resolveDeckId, refreshSidebar };
    cleanup = (await mod.render(view, ctx)) || null;
    if (currentRoute !== name) view.focus({ preventScroll: true });
    currentRoute = name;
    refreshSidebar(data);
  } catch (err) {
    console.warn(err);
    view.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Something went wrong'), h('p', { class: 'muted' }, String(err && err.message || err))));
  }
}

export async function refreshSidebar(data) {
  data = data || await loadData();
  const c = countsFor(data);
  const badge = document.getElementById('navDue');
  badge.textContent = c.total ? String(c.total) : '';
  document.getElementById('sideFoot').textContent = `${data.cards.length} card${data.cards.length === 1 ? '' : 's'} · ${data.decks.length} deck${data.decks.length === 1 ? '' : 's'}`;
}

window.addEventListener('hashchange', route);
let sidebarTimer = null;
onChanged(() => { clearTimeout(sidebarTimer); sidebarTimer = setTimeout(() => refreshSidebar(), 300); });
route();
