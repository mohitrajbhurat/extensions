// Storage layer: profiles (optionally encrypted at rest), settings, site rules and backups.
// storage.local keys:  settings, data (plain profiles), vault (encrypted profiles), siteRules
// storage.session key: vaultKey + lastUsed while unlocked (never written to disk by Chrome).
import * as C from './crypto.js';
import { normalizeData, defaultData } from './profile.js';

export const DEFAULT_SETTINGS = {
  lockEnabled: false,
  autoLockMinutes: 30,
  learnMode: true,
  fillRepeatables: true,
  highlightAfterFill: true,
  overwrite: false,
  minConfidence: 0.5,
  previewFirst: true,
};

export class LockedError extends Error {
  constructor() { super('Profiles are locked. Unlock with your passphrase.'); this.name = 'LockedError'; this.locked = true; }
}

const local = chrome.storage.local;
const session = chrome.storage.session;

export async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await local.set({ settings: s });
  return s;
}

async function sessionKey() {
  const s = await getSettings();
  const { vaultKey, lastUsed } = await session.get(['vaultKey', 'lastUsed']);
  if (!vaultKey) return null;
  const now = Date.now();
  if (s.autoLockMinutes > 0 && lastUsed && now - lastUsed > s.autoLockMinutes * 60000) {
    await session.remove(['vaultKey', 'lastUsed']);
    return null;
  }
  if (!lastUsed || now - lastUsed > 15000) await session.set({ lastUsed: now });
  return C.importKey(vaultKey);
}

export async function getLockState() {
  const s = await getSettings();
  if (!s.lockEnabled) return { lockEnabled: false, locked: false };
  const key = await sessionKey();
  return { lockEnabled: true, locked: !key, autoLockMinutes: s.autoLockMinutes };
}

export async function loadData() {
  const s = await getSettings();
  if (s.lockEnabled) {
    const key = await sessionKey();
    if (!key) throw new LockedError();
    const { vault } = await local.get('vault');
    if (!vault) return defaultData();
    return normalizeData(await C.decryptJSON(key, vault));
  }
  const { data } = await local.get('data');
  if (!data) {
    const d = defaultData();
    await local.set({ data: d });
    return d;
  }
  return normalizeData(data);
}

export async function saveData(data) {
  const s = await getSettings();
  const clean = normalizeData(data);
  if (s.lockEnabled) {
    const key = await sessionKey();
    if (!key) throw new LockedError();
    const { vault } = await local.get('vault');
    const blob = await C.encryptJSON(key, clean);
    await local.set({ vault: { ...vault, ...blob, v: 1, updatedAt: Date.now() } });
  } else {
    await local.set({ data: clean });
  }
  return clean;
}

export async function getProfile(id) {
  const d = await loadData();
  return d.profiles.find(p => p.id === id) || d.profiles.find(p => p.id === d.activeProfileId) || d.profiles[0];
}

export async function setActiveProfile(id) {
  const d = await loadData();
  if (d.profiles.some(p => p.id === id)) { d.activeProfileId = id; await saveData(d); }
}

// ---------- lock management ----------
async function keyFromVault(passphrase, vault) {
  const key = await C.deriveKey(passphrase, C.fromB64(vault.salt), vault.iterations || C.ITERATIONS);
  try {
    const data = await C.decryptJSON(key, vault);
    return { key, data };
  } catch (e) {
    throw new Error('Wrong passphrase.');
  }
}
async function rememberKey(key) {
  await session.set({ vaultKey: await C.exportKey(key), lastUsed: Date.now() });
}

export async function unlock(passphrase) {
  const { vault } = await local.get('vault');
  if (!vault) throw new Error('No encrypted vault found.');
  const { key } = await keyFromVault(passphrase, vault);
  await rememberKey(key);
  return true;
}
export async function lock() {
  await session.remove(['vaultKey', 'lastUsed']);
}
export async function enableLock(passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const s = await getSettings();
  if (s.lockEnabled) throw new Error('Lock is already enabled.');
  const data = await loadData();
  const salt = C.randomBytes(16);
  const key = await C.deriveKey(passphrase, salt, C.ITERATIONS);
  const blob = await C.encryptJSON(key, data);
  await local.set({ vault: { v: 1, kdf: 'PBKDF2-SHA256', iterations: C.ITERATIONS, salt: C.toB64(salt), cipher: 'AES-GCM-256', ...blob, updatedAt: Date.now() } });
  await rememberKey(key);
  await saveSettings({ lockEnabled: true });
  await local.remove('data');
}
export async function disableLock(passphrase) {
  const { vault } = await local.get('vault');
  if (!vault) { await saveSettings({ lockEnabled: false }); return; }
  const { data } = await keyFromVault(passphrase, vault);
  await local.set({ data: normalizeData(data) });
  await saveSettings({ lockEnabled: false });
  await local.remove('vault');
  await lock();
}
export async function changePassphrase(oldPass, newPass) {
  if (!newPass || newPass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const { vault } = await local.get('vault');
  if (!vault) throw new Error('Lock is not enabled.');
  const { data } = await keyFromVault(oldPass, vault);
  const salt = C.randomBytes(16);
  const key = await C.deriveKey(newPass, salt, C.ITERATIONS);
  const blob = await C.encryptJSON(key, data);
  await local.set({ vault: { v: 1, kdf: 'PBKDF2-SHA256', iterations: C.ITERATIONS, salt: C.toB64(salt), cipher: 'AES-GCM-256', ...blob, updatedAt: Date.now() } });
  await rememberKey(key);
}

// ---------- site rules ----------
export async function getRules() {
  const { siteRules } = await local.get('siteRules');
  return siteRules || {};
}
export async function saveRule(host, sig, rule) {
  const all = await getRules();
  all[host] = all[host] || {};
  all[host][sig] = { ...rule, updated: Date.now() };
  await local.set({ siteRules: all });
}
export async function deleteRule(host, sig) {
  const all = await getRules();
  if (all[host]) {
    delete all[host][sig];
    if (!Object.keys(all[host]).length) delete all[host];
  }
  await local.set({ siteRules: all });
}
export async function clearRules(host) {
  const all = await getRules();
  if (host) delete all[host]; else for (const k of Object.keys(all)) delete all[k];
  await local.set({ siteRules: all });
}

// ---------- backups ----------
export async function exportBackup(passphrase, { includeRules = true, includeSettings = true } = {}) {
  if (!passphrase || passphrase.length < 8) throw new Error('Use a backup passphrase of at least 8 characters.');
  const payload = { data: await loadData() };
  if (includeRules) payload.siteRules = await getRules();
  if (includeSettings) { const s = await getSettings(); delete s.lockEnabled; payload.settings = s; }
  const env = await C.sealWithPassphrase(passphrase, payload);
  return JSON.stringify({ format: 'smart-autofill-backup', version: 1, encrypted: true, createdAt: new Date().toISOString(), ...env }, null, 2);
}
export function inspectBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
  if (obj.format !== 'smart-autofill-backup') throw new Error('Not a Smart Autofill backup file.');
  return { encrypted: !!obj.encrypted, createdAt: obj.createdAt, obj };
}
export async function importBackup(text, passphrase, mode = 'merge') {
  const { obj } = inspectBackup(text);
  let payload;
  if (obj.encrypted) {
    try { payload = await C.openWithPassphrase(passphrase || '', obj); } catch (e) { throw new Error('Wrong backup passphrase or damaged file.'); }
  } else payload = obj.payload;
  const incoming = normalizeData(payload.data);
  let data;
  if (mode === 'replace') data = incoming;
  else {
    const cur = await loadData();
    const ids = new Set(cur.profiles.map(p => p.id));
    for (const p of incoming.profiles) {
      if (ids.has(p.id)) cur.profiles = cur.profiles.map(x => x.id === p.id ? p : x);
      else cur.profiles.push(p);
    }
    data = cur;
  }
  await saveData(data);
  if (payload.siteRules) {
    const rules = mode === 'replace' ? {} : await getRules();
    for (const [h, r] of Object.entries(payload.siteRules)) rules[h] = { ...(rules[h] || {}), ...r };
    await local.set({ siteRules: rules });
  }
  if (payload.settings) {
    const s = { ...payload.settings };
    delete s.lockEnabled;
    await saveSettings(s);
  }
  return { profiles: incoming.profiles.length, rules: payload.siteRules ? Object.keys(payload.siteRules).length : 0 };
}

export async function storageUsage() {
  try { return await local.getBytesInUse(null); } catch (e) { return 0; }
}
