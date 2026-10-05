# Tab Workspaces

Tame 100+ open tabs. Tab Workspaces combines workspaces (Workona, Skeema), a tab stash (OneTab), session backups (Session Buddy), a memory saver (The Great Suspender), a duplicate guard (Duplicate Tab Helper), auto-grouping rules and a searchable archive of closed tabs in one extension. Everything stays on your device.

## Features

### Workspaces
- Named, colored sets of tabs, one per project. Tab groups (title, color, collapsed state) are saved and restored.
- **Switch** a window to another workspace: the current workspace is saved, its tabs close, the target's tabs open. If the window had no workspace, its tabs go to the stash first so nothing is lost.
- Create a workspace from the **current window**, from the **selected (highlighted) tabs**, or **empty**.
- Open a workspace in a **new window**; switching to a workspace that is already open just focuses its window.
- Changes autosave: open, close or move tabs and the window's workspace updates.
- Pinned tabs can stay across all workspaces (default). Restored background tabs load lazily to save memory.
- Rename, recolor, duplicate, reorder (drag cards), replace with the current window, remove saved tabs, save and close.
- After a browser restart, windows are matched back to their workspaces by their tabs.

### Tab stash (OneTab style)
- One click sends **all tabs**, **other tabs**, **selected tabs** or a single tab to a dated stash list and closes them.
- Restore one tab, restore all (here or in a new window), or open while keeping them stashed (Shift-click).
- Rename stashes inline, star the ones to keep, merge stashes, drag tabs between stashes or into a new one.
- Turn a stash into a workspace. Remove duplicate URLs across stashes.
- **OneTab import** (paste "Export URLs" text) and **OneTab-format export**.

### Sessions (crash recovery)
- Automatic snapshots of all windows every N minutes (default 15), identical snapshots folded together, latest N kept (default 40); starred snapshots are kept forever.
- A live backup is kept continuously and turned into a **"Before browser closed"** session on the next start.
- Browse snapshots, search inside them, restore everything, one window, or a single tab.

### Memory saver
- Suspends tabs idle for N minutes (default 30) with the browser's own `chrome.tabs.discard`. The tab stays in the strip and reloads when clicked.
- Never suspends the active tab, tabs playing audio, pinned tabs (configurable), sites on your whitelist, or (after you allow it) tabs with unsaved form input.
- Manual: suspend this tab, suspend other tabs, suspend all background tabs.

### Duplicate guard
- When you open a page that is already open, either ask (notification with "Switch to open tab" / "Keep both"), close the new copy and jump to the existing one automatically, or do nothing.
- Same window or all windows; ignores `#fragments` and tracking parameters (`utm_*`, `fbclid`, `gclid`...) by default.
- **Close all duplicates** in one click; duplicates are flagged in the Open tabs view.

### Auto-grouping rules
- Domain, "URL contains", wildcard or regular-expression rules that put matching tabs into a named, colored tab group (created if missing). First matching rule wins; reorder, enable or disable rules.
- Apply rules to all open tabs, group a window by site in one click, test a URL against your rules, and add suggested rules from your most-open sites.

### Archive
- Every closed tab is recorded with its title and time (default limit 5,000 entries).
- Fuzzy search ("gh pr" finds "GitHub pull request"), filter by today / 7 days / 30 days, reopen or delete entries, clear old entries.

### Dashboard, popup and badge
- Full-page dashboard with Workspaces, Stash, Open tabs (stats, bulk select to stash / suspend / move / close / add to workspace), Sessions, Archive, Grouping rules and Settings.
- Popup for quick actions: switch workspace (keys 1-9), save the window as a workspace, stash, suspend, close duplicates, snapshot, and one search box over open tabs, workspaces, the stash and the archive.
- Toolbar badge with the open tab count (all windows or current window), turning red above a threshold you choose.
- **Export / import** everything as JSON (merge or replace).
- Right-click menus on the page and on the toolbar icon.

## Install (load unpacked)
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `tab-workspaces` folder.
4. Pin the icon, then click it and choose **Save this window** to create your first workspace.

## Permissions and why

| Permission | Why |
|---|---|
| `tabs` | Read tab URLs and titles to save workspaces, stashes, sessions and the archive; open, close and move tabs. |
| `tabGroups` | Save and recreate tab groups; auto-grouping rules. |
| `storage`, `unlimitedStorage` | Keep workspaces, stashes, sessions and the archive locally (they can exceed the default quota). |
| `alarms` | Periodic session snapshots and the memory saver's idle check. |
| `contextMenus` | Right-click actions (stash this tab, suspend, never suspend this site...). |
| `notifications` | The duplicate guard's "already open" prompt. |
| `favicon` | Show site icons from the browser's local favicon cache (no network requests). |
| Optional: `scripting` + `<all_urls>` | Only requested if you click **Allow form checks** in Settings. Lets the memory saver check a page for unsaved form input right before suspending it. Nothing is read or stored otherwise. |

No data leaves your device. There are no accounts, analytics or remote code.

## Keyboard shortcuts
No keys are pre-assigned (to avoid clashing with other extensions). Set any of these at `chrome://extensions/shortcuts`:
- Open the popup
- Open the dashboard
- Stash all tabs / stash other tabs
- Suspend other tabs
- Close duplicate tabs
- Next / previous workspace

Inside the popup: type to search, arrow keys and Enter to pick, `1`-`9` to switch workspaces, `/` to focus search.
Inside the dashboard: `/` focuses search; `g` then `w` workspaces, `s` stash, `t` open tabs, `e` sessions, `a` archive, `r` rules, `o` settings.

## Tests
`node tab-workspaces/test/e2e.test.js` (from the repo root) runs Playwright against headless Chromium with the extension loaded: workspace create / switch / autosave / group restore, stash and restore, drag-equivalent moves, duplicate detection (auto-close, tracking params, close all), archive, sessions, grouping rules, memory saver rules, import / export, and that every dashboard view and the popup render without errors.

## Notes and limitations
- Discarding needs Chromium's tab discarding; some pages (browser pages, the active tab) cannot be suspended.
- Unsaved-form protection works only after granting the optional permission, and cannot see forms inside cross-origin frames.
- Incognito windows are not snapshotted.
- The "ask" duplicate prompt uses system notifications; if the OS blocks them, the badge briefly shows "DUP" instead.
