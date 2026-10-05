# Point-and-Click Scraper

Turn tables, product grids and search results on any web page into spreadsheet-ready data. It works like Web Scraper.io or Instant Data Scraper: detect the data automatically or click what you want, teach it the "next" button, crawl several pages, then export.

## Features

- **Auto-detect.** Click **Detect data** in the toolbar popup. The extension scores tables and repeated sibling structures by item count, on-screen size, structural similarity and number of fields, and ignores menus and footers. Use the arrows in the panel to cycle through candidates; matches are outlined on the page.
- **Point & click.** Hover and click one item. Similar items are selected from their shared class and structure path (table rows are recognized). **Wider** / **Narrower** (or <kbd>↑</kbd> / <kbd>↓</kbd> while picking) changes the level.
- **Columns.** Inferred automatically (text fields, link URLs, image URLs; duplicate, empty and constant columns are dropped, and table headers become column names). Click **Add column by clicking**, then click a field inside any item. Each column can be Text, Link URL, Image URL, an attribute or HTML. Rename, reorder and delete columns. Hover a column to see its field outlined on the page. The preview table updates live, including when the page changes.
- **Pagination.**
  - *Next button / Load more:* pick the button once, or use **Auto-find** (`rel=next`, "Next", "›", "Load more", aria labels). Normal links are fetched in the background, so the page you are on doesn't change. JavaScript buttons are clicked on the page and the scraper waits for new content. If a click reloads the whole page, the crawl continues on the new page (see permissions).
  - *Infinite scroll:* scrolls the page or the scrolling container until no new items appear.
  - Set the maximum number of pages and the delay between them. Progress is shown with a **Stop** button. Duplicate rows are removed (optional).
- **Results viewer.** Sort by any column (number-aware: `$1,200` sorts after `$950`), filter, drag headers or press <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> to reorder, hide columns, rename the result. Export:
  - **Copy for Sheets / Excel** (tab-separated, paste straight into a sheet)
  - CSV, Excel-compatible CSV (UTF-8 with BOM, CRLF), TSV, JSON, or copy as CSV or JSON
  - Optional protection against spreadsheet formula injection (`=`, `+`, `-`, `@`)
  Exports use the current column order, visible columns, sort and filter.
- **Recipes.** Save the item selector, columns and pagination for a site. Re-run with one click from the popup (**Run**) or open in the panel to adjust (**Edit**). The manager page lists every recipe and lets you rename, duplicate, delete, and import or export recipes as JSON. It also lists the history of the last 60 results.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `page-scraper` folder.

## Using it

1. Open the page with the data and click the toolbar button.
2. Choose **Detect data** or **Point & click**. A panel opens on the page; drag it by its header or minimize it.
3. Adjust columns, set pagination if needed, and click **Scrape**. The results open in a new tab.
4. Optionally name and **Save recipe** to re-run it later from the popup.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the current page only after you click the toolbar button or use a shortcut. |
| `scripting` | Inject the scraper panel into that page. |
| `storage`, `unlimitedStorage` | Keep results, recipes and view settings locally; scraped tables can be large. |
| Optional host access (`http://*/*`, `https://*/*`) | Never requested automatically. You can grant it for one site from the popup (**Site access**) so a crawl can continue when a "next" click reloads the whole page. Link-based pagination, load-more buttons and infinite scroll work without it. |

No network requests are made except fetching the next pages of the site you are scraping. Nothing leaves your browser.

## Keyboard shortcuts

- Assign shortcuts at `chrome://extensions/shortcuts` for **Open the scraper panel and auto-detect data** and **Open the scraper panel in point-and-click mode**. No default keys are set, so nothing conflicts with the rest of the suite.
- While picking an element: <kbd>↑</kbd> parent, <kbd>↓</kbd> back to child, <kbd>Enter</kbd> select, <kbd>Esc</kbd> cancel.
- In the panel: <kbd>Esc</kbd> closes it; <kbd>←</kbd>/<kbd>→</kbd> switch between Auto-detect and Point & click.
- In the results table: <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> moves the focused column.

## Limitations

- Content inside iframes, closed shadow DOM and canvas isn't scraped.
- Background-fetched pages are parsed without running their JavaScript. If those pages render their data with JavaScript, the scraper clicks through on the live page instead.
- Selectors rely on the site's class names and structure. A site redesign can break a saved recipe; open it with **Edit** and pick again.
- Without optional site access, a crawl stops when a non-link "next" button reloads the whole page. The rows scraped up to that point are kept.

## Development

- `node tools/smoke-test.js page-scraper results/results.html`
- `node page-scraper/test/run-tests.js` runs the Playwright functional tests against the local pages in `test/`: table, paginated card grid, load more, infinite scroll, reload pagination, manual picking, exports and recipe import/export.
