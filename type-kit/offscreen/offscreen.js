/* Offscreen document: reads the system clipboard for the {clipboard} placeholder.
 * Only created when the user granted the optional clipboardRead permission. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'tk-offscreen') return false;
  if (msg.type === 'read-clipboard') {
    const ta = document.getElementById('buf');
    ta.value = '';
    ta.focus();
    let ok = false;
    try { ok = document.execCommand('paste'); } catch (e) { ok = false; }
    sendResponse({ text: ok ? ta.value : null });
    ta.value = '';
  }
  return false;
});
