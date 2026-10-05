// OPTIONAL online metadata lookup (off by default). Only runs when the user enables it in Options,
// which also grants the optional host permissions below. Uses free, keyless public APIs.
import { blankItem, cleanItem } from './model.js';
import { collapse, normalizeDate } from './text.js';
import { parseName } from './names.js';

export const LOOKUP_ORIGINS = ['https://api.crossref.org/*', 'https://openlibrary.org/*', 'https://export.arxiv.org/*'];

export async function hasLookupPermission() {
  try { return await chrome.permissions.contains({ origins: LOOKUP_ORIGINS }); } catch { return false; }
}

async function getJson(url, timeout = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const stripTags = s => collapse(String(s || '').replace(/<[^>]+>/g, ''));

const CROSSREF_TYPES = {
  'journal-article': 'article-journal', 'proceedings-article': 'article-journal', 'book': 'book', 'monograph': 'book',
  'edited-book': 'book', 'reference-book': 'book', 'book-chapter': 'chapter', 'book-section': 'chapter', 'book-part': 'chapter',
  'reference-entry': 'chapter', 'report': 'report', 'posted-content': 'report', 'dissertation': 'report', 'standard': 'report',
};

function crossrefNames(list) {
  return (list || []).map(a => (a.family ? { given: collapse(a.given), family: collapse(a.family) } : a.name ? { literal: collapse(a.name) } : null)).filter(Boolean);
}

export function fromCrossref(msg) {
  const item = blankItem();
  item.type = CROSSREF_TYPES[msg.type] || 'article-journal';
  item.title = stripTags([msg.title?.[0], msg.subtitle?.[0]].filter(Boolean).join(': '));
  item.authors = crossrefNames(msg.author);
  item.editors = crossrefNames(msg.editor);
  item.container = stripTags(msg['container-title']?.[0] || '');
  item.volume = msg.volume || '';
  item.issue = msg.issue || '';
  item.pages = msg.page || msg['article-number'] || '';
  item.publisher = msg.publisher || '';
  item.place = msg['publisher-location'] || '';
  const parts = (msg.issued || msg['published-print'] || msg['published-online'] || msg.created)?.['date-parts']?.[0];
  if (parts && parts[0]) item.date = parts.map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('-');
  item.doi = msg.DOI || '';
  item.isbn = msg.ISBN?.[0] || '';
  item.url = msg.DOI ? 'https://doi.org/' + msg.DOI : (msg.URL || '');
  if (item.type === 'report' && msg.institution?.[0]?.name) item.publisher = msg.institution[0].name;
  if (msg.type === 'posted-content' && msg.subtype === 'preprint' && !item.publisher) item.publisher = 'Preprint';
  return cleanItem(item);
}

export async function lookupDoi(doi) {
  const data = await getJson('https://api.crossref.org/works/' + encodeURIComponent(doi));
  if (!data?.message) throw new Error('DOI not found');
  return fromCrossref(data.message);
}

export function fromOpenLibrary(rec, isbn) {
  const item = blankItem({ type: 'book', isbn });
  item.title = collapse([rec.title, rec.subtitle].filter(Boolean).join(': '));
  item.authors = (rec.authors || []).map(a => parseName(a.name)).filter(Boolean);
  item.publisher = rec.publishers?.[0]?.name || '';
  item.place = rec.publish_places?.[0]?.name || '';
  item.date = normalizeDate(rec.publish_date || '');
  item.url = rec.url || '';
  return cleanItem(item);
}

export async function lookupIsbn(isbn) {
  const key = 'ISBN:' + isbn;
  const data = await getJson(`https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`);
  if (!data?.[key]) throw new Error('ISBN not found');
  return fromOpenLibrary(data[key], isbn);
}

/** Parse the arXiv Atom feed with regular expressions (no DOMParser in the service worker). */
export function fromArxivAtom(xml, id) {
  const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!entry) throw new Error('arXiv ID not found');
  const tag = t => stripTags((entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
  const item = blankItem({ type: 'report', publisher: 'arXiv', number: 'arXiv:' + id, doi: '10.48550/arXiv.' + id, url: 'https://arxiv.org/abs/' + id });
  item.title = tag('title');
  if (!item.title || /^Error$/i.test(item.title)) throw new Error('arXiv ID not found');
  item.authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(m => parseName(stripTags(m[1]))).filter(Boolean);
  item.date = normalizeDate(tag('published'));
  const jref = tag('arxiv:journal_ref');
  const doi = tag('arxiv:doi');
  if (doi) { item.doi = doi; item.type = 'article-journal'; item.publisher = ''; item.number = ''; item.container = jref.replace(/[\s,]*\d.*$/, '') || ''; }
  return cleanItem(item);
}

export async function lookupArxiv(id) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch('https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id), { signal: ctl.signal });
    if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
    return fromArxivAtom(await res.text(), id);
  } finally { clearTimeout(t); }
}

export async function lookupIdentifier(id) {
  if (!id) throw new Error('No identifier');
  if (id.kind === 'doi') return lookupDoi(id.value);
  if (id.kind === 'isbn') return lookupIsbn(id.value);
  if (id.kind === 'arxiv') return lookupArxiv(id.value);
  throw new Error('Unsupported identifier');
}

/** Overlay looked-up metadata on an item: non-empty lookup values win, the item's URL/access date are kept if the lookup has none. */
export function mergeLookup(item, found) {
  const out = { ...item };
  for (const [k, v] of Object.entries(found)) {
    if (Array.isArray(v)) { if (v.length) out[k] = v; } else if (v) out[k] = v;
  }
  if (!found.accessed) out.accessed = item.accessed;
  return out;
}
