// Requests microphone / camera access for the extension origin, so the offscreen
// recorder and the in-page webcam bubble can use them later without a prompt.
const params = new URLSearchParams(location.search);
const need = (params.get('need') || 'mic,cam').split(',').filter(Boolean);
const wantMic = need.includes('mic');
const wantCam = need.includes('cam');
document.getElementById('row-mic').hidden = !wantMic;
document.getElementById('row-cam').hidden = !wantCam;

const labels = { granted: 'Allowed', denied: 'Blocked', prompt: 'Not yet allowed' };
async function refresh() {
  for (const [name, el] of [['microphone', 'st-mic'], ['camera', 'st-cam']]) {
    try {
      const st = await navigator.permissions.query({ name });
      const node = document.getElementById(el);
      node.textContent = labels[st.state] || st.state;
      node.className = 'state ' + st.state;
    } catch { /* permissions API unavailable */ }
  }
}

document.getElementById('grant').addEventListener('click', async () => {
  const result = document.getElementById('result');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: wantMic, video: wantCam });
    if (wantCam) {
      const v = document.getElementById('preview');
      v.srcObject = stream;
      v.hidden = false;
      v.play().catch(() => {});
    }
    setTimeout(() => stream.getTracks().forEach(t => t.stop()), wantCam ? 2500 : 0);
    result.textContent = 'Access granted. Click the Capture Studio toolbar button on the tab you want to record and start again.';
  } catch (e) {
    result.textContent = e.name === 'NotAllowedError'
      ? 'Access was blocked. Click the icon at the left of the address bar, allow Camera and Microphone for this extension, then try again.'
      : 'Could not access the device: ' + e.message;
  }
  refresh();
});
refresh();
