// User settings stored in chrome.storage.local under "settings".
export const DEFAULT_SETTINGS = Object.freeze({
  desiredRetention: 0.9,
  learningSteps: [1, 10],
  relearningSteps: [10],
  maximumInterval: 36500,
  enableFuzz: true,
  newPerDay: 20,
  rolloverHour: 4,
  reminderEnabled: true,
  reminderTime: '09:00',
  showBadge: true,
  floatingButton: false,
  showIntervals: true,
  lastDeckId: null,
  captureMode: 'basic', // 'basic' | 'cloze'
  clozeSeparate: true,
});

export async function getSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function schedulerOptions(s) {
  return {
    desiredRetention: s.desiredRetention,
    learningSteps: s.learningSteps,
    relearningSteps: s.relearningSteps,
    maximumInterval: s.maximumInterval,
    enableFuzz: s.enableFuzz,
  };
}
