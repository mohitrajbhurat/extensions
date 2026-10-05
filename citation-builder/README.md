# Citation Builder

Cite the page you are reading in APA 7, MLA 9, Chicago 17 (author-date and notes-bibliography), Harvard, IEEE, BibTeX or RIS — then keep the references in named project bibliographies. Everything runs locally and offline; nothing is uploaded anywhere.

Modeled on the workflow of the Zotero Connector and ZoteroBib, but self-contained: the metadata extractor and all seven output formats are implemented in this extension.

## Features

**Metadata extraction** (one click, on the page you are on)
- Highwire / Google Scholar `citation_*` tags (title, authors, journal, volume, issue, pages, DOI, ISBN, publisher, report number, arXiv ID)
- schema.org JSON-LD, including `@graph` and `@id` references: `ScholarlyArticle`, `Article`/`NewsArticle`/`BlogPosting`, `Book`, `Chapter`, `Report`, `VideoObject`, `WebPage`; `isPartOf` chains give journal, volume and issue
- Dublin Core (`DC.*`, `DCTERMS.*`) and PRISM
- OpenGraph and Twitter cards, plus microdata (`itemprop`) and visible bylines
- DOI detection in meta tags, the URL and labelled text on the page; arXiv IDs (new and old style); ISBN-10/13 with checksum validation
- Fallbacks: document title with the site name trimmed, `<h1>`, site name, author meta, published/modified dates, and today's access date
- Tracking parameters (`utm_*`, `fbclid`, …) are stripped from the saved URL

**Editing and preview**
- Full editable form: source type (journal article, web page, book, chapter, video, report), an author/editor list with first/last fields, organization (corporate author) rows, reordering, and a "paste a list of names" box that splits and parses `Smith, J.; Doe, K.`, `A, B and C`, `Smith JA`, particles (`van`, `de`) and suffixes (`Jr.`)
- Title, container, volume, issue, pages, edition, report number, publisher, place, date, access date, URL, DOI, ISBN
- Live formatted preview with correct italics, plus the in-text citation (or Chicago short note)

**Formatting rules implemented**
- APA 7: sentence-case titles (acronyms and inner capitals kept), `&` before the last author, 20-author limit with `. . .`, `et al.` from three authors in text, `n.d.`, DOI as a URL
- MLA 9: first author inverted, `et al.` from three authors, container elements, `5 Mar. 2020` dates, URLs without the protocol, access date when there is no publication date
- Chicago 17: author-date entries and `(Author Year, 12)` citations; notes-bibliography entries, full first footnotes and short notes; up to ten authors listed, then the first seven plus `et al.`
- Harvard (Cite Them Right): `Smith, J.A. and Doe, J. (2020)`, `et al.` from four authors, `Available at: … (Accessed: 3 February 2024)`
- IEEE: numbered entries, initials first, `vol./no./pp.`, `doi:`, `[Online]. Available:`, `et al.` beyond six authors
- BibTeX: entry-type mapping, LaTeX escaping, brace-protected acronyms, `--` page ranges, month macros, unique cite keys
- RIS: typed tags with `SP`/`EP` splitting and `ER` terminators
- Year suffixes (2020a, 2020b) are assigned automatically when one author has several works in the same year

**Projects and bibliography manager** (full-page app)
- Named projects, rename/delete with undo, "All citations" view, per-project counts
- Search, sort (style default, author, title, date, date added), bulk select, move/copy between projects, delete with undo
- Duplicate detection by DOI, ISBN, URL and title+year, with a filter and a jump-to-the-other-copy badge
- Per-entry copy: formatted citation (rich text), in-text citation, Chicago footnote, BibTeX, RIS; duplicate and edit in place
- Export the whole bibliography or just the selection as `.bib`, `.ris`, `.txt` or `.html` (hanging indents, double spaced), or copy it formatted
- Rich-text copy puts both `text/html` (italics preserved) and `text/plain` on the clipboard, so pasting into Word, Google Docs or a plain editor both work
- JSON backup and restore in Options

**Context menu**
- *Cite this page* on any page, frame, image or video
- *Cite selected DOI/ISBN "…"* on selected text, and *Cite DOI/arXiv link* on DOI/arXiv links
- Offline by default: the identifier is filled in and you complete the rest. If you turn on online lookup in Options, the identifier (and nothing else) is sent to Crossref, Open Library or arXiv to fill in the record.

## Install
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `citation-builder` folder.

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Read metadata from the page you are on, only when you click the toolbar button or a context-menu item. No host permissions and no content script on every page. |
| `storage` | Projects and citations in `chrome.storage.local`; style, sentence-case, theme and lookup settings in `chrome.storage.sync`. |
| `contextMenus` | The "Cite this page" / "Cite selected DOI/ISBN" entries. |
| `optional_host_permissions`: `api.crossref.org`, `openlibrary.org`, `export.arxiv.org` | **Not granted by default.** Requested only when you switch on online lookup in Options, and removed again when you switch it off. These are the only hosts the extension can ever contact. |

No analytics, no accounts, no remote code.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| (unbound) | Cite the current page — bind at `chrome://extensions/shortcuts` |
| (unbound) | Open the bibliography manager — bind at `chrome://extensions/shortcuts` |
| `Ctrl`/`Cmd` + `Enter` | Save the citation (popup and edit dialog) |
| `/` | Focus search in the manager |
| `N` | Add a citation by hand |
| `Ctrl`/`Cmd` + `A` | Select all shown citations |
| `Delete` | Delete the selection (with undo) |
| `Esc` | Clear the search or the selection, close a menu or dialog |

No suggested keys are declared, so nothing conflicts with the other extensions in this suite.

## Tests

```
node --test citation-builder/test/*.test.mjs        # 36 unit tests for formatters, parsing, export
python3 -m http.server 8843 --directory citation-builder/test/fixtures &
node citation-builder/test/e2e-check.cjs            # extraction + popup + manager in headless Chromium
```

## Known limitations
- Offline is the default, so an item created from a bare DOI/ISBN has only the identifier until you type the rest or enable online lookup.
- Name parsing is heuristic. Compound family names (`María García López`), mononyms and unusual particles may need a quick fix in the author fields; the organization toggle switches a row to a single corporate-author field.
- Sentence case for APA is heuristic: titles that already look sentence-cased are left alone, and the conversion can be turned off in Options.
- PDFs in the built-in viewer, the Chrome Web Store and other extension pages cannot be scripted; the title and URL are filled in and the rest is up to you.
- Styles are implemented for the six source types above; theses, datasets, legal and archival sources are approximated by "report".
