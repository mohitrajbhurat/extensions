// Recording building blocks shared by the offscreen document (tab capture)
// and the recorder page (window / screen capture).
import { putRecording, newId } from './db.js';
import { fixWebmDuration } from './webm-duration.js';

export function pickMimeType(hasAudio) {
  const candidates = hasAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/** Interval timer that keeps running in hidden pages (worker based, with fallback). */
export function createTicker(intervalMs, cb) {
  let worker = null;
  let fallback = null;
  try {
    worker = new Worker(new URL('./ticker-worker.js', import.meta.url));
    worker.onmessage = () => {
      try { cb(); } finally { if (worker) worker.postMessage({ cmd: 'ack' }); }
    };
    worker.postMessage({ cmd: 'start', interval: intervalMs });
  } catch {
    fallback = setInterval(cb, intervalMs);
  }
  return () => {
    if (worker) { const w = worker; worker = null; w.postMessage({ cmd: 'stop' }); w.terminate(); }
    if (fallback) clearInterval(fallback);
  };
}

/** Mixes any number of audio streams into one track. */
export class AudioMixer {
  constructor() {
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    this.inputs = 0;
    this.ctx.resume().catch(() => {});
  }
  add(stream, { monitor = false, gain = 1 } = {}) {
    if (!stream || !stream.getAudioTracks().length) return null;
    const src = this.ctx.createMediaStreamSource(stream);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.dest);
    if (monitor) src.connect(this.ctx.destination); // keep the captured tab audible
    this.inputs++;
    return g;
  }
  meter(stream) {
    if (!stream || !stream.getAudioTracks().length) return null;
    const src = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    return () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 100);
    };
  }
  get track() { return this.inputs ? this.dest.stream.getAudioTracks()[0] : null; }
  close() { this.ctx.close().catch(() => {}); }
}

/** Wraps MediaRecorder with pause-aware elapsed time and duration-fixed output. */
export class RecordingSession {
  constructor(stream, { onError } = {}) {
    this.stream = stream;
    this.hasAudio = stream.getAudioTracks().length > 0;
    this.mimeType = pickMimeType(this.hasAudio);
    const settings = stream.getVideoTracks()[0]?.getSettings() || {};
    this.width = settings.width || 0;
    this.height = settings.height || 0;
    const pixels = (this.width || 1920) * (this.height || 1080);
    const videoBitsPerSecond = Math.round(Math.min(12e6, Math.max(2.5e6, pixels * 30 * 0.09)));
    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType || undefined,
      videoBitsPerSecond,
      audioBitsPerSecond: 128000,
    });
    this.chunks = [];
    this.accumulated = 0;
    this.resumedAt = 0;
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onerror = e => onError && onError(e.error || new Error('Recorder error'));
  }
  start() {
    this.recorder.start(1000);
    this.resumedAt = performance.now();
  }
  get state() { return this.recorder.state; }
  get elapsed() {
    return this.accumulated + (this.recorder.state === 'recording' ? performance.now() - this.resumedAt : 0);
  }
  pause() {
    if (this.recorder.state !== 'recording') return;
    this.recorder.pause();
    this.accumulated += performance.now() - this.resumedAt;
  }
  resume() {
    if (this.recorder.state !== 'paused') return;
    this.recorder.resume();
    this.resumedAt = performance.now();
  }
  stop() {
    return new Promise(resolve => {
      const durationMs = this.elapsed;
      const finish = async () => {
        const type = (this.mimeType || 'video/webm').split(';')[0];
        const raw = new Blob(this.chunks, { type });
        this.chunks = [];
        resolve({ blob: await fixWebmDuration(raw, durationMs), durationMs });
      };
      if (this.recorder.state === 'inactive') { finish(); return; }
      this.recorder.addEventListener('stop', finish, { once: true });
      this.recorder.stop();
    });
  }
  cancel() {
    this.recorder.ondataavailable = null;
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.chunks = [];
  }
}

/** Draws a video element or canvas into a small JPEG thumbnail. */
export async function makeThumb(source, maxWidth = 480) {
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  if (!w || !h) return null;
  const scale = Math.min(1, maxWidth / w);
  const c = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

/** Waits until a <video> has decoded its first frame. */
export function videoReady(video, timeout = 4000) {
  return new Promise(resolve => {
    if (video.readyState >= 2 && video.videoWidth) return resolve(true);
    const t = setTimeout(() => resolve(false), timeout);
    video.addEventListener('loadeddata', () => { clearTimeout(t); resolve(true); }, { once: true });
  });
}

export async function saveRecording({ blob, durationMs, name, mode, width, height, hasAudio, thumb }) {
  const id = newId('r');
  await putRecording({
    id, created: Date.now(), name, durationMs, size: blob.size,
    mimeType: blob.type, width, height, mode, hasAudio, thumb: thumb || null,
  }, blob);
  return id;
}
