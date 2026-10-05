// Global Privacy Control signal for page scripts (runs in the page's MAIN world at
// document_start). The matching Sec-GPC request header is set by the "gpc" DNR ruleset.
// https://privacycg.github.io/gpc-spec/
(() => {
  try {
    const proto = Object.getPrototypeOf(navigator);
    const existing = Object.getOwnPropertyDescriptor(proto, 'globalPrivacyControl');
    if (existing && existing.get && navigator.globalPrivacyControl === true) return;
    const holder = { get globalPrivacyControl() { return true; } };
    Object.defineProperty(proto, 'globalPrivacyControl', {
      get: Object.getOwnPropertyDescriptor(holder, 'globalPrivacyControl').get,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // A frozen navigator prototype: nothing more we can do, the header still goes out.
  }
})();
