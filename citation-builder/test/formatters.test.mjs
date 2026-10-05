// Run: node --test citation-builder/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCitation, formatInText, formatNote, formatBibliography, apaAuthors, mlaAuthors, chicagoBibAuthors, harvardAuthors, ieeeAuthors,
} from '../lib/formatters.js';
import { toBibtex, toRis, citeKey } from '../lib/export.js';

const P = (given, family) => ({ given, family });

const article = {
  id: 'a1', type: 'article-journal',
  authors: [P('Jane A.', 'Smith'), P('John', 'Doe'), P('Kim', 'Lee')],
  title: 'Deep Learning for the Analysis of DNA Sequences: A Review',
  container: 'Nature Methods', volume: '12', issue: '3', pages: '45-67', date: '2020-03-05',
  doi: '10.1038/nmeth.1234',
};
const book = {
  id: 'b1', type: 'book', authors: [P('Donald E.', 'Knuth')], title: 'The Art of Computer Programming',
  edition: '3', publisher: 'Addison-Wesley', place: 'Boston', date: '1997',
};
const web = {
  id: 'w1', type: 'webpage', authors: [], title: 'How to Cite Sources?', container: 'Purdue OWL',
  date: '2021-07-14', url: 'https://owl.purdue.edu/cite', accessed: '2024-02-03',
};
const chapter = {
  id: 'c1', type: 'chapter', authors: [P('Alice', 'Brown')], editors: [P('Ed', 'One'), P('Eve', 'Two')],
  title: 'On Method', container: 'Handbook of Things', pages: '10-20', publisher: 'Springer', place: 'Cham', date: '2019',
};
const video = {
  id: 'v1', type: 'video', authors: [{ literal: '3Blue1Brown' }], title: 'But what is a neural network?',
  container: 'YouTube', date: '2017-10-05', url: 'https://youtu.be/aircAruvnKk', accessed: '2024-01-01',
};
const report = {
  id: 'r1', type: 'report', authors: [{ literal: 'World Health Organization' }], title: 'World Health Statistics 2023',
  publisher: 'World Health Organization', place: 'Geneva', number: 'WHO/123', date: '2023', url: 'https://who.int/x',
};

const text = (it, style, o) => formatCitation(it, style, o).text;
const html = (it, style, o) => formatCitation(it, style, o).html;

// ------------------------------------------------------------------ APA 7
test('APA journal article: sentence case, italic journal and volume, DOI URL', () => {
  assert.equal(text(article, 'apa'),
    'Smith, J. A., Doe, J., & Lee, K. (2020). Deep learning for the analysis of DNA sequences: A review. Nature Methods, 12(3), 45–67. https://doi.org/10.1038/nmeth.1234');
  assert.match(html(article, 'apa'), /<i>Nature Methods<\/i>, <i>12<\/i>\(3\)/);
});

test('APA book with edition, web page with full date, video, report omitting publisher = author', () => {
  assert.equal(text(book, 'apa'), 'Knuth, D. E. (1997). The art of computer programming (3rd ed.). Addison-Wesley.');
  assert.equal(text(web, 'apa'), 'How to cite sources? (2021, July 14). Purdue OWL. https://owl.purdue.edu/cite');
  assert.equal(text(video, 'apa'), '3Blue1Brown. (2017, October 5). But what is a neural network? [Video]. YouTube. https://youtu.be/aircAruvnKk');
  assert.equal(text(report, 'apa'), 'World Health Organization. (2023). World health statistics 2023 (WHO/123). https://who.int/x');
  assert.match(html(video, 'apa'), /<i>But what is a neural network\?<\/i> \[Video\]/);
});

test('APA chapter with editors and page range', () => {
  assert.equal(text(chapter, 'apa'), 'Brown, A. (2019). On method. In E. One & E. Two (Eds.), Handbook of things (pp. 10–20). Springer.');
});

test('APA author list: two authors use ", &"; 21+ authors use ellipsis before final author', () => {
  assert.equal(apaAuthors([P('A', 'One'), P('B', 'Two')]), 'One, A., &amp; Two, B.');
  const many = Array.from({ length: 22 }, (_, i) => P('X', 'Author' + (i + 1)));
  const s = apaAuthors(many);
  assert.ok(s.includes('Author19, X., . . . Author22, X.'));
  assert.ok(!s.includes('Author20'));
});

test('APA in-text: et al. at 3+, ampersand for 2, n.d. and title fallback', () => {
  assert.equal(formatInText(article, 'apa').text, '(Smith et al., 2020)');
  assert.equal(formatInText({ ...article, authors: article.authors.slice(0, 2) }, 'apa').text, '(Smith & Doe, 2020)');
  assert.equal(formatInText({ ...book, date: '' }, 'apa').text, '(Knuth, n.d.)');
  assert.equal(formatInText(web, 'apa').html, '(<i>How to Cite Sources?</i>, 2021)');
});

test('APA leaves already sentence-cased titles (proper nouns) alone, option disables conversion', () => {
  const it = { ...article, title: 'Evolution of Darwin’s finches in the Galápagos' };
  assert.match(text(it, 'apa'), /Evolution of Darwin’s finches in the Galápagos\./);
  assert.match(text(article, 'apa', { sentenceCase: false }), /Deep Learning for the Analysis/);
});

test('APA initials for hyphenated and multiple given names', () => {
  const it = { ...book, authors: [P('Jean-Paul', 'Sartre'), P('John Ronald Reuel', 'Tolkien')] };
  assert.match(text(it, 'apa'), /^Sartre, J\.-P\., & Tolkien, J\. R\. R\. \(1997\)/);
});

// ------------------------------------------------------------------ MLA 9
test('MLA journal: first author inverted, et al. at 3+, quoted title-cased title, abbreviated month', () => {
  assert.equal(text(article, 'mla'),
    'Smith, Jane A., et al. “Deep Learning for the Analysis of DNA Sequences: A Review.” Nature Methods, vol. 12, no. 3, 5 Mar. 2020, pp. 45–67, https://doi.org/10.1038/nmeth.1234.');
});

test('MLA two authors, book, web page without protocol, chapter with editors', () => {
  assert.equal(mlaAuthors([P('A', 'One'), P('B', 'Two')]), 'One, A, and B Two');
  assert.equal(text(book, 'mla'), 'Knuth, Donald E. The Art of Computer Programming. 3rd ed., Addison-Wesley, 1997.');
  assert.equal(text(web, 'mla'), '“How to Cite Sources?” Purdue OWL, 14 July 2021, owl.purdue.edu/cite.');
  assert.equal(text(chapter, 'mla'), 'Brown, Alice. “On Method.” Handbook of Things, edited by Ed One and Eve Two, Springer, 2019, pp. 10–20.');
  assert.match(html(book, 'mla'), /<i>The Art of Computer Programming<\/i>/);
});

test('MLA adds access date only when no publication date', () => {
  assert.match(text({ ...web, date: '' }, 'mla'), /owl\.purdue\.edu\/cite\. Accessed 3 Feb\. 2024\.$/);
});

test('MLA in-text', () => {
  assert.equal(formatInText(article, 'mla').text, '(Smith et al.)');
  assert.equal(formatInText({ ...article, authors: article.authors.slice(0, 2) }, 'mla').text, '(Smith and Doe)');
  assert.equal(formatInText(book, 'mla', { locator: '12-14' }).text, '(Knuth 12–14)');
});

// ------------------------------------------------------------------ Chicago
test('Chicago author-date bibliography and in-text', () => {
  assert.equal(text(article, 'chicago-ad'),
    'Smith, Jane A., John Doe, and Kim Lee. 2020. “Deep Learning for the Analysis of DNA Sequences: A Review.” Nature Methods 12 (3): 45–67. https://doi.org/10.1038/nmeth.1234.');
  assert.equal(text(book, 'chicago-ad'), 'Knuth, Donald E. 1997. The Art of Computer Programming. 3rd ed. Boston: Addison-Wesley.');
  assert.equal(formatInText(article, 'chicago-ad').text, '(Smith, Doe, and Lee 2020)');
  const four = { ...article, authors: [...article.authors, P('Q', 'Four')] };
  assert.equal(formatInText(four, 'chicago-ad').text, '(Smith et al. 2020)');
});

test('Chicago notes-bibliography entry, full note and short note', () => {
  assert.equal(text(article, 'chicago-nb'),
    'Smith, Jane A., John Doe, and Kim Lee. “Deep Learning for the Analysis of DNA Sequences: A Review.” Nature Methods 12, no. 3 (2020): 45–67. https://doi.org/10.1038/nmeth.1234.');
  assert.equal(text(book, 'chicago-nb'), 'Knuth, Donald E. The Art of Computer Programming. 3rd ed. Boston: Addison-Wesley, 1997.');
  assert.equal(formatNote(book, 'chicago-nb').text, 'Donald E. Knuth, The Art of Computer Programming, 3rd ed. (Boston: Addison-Wesley, 1997).');
  assert.equal(formatNote(article, 'chicago-nb').text,
    'Jane A. Smith, John Doe, and Kim Lee, “Deep Learning for the Analysis of DNA Sequences: A Review,” Nature Methods 12, no. 3 (2020): 45–67, https://doi.org/10.1038/nmeth.1234.');
  assert.equal(formatInText(article, 'chicago-nb').text, 'Smith, Doe, and Lee, “Deep Learning.”');
  assert.equal(formatInText(book, 'chicago-nb').html, 'Knuth, <i>Art of Computer Programming</i>.');
});

test('Chicago bibliography lists up to 10 authors, then first seven + et al.', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => P('A', 'N' + (i + 1)));
  const s = chicagoBibAuthors(eleven);
  assert.ok(s.endsWith('A N7, et al.'));
  const ten = chicagoBibAuthors(eleven.slice(0, 10));
  assert.ok(ten.endsWith('and A N10'));
});

// ------------------------------------------------------------------ Harvard
test('Harvard (Cite Them Right) article, book, web page with access date', () => {
  assert.equal(text(article, 'harvard'),
    'Smith, J.A., Doe, J. and Lee, K. (2020) ‘Deep Learning for the Analysis of DNA Sequences: A Review’, Nature Methods, 12(3), pp. 45–67. Available at: https://doi.org/10.1038/nmeth.1234.');
  assert.equal(text(book, 'harvard'), 'Knuth, D.E. (1997) The Art of Computer Programming. 3rd edn. Boston: Addison-Wesley.');
  assert.match(text(web, 'harvard'), /Available at: https:\/\/owl\.purdue\.edu\/cite \(Accessed: 3 February 2024\)\.$/);
  assert.equal(harvardAuthors([P('A', 'One'), P('B', 'Two'), P('C', 'Three'), P('D', 'Four')]), 'One, A. et al.');
  assert.equal(formatInText(article, 'harvard').text, '(Smith, Doe and Lee, 2020)');
});

// ------------------------------------------------------------------ IEEE
test('IEEE article, book and numbering', () => {
  assert.equal(text(article, 'ieee'),
    'J. A. Smith, J. Doe, and K. Lee, “Deep Learning for the Analysis of DNA Sequences: A Review,” Nature Methods, vol. 12, no. 3, pp. 45–67, Mar. 2020, doi: 10.1038/nmeth.1234.');
  assert.equal(text(book, 'ieee'), 'D. E. Knuth, The Art of Computer Programming, 3rd ed. Boston: Addison-Wesley, 1997.');
  assert.equal(text(web, 'ieee'), '“How to Cite Sources?” Purdue OWL, Jul. 14, 2021. Accessed: Feb. 3, 2024. [Online]. Available: https://owl.purdue.edu/cite');
  const seven = Array.from({ length: 7 }, (_, i) => P('A', 'N' + i));
  assert.equal(ieeeAuthors(seven), 'A. N0 <i>et al.</i>');
  assert.equal(formatInText(article, 'ieee', { number: 4 }).text, '[4]');
});

// ------------------------------------------------------------------ bibliography
test('Bibliography sorts alphabetically and adds year suffixes for same author/year', () => {
  const a = { id: 'x1', type: 'book', authors: [P('Ann', 'Zed')], title: 'Beta', date: '2020' };
  const b = { id: 'x2', type: 'book', authors: [P('Ann', 'Zed')], title: 'Alpha', date: '2020' };
  const c = { id: 'x3', type: 'book', authors: [P('Bob', 'Adams')], title: 'Gamma', date: '2001' };
  const bib = formatBibliography([a, b, c], 'apa');
  assert.deepEqual(bib.entries.map(e => e.id), ['x3', 'x2', 'x1']);
  assert.match(bib.entries[1].text, /\(2020a\)\. Alpha/);
  assert.match(bib.entries[2].text, /\(2020b\)\. Beta/);
  assert.equal(bib.entries[2].inText.text, '(Zed, 2020b)');
  assert.match(bib.html, /text-indent:-0\.5in/);
  const ieeeBib = formatBibliography([a, b, c], 'ieee', { sort: 'added' });
  assert.match(ieeeBib.entries[0].text, /^\[1\] /);
});

test('No author: title moves to the author position', () => {
  assert.match(text(web, 'chicago-ad'), /^“How to Cite Sources\?” 2021\. Purdue OWL\./);
});

// ------------------------------------------------------------------ BibTeX / RIS
test('BibTeX export: type mapping, escaping, protected acronyms, page dashes, unique keys', () => {
  const bib = toBibtex([article, { ...article, id: 'a2' }, { ...book, title: 'R&D at 100% Speed_now' }]);
  assert.match(bib, /@article\{smith2020deep,/);
  assert.match(bib, /@article\{smith2020deepb,/);
  assert.match(bib, /author = \{Smith, Jane A\. and Doe, John and Lee, Kim\}/);
  assert.match(bib, /title = \{Deep Learning for the Analysis of \{DNA\} Sequences: A Review\}/);
  assert.match(bib, /pages = \{45--67\}/);
  assert.match(bib, /month = mar/);
  assert.match(bib, /title = \{\{R\\&D\} at 100\\% Speed\\_now\}/);
  assert.match(toBibtex([report]), /author = \{\{World Health Organization\}\}/);
  assert.equal(citeKey(report), 'world2023world');
});

test('RIS export: tags, page split, dates, CRLF and ER terminator', () => {
  const ris = toRis([article, chapter]);
  assert.ok(ris.startsWith('TY  - JOUR\r\nAU  - Smith, Jane A.\r\n'));
  assert.match(ris, /SP {2}- 45\r\nEP {2}- 67/);
  assert.match(ris, /DA {2}- 2020\/03\/05\//);
  assert.match(ris, /DO {2}- 10\.1038\/nmeth\.1234/);
  assert.match(ris, /TY {2}- CHAP[\s\S]*ED {2}- One, Ed/);
  assert.equal((ris.match(/ER {2}- /g) || []).length, 2);
});
