// Citation style formatters: APA 7, MLA 9, Chicago 17 (author-date and notes-bibliography), Harvard
// (Cite Them Right), IEEE. Every formatter returns HTML (with <i> for italics); use htmlToText for plain text.
import {
  esc, htmlToText, punct, italic, quoted, titleCase, sentenceCase, shortTitle,
  parseDate, formatDate, yearOf, pageRange, ordinal, bareUrl, collapse, capFirst,
} from './text.js';
import { initials, fullName, invertedName, familyName } from './names.js';
import { doiUrl } from './identifiers.js';

export const STYLES = [
  { id: 'apa', label: 'APA 7th', short: 'APA' },
  { id: 'mla', label: 'MLA 9th', short: 'MLA' },
  { id: 'chicago-ad', label: 'Chicago 17th (author-date)', short: 'Chicago AD' },
  { id: 'chicago-nb', label: 'Chicago 17th (notes-bibliography)', short: 'Chicago NB' },
  { id: 'harvard', label: 'Harvard (Cite Them Right)', short: 'Harvard' },
  { id: 'ieee', label: 'IEEE', short: 'IEEE' },
];
export const STYLE_IDS = STYLES.map(s => s.id);
export const STYLE_LABELS = Object.fromEntries(STYLES.map(s => [s.id, s.label]));

const AUTHOR_DATE = new Set(['apa', 'harvard', 'chicago-ad']);
// Types whose title is italicized as a standalone work.
const STANDALONE = new Set(['book', 'webpage', 'video', 'report']);

const e = s => esc(collapse(s));

function pagesLabel(pages, { single = 'p.', multi = 'pp.' } = {}) {
  const p = pageRange(pages);
  if (!p) return '';
  return (/[–,]/.test(p) ? multi : single) + ' ' + esc(p);
}

function link(item) {
  return item.doi ? doiUrl(item.doi) : collapse(item.url);
}

function sameText(a, b) {
  return !!a && !!b && collapse(a).toLowerCase() === collapse(b).toLowerCase();
}

/** Join a list of names: "A, B, and C" with configurable connector and serial comma. */
function joinNames(names, { and = 'and', serial = true } = {}) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} ${and} ${names[1]}`;
  return names.slice(0, -1).join(', ') + (serial ? ',' : '') + ` ${and} ` + names[names.length - 1];
}

function editorTag(list, one, many) {
  return list.length > 1 ? many : one;
}

// ======================================================= APA 7

function apaName(n) {
  if (n.literal) return e(n.literal);
  const ini = initials(n.given);
  return e(n.family + (ini ? ', ' + ini : '') + (n.suffix ? ', ' + n.suffix : ''));
}

export function apaAuthors(list) {
  const names = list.map(apaName);
  const n = names.length;
  if (!n) return '';
  if (n === 1) return names[0];
  if (n <= 20) return names.slice(0, -1).join(', ') + ', &amp; ' + names[n - 1];
  return names.slice(0, 19).join(', ') + ', . . . ' + names[n - 1];
}

function apaEditorsNatural(list) {
  const names = list.map(n => (n.literal ? e(n.literal) : e([initials(n.given), n.family].filter(Boolean).join(' '))));
  return joinNames(names, { and: '&amp;', serial: names.length > 2 });
}

function apaDate(item, opts) {
  const withDay = item.type === 'webpage' || item.type === 'video';
  const d = withDay ? formatDate(item.date, 'apa') : yearOf(item.date);
  const sfx = opts.yearSuffix || '';
  return d ? (withDay && sfx ? d.replace(/^(\d{4})/, `$1${sfx}`) : d + sfx) : 'n.d.' + (sfx ? '-' + sfx : '');
}

function apa(item, opts) {
  const sc = opts.sentenceCase === false ? t => collapse(t) : t => sentenceCase(t);
  const T = e(sc(item.title || 'Untitled'));
  const type = item.type;
  const authors = item.authors || [];
  let authorStr = apaAuthors(authors);
  if (!authorStr && type === 'book' && item.editors?.length) {
    authorStr = apaAuthors(item.editors) + editorTag(item.editors, ' (Ed.)', ' (Eds.)');
  }
  const authorPlain = htmlToText(authorStr);
  let titlePart;
  let source = '';
  switch (type) {
    case 'article-journal': {
      titlePart = T;
      let s = italic(e(item.container));
      if (item.volume) s += (s ? ', ' : '') + italic(e(item.volume));
      if (item.issue) s += (item.volume ? '' : (s ? ', ' : '')) + `(${e(item.issue)})`;
      if (item.pages) s += (s ? ', ' : '') + esc(pageRange(item.pages));
      source = s;
      break;
    }
    case 'book': {
      const bits = [];
      if (item.edition) bits.push(/^\d+$/.test(item.edition) ? `${ordinal(item.edition)} ed.` : e(item.edition));
      if (item.volume) bits.push(`Vol. ${e(item.volume)}`);
      titlePart = italic(T) + (bits.length ? ` (${bits.join(', ')})` : '');
      source = sameText(item.publisher, authorPlain) ? '' : e(item.publisher);
      break;
    }
    case 'chapter': {
      titlePart = T;
      const eds = item.editors?.length ? apaEditorsNatural(item.editors) + editorTag(item.editors, ' (Ed.), ', ' (Eds.), ') : '';
      const bits = [];
      if (item.edition) bits.push(/^\d+$/.test(item.edition) ? `${ordinal(item.edition)} ed.` : e(item.edition));
      if (item.pages) bits.push(pagesLabel(item.pages));
      let s = `In ${eds}${italic(e(sc(item.container)))}`;
      if (bits.length) s += ` (${bits.join(', ')})`;
      s = punct(s);
      if (item.publisher) s += ' ' + e(item.publisher);
      source = s;
      break;
    }
    case 'video':
      titlePart = italic(T) + ' [Video]';
      source = e(item.container || item.publisher);
      if (sameText(source, authorPlain)) source = '';
      break;
    case 'report':
      titlePart = italic(T) + (item.number ? ` (${/^\d/.test(item.number) ? 'Report No. ' : ''}${e(item.number)})` : '');
      source = sameText(item.publisher, authorPlain) ? '' : e(item.publisher || item.container);
      break;
    case 'webpage':
    default:
      titlePart = italic(T);
      source = sameText(item.container, authorPlain) ? '' : e(item.container);
      break;
  }
  const date = `(${apaDate(item, opts)}).`;
  const segs = authorStr ? [punct(authorStr), date, punct(titlePart)] : [punct(titlePart), date];
  if (source) segs.push(punct(source));
  const l = link(item);
  if (l) segs.push(esc(l));
  return segs.join(' ');
}

function apaInText(item, opts) {
  const who = authorDateNames(item, { and: '&amp;', etAl: 3, titleWrap: t => (STANDALONE.has(item.type) ? italic(t) : quoted(t)) });
  const y = yearOf(item.date);
  const sfx = opts.yearSuffix || '';
  const date = y ? y + sfx : 'n.d.' + (sfx ? '-' + sfx : '');
  return `(${who}, ${date}${opts.locator ? ', ' + esc(locatorText(opts.locator)) : ''})`;
}

function locatorText(loc) {
  const s = collapse(loc);
  if (/^[a-z]/i.test(s)) return s;
  return (/[-–,]/.test(s) ? 'pp. ' : 'p. ') + pageRange(s);
}

/** Author part of an author-date in-text citation. */
function authorDateNames(item, { and, etAl, serial = false, maxListed = 2, titleWrap }) {
  const list = item.authors?.length ? item.authors : (item.type === 'book' && item.editors?.length ? item.editors : []);
  const fam = list.map(n => e(familyName(n)));
  if (!fam.length) return titleWrap(e(titleCase(shortTitle(item.title || 'Untitled'))));
  if (fam.length >= etAl) return `${fam[0]} et al.`;
  if (fam.length <= maxListed || fam.length < etAl) return joinNames(fam, { and, serial });
  return `${fam[0]} et al.`;
}

// ======================================================= MLA 9

export function mlaAuthors(list) {
  if (!list.length) return '';
  if (list.length === 1) return e(invertedName(list[0]));
  if (list.length === 2) return `${e(invertedName(list[0]))}, and ${e(fullName(list[1]))}`;
  return `${e(invertedName(list[0]))}, et al.`;
}

function mlaNatural(list) {
  const names = list.map(n => e(fullName(n)));
  if (names.length > 2) return `${names[0]} et al.`;
  return joinNames(names);
}

function mla(item, opts) {
  const T = e(titleCase(item.title || 'Untitled'));
  const type = item.type;
  const authors = item.authors || [];
  const head = authors.length ? punct(mlaAuthors(authors)) : '';
  const selfContained = type === 'book' || type === 'report';
  const titlePart = selfContained ? punct(italic(T)) : quoted(T, '.');
  const date = formatDate(item.date, 'mla');
  const year = yearOf(item.date);
  const els = [];
  switch (type) {
    case 'article-journal':
      els.push(italic(e(item.container)), item.volume && `vol. ${e(item.volume)}`, item.issue && `no. ${e(item.issue)}`, date, pagesLabel(item.pages));
      break;
    case 'book':
      els.push(item.edition && (/^\d+$/.test(item.edition) ? `${ordinal(item.edition)} ed.` : e(item.edition)),
        item.volume && `vol. ${e(item.volume)}`, e(item.publisher), year);
      break;
    case 'chapter':
      els.push(italic(e(item.container)), item.editors?.length && `edited by ${mlaNatural(item.editors)}`,
        item.edition && (/^\d+$/.test(item.edition) ? `${ordinal(item.edition)} ed.` : e(item.edition)),
        e(item.publisher), year, pagesLabel(item.pages));
      break;
    case 'video':
      els.push(italic(e(item.container)), item.publisher && !sameText(item.publisher, fullName(authors[0] || {})) && `uploaded by ${e(item.publisher)}`, date);
      break;
    case 'report':
      els.push(e(item.publisher), date || year);
      break;
    case 'webpage':
    default:
      els.push(italic(e(item.container)), !sameText(item.publisher, item.container) && e(item.publisher), date);
      break;
  }
  const l = item.doi ? doiUrl(item.doi) : bareUrl(item.url);
  if (l) els.push(esc(l));
  const body = els.filter(Boolean).join(', ');
  const segs = [head, titlePart];
  if (body) segs.push(punct(body));
  if (!item.date && item.accessed && (type === 'webpage' || type === 'video' || (!item.doi && item.url))) {
    segs.push(`Accessed ${formatDate(item.accessed, 'mla')}.`);
  }
  return segs.filter(Boolean).join(' ');
}

function mlaInText(item, opts) {
  const list = item.authors || [];
  const fam = list.map(n => e(familyName(n)));
  let who;
  if (!fam.length) {
    const st = e(titleCase(shortTitle(item.title || 'Untitled')));
    who = STANDALONE.has(item.type) && item.type !== 'webpage' && item.type !== 'video' ? italic(st) : quoted(st);
  } else if (fam.length === 1) who = fam[0];
  else if (fam.length === 2) who = `${fam[0]} and ${fam[1]}`;
  else who = `${fam[0]} et al.`;
  const loc = opts.locator ? ' ' + esc(pageRange(opts.locator)) : '';
  return `(${who}${loc})`;
}

// ======================================================= Chicago 17

export function chicagoBibAuthors(list) {
  const n = list.length;
  if (!n) return '';
  const first = e(invertedName(list[0]));
  if (n === 1) return first;
  if (n > 10) return [first, ...list.slice(1, 7).map(x => e(fullName(x)))].join(', ') + ', et al.';
  const rest = list.slice(1).map(x => e(fullName(x)));
  if (n === 2) return `${first}, and ${rest[0]}`;
  return `${first}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`;
}

function chicagoNoteAuthors(list) {
  const names = list.map(n => e(fullName(n)));
  if (names.length > 3) return `${names[0]} et al.`;
  return joinNames(names);
}

function chicagoShortAuthors(list) {
  const fam = list.map(n => e(familyName(n)));
  if (fam.length > 3) return `${fam[0]} et al.`;
  return joinNames(fam);
}

function chicagoEditors(list) {
  return list.map(n => e(fullName(n))).length > 3 ? `${e(fullName(list[0]))} et al.` : joinNames(list.map(n => e(fullName(n))));
}

function placePub(item) {
  const pub = e(item.publisher);
  const place = e(item.place);
  if (place && pub) return `${place}: ${pub}`;
  return pub || place;
}

function editionText(item) {
  if (!item.edition) return '';
  return /^\d+$/.test(item.edition) ? `${ordinal(item.edition)} ed.` : e(item.edition);
}

function chicagoAD(item, opts) {
  const T = e(titleCase(item.title || 'Untitled'));
  const type = item.type;
  const authors = item.authors || [];
  let A = chicagoBibAuthors(authors);
  if (!A && type === 'book' && item.editors?.length) A = chicagoBibAuthors(item.editors) + editorTag(item.editors, ', ed', ', eds');
  const year = (yearOf(item.date) || 'n.d.') + (opts.yearSuffix || '');
  const segs = [];
  const titlePart = STANDALONE.has(type) && type !== 'webpage' && type !== 'video' ? punct(italic(T)) : quoted(T, '.');
  if (A) segs.push(punct(A), punct(year), titlePart);
  else segs.push(titlePart, punct(year));
  const usDate = formatDate(item.date, 'us');
  switch (type) {
    case 'article-journal': {
      let s = italic(e(item.container));
      if (item.volume) s += ' ' + e(item.volume);
      if (item.issue) s += ` (${e(item.issue)})`;
      if (item.pages) s += (item.volume || item.issue ? ': ' : ', ') + esc(pageRange(item.pages));
      if (s) segs.push(punct(s));
      break;
    }
    case 'book':
      if (editionText(item)) segs.push(punct(editionText(item)));
      if (placePub(item)) segs.push(punct(placePub(item)));
      break;
    case 'chapter': {
      let s = `In ${italic(e(item.container))}`;
      if (item.editors?.length) s += `, edited by ${chicagoEditors(item.editors)}`;
      if (item.pages) s += ', ' + esc(pageRange(item.pages));
      segs.push(punct(s));
      if (placePub(item)) segs.push(punct(placePub(item)));
      break;
    }
    case 'video':
      segs.push(punct(`${e(item.container) || 'Online'} video${usDate && /,|\s/.test(usDate) ? ', ' + usDate : ''}`));
      break;
    case 'report':
      if (item.number) segs.push(punct(e(item.number)));
      if (placePub(item)) segs.push(punct(placePub(item)));
      break;
    case 'webpage':
    default:
      if (item.container) segs.push(punct(e(item.container)));
      if (usDate && /\s/.test(usDate)) segs.push(punct(usDate));
      break;
  }
  if (!item.date && item.accessed && !item.doi && item.url) segs.push(`Accessed ${formatDate(item.accessed, 'us')}.`);
  const l = link(item);
  if (l) segs.push(esc(l) + '.');
  return segs.join(' ');
}

function chicagoADInText(item, opts) {
  const list = item.authors?.length ? item.authors : (item.type === 'book' ? item.editors || [] : []);
  let who;
  if (!list.length) {
    const st = e(titleCase(shortTitle(item.title || 'Untitled')));
    who = STANDALONE.has(item.type) && item.type !== 'webpage' && item.type !== 'video' ? italic(st) : quoted(st);
  } else who = chicagoShortAuthors(list);
  const year = (yearOf(item.date) || 'n.d.') + (opts.yearSuffix || '');
  return `(${who} ${year}${opts.locator ? ', ' + esc(pageRange(opts.locator)) : ''})`;
}

function chicagoNB(item) {
  const T = e(titleCase(item.title || 'Untitled'));
  const type = item.type;
  const authors = item.authors || [];
  let A = chicagoBibAuthors(authors);
  if (!A && type === 'book' && item.editors?.length) A = chicagoBibAuthors(item.editors) + editorTag(item.editors, ', ed', ', eds');
  const year = yearOf(item.date) || 'n.d.';
  const segs = [];
  if (A) segs.push(punct(A));
  const usDate = formatDate(item.date, 'us');
  switch (type) {
    case 'article-journal': {
      segs.push(quoted(T, '.'));
      let s = italic(e(item.container));
      if (item.volume) s += ' ' + e(item.volume);
      if (item.issue) s += `${item.volume ? ',' : ''} no. ${e(item.issue)}`;
      s += ` (${year})`;
      if (item.pages) s += ': ' + esc(pageRange(item.pages));
      segs.push(punct(s.trim()));
      break;
    }
    case 'book':
      segs.push(punct(italic(T)));
      if (editionText(item)) segs.push(punct(editionText(item)));
      segs.push(punct([placePub(item), year].filter(Boolean).join(', ')));
      break;
    case 'chapter': {
      segs.push(quoted(T, '.'));
      let s = `In ${italic(e(item.container))}`;
      if (item.editors?.length) s += `, edited by ${chicagoEditors(item.editors)}`;
      if (item.pages) s += ', ' + esc(pageRange(item.pages));
      segs.push(punct(s));
      segs.push(punct([placePub(item), year].filter(Boolean).join(', ')));
      break;
    }
    case 'video':
      segs.push(quoted(T, '.'));
      segs.push(punct(`${e(item.container) || 'Online'} video${usDate ? ', ' + usDate : ''}`));
      break;
    case 'report':
      segs.push(punct(italic(T)));
      if (item.number) segs.push(punct(e(item.number)));
      segs.push(punct([placePub(item), year].filter(Boolean).join(', ')));
      break;
    case 'webpage':
    default:
      segs.push(quoted(T, '.'));
      if (item.container) segs.push(punct(e(item.container)));
      if (usDate) segs.push(punct(usDate));
      break;
  }
  if (!item.date && item.accessed && !item.doi && item.url) segs.push(`Accessed ${formatDate(item.accessed, 'us')}.`);
  const l = link(item);
  if (l) segs.push(esc(l) + '.');
  return segs.join(' ');
}

/** Chicago full footnote (first reference). */
export function chicagoFullNote(item) {
  const T = e(titleCase(item.title || 'Untitled'));
  const type = item.type;
  const A = chicagoNoteAuthors(item.authors || []);
  const year = yearOf(item.date) || 'n.d.';
  const usDate = formatDate(item.date, 'us');
  const parts = [];
  if (A) parts.push(A);
  const pubParen = () => `(${[placePub(item), year].filter(Boolean).join(', ')})`;
  switch (type) {
    case 'article-journal': {
      parts.push(quoted(T, ','));
      let s = italic(e(item.container));
      if (item.volume) s += ' ' + e(item.volume);
      if (item.issue) s += `${item.volume ? ',' : ''} no. ${e(item.issue)}`;
      s += ` (${year})`;
      if (item.pages) s += ': ' + esc(pageRange(item.pages));
      parts.push(s.trim());
      break;
    }
    case 'book':
      parts.push(`${italic(T)}${editionText(item) ? ', ' + editionText(item) : ''} ${pubParen()}`);
      break;
    case 'chapter': {
      parts.push(quoted(T, ','));
      let s = `in ${italic(e(item.container))}`;
      if (item.editors?.length) s += `, ed. ${chicagoEditors(item.editors)}`;
      s += ' ' + pubParen();
      if (item.pages) s += ', ' + esc(pageRange(item.pages));
      parts.push(s);
      break;
    }
    case 'video':
      parts.push(quoted(T, ','));
      parts.push(`${e(item.container) || 'Online'} video${usDate ? ', ' + usDate : ''}`);
      break;
    case 'report':
      parts.push(`${italic(T)}${item.number ? ', ' + e(item.number) : ''} ${pubParen()}`);
      break;
    case 'webpage':
    default:
      parts.push(quoted(T, ','));
      if (item.container) parts.push(e(item.container));
      if (usDate) parts.push(usDate);
      else if (item.accessed) parts.push(`accessed ${formatDate(item.accessed, 'us')}`);
      break;
  }
  const l = link(item);
  if (l) parts.push(esc(l));
  // Quoted titles already carry their comma inside the quotes.
  let out = '';
  parts.forEach((p, i) => {
    if (i === 0) { out = p; return; }
    out += /[,?!]”$/.test(out) ? ' ' + p : ', ' + p;
  });
  return punct(out);
}

function chicagoNBInText(item) {
  const list = item.authors || [];
  const st = e(titleCase(shortTitle(item.title || 'Untitled')));
  const t = STANDALONE.has(item.type) && item.type !== 'webpage' && item.type !== 'video' ? punct(italic(st)) : quoted(st, '.');
  return list.length ? `${chicagoShortAuthors(list)}, ${t}` : t;
}

// ======================================================= Harvard (Cite Them Right)

function harvardName(n) {
  if (n.literal) return e(n.literal);
  const ini = initials(n.given, { space: false });
  return e(n.family + (ini ? ', ' + ini : ''));
}

export function harvardAuthors(list) {
  const names = list.map(harvardName);
  if (names.length >= 4) return `${names[0]} et al.`;
  return joinNames(names, { serial: false });
}

function harvardAvailable(item) {
  if (item.doi) return `Available at: ${esc(doiUrl(item.doi))}.`;
  if (!item.url) return '';
  const acc = item.accessed ? ` (Accessed: ${formatDate(item.accessed, 'uk')})` : '';
  return `Available at: ${esc(item.url)}${acc}.`;
}

function harvard(item, opts) {
  const T = e(capFirst(collapse(item.title || 'Untitled')));
  const type = item.type;
  let A = harvardAuthors(item.authors || []);
  if (!A && type === 'book' && item.editors?.length) A = harvardAuthors(item.editors) + editorTag(item.editors, ' (ed.)', ' (eds.)');
  const year = (yearOf(item.date) || 'no date') + (opts.yearSuffix || '');
  const isQuoted = type === 'article-journal' || type === 'chapter';
  const titleHtml = isQuoted ? quoted(T, '', '‘', '’') : italic(T);
  let head;
  if (A) head = `${A} (${year}) ${titleHtml}`;
  else head = `${titleHtml} (${year})`;
  const segs = [];
  switch (type) {
    case 'article-journal': {
      let s = head;
      if (item.container) s += ', ' + italic(e(item.container));
      if (item.volume) s += ', ' + e(item.volume) + (item.issue ? `(${e(item.issue)})` : '');
      else if (item.issue) s += `, (${e(item.issue)})`;
      if (item.pages) s += ', ' + pagesLabel(item.pages);
      segs.push(punct(s));
      break;
    }
    case 'book': {
      segs.push(punct(head));
      if (item.edition) segs.push(/^\d+$/.test(item.edition) ? `${ordinal(item.edition)} edn.` : punct(e(item.edition)));
      if (placePub(item)) segs.push(punct(placePub(item)));
      break;
    }
    case 'chapter': {
      let s = head + ', in ';
      if (item.editors?.length) s += harvardAuthors(item.editors) + editorTag(item.editors, ' (ed.) ', ' (eds) ');
      s += italic(e(item.container));
      segs.push(punct(s));
      const pp = [placePub(item), pagesLabel(item.pages)].filter(Boolean).join(', ');
      if (pp) segs.push(punct(pp));
      break;
    }
    case 'video':
      segs.push(punct(head + ' [Video]'));
      if (item.container) segs.push(punct(e(item.container)));
      break;
    case 'report':
      segs.push(punct(head));
      if (item.number) segs.push(punct(e(item.number)));
      if (placePub(item)) segs.push(punct(placePub(item)));
      break;
    case 'webpage':
    default:
      segs.push(punct(head));
      if (item.container && !sameText(item.container, htmlToText(A))) segs.push(punct(e(item.container)));
      break;
  }
  const av = harvardAvailable(item);
  if (av) segs.push(av);
  return segs.join(' ');
}

function harvardInText(item, opts) {
  const list = item.authors?.length ? item.authors : (item.type === 'book' ? item.editors || [] : []);
  const fam = list.map(n => e(familyName(n)));
  let who;
  if (!fam.length) who = italic(e(shortTitle(item.title || 'Untitled')));
  else if (fam.length >= 4) who = `${fam[0]} et al.`;
  else who = joinNames(fam, { serial: false });
  const year = (yearOf(item.date) || 'no date') + (opts.yearSuffix || '');
  return `(${who}, ${year}${opts.locator ? ', ' + pagesLabel(opts.locator) : ''})`;
}

// ======================================================= IEEE

function ieeeName(n) {
  if (n.literal) return e(n.literal);
  const ini = initials(n.given);
  return e([ini, n.family].filter(Boolean).join(' ') + (n.suffix ? ', ' + n.suffix : ''));
}

export function ieeeAuthors(list) {
  if (!list.length) return '';
  if (list.length > 6) return `${ieeeName(list[0])} <i>et al.</i>`;
  return joinNames(list.map(ieeeName), { serial: true });
}

function ieee(item) {
  const T = e(capFirst(collapse(item.title || 'Untitled')));
  const TT = e(titleCase(item.title || 'Untitled'));
  const type = item.type;
  const A = ieeeAuthors(item.authors || []);
  const year = yearOf(item.date);
  const p = parseDate(item.date);
  const monthYear = p ? formatDate({ y: p.y, m: p.m }, 'ieee') : '';
  const fullDate = formatDate(item.date, 'ieee');
  const accessed = item.accessed ? `Accessed: ${formatDate(item.accessed, 'ieee')}.` : '';
  const head = A ? A + ', ' : '';
  const ed = item.edition ? (/^\d+$/.test(item.edition) ? `${ordinal(item.edition)} ed.` : e(item.edition)) : '';
  const online = item.url ? `[Online]. Available: ${esc(item.url)}` : '';
  switch (type) {
    case 'article-journal': {
      const bits = [italic(e(item.container)), item.volume && `vol. ${e(item.volume)}`, item.issue && `no. ${e(item.issue)}`,
        item.pages && pagesLabel(item.pages, { single: /^\d+$/.test(collapse(item.pages)) ? 'p.' : 'Art. no.' }), monthYear];
      let s = head + quoted(T, ',') + ' ' + bits.filter(Boolean).join(', ');
      if (item.doi) s += `, doi: ${esc(item.doi)}.`;
      else { s = punct(s); if (online) s += ' ' + online; }
      return s;
    }
    case 'book': {
      let s = head + italic(TT) + (ed ? ', ' + ed : '');
      s = punct(s);
      const pub = [placePub(item), year].filter(Boolean).join(', ');
      if (pub) s += ' ' + punct(pub);
      if (item.doi) s += ` doi: ${esc(item.doi)}.`;
      return s;
    }
    case 'chapter': {
      let s = head + quoted(T, ',') + ' in ' + italic(e(titleCase(item.container)));
      if (ed) s += ', ' + ed;
      if (item.editors?.length) s += ', ' + joinNames(item.editors.map(ieeeName)) + editorTag(item.editors, ', Ed', ', Eds');
      s = punct(s);
      const pub = [placePub(item), year, item.pages && pagesLabel(item.pages)].filter(Boolean).join(', ');
      if (pub) s += ' ' + punct(pub);
      if (item.doi) s += ` doi: ${esc(item.doi)}.`;
      return s;
    }
    case 'report': {
      const bits = [e(item.publisher), e(item.place), item.number ? `Rep. ${e(item.number)}` : 'Tech. Rep.', fullDate || year];
      let s = punct(head + quoted(T, ',') + ' ' + bits.filter(Boolean).join(', '));
      if (item.doi) s += ` doi: ${esc(item.doi)}.`;
      else if (online) s += (accessed ? ' ' + accessed : '') + ' ' + online;
      return s;
    }
    case 'video': {
      let s = head + quoted(T, ',') + ' ' + punct([e(item.container), fullDate].filter(Boolean).join(', ') || 'Online video');
      if (accessed) s += ' ' + accessed;
      if (item.url) s += ` [Online Video]. Available: ${esc(item.url)}`;
      return s;
    }
    case 'webpage':
    default: {
      let s = head + quoted(T, ',') + ' ' + punct([e(item.container), fullDate].filter(Boolean).join(', ') || 'Online');
      if (accessed) s += ' ' + accessed;
      if (online) s += ' ' + online;
      return s;
    }
  }
}

// ======================================================= public API

const FORMATTERS = { apa, mla, 'chicago-ad': chicagoAD, 'chicago-nb': chicagoNB, harvard, ieee };

/** Format a single reference-list entry. Returns {html, text}. */
export function formatCitation(item, style = 'apa', opts = {}) {
  const fn = FORMATTERS[style] || apa;
  let html = fn(normalizeForFormat(item), opts).replace(/\s+/g, ' ').trim();
  if (style === 'ieee' && opts.number) html = `[${opts.number}] ${html}`;
  return { html, text: htmlToText(html) };
}

/** In-text (parenthetical) citation, or short note for Chicago notes-bibliography. */
export function formatInText(item, style = 'apa', opts = {}) {
  const it = normalizeForFormat(item);
  let html;
  switch (style) {
    case 'mla': html = mlaInText(it, opts); break;
    case 'chicago-ad': html = chicagoADInText(it, opts); break;
    case 'chicago-nb': html = chicagoNBInText(it, opts); break;
    case 'harvard': html = harvardInText(it, opts); break;
    case 'ieee': html = `[${opts.number || 1}]`; break;
    case 'apa':
    default: html = apaInText(it, opts); break;
  }
  return { html, text: htmlToText(html) };
}

/** Full first-reference footnote (Chicago NB); other styles fall back to the in-text form. */
export function formatNote(item, style = 'chicago-nb', opts = {}) {
  if (style !== 'chicago-nb') return formatInText(item, style, opts);
  const html = chicagoFullNote(normalizeForFormat(item));
  return { html, text: htmlToText(html) };
}

function normalizeForFormat(item) {
  return {
    ...item,
    authors: (item.authors || []).filter(n => n && (n.literal || n.family || n.given)),
    editors: (item.editors || []).filter(n => n && (n.literal || n.family || n.given)),
  };
}

const LEADING_ARTICLE = /^(the|a|an)\s+/i;

export function sortKey(item) {
  const list = item.authors?.length ? item.authors : (item.editors || []);
  const who = list.length ? list.map(n => (n.literal || `${n.family} ${n.given || ''}`)).join(' ') : collapse(item.title).replace(LEADING_ARTICLE, '');
  return who.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Sort entries the way the style expects (alphabetical; IEEE keeps the given order). */
export function sortForStyle(items, style, sort = 'auto') {
  const arr = items.slice();
  const by = (fn, dir = 1) => arr.sort((a, b) => dir * fn(a, b));
  const cmpStr = (x, y) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
  const titleK = it => collapse(it.title).replace(LEADING_ARTICLE, '').toLowerCase();
  const dateK = it => String(it.date || '');
  const mode = sort === 'auto' ? (style === 'ieee' ? 'added' : 'author') : sort;
  switch (mode) {
    case 'added': return by((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));
    case 'added-desc': return by((a, b) => (b.order ?? b.createdAt ?? 0) - (a.order ?? a.createdAt ?? 0));
    case 'title': return by((a, b) => cmpStr(titleK(a), titleK(b)));
    case 'date': return by((a, b) => cmpStr(dateK(a), dateK(b)) || cmpStr(sortKey(a), sortKey(b)));
    case 'date-desc': return by((a, b) => cmpStr(dateK(b), dateK(a)) || cmpStr(sortKey(a), sortKey(b)));
    case 'author':
    default: return by((a, b) => cmpStr(sortKey(a), sortKey(b)) || cmpStr(yearOf(a.date) || '9999', yearOf(b.date) || '9999') || cmpStr(titleK(a), titleK(b)));
  }
}

/** Year-suffix letters (2020a, 2020b) for identical author lists + year, author-date styles only. */
export function yearSuffixes(items, style) {
  const out = new Map();
  if (!AUTHOR_DATE.has(style)) return out;
  const groups = new Map();
  for (const it of items) {
    const k = sortKey(it) + '|' + (yearOf(it.date) || 'nd');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.slice().sort((a, b) => collapse(a.title).localeCompare(collapse(b.title)))
      .forEach((it, i) => out.set(it.id, String.fromCharCode(97 + (i % 26))));
  }
  return out;
}

/**
 * Format a whole bibliography.
 * Returns {entries:[{id, html, text, inText}], html, text}. `html` uses hanging indents suitable for
 * pasting into word processors.
 */
export function formatBibliography(items, style = 'apa', opts = {}) {
  const sorted = sortForStyle(items, style, opts.sort || 'auto');
  const sfx = yearSuffixes(sorted, style);
  const entries = sorted.map((it, i) => {
    const o = { ...opts, yearSuffix: sfx.get(it.id) || '', number: style === 'ieee' ? i + 1 : undefined };
    const c = formatCitation(it, style, o);
    const t = formatInText(it, style, o);
    return { id: it.id, html: c.html, text: c.text, inText: t, number: i + 1 };
  });
  const hanging = style !== 'ieee';
  const pStyle = hanging
    ? 'margin:0 0 0.5em 0;padding-left:0.5in;text-indent:-0.5in;line-height:1.6'
    : 'margin:0 0 0.5em 0;line-height:1.6';
  const html = entries.map(en => `<p style="${pStyle}">${en.html}</p>`).join('\n');
  const text = entries.map(en => en.text).join('\n\n');
  return { entries, html, text };
}

export function bibliographyHeading(style) {
  switch (style) {
    case 'mla': return 'Works Cited';
    case 'apa': return 'References';
    case 'ieee': return 'References';
    case 'harvard': return 'Reference list';
    default: return 'Bibliography';
  }
}
