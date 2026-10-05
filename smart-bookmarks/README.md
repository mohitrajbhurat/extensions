# Smart Bookmarks

A full-page bookmark manager and read-later list that works directly on your browser's own bookmarks. It finds dead links, redirects, duplicates and empty folders, suggests tags, and can search the saved text of pages. It covers much of what Raindrop.io, Bookmark Sidebar and Pocket do. Everything stays on your device: there is no account and no server.

## Features

### Manager (full page)
- **Folder tree** in the sidebar, plus views for *All bookmarks*, *Recently added*, *Untagged*, *Tag suggestions*, *Read later*, *Tags*, *Health check*, *Import & export* and *Settings*.
- **List or grid layout** with favicons, URL, folder path, tags, reading time and the last health status.
- **Multi-select:** click, `Ctrl`/`Cmd`+click, `Shift`+click for a range, `Ctrl`+`A`, or `Space` from the keyboard. The **bulk bar** can move, tag (add and remove), auto-tag, save page text, check links, mark read, add to Read Later, open all and delete. Every delete can be undone from the toast.
- **Drag and drop** bookmarks and folders between folders, either in the tree or in the list, or reorder them inside a folder.
- **Sort** by manual order, relevance (search), title, newest, oldest or website; Read Later can also sort by shortest or longest read. A folder's menu can also permanently sort that folder by title, date or domain.
- **Fast search** across title, URL, tags, notes and saved page text. Operators: `"exact phrase"`, `-exclude`, `tag:x` / `#x`, `site:github.com`, `in:folder`, `is:unread|read|readlater|untagged|duplicate|broken|redirect`, `has:text|note|suggestions`.
- **Details panel:** edit the title, URL, tags and note, view suggested tags and preview the saved text.

### Health check
- **Dead links:** a `HEAD` request first, with a `GET` fallback for servers that reject `HEAD` or fail it. Response bodies are not downloaded. The check is **rate limited**: one request at a time per host, a configurable delay between requests to the same host, and a global concurrency limit. It shows progress with an ETA and the current URL, and you can **cancel** it at any time. Results are classified as *Not found/Gone*, *Unreachable*, *Timeout*, *Restricted (401/403)*, *Rate limited*, *Server error*, *Login page* or *Moved to home*.
- **Redirects:** lists permanent moves, including http to https upgrades, and **offers to update the bookmark URL** to the final address, one at a time or in bulk.
- **Duplicates:** matches URLs after normalizing them, which ignores `www`, the scheme, tracking parameters (`utm_*`, `fbclid`, …), query order, trailing slashes and `index.html`. You choose which copy to keep, and **one click cleans up** a group or all groups. Tags and notes are merged into the copy that is kept.
- **Empty folders:** finds them and deletes them, one at a time or all together.
- The **report** is stored locally and is still there after a restart. Results also feed the `is:broken` and `is:redirect` searches.

### Auto-tagging
- Suggestions are built from the title, the meta keywords and description, the URL path and **TF-IDF frequent terms** in the page text. Document frequencies come from your own library, so terms that appear everywhere rank low. Tags you already use rank higher.
- Suggestions are **never applied silently**. You accept or edit them in the details panel, in the *Tag suggestions* view, or in the review dialog that has *accept all* / *accept selected*.
- Tags are stored locally per bookmark id. The *Tags* view can rename, merge and delete tags.

### Save page text (optional)
- Store a page's readable text for full-text search: from the popup for the current tab, in bulk from the manager, or automatically for new bookmarks (off by default). Text is kept in IndexedDB and is deleted when its bookmark is deleted.

### Read Later
- The toolbar popup offers **Save for later** with tags, suggested tags and an optional *save page text*. It can also bookmark the page into any folder.
- Items live in a real **Read Later** bookmark folder, with an **Archive** subfolder, under *Other bookmarks*. Because they are ordinary bookmarks, the list syncs with your browser and survives uninstalling the extension.
- The list has *Unread / Read / Archived* tabs, an **estimated reading time**, mark read or unread, archive with undo, and *archive all read*. The **unread count** is shown on the toolbar badge.
- You can also save from the right-click menu (*Save page for later*, *Save link for later*) or with a keyboard shortcut.

### Import and export
- **Export** to the **Netscape bookmark HTML** format, which every browser imports, with tags and notes kept. You can also export a **JSON** backup with tags, notes, read-later state and, optionally, saved page text. Files are created locally; nothing is uploaded.
- **Import** Netscape HTML from any browser or service (Chrome, Firefox, Safari, Pocket, Raindrop, Pinboard), or JSON (a Smart Bookmarks backup or a raw `chrome.bookmarks` tree). You preview the counts first; the import goes into a new folder (or one you pick) and can skip links you already have.

## Load it
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `smart-bookmarks` folder.
3. The manager opens with a short welcome page. Pin the toolbar button to use the popup.

## Permissions and why
| Permission | Why |
|---|---|
| `bookmarks` | Read and organize your bookmarks. This is the core of the extension. |
| `storage`, `unlimitedStorage` | Tags, notes and read-later state go in `chrome.storage.local`, settings in `chrome.storage.sync`, and saved page text and the health report in IndexedDB. Large libraries can exceed the default quota. |
| `activeTab`, `scripting` | When you open the popup or use *Save for later*, read the title, meta tags and text of **the current tab only**, to suggest tags and estimate reading time. |
| `contextMenus` | *Save page / link for later*, and the shortcuts on the toolbar button's menu. |
| `favicon` | Show site icons from the browser's own favicon cache, with no network requests. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | **Not granted at install.** The extension asks only when you start a link check, auto-tag or save text for bookmarks that are not open in a tab, or turn on the automatic options for new bookmarks. It is needed to request those pages. You can revoke it any time in *Settings* or on the extension's details page. |

Smart Bookmarks makes no network requests except to the bookmarked pages you ask it to check or read. Requests are sent without cookies.

## Keyboard shortcuts
Browser shortcuts (bind them at `chrome://extensions/shortcuts`; to avoid conflicts within the suite, none has a default key):
- **Open the Smart Bookmarks popup**
- **Save the current page to Read Later**
- **Open the bookmark manager**

Manager: `/` focus search · `↑`/`↓` or `j`/`k` move · `←`/`→` in the grid · `Home`/`End` · `Space` select · `Shift`+arrows extend the selection · `Enter` open (folders open in place) · `Ctrl`+`Enter` open in a background tab · `Ctrl`+`A` select all · `Delete` delete · `m` move · `t` tag · `e`/`F2` edit the title · `r` toggle read (Read Later) · `n` new folder · `g` switch list/grid · `i` details panel · `Alt`+`↑` parent folder · `Esc` clear the selection or close a dialog.

Popup: `Enter` adds a tag · `Ctrl`+`Enter` saves for later.

## Tests
- Unit tests (URL normalization, tagger, text extraction, Netscape and JSON import/export): `node --test smart-bookmarks/test/unit.test.mjs`
- Functional tests (Playwright; seeds a library and drives the manager and popup: search, selection, bulk tagging, duplicates with undo, empty folders, suggestions, Read Later and badge, import/export, health-check classification, moving, keyboard, settings): `node smart-bookmarks/test/functional.js`
- Smoke test: `node tools/smoke-test.js smart-bookmarks manager/manager.html`

## Limitations
- Link checks see what a logged-out visitor sees. Sites that block automated requests or need a sign-in show up as warnings (*Restricted*, *Rate limited*, *Login page*), not as dead links. Local and intranet addresses (`localhost`, private IPs, single-label hosts) are skipped.
- Tags and notes are stored in this browser profile only (bookmarks sync, but extension data does not). Use the JSON or HTML export to move them.
- Saved text for pages that build their content with JavaScript is captured fully only when it is saved from an open tab, through the popup or the right-click menu. Background fetches see only the server HTML.
- Some browsers' managed or root folders (Bookmarks bar, Other bookmarks, Mobile bookmarks) cannot be renamed, moved or deleted.
