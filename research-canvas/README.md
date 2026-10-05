# Research Canvas

Research scattered across tabs, bookmarks and half-finished notes, collected in one place. Research Canvas is a
Manifest V3 extension that combines a **multi-color web highlighter**, **sticky notes pinned to pages**, and a
**side panel** where everything you clip lands in projects with Markdown notes, `[[wikilinks]]` and backlinks.

Everything is stored locally with `chrome.storage.local`. No account, no server, no network requests.

## Features

### Web highlighter
- Select text on any page and pick one of **5 colors** from the floating toolbar, or use the right-click menu
  (**Research Canvas → Highlight selection → …**).
- Highlights **persist and re-anchor** when you come back. Each one stores a text quote with prefix/suffix
  context plus a character-offset fallback, so they survive edited pages, re-flowed whitespace and
  lazily-rendered content. Highlights that can no longer be found are flagged in the panel instead of
  silently disappearing.
- **Click a highlight** to add a comment, change its color, copy the text or delete it.
- Highlights spanning several elements (links, emphasis, list items) are wrapped segment by segment.

### Sticky notes
- Pin notes anywhere on a page: **drag** by the header (or move with the arrow keys when it is focused),
  **resize** from the corner, **collapse** to a title bar, and recolor.
- Notes reappear on the same URL on the next visit, and can be sent to a project as a Markdown note in one click.

### Side panel
Opens as a `chrome.sidePanel` where available; otherwise it falls back to a popup, and
**More → Open in a full tab** always works.

- **Projects** — each holds clips of five kinds (text, highlight, image, link, page) plus notes, with source
  URL and timestamp. Rename, recolor, merge (move items) and delete projects.
- **Drag to reorder** clips, or press `Alt+↑` / `Alt+↓` on a focused card.
- **Tags** on any clip, with filtering by tag and by type.
- **Search everything** across all projects, notes, highlights and sticky notes, with `#tag`,
  `type:note`, `type:highlight`, `type:sticky` filters and highlighted snippets.
- **This page** — the highlights, sticky notes and clips of the tab you are looking at; click one to scroll to
  it on the page. **Pages** lists every annotated page.

### Notes editor
- Markdown with a formatting toolbar, live preview and a side-by-side split mode.
- `[[Wikilinks]]` between notes with autocomplete, link creation on click, and an automatic **backlinks**
  section. Renaming a note rewrites the links that point to it.
- Keyboard: `Ctrl+B`, `Ctrl+I`, `Ctrl+K`, `Ctrl+S`, automatic list continuation.

### Export and import
- **Markdown, one file per note** — writes `Downloads/Research Canvas/<project>/<note>.md` with YAML front
  matter (Obsidian-friendly), plus a `_Clips.md` per project and `_Page annotations.md`.
- **Markdown, single file** — one combined document per project or for everything.
- **JSON** — a complete backup of projects, clips, highlights and sticky notes.
- **Import JSON** — merges an export back in; records keep their ids and the newer copy wins.

## Install
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick the `research-canvas` folder.

## Keyboard shortcuts
| Action | Shortcut |
|---|---|
| Open the Research Canvas panel | `Ctrl+Shift+E` (`Command+Shift+E` on Mac) |
| Highlight the selection with the default color | unassigned — set it at `chrome://extensions/shortcuts` |
| Add a sticky note | unassigned — set it at `chrome://extensions/shortcuts` |
| Clip the selection to the current project | unassigned — set it at `chrome://extensions/shortcuts` |
| Focus the panel search | `/` or `Ctrl+K` |

## Permissions and why
| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Projects, clips, notes, highlights and sticky notes are stored locally. |
| `contextMenus` | The "Clip selection / image / link / page to project", highlight and sticky-note menu items. |
| `activeTab` + `scripting` | Injects the highlighter into the page you are on, only when you open the panel or use a menu item or shortcut. No host permissions are required for this. |
| `downloads` | Writes the Markdown and JSON exports. |
| `sidePanel` | Opens the panel. Feature-detected: without it the toolbar button opens a popup instead. |
| `http://*/*`, `https://*/*` (optional) | Only requested if you turn on **Settings → Restore highlights and sticky notes automatically**, which registers the content script so annotations reappear without opening the panel first. Revoking it in Settings turns the feature off again. |

Nothing is ever sent anywhere: there are no network requests of any kind.

## Notes and limitations
- Without the optional host permission, a page's highlights are re-applied when you open the panel (or use a
  shortcut or context-menu item) on that tab — not instantly on page load.
- Annotations are keyed by URL (hash and common tracking parameters removed), so a page reachable under two
  different URLs keeps two sets.
- Highlights are not applied inside iframes, `<canvas>`, PDF viewers or form fields.
- Browsers do not let extensions run on `chrome://`, `edge://` or the extension gallery pages.
- Image clips store the image URL, not a copy of the bytes, so a clipped image disappears if the site removes it.
- Per-file Markdown export writes several files in a row; Chrome may ask once whether to allow multiple downloads.

## Development
```
node tools/make-icons.js research-canvas
node tools/smoke-test.js research-canvas "sidepanel/sidepanel.html?mode=tab" "sidepanel/sidepanel.html?mode=popup"
```
`test/test-page.html` is a small page for trying the highlighter and sticky notes by hand:
`python3 -m http.server 8765 --directory research-canvas/test`, then open `http://localhost:8765/test-page.html`.

### Layout
```
research-canvas/
  manifest.json
  background.js          service worker: context menus, commands, injection, all writes
  lib/store.js           storage schema, CRUD, import/export
  lib/markdown.js        Markdown renderer (escaped, wikilink-aware) + Markdown export
  content/content.js     highlighter + sticky notes (shadow-DOM UI)
  sidepanel/             panel / popup / full-tab app
  icons/  test/
```
