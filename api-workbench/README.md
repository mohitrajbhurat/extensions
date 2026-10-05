# API Workbench

Test HTTP APIs in a browser tab instead of switching to a desktop app. It works like Postman or Talend API Tester, and it includes a JSON Formatter-style viewer for raw JSON pages.

## Features

**Requests**
- Method, URL and a **params table that stays in sync with the URL** in both directions. `{{variables}}` are kept as typed, and disabled params survive URL edits.
- **Headers** table with suggestions and a bulk editor (`key: value` per line, `//` disables a line). Browser-controlled headers such as `User-Agent`, `Cookie`, `Origin` and `Referer` are applied through a short-lived `declarativeNetRequest` rule scoped to that one request.
- **Body types:** JSON (live validation, Beautify, Minify; `{{vars}}` allowed), text, XML, `x-www-form-urlencoded`, multipart form data with **file fields**, and **binary** file bodies. Files are kept in IndexedDB, so they survive reloads.
- **Auth:** inherit from the folder or collection, Bearer token, Basic, API key (header or query), and **OAuth 2.0 client credentials**. OAuth supports a Basic-header or body client auth, scope and audience, "Get new token", and automatic refresh when the token is missing or expired.
- **Per-request settings:** name, timeout, follow redirects and description.
- Paste a `curl …` command into the URL field to import it in place.

**Responses**
- Status, time, size, response headers, and **cookies** stored for the URL. The response's own `Set-Cookie` header can't be read in a browser.
- **Viewers:** a JSON tree (collapse and expand, search with match navigation, copy any node's path such as `$.data[0].id`), a pretty view (JSON and XML), the raw text, a **sandboxed HTML preview** (scripts disabled), an **image** view, and a hex preview for other binary data.
- Copy or save the body to a file. **Send and download** saves the response straight to a file.
- A **Request** tab shows exactly what was sent after variables and auth were applied, plus any warnings.

**Organizing**
- **Collections and folders** with drag and drop, rename, duplicate and delete. Each collection and folder can set auth, and collections can set variables.
- **Multiple request tabs**, restored after a reload. Unsaved changes are marked with a dot.
- **Environments** with `{{variables}}` plus **globals**. Lookup order: environment, then collection, then globals. Variables can nest (`{{base}}` = `https://{{host}}`). Built-ins: `{{$guid}}`, `{{$timestamp}}`, `{{$timestampMs}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomBoolean}}`, `{{$randomEmail}}`. Values can be masked.
- **History** of sent requests, grouped by day, with a filter. Open any entry again or save it to a collection.

**Tests without code**
- **Assertions** (no `eval`) on the status code, response time, body size, body text, headers, or a JSON path. Operators: equals, not equals, contains, exists, less than, at most, greater than, at least, matches regex, is type, is empty, and their negations. Results show pass or fail with the actual value.
- **Variable extraction:** save a JSON path, header, status or body into an environment or global variable, for example `$.access_token` into `{{token}}`.

**Import and export**
- Import **Postman Collection v2.0 / v2.1** (folders, auth, variables, raw, urlencoded, form data, file and GraphQL bodies, and disabled rows), **Postman environments**, and **cURL** commands. The import summary lists requests that had scripts. Scripts don't run here, so recreate their checks as assertions.
- Export a collection as **Postman v2.1** JSON. Assertions are also written as `pm.test()` scripts, so the export still runs in Postman. Export environments, or back up everything to one JSON file.
- Copy any request as **cURL** or **JavaScript `fetch()`**, with variables resolved.

**JSON viewer for pages**
- Raw JSON documents (`application/json`, `+json`, or `text/plain` that holds JSON) open as a collapsible, highlighted tree. You can switch between **Tree / Pretty / Raw** views, search, expand or collapse all, copy, and use **Open in API Workbench**. The viewer handles XSSI prefixes such as `)]}'`.
- It runs automatically on sites the extension has access to. On any other page, right-click the toolbar icon and choose **Format JSON on this page**, which uses `activeTab`.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `api-workbench` folder.
4. Click the toolbar icon to open the workbench in a tab. The sample collection sends requests to httpbin.org.

## Permissions

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Collections, environments, history, open tabs and settings are stored locally. Large collections and histories can exceed the default quota. |
| `scripting` | Register the JSON page viewer on sites you granted, and inject it on demand. |
| `activeTab` | **Format JSON on this page** (from the action menu or the shortcut) works on the current tab without any site access. |
| `contextMenus` | Toolbar-icon menu items (format JSON, open the page URL as a request) and **Open link in API Workbench**. |
| `cookies` | Show the cookies stored for a response's URL. This only works for hosts you granted. |
| `declarativeNetRequestWithHostAccess` | Set headers that `fetch()` refuses to set (`User-Agent`, `Cookie`, `Origin` and others). It works only on granted hosts, through a rule that lasts for one request. |
| Optional host access (`<all_urls>`) | **Requested per host the first time you send to it**, from the Send click. With access, responses aren't blocked by CORS. If you decline, the request is still sent, and APIs with permissive CORS still work. **Settings → Site access** lets you allow all sites or remove access. |

The only network traffic is the requests you send (and OAuth token requests you configure). There is no telemetry, no account and no remote code.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> | Send (press again, or <kbd>Esc</kbd>, to cancel) |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>S</kbd> | Save the request (asks where on the first save) |
| <kbd>Alt</kbd> + <kbd>T</kbd> / <kbd>Alt</kbd> + <kbd>W</kbd> | New tab / close tab |
| <kbd>Alt</kbd> + <kbd>1</kbd>…<kbd>9</kbd> | Jump to request tab *n* |
| <kbd>Alt</kbd> + <kbd>L</kbd> | Focus the URL |
| <kbd>/</kbd> | Search the JSON response (also on formatted JSON pages) |
| <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> in search | Next / previous match |
| <kbd>←</kbd> <kbd>→</kbd> | Move between tabs in tab bars; collapse or expand a tree folder |
| <kbd>F2</kbd> / <kbd>Delete</kbd> on a tree item | Rename / delete |
| <kbd>Tab</kbd> in a body editor | Indents. Press <kbd>Esc</kbd> first to move focus out. |

Browser-level commands have no default keys, so nothing conflicts with the rest of the suite. Assign them at `chrome://extensions/shortcuts`: **Open API Workbench** and **Format the JSON document in the current tab**.

## Limitations

- Browsers don't expose `Set-Cookie`, redirect hops or the raw HTTP/2 framing to `fetch()`. With redirects off, a redirect shows up as an opaque response.
- `GET` and `HEAD` requests can't carry a body in the browser.
- `Host`, `Content-Length` and `Connection` are always set by the browser.
- Postman pre-request and test scripts are not executed. Digest, Hawk and AWS signature auth are not imported.
- Very large JSON numbers lose precision in the tree view, because `JSON.parse` uses doubles. The Raw view shows the exact text.
- Keep the workbench open in one tab: two open copies would overwrite each other's saved state. The toolbar button focuses the existing tab.

## Development

No build step. From the repository root:

```sh
node tools/make-icons.js api-workbench
node tools/smoke-test.js api-workbench app/workbench.html
node api-workbench/test/unit.mjs      # library tests (JSON path, assertions, cURL, Postman, variables)
node api-workbench/test/e2e.cjs       # drives the app and the JSON viewer against a local server
```
