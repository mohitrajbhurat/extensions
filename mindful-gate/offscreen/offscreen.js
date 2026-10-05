import { playChime } from '../lib/chime.js';

let closeTimer = null;
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'play') {
    clearTimeout(closeTimer);
    playChime(msg.kind, msg.volume).finally(() => {
      sendResponse({ ok: true });
      // Close the document after a quiet minute to free resources.
      closeTimer = setTimeout(() => window.close(), 60000);
    });
    return true;
  }
  return false;
});
