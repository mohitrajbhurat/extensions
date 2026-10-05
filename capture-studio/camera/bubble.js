// Webcam preview shown inside the page during tab recordings (captured with the tab).
const params = new URLSearchParams(location.search);
const camId = params.get('cam');
const video = document.getElementById('cam');
const msg = document.getElementById('msg');

async function run() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 640 }, height: { ideal: 640 } },
      audio: false,
    });
    video.srcObject = stream;
    window.addEventListener('pagehide', () => stream.getTracks().forEach(t => t.stop()));
  } catch (e) {
    msg.textContent = 'Camera unavailable';
    msg.hidden = false;
    video.hidden = true;
  }
}
if (camId !== null) run();
