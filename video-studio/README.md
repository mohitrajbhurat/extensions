# Video Studio: notes and speed control

Take better notes while you learn from video lectures. Video Studio adds keyboard speed control to any HTML5 video and lets you add timestamped Markdown notes, frame screenshots, chapter bookmarks and A-B loops without leaving the player.

It works on YouTube, Coursera, Udemy, Vimeo, edX and any other site that uses a standard `<video>` element. That includes videos inside open shadow roots, inside iframes, and videos that the page adds after it loads.

## Features

### Speed and playback
- Playback speed from 0.07x to 16x. Each step moves to the next point on the step grid, which is 0.1 by default.
- An overlay badge on the video shows the current speed and has buttons for rewind, slower, faster and advance. You can show it always, only when the speed changes, or never.
- Per-site speed memory: the speed you last chose on a site is reapplied to new videos on that site.
- An optional "force speed" setting keeps players from resetting your speed.
- A per-site on/off switch in the popup.
- Shortcut keys are ignored while you type in inputs, textareas and contenteditable areas.

### Notes
- Notes for each video are stored under a canonical key: the YouTube video ID, the Vimeo ID, or the page URL with tracking parameters removed. Notes stay attached to the video when the URL changes.
- The notes panel opens in Chrome's side panel. In Edge, Brave, or when you choose it in settings, it opens as a panel inside the page.
- Press **N** to add a note stamped with the current time. Notes use Markdown: bold, italic, code, lists, links and quotes are supported.
- Typing a time such as `12:34` in a note turns it into a link. Clicking the link, or the time on a note, seeks the video to that time.
- Press **P** to add a note with a screenshot of the current frame. The extension draws the frame to a canvas. When the video is cross-origin and taints the canvas, it captures the visible tab instead and crops the image to the video's rectangle.
- Notes can be edited and deleted. Each video page gets `#vst=` deep links, so a note's timestamp link opens the video at that time.

### Bookmarks and loops
- Press **B** to add a chapter bookmark. You can also add a named bookmark from the panel's Chapters tab and jump to any bookmark.
- Press **[** to set the loop start (A) and **]** to set the loop end (B). Press **\\** to turn the loop on or off. Loop markers are also available in the panel.

### Library
- The library lists every video that has notes. You can search across titles and note text.
- Each video can be exported as Markdown with timestamp links, or as a printable HTML page with the screenshots embedded. You can also print the page or save it as a PDF.
- You can export the whole library as a JSON backup and import it again. Importing merges with the notes you already have.

## Keyboard shortcuts

These keys work on the page while a video is present. You can rebind each one, or add modifier keys, in **Settings**.

| Key | Action |
|---|---|
| S / D | Slower / faster |
| R | Reset to 1x. Press again to return to the previous speed |
| G | Switch between your preferred speed (1.8x by default) and the current speed |
| Z / X | Rewind / advance 10 seconds (configurable) |
| V | Show or hide the speed badge |
| N | Add a note at the current time |
| P | Add a note with a frame screenshot |
| B | Add a bookmark |
| [ / ] / \\ | Set loop start / set loop end / toggle loop |

Browser-level commands have no default keys, to avoid conflicts with the rest of the suite. You can assign keys to them at `chrome://extensions/shortcuts`. They are: open notes panel, add note, add screenshot note and open library.

## How to load

1. Open `chrome://extensions` (or `edge://extensions` or `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `video-studio` folder.
4. Pages that were already open need a reload before the shortcuts work on them.

## Permissions

| Permission | Why |
|---|---|
| Content script on all sites | The speed keys, the overlay badge and note capture need to work on any page that has a video, including videos in iframes. The script stays idle on pages without video. |
| `storage`, `unlimitedStorage` | Settings are saved in `chrome.storage.sync`. Notes, screenshots and bookmarks are saved locally in IndexedDB, and screenshots can be large. |
| `activeTab` | Lets the extension capture the visible tab when a cross-origin video blocks canvas screenshots. |
| `sidePanel` | Shows the notes panel in Chrome's side panel. The extension checks for this feature and uses the in-page panel when it is not available. |
| Optional: all sites | Requested only when you choose to enable it in settings, or after a screenshot fails. It allows tab-capture screenshots from keyboard shortcuts, where `activeTab` has not been granted. |

All data stays on your device. The extension makes no network requests.

## Development

- Icons: `node tools/make-icons.js video-studio`
- Smoke test: `node tools/smoke-test.js video-studio library/library.html library/print.html`
- End-to-end test: `node video-studio/test/e2e.js`. The test generates a WebM video, serves it from two origins and runs the speed keys, notes, screenshots including the tab-capture fallback, loops, bookmarks, the panel, the library exports and JSON import/export in Chromium through Playwright.
