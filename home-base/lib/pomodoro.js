// Pure pomodoro state machine. State lives in storage so the new tab, popup and worker agree.
// state: { mode: 'work'|'short'|'long', running, endsAt (ms), remaining (ms, when paused), cycle, day, doneToday }

export const MODE_NAMES = { work: 'Focus', short: 'Short break', long: 'Long break' };

export function duration(mode, cfg) {
  const min = mode === 'work' ? cfg.work : mode === 'short' ? cfg.short : cfg.long;
  return Math.max(1, Math.min(180, Number(min) || 25)) * 60000;
}

export function remainingMs(state, cfg, now = Date.now()) {
  if (state.running) return Math.max(0, state.endsAt - now);
  return state.remaining > 0 ? state.remaining : duration(state.mode, cfg);
}

export function start(state, cfg, now = Date.now()) {
  if (state.running) return state;
  const rem = remainingMs(state, cfg, now);
  return { ...state, running: true, endsAt: now + rem, remaining: rem };
}

export function pause(state, cfg, now = Date.now()) {
  if (!state.running) return state;
  return { ...state, running: false, remaining: Math.max(1000, state.endsAt - now), endsAt: 0 };
}

export function reset(state, cfg) {
  return { ...state, running: false, endsAt: 0, remaining: duration(state.mode, cfg) };
}

export function setMode(state, mode, cfg) {
  return { ...state, mode, running: false, endsAt: 0, remaining: duration(mode, cfg) };
}

/** Move to the next phase. `completed` counts a finished focus session. */
export function advance(state, cfg, today, now = Date.now(), completed = true) {
  const s = { ...state };
  if (s.day !== today) { s.day = today; s.doneToday = 0; }
  let next;
  if (s.mode === 'work') {
    if (completed) { s.doneToday += 1; s.cycle = (s.cycle || 0) + 1; }
    const every = Math.max(2, Number(cfg.every) || 4);
    next = s.cycle > 0 && s.cycle % every === 0 ? 'long' : 'short';
  } else next = 'work';
  s.mode = next;
  s.remaining = duration(next, cfg);
  s.running = !!cfg.autoStart;
  s.endsAt = s.running ? now + s.remaining : 0;
  return s;
}

/** True when a running timer has reached zero. */
export function isDue(state, now = Date.now()) {
  return !!state.running && state.endsAt > 0 && state.endsAt <= now + 500;
}

export function fmt(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
