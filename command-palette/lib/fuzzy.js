// Fuzzy matcher and scorer, written for the command palette.
// Approach (similar in spirit to fzf v1 / Sublime): a match is a subsequence of the
// text. Each matched character earns points, with bonuses for word starts, camelCase
// humps and consecutive runs, and penalties for gaps. Several candidate alignments are
// tried (each word-boundary occurrence of the first character, plus a backward-tightened
// greedy pass) and the best one wins. Returns { score, indices } or null.

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 10;
const BONUS_FIRST_CHAR = 14; // match at index 0 of the text
const BONUS_CAMEL = 8;
const BONUS_CONSECUTIVE = 5;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXT = 1;
const MAX_GAP_PENALTY = 12;

function isSep(c) {
  return c === ' ' || c === '-' || c === '_' || c === '.' || c === '/' || c === ':' ||
    c === '?' || c === '&' || c === '=' || c === '#' || c === '(' || c === ')' || c === '[' ||
    c === ']' || c === ',' || c === '|' || c === '+' || c === '"' || c === "'" || c === '@';
}
function isUpper(c) { return c >= 'A' && c <= 'Z'; }
function isLowerOrDigit(c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }

function charBonus(text, i) {
  if (i === 0) return BONUS_FIRST_CHAR;
  const prev = text[i - 1];
  if (isSep(prev)) return BONUS_BOUNDARY;
  if (isUpper(text[i]) && isLowerOrDigit(prev)) return BONUS_CAMEL;
  return 0;
}

/** Score a fixed set of matched indices. */
function scoreIndices(text, indices) {
  let score = 0;
  let run = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    let s = SCORE_MATCH + charBonus(text, i);
    if (k > 0) {
      const gap = i - indices[k - 1] - 1;
      if (gap === 0) {
        run++;
        s += BONUS_CONSECUTIVE * Math.min(run, 4);
      } else {
        run = 0;
        score -= Math.min(MAX_GAP_PENALTY, PENALTY_GAP_START + (gap - 1) * PENALTY_GAP_EXT);
      }
    }
    score += s;
  }
  // Leading unmatched characters cost a little (prefer matches near the start).
  if (indices.length) score -= Math.min(8, indices[0] * 0.25);
  return score;
}

/** Greedy forward match starting from `from`; returns indices or null. */
function forward(lower, pat, from) {
  const out = new Array(pat.length);
  let j = 0;
  for (let i = from; i < lower.length && j < pat.length; i++) {
    if (lower[i] === pat[j]) out[j++] = i;
  }
  return j === pat.length ? out : null;
}

/** Tighten a forward match by scanning backwards from its last index (fzf v1 trick). */
function tighten(lower, pat, fwd) {
  const out = new Array(pat.length);
  let j = pat.length - 1;
  for (let i = fwd[fwd.length - 1]; i >= 0 && j >= 0; i--) {
    if (lower[i] === pat[j]) out[j--] = i;
  }
  return j < 0 ? out : fwd;
}

/**
 * Prefer whole-run alignments: after an initial alignment, try to extend each matched
 * character into a consecutive run with the next pattern char when possible.
 */
function wordAligned(text, lower, pat) {
  // Match each pattern char preferring boundary positions (acronym style), falling back
  // to the next plain occurrence.
  const out = [];
  let i = 0;
  for (let j = 0; j < pat.length; j++) {
    const c = pat[j];
    let found = -1;
    // Continue a run if the very next char matches.
    if (out.length && lower[i] === c) found = i;
    else {
      let firstPlain = -1;
      for (let k = i; k < lower.length; k++) {
        if (lower[k] !== c) continue;
        if (firstPlain < 0) firstPlain = k;
        if (k === 0 || isSep(text[k - 1]) || (isUpper(text[k]) && isLowerOrDigit(text[k - 1]))) { found = k; break; }
      }
      if (found < 0) found = firstPlain;
    }
    if (found < 0) return null;
    out.push(found);
    i = found + 1;
  }
  return out;
}

/**
 * Match a lowercase pattern (no spaces) against text.
 * @param {string} pattern lowercase pattern
 * @param {string} text original text
 * @param {string} [lower] lowercase text (pass to avoid recomputing)
 */
export function fuzzyMatch(pattern, text, lower) {
  if (!pattern) return { score: 0, indices: [] };
  if (!text) return null;
  lower = lower || text.toLowerCase();
  const plen = pattern.length;
  if (plen > lower.length) return null;

  // Fast reject: is it a subsequence at all?
  const first = forward(lower, pattern, 0);
  if (!first) return null;

  const candidates = [first, tighten(lower, pattern, first)];

  // Substring occurrences (contiguous) are usually the best match.
  let pos = lower.indexOf(pattern);
  let guard = 0;
  while (pos >= 0 && guard++ < 6) {
    const idx = new Array(plen);
    for (let k = 0; k < plen; k++) idx[k] = pos + k;
    candidates.push(idx);
    pos = lower.indexOf(pattern, pos + 1);
  }

  // Start from each word-boundary occurrence of the first char (up to a few).
  let starts = 0;
  for (let i = 1; i < lower.length && starts < 6; i++) {
    if (lower[i] !== pattern[0]) continue;
    if (!(isSep(text[i - 1]) || (isUpper(text[i]) && isLowerOrDigit(text[i - 1])))) continue;
    starts++;
    const f = forward(lower, pattern, i);
    if (!f) break;
    candidates.push(f, tighten(lower, pattern, f));
  }

  const wa = wordAligned(text, lower, pattern);
  if (wa) candidates.push(wa);

  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = scoreIndices(text, c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  // Bonus for an exact (case-insensitive) match or a prefix match of the whole text.
  if (lower === pattern) bestScore += 30;
  else if (best[0] === 0 && best[plen - 1] === plen - 1) bestScore += 12;
  return { score: bestScore, indices: best };
}

/** Split a query into lowercase tokens. */
export function tokenize(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Score an item with several weighted fields against a tokenized query.
 * Every token must match at least one field. Returns null when any token fails.
 * fields: [{ text, lower?, weight, key }]  (key names the highlight bucket, or null)
 * Result: { score, hl: { [key]: number[] } }
 */
export function scoreFields(tokens, fields) {
  if (!tokens.length) return { score: 0, hl: {} };
  const hl = {};
  let total = 0;
  for (const tok of tokens) {
    let best = null;
    let bestScore = -Infinity;
    let bestField = null;
    for (const f of fields) {
      if (!f.text) continue;
      if (f.lower === undefined) f.lower = f.text.toLowerCase();
      const m = fuzzyMatch(tok, f.text, f.lower);
      if (!m) continue;
      // Heavily scattered matches in long fields are noise: require some density.
      const span = m.indices[m.indices.length - 1] - m.indices[0] + 1;
      if (tok.length >= 3 && span > tok.length * 6 + 8) continue;
      const s = m.score * f.weight;
      if (s > bestScore) { bestScore = s; best = m; bestField = f; }
    }
    if (!best) return null;
    total += bestScore;
    if (bestField.key) {
      const arr = hl[bestField.key] || (hl[bestField.key] = []);
      for (const i of best.indices) arr.push(i);
    }
  }
  for (const k in hl) hl[k] = Array.from(new Set(hl[k])).sort((a, b) => a - b);
  // Normalize so long queries don't dominate other ranking signals too much.
  return { score: total / Math.sqrt(tokens.length), hl };
}
