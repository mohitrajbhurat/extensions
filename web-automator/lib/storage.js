// Persistence helpers. Macros, settings and run history live in chrome.storage.local.
import { uid } from './commands.js';

export const DEFAULT_SETTINGS = {
  speed: 'normal',          // fast | normal | slow
  stepTimeout: 10000,       // ms to wait for an element
  retries: 2,               // retries per step (each retry walks all selector fallbacks)
  highlight: true,
  recordScroll: true,
  recordKeystrokes: false,
  bringToFront: true,
  notifyManual: false,
  onError: 'stop',          // stop | continue
  keepRuns: 30,
};

export const SPEED_DELAY = { fast: 0, normal: 350, slow: 1200 };

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: s });
  return s;
}

export async function getMacros() {
  const { macros } = await chrome.storage.local.get('macros');
  return Array.isArray(macros) ? macros : [];
}

export async function setMacros(macros) {
  await chrome.storage.local.set({ macros });
}

export async function getMacro(id) {
  return (await getMacros()).find(m => m.id === id) || null;
}

export function normalizeMacro(m) {
  const now = Date.now();
  return {
    id: m.id || uid(),
    name: (m.name || 'Untitled macro').slice(0, 200),
    steps: (m.steps || []).map(s => ({
      id: s.id || uid(),
      command: s.command || 'click',
      target: s.target || '',
      targets: Array.isArray(s.targets) ? s.targets.filter(Boolean) : (s.target ? [s.target] : []),
      value: s.value === undefined || s.value === null ? '' : String(s.value),
      comment: s.comment || '',
      disabled: !!s.disabled,
    })),
    csv: m.csv && typeof m.csv.text === 'string' ? { name: m.csv.name || 'data.csv', text: m.csv.text } : null,
    schedule: m.schedule || null,
    created: m.created || now,
    updated: now,
  };
}

export async function saveMacro(macro) {
  const macros = await getMacros();
  const m = normalizeMacro(macro);
  const idx = macros.findIndex(x => x.id === m.id);
  if (idx >= 0) { m.created = macros[idx].created || m.created; macros[idx] = m; }
  else macros.unshift(m);
  await setMacros(macros);
  return m;
}

export async function deleteMacro(id) {
  const macros = (await getMacros()).filter(m => m.id !== id);
  await setMacros(macros);
}

// ---- Run history ----
export async function getRuns() {
  const { runs } = await chrome.storage.local.get('runs');
  return Array.isArray(runs) ? runs : [];
}

export async function saveRun(run) {
  const settings = await getSettings();
  const runs = await getRuns();
  const idx = runs.findIndex(r => r.id === run.id);
  const stored = { ...run };
  delete stored.vars;
  if (idx >= 0) runs[idx] = stored; else runs.unshift(stored);
  const keep = Math.max(5, settings.keepRuns || 30);
  const removed = runs.splice(keep);
  const removeKeys = [];
  for (const r of removed) for (const s of r.screenshots || []) removeKeys.push(s.key);
  if (removeKeys.length) await chrome.storage.local.remove(removeKeys);
  await chrome.storage.local.set({ runs });
}

export async function clearRuns() {
  const runs = await getRuns();
  const keys = [];
  for (const r of runs) for (const s of r.screenshots || []) keys.push(s.key);
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ runs: [] });
}
