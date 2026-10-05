// Pomodoro mini-timer. State lives in storage so it survives closing the tab; the service
// worker moves to the next phase and notifies when time is up.
import { h, icon } from '../../lib/ui.js';
import * as store from '../../lib/store.js';
import * as pomo from '../../lib/pomodoro.js';
import { ymd } from '../../lib/dates.js';

export function mount(frame, app) {
  const time = h('div.pomo-time', { role: 'timer', 'aria-live': 'off' });
  const ring = h('div.pomo-ring', time);
  const modes = h('div.seg', { role: 'tablist', 'aria-label': 'Timer mode' });
  const startBtn = h('button.btn.primary', { type: 'button' });
  const resetBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Reset timer', title: 'Reset' }, icon('reset', 16));
  const skipBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Skip to next phase', title: 'Skip' }, icon('skip', 16));
  const info = h('div.small.muted.pomo-info');
  frame.body.append(h('div.pomo', modes, ring, h('div.row.pomo-controls', resetBtn, startBtn, skipBtn), info));

  const cfg = () => app.state.settings.pomodoro;
  const change = (fn) => store.update('pomodoro', (s) => fn(s, cfg()));

  startBtn.addEventListener('click', () => change((s, c) => (s.running ? pomo.pause(s, c) : pomo.start(s, c))));
  resetBtn.addEventListener('click', () => change((s, c) => pomo.reset(s, c)));
  skipBtn.addEventListener('click', () => change((s, c) => pomo.advance(s, c, ymd(new Date()), Date.now(), false)));

  let asked = 0;
  function tick() {
    const s = app.state.pomodoro;
    const c = cfg();
    const rem = pomo.remainingMs(s, c);
    const text = pomo.fmt(rem);
    if (time.textContent !== text) time.textContent = text;
    const total = pomo.duration(s.mode, c);
    ring.style.setProperty('--p', String(1 - rem / total));
    if (s.running && document.visibilityState === 'visible') document.title = `${text} · ${pomo.MODE_NAMES[s.mode]}`;
    else if (document.title !== 'New Tab') document.title = 'New Tab';
    if (pomo.isDue(s) && Date.now() - asked > 3000) {
      asked = Date.now();
      chrome.runtime.sendMessage({ type: 'pomodoro:check' }).catch(() => {});
    }
  }

  function render() {
    const s = app.state.pomodoro;
    modes.replaceChildren(...Object.entries(pomo.MODE_NAMES).map(([m, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(s.mode === m),
      onclick: () => change((st, c) => pomo.setMode(st, m, c)),
    }, label)));
    startBtn.replaceChildren(icon(s.running ? 'pause' : 'play', 14), s.running ? 'Pause' : 'Start');
    ring.dataset.mode = s.mode;
    const today = ymd(new Date());
    const done = s.day === today ? s.doneToday : 0;
    info.textContent = `${done} focus session${done === 1 ? '' : 's'} today`;
    tick();
  }
  render();
  const timer = setInterval(tick, 500);
  return { keys: ['pomodoro', 'settings'], update: render, destroy: () => clearInterval(timer) };
}
