# Design Inspector

Work out how any website was designed. Design Inspector puts a small toolbar on the current tab. Use it to inspect the box model and type, measure gaps, pick colors and check contrast, pull out the page's palette and typography as design tokens, try live edits, and download the images. It is modeled on CSS Peeper, VisBug, WhatFont and ColorZilla. Everything runs locally and needs no account.

## Features

### Inspect (`I`)
- Hover any element to see its margin, border, padding and content boxes, with the size and the margin and padding numbers drawn on the page.
- A tooltip shows the tag, id and classes, the size, the font that actually renders (not just the first name in the stack), font size, line height, weight, text color, background color and the contrast ratio.
- Click to pin an element. The card groups its CSS into Layout & box, Typography, Background & border and Effects, and leaves out default values. It also shows the element's colors with a WCAG contrast check against the background you actually see (it composites the ancestors' backgrounds).
- Use **Parent**, **Child**, **←** and **→** to move around the DOM tree. **Copy CSS** copies a ready-to-paste rule, and **Copy selector** copies a short, stable selector.
- Clicks on the page don't trigger links or buttons while you inspect.
- Open shadow roots of web components are inspected too.

### Measure (`M`, or hold `Alt`)
- While inspecting, hold **Alt** to see the distances from the pinned element (or the parent, if nothing is pinned) to the element under the cursor.
- Measure mode: click one element, then hover another to see the pixel gaps between them. When one element is inside the other, it shows the inset on all four sides.

### Rulers & guides (`R`)
- Rulers in page coordinates run along the top and left edges, with a marker that follows the cursor.
- Drag from a ruler to add a guide. Drag a guide to move it. To remove one, drag it back onto the ruler, double-click it, or focus it and press Delete. A focused guide also moves with the arrow keys (Shift moves it 10px). The corner button clears all guides.

### Eyedropper & contrast (`C`)
- Uses the built-in **EyeDropper API** where it's available (Chrome and Edge). Otherwise it falls back to a **screenshot loupe**: a magnifier showing an 11×11 pixel grid. Arrow keys move it 1px (Shift moves 10px), Enter picks and Esc cancels. You can choose the loupe even when the EyeDropper API exists.
- Shows the color as **HEX, RGB, HSL and OKLCH**, each with a copy button. You can also type any CSS color.
- Keeps a **history palette** of the last 32 picks, saved locally. Shift-click a swatch to copy it, and use **Copy as CSS** to get the history as custom properties.
- **Contrast checker** with WCAG verdicts for AA and AAA normal text, AA and AAA large text, and 3:1 for UI components. It has a live preview, a swap button and a suggested nearest text color that passes AA (found by adjusting OKLCH lightness).

### Palette & type (`P`)
Scans the visible page (up to 8,000 elements):
- **Colors** grouped by hue family and sorted by usage. You can filter by text, background, border or SVG fill and stroke. The tab also lists CSS color variables declared on `:root`. Click a swatch to copy it.
- **Type**: the rendered font families, the most common type styles (family, size, weight and line height together) and the distributions of font sizes, weights and line heights.
- **Spacing**: margins, paddings and gaps by frequency, with 4px and 8px grid detection.
- **Effects**: border radii and box shadows with previews.
- **Export**: **CSS variables**, **JSON design tokens** in the W3C DTCG format, or a **Tailwind config** (`theme.extend`). You can copy or download the export and set how many colors it includes. Colors get names like `blue-600`, using a Tailwind-like OKLCH lightness scale. Font sizes are named around `base` (`sm`, `lg`, `xl` and so on).

### Live edit (`E`)
- Click an element to select it. Press **Enter** or click **Edit text** to edit its text in place, and press **Esc** to finish.
- Nudge spacing with the keyboard:
  - **Arrow keys** add 1px of margin on that side.
  - **Shift+Arrow** adds 1px of padding instead.
  - **Alt** makes the step 10px.
  - **Ctrl/Cmd** shrinks instead of grows.
- Margin and padding fields: Arrow keys change a value by 1px, Shift+Arrow by 10px.
- Change the text, background and border colors, the font family (with suggestions from the fonts the page loaded), size, weight, line height, letter spacing, width, height and radius. You can also type any extra declarations.
- **Resulting CSS** shows every edit as rules plus notes on text changes, ready to copy. **Reset element** and **Reset all** undo the edits.

### Assets (`A`)
- Lists `<img>` images (the source actually loaded), inline SVGs (exported as standalone files, with `<use>` sprite references inlined), CSS background, mask and pseudo-element images, video posters, favicons and social images.
- Filter by type or search by name or URL, with a thumbnail and dimensions for each. You can download one asset, use **Download all**, copy URLs or copy the SVG code. Downloads are saved to `Downloads/design-inspector/<site>/`.

## How to load
1. Open `chrome://extensions` (or `edge://extensions` or `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `design-inspector` folder.
4. Pin the extension and click its toolbar button on any web page. Click the button again, or press Esc a few times, to close it.

It can't run on browser pages (`chrome://`, the Web Store and similar). When that happens, the badge shows "no" for a moment.

## Keyboard shortcuts
| Key | Action |
|---|---|
| (unbound) | Toggle the inspector. Set a key at `chrome://extensions/shortcuts` |
| `I` | Inspect mode |
| `M` | Measure mode |
| `R` | Rulers & guides |
| `C` | Pick a color |
| `P` | Palette & type panel |
| `E` | Live edit mode |
| `A` | Assets panel |
| `Alt` (hold) | Measure distances while inspecting |
| `Esc` | Step back: stop text editing, unpin, close the panel, leave the mode, then close the inspector |
| `←` `→` | Move between toolbar buttons |

The single-letter keys only work while the toolbar is open and focus isn't in a text field.

## Permissions
| Permission | Why |
|---|---|
| `activeTab` | Gives access to the current tab only after you click the toolbar button (or use its shortcut). There are no host permissions, and the extension never runs on pages you don't activate it on. |
| `scripting` | Injects the toolbar into the active tab when you click the button. |
| `storage` | Saves the color history, contrast pair, loupe preference and toolbar position locally. |
| `downloads` | Saves assets with sensible file names, including cross-origin images that a plain link can't download. |

`captureVisibleTab` (for the loupe fallback) is covered by `activeTab`. The content modules are listed as `web_accessible_resources` because the toolbar loads them with a dynamic `import()`. They contain no page-specific data.

## Privacy
There are no network requests apart from downloads you start. Nothing leaves your browser, and live edits only change the page in your tab until you reload it.

## Files
```
manifest.json
background.js          service worker: inject on click, tab capture, downloads, badge
content/boot.js        injected bootstrap: loads app.js once, toggles on later clicks
content/app.js         shadow-DOM host, toolbar, panel manager, event routing, shortcuts
content/inspect.js     box model overlay, tooltip, pinned card, CSS capture
content/measure.js     distances, Measure mode, rulers and guides
content/eyedropper.js  EyeDropper / screenshot loupe, formats, history, contrast checker
content/extract.js     page scan, token naming, CSS / DTCG JSON / Tailwind export
content/liveedit.js    text editing, nudging, style fields, resulting CSS
content/assets.js      asset collection and downloads
content/color.js       color parsing and conversion (HEX/RGB/HSL/OKLCH), WCAG math
content/css.js         UI stylesheet (light and dark)
content/util.js        DOM, clipboard and storage helpers
test/                  unit tests (node:test) and a Playwright end-to-end test
```

## Tests
```
node --test design-inspector/test/unit.test.mjs   # unit tests: color math, distances, tokens, exports, helpers
node design-inspector/test/e2e.js           # Playwright: every feature against test/fixture.html
node tools/smoke-test.js design-inspector   # service worker boots
```

## Known limitations
- Cross-origin iframes and closed shadow roots can't be inspected. The iframe or host element itself is shown instead.
- The palette scan reads computed styles, so colors used only in `:hover` states or media queries that don't currently match are not included.
- The screenshot loupe samples a still image taken when picking starts, so animated content may have changed since.
- Live edits use inline `!important` styles and are lost on reload. Copy the resulting CSS to keep them.
- CSS variables are only read from same-origin stylesheets.
