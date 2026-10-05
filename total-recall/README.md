# Total Recall

**"I read it somewhere last week and can't find it."** Total Recall saves the readable text of the pages you visit and gives you instant full-text search over your browsing history, like Rewind, Memex or History Search. Everything stays on your device.

## Features
- **Automatic capture.** A content script extracts the main readable text of each page (a lightweight readability pass that drops navigation, headers, footers, cookie banners and share widgets). It waits for the page to settle, re-reads it once when dynamic content keeps loading, and follows single-page-app navigation (`pushState`, `popstate`, hash routes). Text is capped per page (configurable).
- **Never captured:** private (incognito) windows, `chrome://` and other browser pages, excluded sites, pages with password, card or one-time-code fields, sign-in, checkout and banking-like pages, and anything while indexing is paused.
- **Own search engine.** IndexedDB inverted index with tokenization, diacritic folding, stopwords, a light English stemmer and CJK bigrams, ranked with **BM25** (title and URL boosted, small recency and visit-count boost).
- **Query syntax:** `"exact phrase"`, `-word`, `-"phrase"`, `site:github.com`, `-site:`, `date:today|yesterday|week|month|year`, `after:2026-09-01`, `before:2026-10-01`. Results update as you type, with prefix matching on the last word.
- **Search app** (full tab): highlighted snippets, favicon, title, URL, visit time and count, grouped by day, date chips (Today, 7 days, 30 days, custom range), sort by best match or most recent, infinite scroll, forget a page with undo.
- **Jump to the passage.** Results open with a text fragment (`#:~:text=`) so the browser scrolls to and highlights the matching text.
- **Address bar:** type `tr`, then Space, then your query to see the top matches as suggestions.
- **Popup:** quick search with live results, pause or resume indexing, stats (pages indexed, storage used, read today), index the current page now, forget this site.
- **Settings:** excluded sites (domains or domain/path), skip sensitive pages, text per page, minimum length, retention period with automatic pruning, maximum storage (oldest pages removed first), export and import the index as JSON, wipe all data.

## Install
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `total-recall` folder.
3. Browse as usual. Open the popup or type `tr` in the address bar to search.

## Keyboard shortcuts
| Where | Key | Action |
|---|---|---|
| Address bar | `tr` then Space | Search with suggestions |
| Search app | `/` | Focus search |
| Search app | `↓` `↑` or `j` `k` | Move through results |
| Search app | `Enter` | Open in a new tab and jump to the text |
| Search app | `Ctrl`/`⌘` + `Enter` | Open in a background tab |
| Search app | `Shift` + `Enter` | Open in this tab |
| Search app | `c` | Copy the page link |
| Search app | `Delete` | Forget the selected page (with undo) |
| Search app | `Esc` | Clear the search |
| Search app | `?` | Show syntax and shortcut help |
| Popup | `↓` `↑`, `Enter` | Pick a quick result, or open full search |

"Open Total Recall search" has no default key (to avoid suite conflicts); assign one at `chrome://extensions/shortcuts`.

## Permissions and why
| Permission | Why |
|---|---|
| Content script on `http://*/*`, `https://*/*` | Reading the text of pages you visit is the core feature. Nothing is sent anywhere. |
| `storage` | Settings (readable by the content script without a round trip). |
| `unlimitedStorage` | The index can grow beyond the default quota; you set the real cap in Settings. |
| `alarms` | Periodic cleanup for retention and the storage cap. |
| `activeTab`, `scripting` | "Index this page now" on tabs opened before the extension was installed. |
| `favicon` | Show site icons from the browser's own favicon cache (no network requests). |

`"incognito": "not_allowed"` keeps the extension out of private windows entirely, and the service worker also rejects any incognito tab.

## Privacy
All data lives in this browser's IndexedDB. There are no servers, accounts, analytics or network requests. Uninstalling the extension deletes the index. Export files are plain JSON you control.

## Development
- `node tools/make-icons.js total-recall`
- `node tools/smoke-test.js total-recall search/search.html`
- `node total-recall/test/e2e.js` browses the fixtures in `test/fixtures/` with the extension loaded and checks capture, sensitive-page skipping, SPA navigation, ranking, phrase/exclusion/site/date queries, text-fragment links, pause, popup stats and export/import.

## Known limitations
- Text fragments depend on the page still containing the same text; if it changed, the page opens at the top.
- Pages rendered into `<canvas>`, cross-origin iframes, PDFs and images are not indexed.
- The stemmer is English-only; other languages are matched by exact word (CJK by character bigrams).
- Storage used is an estimate of the index size; the browser's on-disk figure may differ.
