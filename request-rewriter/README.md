# Request Rewriter

Rewrite the browser's network requests while you test: point production at staging, add debug headers, fix CORS, mock an endpoint, strip tracking parameters or pretend to be a phone. It works like Requestly or ModHeader, runs entirely on Chrome's `declarativeNetRequest` engine and keeps all data local.

## Features

- **Rule types** (all compiled to declarativeNetRequest rules)
  - Modify **request headers** and **response headers** (set, append, remove)
  - **Redirect** URLs: exact, contains, wildcard (`*`) and regex matches, with `$1`, `$2` … capture groups in the destination
  - **Replace text in URL** (for example `/v1/` → `/v2/`)
  - **Replace host** (production → staging or `localhost:3000`, optional port and scheme)
  - **Query parameters**: add, replace (optionally only when present) and remove
  - **Block** requests
  - **Mock responses**: your body and content type, served as a base64 `data:` URL
  - **User-agent override**, optionally removing the `Sec-CH-UA*` client hints
  - **Allow (exception)** rules that override lower-priority rules
- **Conditions**: URL match type (all, contains, equals, wildcard, regex, domain, raw urlFilter), resource types, HTTP methods, initiator domains, excluded initiator domains, excluded request domains, priority.
- **Tab-scoped rules**: limit a group to one tab. Those rules are installed as session rules for that tab only. When the tab closes the group is turned off.
- **Groups** you can switch on and off together, plus a **global pause**.
- **Badge**: shows the number of active rules, and on each tab the number of requests your rules matched there (green). It shows "off" while paused.
- **Full-page editor** with live validation, including Chrome's own `isRegexSupported` check, a "Try it" box for each rule and a preview of the compiled rule.
- **Test a URL**: evaluates every rule against a URL, resource type, method and initiator the way Chrome does (priority, then allow > block > redirect, header changes stacked) and explains why each rule did or did not match. It also warns about redirect loops.
- **Installed rules** view: what is actually registered in Chrome, and any rule Chrome rejected.
- **Import / export** as JSON, and best-effort **ModHeader import** (request and response headers, cookies, CSP, URL filters, resource filters, initiator filters and URL replacements; tab, time and exclude filters are reported as skipped).
- **Popup**: pause switch, group toggles, the rules that matched on the current tab, and a quick "add a header" form (this site, all URLs or this tab only).
- Light and dark themes, keyboard accessible.

## Mock response limits

Mocks redirect the request to a `data:` URL that contains the body, so:

- the body is limited to 1 MB (Chrome caps URLs at 2 MB, and base64 adds a third); you get a warning from 100 KB.
- the status is always 200 and you cannot set response headers on the mock.
- top-level page loads (main frame) cannot be mocked, because Chrome blocks navigation to `data:` URLs. Mocks work for fetch/XHR, scripts, styles, images, iframes and so on.

## How to load

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `request-rewriter` folder.
4. The editor opens with a disabled **Examples** group. Pin the toolbar icon for the popup.

## Permissions and why

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Installs your rules in Chrome's request engine. |
| `declarativeNetRequestFeedback` | Tells the extension which rules matched, for the badge and the popup's match list. |
| `storage` | Saves your groups, rules and settings locally (`chrome.storage.local`); the per-tab match list lives in `chrome.storage.session`. |
| `activeTab` | Lets the popup ask Chrome which rules matched on the current tab when live match events are unavailable (packed installs). |
| Host access to `http://*/*` and `https://*/*` | Chrome only applies redirect and header rules to sites the extension can access. It also lets the popup read the current tab's address for "This site" rules. No page content is read and nothing is sent anywhere. |

## Keyboard shortcuts

| Where | Keys | Action |
|---|---|---|
| Editor | <kbd>/</kbd> | Search rules |
| Rule dialog | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>S</kbd> | Save the rule |
| Dialogs | <kbd>Esc</kbd> | Close without saving |
| Browser | (unassigned) | "Pause or resume all rules" and "Open the rule editor". Assign keys at `chrome://extensions/shortcuts`. |

## Known limitations

- Chrome only reports live match events (`onRuleMatchedDebug`) to unpacked extensions. In a packed install the popup asks `getMatchedRules` instead, which counts rules rather than individual requests and is rate limited.
- The user-agent override changes the HTTP header only; `navigator.userAgent` in page scripts keeps the real value.
- Regular expressions use RE2 syntax (no lookaround or backreferences), and Chrome limits extensions to 1,000 regex rules.
- Some headers cannot be changed by extensions, and `append` works on a short list of request headers only. The editor tells you when that is the case.

## Files

```
manifest.json
background.js         service worker: compiles rules, installs them, badge, match tracking
lib/rules.js          rule model, validation, compiler, local matcher, import/export (pure)
lib/store.js          storage and state mutations
shared/               base styles and DOM helpers
popup/                toolbar popup
editor/               full-page rule editor (also the options page)
icons/                icon.svg and generated PNGs (node tools/make-icons.js request-rewriter)
test/rules.test.mjs   unit tests: node --test request-rewriter/test/rules.test.mjs
test/e2e.js           browser tests with a local server: node request-rewriter/test/e2e.js
```
