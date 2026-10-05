// Shared defaults and settings helpers. Classic script: works as a content script,
// a <script> in extension pages, and as a side-effect import in the module service worker.
(function () {
  if (globalThis.RS_SETTINGS) return;

  const DEFAULTS = {
    reader: {
      font: 'serif',        // serif | sans | slab | mono | dyslexic
      size: 20,             // px, 14..32
      lineHeight: 1.7,      // 1.2..2.4
      width: 720,           // px, 480..1100
      theme: 'auto',        // auto | light | sepia | dark | black
      align: 'left',        // left | justify
      wpm: 230
    },
    tts: {
      engine: 'chrome',     // chrome (chrome.tts) | web (speechSynthesis)
      voice: '',            // voice name, '' = browser default
      rate: 1,              // 0.5..3
      pitch: 1,
      volume: 1,
      highlightWord: true,
      autoScroll: true,
      source: 'auto'        // auto | selection | article | page
    },
    dark: {
      enabled: 'off',       // off | on | system  (global default; per-site rules override)
      mode: 'dynamic',      // dynamic | filter
      brightness: 100,      // 50..150
      contrast: 100,        // 50..150
      sepia: 0,             // 0..100
      grayscale: 0,         // 0..100
      skipDarkSites: true
    },
    focus: {
      ruler: false,
      rulerMode: 'focus',   // focus (dim around) | band (tinted band) | underline
      rulerHeight: 56,
      rulerOpacity: 0.55,
      rulerColor: '#ffd54a',
      bionic: false,
      bionicStrength: 0.5   // 0.3..0.7 fraction of each word made bold
    },
    player: { x: null, y: null }
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function merge(base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(out)) {
      if (!(k in over)) continue;
      if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], over[k]);
      else if (over[k] !== undefined) out[k] = over[k];
    }
    return out;
  }

  async function load() {
    try {
      const { settings } = await chrome.storage.sync.get('settings');
      return merge(DEFAULTS, settings);
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  // patch: { section: { key: value } }
  async function update(patch) {
    const cur = await load();
    for (const sec of Object.keys(patch)) {
      cur[sec] = Object.assign({}, cur[sec], patch[sec]);
    }
    await chrome.storage.sync.set({ settings: cur });
    return cur;
  }

  async function reset() {
    await chrome.storage.sync.set({ settings: clone(DEFAULTS) });
    return clone(DEFAULTS);
  }

  async function getSites() {
    const { sites } = await chrome.storage.local.get('sites');
    return sites || {};
  }

  async function setSiteRule(host, key, value) {
    const sites = await getSites();
    const entry = Object.assign({}, sites[host]);
    if (value === undefined || value === null) delete entry[key]; else entry[key] = value;
    if (Object.keys(entry).length) sites[host] = entry; else delete sites[host];
    await chrome.storage.local.set({ sites });
    return sites;
  }

  // Effective dark-mode decision ignoring page analysis. Returns 'on', 'off' or 'auto'
  // ('auto' = apply unless the page is already dark).
  function darkDecision(settings, siteRule, prefersDark) {
    if (siteRule === 'on') return 'on';
    if (siteRule === 'off') return 'off';
    const en = settings.dark.enabled;
    if (en === 'on' || (en === 'system' && prefersDark)) return settings.dark.skipDarkSites ? 'auto' : 'on';
    return 'off';
  }

  globalThis.RS_SETTINGS = { DEFAULTS, merge, load, update, reset, getSites, setSiteRule, darkDecision, clone };
})();
