// Dashboard shell: hash router, shared data, live refresh.
import * as store from '../lib/store.js';
import { fmtClock, escapeHtml } from '../lib/util.js';
import { $, $$, toast, projectName } from '../shared/ui.js';
import * as dashboard from './views/dashboard.js';
import * as timer from './views/entries.js';
import * as reports from './views/reports.js';
import * as projects from './views/projects.js';
import * as goals from './views/goals.js';
import * as settings from './views/settings.js';

const ROUTES = { dashboard, timer, reports, projects, goals, settings };
const TITLES = {
  dashboard: 'Screen time', timer: 'Timer & entries', reports: 'Reports',
  projects: 'Projects & rules', goals: 'Goals & limits', settings: 'Settings',
};

const ctx = {
  data: null,
  route: 'dashboard',
  /** Per-view state that survives re-renders (selected period etc.). */
  state: {},
  async reload() {
    ctx.data = await store.getData();
    return ctx.data;
  },
  /** Re-render the current view (after a change). */
  async refresh() {
    await ctx.reload();
    await renderView();
  },
  navigate(route) {
    location.hash = route;
  },
};

let current = null;
let renderToken = 0;

async function renderView() {
  const token = ++renderToken;
  const view = $('#view');
  const mod = ROUTES[ctx.route] || dashboard;
  if (current && current !== mod && current.unmount) current.unmount();
  current = mod;
  try {
    await mod.render(view, ctx, () => token === renderToken);
  } catch (e) {
    console.warn(e);
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
  renderSide();
}

function renderSide() {
  const t = ctx.data.timer;
  $('#sideTimer').innerHTML = t
    ? `Timer running<strong id="sideClock">${fmtClock(Date.now() - t.start)}</strong>${escapeHtml(t.desc || projectName(t.projectId, ctx.data))}`
    : '';
  const on = ctx.data.settings.trackingEnabled !== false;
  $('#sideTrack').textContent = on ? 'Pause tracking' : 'Resume tracking';
  $('#sideTrack').classList.toggle('primary', !on);
}

async function onRoute() {
  const r = (location.hash || '#dashboard').slice(1).split('?')[0];
  ctx.route = ROUTES[r] ? r : 'dashboard';
  document.title = `${TITLES[ctx.route]} · Time Ledger`;
  $$('.side a').forEach((a) => {
    if (a.dataset.route === ctx.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  await ctx.reload();
  await renderView();
  $('#view').focus({ preventScroll: true });
}

$('#sideTrack').addEventListener('click', async () => {
  await store.saveSettings({ trackingEnabled: ctx.data.settings.trackingEnabled === false });
  toast(ctx.data.settings.trackingEnabled === false ? 'Tracking resumed' : 'Tracking paused');
});

// Live updates from the worker / other pages. Views may opt out while the
// user is editing (mod.wantsLiveRefresh returning false).
let pending = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  const onlyEngine = keys.every((k) => k === 'engine' || k.startsWith('act:') || k.startsWith('notified:') || k === 'lastPrune');
  clearTimeout(pending);
  pending = setTimeout(async () => {
    await ctx.reload();
    renderSide();
    const mod = ROUTES[ctx.route];
    if (mod.wantsLiveRefresh && !mod.wantsLiveRefresh(ctx, { onlyEngine, keys })) return;
    // Do not re-render under the user's cursor in a form field or open dialog.
    const ae = document.activeElement;
    if (document.querySelector('dialog[open]')) return;
    if (ae && ae.closest('#view') && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    await renderView();
  }, onlyEngine ? 1500 : 200);
});

setInterval(() => {
  const t = ctx.data && ctx.data.timer;
  const el = document.getElementById('sideClock');
  if (t && el) el.textContent = fmtClock(Date.now() - t.start);
  if (current && current.tick) current.tick(ctx);
}, 1000);

window.addEventListener('hashchange', onRoute);
onRoute();
store.send('flush').catch(() => {});
