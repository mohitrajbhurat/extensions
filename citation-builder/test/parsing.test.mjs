// Name, text, identifier and page-metadata parsing tests. Run: node --test citation-builder/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, parseNames, splitNames, initials } from '../lib/names.js';
import { titleCase, sentenceCase, parseDate, normalizeDate, formatDate, shortTitle } from '../lib/text.js';
import { cleanDoi, cleanIsbn, findIsbn, findArxiv, detectIdentifier } from '../lib/identifiers.js';
import { normalizePage, cleanTitle, itemFromIdentifier } from '../lib/normalize.js';
import { duplicateReason, findDuplicates } from '../lib/model.js';

test('parseName handles inverted, natural, particles, suffixes, PubMed style and organizations', () => {
  assert.deepEqual(parseName('Smith, John'), { given: 'John', family: 'Smith' });
  assert.deepEqual(parseName('Ludwig van Beethoven'), { given: 'Ludwig', family: 'van Beethoven' });
  assert.deepEqual(parseName('Martin Luther King Jr.'), { given: 'Martin Luther', family: 'King', suffix: 'Jr.' });
  assert.deepEqual(parseName('Smith JA'), { given: 'J. A.', family: 'Smith' });
  assert.deepEqual(parseName('By Dr. Jane Doe'), { given: 'Jane', family: 'Doe' });
  assert.deepEqual(parseName('World Health Organization'), { literal: 'World Health Organization' });
  assert.deepEqual(parseName('SMITH, JOHN'), { given: 'JOHN', family: 'Smith' });
});

test('splitNames handles and/&, semicolons, comma lists and inverted pairs', () => {
  assert.deepEqual(splitNames('Jane Doe and John Smith'), ['Jane Doe', 'John Smith']);
  assert.deepEqual(splitNames('Jane Doe, John Smith, and Kim Lee'), ['Jane Doe', 'John Smith', 'Kim Lee']);
  assert.deepEqual(splitNames('Smith, John'), ['Smith, John']);
  assert.deepEqual(splitNames('Smith, J.; Doe, K.'), ['Smith, J.', 'Doe, K.']);
  assert.deepEqual(splitNames('Smith, J., Doe, K.'), ['Smith, J.', 'Doe, K.']);
  assert.equal(parseNames('Jane Doe and Jane Doe').length, 1);
});

test('initials', () => {
  assert.equal(initials('John Ronald Reuel'), 'J. R. R.');
  assert.equal(initials('Jean-Paul'), 'J.-P.');
  assert.equal(initials('J.R.', { space: false }), 'J.R.');
  assert.equal(initials('Émile'), 'É.');
});

test('titleCase keeps minor words lower, capitalizes after colon and last word, preserves acronyms', () => {
  assert.equal(titleCase('the lord of the rings: the return of the king'), 'The Lord of the Rings: The Return of the King');
  assert.equal(titleCase('what are they looking at'), 'What Are They Looking At');
  assert.equal(titleCase('using DNA and iPhone data'), 'Using DNA and iPhone Data');
  assert.equal(titleCase('A SHOUTING TITLE IN CAPS'), 'A Shouting Title in Caps');
  assert.equal(titleCase('self-report measures in long-term care'), 'Self-Report Measures in Long-Term Care');
});

test('sentenceCase converts headline case but keeps acronyms and first word after colon', () => {
  assert.equal(sentenceCase('The Effects of COVID-19 on Learning: A Meta-Analysis'), 'The effects of COVID-19 on learning: A meta-analysis');
  assert.equal(sentenceCase('Evolution of Darwin’s finches'), 'Evolution of Darwin’s finches');
});

test('shortTitle drops leading article and trailing minor words', () => {
  assert.equal(shortTitle('The Art of Computer Programming'), 'Art of Computer Programming');
  assert.equal(shortTitle('Deep Learning for the Analysis of Things'), 'Deep Learning');
  assert.equal(shortTitle('Short: With Subtitle'), 'Short');
});

test('dates: parse many shapes and format per style', () => {
  assert.deepEqual(parseDate('2020-03-05T10:00:00Z'), { y: 2020, m: 3, d: 5 });
  assert.deepEqual(parseDate('March 5, 2020'), { y: 2020, m: 3, d: 5 });
  assert.deepEqual(parseDate('5 Mar. 2020'), { y: 2020, m: 3, d: 5 });
  assert.deepEqual(parseDate('2017/12/04'), { y: 2017, m: 12, d: 4 });
  assert.deepEqual(parseDate('Thu, 05 Mar 2020 10:00:00 GMT'), { y: 2020, m: 3, d: 5 });
  assert.equal(normalizeDate('Sept 2019'), '2019-09');
  assert.equal(formatDate('2020-09-05', 'mla'), '5 Sept. 2020');
  assert.equal(formatDate('2020-06-05', 'mla'), '5 June 2020');
  assert.equal(formatDate('2020-03-05', 'apa'), '2020, March 5');
  assert.equal(formatDate('2020-03-05', 'ieee'), 'Mar. 5, 2020');
  assert.equal(formatDate('2020', 'us'), '2020');
});

test('identifiers: DOI cleanup, ISBN checksum, arXiv', () => {
  assert.equal(cleanDoi('https://doi.org/10.1038/nature14539'), '10.1038/nature14539');
  assert.equal(cleanDoi('doi:10.1000/xyz123.'), '10.1000/xyz123');
  assert.equal(cleanDoi('(see 10.1000/abc(1)2)'), '10.1000/abc(1)2');
  assert.equal(cleanDoi('https://onlinelibrary.wiley.com/doi/full/10.1002/anie.201000001?af=R'), '10.1002/anie.201000001');
  assert.equal(cleanDoi('https://example.com/doi/10.1002/x.y/abstract'), '10.1002/x.y');
  assert.equal(cleanIsbn('978-0-262-03561-3'), '9780262035613');
  assert.equal(cleanIsbn('0-306-40615-2'), '0306406152');
  assert.equal(cleanIsbn('978-0-262-03561-4'), '');
  assert.equal(findIsbn('ISBN 978-0-262-03561-3 (hardcover)'), '9780262035613');
  assert.equal(findArxiv('https://arxiv.org/abs/1706.03762v5'), '1706.03762');
  assert.equal(findArxiv('arXiv:hep-th/9901001'), 'hep-th/9901001');
  assert.deepEqual(detectIdentifier('see arXiv:1706.03762'), { kind: 'arxiv', value: '1706.03762' });
  assert.deepEqual(detectIdentifier('ISBN 0306406152'), { kind: 'isbn', value: '0306406152' });
});

test('cleanTitle strips trailing site names', () => {
  assert.equal(cleanTitle('How Bees Navigate - The Daily Example', 'The Daily Example', 'dailyexample.com'), 'How Bees Navigate');
  assert.equal(cleanTitle('Some Page | GitHub', '', 'github.com'), 'Some Page');
  assert.equal(cleanTitle('A - B Testing Explained', '', 'blog.io'), 'A - B Testing Explained');
});

const meta = (k, v) => [k, v, ''];

test('normalizePage: Highwire tags win and produce a journal article', () => {
  const { item, sources } = normalizePage({
    url: 'https://journals.example.org/article/123?utm_source=x',
    docTitle: 'Attention | Journal',
    metas: [
      meta('citation_title', 'Attention Is All You Need'), meta('citation_author', 'Vaswani, Ashish'), meta('citation_author', 'Noam Shazeer'),
      meta('citation_journal_title', 'Journal of Tests'), meta('citation_volume', '30'), meta('citation_issue', '2'),
      meta('citation_firstpage', '5998'), meta('citation_lastpage', '6008'), meta('citation_publication_date', '2017/12/04'),
      meta('citation_doi', 'doi:10.5555/3295222.3295349'), meta('og:title', 'Wrong title'),
    ],
    jsonld: [], micro: {}, bylines: [], text: '',
  }, { now: new Date(2024, 0, 2) });
  assert.equal(item.type, 'article-journal');
  assert.equal(item.title, 'Attention Is All You Need');
  assert.deepEqual(item.authors, [{ given: 'Ashish', family: 'Vaswani' }, { given: 'Noam', family: 'Shazeer' }]);
  assert.equal(item.pages, '5998-6008');
  assert.equal(item.date, '2017-12-04');
  assert.equal(item.doi, '10.5555/3295222.3295349');
  assert.equal(item.accessed, '2024-01-02');
  assert.equal(item.url, 'https://journals.example.org/article/123');
  assert.ok(sources.includes('Highwire meta'));
});

test('normalizePage: JSON-LD @graph NewsArticle with Person authors', () => {
  const { item } = normalizePage({
    url: 'https://news.example.com/bees',
    docTitle: 'How Bees Navigate Cities - The Daily Example',
    metas: [meta('og:site_name', 'The Daily Example'), meta('og:type', 'article')],
    jsonld: [JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'NewsArticle', headline: 'How Bees Navigate Cities', datePublished: '2023-06-14T09:30:00Z',
        author: [{ '@type': 'Person', name: 'Maria García López' }, { '@type': 'Person', givenName: 'Tom', familyName: "O'Neil" }],
        publisher: { '@type': 'Organization', name: 'Example Media' } },
    ] })],
    micro: {}, bylines: [], text: '',
  });
  assert.equal(item.type, 'webpage');
  assert.equal(item.title, 'How Bees Navigate Cities');
  assert.equal(item.container, 'The Daily Example');
  assert.equal(item.date, '2023-06-14');
  assert.deepEqual(item.authors[1], { given: 'Tom', family: "O'Neil" });
  assert.equal(item.authors[0].family, 'López');
});

test('normalizePage: Dublin Core, DOI in identifier, video and ISBN detection', () => {
  const dc = normalizePage({
    url: 'https://repo.example.edu/record/1', docTitle: 'Record',
    metas: [meta('DC.title', 'Soil Carbon'), meta('DC.creator', 'Keller, Anna'), meta('DC.date', '2019-11'), meta('DC.identifier', 'https://doi.org/10.3929/ethz-b-000123456')],
    jsonld: [], micro: {}, bylines: [], text: '',
  }).item;
  assert.equal(dc.title, 'Soil Carbon');
  assert.equal(dc.doi, '10.3929/ethz-b-000123456');
  assert.equal(dc.date, '2019-11');
  assert.deepEqual(dc.authors, [{ given: 'Anna', family: 'Keller' }]);

  const yt = normalizePage({
    url: 'https://www.youtube.com/watch?v=abc&feature=share', docTitle: 'Neural nets - YouTube',
    metas: [meta('og:title', 'Neural nets'), meta('og:type', 'video.other'), meta('og:site_name', 'YouTube')],
    jsonld: [], micro: { author: ['3Blue1Brown'], datePublished: ['2017-10-05'] }, bylines: [], text: '',
  }).item;
  assert.equal(yt.type, 'video');
  assert.equal(yt.container, 'YouTube');
  assert.equal(yt.date, '2017-10-05');
  assert.equal(yt.url, 'https://www.youtube.com/watch?v=abc');

  const bk = normalizePage({
    url: 'https://books.example.com/b', docTitle: 'A Book', metas: [meta('og:type', 'book'), meta('book:isbn', '9780262035613')],
    jsonld: [], micro: {}, bylines: [], text: '',
  }).item;
  assert.equal(bk.type, 'book');
  assert.equal(bk.isbn, '9780262035613');
});

test('normalizePage: arXiv abstract page becomes a preprint report with DataCite DOI', () => {
  const { item } = normalizePage({
    url: 'https://arxiv.org/abs/1706.03762v7', docTitle: '[1706.03762] Attention Is All You Need',
    metas: [meta('citation_title', 'Attention Is All You Need'), meta('citation_author', 'Vaswani, Ashish'), meta('citation_date', '2017/06/12'), meta('citation_arxiv_id', '1706.03762')],
    jsonld: [], micro: {}, bylines: [], text: '',
  });
  assert.equal(item.type, 'report');
  assert.equal(item.number, 'arXiv:1706.03762');
  assert.equal(item.doi, '10.48550/arXiv.1706.03762');
});

test('normalizePage: labelled DOI in page text is used only when unique', () => {
  const base = { url: 'https://x.example/p', docTitle: 'Paper', metas: [], jsonld: [], micro: {}, bylines: [] };
  assert.equal(normalizePage({ ...base, text: 'DOI: 10.1234/abc.5 and refs 10.9/zzz' }).item.doi, '10.1234/abc.5');
  assert.equal(normalizePage({ ...base, text: 'doi:10.1/a doi:10.2/b' }).item.doi, '');
});

test('itemFromIdentifier builds offline skeletons', () => {
  assert.equal(itemFromIdentifier({ kind: 'doi', value: '10.1/x' }).url, 'https://doi.org/10.1/x');
  assert.equal(itemFromIdentifier({ kind: 'isbn', value: '9780262035613' }).type, 'book');
  assert.equal(itemFromIdentifier({ kind: 'doi', value: '10.48550/arXiv.1706.03762' }).number, 'arXiv:1706.03762');
});

test('duplicate detection by DOI, URL and title+year', () => {
  assert.equal(duplicateReason({ doi: '10.1/A' }, { doi: '10.1/a' }), 'same DOI');
  assert.equal(duplicateReason({ url: 'https://www.x.com/a/' }, { url: 'http://x.com/a?utm=1' }), 'same URL');
  assert.equal(duplicateReason({ title: 'A Long Title Here', date: '2020' }, { title: 'a long title here!', date: '2020-05' }), 'same title');
  assert.equal(duplicateReason({ title: 'A Long Title Here', date: '2020' }, { title: 'A Long Title Here', date: '2021' }), '');
  const map = findDuplicates([{ id: 1, doi: '10.1/a' }, { id: 2, doi: '10.1/a' }, { id: 3, doi: '10.1/b' }]);
  assert.equal(map.size, 2);
});
