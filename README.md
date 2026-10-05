# Extensions

A suite of productivity browser extensions. Each top-level folder is a complete Manifest V3 extension that loads directly in Chrome, Edge or Brave. No build step needed.

## Install any extension
1. Download or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the extension's folder.

## The suite

### Find and remember

| Extension | What it does |
|---|---|
| [Total Recall](total-recall/) | Full-text search over every page you've read. Private, local and offline: your browsing memory never leaves this device. |
| [Research Canvas](research-canvas/) | Highlight the web in 5 colors, pin sticky notes to pages, and clip everything into projects with linked Markdown notes. |
| [Smart Bookmarks](smart-bookmarks/) | Organize, search and tag bookmarks, find dead links and duplicates, and keep a read-later list. |
| [Citation Builder](citation-builder/) | Cite any page in APA, MLA, Chicago, Harvard, IEEE, BibTeX or RIS, and keep project bibliographies. Works offline. |
| [Recall Cards](recall-cards/) | Turn highlights into flashcards and remember what you read with FSRS spaced repetition. |

### Automate web work

| Extension | What it does |
|---|---|
| [Web Automator](web-automator/) | Record, edit and replay browser workflows: clicks, form filling, data extraction, CSV-driven runs and schedules. |
| [Point-and-Click Scraper](page-scraper/) | Turn tables and product lists on any page into spreadsheet-ready data. Auto-detect, point and click, paginate, export. |
| [Smart Autofill](smart-autofill/) | Fill job applications and long forms from your profiles: smart field matching, preview, undo, learning and an optional encrypted vault. |
| [Page Watch](page-watch/) | Monitor any part of a web page for changes: restocks, new postings, grades or price drops. Local, private, no account. |
| [Price Tracker](price-tracker/) | Track prices on any store, see the full price history and find out whether a sale is real. Alerts for target prices, lows and restocks. |
| [Command Palette](command-palette/) | A keyboard-first command palette: fuzzy search tabs, bookmarks, history and 60+ browser actions. |

### Focus and time

| Extension | What it does |
|---|---|
| [Tab Workspaces](tab-workspaces/) | Workspaces, tab stash, session backups, memory saver, duplicate guard, auto-grouping and a searchable closed-tab archive. |
| [Mindful Gate](mindful-gate/) | Focus and distraction control: a mindful pause before distracting sites, hard-block schedules, a Pomodoro timer and insights. |
| [Time Ledger](time-ledger/) | Automatic time tracking, timer, screen-time goals and billable timesheets. Private and offline. |
| [Home Base](home-base/) | A calm new tab dashboard with tasks: focus, clock, daily backgrounds, quotes, links, notes, calendar, habits and a pomodoro timer. |

### Read, learn and create

| Extension | What it does |
|---|---|
| [Page Assistant](page-assistant/) | Summarize, question and study any article or PDF with on-device AI, plus a private offline fallback. |
| [Language Immersion](immersion/) | Learn a language while you browse: swaps a few words on each page into Spanish, French, German and more, with review quizzes. |
| [Reading Studio](reading-studio/) | Reader view, read aloud with sentence highlighting, dark mode for any site, and focus aids. Fully offline. |
| [Video Studio: notes and speed control](video-studio/) | Speed control for any HTML5 video plus timestamped Markdown notes, frame screenshots, bookmarks and A-B loops. |
| [Capture Studio](capture-studio/) | Screenshots (visible, region, full page), an annotation editor and screen recording with webcam and audio. All local. |
| [PDF Studio](pdf-studio/) | View, annotate, fill, sign, merge, split, reorder and compress PDFs. 100% local, nothing is uploaded. |
| [Type Kit](type-kit/) | Text expander and clipboard history: snippets with shortcuts, fill-in placeholders, a fuzzy picker and local clipboard history. |
| [Pocket Tools](pocket-tools/) | Everyday utility belt: password and passphrase generator, QR codes, word counter and unit, time zone and number converters. Offline. |

### Developer and design

| Extension | What it does |
|---|---|
| [API Workbench](api-workbench/) | Test HTTP APIs in a browser tab: collections, environments, auth, assertions, Postman and cURL import, and a JSON viewer. |
| [Request Rewriter](request-rewriter/) | Rewrite requests while you test: headers, redirects, host swaps, query params, blocks, mocks and user-agent overrides. |
| [Accessibility Auditor](a11y-auditor/) | Audit any page against 60+ WCAG 2.2 rules: contrast, alt text, labels, ARIA, headings, landmarks, target size, keyboard access. Export HTML/JSON/CSV. |
| [Design Inspector](design-inspector/) | Inspect any page's box model, type and colors, measure gaps, pick colors, extract design tokens, live-edit styles and list assets. |
| [Privacy Shield](privacy-shield/) | Blocks cross-site trackers, strips tracking parameters, answers cookie banners for you and sends Global Privacy Control. |

## Notes
- Everything runs locally. No accounts, no paid APIs, nothing is uploaded.
- **Page Assistant** and **Language Immersion** use Chrome's free built-in AI when it is available. In Edge and Brave they fall back to offline features.
- **Home Base** is the only extension that replaces the new tab page.
- Some extensions ask for access to a site the first time you use a feature there; that is expected.
- Each folder has its own README with features, permissions and keyboard shortcuts.

## Development
- `node tools/smoke-test.js <folder>` loads an extension in headless Chromium and checks every page opens without errors.
- `node tools/make-icons.js <folder>` renders `icons/icon.svg` to PNG icons.
- Most folders have tests under `test/`; see that folder's README.
- Conventions for new extensions are in [CONVENTIONS.md](CONVENTIONS.md).
