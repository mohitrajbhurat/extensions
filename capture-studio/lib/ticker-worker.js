// Dedicated worker timer: unlike page timers, it is not throttled when the tab is hidden.
// The next tick is only scheduled after the page acknowledges the previous one, so a
// slow callback can never build up a backlog of queued ticks.
let interval = 1000;
let timer = null;
let running = false;
let last = 0;

function schedule() {
  clearTimeout(timer);
  if (!running) return;
  const wait = Math.max(0, last + interval - performance.now());
  timer = setTimeout(() => { last = performance.now(); self.postMessage('tick'); }, wait);
}

self.onmessage = e => {
  const { cmd, interval: ms } = e.data || {};
  if (cmd === 'start') {
    interval = Math.max(4, ms || 1000);
    running = true;
    last = performance.now();
    schedule();
  } else if (cmd === 'ack') {
    schedule();
  } else if (cmd === 'stop') {
    running = false;
    clearTimeout(timer);
  }
};
