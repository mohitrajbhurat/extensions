# Home Base

A calm new tab dashboard with a full task manager built in. Modeled on the Momentum + Todoist style of working: one clear focus a day, a clean place to land, and tasks that understand plain English.

Everything runs offline and stays in your browser. No account, no tracking, no remote code.

## Features

### New tab
- **Clock and greeting** with your name (click the name to change it). 12 or 24-hour time, optional seconds.
- **Daily focus**: “What is your main focus for today?” Tick it off for a small celebration (confetti is skipped when reduced motion is on). It resets each day.
- **Backgrounds**: calm generated scenes (dunes, peaks, sea, aurora, haze across 12 palettes) that change daily, plus your own photos stored locally in IndexedDB. Shuffle any time; adjust dimming.
- **Line of the day** from 224 original motivational lines and focus prompts (`data/quotes.json`), with a button for another.
- **Quick links** with favicons: add, edit, remove, drag to reorder.
- **Search box** using your browser's default search engine (or Google, DuckDuckGo, Bing, Brave, Ecosia). Typing a web address opens it directly.
- **Draggable, resizable widgets** (positions are saved; on narrow windows they stack below the dashboard):
  - **Tasks**: quick add plus Today / Upcoming / Inbox.
  - **Notes**: Markdown scratchpad with preview; checklist boxes are clickable.
  - **Calendar**: month view with events, yearly events (birthdays), countdowns, and dots for days with tasks due.
  - **World clocks**: any IANA time zone, with day and offset.
  - **Habits**: 12-week streak grid per habit, current and best streak.
  - **Pomodoro**: focus / short / long break; keeps running when the tab closes and notifies you when a phase ends.

### Tasks (full page, new tab widget and toolbar popup)
- **Natural-language quick add**: `Call Sam tomorrow 5pm p2 #work @phone`
  - Dates: `today`, `tomorrow`, `next fri`, `monday`, `oct 12`, `12/1`, `2026-12-01`, `in 3 days`, `next week`, `end of month`
  - Times: `5pm`, `9:30am`, `at 17:00`, `noon`, `tonight`, `in 90 minutes`
  - Repeats: `every day`, `every monday`, `every weekday`, `every mon and thu`, `every 2 weeks`, `every 15th`, `every last day of month`, `every jan 5`, `monthly`, `quarterly`
  - Priority `p1`–`p4` or `!!!`, project `#name` (created if new), labels `@name`
- Projects (with colors), labels, priorities, notes in Markdown, subtasks, recurring tasks (completing one rolls it to the next date).
- Views: Inbox, Today (with Overdue), Upcoming (next 7 days plus later), Overdue, Completed, per project, per label, search.
- Drag to reorder, drag onto a day in Upcoming to reschedule, drag onto a project or Today in the sidebar. Undo for complete, delete and add.
- **Toolbar badge** shows tasks due today plus overdue (red when something is overdue).
- **Reminders** for tasks with a time, using alarms and notifications, with Complete and Snooze 10 min buttons. Optional lead time.

### Settings
Name, 12/24-hour, seconds, week start, theme (system / light / dark), which dashboard parts and widgets show, search engine, background source/style/dim and photos, badge, reminders, pomodoro lengths, **backup export/import (JSON)** and reset.

## Install (Load unpacked)
1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `home-base` folder.
4. Open a new tab. Chrome asks whether to keep the changed new tab page; choose **Keep it**.

## Keyboard shortcuts

New tab: `/` search, `f` focus field, `n` add a task (tasks widget), `b` new background. Widgets: focus the drag handle, then arrow keys move it, `Shift`+arrows move further, `Alt`+arrows resize.

Task manager (press `?` there for the list):

| Key | Action |
|---|---|
| `q` or `n` | Add a task |
| `/` | Search |
| `j` / `k` or arrows | Move selection |
| `x` or `Space` | Complete / reopen |
| `Enter` or `e` | Edit |
| `Delete` | Delete (with undo) |
| `1`–`4` | Priority |
| `t` / `m` / `0` | Due today / tomorrow / no date |
| `Alt`+`↑` `↓` | Reorder |
| `g` then `i` `t` `u` `o` `c` | Inbox, Today, Upcoming, Overdue, Completed |
| `Ctrl`+`Enter` | Save in the editor |

Global commands “Open the Home Base task manager” and “Add a task in Home Base” have no default key (to avoid clashes); assign them at `chrome://extensions/shortcuts`.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves tasks, notes, settings and layout locally. |
| `alarms` | Fires task reminders, pomodoro phase changes and the daily badge refresh. |
| `notifications` | Shows reminders and pomodoro notices. |
| `search` | Sends new tab searches to your browser's default search engine. |
| `favicon` | Shows site icons for quick links from the browser's own cache (no network request). |

No host permissions, no content scripts. The new tab override (`chrome_url_overrides.newtab`) is the only page override. Background photos are kept in IndexedDB on this device and are not part of the JSON backup.

## Files
- `newtab/` dashboard and widgets, `tasks/` full task manager, `popup/` toolbar popup, `options/` settings
- `lib/` shared logic: `nlp.js` (date parser), `tasks.js` (task model and views), `taskops.js` (storage-backed operations with undo), `taskui.js` (list + editor), `store.js`, `backgrounds.js`, `images.js`, `pomodoro.js`, `habits.js`, `markdown.js`
- `background.js` service worker: badge, reminders, pomodoro, commands

## Tests
```
node --test home-base/test/*.test.mjs   # date parser, task logic, habits, pomodoro, markdown, backup
node home-base/test/e2e.cjs             # end-to-end run in headless Chromium (needs Playwright)
node tools/smoke-test.js home-base tasks/tasks.html
```

## Known limitations
- Reminders only fire while the browser is running; a reminder missed while it was closed is not replayed.
- Edge and Brave may block `chrome.search` for some setups; the search box then falls back to DuckDuckGo unless another engine is chosen.
- Notes and layout are per browser profile; use backup export/import to move them.
