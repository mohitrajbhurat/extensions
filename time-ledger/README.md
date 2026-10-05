# Time Ledger

Automatic time tracking, a manual timer, screen-time goals and billable timesheets in one private, offline browser extension. Built for freelancers and students who want to know where their hours went. It covers what Toggl Track, Clockify, RescueTime and Webtime Tracker do, and all data stays in your browser.

## Features

**Automatic tracking**
- Records time on the active tab per site and page, and only while a browser window is focused and you are active.
- Idle detection through `chrome.idle` with a threshold you set (15 s to 1 h). When you go idle, the idle stretch is taken back off. A locked screen always stops tracking.
- Optional: keep counting while the active tab plays audio or video (lectures, calls).
- Handles service-worker restarts: engine state is saved after every event, and a 30-second alarm heartbeat checkpoints progress. A crash loses at most one heartbeat. Sleep or a closed browser is detected from the heartbeat gap and never counted.
- Privacy: query strings are dropped by default, and you can list sites that are never tracked.

**Projects, clients and rules**
- Clients and projects with colors, hourly rates (project rate, then client rate, then default rate), billable flags and archiving.
- Ordered rules map automatic time to projects by domain (`acme.atlassian.net`, `*.acme.io`), URL glob (`github.com/acme/*`) or title keywords (`thesis, chapter`). Rules also apply to past time, and a built-in tester shows which rule matches a page.
- Assign uncategorized time later: from the Sites list, or from "Unassigned automatic time" on the entries page. One click can turn an assignment into a permanent rule.

**Timer and entries**
- Start/stop timer with description, project, tags and billable flag, from the popup, the dashboard or a keyboard shortcut.
- Add manual entries (with a duration field that accepts `1:30`, `1h 30m`, `90m` or `1.5`), edit, split at a time, merge selected entries, duplicate, continue, bulk set project and delete with undo. Overlapping entries are flagged.

**Screen time**
- Day, week and month views by site and category (productive, neutral or distracting; you can edit any site's category), an hourly or daily stacked chart, a category donut, a focus score and per-page drill-down.
- Daily goals ("at least") and limits ("at most") for all browsing, a category, a site or a project. Notifications fire at 80% of a limit, when it is exceeded and when a goal is reached, each once per day.

**Reports**
- Presets (today, this or last week, this or last month, last 30 days) or a custom range. Filter by source (timer, automatic or both), client, project and billable only.
- Stacked bars per day by project, donut by project, a timesheet grid (projects × days, or weeks for long ranges) with totals, billing per project with amounts, and a breakdown by tag.
- Export entries CSV and timesheet CSV, and open a printable invoice or time report (print or save as PDF) with your details, the client's details, rounding and notes.

**Popup**
- Running timer with live clock, quick start, one-click "continue" for recent entries, what is being tracked now, today's totals by category, goal progress and top sites.

## Load it
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and turn on Developer mode.
2. Click **Load unpacked** and pick the `time-ledger` folder.
3. Pin the extension. Open the dashboard from the popup, or right-click the icon and choose **Options**.

## Permissions
| Permission | Why |
|---|---|
| `tabs` | Read the active tab's URL and title to attribute time. Nothing is sent anywhere. |
| `idle` | Stop counting when you are away or the screen is locked. |
| `alarms` | 30-second heartbeat that checkpoints tracking and survives service-worker restarts. |
| `storage`, `unlimitedStorage` | Keep history, entries and settings locally. Long histories can exceed the default 10 MB quota. You can set a retention period. |
| `notifications` | Goal and limit alerts. |

No host permissions, no content scripts, no network requests.

## Keyboard shortcuts
No default keys are assigned, so nothing conflicts with the rest of the suite. Bind these at `chrome://extensions/shortcuts`:
- **Open the Time Ledger popup**
- **Start or stop the timer** (continues your last entry)
- **Pause or resume automatic tracking**

In pages, everything works with Tab, Enter and Space. Dialogs close with Esc.

## Data
- Activity is stored per day (`act:YYYY-MM-DD`) in `chrome.storage.local`. Manual entries, projects, rules and settings are stored there too.
- Settings → Data: export a JSON backup, import a backup (replace or merge) and delete history.

## Development
- Plain ES modules, no build step. The tracking engine (`lib/engine.js`), rules, reports and goals are pure functions.
- Tests: `node --test time-ledger/test/*.test.mjs` simulates browser event sequences (tab switches, focus loss, idle/locked, audio, heartbeats, worker restarts, sleep gaps, midnight splits) and covers rules, timesheets, billing, CSV, split/merge and goals.
- Smoke test: `node tools/smoke-test.js time-ledger report/invoice.html`.

## Known limitations
- Only browser time is tracked, not time in other desktop apps.
- Incognito windows are tracked only if you allow the extension in incognito.
- Window-focus events can be unreliable on some Linux window managers. The heartbeat re-checks focus every 30 seconds, which corrects it.
