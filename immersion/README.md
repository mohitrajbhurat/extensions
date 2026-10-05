# Language Immersion

Learn a language without setting aside study time. As you browse, Language Immersion swaps a small number of words and short phrases on English pages into the language you are learning (Spanish, French, German and more). Hover a swapped word to see the original, hear it pronounced and track it. Words you meet go into a spaced-repetition deck with quizzes.

Modeled on tools like Toucan and Language Reactor. It works offline and keeps all data in your browser.

## Features

- **In-page word swaps.** A configurable number of words per page (5 to 80) is replaced. The count is a cap: short pages get proportionally fewer, and never more than about 8% of the words on a page. Choices are spread through the page and weighted toward words you are learning. Content that loads later (infinite scroll, single-page apps) is handled too.
- **Subtle styling.** Swapped words keep the page's font with a light tint and a dotted underline. The colour shows the word's state (new, learning, known). Three highlight styles are available.
- **Hover card.** Shows the translation with its article and gender for nouns, the original word, the sentence it came from, and pronunciation via `speechSynthesis`. Buttons:
  - **I know this** marks the word known, and it shows up rarely after that.
  - **Save to review** adds the word to the review deck.
  - **Show original** swaps the word back in place.
- **Difficulty levels.**
  - Beginner: common nouns only.
  - Intermediate: adds verbs, adjectives and adverbs. Noun/verb ambiguity is resolved from the neighbouring word, and words with several unrelated meanings are skipped.
  - Advanced: adds phrases such as "of course" and "every day", plus numbers.
- **Translation engines.**
  - **Chrome's built-in Translator API** (on-device), detected at runtime. When it is available it is used for any supported language pair, together with `LanguageDetector` to confirm the page language. Translations are cached locally.
  - **Bundled dictionaries** (`data/`): the 1,500 most common English words and 83 phrases, each with Spanish, French and German translations and noun genders. Spanish and French plurals are inflected. These are used in Edge, Brave and any Chrome without built-in AI.
- **Smart skipping.** Inputs, textareas, contenteditable areas, code and `pre` blocks, editors (CodeMirror, Monaco, Ace), buttons, `translate="no"` / `.notranslate` regions, likely proper nouns and acronyms are never changed. Pages that are not in your reading language are left alone.
- **Per-site control.** Pause on a site from the popup or with a keyboard shortcut. You can also switch to an "only on these sites" allowlist in settings.
- **Selection translation.** Select text and click the Translate button for an inline translation using the on-device Translator. The selection's language is detected, and text already in the target language is translated back. You can listen, copy, or save it to review. Without the Translator API, single words and phrases found in the dictionary are still looked up, in both directions.
- **Vocabulary tracker.** Records seen counts (each word counts once per page, when it is actually scrolled into view), plus new, learning and known states, saved words, and context sentences with their source links. A word joins the review deck automatically after N sightings (configurable) or as soon as you save it.
- **Review page.**
  - **Leitner boxes**: five boxes, reviewed after 0, 1, 3, 7 and 16 days. A miss sends the word back to box 1.
  - **Flashcards**: Space reveals the answer, 1 means "Again", 2 means "I knew it", S plays the audio.
  - **Quizzes**: multiple choice in both directions, type the translation, and listen and type. Typed answers ignore accents and articles. Quiz answers update the schedule.
  - **Word list**: search, filters and sorting; mark words known or forget them.
  - **Progress**: 30-day activity chart, streak, daily review goal and a per-language breakdown.
- **Popup.**
  - Target language, global on/off and a per-site switch.
  - Difficulty and density slider.
  - Status of the current page and the engine it uses, with a one-click on-device model download when available.
  - Stats: words learned, words being learned, day streak and words seen today.
- **Badge.** The toolbar icon shows how many words are due for review.
- **Export and import** of your vocabulary and settings as JSON, plus a progress reset.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `immersion/` folder.
4. The settings page opens with a short welcome. Pick your target language, then browse any English article.

For AI translation in Chrome (needed for languages other than Spanish, French and German, and for free-form selection translation), use a Chrome version that includes the built-in Translator API. The popup and settings page show its status and offer the one-time model download.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves settings (`chrome.storage.sync`) and your vocabulary, review schedule, activity log and translation cache (`chrome.storage.local`). Nothing leaves the browser. |
| Content script on `http://*/*` and `https://*/*` | Word swapping runs automatically on the pages you read, so the script has to be present on page load. It does not need `activeTab`, `tabs`, `scripting` or host permissions for network access. It makes no network requests. You can pause it per site or switch to an allowlist. |

No remote code, no accounts and no network calls. Dictionaries ship with the extension, and the Translator API runs on-device.

## Keyboard shortcuts

Set these at `chrome://extensions/shortcuts`. To avoid conflicts with the rest of the suite, no keys are assigned by default.

| Command | Action |
|---|---|
| Pause or resume immersion on the current site | `toggle-site` |
| Open the vocabulary review page | `open-review` |

On the review page:

| Where | Keys |
|---|---|
| Flashcards | Space to reveal or mark "I knew it", 1 for Again, 2 for I knew it, S to listen |
| Quizzes | 1 to 4 to pick an answer, Enter for the next question |
| Tabs and option groups | Arrow keys |

In pages, Esc closes the hover card or the translate button.

## Files

```
manifest.json
background.js         service worker: vocabulary store (serialized writes), dictionaries, badge, commands
lib/common.js         shared settings, language list, inflection helpers, stats, speech
lib/ui.css            shared styles for extension pages
content/engine.js     candidate finding, context rules and selection of words to replace
content/ui.js         hover card, selection pill and toasts in a shadow root
content/content.js    orchestration: engine choice, replacement, sightings, mutation handling
content/content.css   styling of swapped words
popup/                toolbar popup
options/              settings page
review/               review, quizzes, word list and progress
data/                 en.json (part of speech) plus es/fr/de.json dictionaries
test/                 Playwright test (node immersion/test/replacement.test.js) and test article
```

## Known limitations

- Without the Translator API, translation is word-for-word from a 1,500-word dictionary, with no context. Ambiguous words are skipped instead of risking a wrong sense, and German plurals are not generated (only singular nouns are swapped).
- Only English pages get word swaps in dictionary mode. Other reading languages need the on-device Translator.
- Pronunciation depends on the text-to-speech voices installed on your system.
- The extension does not run on browser pages (`chrome://`, the Web Store) or inside iframes.
