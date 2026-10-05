// Shared constants and helpers. Loaded as a classic script in the content script and
// extension pages, and as a side-effect import in module contexts. Exposes globalThis.VS.
(function (g) {
  'use strict';
  if (g.VS) return;

  const MIN_RATE = 0.07;
  const MAX_RATE = 16;

  // Action metadata: label, default binding (KeyboardEvent.code + modifiers) and grouping.
  const ACTIONS = {
    slower: { label: 'Decrease speed', group: 'Speed', key: { code: 'KeyS' } },
    faster: { label: 'Increase speed', group: 'Speed', key: { code: 'KeyD' } },
    reset: { label: 'Reset speed (toggle 1x)', group: 'Speed', key: { code: 'KeyR' } },
    preferred: { label: 'Toggle preferred speed', group: 'Speed', key: { code: 'KeyG' } },
    rewind: { label: 'Rewind', group: 'Playback', key: { code: 'KeyZ' } },
    advance: { label: 'Advance', group: 'Playback', key: { code: 'KeyX' } },
    toggleOverlay: { label: 'Show or hide speed badge', group: 'Playback', key: { code: 'KeyV' } },
    addNote: { label: 'Add note at current time', group: 'Notes', key: { code: 'KeyN' } },
    screenshotNote: { label: 'Add note with frame screenshot', group: 'Notes', key: { code: 'KeyP' } },
    bookmark: { label: 'Add bookmark (chapter)', group: 'Notes', key: { code: 'KeyB' } },
    loopA: { label: 'Set loop start (A)', group: 'Loop', key: { code: 'BracketLeft' } },
    loopB: { label: 'Set loop end (B)', group: 'Loop', key: { code: 'BracketRight' } },
    loopClear: { label: 'Toggle A-B loop on or off', group: 'Loop', key: { code: 'Backslash' } },
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    speedStep: 0.1,
    seekSeconds: 10,
    preferredSpeed: 1.8,
    defaultSpeed: 1.0,
    rememberPerSite: true,
    forceSpeed: false,
    overlayMode: 'always', // always | onchange | never
    overlayOpacity: 0.35,
    overlayPosition: 'top-left', // top-left | top-right
    pauseWhileTyping: true,
    openPanelOnNote: true,
    panelMode: 'auto', // auto (side panel when available) | inpage
    screenshotMaxWidth: 1280,
    screenshotQuality: 0.85,
    autoTabCapture: true,
    disabledSites: [],
    bindings: null, // filled by normalizeSettings
  };

  function defaultBindings() {
    const b = {};
    for (const [action, meta] of Object.entries(ACTIONS)) {
      b[action] = Object.assign({ code: '', shift: false, ctrl: false, alt: false, meta: false }, meta.key);
    }
    return b;
  }

  function num(v, def, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.speedStep = num(s.speedStep, 0.1, 0.01, 4);
    s.seekSeconds = num(s.seekSeconds, 10, 1, 600);
    s.preferredSpeed = clampRate(num(s.preferredSpeed, 1.8, MIN_RATE, MAX_RATE));
    s.defaultSpeed = clampRate(num(s.defaultSpeed, 1, MIN_RATE, MAX_RATE));
    s.overlayOpacity = num(s.overlayOpacity, 0.35, 0.1, 1);
    s.screenshotMaxWidth = num(s.screenshotMaxWidth, 1280, 320, 3840);
    s.screenshotQuality = num(s.screenshotQuality, 0.85, 0.3, 1);
    if (!['always', 'onchange', 'never'].includes(s.overlayMode)) s.overlayMode = 'always';
    if (!['top-left', 'top-right'].includes(s.overlayPosition)) s.overlayPosition = 'top-left';
    if (!['auto', 'inpage'].includes(s.panelMode)) s.panelMode = 'auto';
    if (!Array.isArray(s.disabledSites)) s.disabledSites = [];
    const defs = defaultBindings();
    const out = {};
    for (const action of Object.keys(ACTIONS)) {
      const src = s.bindings && Object.prototype.hasOwnProperty.call(s.bindings, action) ? s.bindings[action] : defs[action];
      out[action] = src && src.code
        ? { code: String(src.code), shift: !!src.shift, ctrl: !!src.ctrl, alt: !!src.alt, meta: !!src.meta }
        : null;
    }
    s.bindings = out;
    return s;
  }

  function clampRate(r) {
    const n = Number(r);
    if (!Number.isFinite(n)) return 1;
    return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, n)) * 100) / 100;
  }

  function bindingMatches(b, e) {
    return !!b && b.code === e.code && b.shift === e.shiftKey && b.ctrl === e.ctrlKey && b.alt === e.altKey && b.meta === e.metaKey;
  }

  const CODE_NAMES = {
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backquote: '`', Minus: '-', Equal: '=', Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right',
    ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Enter', Tab: 'Tab',
  };

  function codeName(code) {
    if (!code) return '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
    return CODE_NAMES[code] || code;
  }

  function bindingLabel(b) {
    if (!b || !b.code) return 'Not set';
    const parts = [];
    if (b.ctrl) parts.push('Ctrl');
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
    if (b.meta) parts.push('Meta');
    parts.push(codeName(b.code));
    return parts.join('+');
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Accepts 1:23:45, 12:34, 95, 1h2m3s, 2m, 30s.
  function parseTime(str) {
    if (typeof str === 'number') return str;
    const t = String(str || '').trim();
    if (!t) return NaN;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    let m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
    m = t.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/i);
    if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    return NaN;
  }

  const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|si|feature|vst|t|start|time_continue|ref|ref_src)$/i;

  // Identify a video by the page (frame) URL it plays on. Returns { key, site, url, ytId?, vimeoId? }.
  function canonicalVideo(href) {
    let u;
    try { u = new URL(href); } catch (_) { return { key: 'url:' + String(href), site: '', url: String(href) }; }
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    let id = null;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      id = u.searchParams.get('v');
      if (!id) {
        const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
        if (m) id = m[1];
      }
    } else if (host === 'youtu.be') {
      id = u.pathname.slice(1).split('/')[0] || null;
    }
    if (id && /^[\w-]{6,}$/.test(id)) {
      return { key: 'yt:' + id, site: 'YouTube', url: 'https://www.youtube.com/watch?v=' + id, ytId: id };
    }
    if (/(^|\.)vimeo\.com$/.test(host)) {
      const m = u.pathname.match(/(?:^|\/)(?:video\/)?(\d{5,})(?:\/|$)/);
      if (m) return { key: 'vimeo:' + m[1], site: 'Vimeo', url: 'https://vimeo.com/' + m[1], vimeoId: m[1] };
    }
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (!TRACKING_PARAMS.test(k)) params.append(k, v);
    const qs = params.toString();
    let hash = '';
    if (/^#[!/]/.test(u.hash)) hash = u.hash.replace(/[&?]vst=[\d.]+/, '');
    const url = u.origin + u.pathname + (qs ? '?' + qs : '') + hash;
    return { key: 'url:' + url, site: siteName(u.hostname), url };
  }

  function siteName(hostname) {
    const h = String(hostname || '').replace(/^www\./, '');
    const known = { 'coursera.org': 'Coursera', 'udemy.com': 'Udemy', 'vimeo.com': 'Vimeo', 'youtube.com': 'YouTube', 'edx.org': 'edX', 'khanacademy.org': 'Khan Academy', 'linkedin.com': 'LinkedIn Learning', 'twitch.tv': 'Twitch' };
    for (const [d, n] of Object.entries(known)) if (h === d || h.endsWith('.' + d)) return n;
    return h || 'Local file';
  }

  // Build a link that opens the video at time t (seconds).
  function timeLink(video, t) {
    const s = Math.max(0, Math.floor(t || 0));
    const key = (video && video.id) || '';
    if (key.startsWith('yt:')) return `https://www.youtube.com/watch?v=${key.slice(3)}&t=${s}s`;
    if (key.startsWith('vimeo:')) return `https://vimeo.com/${key.slice(6)}#t=${s}s`;
    const url = (video && video.url) || '';
    if (!url) return '';
    if (url.includes('#')) return `${url}&vst=${s}`;
    return `${url}#vst=${s}`;
  }

  g.VS = {
    MIN_RATE, MAX_RATE, ACTIONS, DEFAULT_SETTINGS, defaultBindings, normalizeSettings, clampRate,
    bindingMatches, bindingLabel, codeName, formatTime, parseTime, canonicalVideo, siteName, timeLink,
  };
})(globalThis);
