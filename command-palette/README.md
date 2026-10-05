# Command Palette

A keyboard-first command palette for the browser, in the spirit of Raycast, Omni and Superhuman's Cmd+K. Press **Ctrl+Shift+K** (Mac: **Command+Shift+K**) on any page, type a few letters, press Enter.

## Features

- **One search box for everything:** open tabs (all windows), recently closed tabs and windows, bookmarks, history, 60+ actions, your search commands and quicklinks.
- **Fuzzy matching** with its own scorer: word starts, acronyms (`ctr` finds *Close Tabs to the Right*), camelCase, consecutive runs and multi-word queries (`git claude`). Matched characters are highlighted.
- **Frecency ranking** that learns from what you pick. Results you choose often and recently rank higher, and the palette remembers which result you picked for a query (typing `gm` again goes straight to Gmail).
- **Prefixes:** `/` actions, `>` tabs (and recently closed), `#` bookmarks and quicklinks, `@` history. Type a prefix on its own to browse that source.
- **Search commands:** keyword URL templates with `{query}`, for example `yt lofi beats`, `gh react router`, `jira ABC-123`. Google, YouTube, Wikipedia and GitHub are also offered as fallbacks for any text you type. Add, edit or remove them in Settings.
- **Quicklinks:** named links with an optional keyword (`dash` + Enter opens your dashboard).
- **Type or paste a URL** to open it directly.
- **Overlay on the page:** the palette is injected into the current page inside a closed shadow DOM, so page styles can't leak in and page keyboard shortcuts don't see your typing. On pages extensions cannot script (chrome://, the Web Store, the PDF viewer), it opens in a small popup window instead. The toolbar button opens it as a popup too.
- Light and dark themes (auto or forced), mouse support, screen-reader roles (combobox + listbox).

### Actions (68)

| Group | Actions |
|---|---|
| Tabs | New Tab, Close Tab, Duplicate, Pin/Unpin, Mute/Unmute, Mute All Other Tabs, Unmute All, Reload, Hard Reload, Reload All in Window, Switch to Last Used Tab, Reopen Closed Tab, Move Left/Right/Start/End, Close Other Tabs, Close Tabs to the Right/Left, Close Duplicate Tabs, Close All Tabs from Site…, Sort Tabs by Domain, Discard Tab, Discard All Other Tabs |
| Windows | New Window, New Incognito Window, Open Page in Incognito, Close Window, Move Tab to New Window, Move Tab to Window…, Merge All Windows |
| Groups | Add Tab to Group… (existing or new, named), Remove from Group, Group Tabs by Domain, Ungroup All, Collapse/Expand All Groups |
| Page | Bookmark / Remove Bookmark, Copy URL, Copy Title, Copy Markdown Link, Copy Domain, Copy All Tab URLs, View Source, Print, Scroll to Top/Bottom |
| View | Toggle Fullscreen, Zoom In/Out/Reset |
| Navigation | Go Back, Go Forward |
| Privacy | Clear Cache for This Site, Clear Cookies and Site Data for This Site… (with confirmation), Open Clear Browsing Data |
| Browser | Open Downloads, Extensions, Extension Shortcuts, Settings, History, Bookmark Manager, Password Manager |
| Palette | Search Tabs/Bookmarks/History, Show All Actions, Palette Settings |

Actions ending in "…" open a second-level list (pick a window, a group, a site, or confirm).

## Keyboard shortcuts

| Key | What it does |
|---|---|
| Ctrl+Shift+K / Cmd+Shift+K | Open or close the palette (change it at `chrome://extensions/shortcuts`) |
| ↑ ↓, Ctrl+N / Ctrl+P | Move the selection |
| PgUp / PgDn | Jump 8 results |
| Enter | Switch to tab, open link (current tab by default), run action |
| Shift+Enter | Open in a new tab (or the current tab if you set "new tab" as the default) |
| Ctrl/Cmd+Enter, middle-click | Open in a background tab |
| Tab | Complete a search command's keyword, otherwise next result |
| Shift+Delete | Close the selected tab without leaving the palette |
| Esc | Back out of a sub-list, otherwise close |

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `command-palette` folder.
4. Press Ctrl+Shift+K. If another extension already uses the shortcut, set one at `chrome://extensions/shortcuts`.

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the palette overlay into the page you are on, only when you press the shortcut. No access to pages otherwise, and no host permissions. |
| `tabs` | List, switch, move, close, pin, mute, zoom and reload tabs, and read their titles/URLs for search. |
| `tabGroups` | Group, name, collapse and ungroup tabs. |
| `sessions` | Show and restore recently closed tabs and windows. |
| `bookmarks` | Search bookmarks; bookmark or unbookmark the current page. |
| `history` | Search your browsing history. |
| `browsingData` | "Clear Cache for This Site" and "Clear Cookies and Site Data" for the current site only. |
| `storage` | Settings, search commands and quicklinks (`storage.sync`), learned ranking (`storage.local`). |
| `favicon` | Show site icons from the browser's own favicon cache (no network requests). |
| `clipboardWrite` | Copy URL, title and Markdown link actions. |

Everything stays on your device. The extension makes no network requests of its own; the only pages loaded are the ones you choose to open.

## Notes and limitations

- The overlay can't run on browser pages (chrome://, edge://), the Chrome Web Store, or the built-in PDF viewer; the palette opens in a popup window there. In-page actions (scroll, print) aren't available on those pages.
- "Clear Cache for This Site" clears that site's Cache Storage and service workers and hard-reloads the page. The browser's HTTP cache can't be cleared per site through the extension API.
- The active tab can't be discarded, so "Discard Tab" switches to your last used tab first.
- History search indexes your most recent 3,000 visits from the last 90 days by default (configurable).

## Development

- No build step. Shared palette UI lives in `ui/palette-ui.js` (used by the overlay and the popup page). Search, ranking and actions run in the service worker (`lib/`).
- `node tools/smoke-test.js command-palette` from the repo root checks the extension loads cleanly.
- `node command-palette/test/e2e.js` runs a Playwright end-to-end test: opens the overlay on a local page, searches for and switches to a tab, runs actions (duplicate, copy URL, scroll), and checks prefixes, keyword commands, sub-lists, frecency learning and the options page.
