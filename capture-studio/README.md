# Capture Studio

Screenshots and screen recording for explaining things visually, without an account or a subscription. It is modeled on GoFullPage / Awesome Screenshot (capture and annotate) and Loom / Screencastify (record with your webcam and voice). Everything stays on your device: captures are stored in the extension's own IndexedDB and nothing is uploaded.

## Features

### Screenshots
- **Visible area**, **selected region** and **full scrolling page**, from the toolbar popup or the keyboard.
- **Region selection overlay** (Alt+Shift+S): drag a rectangle, with a live size readout in device pixels. In the overlay, **Enter** captures the visible area, **F** captures the full page and **Esc** cancels. The overlay is removed before the capture, so it never appears in the image.
- **Full page (scroll and stitch):**
  - Scrolls the page one screen at a time, captures each screen with `captureVisibleTab` and stitches the frames on a canvas.
  - Fixed and sticky elements (headers, cookie bars, chat buttons) are captured in the first frame, then hidden for the rest, so they do not repeat down the page.
  - Detects apps that scroll an inner container instead of the document and captures that container.
  - Handles `devicePixelRatio` (HiDPI screens give HiDPI images) and stays under Chromium's limit of 2 captures per second, retrying when it is rate-limited.
  - Very long pages are capped at Chromium's canvas limits (scaled down rather than failing). Scrollbars and smooth scrolling are disabled during the capture, and the page's scroll position and styles are restored afterwards.
  - Progress shows on the toolbar badge. It stops cleanly if you switch tabs during the capture.
- Every screenshot opens in the editor and is saved in the library.

### Annotation editor
- Tools: **arrow**, **rectangle**, **ellipse**, **freehand pen**, **text**, **highlighter**, **blur**, **pixelate** and **crop**.
- 8 preset colors plus a custom color picker, and 4 stroke sizes (the size also sets the text size and the blur or pixelate strength).
- **Select and move** annotations (mouse or arrow keys), recolor or resize the selected one, delete it, and double-click text to edit it. Hold Shift to draw squares and circles, or to snap arrows to 45 degrees.
- **Undo / redo** (200 steps). Annotations are saved as editable data, so you can reopen a screenshot from the library later and keep editing. The original image is never changed.
- Blur and pixelate work on everything beneath them, including earlier annotations.
- Crop with a draggable area and a size readout, then apply or reset it.
- **Download PNG or JPEG**, and **Copy to clipboard** as PNG.
- Zoom: fit to window, 100%, Ctrl+wheel and Ctrl+plus/minus.
- Open any image in the editor: choose a file, drag and drop, or paste with Ctrl+V.

### Screen recording
- **This tab:** records through `chrome.tabCapture` in an offscreen document, so you can keep using the tab, and even switch to other tabs, while it records. Tab audio stays audible while it is recorded.
- **A window** or **the entire screen:** a recorder tab uses `getDisplayMedia`, where the browser asks which window or screen to share. System audio is included when the browser and OS support it (for example Chrome on Windows, or a tab shared from Chrome).
- **Microphone + tab or system audio mixing** with the Web Audio API, with a choice of microphone and a live level meter in the recorder.
- **Webcam bubble:**
  - In tab recordings, a round, draggable camera bubble is placed on the page and recorded with it.
  - In window and screen recordings, the camera is composited into the video through a canvas. Drag the bubble on the preview to move it. You can change its size or hide it while recording.
- **Countdown** (off, 3 or 5 seconds), **pause / resume**, and a running **timer**.
- **Stop from the toolbar:** the toolbar badge shows the elapsed time (or "II" when paused). Click the button to pause, resume, stop or discard. Stopping with the browser's own "Stop sharing" bar, or closing the recorded tab, also saves what was recorded.
- The first time you record a tab with the microphone or camera, a one-time page asks for access. This is needed because the background recorder cannot show a permission prompt itself.

### Library
- **Recordings:** thumbnails, length, size and date; search by name.
- A **player** to watch, rename, download as **WebM**, or delete a recording.
- Recordings are saved with a correct duration, so they can be seeked in the player and in other apps (MediaRecorder output normally lacks one).
- **Trim:** set in and out points by dragging the handles, using the arrow keys, or pressing **I** and **O** at the playhead. Preview the range, then save a trimmed copy or replace the original. Trimming re-encodes the range with MediaRecorder in real time.
- **Screenshots:** a grid of all captures. Open one in the editor to keep annotating, or delete it.
- Shows how much local storage the library uses.

## Install (Load unpacked)
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `capture-studio` folder.
4. Optional: pin the toolbar button. Bind the extra commands at `chrome://extensions/shortcuts`.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Alt+Shift+S | Screenshot: select a region (then Enter = visible area, F = full page, Esc = cancel) |
| (unassigned) | Screenshot: visible area |
| (unassigned) | Screenshot: full page |
| (unassigned) | Pause or resume the recording |
| (unassigned) | Stop and save the recording |

**Editor:** V select, A arrow, R rectangle, E ellipse, P pen, T text, H highlight, B blur, X pixelate, C crop, 1 to 4 stroke size, Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo, Delete removes the selected annotation, arrow keys move it (Shift for larger steps), Enter applies a crop or edits the selected text, Ctrl+Enter finishes text, Esc cancels, Ctrl+S download, Ctrl+C copy, Ctrl+plus / Ctrl+minus / Ctrl+0 zoom.

**Recorder page:** Space pauses or resumes. **Library trim:** I sets the start, O sets the end.

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab` | Capture or record the current tab only after you click the toolbar button or press a shortcut. There are no broad host permissions. |
| `scripting` | Inject the region selector, the full-page scroll helper, the recording countdown and the webcam bubble into that tab, only on your action. |
| `tabCapture` | Record the current tab's video and audio. |
| `offscreen` | Run the tab recorder in an offscreen document so recording continues after the popup closes. |
| `storage` | Remember recording options and editor preferences (color, stroke size, file format). |
| `unlimitedStorage` | Recordings can be large. They are kept in the extension's IndexedDB on your device. |

Camera and microphone access are requested by the browser's normal permission prompt, only when you turn them on. Window and screen sharing always uses the browser's own picker.

## Privacy
- No network requests, no accounts, no analytics. Screenshots and recordings never leave your device unless you download them.
- Deleting an item in the library removes it from storage immediately.

## Browser support and limitations
- Chrome, Edge and Brave 120 or later (Manifest V3).
- Browser pages (`chrome://`, the extension stores, other extensions) cannot be captured or recorded as a tab. Window and screen recording still work there.
- Full-page capture stitches what the page shows as it scrolls. Pages that change their layout while scrolling (infinite feeds, scroll-driven animations) may not stitch perfectly. Content that loads lazily after the first measurement can be cut off at the bottom.
- Tab recording uses the tab's own size. Recordings are WebM (VP9 or VP8 with Opus). MP4 export is not available because MediaRecorder in Chromium does not reliably produce it and no encoder library is bundled.
- Trimming plays the selected range in real time to re-encode it, so it takes as long as the clip.
- In window and screen recordings with the webcam, the composited video is capped at 1080p to keep recording smooth.

## Development
- `node tools/make-icons.js capture-studio` regenerates the PNG icons from `icons/icon.svg`.
- `node tools/smoke-test.js capture-studio editor/editor.html library/library.html recorder/recorder.html permissions/permissions.html` checks that every page loads without errors.
- `node capture-studio/test/run-tests.js [--dpr=2]` runs the end-to-end checks (Playwright with fake media devices). They cover visible, region and full-page capture (pixel checks on a fixture page), every editor tool, undo/redo, crop, PNG/JPEG export and copy, the library (duration fix, rename, download, trim, delete), and window/screen recording with mic and webcam. Tab capture needs a real toolbar click, so it is not covered by the automated test.
