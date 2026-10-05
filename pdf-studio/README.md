# PDF Studio

View, annotate, fill, sign and rearrange PDFs without paying for a subscription or uploading anything. PDF Studio does the everyday jobs of Smallpdf, Kami and Acrobat, and it does them entirely inside your browser. Files never leave your computer.

## Features

### Viewer (`viewer/viewer.html`)
- Open a PDF with the file picker (Ctrl+O), by dropping it on the page, or by pasting a link.
- **Open in PDF Studio**: right-click a link to a PDF. You can also click the toolbar button while a PDF is open in a tab. For a link on another site, PDF Studio asks for access to that site the first time.
- Page thumbnails, zoom (buttons, Ctrl +/-, Ctrl+wheel at the cursor), fit width, fit page, and page navigation.
- Selectable text layer. Search (Ctrl+F) highlights every match, with match-case and whole-word options.
- A dark viewing mode inverts the pages for night reading. The app also follows your system light or dark theme.
- Password-protected PDFs open after you enter the password.

### Annotate
- Highlight, underline and strikeout on selected text.
- Freehand pen, rectangles, ellipses, lines and arrows, with color, width and fill options.
- Text boxes with a choice of font and size, plus sticky comments.
- Inserted images.
- Select, move, resize, nudge and delete annotations, with full undo and redo.
- Unsaved work is kept as a local draft and offered back when you reopen the same file.
- **Download** (Ctrl+S) writes everything into the PDF with pdf-lib. Drawings are flattened into the page, and sticky comments become real PDF comments that other readers can show.

### Fill & Sign
- Fill AcroForm fields: text, checkboxes, radio buttons, dropdowns and lists. You can keep the form editable or flatten it.
- Signatures can be drawn, typed in a choice of script styles, or made from an uploaded image, with optional background removal. Saved signatures can be reused later.
- Place a signature, then drag it and resize it.
- Stamp today's date in a format you choose. Check, cross and dot marks are also available.

### Page tools (`tools/tools.html`)
- **Merge**: combine any number of PDFs. Drag them into order and optionally pick pages from each file (for example `1-3, 7`).
- **Split**: split by custom ranges (one PDF per range), split every N pages, or extract selected pages. Several results download as a single .zip.
- **Organize**: drag thumbnails to reorder pages. You can rotate, delete, extract or move the selection, and insert blank pages. Several PDFs can be combined here too. Includes undo and reset. Click **Open in viewer** to keep working on the result.
- **Images to PDF**: JPG, PNG, WebP, GIF and BMP, one image per page. Page size can match each image or be A4, Letter, Legal or A5, with orientation and margin options. Phone photos are rotated upright using their EXIF data.
- **Compress**: a lossless rebuild with object streams, which drops unused objects and keeps form fields and bookmarks. Or rasterize each page to JPEG at 72 to 300 DPI, with quality control and an optional grayscale conversion. The tool shows the size before and after.

## How to load
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `pdf-studio` folder.
4. Click the PDF Studio toolbar button. Right-click the button for **Page tools**.

To open local `file://` PDFs by link, turn on **Allow access to file URLs** on the extension's details page. Dropping a file or using the picker always works without it.

## Permissions and why
| Permission | Why |
|---|---|
| `contextMenus` | Adds "Open in PDF Studio" for PDF links, and the toolbar button's menu. |
| `activeTab` | When you click the toolbar button on a tab that shows a PDF, lets PDF Studio read that one PDF. |
| `storage` | Stores small settings such as dark mode, tool styles, date format and sidebar state. Drafts and saved signatures live in IndexedDB on this computer. |
| `optional_host_permissions` (http/https) | Requested one site at a time, only when you open a PDF link from that site, so the file can be downloaded into the viewer. |

No other network access. There are no accounts, no analytics and no remote code. pdf.js and pdf-lib are vendored in `vendor/` with their licenses.

## Keyboard shortcuts
| Where | Keys | Action |
|---|---|---|
| Browser | assign at `chrome://extensions/shortcuts` | Open the current PDF, or open Page tools |
| Viewer | Ctrl+O / Ctrl+S / Ctrl+F | Open, download with changes, search |
| Viewer | Ctrl + / Ctrl - / Ctrl 0 | Zoom in, zoom out, 100% |
| Viewer | PgUp, PgDn, Home, End | Navigate pages |
| Viewer | V H U K P R O L A T N D | Select, highlight, underline, strikeout, pen, rectangle, ellipse, line, arrow, text, comment, date |
| Viewer | Del, arrow keys (Shift = 10pt) | Delete or nudge the selected annotation |
| Viewer | Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y | Undo, redo |
| Viewer | ? | Show all shortcuts |
| Organize | Arrow keys, Space or Enter, Shift+arrows | Move focus, toggle selection, extend selection |
| Organize | Ctrl+arrows | Move the selected pages |
| Organize | R / Shift+R, Delete | Rotate right or left, delete |
| Organize | Ctrl+A, Ctrl+Z, Ctrl+S, Esc | Select all, undo, save, clear selection |

## Tests
```
node pdf-studio/test/pdfops.test.mjs      # page operations, ranges, zip, text wrapping
node tools/smoke-test.js pdf-studio viewer/viewer.html tools/tools.html
```

## Known limitations
- Annotations are flattened into the page content. Only sticky comments stay as editable PDF annotations, and existing annotations in a PDF are displayed but cannot be edited.
- Text boxes use the standard PDF fonts (Helvetica, Times, Courier). Characters outside Latin-1 are replaced with `?` in the saved file, and PDF Studio warns you when that happens.
- Encrypted PDFs can be viewed, but the page tools refuse them. Remove the password first.
- Compress makes no attempt to recompress images losslessly. For scanned documents, use the rasterize option.
- The toolbar button detects PDFs by URL (`.pdf` or `/pdf/`). For other PDF tabs, download the file and drop it in.
