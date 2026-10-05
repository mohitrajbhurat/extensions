// Hosts the palette in the toolbar popup, or in a small window when the current page
// cannot be scripted (chrome:// pages, the Web Store, PDF viewer...).
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'window' ? 'window' : 'popup';
  const tabId = Number(params.get('tab')) || null;
  document.body.classList.add(mode);

  const style = document.createElement('style');
  style.textContent = CommandPaletteUI.CSS.replace(':host { all: initial; }', '');
  document.head.appendChild(style);

  let closing = false;
  async function close(result) {
    if (closing) return;
    closing = true;
    result = result || {};
    if (result.pageOp) {
      const r = await chrome.runtime.sendMessage({ type: 'pageOp', op: result.pageOp, ctx: { tabId } });
      if (r && r.error) { closing = false; ui.toast(r.error, true); return; }
    }
    if (result.toast) {
      ui.toast(result.toast);
      await new Promise(r => setTimeout(r, 700));
    }
    window.close();
  }

  const ui = CommandPaletteUI.mount(document.getElementById('app'), {
    mode,
    ctx: tabId ? { tabId } : null,
    send: msg => chrome.runtime.sendMessage(msg),
    close,
  });

  if (mode === 'window') {
    // Behave like a spotlight window: dismiss when it loses focus.
    let blurTimer = null;
    window.addEventListener('blur', () => { blurTimer = setTimeout(() => { if (!document.hasFocus() && !closing) window.close(); }, 250); });
    window.addEventListener('focus', () => clearTimeout(blurTimer));
  }
})();
