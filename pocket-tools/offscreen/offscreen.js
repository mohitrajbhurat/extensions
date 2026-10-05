// Offscreen document: writes to and clears the clipboard while no extension
// page is open (service workers have no DOM clipboard access).

let clearTimer = null;

function writeClipboard(text) {
  // A copy-event handler lets us place any text, including an empty string.
  const onCopy = e => {
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  const buffer = document.getElementById('buffer');
  buffer.value = text || ' ';
  buffer.select();
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  buffer.value = '';
  return ok;
}

function schedule(ms) {
  clearTimeout(clearTimer);
  clearTimer = null;
  if (ms > 0) {
    clearTimer = setTimeout(() => {
      writeClipboard('');
      clearTimer = null;
      chrome.runtime.sendMessage({ type: 'offscreen:idle' }).catch(() => {});
    }, ms);
  } else {
    chrome.runtime.sendMessage({ type: 'offscreen:idle' }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'copy') {
    const ok = writeClipboard(String(msg.text || ''));
    schedule(msg.clearAfterMs || 0);
    sendResponse({ ok });
  } else if (msg.type === 'schedule-clear') {
    schedule(msg.clearAfterMs || 0);
    sendResponse({ ok: true });
  }
  return false;
});
