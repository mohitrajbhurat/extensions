// Offscreen document: parses fetched HTML with DOMParser and plays alert sounds.
const { extract } = globalThis.PageWatchExtract;

function parseAndExtract(html, url, selector) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (url && doc.head && !doc.querySelector('base')) {
    const base = doc.createElement('base');
    base.href = url;
    doc.head.prepend(base);
  }
  return extract(doc, selector || '');
}

let audioCtx = null;

/** Synthesize a short alert so no audio files are needed. */
async function playSound(kind = 'chime', volume = 0.6) {
  audioCtx = audioCtx || new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
  const ctx = audioCtx;
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0.6)) * 0.4;
  gain.connect(ctx.destination);
  const patterns = {
    chime: [[880, 0, 0.18], [1318.5, 0.16, 0.35]],
    bell: [[660, 0, 0.6], [990, 0, 0.6]],
    alert: [[740, 0, 0.12], [740, 0.18, 0.12], [740, 0.36, 0.12]],
  };
  const notes = patterns[kind] || patterns.chime;
  const t0 = ctx.currentTime + 0.02;
  let end = t0;
  for (const [freq, at, dur] of notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = kind === 'alert' ? 'square' : 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, t0 + at);
    env.gain.exponentialRampToValueAtTime(1, t0 + at + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(env).connect(gain);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
    end = Math.max(end, t0 + at + dur + 0.05);
  }
  await new Promise((r) => setTimeout(r, (end - ctx.currentTime) * 1000 + 50));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'extract') {
    try {
      sendResponse(parseAndExtract(msg.html, msg.url, msg.selector));
    } catch (e) {
      sendResponse({ fatal: 'Could not parse page: ' + (e && e.message ? e.message : e) });
    }
    return false;
  }
  if (msg.type === 'play-sound') {
    playSound(msg.sound, msg.volume).then(() => sendResponse({ ok: true }), (e) => sendResponse({ fatal: String(e) }));
    return true;
  }
  return false;
});
