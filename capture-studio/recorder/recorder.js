// Window / full-screen recorder (getDisplayMedia). Mixes microphone and system audio
// and composites a draggable webcam bubble into the video through a canvas.
import { AudioMixer, RecordingSession, createTicker, makeThumb, saveRecording, videoReady } from '../lib/recorder-core.js';
import { formatDuration, timestampName } from '../lib/util.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEFAULTS = { mic: true, tabAudio: true, webcam: false, camSize: 'medium', countdown: 3, micId: '', camId: '' };
const SIZE_MAP = { small: 0.1, medium: 0.15, large: 0.22 };
const MAX_COMPOSITE_W = 1920;
const MAX_COMPOSITE_H = 1080;

let opts = { ...DEFAULTS };
let mode = params.get('mode') === 'screen' ? 'screen' : 'window';
let ctx = null; // live recording context

const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = msg => chrome.runtime.sendMessage(msg).catch(() => undefined);

/* ---------------- setup UI ---------------- */
async function initSetup() {
  try { opts = { ...DEFAULTS, ...((await chrome.storage.local.get('recOptions')).recOptions || {}) }; } catch { /* defaults */ }
  document.querySelector(`input[name=mode][value="${mode}"]`).checked = true;
  $('opt-mic').checked = !!opts.mic;
  $('opt-audio').checked = !!opts.tabAudio;
  $('opt-cam').checked = !!opts.webcam;
  $('opt-countdown').value = String(opts.countdown);
  $('cam-size').value = String(SIZE_MAP[opts.camSize] || 0.15);
  await fillDevices();
  syncSetup();
}

function syncSetup() {
  $('share').textContent = mode === 'screen' ? 'Choose screen to share' : 'Choose window to share';
  $('mic-device').hidden = !opts.mic;
  $('cam-device').hidden = !opts.webcam;
}

async function fillDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const fill = (select, kind, current, fallback) => {
    select.innerHTML = '';
    select.appendChild(new Option(fallback, ''));
    devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => select.appendChild(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
    select.value = [...select.options].some(o => o.value === current) ? current : '';
  };
  fill($('mic-device'), 'audioinput', opts.micId, 'Default microphone');
  fill($('cam-device'), 'videoinput', opts.camId, 'Default camera');
}

function persist() { chrome.storage.local.set({ recOptions: { ...opts, mode } }).catch(() => {}); syncSetup(); }
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => { mode = r.value; persist(); }));
$('opt-mic').addEventListener('change', e => { opts.mic = e.target.checked; persist(); });
$('opt-audio').addEventListener('change', e => { opts.tabAudio = e.target.checked; persist(); });
$('opt-cam').addEventListener('change', e => { opts.webcam = e.target.checked; persist(); });
$('opt-countdown').addEventListener('change', e => { opts.countdown = Number(e.target.value); persist(); });
$('mic-device').addEventListener('change', e => { opts.micId = e.target.value; persist(); });
$('cam-device').addEventListener('change', e => { opts.camId = e.target.value; persist(); });

function setupError(message) {
  $('setup-error').textContent = message;
  $('setup-error').hidden = !message;
}

/* ---------------- capture ---------------- */
$('share').addEventListener('click', async () => {
  setupError('');
  $('share').disabled = true;
  try {
    await begin();
  } catch (e) {
    teardown();
    showView('setup');
    if (e.name === 'NotAllowedError') setupError('Sharing was cancelled or blocked.');
    else setupError('Could not start recording: ' + e.message);
    send({ type: 'rec-status', mode, state: 'setup', elapsed: 0 });
  } finally {
    $('share').disabled = false;
  }
});

async function begin() {
  // getDisplayMedia must run first, while the click still counts as a user gesture.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: mode === 'screen' ? 'monitor' : 'window', frameRate: { ideal: 30, max: 30 }, width: { max: 3840 }, height: { max: 2160 } },
    audio: opts.tabAudio ? { suppressLocalAudioPlayback: false } : false,
    systemAudio: opts.tabAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
  });
  ctx = { streams: [display], mixer: new AudioMixer(), session: null, cancelled: false, camOn: false, stopTicker: null, stopDraw: null, warnings: [] };
  const me = ctx;
  display.getVideoTracks()[0].addEventListener('ended', () => { if (ctx === me) stop(); });

  let mic = null;
  if (opts.mic) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: opts.micId ? { exact: opts.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ctx.streams.push(mic);
    } catch (e) { ctx.warnings.push('Microphone unavailable (' + e.message + ').'); }
  }
  let cam = null;
  if (opts.webcam) {
    try {
      cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: opts.camId ? { exact: opts.camId } : undefined, width: { ideal: 640 }, height: { ideal: 480 } } });
      ctx.streams.push(cam);
    } catch (e) { ctx.warnings.push('Camera unavailable (' + e.message + ').'); }
  }
  if (me.cancelled) return;
  fillDevices(); // labels are available now that access was granted

  ctx.mixer.add(display);
  if (mic) {
    ctx.mixer.add(mic);
    const level = ctx.mixer.meter(mic);
    $('meter-wrap').hidden = false;
    const tick = () => { if (ctx !== me) return; $('meter').style.width = Math.round(level() * 100) + '%'; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  } else $('meter-wrap').hidden = true;

  const screenVideo = $('screen');
  screenVideo.srcObject = display;
  await screenVideo.play().catch(() => {});
  await videoReady(screenVideo);

  let videoTrack;
  const canvas = $('canvas');
  if (cam) {
    const camVideo = document.createElement('video');
    camVideo.muted = true;
    camVideo.playsInline = true;
    camVideo.srcObject = cam;
    await camVideo.play().catch(() => {});
    ctx.camOn = true;
    ctx.bubble = { x: 0.12, y: 0.82, size: Number($('cam-size').value) };
    setupCompositor(canvas, screenVideo, camVideo);
    videoTrack = canvas.captureStream(30).getVideoTracks()[0];
    canvas.hidden = false;
    screenVideo.hidden = true;
    $('btn-cam').hidden = false;
    $('cam-size').hidden = false;
  } else {
    videoTrack = display.getVideoTracks()[0];
    canvas.hidden = true;
    screenVideo.hidden = false;
    $('btn-cam').hidden = true;
    $('cam-size').hidden = true;
  }
  const tracks = [videoTrack];
  if (ctx.mixer.track) tracks.push(ctx.mixer.track);
  ctx.stream = new MediaStream(tracks);
  ctx.thumbSource = cam ? canvas : screenVideo;

  showView('studio');
  $('studio-hint').textContent = (ctx.warnings.join(' ') + ' ' + (cam ? 'Drag the webcam bubble to move it. ' : '') +
    'You can switch to the window you are recording. Stop from here, from the toolbar button, or with the browser\'s "Stop sharing" bar.').trim();

  // Countdown
  const n = Math.max(0, Math.min(10, opts.countdown || 0));
  for (let i = n; i > 0; i--) {
    if (me.cancelled) return;
    $('countdown').hidden = false;
    $('countdown-n').textContent = i;
    send({ type: 'rec-status', mode, state: 'countdown', n: i, elapsed: 0 });
    await sleep(1000);
  }
  $('countdown').hidden = true;
  if (me.cancelled) return;

  ctx.session = new RecordingSession(ctx.stream, { onError: e => fail(e) });
  ctx.session.start();
  ctx.stopTicker = createTicker(1000, () => report());
  report();
  setTimeout(async () => { if (ctx === me) me.thumb = await makeThumb(me.thumbSource).catch(() => null); }, 700);
}

function setupCompositor(canvas, screenVideo, camVideo) {
  const g = canvas.getContext('2d');
  // Composite at up to 1080p: compositing 4K frames on the main thread is too slow on
  // many machines and would make the page (and the recording) stutter.
  const srcW = screenVideo.videoWidth || 1920;
  const srcH = screenVideo.videoHeight || 1080;
  const fit = Math.min(1, MAX_COMPOSITE_W / srcW, MAX_COMPOSITE_H / srcH);
  const W = Math.max(2, Math.round(srcW * fit / 2) * 2);
  const H = Math.max(2, Math.round(srcH * fit / 2) * 2);
  canvas.width = W;
  canvas.height = H;
  g.imageSmoothingQuality = 'high';
  const me = ctx;

  const draw = () => {
    if (ctx !== me) return;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const vw = screenVideo.videoWidth;
    const vh = screenVideo.videoHeight;
    if (vw && vh) {
      // Keep the output size fixed; letterbox if the shared surface is resized.
      const s = Math.min(W / vw, H / vh);
      const dw = vw * s;
      const dh = vh * s;
      g.drawImage(screenVideo, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    if (me.camOn && camVideo.videoWidth) {
      const r = me.bubble.size * Math.min(W, H);
      const cx = me.bubble.x * W;
      const cy = me.bubble.y * H;
      const cw = camVideo.videoWidth;
      const ch = camVideo.videoHeight;
      const side = Math.min(cw, ch);
      g.save();
      g.shadowColor = 'rgba(0,0,0,.35)';
      g.shadowBlur = r * 0.15;
      g.beginPath();
      g.arc(cx, cy, r + r * 0.04, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.restore();
      g.save();
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.clip();
      // Mirror like a selfie preview.
      g.translate(cx, cy);
      g.scale(-1, 1);
      g.drawImage(camVideo, (cw - side) / 2, (ch - side) / 2, side, side, -r, -r, r * 2, r * 2);
      g.restore();
    }
  };
  // Worker-driven ticks keep drawing even when this tab is in the background.
  me.stopDraw = createTicker(1000 / 30, draw);
  draw();

  // Dragging the bubble on the preview.
  const toCanvas = e => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };
  const hit = p => {
    const r = me.bubble.size * Math.min(W, H);
    const dx = (p.x - me.bubble.x) * W;
    const dy = (p.y - me.bubble.y) * H;
    return me.camOn && dx * dx + dy * dy <= r * r;
  };
  let drag = null;
  canvas.onpointerdown = e => {
    const p = toCanvas(e);
    if (!hit(p)) return;
    drag = { dx: p.x - me.bubble.x, dy: p.y - me.bubble.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  };
  canvas.onpointermove = e => {
    const p = toCanvas(e);
    if (!drag) { canvas.classList.toggle('can-drag', hit(p)); return; }
    const r = me.bubble.size * Math.min(W, H);
    me.bubble.x = Math.min(1 - r / W, Math.max(r / W, p.x - drag.dx));
    me.bubble.y = Math.min(1 - r / H, Math.max(r / H, p.y - drag.dy));
    draw();
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; canvas.classList.remove('dragging'); };
}

$('btn-cam').addEventListener('click', () => {
  if (!ctx) return;
  ctx.camOn = !ctx.camOn;
  $('btn-cam').textContent = ctx.camOn ? 'Hide camera' : 'Show camera';
});
$('cam-size').addEventListener('change', e => {
  if (ctx && ctx.bubble) ctx.bubble.size = Number(e.target.value);
  const name = Object.entries(SIZE_MAP).find(([, v]) => v === Number(e.target.value));
  if (name) { opts.camSize = name[0]; persist(); }
});

/* ---------------- state + controls ---------------- */
function report() {
  if (!ctx || !ctx.session) return;
  const state = ctx.session.state === 'paused' ? 'paused' : 'recording';
  const elapsed = ctx.session.elapsed;
  send({ type: 'rec-status', mode, state, elapsed });
  $('pill').hidden = false;
  $('timer').hidden = false;
  $('pill').classList.toggle('paused', state === 'paused');
  $('pill-text').textContent = state === 'paused' ? 'Paused' : 'Recording';
  $('timer').textContent = formatDuration(elapsed);
  $('btn-pause').firstChild.textContent = state === 'paused' ? 'Resume ' : 'Pause ';
  document.title = `${state === 'paused' ? 'Paused' : 'Recording'} ${formatDuration(elapsed)} - Capture Studio`;
}

function pauseToggle() {
  if (!ctx || !ctx.session) return;
  if (ctx.session.state === 'paused') ctx.session.resume(); else ctx.session.pause();
  report();
}

async function stop() {
  const me = ctx;
  if (!me) return;
  if (!me.session) { cancel(); return; }
  ctx = null;
  me.cancelled = true;
  showView('saving');
  send({ type: 'rec-status', mode, state: 'saving', elapsed: me.session.elapsed });
  try {
    const session = me.session;
    const { blob, durationMs } = await session.stop();
    release(me);
    if (!blob.size) throw new Error('The recording is empty.');
    const id = await saveRecording({
      blob, durationMs, name: timestampName(mode === 'screen' ? 'Screen recording' : 'Window recording'),
      mode, width: session.width, height: session.height, hasAudio: session.hasAudio, thumb: me.thumb,
    });
    await send({ type: 'rec-saved', id });
    location.replace(chrome.runtime.getURL(`library/library.html?play=${id}`));
  } catch (e) {
    release(me);
    send({ type: 'rec-error', message: 'Could not save the recording: ' + e.message });
    showView('setup');
    setupError('Could not save the recording: ' + e.message);
  }
}

function cancel() {
  const me = ctx;
  if (!me) return;
  ctx = null;
  me.cancelled = true;
  if (me.session) me.session.cancel();
  release(me);
  send({ type: 'rec-saved', id: null });
  showView('setup');
  setupError('Recording discarded.');
}

function fail(e) {
  const me = ctx;
  if (!me) return;
  ctx = null;
  me.cancelled = true;
  try { me.session && me.session.cancel(); } catch { /* ignore */ }
  release(me);
  send({ type: 'rec-error', message: 'Recording failed: ' + (e.message || e) });
  showView('setup');
  setupError('Recording failed: ' + (e.message || e));
}

function release(me) {
  if (me.stopTicker) me.stopTicker();
  if (me.stopDraw) me.stopDraw();
  me.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  if (me.stream) me.stream.getTracks().forEach(t => t.stop());
  me.mixer.close();
  $('screen').srcObject = null;
  $('pill').hidden = true;
  $('timer').hidden = true;
  $('countdown').hidden = true;
  document.title = 'Capture Studio - Screen recorder';
}

function teardown() { if (ctx) { const me = ctx; ctx = null; me.cancelled = true; release(me); } }

function showView(name) {
  $('setup').hidden = name !== 'setup';
  $('studio').hidden = name !== 'studio';
  $('saving').hidden = name !== 'saving';
}

$('btn-pause').addEventListener('click', pauseToggle);
$('btn-stop').addEventListener('click', stop);
$('btn-discard').addEventListener('click', () => { if (confirm('Discard this recording? It will not be saved.')) cancel(); });

document.addEventListener('keydown', e => {
  if (!ctx || !ctx.session) return;
  if (e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); pauseToggle(); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'recorder' || msg.type !== 'control') return false;
  if (msg.action === 'pause' || msg.action === 'resume') { if (ctx && ctx.session && (ctx.session.state === 'paused') === (msg.action === 'resume')) pauseToggle(); }
  else if (msg.action === 'stop') stop();
  else if (msg.action === 'cancel') { if (ctx) cancel(); }
  sendResponse({ ok: true });
  return false;
});

window.addEventListener('beforeunload', e => {
  if (ctx && ctx.session) { e.preventDefault(); e.returnValue = ''; }
});

initSetup();
