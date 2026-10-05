# Page Watch

Monitor any part of a web page and get told when it changes. Useful for restocks, new job postings, grade portals, price drops and anything else you would otherwise keep reloading. Works like Distill Web Monitor or Visualping, but everything stays on your device: no account, no server.

## Features
- **Point-and-click picker.** From the toolbar popup choose *Pick an element*. Hover to highlight, click to select, then use **↑ Parent** / **↓ Child** (or the arrow keys) to widen or narrow the selection. The toolbar shows the generated CSS selector (editable), how many elements match and a live text preview. *Whole page* watches all visible text.
- **Background checks** on a schedule from every minute to once a day (`chrome.alarms`).
  - **Fetch HTML (default):** downloads the page with your cookies and parses it in an offscreen document with `DOMParser`, then applies the selector. Fast and invisible.
  - **Render in background tab:** for pages that build their content with JavaScript. Opens an inactive, muted tab, waits the configured number of seconds (plus up to 10 s more if the element has not appeared), extracts the text and closes the tab.
  - CSS selectors and XPath (`xpath://h1`) are both supported.
- **Alert conditions:** any change, text contains, text does not contain, number goes above or below a threshold (understands `$1,299.99`, `1.299,99 €`, `1 299 kr`), or a regular expression (`pattern` or `/pattern/flags`). You are alerted when the content changes *and* the condition holds.
- **Alerts:** desktop notification (click opens the page; buttons for *Open page* and *View changes*), unread count on the toolbar badge, optional synthesized sound (chime, bell or beeps, adjustable volume).
- **History:** every change is stored as a timestamped snapshot in IndexedDB (100 per monitor by default, configurable).
- **Dashboard** (full page): all monitors with status, last check, last change, next check, check count, current number; search and filters (changed, problems, paused); pause/resume, edit, check now, delete.
- **Visual diff:** word-level diff (Myers O(ND) algorithm with an LCS fallback, and a line-then-word strategy for very large pages) between any two snapshots, shown inline, side by side, or as plain text. Long unchanged stretches are folded.
- **Test before saving:** the editor's *Test now* button runs the exact background check and shows the extracted text and whether the condition is currently met. It suggests render mode when a selector picked on the live page is missing from the fetched HTML.
- **Import / export** monitors as JSON. Duplicates (same URL and selector) are skipped on import, and a banner offers to grant access to any imported sites in one step.
- Light and dark themes, keyboard accessible.

## Load it
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `page-watch` folder.
3. Pin Page Watch to the toolbar, open a page and click the icon.

## Permissions and why
| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the element picker into the current tab only when you click *Pick an element*; read the page in a render-mode background tab. |
| `storage` | Save monitors and settings locally (`chrome.storage.local`). Snapshot history lives in IndexedDB. |
| `alarms` | Schedule the background checks. |
| `offscreen` | Parse fetched HTML with `DOMParser` (service workers have no DOM) and play the alert sound. |
| `notifications` | Desktop alerts when a watched page changes. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | **Requested per site** when you save or test a monitor, e.g. `https://shop.example.com/*`. Needed to fetch that site in the background. Nothing is granted up front; you can revoke access any time in the extension's site settings, and the dashboard shows *Needs access* with a *Grant access* button. |

Page Watch makes no network requests other than fetching the pages you choose to monitor.

## Keyboard shortcuts
Bind these at `chrome://extensions/shortcuts` (no default keys are reserved):
- **Pick an element to watch on the current page**
- **Open the Page Watch dashboard**

In the picker: `↑` parent, `↓` child, `Enter` watch, `Esc` cancel.
In the dashboard: `/` search, `n` new monitor, `j` / `k` next or previous monitor, `c` check now, `e` edit, `↑` / `↓` move through the list and history, `Shift`+click a history entry to set the older side of the comparison. `Ctrl`+`Enter` saves the editor.

## Tests
- Unit tests (diff, conditions, number parsing): `node --test page-watch/test/*.test.mjs`
- End-to-end (Playwright, local test server that changes between checks: picker, fetch + extract, conditions, badge, render mode, dashboard diff, import/export, popup): `node --test page-watch/test/e2e.mjs`
- Smoke test: `node tools/smoke-test.js page-watch dashboard/dashboard.html`

## Limitations
- Fetch mode sees the HTML the server sends; content built by JavaScript needs render mode. Selectors that use classes added at runtime may need adjusting (the editor's *Test now* shows what will be read).
- Render mode briefly opens an inactive tab in your current window.
- Pages behind a login work only while you are signed in in this browser profile. Chrome may skip checks while the computer sleeps and runs one catch-up check when it wakes.
- Text inside iframes and canvas is not read.
