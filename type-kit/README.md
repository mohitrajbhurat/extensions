# Type Kit

A text expander and clipboard history for Chrome, Edge and Brave, in the spirit of Text Blaze, Magical and Clipboard History Pro. Type a short shortcut such as `/sig` or `;addr` in any text field and it turns into the full text. Everything stays on your device.

## Features

### Snippets that expand while you type
- Works in `<input>`, `<textarea>` and rich editors (`contenteditable`) such as Gmail, Slack, Notion and LinkedIn, including editors that handle paste themselves.
- Works with React and Vue controlled inputs: the page's own input events fire, so its state updates.
- **Backspace right after an expansion** puts the typed shortcut back.
- Two trigger modes: **instant** (expands as soon as the shortcut is typed) or **after a space, Enter or punctuation**. In instant mode, if one shortcut is the start of another (`/bye` and `/byebye`), the shorter one expands when you type a space or punctuation after it.
- Case-insensitive by default, word-boundary aware, never expands in password fields, and can be turned off per site.
- Plain-text and rich-text snippets (bold, italic, underline, lists, links). Rich snippets keep their formatting in rich editors and become plain text in plain fields.

### Placeholders
| Placeholder | Result |
|---|---|
| `{date}` `{time}` `{datetime}` | Now, in your default formats (Settings) |
| `{date:DD/MM/YYYY}` | Custom format. Tokens: `YYYY YY MMMM MMM MM M DD D Do dddd ddd HH H hh h mm m ss s A a WW X`; literal text in `[brackets]` |
| `{date:+3d:YYYY-MM-DD}` `{time:+90m:h:mm A}` | Offsets: `+`/`-` with `y`, `M` (months), `w`, `d`, `h`, `m` (minutes), `s`. Combine them: `{date:+1M-1d}` |
| `{clipboard}` | Your clipboard: the latest history item, or the system clipboard if you allow it in Settings. `{clipboard:2}` is the item before that |
| `{cursor}` | Where the caret lands after expanding |
| `{input:Name}` `{input:Name:default}` `{input:Notes:multiline}` | Fill-in field; a dialog asks for it before inserting. Using the same name twice reuses the value |
| `{select:A|B|C}` `{select:Label:A|B}` | Dropdown in the fill-in dialog |
| `{snippet:/other}` | Another snippet, by shortcut or name (nested up to 6 levels, loops are ignored) |
| `{url}` `{title}` `{host}` | The current page |
| `{uuid}` `{random:1:6}` | Random ID or number |
| `{{` `}}` | Literal braces |

The fill-in dialog shows a live preview. Enter inserts, Esc cancels and leaves your text as it was.

### Manager page
Open it from the popup (☰ button) or the extension's options.
- **Folders:** create, rename, delete (snippets move to General); filter the list by folder.
- **Search** across shortcut, name and text (fuzzy); sort by name, most used, recently used or recently edited.
- **Editor:** name, shortcut (warns about duplicates and prefix clashes), folder, plain or rich format, enable/disable, an *Insert placeholder* menu, a live preview that shows where `{cursor}` lands, duplicate and delete. Unsaved changes are flagged.
- **Clipboard:** full history with search, pin, copy, delete, *Save as snippet*, clear (keeping pinned items) or clear all.
- **Stats:** expansions, characters saved and estimated time saved (from your typing speed), and the most used snippets.
- **Settings:** trigger mode, case sensitivity, word boundaries, notices, default date and time formats, sites where expansion is off, clipboard history options, typing speed.
- **Import / export:** JSON (everything: folders, snippets, usage, settings, pinned clips) and CSV (one snippet per row: shortcut, name, folder, format, body, uses). Imports can update existing shortcuts, keep them, add duplicates or replace everything. CSV imports recognise common column names from other expanders (`abbreviation`, `trigger`, `expansion`, `text`, `content`...).

### Picker: Alt+Shift+V
Opens a search box on the current page with your snippets and clipboard items. It remembers where your caret was, so the chosen item goes straight into the field you were typing in. With no field focused, Enter copies instead.

### Clipboard history
- Records text you **copy or cut on web pages** (including text that copy buttons and editors put on the clipboard), with the source page and time.
- Keeps the last *N* items (default 100); pinned items are always kept. Optional expiry after a number of days.
- **Never recorded:** password fields, credit card / one-time-code fields, incognito windows, and sites you exclude.
- Search, pin, re-copy, paste into the focused field, delete, clear.

### Popup
Recent clipboard items and snippet search. Enter (or a click) pastes into the field that was focused on the page; Shift+Enter copies. A switch pauses shortcut expansion.

## Keyboard shortcuts

| Where | Key | Action |
|---|---|---|
| Any page | **Alt+Shift+V** | Open the picker (change it at `chrome://extensions/shortcuts`) |
| Any text field | Backspace (right after expanding) | Undo the expansion |
| Picker | ↑ ↓, Ctrl+N / Ctrl+P, PgUp / PgDn | Move |
| Picker | Enter / Shift+Enter | Insert / copy |
| Picker | Tab / Shift+Tab | Switch filter: All, Snippets, Clipboard |
| Picker | Alt+P | Pin or unpin the selected clipboard item |
| Picker, fill-in dialog | Esc | Close |
| Fill-in dialog | Enter (Ctrl+Enter in a multi-line field) | Insert |
| Popup | ↑ ↓, Enter, Shift+Enter, Alt+P | Move, paste, copy, pin |
| Manager | Ctrl+S, Alt+N, `/` | Save snippet, new snippet, focus search |

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `type-kit` folder.
4. Reload tabs that were already open so shortcuts expand there. (The picker and popup work in them right away.)

## Permissions and why

| Permission | Why |
|---|---|
| Content script on all sites (`<all_urls>`) | Shortcuts must expand in whatever field you type in, and copy events must be seen to build the clipboard history. The script only reads the few characters before your caret and the text you copy; nothing leaves your device. |
| `storage` | Snippets, folders, settings and clipboard history, in `chrome.storage.local`. |
| `activeTab`, `scripting` | Open the picker or insert from the popup in a tab that was open before Type Kit was installed. |
| `clipboardWrite` | Copy snippets and history items to the clipboard. |
| `alarms` | Hourly clean-up so expired clipboard items are deleted even when you do not open Type Kit. |
| `offscreen` | Reads the system clipboard for `{clipboard}`, only after you grant the optional permission below. |
| `clipboardRead` (optional) | Off by default. Turn it on in Settings if you want `{clipboard}` to use text copied in other apps too. |

No accounts, no network requests, no analytics.

## Known limitations
- Text copied outside the browser, or by pages through `navigator.clipboard.writeText()` without a copy event, is not added to the history.
- Browser pages (`chrome://`, the Web Store), the PDF viewer and canvas-based editors such as Google Docs cannot be scripted, so shortcuts do not expand there.
- Some editors rebuild their content asynchronously; in those, `{cursor}` placement in rich snippets can be off by a character or two.

## Files
```
manifest.json
background.js          service worker: storage, history writes, picker command, clipboard reads
shared/engine.js       placeholders, date math, shortcut matching, fuzzy search, HTML sanitising
shared/store.js        chrome.storage.local data layer, import/export
shared/ui.css          design tokens shared by the popup and manager
content/content.js     expansion, undo, fill-in dialog, picker, copy capture
popup/                 toolbar popup
manager/               full-page manager (also the options page)
offscreen/             clipboard reader (only with the optional permission)
test/                  unit tests and an end-to-end Playwright check
```

## Tests
```
node type-kit/test/unit.test.js   # engine and storage
node type-kit/test/e2e.js         # loads the extension in Chromium and drives test/fixture.html
node tools/smoke-test.js type-kit
```
