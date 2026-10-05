// Turns raw page signals (from extract-page.js) into a citation item.
// Priority: Highwire/Google Scholar citation_* > schema.org JSON-LD > Dublin Core > OpenGraph > generic fallbacks.
import { collapse, normalizeDate, todayISO } from './text.js';
import { parseNames, parseName, looksLikeOrg } from './names.js';
import { cleanDoi, findDois, cleanIsbn, findArxiv, cleanArxiv } from './identifiers.js';
import { blankItem, cleanItem } from './model.js';

// ---------- meta helpers ----------

function metaIndex(metas) {
  const map = new Map();
  for (const [k, v] of metas || []) {
    const key = String(k).toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(collapse(v));
  }
  return {
    get: (...keys) => { for (const k of keys) { const v = map.get(k.toLowerCase()); if (v && v[0]) return v[0]; } return ''; },
    all: (...keys) => { for (const k of keys) { const v = map.get(k.toLowerCase()); if (v && v.length) return v.filter(Boolean); } return []; },
    has: prefix => [...map.keys()].some(k => k.startsWith(prefix)),
    values: () => [...map.values()].flat(),
  };
}

const isUrl = s => /^(https?:)?\/\//i.test(String(s || '').trim());

// ---------- JSON-LD ----------

const LD_SCORES = {
  scholarlyarticle: 10, medicalscholarlyarticle: 10, book: 9, chapter: 9, videoobject: 8, report: 8, thesis: 8,
  newsarticle: 7, article: 7, blogposting: 7, techarticle: 7, reportagenewsarticle: 7, analysisnewsarticle: 7, opinionnewsarticle: 7, socialmediaposting: 5, creativework: 4,
  webpage: 3, itempage: 3, aboutpage: 2, collectionpage: 2,
};

function typesOf(node) {
  const t = node && node['@type'];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(x => String(x).replace(/^.*[/#]/, '').toLowerCase());
}

function flattenLd(data, out = [], depth = 0) {
  if (!data || depth > 6) return out;
  if (Array.isArray(data)) { data.forEach(d => flattenLd(d, out, depth + 1)); return out; }
  if (typeof data !== 'object') return out;
  if (data['@graph']) flattenLd(data['@graph'], out, depth + 1);
  if (data['@type']) out.push(data);
  if (data.mainEntity && typeof data.mainEntity === 'object') flattenLd(data.mainEntity, out, depth + 1);
  return out;
}

function parseJsonLd(blobs) {
  const nodes = [];
  for (const b of blobs || []) {
    try {
      flattenLd(JSON.parse(b), nodes);
    } catch {
      // Some sites emit invalid JSON (trailing commas, raw newlines in strings); try a light repair.
      try { flattenLd(JSON.parse(String(b).replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]+/g, ' ')), nodes); } catch { /* ignore */ }
    }
  }
  const byId = new Map(nodes.filter(n => n['@id']).map(n => [n['@id'], n]));
  return { nodes, byId };
}

function ldText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return ldText(v[0]);
  if (typeof v === 'object') return collapse(v.name || v['@value'] || v.headline || '');
  return collapse(String(v));
}

function deref(v, byId) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v['@id'] && Object.keys(v).length === 1 && byId.has(v['@id'])) return byId.get(v['@id']);
  return v;
}

function ldPersons(v, byId) {
  const out = [];
  for (let p of Array.isArray(v) ? v : [v]) {
    p = deref(p, byId);
    if (!p) continue;
    if (typeof p === 'string') { if (!isUrl(p)) out.push(...parseNames(p)); continue; }
    const types = typesOf(p);
    if (p.givenName || p.familyName) {
      out.push({ given: ldText(p.givenName), family: ldText(p.familyName) });
    } else if (p.name) {
      const name = ldText(p.name);
      if (!name || isUrl(name)) continue;
      if (types.includes('organization') || types.includes('newsmediaorganization') || types.includes('corporation')) out.push({ literal: name });
      else { const n = parseName(name); if (n) out.push(n); }
    }
  }
  return out;
}

function ldContainerChain(node, byId) {
  const out = { container: '', volume: '', issue: '' };
  let cur = deref(node.isPartOf, byId);
  for (let i = 0; cur && i < 5; i++) {
    if (Array.isArray(cur)) cur = deref(cur[0], byId);
    if (!cur || typeof cur !== 'object') { if (typeof cur === 'string' && !isUrl(cur) && !out.container) out.container = cur; break; }
    const t = typesOf(cur);
    if (t.includes('publicationissue')) out.issue = out.issue || ldText(cur.issueNumber);
    else if (t.includes('publicationvolume')) out.volume = out.volume || ldText(cur.volumeNumber);
    else if (cur.name && !out.container) out.container = ldText(cur.name);
    if (cur.issueNumber && !out.issue) out.issue = ldText(cur.issueNumber);
    if (cur.volumeNumber && !out.volume) out.volume = ldText(cur.volumeNumber);
    cur = deref(cur.isPartOf, byId);
  }
  return out;
}

function ldIdentifiers(node) {
  const vals = [];
  const push = v => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'object') push(v.value || v['@value'] || v['@id'] || v.url);
    else vals.push(String(v));
  };
  push(node.identifier); push(node.sameAs); push(node['@id']); push(node.doi); push(node.url);
  return vals;
}

function pickLdNode(nodes) {
  let best = null, score = 0;
  for (const n of nodes) {
    const s = Math.max(0, ...typesOf(n).map(t => LD_SCORES[t] || 0));
    if (s > score) { best = n; score = s; }
  }
  return best;
}

// ---------- title cleanup ----------

const SEP = /\s+(?:\||-|–|—|·|::|•|\/\/)\s+/;

export function cleanTitle(title, siteName, host) {
  let t = collapse(title);
  if (!t) return '';
  const parts = t.split(SEP);
  if (parts.length > 1) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const site = norm(siteName || '');
    const h = norm((host || '').replace(/^www\./, '').split('.')[0]);
    const last = norm(parts[parts.length - 1]);
    const first = norm(parts[0]);
    if (last && ((site && (site.includes(last) || last.includes(site))) || (h && (last.includes(h) || h.includes(last))))) {
      parts.pop();
      t = parts.join(' - ');
    } else if (first && parts.length > 1 && ((site && site === first) || (h && h === first))) {
      parts.shift();
      t = parts.join(' - ');
    }
  }
  return t.replace(/\s*\|\s*$/, '');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function siteFromHost(host) {
  const h = host.replace(/^www\d?\./, '');
  const known = {
    'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'm.youtube.com': 'YouTube', 'vimeo.com': 'Vimeo', 'ted.com': 'TED',
    'en.wikipedia.org': 'Wikipedia', 'arxiv.org': 'arXiv', 'github.com': 'GitHub', 'medium.com': 'Medium',
    'nytimes.com': 'The New York Times', 'theguardian.com': 'The Guardian', 'bbc.co.uk': 'BBC', 'bbc.com': 'BBC',
    'washingtonpost.com': 'The Washington Post', 'reuters.com': 'Reuters', 'nature.com': 'Nature', 'dailymotion.com': 'Dailymotion',
  };
  if (known[h]) return known[h];
  if (/\.wikipedia\.org$/.test(h)) return 'Wikipedia';
  return h;
}

export function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_src|igshid|_ga|si$|feature$)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return url || ''; }
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|ted\.com|twitch\.tv|bilibili\.com)$/;

// ---------- main ----------

/**
 * @param raw   object returned by collectPageData()
 * @returns {{item: object, sources: string[]}}
 */
export function normalizePage(raw, { now = new Date() } = {}) {
  const r = raw || {};
  const m = metaIndex(r.metas);
  const url = cleanUrl(r.url || '');
  const host = hostOf(url);
  const sources = [];
  const item = blankItem({ accessed: todayISO(now) });

  // --- Highwire / Google Scholar
  const hw = m.has('citation_');
  if (hw) sources.push('Highwire meta');
  // --- JSON-LD
  const { nodes, byId } = parseJsonLd(r.jsonld);
  const ld = pickLdNode(nodes);
  if (ld) sources.push('JSON-LD (' + (typesOf(ld)[0] || 'thing') + ')');
  const ldTypes = ld ? typesOf(ld) : [];
  // --- Dublin Core
  const dc = (...k) => m.get(...k.flatMap(x => [`dc.${x}`, `dcterms.${x}`, `dc:${x}`, `dcterms:${x}`]));
  const dcAll = (...k) => m.all(...k.flatMap(x => [`dc.${x}`, `dcterms.${x}`, `dc:${x}`, `dcterms:${x}`]));
  const hasDc = m.has('dc.') || m.has('dcterms.') || m.has('dc:') || m.has('dcterms:');
  if (hasDc) sources.push('Dublin Core');
  const hasOg = m.has('og:');
  if (hasOg) sources.push('OpenGraph');

  const siteName = m.get('og:site_name', 'application-name', 'citation_publisher') || (ld && ldText(deref(ld.publisher, byId))) || '';

  // --- title
  const ldTitle = ld ? ldText(ld.headline) || ldText(ld.name) : '';
  let title = m.get('citation_title', 'eprints.title', 'prism.title') || ldTitle || dc('title') ||
    m.get('og:title', 'twitter:title', 'title', 'parsely-title', 'sailthru.title') || (r.micro?.headline?.[0]) || '';
  const fromDocTitle = !title;
  if (!title) title = r.docTitle || r.h1 || '';
  title = cleanTitle(title, siteName, host);
  if (fromDocTitle && title) sources.push('Page title');
  item.title = title;

  // --- authors
  let authors = [];
  const hwAuthors = m.all('citation_author');
  if (hwAuthors.length) authors = parseNames(hwAuthors.flatMap(a => (a.includes(';') ? a.split(';') : [a])));
  if (!authors.length && m.get('citation_authors')) authors = parseNames(m.get('citation_authors'));
  if (!authors.length && ld) authors = ldPersons(ld.author || ld.creator, byId);
  if (!authors.length && dcAll('creator').length) authors = parseNames(dcAll('creator', 'creator.personalname'));
  if (!authors.length && r.micro?.author?.length) authors = parseNames(r.micro.author.filter(a => !isUrl(a)).slice(0, 20));
  if (!authors.length) {
    const metaAuthor = m.all('author', 'article:author', 'book:author', 'parsely-author', 'sailthru.author', 'byl', 'twitter:creator:name').filter(a => !isUrl(a) && !/^@/.test(a));
    if (metaAuthor.length) authors = parseNames(metaAuthor.length === 1 ? metaAuthor[0] : metaAuthor);
  }
  if (!authors.length && r.bylines?.length) authors = parseNames(r.bylines[0]);
  item.authors = authors.filter(a => !(a.literal && a.literal.length > 120)).slice(0, 100);

  // editors (chapters)
  const eds = m.all('citation_editor');
  if (eds.length) item.editors = parseNames(eds);
  else if (ld?.editor) item.editors = ldPersons(ld.editor, byId);

  // --- container, volume, issue, pages
  const chain = ld ? ldContainerChain(ld, byId) : { container: '', volume: '', issue: '' };
  const hwContainer = m.get('citation_journal_title', 'citation_conference_title', 'citation_inbook_title', 'citation_book_title', 'prism.publicationname', 'citation_series_title');
  item.container = hwContainer || chain.container || dc('source', 'ispartof') || siteName || '';
  item.volume = m.get('citation_volume', 'prism.volume') || chain.volume || (ld && ldText(ld.volumeNumber)) || '';
  item.issue = m.get('citation_issue', 'prism.number') || chain.issue || (ld && ldText(ld.issueNumber)) || '';
  const fp = m.get('citation_firstpage', 'prism.startingpage') || (ld && ldText(ld.pageStart));
  const lp = m.get('citation_lastpage', 'prism.endingpage') || (ld && ldText(ld.pageEnd));
  item.pages = fp ? (lp && lp !== fp ? `${fp}-${lp}` : fp) : (ld && ldText(ld.pagination)) || '';

  // --- publisher, place
  const ldPublisher = ld ? ldText(deref(ld.publisher, byId)) : '';
  item.publisher = m.get('citation_publisher', 'citation_technical_report_institution', 'citation_dissertation_institution', 'dc.publisher', 'dcterms.publisher') || ldPublisher || '';
  item.place = m.get('citation_publication_place') || '';
  item.number = m.get('citation_technical_report_number', 'citation_report_number') || '';
  item.edition = m.get('citation_edition') || (ld && ldText(ld.bookEdition)) || '';

  // --- date
  const dateRaw = m.get('citation_publication_date', 'citation_date', 'citation_cover_date', 'citation_online_date', 'citation_year', 'prism.publicationdate') ||
    (ld && (ldText(ld.datePublished) || ldText(ld.uploadDate) || ldText(ld.dateCreated))) ||
    dc('date', 'issued', 'created', 'date.issued') ||
    m.get('article:published_time', 'og:published_time', 'video:release_date', 'book:release_date', 'datepublished', 'date', 'pubdate', 'publishdate', 'publish-date', 'publication_date', 'sailthru.date', 'parsely-pub-date', 'article.published', 'dc.date.created') ||
    r.micro?.datePublished?.[0] || r.time ||
    (ld && ldText(ld.dateModified)) || m.get('article:modified_time', 'og:updated_time', 'last-modified', 'dcterms.modified') || r.micro?.dateModified?.[0] || '';
  item.date = normalizeDate(dateRaw);
  if (/\.wikipedia\.org$/.test(host) && ld && ld.dateModified) item.date = normalizeDate(ldText(ld.dateModified));

  // --- identifiers
  let doi = cleanDoi(m.get('citation_doi', 'prism.doi', 'bepress_citation_doi', 'dc.identifier.doi'));
  if (!doi) for (const v of dcAll('identifier')) { if (/^(doi:|https?:\/\/(dx\.)?doi\.org\/|10\.)/i.test(v)) { doi = cleanDoi(v); if (doi) break; } }
  if (!doi && ld) for (const v of ldIdentifiers(ld)) { if (/doi|^10\./i.test(v)) { doi = cleanDoi(v); if (doi) break; } }
  if (!doi && /doi/i.test(url)) doi = cleanDoi(url);
  if (!doi && /\/10\.\d{4,9}\//.test(url)) doi = cleanDoi(url);
  if (!doi) {
    const metaDois = m.values().filter(v => /(^doi:|doi\.org\/)10\./i.test(v));
    if (metaDois.length) doi = cleanDoi(metaDois[0]);
  }
  if (!doi && r.text) {
    // Use a DOI from the visible text only if it is labelled ("DOI: 10..." / doi.org link) and unique.
    const labelled = [...String(r.text).matchAll(/(?:\bdoi\b\s*:?\s*|doi\.org\/)(10\.\d{4,9}\/\S+)/gi)].map(x => cleanDoi(x[1])).filter(Boolean);
    const uniq = [...new Set(labelled.map(d => d.toLowerCase()))];
    if (uniq.length === 1) doi = labelled[0];
  }
  if (doi) { item.doi = doi; sources.push('DOI'); }

  let isbn = cleanIsbn(m.get('citation_isbn', 'book:isbn', 'isbn')) || (ld && cleanIsbn(ldText(ld.isbn)));
  if (!isbn) for (const v of dcAll('identifier')) { if (/isbn/i.test(v) || /^97[89]/.test(v)) { isbn = cleanIsbn(v); if (isbn) break; } }
  if (!isbn && ld?.workExample) isbn = cleanIsbn(ldText((Array.isArray(ld.workExample) ? ld.workExample[0] : ld.workExample)?.isbn));
  if (!isbn) { const um = url.match(/(?:isbn[=/:]|\/dp\/|\/product\/)(97[89]\d{10}|\d{9}[\dX])\b/i); if (um) isbn = cleanIsbn(um[1]); }
  if (isbn) { item.isbn = isbn; sources.push('ISBN'); }

  let arxiv = cleanArxiv(m.get('citation_arxiv_id')) || (/arxiv\.org$/.test(host) ? findArxiv(url) : '');
  if (!arxiv && doi && /^10\.48550\/arxiv\./i.test(doi)) arxiv = doi.replace(/^10\.48550\/arxiv\./i, '');

  // --- type
  let type = 'webpage';
  const ogType = m.get('og:type').toLowerCase();
  if (ldTypes.some(t => t === 'videoobject') || /^video/.test(ogType) || VIDEO_HOSTS.test(host)) type = 'video';
  else if (m.get('citation_technical_report_number', 'citation_technical_report_institution') || ldTypes.includes('report')) type = 'report';
  else if ((m.get('citation_inbook_title') || (m.get('citation_book_title') && m.get('citation_title'))) || ldTypes.includes('chapter')) type = 'chapter';
  else if (m.get('citation_journal_title', 'citation_conference_title', 'prism.publicationname') || ldTypes.includes('scholarlyarticle') || ldTypes.includes('medicalscholarlyarticle')) type = 'article-journal';
  else if (ldTypes.includes('book') || ogType === 'book' || (isbn && !hw) || (hw && isbn && !m.get('citation_journal_title'))) type = 'book';
  else if (hw && doi && item.container && !/^web/.test(ogType)) type = 'article-journal';
  if (ldTypes.includes('thesis') || m.get('citation_dissertation_institution')) type = 'report';

  if (arxiv) {
    type = 'report';
    item.number = 'arXiv:' + arxiv;
    item.publisher = 'arXiv';
    item.container = '';
    if (!item.doi) item.doi = '10.48550/arXiv.' + arxiv;
    if (!item.url) item.url = 'https://arxiv.org/abs/' + arxiv;
    sources.push('arXiv');
  }

  if (type === 'book') {
    // For books the "container" should be empty; site name goes nowhere, publisher stays.
    if (item.container && (item.container === siteName || item.container === hwContainer)) item.container = '';
  }
  if (type === 'chapter') item.container = m.get('citation_inbook_title', 'citation_book_title') || chain.container || item.container;
  if (type === 'video') {
    item.container = VIDEO_HOSTS.test(host) ? siteFromHost(host) : (siteName || siteFromHost(host));
    if (!item.authors.length && ld) item.authors = ldPersons(ld.author || ld.creator || ld.publisher, byId);
  }
  if (type === 'webpage' && !item.container) item.container = siteName || siteFromHost(host);
  if (type === 'webpage' && item.publisher && item.publisher === item.container) item.publisher = '';
  if (type === 'article-journal' && item.publisher && !hw) item.publisher = '';

  item.type = type;
  item.url = url && !/^(chrome|edge|about|brave|chrome-extension):/i.test(url) ? url : '';
  if (r.canonical && hostOf(r.canonical) === host && !/[?&](page|p)=/.test(url)) item.url = cleanUrl(r.canonical);
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(item.url) && item.doi) item.url = 'https://doi.org/' + item.doi;

  return { item: cleanItem(item), sources: [...new Set(sources)] };
}

/** Build a minimal item from a bare identifier (offline). */
export function itemFromIdentifier(id, { now = new Date() } = {}) {
  const item = blankItem({ accessed: todayISO(now) });
  if (!id) return item;
  if (id.kind === 'doi') {
    item.type = 'article-journal';
    item.doi = id.value;
    item.url = 'https://doi.org/' + id.value;
    if (/^10\.48550\/arxiv\./i.test(id.value)) return itemFromIdentifier({ kind: 'arxiv', value: id.value.replace(/^10\.48550\/arxiv\./i, '') }, { now });
  } else if (id.kind === 'isbn') {
    item.type = 'book';
    item.isbn = id.value;
  } else if (id.kind === 'arxiv') {
    item.type = 'report';
    item.publisher = 'arXiv';
    item.number = 'arXiv:' + id.value;
    item.doi = '10.48550/arXiv.' + id.value;
    item.url = 'https://arxiv.org/abs/' + id.value;
  }
  return item;
}

export { findDois, looksLikeOrg };
