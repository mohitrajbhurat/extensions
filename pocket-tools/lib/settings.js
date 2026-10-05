// Small user preferences in chrome.storage.sync. Generated passwords and
// passphrases are never stored; only the generator's options are.

export const HOST_ORIGINS = ['http://*/*', 'https://*/*'];

export const DEFAULTS = {
  tooltip: false, // selection conversion tooltip on every page (needs optional host access)
  clearSeconds: 30, // clipboard auto-clear after copying a password; 0 = never
  lastTab: 'password',
  generator: {
    type: 'password', // password | pronounceable | passphrase
    length: 20,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    words: 5,
    separator: '-',
    capitalize: true,
    includeNumber: true,
  },
  qr: { level: 'M', scale: 8, quiet: 4, dark: '#111111', light: '#ffffff' },
  homeZone: '', // '' = the browser's zone
  cities: ['America/New_York', 'Europe/London', 'Asia/Tokyo'],
  workStart: 9,
  workEnd: 17,
};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get('settings');
    return merge(DEFAULTS, stored.settings);
  } catch {
    return merge(DEFAULTS, {});
  }
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = merge(current, patch);
  await chrome.storage.sync.set({ settings: next });
  return next;
}
