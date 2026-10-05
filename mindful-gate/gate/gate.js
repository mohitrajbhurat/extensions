import { send, fmtDuration, fmtHourMin, escapeHtml } from '../lib/core.js';
import { $, toast, targetFromLocation, param, el } from '../lib/ui.js';

const target = targetFromLocation();
const SUGGESTIONS = ['Reply to one message', 'Look up one specific thing', 'Watch one video I planned to', 'Take a deliberate 10 minute break'];

let info = null;
let breathLeftMs = 0;
let breathDone = false;
let busy = false;

function pickReason(reasons) {
  const list = reasons && reasons.length ? reasons : ['Your attention is worth protecting.'];
  $('#reason').textContent = list[Math.floor(Math.random() * list.length)];
}

async function init() {
  if (param('left') === '1') return showLeft();
  if (!target) {
    $('#gateView').classList.remove('hidden');
    $('#gateTitle').textContent = 'Nothing to open';
    $('#breath').classList.add('hidden');
    $('#intentForm').classList.add('hidden');
    return;
  }
  // Count a prompt once per page load (not on bfcache restores or reloads of the same tab).
  const guardKey = 'mg-prompted:' + target;
  const count = !sessionStorage.getItem(guardKey);
  try { sessionStorage.setItem(guardKey, '1'); } catch { /* ignore */ }

  info = await send('gateOpened', { url: target, count });
  if (info.blocked) return location.replace(info.blocked.url);
  if (info.pass) return location.replace(target);

  document.title = `${info.domain} - pause first`;
  $('#siteName').textContent = info.domain;
  const metaBits = [`visit ${info.visitsToday + 1} today`];
  if (info.timeToday >= 60) metaBits.push(`${fmtDuration(info.timeToday)} spent today`);
  if (info.turnedBackToday) metaBits.push(`turned back ${info.turnedBackToday}x`);
  $('#siteMeta').textContent = metaBits.join(' · ');
  pickReason(info.reasons);
  renderChips();
  renderPassButtons();
  renderRecent();
  $('#gateView').classList.remove('hidden');
  breathLeftMs = info.breath * 1000;
  startBreathing();
  $('#intention').focus();
}

function renderChips() {
  const wrap = $('#chips');
  for (const s of SUGGESTIONS) {
    wrap.append(el('button', { type: 'button', class: 'chip', text: s, onclick: () => { $('#intention').value = s; updateReady(); $('#intention').focus(); } }));
  }
}

function renderPassButtons() {
  const wrap = $('#passButtons');
  info.passOptions.forEach((m, i) => {
    wrap.append(el('button', {
      type: 'button', class: 'btn lg' + (i === 0 ? ' primary' : ''), 'data-min': m, disabled: true,
      onclick: () => grant(m),
    }, `${m} min`));
  });
}

function renderRecent() {
  if (!info.recent.length) return;
  const ul = $('#recent');
  for (const r of info.recent) {
    const what = r.outcome === 'back' ? 'turned back' : `${r.minutes} min`;
    ul.append(el('li', {}, el('span', { text: r.text || '(no intention)' }), el('span', { text: `${new Date(r.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtHourMin(r.ts)} · ${what}` })));
  }
  $('#recentWrap').classList.remove('hidden');
}

function startBreathing() {
  const orb = $('#orb');
  let last = performance.now();
  let phaseStart = 0;
  let inhale = true;
  orb.classList.add('inhale');
  const step = now => {
    const dt = now - last;
    last = now;
    if (!document.hidden) {
      breathLeftMs -= dt;
      phaseStart += dt;
      if (phaseStart >= 4000) {
        phaseStart = 0;
        inhale = !inhale;
        orb.classList.toggle('inhale', inhale);
      }
    }
    if (breathLeftMs <= 0) {
      breathDone = true;
      orb.classList.remove('inhale');
      orb.classList.add('done');
      $('#breathCue').textContent = 'Ready when you are';
      $('#breathLeft').textContent = info.visitsToday ? `Pauses get longer with each visit today.` : '';
      updateReady();
      return;
    }
    $('#breathCue').textContent = inhale ? 'Breathe in' : 'Breathe out';
    $('#breathLeft').textContent = `${Math.ceil(breathLeftMs / 1000)}s pause${document.hidden ? ' (paused while hidden)' : ''}`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // rAF does not run in background tabs; the timer intentionally stops there too.
}

function intentionOk() {
  return $('#intention').value.trim().length >= (info ? info.minIntention : 3);
}

function updateReady() {
  const ready = breathDone && intentionOk();
  for (const b of document.querySelectorAll('#passButtons .btn')) b.disabled = !ready || busy;
  $('#passHint').textContent = !breathDone
    ? 'The buttons unlock after your pause.'
    : intentionOk() ? 'Your pass starts now. You will be asked again when it ends.' : 'Write your intention to continue.';
}

async function grant(minutes) {
  if (busy || !breathDone || !intentionOk()) return;
  busy = true;
  updateReady();
  try {
    await send('grantPass', { url: target, minutes, intention: $('#intention').value.trim() });
    location.replace(target);
  } catch (e) {
    busy = false;
    updateReady();
    toast(e.message, true);
    if (/hard blocked/.test(e.message)) setTimeout(() => location.reload(), 1200);
  }
}

async function turnBack() {
  try { await send('turnBack', { url: target, intention: $('#intention').value.trim() }); } catch { /* still leave */ }
  showLeft(true);
}

function showLeft(fromGate = false) {
  $('#gateView').classList.add('hidden');
  $('#leftView').classList.remove('hidden');
  document.title = 'Good call - Mindful Gate';
  const host = (() => { try { return new URL(target).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  if (host) $('#leftText').innerHTML = `You chose your time over <strong>${escapeHtml(host)}</strong>. That counts.`;
  if (!info) send('getState').then(s => pickReason(s.settings.reasons)).catch(() => pickReason([]));
  if (fromGate && history.length > 1) {
    $('#leftText').append(' Taking you back...');
    setTimeout(() => history.back(), 1400);
  }
  $('#closeBtn').focus();
}

$('#intention').addEventListener('input', updateReady);
$('#intention').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (breathDone && intentionOk() && info) grant(info.passOptions[0]);
  }
});
$('#intentForm').addEventListener('submit', e => e.preventDefault());
$('#backBtn').addEventListener('click', turnBack);
$('#closeBtn').addEventListener('click', () => send('closeTab').catch(() => window.close()));

init().catch(e => toast(e.message, true));
