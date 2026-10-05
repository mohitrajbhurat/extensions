# Smart Autofill

Fill job applications and other long forms from saved profiles instead of retyping the same details. Smart Autofill recognizes fields by their labels and attributes, shows you what it will fill and how confident it is, fills everything in one click (including React and Vue forms, shadow DOM and embedded frames), and learns from your corrections on each site. You can lock your profiles with a passphrase so they are encrypted at rest.

## Features

- **Multiple profiles** (Personal, Work, Job hunting, Custom), each with:
  - contact, address, links (LinkedIn, GitHub, portfolio, X)
  - work authorization (authorized, sponsorship, citizenship, visa status, relocation, work arrangement, age, clearance, background check)
  - optional demographics for voluntary EEO questions (left blank = never answered)
  - compensation, availability, notice period, years of experience, "how did you hear", skills, languages, summary, cover letter text
  - **work history** and **education** as repeatable entries
  - **custom answers** for free-text questions ("Why do you want to work at {company}?") with templates: `{company}`, `{role}`, `{name}`, `{first_name}`, `{current_company}`, `{current_title}`, `{years}`, `{date}`
  - **resume and cover letter files** (stored as data URLs, attached to upload fields with DataTransfer, respecting the `accept` attribute)
- **Field matcher**: weighted keyword dictionary with synonyms, scored across label text, `aria-label` / `aria-labelledby`, placeholder, `name` / `id` (camelCase and snake_case aware), `autocomplete` tokens, `data-automation-id` style attributes, nearby text and section headings (so "Start date" under "Education" is not mistaken for a job start date). Negative keywords prevent common mix-ups (for example "Company website" vs. portfolio).
- **Controls**: text, email, tel, url, number, textarea, `<select>` (fuzzy option matching with US states, countries, degrees, EEO answers and yes/no polarity), radio groups, checkboxes and checkbox groups, `date` / `month` inputs, text dates in the format the placeholder asks for (MM/YYYY, MM/DD/YYYY ...), separate month and year selects, contenteditable editors, ARIA comboboxes, file inputs.
- **Framework-safe**: values are set with the native prototype setter and followed by `input` / `change` / `blur` events, so React, Vue and Angular state updates.
- **Shadow DOM** (open, and closed via `chrome.dom.openOrClosedShadowRoot`) and **iframes** (content script injected into all frames).
- **Preview**: matched fields are outlined on the page with a badge showing the field, the value and the confidence (green, amber, red). Click the check mark to skip a field, or use the badge menu to remap it to any profile field or mark it "never fill here". A floating panel fills the page when you are ready.
- **Undo** restores every value the last fill changed (all frames).
- **Learn mode**: if you change a filled field to a different value from your profile, or clear it, the mapping is remembered for that site. Rules are listed, and can be deleted, under Site rules.
- **Repeatable sections**: after filling the first work and education entries, Smart Autofill looks for "Add another position" style buttons near the section and fills additional entries (best effort).
- **Passphrase lock**: profiles (including files) are encrypted with AES-GCM 256 using a PBKDF2-SHA-256 key (310,000 iterations). The key lives only in `chrome.storage.session` while unlocked, with configurable auto-lock.
- **Import and export** as passphrase-encrypted JSON, with merge or replace.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `smart-autofill` folder.
4. The options page opens: fill in your profile. Then open a form, click the toolbar button and press **Preview & fill**.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read and fill the page you are on, only after you click the toolbar button or use a shortcut. |
| `scripting` | Inject the matcher and filler into the page (all frames) on demand. Nothing runs on pages you have not asked it to fill. |
| `storage` | Keep profiles, settings and learned site rules locally; hold the unlock key in session storage while unlocked. |
| `<all_urls>` (optional) | Only if you turn on "Allow filling inside embedded forms" in Settings. Needed for application forms embedded in an iframe from another domain. |

No network requests, no accounts, no analytics. All data stays in this browser.

## Keyboard shortcuts

Commands are declared without default keys to avoid conflicts. Assign them at `chrome://extensions/shortcuts`:

- **Preview and fill this page** (or fill directly if "Preview before filling" is off)
- **Fill this page immediately**
- **Undo the last fill**

In the in-page panel, `Esc` closes the preview. All controls are keyboard reachable.

## Notes and limitations

- Some upload widgets reject programmatically attached files; attach those by hand.
- Custom dropdown widgets that are not ARIA comboboxes and do not use a native `<select>` may not be filled.
- Repeatable-section expansion depends on finding a recognizable "Add" button and may not work on every site.
- Learned rules are stored unencrypted (they contain field identifiers and profile field names, not your values).

## Development

- No build step. Plain MV3, ES modules in extension pages and the service worker; content scripts are classic scripts in `content/`.
- `node tools/smoke-test.js smart-autofill` from the repo root checks the service worker and pages.
- `node smart-autofill/test/run-test.js` runs an end-to-end Playwright test against `test/job-form.html` (matching, filling, repeatable sections, React-style inputs, shadow DOM, iframe, undo, learn mode, encryption and backups).
