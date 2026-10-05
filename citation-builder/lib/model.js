// Citation item model shared by the popup, manager, background and formatters.
import { collapse, normalizeDate } from './text.js';
import { cleanDoi, cleanIsbn } from './identifiers.js';

export const TYPES = [
  { id: 'article-journal', label: 'Journal article' },
  { id: 'webpage', label: 'Web page' },
  { id: 'book', label: 'Book' },
  { id: 'chapter', label: 'Book chapter' },
  { id: 'video', label: 'Video' },
  { id: 'report', label: 'Report' },
];

export const TYPE_LABELS = Object.fromEntries(TYPES.map(t => [t.id, t.label]));

/**
 * Field definitions. `types` lists the item types that show the field; `label` may vary per type.
 */
export const FIELDS = [
  { key: 'title', label: { default: 'Title', chapter: 'Chapter title', webpage: 'Page title' }, types: '*', wide: true },
  { key: 'container', label: { 'article-journal': 'Journal', webpage: 'Website name', chapter: 'Book title', video: 'Platform / website', report: 'Series' }, types: ['article-journal', 'webpage', 'chapter', 'video', 'report'], wide: true },
  { key: 'volume', label: 'Volume', types: ['article-journal', 'book'] },
  { key: 'issue', label: 'Issue', types: ['article-journal'] },
  { key: 'pages', label: { default: 'Pages', 'article-journal': 'Pages / article no.' }, types: ['article-journal', 'chapter'] },
  { key: 'edition', label: 'Edition', types: ['book', 'chapter'] },
  { key: 'number', label: 'Report number', types: ['report'] },
  { key: 'publisher', label: { default: 'Publisher', report: 'Institution / publisher', webpage: 'Publisher (if different)', video: 'Channel / publisher' }, types: ['webpage', 'book', 'chapter', 'report', 'video'] },
  { key: 'place', label: 'Place of publication', types: ['book', 'chapter', 'report'] },
  { key: 'date', label: 'Published', types: '*', type: 'date' },
  { key: 'accessed', label: 'Accessed', types: '*', type: 'date' },
  { key: 'url', label: 'URL', types: '*', wide: true, type: 'url' },
  { key: 'doi', label: 'DOI', types: ['article-journal', 'book', 'chapter', 'report'] },
  { key: 'isbn', label: 'ISBN', types: ['book', 'chapter'] },
];

export function fieldLabel(f, type) {
  if (typeof f.label === 'string') return f.label;
  return f.label[type] || f.label.default || f.key;
}

export function fieldVisible(f, type) {
  return f.types === '*' || f.types.includes(type);
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function blankItem(extra = {}) {
  return {
    type: 'webpage', authors: [], editors: [], title: '', container: '', volume: '', issue: '', pages: '',
    edition: '', number: '', publisher: '', place: '', date: '', accessed: '', url: '', doi: '', isbn: '',
    ...extra,
  };
}

function cleanNames(list) {
  return (Array.isArray(list) ? list : [])
    .map(n => (n && n.literal ? { literal: collapse(n.literal) } : n ? { given: collapse(n.given), family: collapse(n.family), ...(n.suffix ? { suffix: collapse(n.suffix) } : {}) } : null))
    .filter(n => n && (n.literal || n.family || n.given));
}

/** Trim strings, normalize identifiers and dates, drop empty names. Keeps id/projectId/timestamps. */
export function cleanItem(item) {
  const out = blankItem();
  for (const k of Object.keys(out)) {
    if (k === 'authors' || k === 'editors') out[k] = cleanNames(item[k]);
    else if (item[k] != null) out[k] = collapse(String(item[k]));
  }
  if (!TYPE_LABELS[out.type]) out.type = 'webpage';
  if (out.doi) out.doi = cleanDoi(out.doi) || out.doi;
  if (out.isbn) out.isbn = cleanIsbn(out.isbn) || out.isbn;
  if (out.date) out.date = normalizeDate(out.date);
  if (out.accessed) out.accessed = normalizeDate(out.accessed);
  for (const k of ['id', 'projectId', 'createdAt', 'updatedAt', 'order']) if (item[k] != null) out[k] = item[k];
  return out;
}

// ---------- duplicates ----------

function normUrl(u) {
  return String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function normTitle(t) {
  return String(t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Returns a reason string when two items look like the same work, else ''. */
export function duplicateReason(a, b) {
  if (a.doi && b.doi && a.doi.toLowerCase() === b.doi.toLowerCase()) return 'same DOI';
  if (a.isbn && b.isbn && a.isbn === b.isbn) return 'same ISBN';
  const ta = normTitle(a.title), tb = normTitle(b.title);
  if (a.url && b.url && normUrl(a.url) === normUrl(b.url) && (!ta || !tb || ta === tb)) return 'same URL';
  if (ta && ta.length > 8 && ta === tb) {
    const ya = String(a.date || '').slice(0, 4), yb = String(b.date || '').slice(0, 4);
    if (!ya || !yb || ya === yb) return 'same title';
  }
  return '';
}

/** Map id -> [{id, reason}] of likely duplicates within a list. */
export function findDuplicates(items) {
  const map = new Map();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const r = duplicateReason(items[i], items[j]);
      if (!r) continue;
      if (!map.has(items[i].id)) map.set(items[i].id, []);
      if (!map.has(items[j].id)) map.set(items[j].id, []);
      map.get(items[i].id).push({ id: items[j].id, reason: r });
      map.get(items[j].id).push({ id: items[i].id, reason: r });
    }
  }
  return map;
}
