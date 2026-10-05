// Cloze deletion helpers. Syntax: {{c1::answer}} or {{c1::answer::hint}} (Anki compatible).
// Pure module, safe for node:test.

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** Escapes text and turns newlines into <br>. */
export function textToHtml(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

export function hasCloze(text) {
  CLOZE_RE.lastIndex = 0;
  return CLOZE_RE.test(String(text || ''));
}

/** Sorted unique cloze numbers used in text. */
export function clozeNumbers(text) {
  const nums = new Set();
  for (const m of String(text || '').matchAll(CLOZE_RE)) nums.add(Number(m[1]));
  return [...nums].filter(n => n > 0).sort((a, b) => a - b);
}

export function nextClozeNumber(text) {
  const nums = clozeNumbers(text);
  return nums.length ? nums[nums.length - 1] + 1 : 1;
}

/**
 * Renders cloze text to safe HTML for card `n`.
 * reveal=false: the active cloze is hidden as [...] (or [hint]); others show their answer.
 * reveal=true: the active cloze answer is highlighted.
 */
export function renderCloze(text, n, reveal) {
  const src = String(text || '');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(CLOZE_RE)) {
    out += textToHtml(src.slice(last, m.index));
    const num = Number(m[1]);
    const answer = m[2];
    const hint = m[3];
    if (num === Number(n)) {
      out += reveal
        ? `<span class="cloze cloze-revealed">${textToHtml(answer)}</span>`
        : `<span class="cloze cloze-hidden">[${hint ? textToHtml(hint) : '&hellip;'}]</span>`;
    } else {
      out += `<span class="cloze-other">${textToHtml(answer)}</span>`;
    }
    last = m.index + m[0].length;
  }
  out += textToHtml(src.slice(last));
  return out;
}

/** Plain text with all clozes replaced by their answers (for search and list previews). */
export function stripCloze(text) {
  return String(text || '').replace(CLOZE_RE, (_, _n, answer) => answer);
}

/**
 * Splits text into tokens for the click-to-cloze builder.
 * Returns [{text, word:boolean}] where non-word tokens are whitespace/punctuation runs.
 */
export function tokenize(text) {
  const tokens = [];
  const re = /([\p{L}\p{N}][\p{L}\p{N}'’\-_.%$€£]*[\p{L}\p{N}%]|[\p{L}\p{N}])|([^\p{L}\p{N}]+)/gu;
  for (const m of String(text || '').matchAll(re)) tokens.push({ text: m[0], word: !!m[1] });
  return tokens;
}

/**
 * Builds cloze text from tokens and a set of selected word indexes.
 * Adjacent selected words (separated only by spaces/punctuation inside the run) merge into one deletion.
 * separate=true numbers each group c1, c2, ...; separate=false puts every group in c1 (one card).
 */
export function buildCloze(tokens, selected, separate = true) {
  const sel = selected instanceof Set ? selected : new Set(selected);
  let out = '';
  let n = 0;
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].word && sel.has(i)) {
      // extend group across following selected words joined by non-newline separators
      let j = i;
      while (j + 2 < tokens.length && !tokens[j + 1].word && !/\n/.test(tokens[j + 1].text) && tokens[j + 2].word && sel.has(j + 2)) j += 2;
      n += 1;
      const num = separate ? n : 1;
      out += `{{c${num}::${tokens.slice(i, j + 1).map(t => t.text).join('')}}}`;
      i = j + 1;
    } else {
      out += tokens[i].text;
      i += 1;
    }
  }
  return out;
}

/** Wraps text[start:end] in the next cloze number (used by "Cloze selection" buttons). */
export function wrapCloze(text, start, end, num) {
  const s = String(text || '');
  const n = num || nextClozeNumber(s);
  const inner = s.slice(start, end) || '…';
  return { text: s.slice(0, start) + `{{c${n}::${inner}}}` + s.slice(end), cursor: start + `{{c${n}::${inner}}}`.length };
}
