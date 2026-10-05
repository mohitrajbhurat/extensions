// Dedicated worker timer: unlike page timers, it is not throttled when the tab is hidden.
let timer = null;
self.onmessage = e => {
  const { cmd, interval } = e.data || {};
  clearInterval(timer);
  timer = null;
  if (cmd === 'start') timer = setInterval(() => self.postMessage('tick'), Math.max(4, interval || 1000));
};
