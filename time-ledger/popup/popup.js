import * as store from '../lib/store.js';
import { CATEGORY_META, CATEGORIES } from '../lib/rules.js';
import { total, siteTotals, totalsBy } from '../lib/report.js';
import { evaluateGoals, goalLabel } from '../lib/goals.js';
import { startOfDay, addDays, fmtDur, fmtClock, escapeHtml } from '../lib/util.js';
import { $, ICONS, toast, projectOptions, projectName, projectColor, loadRange, parseTags, faviconFor } from '../shared/ui.js';

let data = null;
let today = null;
let editingTimer = false;

function openApp(hash = 'dashboard') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`app/app.html#${hash}`) });
  window.close();
}

async function refresh() {
  const from = startOfDay(Date.now());
  today = await loadRange(from, addDays(from, 1));
  data = today.data;
  render();
}

function render() {
  renderTracking();
  renderTimer();
  renderNow();
  renderToday();
  renderSites();
}

function renderTracking() {
  const on = data.settings.trackingEnabled !== false;
  const b = $('#trackToggle');
  b.textContent = on ? 'Tracking on' : 'Paused';
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('primary', on);
}

function renderTimer() {
  const t = data.timer;
  const card = $('.timer');
  card.classList.toggle('running', !!t);
  const btn = $('#timerBtn');
  btn.innerHTML = t ? ICONS.stop : ICONS.play;
  btn.className = 'btn ' + (t ? 'stop' : 'primary start');
  btn.setAttribute('aria-label', t ? 'Stop timer' : 'Start timer');
  btn.title = t ? 'Stop timer' : 'Start timer';
  if (!editingTimer) {
    $('#desc').value = t ? t.desc || '' : $('#desc').value;
    $('#project').innerHTML = projectOptions(data, t ? t.projectId : $('#project').value || null);
    if (t) $('#tags').value = (t.tags || []).join(', ');
  }
  $('#timerSub').textContent = t
    ? `Started ${new Date(t.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${projectName(t.projectId, data)}`
    : 'Timer stopped';
  tick();
  // Recent entries for one-click continue
  const seen = new Set();
  const recent = [];
  for (const e of [...data.entries].sort((a, b) => b.end - a.end)) {
    const k = (e.desc || '') + '|' + (e.projectId || '');
    if (seen.has(k) || (!e.desc && !e.projectId)) continue;
    seen.add(k);
    recent.push(e);
    if (recent.length >= 4) break;
  }
  $('#recent').innerHTML = t ? '' : recent.map((e, i) => `
    <button type="button" data-recent="${i}" title="Continue: ${escapeHtml(e.desc || projectName(e.projectId, data))}">
      <span class="dot" style="background:${projectColor(e.projectId, data)}"></span>
      <span class="t">${escapeHtml(e.desc || projectName(e.projectId, data))}</span>
    </button>`).join('');
  $('#recent').onclick = async (ev) => {
    const b = ev.target.closest('[data-recent]');
    if (!b) return;
    const e = recent[+b.dataset.recent];
    await store.send('timer.start', { desc: e.desc, projectId: e.projectId, tags: e.tags, billable: e.billable });
    await refresh();
  };
}

function tick() {
  const t = data && data.timer;
  $('#elapsed').textContent = fmtClock(t ? Date.now() - t.start : 0);
}

function renderNow() {
  const eng = data.engine;
  const body = $('#nowBody');
  const live = today.segs.find((s) => s.live);
  if (data.settings.trackingEnabled === false) {
    body.innerHTML = '<span class="muted">Automatic tracking is paused.</span>';
    $('#nowDur').textContent = '';
    return;
  }
  if (!live) {
    let why = 'Not tracking: this page is not a website.';
    if (eng && eng.idle && eng.idle !== 'active') why = 'Not tracking: you are away.';
    body.innerHTML = `<span class="muted">${why}</span>`;
    $('#nowDur').textContent = '';
    return;
  }
  const item = today.auto.find((i) => i.live);
  const proj = item && item.projectId;
  const cat = item ? item.category : 'neutral';
  body.innerHTML = `${faviconFor(live.domain)}
    <div class="grow stack" style="gap:0">
      <strong class="title">${escapeHtml(live.domain)}</strong>
      <span class="title small muted">${escapeHtml(live.title || live.url)}</span>
    </div>
    <span class="chip ${cat}">${CATEGORY_META[cat].label}</span>
    ${proj ? `<span class="chip"><span class="dot" style="background:${projectColor(proj, data)}"></span>${escapeHtml(projectName(proj, data))}</span>` : ''}`;
  // time on this site today
  const siteMs = total(today.auto.filter((i) => i.domain === live.domain));
  $('#nowDur').textContent = `${fmtDur(siteMs)} today`;
}

function renderToday() {
  const autoMs = total(today.auto);
  $('#todayTotal').textContent = fmtDur(autoMs);
  $('#todayTimer').textContent = fmtDur(total(today.manual));
  const byCat = Object.fromEntries(totalsBy(today.auto, (i) => i.category).map((r) => [r.key, r.ms]));
  $('#catBar').innerHTML = autoMs ? CATEGORIES.map((c) => byCat[c]
    ? `<span style="width:${(byCat[c] / autoMs) * 100}%;background:${CATEGORY_META[c].color}" title="${CATEGORY_META[c].label}: ${fmtDur(byCat[c])}"></span>` : '').join('') : '';
  $('#catLegend').innerHTML = CATEGORIES.map((c) => `<span><span class="dot" style="background:${CATEGORY_META[c].color}"></span>${CATEGORY_META[c].label} <span class="mono">${fmtDur(byCat[c] || 0)}</span></span>`).join('');
  const results = evaluateGoals(data.goals, [...today.auto, ...today.manual]).slice(0, 3);
  $('#goals').innerHTML = results.map((r) => {
    const pct = Math.min(100, r.pct * 100);
    const color = r.goal.kind === 'limit'
      ? (r.status === 'exceeded' ? 'var(--danger)' : r.status === 'warning' ? 'var(--warning)' : 'var(--accent)')
      : (r.status === 'reached' ? 'var(--success)' : 'var(--accent)');
    return `<div class="goal"><span>${escapeHtml(goalLabel(r.goal, data.projects))}</span>
      <span class="mono muted">${fmtDur(r.ms)} / ${fmtDur(r.targetMs)}</span>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct}%;background:${color}"></span></div></div>`;
  }).join('');
}

function renderSites() {
  const sites = siteTotals(today.auto, data.categoryMap).slice(0, 6);
  const max = sites[0] ? sites[0].ms : 1;
  $('#sites').innerHTML = sites.length ? sites.map((s) => `<li>
      ${faviconFor(s.domain)}<span class="name">${escapeHtml(s.domain)}</span>
      <span class="mono small">${fmtDur(s.ms)}</span>
      <div class="bar mini"><span style="width:${(s.ms / max) * 100}%;background:${CATEGORY_META[s.category].color}"></span></div>
    </li>`).join('') : '<li class="muted small" style="display:block">No browsing tracked yet today.</li>';
}

// ---------- events ----------
$('#openApp').innerHTML = ICONS.open;
$('#openApp').onclick = () => openApp('dashboard');
$('#allSites').onclick = (e) => { e.preventDefault(); openApp('dashboard'); };
document.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openApp(a.dataset.open); }));

$('#trackToggle').onclick = async () => {
  await store.saveSettings({ trackingEnabled: data.settings.trackingEnabled === false });
  await refresh();
};

$('#timerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (data.timer) {
      const entry = await store.send('timer.stop');
      toast(entry ? `Saved ${fmtDur(entry.end - entry.start)}` : 'Timer discarded (under 1 second)');
    } else {
      await store.send('timer.start', {
        desc: $('#desc').value.trim(), projectId: $('#project').value || null, tags: parseTags($('#tags').value),
      });
    }
    editingTimer = false;
    await refresh();
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// Editing description/project/tags of a running timer saves on change.
for (const id of ['#desc', '#project', '#tags']) {
  const el = $(id);
  el.addEventListener('focus', () => { editingTimer = true; });
  el.addEventListener('blur', () => { editingTimer = false; });
  el.addEventListener('change', async () => {
    if (!data.timer) return;
    await store.send('timer.update', { patch: { desc: $('#desc').value.trim(), projectId: $('#project').value || null, tags: parseTags($('#tags').value) } });
  });
}

let pending = null;
function scheduleRefresh() {
  clearTimeout(pending);
  pending = setTimeout(refresh, 150);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.timer || changes.settings || changes.projects || changes.entries || changes.engine || changes.goals) scheduleRefresh();
});

setInterval(tick, 1000);
setInterval(refresh, 15000);

// Ask the worker to checkpoint so totals are fresh, then render.
refresh().then(() => store.send('flush').catch(() => {})).catch((e) => toast(e.message, { error: true }));
$('#desc').focus();
