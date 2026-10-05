// Export / import of all extension data, plus OneTab text import.
import * as store from './store.js';
import { uid, parseOneTab, DEFAULT_SETTINGS, GROUP_COLORS } from './util.js';

const FORMAT = 'tab-workspaces';

export async function exportAll() {
  const data = await chrome.storage.local.get(['workspaces', 'stashes', 'sessions', 'archive', 'rules', 'settings']);
  return {
    format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
    workspaces: data.workspaces || [], stashes: data.stashes || [], sessions: data.sessions || [],
    archive: data.archive || [], rules: data.rules || [], settings: data.settings || {},
  };
}

const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d = Date.now()) => (Number.isFinite(+v) && +v > 0 ? +v : d);

function cleanTab(t) {
  if (!t || typeof t.url !== 'string' || !t.url) return null;
  return { url: t.url, title: str(t.title, t.url), favIconUrl: str(t.favIconUrl), pinned: !!t.pinned, group: Number.isInteger(t.group) ? t.group : -1, active: !!t.active };
}
function cleanGroups(gs) {
  return Array.isArray(gs) ? gs.map(g => ({ title: str(g?.title), color: GROUP_COLORS.includes(g?.color) ? g.color : 'grey', collapsed: !!g?.collapsed })) : [];
}

function cleanWorkspace(w) {
  if (!w || !Array.isArray(w.tabs)) return null;
  return { id: uid('ws_'), name: str(w.name, 'Imported workspace').slice(0, 80), color: GROUP_COLORS.includes(w.color) ? w.color : 'blue',
    tabs: w.tabs.map(cleanTab).filter(Boolean), groups: cleanGroups(w.groups), createdAt: num(w.createdAt), updatedAt: Date.now(), lastOpenedAt: 0 };
}
function cleanStash(s) {
  if (!s || !Array.isArray(s.tabs)) return null;
  const tabs = s.tabs.map(cleanTab).filter(Boolean).map(t => ({ id: uid('t_'), url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned }));
  if (!tabs.length) return null;
  return { id: uid('st_'), name: str(s.name, 'Imported').slice(0, 120), createdAt: num(s.createdAt), starred: !!s.starred, tabs };
}
function cleanSession(s) {
  if (!s || !Array.isArray(s.windows)) return null;
  const windows = s.windows.map(w => ({ tabs: (w?.tabs || []).map(cleanTab).filter(Boolean), groups: cleanGroups(w?.groups), focused: !!w?.focused })).filter(w => w.tabs.length);
  if (!windows.length) return null;
  return { id: uid('se_'), kind: ['auto', 'manual', 'previous'].includes(s.kind) ? s.kind : 'manual', name: str(s.name), createdAt: num(s.createdAt), confirmedAt: num(s.confirmedAt),
    windows, tabCount: windows.reduce((n, w) => n + w.tabs.length, 0), sig: '', starred: !!s.starred };
}
function cleanArchive(a) {
  if (!a || typeof a.url !== 'string') return null;
  return { id: uid('a_'), url: a.url, title: str(a.title, a.url), favIconUrl: str(a.favIconUrl), closedAt: num(a.closedAt), windowClosing: !!a.windowClosing };
}
function cleanRule(r) {
  if (!r || !r.pattern) return null;
  return { id: uid('r_'), pattern: str(r.pattern), type: str(r.type, 'auto'), title: str(r.title), color: GROUP_COLORS.includes(r.color) ? r.color : 'blue', enabled: r.enabled !== false };
}

/** Import an export file. mode: 'merge' (append) or 'replace' (overwrite everything). */
export async function importAll(json, mode = 'merge') {
  let data = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch { throw new Error('That file is not valid JSON.'); }
  }
  if (!data || typeof data !== 'object' || (data.format && data.format !== FORMAT)) throw new Error('Not a Tab Workspaces export file.');
  const pick = (k, fn) => (Array.isArray(data[k]) ? data[k].map(fn).filter(Boolean) : []);
  const inc = {
    workspaces: pick('workspaces', cleanWorkspace), stashes: pick('stashes', cleanStash), sessions: pick('sessions', cleanSession),
    archive: pick('archive', cleanArchive), rules: pick('rules', cleanRule),
  };
  for (const k of Object.keys(inc)) {
    await store.update(k, [], list => {
      if (mode === 'replace') return inc[k];
      if (k === 'archive') return [...inc[k], ...list].sort((a, b) => b.closedAt - a.closedAt);
      if (k === 'stashes' || k === 'sessions') return [...inc[k], ...list].sort((a, b) => b.createdAt - a.createdAt);
      return [...list, ...inc[k]];
    });
  }
  if (mode === 'replace' && data.settings && typeof data.settings === 'object') {
    const settings = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in data.settings && typeof data.settings[k] === typeof DEFAULT_SETTINGS[k]) settings[k] = data.settings[k];
    await store.set('settings', settings);
  }
  if (mode === 'replace') await store.sset('bindings', {});
  return Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, v.length]));
}

/** Import OneTab's "Export URLs" text: each blank-line-separated block becomes a stash. */
export async function importOneTab(text) {
  const groups = parseOneTab(text);
  if (!groups.length) throw new Error('No URLs found. Paste the text from OneTab’s “Export URLs” page.');
  const now = Date.now();
  const stashes = groups.map((g, i) => ({
    id: uid('st_'), name: groups.length > 1 ? `OneTab import ${i + 1}` : 'OneTab import', createdAt: now - i, starred: false,
    tabs: g.tabs.map(t => ({ id: uid('t_'), url: t.url, title: t.title, favIconUrl: '', pinned: false })),
  }));
  await store.update('stashes', [], list => [...stashes, ...list]);
  return { stashes: stashes.length, tabs: stashes.reduce((n, s) => n + s.tabs.length, 0) };
}
