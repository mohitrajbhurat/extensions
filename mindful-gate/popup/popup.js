import { send, fmtClock, fmtDuration, fmtHourMin, dayKey, emptyDay } from '../lib/core.js';
import { $, toast, el } from '../lib/ui.js';

const CIRC = 2 * Math.PI * 52;
let state = null;
let tab = null;

async function refresh() {
  state = await send('getState');
  renderFocus();
  await renderSite();
  await renderToday();
}

function phaseName(p) {
  return p === 'work' ? 'Focus' : p === 'short' ? 'Short break' : p === 'long' ? 'Long break' : 'Ready to focus';
}

function renderFocus() {
  const f = state.focus;
  const p = state.settings.pomodoro;
  const card = $('#focusCard');
  card.classList.toggle('idle', f.phase === 'idle');
  card.classList.toggle('break', f.phase === 'short' || f.phase === 'long');
  const dots = $('#dots');
  dots.textContent = '';
  const done = (f.cycle || 0) % Math.max(1, p.cycles);
  const filled = f.phase === 'long' ? p.cycles : done;
  for (let i = 0; i < p.cycles; i++) dots.append(el('span', { class: i < filled ? 'on' : '' }));
  dots.setAttribute('aria-label', `${filled} of ${p.cycles} focus sessions in this cycle`);

  if (document.activeElement !== $('#task')) $('#task').value = f.task || '';
  const strictLock = p.strict && f.phase === 'work' && !f.paused;
  const c = $('#controls');
  c.textContent = '';
  const btn = (label, cls, fn, opts = {}) => c.append(el('button', { class: `btn ${cls}`, type: 'button', onclick: fn, disabled: opts.disabled, title: opts.title }, label));
  if (f.phase === 'idle') {
    btn('Start focus', 'focus main', () => act('focusStart', { task: $('#task').value.trim() }));
  } else if (f.paused) {
    btn(f.phase === 'work' ? 'Start focus' : 'Start break', (f.phase === 'work' ? 'focus' : 'primary') + ' main', () => act('focusResume'));
    btn('Skip', '', () => act('focusSkip'));
    btn('Stop', 'ghost', () => act('focusStop'));
  } else {
    const t = strictLock ? 'Strict focus is on' : undefined;
    btn('Pause', 'main', () => act('focusPause'), { disabled: strictLock, title: t });
    btn('Skip', '', () => act('focusSkip'), { disabled: strictLock, title: t });
    btn('Stop', 'ghost', () => act('focusStop'), { disabled: strictLock, title: t });
  }
  const note = $('#focusNote');
  if (f.phase === 'work' && !f.paused) note.textContent = `Distraction sites are blocked until ${fmtHourMin(f.endsAt)}.${strictLock ? ' Strict mode: no stopping early.' : ''}`;
  else if (f.phase === 'idle') note.textContent = `${p.work} min focus · ${p.short} min break · long break every ${p.cycles}`;
  else if (f.paused) note.textContent = f.phase === 'work' ? 'Paused. Sites are not blocked while paused.' : 'Break is ready when you are.';
  else note.textContent = `Break ends at ${fmtHourMin(f.endsAt)}.`;
  tickTimer();
}

function tickTimer() {
  if (!state) return;
  const f = state.focus;
  const p = state.settings.pomodoro;
  let left, total;
  if (f.phase === 'idle') { total = p.work * 60000; left = total; }
  else {
    total = f.duration || 1;
    left = f.paused ? (f.remaining ?? total) : Math.max(0, f.endsAt - Date.now());
  }
  $('#time').textContent = fmtClock(left);
  $('#phaseLabel').textContent = f.phase === 'idle' ? 'Ready to focus' : phaseName(f.phase) + (f.paused ? ' (paused)' : '');
  const frac = f.phase === 'idle' ? 0 : 1 - left / total;
  $('#ringFg').style.strokeDashoffset = String(CIRC * (1 - frac));
}

async function act(type, payload) {
  try {
    await send(type, payload);
    await refresh();
  } catch (e) { toast(e.message, true); }
}

async function renderSite() {
  renderSite.passTick = null;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const actions = $('#siteActions');
  actions.textContent = '';
  const status = $('#siteStatus');
  const detail = $('#siteDetail');
  status.className = 'pill';
  status.classList.remove('hidden');
  let url = tab && tab.url || '';
  // On our own gate/block page, describe the site behind it.
  if (url.startsWith(chrome.runtime.getURL(''))) {
    const m = url.match(/[?&]u=(.*)$/);
    url = m ? m[1] : '';
  }
  const st = url ? await send('tabStatus', { url }) : { trackable: false };
  if (!st.trackable) {
    $('#siteTitle').textContent = 'No website';
    status.textContent = '';
    status.classList.add('hidden');
    detail.textContent = 'Open a website to add it to your distraction list.';
    return;
  }
  $('#siteTitle').textContent = st.domain;
  if (st.blocked) {
    status.textContent = st.blocked.reason === 'focus' ? 'Blocked: focus' : 'Blocked: schedule';
    status.classList.add('focus');
    detail.textContent = `Hard blocked until ${fmtHourMin(st.blocked.until)}${st.blocked.strict ? ' (strict)' : ''}.`;
  } else if (st.pass) {
    status.textContent = 'Pass active';
    status.classList.add('accent');
    const tickPass = () => { detail.textContent = `${fmtClock(st.pass.until - Date.now())} left. Intention: ${st.pass.intention}`; };
    tickPass();
    renderSite.passTick = tickPass;
    actions.append(el('button', { class: 'btn sm', type: 'button', onclick: () => act('endPass', { domain: st.pass.domain }) }, 'End pass now'));
  } else if (st.gated) {
    status.textContent = 'Gated';
    status.classList.add('warn');
    detail.textContent = `In ${st.groups.map(g => g.name).join(', ')}. You will be asked for an intention on your next visit.`;
  } else if (st.listed) {
    status.textContent = 'Listed';
    detail.textContent = `In ${st.groups.map(g => g.name).join(', ')}. Blocked during schedules and focus only.`;
  } else {
    status.textContent = 'Not listed';
    detail.textContent = 'Add this site to make it ask for an intention first.';
    const sel = el('select', { 'aria-label': 'Group' });
    for (const g of state.settings.groups) sel.append(el('option', { value: g.id }, g.name));
    actions.append(sel, el('button', {
      class: 'btn primary sm', type: 'button',
      onclick: async () => {
        try {
          const r = await send('addSite', { domain: st.domain, groupId: sel.value });
          toast(`Added ${r.domain}`);
          await refresh();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Add to list'));
    if (!state.settings.groups.length) sel.remove();
  }
  if (st.listed && !st.blocked) {
    actions.append(el('button', {
      class: 'btn ghost sm danger', type: 'button',
      onclick: async () => {
        try { await send('removeSite', { domain: st.domain }); toast(`Removed ${st.domain}`); await refresh(); }
        catch (e) { toast(e.message, true); }
      },
    }, 'Remove'));
  }
}

async function renderToday() {
  const { stats = {} } = await chrome.storage.local.get('stats');
  const d = { ...emptyDay(), ...(stats[dayKey()] || {}) };
  const distract = Object.values(d.sites).reduce((a, b) => a + b, 0);
  const prompts = Object.values(d.prompts).reduce((a, b) => a + b, 0);
  const back = Object.values(d.turnedBack).reduce((a, b) => a + b, 0);
  $('#statFocus').textContent = fmtDuration(d.focusMinutes * 60);
  $('#statDistract').textContent = fmtDuration(distract);
  $('#statBack').textContent = prompts ? `${back}/${prompts}` : String(back);
}

$('#task').addEventListener('change', () => {
  if (state && state.focus.phase !== 'idle') send('setTask', { task: $('#task').value.trim() }).catch(() => {});
});
$('#task').addEventListener('keydown', e => {
  if (e.key === 'Enter' && state && state.focus.phase === 'idle') act('focusStart', { task: $('#task').value.trim() });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.focus || changes.passes || changes.settings)) refresh().catch(() => {});
});

setInterval(() => {
  tickTimer();
  if (renderSite.passTick) renderSite.passTick();
  if (state && state.focus.phase !== 'idle' && !state.focus.paused && state.focus.endsAt < Date.now() - 1500) refresh().catch(() => {});
}, 1000);

refresh().catch(e => toast(e.message, true));
