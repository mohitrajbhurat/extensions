# Price Tracker

Track prices on any online store, keep a full price history, and find out whether a "sale" is
actually a sale. Like Keepa or CamelCamelCamel, but not tied to one retailer — and all data
stays on your machine.

## Features

**Detect products anywhere**
- schema.org **JSON-LD** (`Product`, `ProductGroup`, `AggregateOffer`, `hasVariant`, strikethrough
  price specifications) and **microdata** (`itemprop="price"`, `offers`, `availability`).
- **OpenGraph / meta** tags (`product:price:amount`, `og:price:*`, `product:availability`).
- Tuned selectors for **Amazon** (incl. split `a-price-whole`/`a-price-fraction` markup),
  **Best Buy**, **Walmart**, **Target**, **eBay**, **Etsy** and **Shopify** stores (including the
  embedded product JSON, so the right variant is read from `?variant=`).
- A scored **generic heuristic** for everything else, which ignores crossed-out "was" prices,
  cart totals, related-product carousels and per-unit prices.
- A **"pick the price element"** overlay when all of that fails: hover, click (or arrow keys plus
  Enter), and the extension builds a stable CSS selector and remembers it for future checks.
- Robust price parsing across locales and currencies: `$1,299.00`, `1.299,00 €`, `₹1,29,999`,
  `CHF 1'299.50`, `1 299,00 €`, `299,- kr`, `12,800円`, `KWD 1.250`, and 3-decimal currencies.
  Ambiguous `$` and `kr` are resolved with the page's currency metadata or its country domain.

**Popup on a product page**
- Title, image, price and availability, with the source of the price shown plainly.
- **Track** with a target: a percentage drop, an absolute price, any drop, or lows-only.
- Once tracked: a mini price-history sparkline, lowest/average/highest, a deal verdict, and a
  warning when the store's claimed discount does not match the recorded history.

**Background re-checks**
- `chrome.alarms` fires on a configurable schedule (default every 6 hours), fetches each tracked
  page and parses it in an **offscreen document** (`DOM_PARSER`), recording price and availability.
- Requests are spaced out per store, so checks look nothing like a scraper.
- **Bot-blocked pages degrade gracefully**: captcha interstitials, Cloudflare/PerimeterX/Akamai
  challenges and 403/429/503 responses mark the item **Needs visit** instead of recording junk.
  Those items update automatically the next time you open the page in your browser — a tiny
  content script, registered only for the stores you allowed, records the price you actually see.
- A currency change (region or locale switch) is also treated as "needs visit" rather than
  corrupting the history.

**Alerts** — desktop notifications for a target price being reached (once per crossing, not on
every check), a new all-time low, and back-in-stock. The toolbar badge counts items at target.

**Dashboard** (`Check all`, search, filter, sort, bulk select)
- Current, lowest, highest, **time-weighted average** (so a burst of checks can't skew it),
  percent vs average, and a "is this a good deal" verdict.
- Detail view with a **canvas price chart drawn by hand** — step line, out-of-stock bands, target
  line, direct low label, hover crosshair and tooltip, full keyboard access (arrows / Home / End),
  and an equivalent data table for screen readers.
- Edit the alert, add notes, pause checks, check now, delete.
- **Export** a summary CSV, the full price-history CSV, or a JSON backup — and import a backup
  back in (histories merge, nothing is duplicated).

**Everything is local.** No account, no server, no analytics. Data lives in `chrome.storage.local`
(items and history) and `chrome.storage.sync` (settings only).

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this `price-tracker/` folder.

## Permissions and why

| Permission | Why |
|---|---|
| `storage` | Tracked items, price history and settings, all local. |
| `alarms` | The periodic background re-check. |
| `notifications` | Target / all-time-low / back-in-stock alerts. |
| `offscreen` | A service worker has no `DOMParser`; fetched pages are parsed in an offscreen document. |
| `activeTab` + `scripting` | Read the product on the page you're looking at, only when you open the popup, and inject the price picker on request. |
| `optional_host_permissions` (`https://*/*`, `http://*/*`) | **Not granted up front.** Asked for one store at a time, when you tick "Check in the background" while tracking an item. Without it the extension still works — prices just update when you open the page. Revoke per store in Settings. |

No `<all_urls>` content scripts: the record-on-visit script is registered dynamically, only for the
origins you granted and only while "record visits" is on.

## Keyboard shortcuts

Neither command has a suggested key (the reserved keys belong to other extensions in this suite);
bind them at `chrome://extensions/shortcuts`.

| Command | Action |
|---|---|
| `_execute_action` | Open the Price Tracker popup for the current page |
| `open-dashboard` | Open the dashboard |

In the dashboard: `/` focuses search, `↑`/`↓` move between items, `Enter` opens details,
`Delete` removes an item, `Esc` closes the detail pane. On the chart: `←`/`→`, `Home`, `End` read
individual prices; `Esc` clears the readout. In the price picker: `↑`/`↓` widen or narrow the
selection, `Enter` picks, `Esc` cancels.

## Tests

```
node --test price-tracker/test/*.test.js   # price parsing + statistics/verdicts/alerts (53 tests)
node price-tracker/test/e2e.js             # Playwright: detection, picker, background checks, UI
node tools/smoke-test.js price-tracker dashboard/dashboard.html
```

`test/fixtures/` holds the local product pages used by the end-to-end run; the extension test
loads a temporary copy of the extension with access to `127.0.0.1` pre-granted and exercises the
real service worker, offscreen parser, content script, popup and dashboard.

## Known limitations

- Stores that render prices only after a login, or behind aggressive bot protection, can't be
  re-checked in the background; they fall back to "needs visit" and update when you open the page.
- Prices are recorded for the page you tracked. A page where a variant changes the price without
  changing the URL records whichever variant the store shows by default on a background check.
- Price history starts when you start tracking; there is no back-fill from any third-party service.
- The "good deal" verdict needs at least a couple of days of history before it says anything.
