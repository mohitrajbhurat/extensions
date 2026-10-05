// Offscreen document: records the current tab via chrome.tabCapture stream id,
// mixing tab audio (kept audible) with the microphone.
import { AudioMixer, RecordingSession, createTicker, makeThumb, saveRecording, videoReady } from '../lib/recorder-core.js';
import { timestampName } from '../lib/util.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let current = null; // { session, streams, mixer, stopTicker, cancelled, title, thumb }

function send(msg) { return chrome.runtime.sendMessage(msg).catch(() => undefined); }

function status(extra) {
  const s = current && current.session;
  send({ type: 'rec-status', mode: 'tab', elapsed: s ? s.elapsed : 0, ...extra });
}

async function start({ streamId, opts, title }) {
  if (current) throw new Error('Already recording.');
  const streams = [];
  const constraints = {
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 } },
  };
  if (opts.tabAudio) constraints.audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  const tabStream = await navigator.mediaDevices.getUserMedia(constraints);
  streams.push(tabStream);

  const mixer = new AudioMixer();
  if (opts.tabAudio) mixer.add(tabStream, { monitor: true });
  let warning = null;
  if (opts.mic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: opts.micId ? { exact: opts.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streams.push(mic);
      mixer.add(mic);
    } catch (e) {
      warning = 'Microphone unavailable: ' + e.message;
    }
  }
  const tracks = [tabStream.getVideoTracks()[0]];
  if (mixer.track) tracks.push(mixer.track);
  const stream = new MediaStream(tracks);

  const preview = document.getElementById('preview');
  preview.srcObject = tabStream;
  preview.play().catch(() => {});

  current = { streams, mixer, session: null, stopTicker: null, cancelled: false, title, warning };
  const me = current;
  tabStream.getVideoTracks()[0].addEventListener('ended', () => { if (current === me) stop(); });

  // Countdown and start run after we reply, so the popup is not blocked.
  (async () => {
    const n = Math.max(0, Math.min(10, Number(opts.countdown) || 0));
    for (let i = n; i > 0; i--) {
      if (me.cancelled) return;
      send({ type: 'rec-status', mode: 'tab', state: 'countdown', n: i, elapsed: 0 });
      await sleep(1000);
    }
    if (me.cancelled) return;
    if (n) { await send({ type: 'rec-countdown-done' }); await sleep(120); }
    if (me.cancelled) return;
    try {
      me.session = new RecordingSession(stream, { onError: e => fail(e) });
      me.session.start();
    } catch (e) { fail(e); return; }
    status({ state: 'recording' });
    me.stopTicker = createTicker(1000, () => { if (me.session) status({ state: me.session.state === 'paused' ? 'paused' : 'recording' }); });
    if (await videoReady(preview)) me.thumb = await makeThumb(preview).catch(() => null);
  })();
  return { ok: true, warning };
}

function release(rec) {
  if (rec.stopTicker) rec.stopTicker();
  for (const s of rec.streams) s.getTracks().forEach(t => t.stop());
  rec.mixer.close();
  const preview = document.getElementById('preview');
  preview.srcObject = null;
}

async function stop() {
  const rec = current;
  if (!rec) return;
  if (!rec.session) { // stopped during countdown
    rec.cancelled = true;
    current = null;
    release(rec);
    send({ type: 'rec-saved', id: null });
    return;
  }
  current = null;
  rec.cancelled = true;
  send({ type: 'rec-status', mode: 'tab', state: 'saving', elapsed: rec.session.elapsed });
  try {
    const session = rec.session;
    const { blob, durationMs } = await session.stop();
    release(rec);
    if (!blob.size) throw new Error('The recording is empty.');
    const id = await saveRecording({
      blob, durationMs, name: rec.title ? `${rec.title}`.slice(0, 80) : timestampName('Recording'),
      mode: 'tab', width: session.width, height: session.height, hasAudio: session.hasAudio, thumb: rec.thumb,
    });
    send({ type: 'rec-saved', id });
  } catch (e) {
    release(rec);
    send({ type: 'rec-error', message: 'Could not save the recording: ' + e.message });
  }
}

function cancel() {
  const rec = current;
  if (!rec) return;
  current = null;
  rec.cancelled = true;
  if (rec.session) rec.session.cancel();
  release(rec);
  send({ type: 'rec-saved', id: null });
}

function fail(e) {
  const rec = current;
  if (!rec) return;
  current = null;
  rec.cancelled = true;
  try { rec.session && rec.session.cancel(); } catch { /* ignore */ }
  release(rec);
  send({ type: 'rec-error', message: 'Recording failed: ' + (e.message || e) });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg).then(sendResponse, e => sendResponse({ error: 'Could not capture the tab: ' + e.message }));
    return true;
  }
  if (msg.type === 'control') {
    const s = current && current.session;
    if (msg.action === 'pause' && s) { s.pause(); status({ state: 'paused' }); }
    else if (msg.action === 'resume' && s) { s.resume(); status({ state: 'recording' }); }
    else if (msg.action === 'stop') stop();
    else if (msg.action === 'cancel') cancel();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
