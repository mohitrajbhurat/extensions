// Settings live in chrome.storage.local so content scripts can read them without a round trip.

export const DEFAULT_SETTINGS = Object.freeze({
  paused: false,
  excludedDomains: [
    'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'paypal.com',
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'web.whatsapp.com', 'messages.google.com',
  ],
  skipSensitive: true,
  retentionDays: 180,      // 0 = keep forever
  maxStorageMB: 500,
  maxCharsPerPage: 60000,
  minChars: 120,
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
