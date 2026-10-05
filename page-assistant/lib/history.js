// Page Assistant: per-URL history of summaries and answers in chrome.storage.local.
const INDEX = 'pa:index';
const PREFIX = 'pa:h:';
const MAX_PAGES = 300;
const MAX_PER_PAGE = 20;
const MAX_TEXT = 30000;

/** Normalize a URL so tracking params and fragments do not split history. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|ref_src|igshid|si$)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch (e) {
    return String(url || '');
  }
}

const store = () => (globalThis.chrome && chrome.storage && chrome.storage.local) || null;

async function getIndex() {
  const s = store();
  if (!s) return [];
  const r = await s.get(INDEX);
  return Array.isArray(r[INDEX]) ? r[INDEX] : [];
}

export async function addEntry(url, title, entry) {
  const s = store();
  if (!s || !url) return null;
  const key = normalizeUrl(url);
  const k = PREFIX + key;
  const r = await s.get(k);
  const list = Array.isArray(r[k]) ? r[k] : [];
  const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now(), ...entry, text: String(entry.text || '').slice(0, MAX_TEXT) };
  list.unshift(e);
  const index = (await getIndex()).filter((p) => p.url !== key);
  index.unshift({ url: key, title: title || key, updatedAt: e.createdAt, count: Math.min(list.length, MAX_PER_PAGE) });
  const removed = index.splice(MAX_PAGES);
  await s.set({ [k]: list.slice(0, MAX_PER_PAGE), [INDEX]: index });
  if (removed.length) await s.remove(removed.map((p) => PREFIX + p.url));
  return e;
}

export async function getEntries(url) {
  const s = store();
  if (!s || !url) return [];
  const k = PREFIX + normalizeUrl(url);
  const r = await s.get(k);
  return Array.isArray(r[k]) ? r[k] : [];
}

export async function listPages() { return getIndex(); }

export async function deleteEntry(url, id) {
  const s = store();
  const key = normalizeUrl(url);
  const list = (await getEntries(key)).filter((e) => e.id !== id);
  const index = await getIndex();
  if (list.length) {
    const i = index.findIndex((p) => p.url === key);
    if (i >= 0) index[i].count = list.length;
    await s.set({ [PREFIX + key]: list, [INDEX]: index });
  } else {
    await s.remove(PREFIX + key);
    await s.set({ [INDEX]: index.filter((p) => p.url !== key) });
  }
}

export async function deletePage(url) {
  const s = store();
  const key = normalizeUrl(url);
  await s.remove(PREFIX + key);
  await s.set({ [INDEX]: (await getIndex()).filter((p) => p.url !== key) });
}

export async function clearAll() {
  const s = store();
  const index = await getIndex();
  await s.remove([INDEX, ...index.map((p) => PREFIX + p.url)]);
}

/** Markdown export for one entry. */
export function entryToMarkdown(entry, { title, url } = {}) {
  const date = new Date(entry.createdAt || Date.now()).toISOString().slice(0, 10);
  const meta = [entry.label || entry.kind, entry.engine, date].filter(Boolean).join(' · ');
  const head = `# ${title || 'Untitled page'}\n\n${url ? `<${url}>\n\n` : ''}_${meta}_\n\n`;
  const q = entry.question ? `**Q:** ${entry.question}\n\n` : '';
  return head + q + String(entry.text || '').trim() + '\n';
}
