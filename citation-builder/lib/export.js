// Machine-readable exports (BibTeX, RIS) and document exports (HTML, plain text).
import { parseDate, collapse, esc } from './text.js';
import { formatBibliography, bibliographyHeading, STYLE_LABELS } from './formatters.js';

const BIB_TYPES = { 'article-journal': 'article', book: 'book', chapter: 'incollection', report: 'techreport', webpage: 'misc', video: 'misc' };
const BIB_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'at', 'by']);

function ascii(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '');
}

export function bibtexEscape(s) {
  return collapse(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}&%$#_])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\\textbackslash\\\{\\\}/g, '\\textbackslash{}')
    .replace(/\\textasciitilde\\\{\\\}/g, '\\textasciitilde{}')
    .replace(/\\textasciicircum\\\{\\\}/g, '\\textasciicircum{}');
}

/** Protect words with capitals beyond the first letter (acronyms, proper nouns like iPhone) with braces. */
function protectCase(s) {
  return bibtexEscape(s).split(/(\s+)/).map(w => (/[A-Z]/.test(w.slice(1)) && !w.startsWith('\\') ? `{${w}}` : w)).join('');
}

function bibNames(list) {
  return list.map(n => (n.literal ? `{${bibtexEscape(n.literal)}}` : bibtexEscape([n.family, n.suffix, n.given].filter(Boolean).join(', ')))).join(' and ');
}

export function citeKey(item) {
  const first = (item.authors && item.authors[0]) || (item.editors && item.editors[0]);
  const who = !first ? 'anon'
    : first.literal ? ascii(collapse(first.literal).split(/\s+/).find(w => !STOP.has(w.toLowerCase())) || '').toLowerCase()
      : ascii((first.family || '').split(/\s+/).pop()).toLowerCase();
  const p = parseDate(item.date);
  const word = collapse(item.title).split(/\s+/).map(w => ascii(w).toLowerCase()).find(w => w && !STOP.has(w)) || '';
  return (who || 'anon') + (p ? p.y : 'nd') + word;
}

export function toBibtex(items) {
  const used = new Map();
  return items.map(item => {
    let key = citeKey(item);
    if (used.has(key)) {
      const n = used.get(key) + 1;
      used.set(key, n);
      key += String.fromCharCode(96 + n);
    } else used.set(key, 1);
    const type = BIB_TYPES[item.type] || 'misc';
    const f = [];
    const add = (k, v, raw = false) => { if (v) f.push(`  ${k} = {${raw ? v : bibtexEscape(v)}}`); };
    if (item.authors?.length) add('author', bibNames(item.authors), true);
    if (item.editors?.length) add('editor', bibNames(item.editors), true);
    if (item.title) add('title', protectCase(item.title), true);
    if (type === 'article') add('journal', item.container);
    if (type === 'incollection') add('booktitle', protectCase(item.container), true);
    if (type === 'techreport') { add('institution', item.publisher || item.container); add('number', item.number); }
    if (type === 'misc' && item.container) add('howpublished', item.container);
    const p = parseDate(item.date);
    if (p) {
      add('year', String(p.y));
      if (p.m) f.push(`  month = ${BIB_MONTHS[p.m - 1]}`);
      add('date', collapse(item.date));
    }
    add('volume', item.volume);
    add('number', type === 'article' ? item.issue : '');
    if (item.pages) add('pages', collapse(item.pages).replace(/\s*(?:-+|–|—)\s*/g, '--'));
    add('edition', item.edition);
    if (type !== 'techreport') add('publisher', item.publisher);
    add('address', item.place);
    add('isbn', item.isbn);
    add('doi', item.doi, true);
    if (item.url) add('url', item.url, true);
    if (item.accessed) {
      add('urldate', item.accessed, true);
      if (type === 'misc') add('note', `Accessed: ${item.accessed}`);
    }
    return `@${type}{${key},\n${f.join(',\n')}\n}`;
  }).join('\n\n') + '\n';
}

const RIS_TYPES = { 'article-journal': 'JOUR', book: 'BOOK', chapter: 'CHAP', report: 'RPRT', webpage: 'ELEC', video: 'VIDEO' };

function risDate(s) {
  const p = parseDate(s);
  if (!p) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${p.y}/${p.m ? pad(p.m) : ''}/${p.d ? pad(p.d) : ''}/`;
}

export function toRis(items) {
  const out = [];
  for (const item of items) {
    const L = [];
    const add = (tag, v) => { if (v) L.push(`${tag}  - ${collapse(v)}`); };
    add('TY', RIS_TYPES[item.type] || 'GEN');
    for (const a of item.authors || []) add('AU', a.literal || [a.family, a.given, a.suffix].filter(Boolean).join(', '));
    for (const a of item.editors || []) add('ED', a.literal || [a.family, a.given, a.suffix].filter(Boolean).join(', '));
    add('TI', item.title);
    if (item.type === 'article-journal') add('JO', item.container);
    add('T2', item.container);
    add('VL', item.volume);
    add('IS', item.issue);
    if (item.pages) {
      const [sp, ep] = collapse(item.pages).split(/\s*(?:-+|–|—)\s*/);
      add('SP', sp);
      add('EP', ep);
    }
    add('ET', item.edition);
    add('M1', item.number);
    add('PB', item.publisher);
    add('CY', item.place);
    const p = parseDate(item.date);
    if (p) add('PY', String(p.y));
    add('DA', risDate(item.date));
    add('Y2', risDate(item.accessed));
    add('SN', item.isbn);
    add('DO', item.doi);
    add('UR', item.url);
    L.push('ER  - ');
    out.push(L.join('\r\n'));
  }
  return out.join('\r\n\r\n') + '\r\n';
}

export function toPlainText(items, style, opts = {}) {
  const bib = formatBibliography(items, style, opts);
  const lines = bib.entries.map(en => en.text);
  return (opts.heading ? bibliographyHeading(style) + '\n\n' : '') + lines.join('\n\n') + '\n';
}

export function toHtmlDocument(items, style, { title = 'Bibliography', ...opts } = {}) {
  const bib = formatBibliography(items, style, opts);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 2; max-width: 7.5in; margin: 1in auto; padding: 0 16px; color: #111; }
  h1 { font-size: 12pt; text-align: center; font-weight: ${style === 'apa' ? 'bold' : 'normal'}; margin: 0 0 12pt; }
  p { margin: 0 0 0 0 !important; line-height: 2 !important; }
  footer { margin-top: 2em; font: 10pt system-ui, sans-serif; color: #666; }
</style>
</head>
<body>
<h1>${esc(bibliographyHeading(style))}</h1>
${bib.html}
<footer>${esc(title)} &middot; ${esc(STYLE_LABELS[style] || style)} &middot; ${items.length} source${items.length === 1 ? '' : 's'}</footer>
</body>
</html>
`;
}
