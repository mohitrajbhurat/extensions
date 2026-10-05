# Web Automator

Record, edit and replay the clicks and form entries you repeat every day in web tools. Modeled on Ui.Vision, iMacros and Axiom. Runs fully offline; macros, data and screenshots stay in your browser.

## Features
- **Recorder**: captures clicks, typing (final values by default, or keystrokes), select changes, checkbox and radio toggles, Enter and form submits, window scrolling, and navigations (address bar, back/forward, reload) across page loads in the same tab. An in-page pill shows the step count and has a Stop button.
- **Robust selectors**: each step stores up to 6 selectors, in this order: `id=`, `data-testid` (and similar test attributes), `name=`, `aria=`, `label=`, `placeholder=`, `text=`, a short CSS path and an XPath. Ids that look generated (`:r1:`, long digit or hex runs) are skipped.
- **Macro editor** (full page): editable command, target and value for each step. Add, delete, duplicate, disable, and drag or keyboard reorder. Undo and redo. Fallback selector list. Pick an element in the page, or highlight a selector in it. Block indentation and block-structure errors are shown.
- **Commands**: `open`, `goBack`, `refresh`, `click`, `doubleClick`, `type`, `typeKeys`, `pressKey`, `select`, `check`, `uncheck`, `submit`, `hover`, `scroll`, `waitForElement`, `waitForVisible`, `waitForGone`, `pause`, `assertText`, `assertExists`, `assertUrl`, `assertTitle`, `extract` (`name` or `name@attribute`), `extractAll`, `set`, `echo`, `screenshot`, `if` / `ifNot` (element exists), `ifVar`, `else`, `loop` N, `csvLoop` (optionally over a row range), `break`, `end`, `stop`.
- **Variables**: `${name}`, `${row.column}`, `${loop.index}`, plus `${date}`, `${time}`, `${now}`, `${timestamp}` and `${random}`.
- **Player**: runs in a tab you choose or in a new tab. Highlights the current element, has three speeds (adjustable while running), pause, resume and stop. Each step tries every fallback selector, with a configurable timeout and retries. Waits for pages to load after clicks. Live run log.
- **Data**: extracted values become table rows (one per CSV row or loop pass). View them, then export to CSV or JSON or copy them. Screenshots are kept with each run.
- **CSV input**: upload, drop or paste a CSV (the delimiter is detected and quoted fields are supported). Run the macro once per row, or loop over rows inside it.
- **Scheduling**: daily at a time on chosen weekdays, hourly at a minute, or every N minutes, via `chrome.alarms`. Scheduled runs use a background tab, and a notification reports the result (click it to open the run).
- **Popup**: Record / Stop, macro list with Play (and Play per CSV row), open editor, import and export.
- **Import/export**: Web Automator JSON. Ui.Vision JSON macros can also be imported; common commands are mapped and unsupported ones come in as disabled notes.

## Load it
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on Developer mode.
2. Click **Load unpacked** and choose this `web-automator` folder.
3. In the welcome page or popup, click **Allow on all sites** (needed to record and replay across pages).

## Permissions
| Permission | Why |
|---|---|
| `<all_urls>` (optional, requested at runtime) | Inject the recorder/player into the tabs you automate, keep recording across page loads, run scheduled macros and capture screenshots. Can be revoked in Settings. |
| `scripting` | Inject the page agent on demand (no always-on content script). |
| `activeTab` | Access the current tab from the popup. |
| `webNavigation` | Detect page loads and address-bar navigations while recording and playing. |
| `storage`, `unlimitedStorage` | Macros, CSV data, run logs, extracted data and screenshots, stored locally. |
| `alarms` | Scheduled runs. |
| `notifications` | Report the results of scheduled runs. |

## Keyboard
- Commands (bind them at `chrome://extensions/shortcuts`): **Start/stop recording**, **Open editor**.
- Editor: `Ctrl+Enter` adds a step, `Ctrl+D` duplicates, `Ctrl+/` enables or disables, `Del` deletes, `Alt+Up`/`Alt+Down` move a step, `Up`/`Down` change the selection, `Ctrl+Z`/`Ctrl+Shift+Z` undo and redo. In the picker, `Esc` cancels.

## Tests
`node web-automator/test/e2e.js` serves `test/form.html` and `test/result.html` and drives the extension in Playwright. It covers recording (both modes), replay, every major command, CSV runs, failures, pause and stop, alarms and the editor.

## Known limitations
- Only the top frame is automated. Elements inside iframes and closed shadow roots are not supported.
- Synthetic events are not `isTrusted`, so a few sites that check for that (some file pickers and anti-bot widgets) will not respond.
- Browser pages (`chrome://`, web stores) cannot be automated.
- Scheduled runs need the browser to be open. Typed values are stored in plain text in local extension storage, except passwords: the recorder never saves them and writes a `${password}` placeholder instead, which you fill with a "Set variable" step or a CSV column.
