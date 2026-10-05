// Trims a recording by replaying the selected range and re-encoding it with MediaRecorder.
import { RecordingSession, createTicker } from '../lib/recorder-core.js';

function once(target, event, errorEvent = 'error') {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('Could not read the video.')); };
    const cleanup = () => { target.removeEventListener(event, ok); target.removeEventListener(errorEvent, bad); };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener(errorEvent, bad, { once: true });
  });
}

/**
 * @param {Blob} blob source WebM
 * @param {number} inS start (seconds)
 * @param {number} outS end (seconds)
 * @param {{hasAudio:boolean,onProgress:(f:number)=>void,signal?:AbortSignal}} options
 * @returns {Promise<{blob:Blob,durationMs:number}>}
 */
export async function trimRecording(blob, inS, outS, { hasAudio = true, onProgress = () => {}, signal } = {}) {
  if (!(outS > inS)) throw new Error('The end point must be after the start point.');
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:16px;height:16px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  let audioCtx = null;
  let stopTicker = null;
  try {
    const meta = once(video, 'loadedmetadata');
    video.src = url;
    await meta;
    let audioTrack = null;
    if (hasAudio) {
      // Route audio into the recording without playing it out loud.
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(dest);
      audioTrack = dest.stream.getAudioTracks()[0];
      await audioCtx.resume().catch(() => {});
    } else {
      video.muted = true;
    }
    const seeked = once(video, 'seeked');
    video.currentTime = inS;
    await seeked;
    const captured = video.captureStream();
    // Video tracks can appear slightly after captureStream() is called.
    let videoTrack = captured.getVideoTracks()[0];
    if (!videoTrack) {
      await new Promise(r => { captured.addEventListener('addtrack', r, { once: true }); setTimeout(r, 1000); });
      videoTrack = captured.getVideoTracks()[0];
    }
    if (!videoTrack) throw new Error('This browser cannot re-encode the video.');
    const stream = new MediaStream([videoTrack, audioTrack].filter(Boolean));
    const session = new RecordingSession(stream);
    session.start();
    await video.play();
    await new Promise((resolve, reject) => {
      const check = () => {
        if (signal && signal.aborted) { reject(new DOMException('Trim cancelled', 'AbortError')); return; }
        const t = video.currentTime;
        onProgress(Math.max(0, Math.min(1, (t - inS) / (outS - inS))));
        if (t >= outS || video.ended) resolve();
      };
      stopTicker = createTicker(30, check);
      video.addEventListener('ended', () => resolve(), { once: true });
    }).catch(e => { session.cancel(); throw e; });
    video.pause();
    const result = await session.stop();
    onProgress(1);
    return result;
  } finally {
    if (stopTicker) stopTicker();
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
    if (audioCtx) audioCtx.close().catch(() => {});
  }
}
