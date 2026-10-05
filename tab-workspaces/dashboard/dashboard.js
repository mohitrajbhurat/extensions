// Dashboard shell: navigation, shared data loading and live refresh.
import { h, icon, clear } from '../shared/ui.js';
import { DEFAULT_SETTINGS, plural } from '../lib/util.js';
import workspaces from './views/workspaces.js';
import stash from './views/stash.js';
import tabs from './views/tabs.js';
import sessions from './views/sessions.js';
import archive from './views/archive.js';
import rules from './views/rules.js';
import settings from './views/settings.js';

const VIEWS = [workspaces, stash, tabs, sessions, archive, rules, settings];
const content = document.getElementById('content');
const nav = document.getElementById('nav');

const ctx = {
  windowId: undefined,
  data: { workspaces: [], stashes: [], sessions: [], archive: [], rules: [], settings: DEFAULT_SETTINGS, stats: {}, liveSession: null },
  bindings: {},
  tabs: [],
  groups: new Map(),
  refresh: () => scheduleRefresh(0),
};

let current = null;

async function load() {
  if (ctx.windowId === undefined) {
    try { ctx.windowId = (await chrome.windows.getCurrent()).id; } catch {}
  }
  const [local, session, allTabs, groups] = await Promise.all([
    chrome.storage.local.get(['workspaces', 'stashes', 'sessions', 'archive', 'rules', 'settings', 'stats', 'liveSession']),
    chrome.storage.session.get('bindings').catch(() => ({})),
    chrome.tabs.query({}),
    chrome.tabGroups ? chrome.tabGroups.query({}) : Promise.resolve([]),
  ]);
  ctx.data = {
    workspaces: local.workspaces || [], stashes: local.stashes || [], sessions: local.sessions || [], archive: local.archive || [],
    rules: local.rules || [], settings: { ...DEFAULT_SETTINGS, ...(local.settings || {}) }, stats: local.stats || {}, liveSession: local.liveSession || null,
  };
  ctx.bindings = session.bindings || {};
  ctx.tabs = allTabs;
  ctx.groups = new Map(groups.map(g => [g.id, g]));
}

function renderNav() {
  clear(nav, VIEWS.map(v => h('li', h('button', {
    type: 'button', 'aria-current': current === v ? 'page' : null,
    onclick: () => { location.hash = v.id; },
  }, icon(v.icon), h('span.label', v.label), h('span.count', v.count ? String(v.count(ctx) ?? '') : '')))));
  const n = ctx.tabs.length;
  document.getElementById('brand-sub').textContent = `${plural(n, 'open tab')}`;
}

function route() {
  const id = (location.hash || '#workspaces').slice(1).split('?')[0];
  const view = VIEWS.find(v => v.id === id) || workspaces;
  if (view !== current) {
    current?.unmount?.();
    current = view;
    clear(content);
    view.mount(content, ctx);
    document.title = `${view.label} · Tab Workspaces`;
    content.scrollTop = 0;
    window.scrollTo(0, 0);
  }
  renderNav();
}

let timer = null;
function scheduleRefresh(delay = 250) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await load();
    renderNav();
    current?.update(ctx);
  }, delay);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || (area === 'session' && changes.bindings)) scheduleRefresh();
});
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated', 'onReplaced']) {
  chrome.tabs[ev].addListener((...args) => {
    // Ignore noisy loading/favicon-only updates.
    if (ev === 'onUpdated' && !(args[1].url || args[1].title || args[1].discarded !== undefined || args[1].pinned !== undefined || args[1].groupId !== undefined || args[1].audible !== undefined || args[1].status === 'complete')) return;
    scheduleRefresh(400);
  });
}
if (chrome.tabGroups) chrome.tabGroups.onUpdated.addListener(() => scheduleRefresh(400));
chrome.windows.onRemoved.addListener(() => scheduleRefresh(400));
window.addEventListener('hashchange', route);

// Keyboard: "/" focuses search; "g" + key jumps to a section.
let gPressed = 0;
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.key === '/') {
    const s = content.querySelector('[data-search]');
    if (s) { e.preventDefault(); s.focus(); }
    return;
  }
  if (e.key === 'g') { gPressed = Date.now(); return; }
  if (Date.now() - gPressed < 1200) {
    const v = VIEWS.find(x => x.key === e.key.toLowerCase());
    if (v) { location.hash = v.id; e.preventDefault(); }
    gPressed = 0;
  }
});

load().then(route);
