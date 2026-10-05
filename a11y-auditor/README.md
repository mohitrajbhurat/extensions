# Accessibility Auditor

Find the accessibility barriers on any web page and learn how to fix them. Accessibility Auditor runs 67 automated checks mapped to WCAG 2.2. It works like axe DevTools or WAVE, but it uses its own rule engine and runs entirely in your browser.

## Features

- **67 rules mapped to WCAG 2.2.** Each rule has an impact level (critical, serious, moderate, minor), its success criteria and conformance level, an explanation, a fix, and links to the W3C "Understanding" pages.
  - **Contrast (1.4.3, 1.4.6 AAA):** the effective background is computed by compositing every ancestor layer, including translucent colours and inherited `opacity`. Large-text thresholds apply. Text over background images or gradients, or with a text shadow, is flagged for manual review.
  - **Text alternatives:** missing `alt` on images, image buttons, image-map areas, `role="img"`/SVG and `<object>`. Suspicious alt text such as file names, "image", or text that repeats a caption. Server-side image maps.
  - **Names:** empty or ambiguous links ("click here"), buttons without a name, form fields with no label or only a placeholder or title, multiple labels, invalid `autocomplete` values, label-in-name mismatch (2.5.3), unnamed ARIA widgets, frames without a title, and frames that share a title.
  - **Structure:** heading order, empty headings, a missing `<h1>`, the main landmark, duplicate banner and contentinfo landmarks, landmarks without a unique name, content outside landmarks, bypass blocks, list, `dl` and table semantics (header cells, `headers` attribute, empty headers).
  - **ARIA validity:** invalid or abstract roles (with "did you mean" suggestions), unknown `aria-*` attributes, invalid values and dangling id references, attributes the role does not allow, attributes the role prohibits, required attributes, required children and parents, `aria-hidden` on focusable content or on `<body>`, and ignored `role="none"`.
  - **Accessible name:** names are computed with a built-in implementation of a subset of accname 1.2. It covers `aria-labelledby`, `aria-label`, labels, alt, legend, caption, content, title and placeholder.
  - **Keyboard and focus:** positive `tabindex`, click handlers that are not keyboard accessible (inline handlers, plus a "pointer cursor" heuristic), scrollable regions that cannot be focused, nested interactive controls, and focus outlines that style sheets remove with no replacement (2.4.7).
  - **Page:** missing or invalid `lang` (also on individual parts of the page), missing `<title>`, `user-scalable=no` or `maximum-scale` below 2, timed meta refresh, autoplaying audio, video without captions, `<blink>`/`<marquee>`, duplicate ids, duplicate `accesskey` values.
  - **Target size (2.5.8):** targets smaller than 24x24 px fail unless they meet the spacing exception (a 24 px circle centred on the target overlaps no other target) or are inline links in text.
- **Two kinds of findings.** *Violations* are definite failures. *Needs review* items are heuristic findings that a person should confirm.
- **Results UI.** Results appear in the side panel, or in the popup where the side panel is not available. You can group them by severity or by rule. You can filter them by severity chip or by text search. Each finding shows a count, the code snippet, the CSS selector and the WCAG links. **Show on page** scrolls to the element and outlines it, and **Copy selector** copies its selector.
- **On-page overlays:**
  - Issue markers: coloured badges on every element that has a finding.
  - Tab-order visualiser: every keyboard stop is numbered and connected by a path. Positive tabindex stops are shown in red.
  - Headings and landmarks labels drawn on the page.
  - Colour-vision simulation using SVG filters: protanopia, deuteranopia, tritanopia, achromatopsia, plus blurred vision.
- **Structure tab.** Shows the heading outline (skipped levels are flagged), the landmark tree and the tab-order list. Click any entry to find it on the page.
- **Frames and shadow DOM.** The auditor checks every frame it is allowed to reach. Open shadow roots are included.
- **Export** to a self-contained **HTML** report, **JSON** or **CSV**. The CSV export is safe to open in spreadsheets.
- **Toolbar badge.** Shows the violation count for the scanned tab. Results are marked stale when the page reloads or navigates.

## How to load

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `a11y-auditor` folder.
4. Pin the extension. Open a web page and click the toolbar button: the popup scans the page right away. Click **Side panel** to keep the results open while you work.

To audit local `file://` pages, turn on **Allow access to file URLs** in the extension's details.

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab` | Read the current page only after you click the toolbar button or use the shortcut. |
| `scripting` | Inject the audit engine and overlays into that page (and into its frames). |
| `storage` | Store your settings and the latest results for each tab. Results are kept in session storage and deleted when the tab closes. |
| `sidePanel` | Show the results in the browser side panel. The extension checks that this feature exists and falls back to the popup where it does not. |
| `<all_urls>` (optional) | Off by default. Grant it from **Tools > Site access** if you want to rescan from the side panel after navigating, or audit cross-origin iframes, without clicking the toolbar button again. |

The extension makes no network requests. Nothing leaves your browser. The only external links are the W3C documentation links in the results, and they open only when you click them.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| (unassigned) `Open Accessibility Auditor` | Opens the popup. Assign a key at `chrome://extensions/shortcuts`. |
| (unassigned) `Scan the current tab` | Scans without opening any UI; the count appears on the toolbar badge. Assign a key at `chrome://extensions/shortcuts`. |
| `/` | Focus the issue filter (in the popup or side panel). |
| `Esc` | Remove the highlight from the page. |
| Arrow keys, `Home`, `End` | Move between the Issues, Structure and Tools tabs. |

## Settings (Tools tab)

- **Include AAA rules:** enhanced contrast and link purpose (link only). Off by default.
- **Include best practices:** heading order, landmarks, duplicate ids and other checks that are not WCAG requirements. On by default.
- **Show "needs review" items** and **Show markers after each scan**.

## Known limitations

- Automated testing finds only part of all accessibility problems. Always test with a keyboard and a screen reader.
- Contrast is computed from CSS. Text placed over images, gradients, or absolutely positioned elements that are not its ancestors cannot be measured exactly. That text is flagged for review, or its contrast is measured against the nearest ancestor background.
- Event listeners added with `addEventListener` cannot be seen by extensions. Keyboard-access checks therefore rely on inline handlers and a `cursor: pointer` heuristic.
- The focus-visible check reads same-origin style sheets only. Cross-origin CSS cannot be read.
- Cross-origin iframes are audited only when the optional all-sites permission is granted. Closed shadow roots are never reachable.
- The tab-order overlay covers the top document.

## Development

- `node tools/make-icons.js a11y-auditor` regenerates the PNG icons from `icons/icon.svg`.
- `node tools/smoke-test.js a11y-auditor` checks that the service worker and pages load without errors.
- `node a11y-auditor/test/run-tests.js` runs the engine tests and the end-to-end extension tests (scan, overlays, UI, exports) against `test/fixtures/`.

### Files

```
manifest.json
background.js          service worker: badge, stale results, "scan current tab" command
lib/color.js           colour parsing, compositing, contrast maths
lib/aria.js            WAI-ARIA 1.2 role/attribute tables
lib/accname.js         roles, visibility, accessible name, selectors
content/engine.js      the rule engine (injected into pages)
content/overlay.js     highlight, markers, tab order, structure labels, colour filters
ui/                    shared popup/side panel UI, scanning helpers, exporters
popup/, panel/         entry pages
test/                  fixtures and Playwright tests
```
