// WebAudio chimes for the focus timer. No audio files: tones are synthesized.

const PATTERNS = {
  // [frequency Hz, start offset s, duration s]
  start: [[523.25, 0, 0.35], [659.25, 0.12, 0.45]],
  done: [[659.25, 0, 0.5], [783.99, 0.18, 0.5], [1046.5, 0.36, 0.9]],
  break: [[783.99, 0, 0.5], [587.33, 0.2, 0.8]],
};

let ctx = null;

export async function playChime(kind = 'done', volume = 0.6) {
  const AC = self.AudioContext || self.webkitAudioContext;
  if (!AC) return;
  ctx = ctx || new AC();
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* autoplay */ } }
  const notes = PATTERNS[kind] || PATTERNS.done;
  const master = ctx.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.5;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  let end = t0;
  for (const [freq, at, dur] of notes) {
    for (const [mult, amp] of [[1, 1], [2, 0.25], [3.01, 0.08]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const s = t0 + at;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(amp, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur + 0.6);
      osc.connect(g).connect(master);
      osc.start(s);
      osc.stop(s + dur + 0.7);
      end = Math.max(end, s + dur + 0.7);
    }
  }
  return new Promise(r => setTimeout(r, (end - ctx.currentTime) * 1000));
}
