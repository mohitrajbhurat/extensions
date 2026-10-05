// Offscreen document: parses fetched HTML with DOMParser (unavailable in service workers).
'use strict';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'parse') return false;
  try {
    const doc = new DOMParser().parseFromString(String(msg.html || ''), 'text/html');
    // Make relative URLs (images, canonical) resolve against the product page.
    const base = doc.createElement('base');
    base.href = msg.url;
    if (doc.head) doc.head.prepend(base);
    const product = globalThis.PriceDetect.detectProduct(doc, msg.url, { selector: msg.selector || null });
    sendResponse({ ok: true, product });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  }
  return false;
});
