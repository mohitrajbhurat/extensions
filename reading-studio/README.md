# Reading Studio

Easier reading on any web page: a clean reader view, read-aloud with sentence highlighting, dark mode for any site, and focus aids. It is modeled on Mercury Reader / Just Read, Speechify / Read Aloud and Dark Reader. Everything runs offline in your browser.

## Features

### Reader view (Alt+Shift+R)
- Its own readability extraction (no libraries). It scores content blocks, keeps headings, lists, quotes, figures with captions, code and tables, and drops navigation, sidebars, ads, share bars, newsletter forms, comments and footers.
- A clean overlay (isolated in a shadow root) showing the title, site, byline, date, word count and reading time. A progress bar and a "min left" counter follow your scroll.
- Typography panel:
  - Fonts: serif, sans-serif, slab and monospace, plus a **dyslexia-friendly** option. It uses OpenDyslexic, Lexend, Atkinson Hyperlegible or Comic Sans if one is installed, and adds extra letter, word and line spacing.
  - Text size, line spacing, column width, left or justified alignment.
  - Themes: auto, light, sepia, dark and black.
- Settings are remembered and apply live, including to a reader that is already open.
- The page behind the overlay stops scrolling while the reader is open. Esc closes the reader.

### Read aloud
- Uses `chrome.tts` with all installed voices. If `chrome.tts` has no voices or fails (some Edge and Brave setups), it falls back to the Web Speech API (`speechSynthesis`) automatically. You can also choose the Web Speech engine in Settings.
- Reads the **selection**, the **article**, the **whole page** or the open **reader view**. "Auto" uses the selection if there is one, otherwise the article. Article reading skips the same clutter the reader drops.
- Its own sentence splitter handles abbreviations (Dr., e.g., U.S.), initials, decimals, quotes, ellipses and CJK punctuation. Very long sentences are split into chunks so speech stays responsive.
- Highlights the current sentence and the spoken word (CSS Custom Highlight API, so the page DOM is never changed) and auto-scrolls to follow. Scrolling by hand pauses auto-scroll for a few seconds.
- **Click any sentence** while a session is active to continue reading from there.
- Floating, draggable **mini player**:
  - Play/pause, previous/next sentence, previous/next paragraph.
  - A seekable progress bar and time left.
  - Speed from 0.5x to 3x, with presets.
  - Voice and highlight options.
  - The player matches the page in dark mode.
- **Resume per page:** your position is saved for each URL and reading picks up where you stopped. Clear saved positions in Settings.
- Context menu: "Read selection aloud" and "Read this page aloud".

### Dark mode for any site
- **Dynamic mode:** analyzes the page's stylesheets (including CSS variables, gradients and adopted sheets) and computed colors, then injects overriding stylesheets with dark surfaces, light text and lightened brand colors. A mutation observer themes content added later. Images and video stay natural.
- **Filter mode:** a fast invert plus hue-rotate filter that works everywhere. Images, video and canvas are counter-inverted so they look natural.
- Brightness, contrast, sepia and grayscale sliders (both modes).
- **Per-site on/off** rules that override the global default. The global default can be off, on, or follow the system color scheme.
- **Avoids double darkening:** pages that are already dark are detected and left alone, unless you force dark mode on for that site.
- Optional: grant site access (one site or all sites) so dark mode applies as pages load, with no white flash. Without it, dark mode applies when you use the extension on a tab.

### Focus aids
- **Reading ruler** that follows the mouse. Three styles: spotlight (dims everything except a band), tinted band, or underline. Height, opacity and color are adjustable. Alt+Up / Alt+Down move it with the keyboard.
- **Bionic-style bold word starts** on the page or in the reader view, with adjustable strength. Turning it off restores the exact original text.

### Popup and options
- The **popup** has every control: reader, listen/pause/stop, source, voice, speed, dark mode for this site, global default, engine and sliders, ruler, bold word starts and reader appearance.
- The **options page** adds full reader typography with a live preview, speech engine, pitch and volume, voice preview, highlight and auto-scroll toggles, ruler styling, bionic strength preview, a per-site dark mode rule list, the shortcut list, and data controls (clear positions, reset).

## Install (Load unpacked)
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `reading-studio` folder.
4. Optional: to use it on local `file://` pages, open the extension's details and enable **Allow access to file URLs**.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Alt+Shift+R | Open or close Reader view |
| (unassigned) | Read aloud: start, pause or resume |
| (unassigned) | Toggle dark mode on the current site |
| (unassigned) | Toggle the reading ruler |
| Esc | Close the typography panel, then the reader view; closes player menus |
| Alt+Up / Alt+Down | Move the reading ruler |
| Left / Right, Space (player progress bar focused) | Previous / next sentence, play/pause |

Assign or change the shortcuts at `chrome://extensions/shortcuts`.

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Inject the reader, read-aloud and focus tools into the current tab only when you click the toolbar button, a context-menu item or a shortcut. No automatic access to your pages. |
| `tts` | Speak text with the browser's voices (`chrome.tts`). |
| `storage` | Save settings (synced, small), per-site dark mode rules and read-aloud positions (local). |
| `contextMenus` | "Read selection aloud", "Read this page aloud", "Open in Reader view", "Toggle dark mode on this site". |
| `optional_host_permissions: *://*/*` | Only requested if you ask for it, from the popup or Settings, for one site or all sites. It lets dark mode apply automatically as pages load. |

## Privacy
No network requests, accounts or analytics. All data stays in `chrome.storage`. Speech uses the voices installed in your browser and system. Some browsers offer online voices, which are marked "online" in the voice list.

## Browser notes
- Works in Chrome, Edge and Brave (Chromium 120+).
- If `chrome.tts` has no voices, the Web Speech API is used instead.
- Browser pages (`chrome://`, the extension stores) cannot be scripted, so the popup shows a notice there.

## Tests
```
node tools/smoke-test.js reading-studio
node reading-studio/test/run-tests.js
```
`test/run-tests.js` loads the extension in headless Chromium and checks the following against the local pages in `test/`:
- extraction, the reader overlay and typography
- sentence segmentation
- read-aloud with a silent mock engine: highlighting, skipping, click-to-jump, speed, resume, sources
- dynamic and filter dark mode, sliders, per-site rules and already-dark detection
- the ruler and bionic text
- background messaging, the popup and the options page

## Known limitations
- Reader extraction is heuristic. Unusual layouts (heavy single-page apps, paywalled or script-rendered articles) may give partial results. You can always read the whole page aloud instead.
- Dynamic dark mode cannot read cross-origin stylesheets directly. Those colors are handled by the computed-style sweep, which may miss pseudo-elements. Filter mode is the fallback for stubborn sites.
- Word highlighting depends on the voice sending word-boundary events. Some voices (often online ones) only report sentence starts.
- The dyslexia-friendly option uses fonts installed on your system. No font files are bundled.
