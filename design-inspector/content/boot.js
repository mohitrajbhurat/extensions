/* Design Inspector bootstrap (classic script, injected with chrome.scripting).
   Loads the ES module app once and toggles it on later clicks. */
(() => {
  const KEY = '__designInspector__';
  if (window[KEY]) {
    try {
      window[KEY].toggle();
    } catch (e) {
      console.warn('Design Inspector:', e);
    }
    return;
  }
  window[KEY] = { loading: true, toggle() {} };
  import(chrome.runtime.getURL('content/app.js'))
    .then(mod => {
      const api = mod.start();
      window[KEY] = api;
    })
    .catch(e => {
      delete window[KEY];
      console.error('Design Inspector failed to load:', e);
    });
})();
