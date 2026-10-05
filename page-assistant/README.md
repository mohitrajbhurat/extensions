# Page Assistant

Summarize, question and study long articles, docs and PDFs without leaving the page. In the spirit of Sider, Merlin and Glasp, but everything runs on your device and it is free: Chrome's built-in AI when it is available, and a complete offline engine (TextRank, keyword search, readability) everywhere else. Press **Ctrl+Shift+Y** on any page.

## Features

### Reading the page
- **Own readability-style extraction** (`content/extract.js`): scores content blocks, drops navigation, ads, cookie banners, comments, share bars, sidebars and footers. Handles semantic articles, "div soup" blogs (splits `<br><br>` paragraphs), docs with code blocks and tables, title / byline / date / site name from metadata.
- **Selected text**: grab the page selection into the Tools tab, or summarize only the selection.
- **PDFs** opened in the browser viewer: the file is downloaded and parsed by a built-in PDF text reader (`lib/pdf.js`: FlateDecode, font ToUnicode maps, line and paragraph reconstruction). Scanned PDFs without a text layer are reported as such.

### On-device AI (Chrome built-in APIs, feature-detected)
- **Summarizer API**: key points, TL;DR or headline; short, medium or long. Long pages are chunked and summarized map-reduce style within the model's input quota.
- **Prompt API (LanguageModel)**: streaming multi-turn Q&A chat grounded in the page (the most relevant passages are fed as context for long pages), explain selection, simplify, flashcards and a multiple-choice quiz from the page.
- **Writer / Rewriter APIs** when present: rewrite the selection (tone, length) and draft text about the page (share post, email to a colleague, discussion questions, study notes, custom).
- **Availability states** shown in the status bar: ready, needs download (with a **Download** button and progress bar), downloading, unavailable, unsupported. Actions never wait on a download: until the model is ready the offline engine answers.
- Output language: match the page, English, Spanish or Japanese.

### Offline engine (always available, used automatically as fallback)
- **Extractive summary** with TextRank over sentences (abbreviation-aware splitting, Porter stemming, position and title boost, redundancy filter).
- **Keywords** (multi-word phrases), **outline** from headings (or topic segments when a page has none), **reading time**, word count, **Flesch reading ease** and grade level.
- **Keyword Q&A**: BM25-style passage ranking returns the best passages with matched terms marked, and **highlights them in the page** (CSS Custom Highlight API, with a `<mark>` fallback). Click any key point or source to jump to it.
- Offline explain / simplify, flashcards (definition and cloze) and quiz.

### Everywhere
- **Context menu** on a selection: Explain, Summarize selection, Ask about this, Simplify. On a page: Summarize this page, Ask about this page.
- **History per URL** of summaries and answers (tracking parameters ignored), searchable, with delete and clear.
- **Copy as Markdown** for summaries, answers, study sets and history entries; flashcards export to Anki-compatible TSV.
- Side panel follows the active tab (optional), auto-summarize on open (optional).

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `page-assistant` folder.
4. Optional: in Chrome, enable built-in AI (Chrome 138+ on supported hardware; see `chrome://on-device-internals`). Without it the extension works fully in offline mode.

The UI opens in Chrome's **side panel**. Where the Side Panel API is missing (some Edge and Brave builds) it opens as a small popup window bound to the tab you were on.

## Keyboard shortcuts

| Key | What it does |
|---|---|
| Ctrl+Shift+Y (Mac: Command+Shift+Y) | Open Page Assistant for the current tab |
| *(unbound)* Summarize page | Open and summarize. Bind at `chrome://extensions/shortcuts` |
| *(unbound)* Explain selection | Open and explain the selected text |
| Alt+1 … Alt+6 | Switch tabs: Summary, Ask, Tools, Study, Insights, History |
| ← → / Home / End on the tab bar | Move between tabs |
| Enter / Shift+Enter in chat | Send / new line |
| ← → in flashcards | Previous / next card |
| Esc | Stop the running AI operation |

## Permissions

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Read the page you open the assistant on (only after you click the icon, press the shortcut or use the context menu) and draw highlights. |
| `sidePanel` | Show the assistant next to the page (feature-detected; popup window fallback). |
| `contextMenus` | Explain / Summarize / Ask / Simplify on selected text. |
| `storage` | Settings and per-URL history, stored locally. |
| `<all_urls>` (optional) | Only if you click **Allow on all sites** in Settings: lets the panel read pages as you switch tabs and download PDFs. Removable at any time. |

No network requests are made except downloading the PDF you are viewing. No accounts, no analytics; page content never leaves your device.

## Files

- `background.js`: service worker; opens the panel or popup window, context menus, commands.
- `sidepanel/`: the UI (also used as the fallback popup window with `?mode=window`).
- `content/extract.js`, `content/highlight.js`: injected on demand for extraction and highlighting.
- `lib/nlp.js` (offline engine), `lib/ai.js` (built-in AI wrappers), `lib/pdf.js` (PDF text), `lib/history.js`, `lib/markdown.js` (safe Markdown renderer).

## Tests

```
node --test page-assistant/test/*.test.js
```

Unit tests for the offline engine and PDF reader, plus Playwright end-to-end tests that load the extension in Chromium and drive extraction, highlighting, summarizing, Q&A, study, history and context-menu hand-off against the fixtures in `test/fixtures/`.

## Known limitations

- Built-in AI depends on Chrome version, hardware and a one-time model download; Edge and Brave use the offline engine.
- Pages inside cross-origin iframes and canvas-rendered apps (e.g. Google Docs) can't be extracted; select text and use the Tools tab instead.
- Highlights are not available inside the PDF viewer. Encrypted or image-only PDFs can't be read.
- Without the optional all-sites permission, switching tabs requires pressing the shortcut or icon again to read the new page.
