/* Type Kit storage layer.
 * Classic script so it can be shared by the service worker (importScripts),
 * extension pages (<script src>) and content scripts (manifest js array).
 * Everything lives in chrome.storage.local - no network, no accounts.
 */
(function (root) {
  'use strict';

  const KEYS = { snippets: 'tk.snippets', folders: 'tk.folders', settings: 'tk.settings', clips: 'tk.clips' };

  const DEFAULT_SETTINGS = {
    expanderEnabled: true,
    triggerMode: 'instant',       // 'instant' | 'space'
    caseSensitive: false,
    requireWordBoundary: true,
    showToast: true,
    pickerEnabled: true,
    historyEnabled: true,
    historyLimit: 100,
    historyExpiryDays: 0,          // 0 = never
    minClipLength: 2,
    maxClipLength: 20000,
    excludedSites: [],             // clipboard history ignores these hosts (globs, e.g. "*.bank.com")
    expanderExcludedSites: [],     // shortcuts do not expand on these hosts
    wpm: 40,                       // typing speed used for "time saved"
    dateFormat: 'YYYY-MM-DD',
    timeFormat: 'HH:mm',
  };

  function uid(prefix) {
    const r = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return (prefix || 'id') + '_' + Date.now().toString(36) + r;
  }

  function nowISO() { return new Date().toISOString(); }

  function get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (v) => resolve(v || {})));
  }
  function set(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
  }

  /* ---------- defaults ---------- */

  function starterData() {
    const folders = [
      { id: 'f_general', name: 'General', order: 0 },
      { id: 'f_work', name: 'Work', order: 1 },
    ];
    const mk = (o) => Object.assign({
      id: uid('s'), name: '', shortcut: '', body: '', format: 'plain', folderId: 'f_general',
      enabled: true, uses: 0, charsSaved: 0, lastUsedAt: null, createdAt: nowISO(), updatedAt: nowISO(),
    }, o);
    const snippets = [
      mk({ name: 'Signature', shortcut: '/sig', folderId: 'f_work',
        body: 'Best regards,\nYour Name\nyour.name@example.com' }),
      mk({ name: 'Today’s date', shortcut: '/date', body: '{date}' }),
      mk({ name: 'Meeting follow-up', shortcut: '/followup', folderId: 'f_work',
        body: 'Hi {input:First name},\n\nThanks for the call on {date:-1d:dddd, MMMM D}. {cursor}\n\nI will send notes by {date:+2d:dddd}.\n\n{snippet:/sig}' }),
      mk({ name: 'Address', shortcut: ';addr',
        body: '100 Congress Ave\nAustin, TX 78701\nUnited States' }),
      mk({ name: 'Status update', shortcut: '/status', folderId: 'f_work',
        body: 'Status: {select:Status:On track|At risk|Blocked}\nUpdated {date} {time}\n\n{cursor}' }),
      mk({ name: 'Paste last copy', shortcut: '/clip', body: '{clipboard}' }),
    ];
    return { folders, snippets };
  }

  /* ---------- load / save ---------- */

  async function loadAll() {
    const v = await get([KEYS.snippets, KEYS.folders, KEYS.settings, KEYS.clips]);
    let snippets = v[KEYS.snippets];
    let folders = v[KEYS.folders];
    if (!Array.isArray(snippets) || !Array.isArray(folders)) {
      const starter = starterData();
      snippets = Array.isArray(snippets) ? snippets : starter.snippets;
      folders = Array.isArray(folders) ? folders : starter.folders;
      await set({ [KEYS.snippets]: snippets, [KEYS.folders]: folders });
    }
    return {
      snippets,
      folders,
      settings: Object.assign({}, DEFAULT_SETTINGS, v[KEYS.settings] || {}),
      clips: Array.isArray(v[KEYS.clips]) ? v[KEYS.clips] : [],
    };
  }

  async function getSettings() {
    const v = await get(KEYS.settings);
    return Object.assign({}, DEFAULT_SETTINGS, v[KEYS.settings] || {});
  }

  async function saveSettings(patch) {
    const s = Object.assign(await getSettings(), patch || {});
    await set({ [KEYS.settings]: s });
    return s;
  }

  async function getSnippets() {
    return (await loadAll()).snippets;
  }

  async function saveSnippets(list) {
    await set({ [KEYS.snippets]: list });
    return list;
  }

  async function getFolders() {
    return (await loadAll()).folders;
  }

  async function saveFolders(list) {
    await set({ [KEYS.folders]: list });
    return list;
  }

  function normalizeSnippet(input) {
    const s = Object.assign({}, input);
    s.id = s.id || uid('s');
    s.name = String(s.name || '').trim() || String(s.shortcut || 'Untitled');
    s.shortcut = String(s.shortcut || '').trim();
    s.body = typeof s.body === 'string' ? s.body : '';
    s.format = s.format === 'rich' ? 'rich' : 'plain';
    s.folderId = s.folderId || 'f_general';
    s.enabled = s.enabled !== false;
    s.uses = Number(s.uses) || 0;
    s.charsSaved = Number(s.charsSaved) || 0;
    s.lastUsedAt = s.lastUsedAt || null;
    s.createdAt = s.createdAt || nowISO();
    s.updatedAt = nowISO();
    return s;
  }

  async function upsertSnippet(input) {
    const list = await getSnippets();
    const s = normalizeSnippet(input);
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = Object.assign({}, list[i], s);
    else list.push(s);
    await saveSnippets(list);
    return s;
  }

  async function deleteSnippet(id) {
    const list = (await getSnippets()).filter((s) => s.id !== id);
    await saveSnippets(list);
  }

  async function duplicateSnippet(id) {
    const list = await getSnippets();
    const src = list.find((s) => s.id === id);
    if (!src) return null;
    const copy = normalizeSnippet(Object.assign({}, src, {
      id: uid('s'), name: src.name + ' copy', shortcut: src.shortcut ? src.shortcut + '2' : '',
      uses: 0, charsSaved: 0, lastUsedAt: null, createdAt: nowISO(),
    }));
    list.push(copy);
    await saveSnippets(list);
    return copy;
  }

  async function recordUse(id, insertedLength, shortcutLength) {
    const list = await getSnippets();
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    s.uses = (Number(s.uses) || 0) + 1;
    s.charsSaved = (Number(s.charsSaved) || 0) + Math.max(0, (insertedLength || 0) - (shortcutLength || 0));
    s.lastUsedAt = nowISO();
    await saveSnippets(list);
    return s;
  }

  /* ---------- folders ---------- */

  async function addFolder(name) {
    const list = await getFolders();
    const f = { id: uid('f'), name: String(name || 'New folder').trim() || 'New folder', order: list.length };
    list.push(f);
    await saveFolders(list);
    return f;
  }

  async function renameFolder(id, name) {
    const list = await getFolders();
    const f = list.find((x) => x.id === id);
    if (f) { f.name = String(name || f.name).trim() || f.name; await saveFolders(list); }
    return f;
  }

  async function deleteFolder(id) {
    if (id === 'f_general') return;
    const folders = (await getFolders()).filter((f) => f.id !== id);
    if (!folders.some((f) => f.id === 'f_general')) folders.unshift({ id: 'f_general', name: 'General', order: -1 });
    const snippets = (await getSnippets()).map((s) => (s.folderId === id ? Object.assign(s, { folderId: 'f_general' }) : s));
    await saveFolders(folders);
    await saveSnippets(snippets);
  }

  /* ---------- clipboard history ---------- */

  function hostMatches(host, pattern) {
    host = String(host || '').toLowerCase();
    pattern = String(pattern || '').trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    if (pattern.includes('*')) {
      const rx = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return rx.test(host);
    }
    return host === pattern || host.endsWith('.' + pattern);
  }

  function isExcluded(host, settings) {
    const list = (settings && settings.excludedSites) || [];
    return list.some((p) => hostMatches(host, p));
  }

  function pruneClips(clips, settings) {
    const limit = Math.max(5, Math.min(1000, Number(settings.historyLimit) || 100));
    const days = Number(settings.historyExpiryDays) || 0;
    let out = clips.slice();
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      out = out.filter((c) => c.pinned || new Date(c.createdAt).getTime() >= cutoff);
    }
    const pinned = out.filter((c) => c.pinned);
    const rest = out.filter((c) => !c.pinned).slice(0, limit);
    // keep newest-first ordering overall
    return pinned.concat(rest).sort((a, b) => (b.pinned - a.pinned) || (new Date(b.createdAt) - new Date(a.createdAt)));
  }

  async function addClip(entry) {
    const settings = await getSettings();
    if (!settings.historyEnabled) return { skipped: 'disabled' };
    const text = String((entry && entry.text) || '');
    if (text.trim().length < Math.max(1, Number(settings.minClipLength) || 1)) return { skipped: 'too-short' };
    if (text.length > (Number(settings.maxClipLength) || 20000)) return { skipped: 'too-long' };
    let host = '';
    try { host = entry.url ? new URL(entry.url).hostname : ''; } catch (e) { host = ''; }
    if (isExcluded(host, settings)) return { skipped: 'excluded' };

    const v = await get(KEYS.clips);
    let clips = Array.isArray(v[KEYS.clips]) ? v[KEYS.clips] : [];
    const dup = clips.find((c) => c.text === text);
    if (dup) {
      dup.createdAt = nowISO();
      dup.url = entry.url || dup.url;
      dup.title = entry.title || dup.title;
      dup.host = host || dup.host;
    } else {
      clips.unshift({
        id: uid('c'), text, url: entry.url || '', title: entry.title || '', host,
        createdAt: nowISO(), pinned: false, uses: 0,
      });
    }
    clips = pruneClips(clips, settings);
    await set({ [KEYS.clips]: clips });
    return { ok: true, count: clips.length, duplicate: !!dup };
  }

  async function getClips() {
    const v = await get(KEYS.clips);
    const clips = Array.isArray(v[KEYS.clips]) ? v[KEYS.clips] : [];
    const settings = await getSettings();
    const pruned = pruneClips(clips, settings);
    if (pruned.length !== clips.length) await set({ [KEYS.clips]: pruned });
    return pruned;
  }

  async function updateClip(id, patch) {
    const clips = await getClips();
    const c = clips.find((x) => x.id === id);
    if (!c) return null;
    Object.assign(c, patch || {});
    await set({ [KEYS.clips]: pruneClips(clips, await getSettings()) });
    return c;
  }

  async function deleteClip(id) {
    const clips = (await getClips()).filter((c) => c.id !== id);
    await set({ [KEYS.clips]: clips });
  }

  async function clearClips(keepPinned) {
    const clips = keepPinned ? (await getClips()).filter((c) => c.pinned) : [];
    await set({ [KEYS.clips]: clips });
    return clips.length;
  }

  /* ---------- stats ---------- */

  async function stats() {
    const { snippets, clips, settings } = await loadAll();
    const uses = snippets.reduce((n, s) => n + (Number(s.uses) || 0), 0);
    const chars = snippets.reduce((n, s) => n + (Number(s.charsSaved) || 0), 0);
    const cps = Math.max(10, (Number(settings.wpm) || 40) * 5) / 60; // chars per second
    return {
      snippetCount: snippets.length,
      clipCount: clips.length,
      pinnedCount: clips.filter((c) => c.pinned).length,
      uses,
      charsSaved: chars,
      secondsSaved: Math.round(chars / cps),
      top: snippets.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 5)
        .map((s) => ({ id: s.id, name: s.name, shortcut: s.shortcut, uses: s.uses || 0 })),
    };
  }

  /* ---------- import / export ---------- */

  function toCSV(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', q = false;
    const src = String(text).replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  async function exportJSON() {
    const { snippets, folders, settings, clips } = await loadAll();
    return JSON.stringify({
      app: 'type-kit', version: 1, exportedAt: nowISO(),
      folders, snippets,
      settings,
      clips: clips.filter((c) => c.pinned).map((c) => ({ text: c.text, url: c.url, title: c.title, pinned: true })),
    }, null, 2);
  }

  async function exportCSV() {
    const { snippets, folders } = await loadAll();
    const fname = (id) => (folders.find((f) => f.id === id) || {}).name || '';
    const rows = [['shortcut', 'name', 'folder', 'format', 'body', 'uses']];
    for (const s of snippets) rows.push([s.shortcut, s.name, fname(s.folderId), s.format, s.body, s.uses || 0]);
    return toCSV(rows);
  }

  async function importData(text, mode) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Nothing to import');
    let incomingSnippets = [], incomingFolders = [], incomingSettings = null, incomingClips = [];

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) incomingSnippets = data;
      else {
        incomingSnippets = Array.isArray(data.snippets) ? data.snippets : [];
        incomingFolders = Array.isArray(data.folders) ? data.folders : [];
        incomingSettings = data.settings && typeof data.settings === 'object' ? data.settings : null;
        incomingClips = Array.isArray(data.clips) ? data.clips : [];
      }
    } else {
      const rows = parseCSV(trimmed);
      if (!rows.length) throw new Error('Empty CSV');
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const idx = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
      const iShort = idx(['shortcut', 'trigger', 'abbreviation', 'abbr', 'key']);
      const iBody = idx(['body', 'text', 'snippet', 'expansion', 'value', 'content']);
      const iName = idx(['name', 'label', 'title']);
      const iFolder = idx(['folder', 'group', 'category']);
      const iFormat = idx(['format', 'type']);
      const start = (iShort >= 0 || iBody >= 0) ? 1 : 0;
      for (let r = start; r < rows.length; r++) {
        const row = rows[r];
        const shortcut = iShort >= 0 ? row[iShort] : row[0];
        const body = iBody >= 0 ? row[iBody] : row[1];
        if (!shortcut && !body) continue;
        incomingSnippets.push({
          shortcut, body,
          name: iName >= 0 ? row[iName] : '',
          folderName: iFolder >= 0 ? row[iFolder] : '',
          format: iFormat >= 0 ? row[iFormat] : 'plain',
        });
      }
    }

    let folders = mode === 'replace' ? [{ id: 'f_general', name: 'General', order: 0 }] : await getFolders();
    let snippets = mode === 'replace' ? [] : await getSnippets();

    const folderIdByName = new Map(folders.map((f) => [f.name.toLowerCase(), f.id]));
    for (const f of incomingFolders) {
      const name = String(f.name || '').trim();
      if (!name) continue;
      if (!folderIdByName.has(name.toLowerCase())) {
        const nf = { id: f.id && !folders.some((x) => x.id === f.id) ? f.id : uid('f'), name, order: folders.length };
        folders.push(nf);
        folderIdByName.set(name.toLowerCase(), nf.id);
      }
    }

    let added = 0, updated = 0;
    for (const raw of incomingSnippets) {
      let folderId = raw.folderId;
      const fname = String(raw.folderName || '').trim();
      if (fname) {
        if (!folderIdByName.has(fname.toLowerCase())) {
          const nf = { id: uid('f'), name: fname, order: folders.length };
          folders.push(nf); folderIdByName.set(fname.toLowerCase(), nf.id);
        }
        folderId = folderIdByName.get(fname.toLowerCase());
      }
      if (!folderId || !folders.some((f) => f.id === folderId)) folderId = 'f_general';
      const s = normalizeSnippet(Object.assign({}, raw, { folderId, id: raw.id }));
      const existing = s.shortcut
        ? snippets.find((x) => x.shortcut && x.shortcut.toLowerCase() === s.shortcut.toLowerCase())
        : snippets.find((x) => x.id === s.id);
      if (existing && mode === 'merge') { Object.assign(existing, s, { id: existing.id }); updated++; }
      else if (existing && mode === 'skip') { /* keep existing */ }
      else { if (snippets.some((x) => x.id === s.id)) s.id = uid('s'); snippets.push(s); added++; }
    }

    if (!folders.some((f) => f.id === 'f_general')) folders.unshift({ id: 'f_general', name: 'General', order: -1 });
    await saveFolders(folders);
    await saveSnippets(snippets);
    if (incomingSettings) await saveSettings(incomingSettings);
    for (const c of incomingClips) if (c && c.text) await addClip({ text: c.text, url: c.url, title: c.title }).then(() => updateClipByText(c.text, { pinned: true })).catch(() => {});
    return { added, updated, folders: folders.length, total: snippets.length };
  }

  async function updateClipByText(text, patch) {
    const clips = await getClips();
    const c = clips.find((x) => x.text === text);
    if (c) { Object.assign(c, patch); await set({ [KEYS.clips]: clips }); }
  }

  root.TKStore = {
    KEYS, DEFAULT_SETTINGS, uid, nowISO,
    loadAll, getSettings, saveSettings,
    getSnippets, saveSnippets, upsertSnippet, deleteSnippet, duplicateSnippet, recordUse, normalizeSnippet,
    getFolders, saveFolders, addFolder, renameFolder, deleteFolder,
    addClip, getClips, updateClip, deleteClip, clearClips, isExcluded, hostMatches,
    stats, exportJSON, exportCSV, importData, toCSV, parseCSV,
  };
})(typeof self !== 'undefined' ? self : window);
