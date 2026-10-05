import { send, fmtClock, fmtHourMin, hostOf } from '../lib/core.js';
import { $, toast, targetFromLocation, param, el } from '../lib/ui.js';

const target = targetFromLocation();
const reason = param('r');
const groupId = param('g');
let info = null;
let until = 0;
let snoozeReadyAt = 0;

async function load() {
  info = await send('blockInfo', { groupId, reason, url: target });
  render();
}

function render() {
  const b = info.blocked;
  const host = hostOf(target);
  if (!b) return showEnded();
  until = b.until;
  const isFocus = b.reason === 'focus';
  $('#kind').textContent = isFocus ? 'Focus session' : 'Scheduled block';
  $('#title').textContent = isFocus ? 'Stay with it.' : 'Not right now.';
  $('#why').textContent = isFocus
    ? `${host || 'This site'} is blocked while you focus. Your break comes soon.`
    : `${host || 'This site'} is blocked by your "${b.group}" schedule until ${fmtHourMin(b.until)}.`;
  $('#clockLabel').textContent = isFocus ? 'left in this focus session' : 'until the schedule ends';
  if (isFocus && info.focus.task) {
    $('#task').textContent = `Working on: ${info.focus.task}`;
    $('#task').classList.remove('hidden');
  }
  $('#strictNote').classList.toggle('hidden', !b.strict);
  const canSnooze = info.canSnooze;
  $('#snooze').classList.toggle('hidden', !canSnooze);
  const list = $('#reasons');
  list.textContent = '';
  const reasons = info.reasons.length ? info.reasons : ['Your attention is worth protecting.'];
  for (const r of reasons) list.append(el('li', { text: r }));
  document.title = `${isFocus ? 'Focus' : 'Blocked'}: ${host || 'site'} - Mindful Gate`;
  tick();
}

function showEnded() {
  $('#clockWrap').classList.add('hidden');
  $('#snooze').classList.add('hidden');
  $('#strictNote').classList.add('hidden');
  $('#kind').textContent = 'Unblocked';
  $('#title').textContent = 'You made it through.';
  $('#why').textContent = 'The block is over.';
  if (target) {
    $('#ended').classList.remove('hidden');
    $('#continueBtn').href = target;
  }
  if (info && info.reasons) {
    const list = $('#reasons');
    list.textContent = '';
    for (const r of info.reasons) list.append(el('li', { text: r }));
  }
}

function tick() {
  if (!until) return;
  const left = until - Date.now();
  $('#clock').textContent = left > 3600000
    ? `${Math.floor(left / 3600000)}:${String(Math.floor(left / 60000) % 60).padStart(2, '0')}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`
    : fmtClock(left);
  if (left <= 0) { until = 0; setTimeout(load, 1500); }
  if (snoozeReadyAt) {
    const s = Math.ceil((snoozeReadyAt - Date.now()) / 1000);
    const btn = $('#snoozeBtn');
    if (s > 0) { btn.textContent = `Wait ${s}s`; btn.disabled = true; }
    else { btn.textContent = 'Snooze 5 minutes'; btn.disabled = $('#snoozeWhy').value.trim().length < 10; }
  }
}

$('#backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else send('closeTab').catch(() => window.close());
});

$('#snooze').addEventListener('toggle', () => {
  if ($('#snooze').open && !snoozeReadyAt) snoozeReadyAt = Date.now() + 30000;
});
$('#snoozeWhy').addEventListener('input', tick);
$('#snoozeBtn').addEventListener('click', async () => {
  try {
    await send('snooze', { groupId: (info.blocked && info.blocked.groupId) || groupId, intention: $('#snoozeWhy').value.trim() });
    location.replace(target || '../dashboard/dashboard.html');
  } catch (e) { toast(e.message, true); }
});

// Record the blocked visit once per page load.
if (target && !sessionStorage.getItem('mg-hit:' + target)) {
  try { sessionStorage.setItem('mg-hit:' + target, '1'); } catch { /* ignore */ }
  send('blockHit').catch(() => {});
}

load().catch(e => toast(e.message, true));
setInterval(tick, 1000);
setInterval(() => load().catch(() => {}), 15000);
