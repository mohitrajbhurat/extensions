/* Language Immersion - shared helpers.
 * Plain script (no exports) so it works as a content script, in extension pages
 * via <script src>, and in the module service worker via a side-effect import.
 * Everything hangs off globalThis.LIM. */
(function () {
  'use strict';
  if (globalThis.LIM) return;

  // Languages with a bundled offline dictionary (English source only).
  const DICTIONARY_LANGS = ['es', 'fr', 'de'];

  // Target languages offered in the UI. Non-dictionary ones need Chrome's built-in Translator.
  const LANGUAGES = [
    { code: 'es', name: 'Spanish', native: 'Español', flag: 'ES' },
    { code: 'fr', name: 'French', native: 'Français', flag: 'FR' },
    { code: 'de', name: 'German', native: 'Deutsch', flag: 'DE' },
    { code: 'it', name: 'Italian', native: 'Italiano', flag: 'IT' },
    { code: 'pt', name: 'Portuguese', native: 'Português', flag: 'PT' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands', flag: 'NL' },
    { code: 'pl', name: 'Polish', native: 'Polski', flag: 'PL' },
    { code: 'sv', name: 'Swedish', native: 'Svenska', flag: 'SV' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe', flag: 'TR' },
    { code: 'ru', name: 'Russian', native: 'Русский', flag: 'RU' },
    { code: 'ja', name: 'Japanese', native: '日本語', flag: 'JA' },
    { code: 'ko', name: 'Korean', native: '한국어', flag: 'KO' },
    { code: 'zh', name: 'Chinese', native: '中文', flag: 'ZH' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: 'HI' },
    { code: 'ar', name: 'Arabic', native: 'العربية', flag: 'AR' },
    { code: 'en', name: 'English', native: 'English', flag: 'EN' },
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    nativeLang: 'en',
    targetLang: 'es',
    difficulty: 'beginner',      // beginner | intermediate | advanced
    density: 20,                 // max replacements per page (5..80)
    siteMode: 'all',             // all | allowlist
    disabledSites: [],
    enabledSites: [],
    selectionTranslate: true,
    engine: 'auto',              // auto | dictionary
    highlight: 'underline',      // underline | tint | minimal
    showKnown: true,             // occasionally still show words marked known
    autoLearnAfter: 3,           // sightings before a word joins the review deck (0 = only saved words)
    speechRate: 0.9,
    dailyGoal: 10,
  };

  // Leitner boxes: days until the next review after landing in each box.
  const LEITNER_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 16 };
  const DAY_MS = 86400000;

  const POS_LABEL = {
    n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', num: 'number', pron: 'pronoun',
    prep: 'preposition', conj: 'conjunction', det: 'determiner', int: 'interjection', phrase: 'phrase',
  };

  function langName(code) {
    const l = LANGUAGES.find((x) => x.code === code);
    return l ? l.name : (code || '').toUpperCase();
  }

  function todayKey(d) {
    d = d || new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function wordKey(lang, en) {
    return `${lang}:${String(en).toLowerCase().trim()}`;
  }

  function hostAllowed(settings, host) {
    if (!settings.enabled || !host) return false;
    host = host.replace(/^www\./, '');
    const match = (list) => (list || []).some((h) => host === h || host.endsWith('.' + h));
    if (settings.siteMode === 'allowlist') return match(settings.enabledSites);
    return !match(settings.disabledSites);
  }

  // ---------- Inflection helpers ----------
  const EN_IRREGULAR_PLURALS = {
    man: 'men', woman: 'women', child: 'children', foot: 'feet', tooth: 'teeth', mouse: 'mice',
    knife: 'knives', leaf: 'leaves', wife: 'wives', life: 'lives', wolf: 'wolves', half: 'halves',
    sheep: 'sheep', fish: 'fish', potato: 'potatoes', tomato: 'tomatoes', person: 'people',
    thief: 'thieves', shelf: 'shelves', hero: 'heroes', kid: 'kids', video: 'videos', photo: 'photos',
    radio: 'radios', piano: 'pianos', zoo: 'zoos',
  };
  // Nouns that are uncountable or already plural; no plural form is generated.
  const EN_NO_PLURAL = new Set(('people information money news music water air health education police data ' +
    'research advice evidence clothes luggage homework weather traffic electricity furniture knowledge ' +
    'rice sugar salt milk bread butter cheese meat sand snow rain grass gold silver iron wood plastic ' +
    'pants soccer football tennis basketball english spanish french german today tomorrow yesterday ' +
    'nature anger joy peace freedom safety luck pride shame guilt trust respect cash credit percent ' +
    'chocolate coffee tea wine beer juice soup oil gas fuel energy fever silence noise').split(' '));

  function englishPlural(w) {
    if (EN_NO_PLURAL.has(w)) return null;
    if (EN_IRREGULAR_PLURALS[w]) return EN_IRREGULAR_PLURALS[w];
    if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
    if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
    return w + 's';
  }

  const ES_ACCENT_DROP = { 'ón': 'on', 'án': 'an', 'és': 'es', 'ín': 'in', 'ún': 'un' };
  function spanishPlural(w) {
    const parts = w.split(' ');
    let h = parts[0];
    if (/[sx]$/.test(h)) return w;
    if (/z$/.test(h)) h = h.slice(0, -1) + 'ces';
    else if (/[aeiouáéó]$/.test(h)) h = h + 's';
    else if (/[íú]$/.test(h)) h = h + 'es';
    else {
      const tail = h.slice(-2);
      if (ES_ACCENT_DROP[tail]) h = h.slice(0, -2) + ES_ACCENT_DROP[tail];
      h = h + 'es';
    }
    parts[0] = h;
    return parts.join(' ');
  }

  function frenchPlural(w) {
    const parts = w.split(' ');
    let h = parts[0];
    if (/[sxz]$/.test(h)) return w;
    if (/(eau|eu)$/.test(h)) h += 'x';
    else if (/al$/.test(h) && !/^(festival|bal|carnaval)$/.test(h)) h = h.slice(0, -2) + 'aux';
    else if (h.includes('-')) h = h.split('-').map((p) => (/[sxz]$/.test(p) ? p : p + 's')).join('-');
    else h += 's';
    parts[0] = h;
    return parts.join(' ');
  }

  function targetPlural(lang, w) {
    if (lang === 'es') return spanishPlural(w);
    if (lang === 'fr') return frenchPlural(w);
    return null; // German and others: plural forms are irregular, not generated.
  }

  // Definite article for a noun with grammatical gender g (m|f|n|pl|x).
  function article(lang, g, word, plural) {
    if (!g || g === 'x') return '';
    if (lang === 'es') {
      if (plural || g === 'pl') return g === 'f' ? 'las' : 'los';
      return g === 'f' ? 'la' : 'el';
    }
    if (lang === 'fr') {
      if (plural || g === 'pl') return 'les';
      if (/^[aeiouyhâàéèêîïôûœ]/i.test(word)) return "l'";
      return g === 'f' ? 'la' : 'le';
    }
    if (lang === 'de') {
      if (plural || g === 'pl') return 'die';
      return { m: 'der', f: 'die', n: 'das' }[g] || '';
    }
    return '';
  }

  function genderLabel(g) {
    return { m: 'masculine', f: 'feminine', n: 'neuter', pl: 'plural' }[g] || '';
  }

  // Accent-insensitive comparison for typed quiz answers.
  function normalizeAnswer(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function stripArticle(s) {
    return String(s || '').replace(/^(el|la|los|las|le|les|l'|der|die|das|un|une|una|ein|eine)\s*/i, '');
  }

  // ---------- Stats ----------
  function computeStats(vocab, activity, now) {
    now = now || Date.now();
    let known = 0, learning = 0, seenWords = 0, due = 0, saved = 0, exposures = 0;
    for (const e of Object.values(vocab || {})) {
      seenWords++;
      exposures += e.seen || 0;
      if (e.state === 'known') known++;
      else if (e.state === 'learning') learning++;
      if (e.saved) saved++;
      if (e.state === 'learning' && (e.due || 0) <= now) due++;
    }
    const act = activity || {};
    let streak = 0;
    const d = new Date(now);
    // Today counts if active; otherwise the streak may still be alive from yesterday.
    if (!isActive(act[todayKey(d)])) d.setDate(d.getDate() - 1);
    while (isActive(act[todayKey(d)])) { streak++; d.setDate(d.getDate() - 1); }
    const today = act[todayKey(new Date(now))] || {};
    return { known, learning, seenWords, due, saved, exposures, streak,
      seenToday: today.seen || 0, reviewedToday: today.reviewed || 0 };
  }
  function isActive(day) { return !!day && ((day.seen || 0) > 0 || (day.reviewed || 0) > 0); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Pick a speechSynthesis voice for a language code (best effort; voices load async).
  function pickVoice(lang) {
    if (typeof speechSynthesis === 'undefined') return null;
    const voices = speechSynthesis.getVoices() || [];
    const lc = lang.toLowerCase();
    return voices.find((v) => v.lang && v.lang.toLowerCase() === lc) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lc + '-') && v.localService) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lc)) || null;
  }

  function speak(text, lang, rate) {
    if (typeof speechSynthesis === 'undefined' || !text) return false;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const v = pickVoice(lang);
      if (v) u.voice = v;
      u.rate = rate || 0.9;
      speechSynthesis.speak(u);
      return true;
    } catch (e) {
      return false;
    }
  }

  globalThis.LIM = {
    DICTIONARY_LANGS, LANGUAGES, DEFAULT_SETTINGS, LEITNER_DAYS, DAY_MS, POS_LABEL,
    langName, todayKey, wordKey, hostAllowed, englishPlural, targetPlural, article, genderLabel,
    normalizeAnswer, stripArticle, computeStats, escapeHtml, pickVoice, speak,
  };
})();
