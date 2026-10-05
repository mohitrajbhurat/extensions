# Mindful Gate

Focus and distraction control. Plain blockers get switched off, so Mindful Gate adds friction with intent instead: a short pause and a stated intention before a distracting site, a time-boxed pass, hard-block schedules with a strict mode, a Pomodoro timer that blocks distractions while you work, and an insights dashboard.

## Features

- **Mindful gate.** Visiting a site on your list redirects (declarativeNetRequest) to a gate page that asks "What's your intention?" and runs a breathing pause. The pause grows with each visit that day (default 5s, +5s per visit, max 60s) and stops counting while the tab is hidden. Then you choose a pass of 5, 10 or 15 minutes (configurable), or turn back.
- **Pass expiry.** One minute before a pass ends a small heads-up appears. When it ends, a full-page overlay pauses video/audio and asks you to leave or extend (extend unlocks after a 5 second wait and counts as another visit).
- **Hard-block schedules.** Per site group, block fully on chosen days and times (overnight windows work, e.g. 23:00 to 07:00). **Strict mode** locks the group while a schedule is active: sites can be added, but not removed, and the schedule, mode and strict flag cannot be changed. Non-strict schedules can be snoozed for 5 minutes after a 30 second wait and a written reason.
- **Focus timer.** Pomodoro with configurable focus, short break, long break and cycles; auto-start options; optional strict focus (no pause or stop). Groups with "Block during focus" are hard-blocked while a focus session runs. Toolbar badge countdown, desktop notifications (with a "Start break"/"Start focus" button), WebAudio chimes, daily focus log.
- **Motivational block page** with your own reasons list, the remaining time, and your current focus task.
- **Insights dashboard.** Weekly summary vs last week, time per distracting site per day (active tab, focused window, idle excluded), gate prompts vs turn-backs, focus minutes vs daily goal, site table, focus log and searchable intentions history. Canvas charts with hover and keyboard tooltips and table views. 7 or 30 day range.
- **Popup.** Start, pause, skip and stop focus with a task name; status of the current tab (pass time left, gated, blocked); add or remove the current site in one click; today's numbers.
- Settings export/import as JSON, history clearing. Light and dark mode.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on Developer mode.
2. Click **Load unpacked** and select this `mindful-gate` folder.
3. The settings page opens with a starter list. Edit the groups, then pin the toolbar button.

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Redirect listed sites to the gate or block page before they load. |
| Host access to `http://*/*`, `https://*/*` | Redirect rules need host access for the sites you choose (the list is yours, so it cannot be known in advance), and the pass-expiry overlay is injected into those tabs. Nothing runs on other sites. |
| `scripting` | Inject the expiry overlay and heads-up only into tabs of a site whose pass is ending. |
| `tabs` | Read the active tab's site for time tracking and the popup, and move already-open tabs to the block page when a block starts. |
| `idle` | Stop counting time when you step away. |
| `alarms` | Pass expiry, timer phases, schedule boundaries, badge updates. |
| `notifications` | Focus and break notifications. |
| `offscreen` | Play WebAudio chimes from the background. Feature-detected: without it, chimes are skipped. |
| `storage` | Settings, stats, intentions and focus log, all local. |

No network requests, no accounts, no remote code. All data stays in `chrome.storage.local`.

## Keyboard shortcuts

Commands without default keys; set them at `chrome://extensions/shortcuts`:
- **Start, pause or resume a focus session**
- **Open the insights dashboard**

On the gate page, press Enter in the intention box to take the first pass length once the pause is over.

## Testing

`node tools/smoke-test.js mindful-gate dashboard/dashboard.html gate/gate.html block/block.html` and `node mindful-gate/test/e2e.js` (Playwright, serves `test/site.html` on localhost and checks the gate redirect, pass, expiry overlay, focus timer blocking, badge, strict schedule and dashboard).

## Known limitations

- Anyone can still disable the extension at `chrome://extensions`; strict mode makes giving in deliberate, not impossible.
- Pages already open when a site is added are gated on their next navigation, not immediately.
- The overlay cannot be injected into pages the browser protects (for example the Chrome Web Store); those tabs are sent through the gate instead.
- Time tracking counts only listed sites and is minute-accurate, not second-accurate, when the service worker sleeps.
