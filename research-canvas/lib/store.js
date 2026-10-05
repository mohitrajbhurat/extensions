// Research Canvas data layer.
// Every record lives under its own chrome.storage.local key so concurrent writers rarely collide:
//   project:<id>   { id, name, color, order, createdAt, updatedAt }
//   clip:<id>      { id, projectId, type, title, content, comment, url, pageTitle, tags[], color,
//                    highlightId, order, createdAt, updatedAt }
//   page:<url>     { url, title, highlights[], stickies[], updatedAt }
//   settings       { activeProjectId, autoRestore, showToolbar, highlightsToProject, defaultColor }
// Writes are performed by the service worker (serialized through `locked`); pages read directly.

export const COLORS = [
  { id: 'yellow', name: 'Yellow', hex: '#ffe066' },
  { id: 'green', name: 'Green', hex: '#8ce99a' },
  { id: 'blue', name: 'Blue', hex: '#a5d8ff' },
  { id: 'pink', name: 'Pink', hex: '#fcc2d7' },
  { id: 'purple', name: 'Purple', hex: '#d0bfff' },
];
export const COLOR_HEX = Object.fromEntries(COLORS.map(c => [c.id, c.hex]));

export const PROJECT_COLORS = ['#7c5cff', '#228be6', '#12b886', '#fab005', '#fa5252', '#e64980', '#15aabf', '#868e96'];

export const CLIP_TYPES = ['text', 'highlight', 'image', 'link', 'note', 'page'];

export const DEFAULT_SETTINGS = {
  activeProjectId: null,
  autoRestore: false,
  showToolbar: true,
  highlightsToProject: true,
  defaultColor: 'yellow',
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src)$/i;

/** Canonical page key: no hash, no tracking params, no trailing slash on the path. */
export function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return String(href || '').split('#')[0];
  }
}

// ---------- serialization ----------
let chain = Promise.resolve();
export function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const get = async keys => chrome.storage.local.get(keys);
const set = async obj => chrome.storage.local.set(obj);
const remove = async keys => chrome.storage.local.remove(keys);

// ---------- reading ----------
/** Parse a full storage snapshot into typed collections. */
export function parseSnapshot(all) {
  const projects = [];
  const clips = [];
  const pages = [];
  for (const [k, v] of Object.entries(all || {})) {
    if (!v || typeof v !== 'object') continue;
    if (k.startsWith('project:')) projects.push(v);
    else if (k.startsWith('clip:')) clips.push(v);
    else if (k.startsWith('page:')) pages.push(v);
  }
  projects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  clips.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  pages.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { projects, clips, pages, settings: { ...DEFAULT_SETTINGS, ...(all.settings || {}) } };
}

export async function snapshot() {
  return parseSnapshot(await get(null));
}

export async function getSettings() {
  const { settings } = await get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function getPage(url) {
  const key = 'page:' + normalizeUrl(url);
  const r = await get(key);
  return r[key] || { url: normalizeUrl(url), title: '', highlights: [], stickies: [], updatedAt: 0 };
}

// ---------- writing (call through locked() from the service worker) ----------
export async function setSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch };
  await set({ settings: next });
  return next;
}

export async function ensureDefaults() {
  const snap = await snapshot();
  let settings = snap.settings;
  if (!snap.projects.length) {
    const p = await createProject({ name: 'Inbox' });
    settings = await setSettings({ activeProjectId: p.id });
  } else if (!snap.projects.some(p => p.id === settings.activeProjectId)) {
    settings = await setSettings({ activeProjectId: snap.projects[0].id });
  } else {
    await set({ settings });
  }
  return settings;
}

export async function activeProjectId() {
  const s = await getSettings();
  if (s.activeProjectId) {
    const k = 'project:' + s.activeProjectId;
    if ((await get(k))[k]) return s.activeProjectId;
  }
  return (await ensureDefaults()).activeProjectId;
}

export async function createProject({ name, color }) {
  const snap = await snapshot();
  const now = Date.now();
  const p = {
    id: uid(),
    name: (name || 'Untitled project').trim().slice(0, 120) || 'Untitled project',
    color: color || PROJECT_COLORS[snap.projects.length % PROJECT_COLORS.length],
    order: snap.projects.length ? Math.max(...snap.projects.map(x => x.order ?? 0)) + 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  await set({ ['project:' + p.id]: p });
  return p;
}

export async function updateProject(id, patch) {
  const k = 'project:' + id;
  const cur = (await get(k))[k];
  if (!cur) throw new Error('Project not found');
  const next = { ...cur, ...patch, id, updatedAt: Date.now() };
  if (typeof next.name === 'string') next.name = next.name.trim().slice(0, 120) || cur.name;
  await set({ [k]: next });
  return next;
}

/** Delete a project. Its clips move to `moveTo` if given, otherwise they are deleted (with their highlights). */
export async function deleteProject(id, moveTo) {
  const snap = await snapshot();
  if (snap.projects.length <= 1) throw new Error('You need at least one project.');
  const clips = snap.clips.filter(c => c.projectId === id);
  if (moveTo && snap.projects.some(p => p.id === moveTo)) {
    const upd = {};
    for (const c of clips) upd['clip:' + c.id] = { ...c, projectId: moveTo, updatedAt: Date.now() };
    await set(upd);
  } else {
    for (const c of clips) await deleteClip(c.id);
  }
  await remove('project:' + id);
  if (snap.settings.activeProjectId === id) {
    await setSettings({ activeProjectId: snap.projects.find(p => p.id !== id).id });
  }
}

export async function createClip(data) {
  const now = Date.now();
  const projectId = data.projectId || (await activeProjectId());
  const c = {
    id: uid(),
    projectId,
    type: CLIP_TYPES.includes(data.type) ? data.type : 'text',
    title: String(data.title || '').slice(0, 300),
    content: String(data.content || ''),
    comment: String(data.comment || ''),
    url: data.url || '',
    pageTitle: String(data.pageTitle || '').slice(0, 300),
    tags: cleanTags(data.tags),
    color: data.color || '',
    highlightId: data.highlightId || '',
    order: typeof data.order === 'number' ? data.order : -now,
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
  await set({ ['clip:' + c.id]: c });
  return c;
}

export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (let t of tags) {
    t = String(t).trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export async function updateClip(id, patch) {
  const k = 'clip:' + id;
  const cur = (await get(k))[k];
  if (!cur) throw new Error('Clip not found');
  const next = { ...cur, ...patch, id, updatedAt: Date.now() };
  if (patch.tags) next.tags = cleanTags(patch.tags);
  await set({ [k]: next });
  // Keep the page highlight in sync with its clip.
  if (cur.type === 'highlight' && cur.highlightId && cur.url && ('comment' in patch || 'color' in patch)) {
    const page = await getPage(cur.url);
    const h = page.highlights.find(x => x.id === cur.highlightId);
    if (h) {
      if ('comment' in patch) h.comment = next.comment;
      if ('color' in patch) h.color = next.color;
      await savePage(page);
    }
  }
  return next;
}

export async function deleteClip(id, { keepHighlight = false } = {}) {
  const k = 'clip:' + id;
  const cur = (await get(k))[k];
  await remove(k);
  if (cur && cur.type === 'highlight' && cur.highlightId && cur.url && !keepHighlight) {
    const page = await getPage(cur.url);
    const before = page.highlights.length;
    page.highlights = page.highlights.filter(h => h.id !== cur.highlightId);
    if (page.highlights.length !== before) await savePage(page);
  }
}

export async function savePage(page) {
  const key = 'page:' + normalizeUrl(page.url);
  if (!page.highlights.length && !page.stickies.length) {
    await remove(key);
    return null;
  }
  page.updatedAt = Date.now();
  await set({ [key]: page });
  return page;
}

export async function addHighlight({ url, title, highlight }) {
  const page = await getPage(url);
  if (title) page.title = title;
  const s = await getSettings();
  const h = {
    id: highlight.id || uid(),
    color: COLOR_HEX[highlight.color] ? highlight.color : s.defaultColor,
    quote: highlight.quote,
    position: highlight.position,
    comment: highlight.comment || '',
    createdAt: Date.now(),
    clipId: '',
  };
  if (s.highlightsToProject) {
    const clip = await createClip({
      type: 'highlight',
      content: h.quote.exact,
      comment: h.comment,
      color: h.color,
      url: page.url,
      pageTitle: page.title,
      highlightId: h.id,
    });
    h.clipId = clip.id;
  }
  page.highlights.push(h);
  await savePage(page);
  return h;
}

export async function updateHighlight({ url, id, patch }) {
  const page = await getPage(url);
  const h = page.highlights.find(x => x.id === id);
  if (!h) throw new Error('Highlight not found');
  for (const k of ['color', 'comment']) if (k in patch) h[k] = patch[k];
  await savePage(page);
  if (h.clipId) {
    const ck = 'clip:' + h.clipId;
    const clip = (await get(ck))[ck];
    if (clip) await set({ [ck]: { ...clip, color: h.color, comment: h.comment, updatedAt: Date.now() } });
  }
  return h;
}

export async function deleteHighlight({ url, id }) {
  const page = await getPage(url);
  const h = page.highlights.find(x => x.id === id);
  page.highlights = page.highlights.filter(x => x.id !== id);
  await savePage(page);
  if (h && h.clipId) await remove('clip:' + h.clipId);
}

export async function upsertSticky({ url, title, sticky }) {
  const page = await getPage(url);
  if (title && !page.title) page.title = title;
  const i = page.stickies.findIndex(s => s.id === sticky.id);
  const now = Date.now();
  if (i >= 0) page.stickies[i] = { ...page.stickies[i], ...sticky, updatedAt: now };
  else page.stickies.push({
    id: sticky.id || uid(), text: '', color: 'yellow', x: 80, y: 120, w: 240, h: 180, collapsed: false,
    createdAt: now, ...sticky, updatedAt: now,
  });
  await savePage(page);
  return page.stickies.find(s => s.id === (sticky.id || page.stickies[page.stickies.length - 1].id));
}

export async function deleteSticky({ url, id }) {
  const page = await getPage(url);
  page.stickies = page.stickies.filter(s => s.id !== id);
  await savePage(page);
}

export async function deletePage(url) {
  const page = await getPage(url);
  for (const h of page.highlights) if (h.clipId) await remove('clip:' + h.clipId);
  await remove('page:' + normalizeUrl(url));
}

// ---------- import / export ----------
export const EXPORT_FORMAT = 'research-canvas';

export async function exportJSON(projectId) {
  const snap = await snapshot();
  const projects = projectId ? snap.projects.filter(p => p.id === projectId) : snap.projects;
  const clips = projectId ? snap.clips.filter(c => c.projectId === projectId) : snap.clips;
  let pages = snap.pages;
  if (projectId) {
    const urls = new Set(clips.map(c => c.url).filter(Boolean));
    pages = pages.filter(p => urls.has(p.url)).map(p => ({
      ...p,
      highlights: p.highlights.filter(h => !h.clipId || clips.some(c => c.id === h.clipId)),
    }));
  }
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    scope: projectId ? 'project' : 'all',
    projects,
    clips,
    pages,
    settings: projectId ? undefined : snap.settings,
  };
}

/** Merge an export into local data. Records with the same id are kept if the local copy is newer. */
export async function importJSON(data) {
  if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.projects)) {
    throw new Error('This file is not a Research Canvas export.');
  }
  const all = await get(null);
  const out = {};
  const stats = { projects: 0, clips: 0, highlights: 0, stickies: 0 };
  const newer = (incoming, local) => !local || (incoming.updatedAt || 0) >= (local.updatedAt || 0);
  for (const p of data.projects) {
    if (!p || !p.id || !p.name) continue;
    const k = 'project:' + p.id;
    if (newer(p, all[k])) { out[k] = { ...p }; stats.projects++; }
  }
  const projectIds = new Set([...Object.keys(all), ...Object.keys(out)].filter(k => k.startsWith('project:')).map(k => k.slice(8)));
  for (const c of data.clips || []) {
    if (!c || !c.id || !projectIds.has(c.projectId)) continue;
    const k = 'clip:' + c.id;
    if (newer(c, all[k])) {
      out[k] = { ...c, tags: cleanTags(c.tags), type: CLIP_TYPES.includes(c.type) ? c.type : 'text' };
      stats.clips++;
    }
  }
  for (const p of data.pages || []) {
    if (!p || !p.url) continue;
    const k = 'page:' + normalizeUrl(p.url);
    const local = all[k] || { url: normalizeUrl(p.url), title: p.title || '', highlights: [], stickies: [] };
    const merged = { ...local, highlights: [...local.highlights], stickies: [...local.stickies] };
    for (const h of p.highlights || []) {
      if (h && h.id && h.quote && !merged.highlights.some(x => x.id === h.id)) { merged.highlights.push(h); stats.highlights++; }
    }
    for (const s of p.stickies || []) {
      if (s && s.id && !merged.stickies.some(x => x.id === s.id)) { merged.stickies.push(s); stats.stickies++; }
    }
    merged.updatedAt = Math.max(local.updatedAt || 0, p.updatedAt || 0) || Date.now();
    out[k] = merged;
  }
  await set(out);
  await ensureDefaults();
  return stats;
}
