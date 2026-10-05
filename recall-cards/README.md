# Recall Cards: highlights to flashcards

You read a lot and forget most of it. Recall Cards turns what you highlight on the web into flashcards and schedules reviews with **FSRS-5**, the modern spaced repetition algorithm used by Anki, so each card comes back just before you would forget it.

## Features
- **Capture from any page**: select text, then right-click → **Make flashcard**. You can also turn on a floating **Make flashcard** button (optional), use the popup's **Card from page selection**, or bind a keyboard shortcut.
- **Quick-create dialog**: front/back, deck (or a new deck), tags, and the source page URL and title. It saves with Ctrl+Enter.
- **Cloze deletions**: click words in the highlight to blank them out (`{{c1::text}}`). Adjacent words merge into one blank. You can create one card per blank, or put every blank on a single card. Hints are supported (`{{c1::answer::hint}}`).
- **FSRS-5 scheduler** with the 19 default weights, Again/Hard/Good/Easy ratings, learning and relearning steps, desired retention, maximum interval and interval fuzz. The next interval is shown on each rating button.
- **Full-page app**:
  - **Decks**: new/learning/due counts per deck; create, rename and delete decks; a sample deck.
  - **Review session**: Space flips the card, 1–4 rate it. Undo, edit and suspend work mid-session. Learning cards come back automatically.
  - **Browse**: search with `deck:`, `tag:`, `is:new|learning|review|due|suspended|cloze`, `"phrases"` and `-negation`. Sort by any column and open any card to edit it. Each card shows its stability, difficulty, recall probability and review history. Bulk actions: move, tag, suspend, reset and delete.
  - **Statistics**: a heatmap of reviews per day (canvas), a 30-day due forecast (canvas, with a table view), true retention (young and mature), study streak, card states and answer-button distribution.
  - **Import / export**: full JSON backup (with scheduling and history), CSV, and Anki-compatible tab-separated text with `#separator`, `#html`, `#notetype`, `#deck` and `#tags` headers. Duplicates are skipped on import.
- **Toolbar badge** with the due count. A **daily reminder notification** (via `chrome.alarms`) fires at your chosen time when cards are due.
- **Popup**: due count with a new/learning/review breakdown, **Start review**, and a quick-add form.
- Works offline. All data stays in this browser (IndexedDB plus `chrome.storage.local` for settings). Light and dark mode. Recall Cards does not override the new tab page.

## Load it
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select the `recall-cards/` folder.

## Permissions
| Permission | Why |
|---|---|
| `contextMenus` | The **Make flashcard** item on selected text. |
| `activeTab` + `scripting` | Injects the capture dialog into the current tab, only when you invoke it (menu, popup or shortcut). |
| `storage`, `unlimitedStorage` | Settings, plus local storage for large card collections and review history. |
| `alarms` | The daily reminder and periodic badge refresh. |
| `notifications` | The "cards due" reminder. |
| Optional `<all_urls>` host access | Requested only if you turn on the floating selection button in Settings. Turning the button off removes the permission. |

## Keyboard shortcuts
| Where | Keys | Action |
|---|---|---|
| Review | `Space` / `Enter` | Show answer, then rate Good |
| Review | `1` `2` `3` `4` | Again / Hard / Good / Easy |
| Review | `Z` · `E` · `S` · `Shift+Delete` | Undo · edit · suspend · delete |
| Editors | `Ctrl+Enter` | Save card |
| Editors | `Ctrl+Shift+C` (`+Alt` for the same number) | Wrap the selection in a cloze |
| Browse | `/` | Focus search |
| Global | unassigned | "Make a flashcard from the selected text" and "Start reviewing". Bind them at `chrome://extensions/shortcuts`. |

## Development
- Unit tests (scheduler, queue, cloze, import/export): `node --test recall-cards/test/*.test.mjs`
- Smoke test: `node tools/smoke-test.js recall-cards app/app.html`

## Limitations
- FSRS weights are not optimized from your review history; the default FSRS-5 weights are used.
- Cards are plain text with line breaks. Rich formatting and images are not supported, and HTML in Anki imports is converted to text.
- The capture dialog can't run on browser pages (`chrome://`, the Web Store) or in the built-in PDF viewer. In those cases the app's Add page opens with the selection prefilled.
