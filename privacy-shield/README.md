# Privacy Shield

Blocks cross-site trackers, strips tracking parameters from links, answers cookie banners for you and sends Global Privacy Control. Modeled on Privacy Badger, Ghostery and Consent-O-Matic, with its own hand-written tracker list and consent rules. Nothing is downloaded and nothing leaves your device.

## Features

- **Tracker blocking by category.** About 510 tracker domains in five categories, each a separate declarativeNetRequest static ruleset you can switch on or off: advertising, analytics, social, fingerprinting and session replay. Rules only apply to third-party requests and never to the page you navigate to. Companies that own both the site and the tracker (Meta on facebook.com, Google on youtube.com and so on) are handled through an entity map, so their own sites keep working.
- **Per-site allowlist.** Turn protection off for a site from the popup. This adds a dynamic `allowAllRequests` rule for the site, and banner handling is also skipped there.
- **Heuristic learning.** A third-party domain that sets or sends cookies, or uses storage inside a cross-site iframe, on 3 or more unrelated sites gets flagged. The threshold can be set from 2 to 10. You can block flagged domains one at a time, or turn on automatic blocking. CDNs, payment providers, sign-in providers, video players and consent managers are never learned.
- **Tracking parameter stripping.** `utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_eid`, `_hsenc`, `igshid` and over 100 others are removed from page and frame URLs by a DNR redirect with `queryTransform`, before the request leaves the browser. Functional parameters such as `id`, `ref` and `q` are kept.
- **Cookie banners.** Rules for OneTrust, Cookiebot, Quantcast Choice and other TCF banners, Didomi, TrustArc (including its iframe), Usercentrics (shadow DOM), Sourcepoint (iframe), Osano, CookieYes, Klaro, Google Funding Choices and the open-source Cookie Consent, plus a careful generic detector for hand-made banners. There are four modes: **Reject** (necessary only; the default), **Accept**, **Hide** and **Off**. When a banner cannot be answered it is hidden and page scrolling is restored.
- **Global Privacy Control.** The `Sec-GPC: 1` request header (DNR ruleset) and `navigator.globalPrivacyControl === true`, set by a script registered in the page's MAIN world at `document_start`.
- **Popup report and grade.** Each page gets a grade from A to F based on the trackers it tries to load, with fingerprinting and session replay weighted more heavily. The popup also lists tracker domains by category with their owner and blocked or allowed counts, stripped parameters, and what happened to the cookie banner. From the popup you can trust a tracker, or block or unblock a learned one.
- **Dashboard.** Totals for 7, 30, 90 or 365 days, a daily blocked-requests chart by category, a category breakdown, top trackers, every site you visited with its grade (with a per-site protection toggle), and the learned-tracker list with Block, Unblock, Ignore and Forget actions.
- **Settings.** Category toggles, parameter stripping, GPC, cookie mode, learning options, badge count, your lists (sites with protection off, never block, always block) and data reset.

## Install (Load unpacked)

1. Open `chrome://extensions` (or `edge://extensions` or `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `privacy-shield` folder.

This works in Chrome, Edge and Brave 120 or later, and it needs no build step.

## Permissions and why

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Blocks trackers, strips parameters and sets the `Sec-GPC` header with the browser's built-in rule engine. Page content is never read for this. |
| `webRequest` | Observes requests only and never blocks or changes them. It counts what was blocked for the popup report, badge and dashboard, and it sees which third parties use cookies for learning. |
| `scripting` | Registers the small MAIN-world script that sets `navigator.globalPrivacyControl`, and unregisters it when GPC is turned off. |
| `storage` | Keeps settings, your lists, statistics and learned trackers in `chrome.storage.local`. Per-tab reports go in `chrome.storage.session`. |
| Host access to all `http`/`https` (and `ws`/`wss`) sites | Parameter-stripping redirects and request observation need it, and so does the cookie-banner content script, which must run on every site you visit. |

No data is sent anywhere. The extension makes no network requests of its own.

## Keyboard shortcuts

Two commands ship without default keys, to avoid conflicts with the rest of the suite. You can assign them at `chrome://extensions/shortcuts`; the settings page has a **Set shortcuts** button that opens it.

- **Toggle protection on this site.** Adds the current site to the allowlist or removes it, then reloads the tab.
- **Open the Privacy Shield dashboard.**

## How it works

- `lib/trackers.js` holds the tracker list (domain to category, plus owner names). `lib/entities.js` maps companies to their sites and tracker domains. `lib/params.js` lists the tracking parameters.
- `rules/*.json` are generated from those modules by `node privacy-shield/tools/build-rules.js`. Commit the output; `--check` verifies it is current.
- `background.js` keeps rulesets and dynamic rules in sync with settings and builds the per-tab reports, statistics and learning data from non-blocking `webRequest` events. A blocked request shows up as `net::ERR_BLOCKED_BY_CLIENT`.
- `content/consent-rules.js` and `content/consent.js` run in every frame and handle cookie banners. In cross-site iframes they also report storage use for learning.
- `content/gpc.js` is the MAIN-world GPC script.

## Tests

```sh
node --test privacy-shield/test/unit.test.mjs   # tracker list, rules, params, grades, learning
node privacy-shield/test/e2e.js                  # real Chromium with the extension loaded
node tools/smoke-test.js privacy-shield dashboard/dashboard.html
```

The end-to-end test serves `test/fixtures/` from a local server and maps every hostname to it with `--host-resolver-rules`. That way site-a.com, site-b.org and site-c.net can load "third-party" scripts from www.google-analytics.com, static.hotjar.com, ad.doubleclick.net and others. The test checks:

- blocking, category toggles and the allowlist
- entity exceptions on facebook.com
- parameter stripping
- the GPC header and JavaScript property
- the OneTrust, Cookiebot and generic banner mocks in reject and accept modes
- learning and auto-block across three sites
- the popup report and dashboard data

## Known limitations

- The registrable-domain logic uses a compact built-in public-suffix list instead of the full Public Suffix List. Chrome's own rule matching uses the full list.
- Static rulesets cannot block a tracker's cookies while letting the request through, the way Privacy Badger's "cookieblock" does. Learned trackers are blocked outright or left alone.
- Banner rules follow each CMP's current markup. A CMP redesign can break the click path, in which case the banner is hidden instead of answered.
- Per-tab counts come from `webRequest` events. Requests served from a service worker cache, or blocked by another extension, may be counted differently.
- After a settings change, rules apply to new page loads. Reload open tabs to see the change.
