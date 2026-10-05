// Records the price when the user visits a tracked product page normally.
// Registered dynamically only for stores the user granted access to.
(() => {
  'use strict';
  if (window.top !== window || window.__priceTrackerVisit) return;
  window.__priceTrackerVisit = true;

  let lastUrl = null;
  let timer = null;

  function canonical() {
    const el = document.querySelector('link[rel="canonical"]');
    try { return el ? new URL(el.getAttribute('href'), location.href).href : null; } catch (_) { return null; }
  }

  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          void chrome.runtime.lastError;
          resolve(res && res.ok ? res.result : null);
        });
      } catch (_) { resolve(null); } // extension reloaded
    });
  }

  async function run() {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    clearTimeout(timer);
    const tracked = await send({ type: 'visit', url, canonical: canonical() });
    if (!tracked) return;
    let attempt = 0;
    const tryDetect = () => {
      if (location.href !== url) return;
      const product = globalThis.PriceDetect.detectProduct(document, url, { selector: tracked.selector });
      if (product.price == null && attempt < 5) {
        attempt++;
        timer = setTimeout(tryDetect, 1200 * attempt); // late-rendering storefronts
        return;
      }
      if (product.price != null || product.availability !== 'unknown') {
        send({ type: 'observe', id: tracked.id, url, product, via: 'visit' });
      }
    };
    tryDetect();
  }

  run();
  // Single-page storefronts change URL without reloading.
  setInterval(() => { if (location.href !== lastUrl) run(); }, 2000);
  window.addEventListener('popstate', () => setTimeout(run, 300));
})();
