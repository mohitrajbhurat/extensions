# Pocket Tools

An everyday utility belt in one popup: a password and passphrase generator, a QR code maker (and reader), a word counter with readability scores and case conversion, and converters for units, time zones, number bases and unix timestamps. Select "5 miles", "72°F" or "3pm PST" on any page to get a conversion tooltip.

Everything runs locally. There are no accounts, no network calls and no third-party libraries. The QR encoder, Reed-Solomon coder, word list and converters were all written for this extension.

## Features

### Password generator
- Three modes: **random password** (4–128 characters, A–Z / a–z / 0–9 / symbols, optional "exclude look-alikes" such as `I l 1 O 0`), **pronounceable** (alternating consonant/vowel syllables plus digits and a symbol) and **passphrase** (3–20 words from a bundled list of 1,889 common English words, custom separator, capitalisation, optional number).
- Uses `crypto.getRandomValues` with rejection sampling, so there is no modulo bias.
- **Exact entropy**: for random passwords that must contain every chosen class, the count of valid strings is computed with inclusion–exclusion (BigInt), not estimated.
- Strength meter, and estimated time to crack offline (10 billion guesses/s) and online (1,000 guesses/s).
- **Copy with auto-clear**: the clipboard is cleared after 30 s (configurable: never to 5 minutes) by an offscreen document, even after the popup closes.
- **Stores nothing**: generated values are never saved. Only your generator options are kept (in `chrome.storage.sync`).

### QR codes
- Encoder written from ISO/IEC 18004: numeric, alphanumeric and byte (UTF-8) modes, versions 1–40, error correction L/M/Q/H, Reed-Solomon over GF(256), all 8 masks scored with the 4 penalty rules, format and version information.
- Content: the current page URL, any text or link, **Wi-Fi** (WPA/WEP/open, hidden networks, proper escaping) and **contacts** (vCard 3.0).
- Right-click to make a QR code for the page, a link or the selected text.
- Module size, quiet zone, dark/light colours, with contrast and inverted-colour warnings. Shows version, mask, mode and capacity used.
- Download as **PNG** or **SVG**, or copy the image.
- **Scan** a QR code from an image (drop, paste or choose a file) where the browser provides `BarcodeDetector` (Chrome on macOS, ChromeOS and Android). Elsewhere the tab explains that scanning is unavailable.

### Text statistics
- Words, characters (grapheme-aware, with and without spaces), sentences, paragraphs, syllables, reading time (238 wpm) and speaking time (150 wpm), average word length.
- Flesch reading ease and Flesch–Kincaid grade level.
- Top keywords with counts and density (stop words removed).
- Case converter: UPPER, lower, Title Case (keeps small words lowercase), Sentence case, camelCase, PascalCase, snake_case, kebab-case and CONSTANT_CASE. Applies to the selected part of the text if there is one. Undo is available.
- "Use page selection" pulls the selected text from the current tab. Right-click → **Count words in selection** does the same.
- The draft is kept only in session storage, which is cleared when the browser closes.

### Converters
- **Quick convert** box: type anything the tooltip understands.
- **Units**: length, mass, temperature, volume (US and imperial), area, speed, data (decimal and binary prefixes) and time. Click any result to copy it.
- **Time zones**: your clock plus up to 8 cities (any IANA zone through `Intl`), live, with offsets and day differences. A **meeting planner** shows a 24-hour grid for any date, highlighting hours that are working hours everywhere (configurable, default 9:00–17:00) and hours when everyone is awake. DST is handled through `Intl`.
- **Number bases**: binary, octal, decimal, hex or any base 2–36, with arbitrary precision (BigInt), negative numbers, and the character for a code point.
- **Unix timestamps**: live "now" values, and conversion of seconds, milliseconds, microseconds or nanoseconds (detected from magnitude) to local, UTC, ISO 8601 and relative time, and back from a date.

### Selection conversion tooltip
Select a value on a page to see conversions in a small tooltip. Click a value to copy it; press Esc to close. It recognises:
- quantities: `5 miles`, `72°F`, `-3 °C`, `5'11"`, `1,200 sq ft`, `2½ cups`, `100 km/h`, `4 GiB`, `90 min`
- times with a zone: `3pm PST`, `15:30 CET`, `9:15 a.m. ET`, `noon UTC`, `8pm UTC+5:30`, `10am Tokyo`. These are shown in your time zone and your saved cities.
- `0xFF` / `0b1010` / `0o17` literals, and 10- or 13-digit unix timestamps

There are two ways to use it:
1. **On demand (default)**: right-click a selection and choose **Convert "…"**, or use the *Show conversions for the selected text* shortcut. This uses `activeTab`, so the extension only touches that page when you ask.
2. **Automatic (opt-in)**: tick *Show a conversion tooltip when I select values on web pages* in the Convert tab or in Settings. The browser asks for site access once. Turning it off removes that access again.

## Install (Load unpacked)
1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `pocket-tools` folder.
4. Pin Pocket Tools from the toolbar's extensions menu.

Works in Chrome, Edge and Brave 120 or newer, with no build step.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your settings (generator options, QR look, cities, clipboard timer) and hands context-menu selections to the popup through session storage. |
| `contextMenus` | Right-click items: Convert, QR code for selection / link / page, Count words. |
| `activeTab` | Reads the current tab's URL for the QR code, and the selected text when you click a menu item, use a shortcut or press "Use page selection". |
| `scripting` | Injects the tooltip or reads the selection in the active tab when you ask. It also registers the automatic tooltip if you turn that on. |
| `offscreen` | A hidden page that can write to the clipboard, so a copied password is cleared on time after the popup closes. |
| `clipboardWrite` | Lets that hidden page copy and clear without a click. |
| Optional: `http://*/*`, `https://*/*` | Only requested if you turn on the automatic selection tooltip. It is removed again when you turn the tooltip off. |

There is no `tabs` permission, no host access by default and no network access.

## Keyboard shortcuts

Pocket Tools declares these commands **without default keys**, so it never clashes with other extensions. Assign keys at `chrome://extensions/shortcuts` (the Settings page has a button for it):
- **Open Pocket Tools** (opens the popup)
- **Generate a password with your saved options and copy it**: copies straight to the clipboard, with auto-clear.
- **Show conversions for the selected text**
- **Show a QR code for the current page**

Inside the popup:
- `Alt+1` … `Alt+4` switch between Password, QR code, Text and Convert.
- Arrow keys, `Home` and `End` move between tabs.
- On the Password tab, `R` regenerates and `C` copies.

## Files
```
manifest.json
background.js            service worker: menus, commands, tooltip registration, clipboard
offscreen/               clipboard copy + timed clear
popup/                   tabbed popup (gen.js, qrtab.js, texttab.js, convtab.js, util.js)
options/                 settings page
content/tooltip.js       selection tooltip (shadow DOM, injected on demand or registered)
lib/qr.js                QR encoder (modes, RS, masks, SVG/canvas output, Wi-Fi/vCard payloads)
lib/password.js          generators, exact entropy, crack-time estimates
lib/wordlist.js          1,889-word passphrase list
lib/textstats.js         counts, readability, keywords, case conversion
lib/units.js             unit tables, parsing, conversion
lib/timeutil.js          time zones, "3pm PST" parsing, meeting planner, timestamps, bases
lib/convert.js           free-text conversion used by the tooltip and quick convert
lib/settings.js          defaults and storage helpers
shared/ui.css            design tokens (light and dark)
test/                    node:test suites
```

## Tests
```
node --test pocket-tools/test/*.test.mjs
```
- `qr.test.mjs` checks the encoder against published values: the "HELLO WORLD" 1-M codewords, alignment positions, capacity tables and the version-7 information block. It also decodes every generated symbol with an independent reader written in the test. That reader parses the format bits, unmasks, de-interleaves, verifies the Reed-Solomon syndromes and parses the segments.
- `converters.test.mjs` covers units, temperature, parsing, DST-aware time zones, "3pm PST" parsing, the meeting planner, timestamps and bases.
- `tools.test.mjs` covers the password generator (classes, exact entropy, uniformity), passphrases, text statistics and case conversion.

## Limitations
- QR scanning depends on the browser's `BarcodeDetector`. It is not available in desktop Chrome on Windows or Linux, nor in Edge or Brave on those platforms.
- The encoder uses one segment per code (it picks the most compact mode for the whole text) and does not use Kanji mode or ECI.
- Clipboard auto-clear overwrites the clipboard when the timer ends, even if you copied something else in the meantime. Reading the clipboard first would need an extra permission.
- Fixed abbreviations are taken literally: `PST` is always UTC−8, even in summer. Use `PT` for "whatever Pacific time is today".
- Readability formulas and syllable counts are designed for English.
