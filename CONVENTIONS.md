# Extension conventions

Every top-level folder (except `tools/`) is one self-contained browser extension.

## Hard rules
- Manifest V3. Plain HTML, CSS and JavaScript (ES modules allowed in extension pages and the service worker with `"type": "module"`). No build step, no bundler, no `package.json`, no `node_modules`.
- The folder must load as-is via **Load unpacked** in Chrome, Edge and Brave (Chromium 120+).
- Works offline. No accounts, no paid APIs, no remote code (MV3 forbids loading remote scripts). No network calls except fetching the pages the user is working with, or what the extension's feature inherently needs (for example the API client sending the user's requests).
- No third-party libraries unless they are already vendored in the folder's `vendor/` directory. Write your own code.
- All data stays local: `chrome.storage.local`, `chrome.storage.sync` for small settings, or IndexedDB for large data.
- Ask for the minimum permissions. Prefer `activeTab` plus `scripting` over `<all_urls>` host permissions when the feature only runs on user action. Use `optional_host_permissions` where it makes sense.
- Chrome-only APIs (built-in AI such as `LanguageModel`, `Summarizer`, `Translator`; `sidePanel`) must be feature-detected, with a graceful fallback so the extension still works in Edge and Brave.
- Must not override the new tab page unless the roster says so (only `home-base` does).

## Required files
```
<folder>/
  manifest.json        name, short description, version "1.0.0", icons 16/32/48/128
  icons/icon.svg       128x128 viewBox source icon (distinct color and simple glyph)
  icons/icon16.png ... icon128.png   generated: node tools/make-icons.js <folder>
  README.md            what it does, features, how to load, permissions and why, keyboard shortcuts
  background.js        (service worker) required, even if small, so the smoke test can find the extension
  ...                  popup/, options/, sidepanel/, content/ etc. as needed
```

## UI style
Clean, modern, system font stack, light and dark mode via `prefers-color-scheme`, CSS custom properties for colors, 8px spacing grid, rounded corners, visible focus states, keyboard accessible. Popups 360 to 420px wide. Full-page apps use the whole tab responsively.

## Keyboard shortcuts (manifest `commands`)
Only these suggested keys are reserved, to avoid conflicts across the suite. Other extensions may declare commands without `suggested_key` (users bind them at chrome://extensions/shortcuts).
| Extension | Suggested key |
|---|---|
| command-palette | Ctrl+Shift+K (Mac: Command+Shift+K) |
| page-assistant | Ctrl+Shift+Y |
| research-canvas | Ctrl+Shift+E |
| reading-studio | Alt+Shift+R |
| capture-studio | Alt+Shift+S |
| type-kit | Alt+Shift+V |

## Verify before finishing
1. `node tools/make-icons.js <folder>`
2. `node tools/smoke-test.js <folder> [extra-page.html ...]`: must print PASS (service worker boots, every manifest page opens with no console errors). Pass any full-page app pages as extra arguments.
3. For content-script features, write a quick Playwright check (see smoke-test.js for how to launch with the extension) against a local test HTML file served with `python3 -m http.server`, or a `data:`/file page, and confirm the core feature works. Delete throwaway test files afterwards, or keep a small one under `<folder>/test/` if useful.
4. `node --check` every .js file.
