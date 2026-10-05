// Password, pronounceable password and passphrase generation with exact
// entropy estimates. Uses crypto.getRandomValues with rejection sampling so
// every choice is unbiased. Nothing generated here is ever stored.

export const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>/?~',
};
// Characters that are easy to confuse when read or typed by hand.
export const AMBIGUOUS = 'Il1O0o|`\'"{}[]()/\\;:,.<>~';

export const DEFAULT_PASSWORD_OPTIONS = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

const cryptoObj = globalThis.crypto;

// Uniform integer in [0, n) without modulo bias.
export function randomInt(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError('randomInt: bad bound ' + n);
  if (n === 1) return 0;
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    cryptoObj.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function pick(str) {
  const arr = typeof str === 'string' ? [...str] : str;
  return arr[randomInt(arr.length)];
}

export function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function classSets(opts) {
  const strip = s => (opts.excludeAmbiguous ? [...s].filter(c => !AMBIGUOUS.includes(c)).join('') : s);
  const sets = [];
  for (const key of ['upper', 'lower', 'digits', 'symbols']) {
    if (opts[key]) {
      const chars = strip(CHARSETS[key]);
      if (chars) sets.push(chars);
    }
  }
  return sets;
}

// Number of strings of `length` over the union of `sets` that contain at least
// one character from every set (inclusion-exclusion), as a BigInt.
export function countValid(sets, length) {
  const L = BigInt(length);
  let total = 0n;
  const k = sets.length;
  for (let mask = 0; mask < 1 << k; mask++) {
    let size = 0;
    let excluded = 0;
    for (let i = 0; i < k; i++) {
      if (mask & (1 << i)) excluded++;
      else size += sets[i].length;
    }
    const term = BigInt(size) ** L;
    total += excluded % 2 ? -term : term;
  }
  return total;
}

export function log2Big(n) {
  if (n <= 0n) return 0;
  const s = n.toString(2);
  if (s.length <= 52) return Math.log2(Number(n));
  const head = Number.parseInt(s.slice(0, 52), 2);
  return Math.log2(head) + (s.length - 52);
}

/**
 * Random password where each enabled character class appears at least once.
 * Uniform over all such strings (rejection sampling), so the entropy below is exact.
 */
export function generatePassword(options = {}) {
  const opts = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const sets = classSets(opts);
  if (!sets.length) throw new Error('Choose at least one character type.');
  const length = clampInt(opts.length, Math.max(4, sets.length), 128, 20);
  const pool = [...sets.join('')];
  let password;
  for (let attempt = 0; attempt < 10000; attempt++) {
    const chars = [];
    for (let i = 0; i < length; i++) chars.push(pool[randomInt(pool.length)]);
    password = chars.join('');
    if (sets.every(set => chars.some(c => set.includes(c)))) break;
  }
  return { value: password, entropy: log2Big(countValid(sets, length)), length, poolSize: pool.length };
}

export function passwordEntropy(options = {}) {
  const opts = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const sets = classSets(opts);
  if (!sets.length) return 0;
  const length = clampInt(opts.length, Math.max(4, sets.length), 128, 20);
  return log2Big(countValid(sets, length));
}

// ------------------------------------------------------------ pronounceable

const CONSONANTS = 'bcdfghjkmnprstvwxz'; // no l, q, y: they are ambiguous or awkward
const VOWELS = 'aeiou';
const SAFE_DIGITS = '23456789';
const SAFE_SYMBOLS = '!@#$%&*?-+=';

/**
 * Alternating consonant/vowel letters ("tobakemu"). Optional random-case
 * consonants, and digits/symbol appended at the end.
 */
export function generatePronounceable(options = {}) {
  const opts = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const length = clampInt(opts.length, 6, 128, 16);
  const digitCount = opts.digits ? 2 : 0;
  const symbolCount = opts.symbols ? 1 : 0;
  const letterCount = Math.max(4, length - digitCount - symbolCount);
  let bits = 1; // starts with a consonant or a vowel
  let out = '';
  let consonant = randomInt(2) === 0;
  for (let i = 0; i < letterCount; i++) {
    if (consonant) {
      let c = pick(CONSONANTS);
      bits += Math.log2(CONSONANTS.length);
      if (opts.upper) {
        if (randomInt(2)) c = c.toUpperCase();
        bits += 1;
      }
      out += c;
    } else {
      out += pick(VOWELS);
      bits += Math.log2(VOWELS.length);
    }
    consonant = !consonant;
  }
  for (let i = 0; i < digitCount; i++) { out += pick(SAFE_DIGITS); bits += Math.log2(SAFE_DIGITS.length); }
  for (let i = 0; i < symbolCount; i++) { out += pick(SAFE_SYMBOLS); bits += Math.log2(SAFE_SYMBOLS.length); }
  return { value: out, entropy: bits, length: out.length };
}

// --------------------------------------------------------------- passphrase

export const DEFAULT_PASSPHRASE_OPTIONS = {
  words: 5,
  separator: '-',
  capitalize: true,
  includeNumber: true,
};

export function generatePassphrase(options = {}, wordlist) {
  const opts = { ...DEFAULT_PASSPHRASE_OPTIONS, ...options };
  if (!wordlist || wordlist.length < 2) throw new Error('A word list is required.');
  const count = clampInt(opts.words, 3, 20, 5);
  const words = [];
  for (let i = 0; i < count; i++) {
    let w = wordlist[randomInt(wordlist.length)];
    if (opts.capitalize) w = w[0].toUpperCase() + w.slice(1);
    words.push(w);
  }
  let bits = count * Math.log2(wordlist.length);
  if (opts.includeNumber) {
    const idx = randomInt(count);
    words[idx] += String(randomInt(10));
    bits += Math.log2(10) + Math.log2(count);
  }
  const sep = typeof opts.separator === 'string' ? opts.separator.slice(0, 3) : '-';
  return { value: words.join(sep), entropy: bits, words: count };
}

// ------------------------------------------------------------------ strength

export function strengthLabel(bits) {
  if (bits < 28) return { score: 0, label: 'Very weak' };
  if (bits < 36) return { score: 1, label: 'Weak' };
  if (bits < 60) return { score: 2, label: 'Fair' };
  if (bits < 80) return { score: 3, label: 'Strong' };
  return { score: 4, label: 'Very strong' };
}

// Average seconds to find the password: half the keyspace at `guessesPerSecond`.
export function crackSeconds(bits, guessesPerSecond = 1e10) {
  return 2 ** (bits - 1) / guessesPerSecond;
}

export function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'forever';
  if (seconds < 1) return 'instantly';
  const units = [
    ['year', 31557600],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  if (seconds >= 31557600 * 1e12) return 'over a trillion years';
  for (const [name, size] of units) {
    if (seconds >= size) {
      const n = seconds / size;
      if (name === 'year' && n >= 1e6) {
        const scales = [[1e9, 'billion'], [1e6, 'million']];
        for (const [s, word] of scales) if (n >= s) return `${Math.round(n / s).toLocaleString('en-US')} ${word} years`;
      }
      const r = Math.round(n);
      return `${r.toLocaleString('en-US')} ${name}${r === 1 ? '' : 's'}`;
    }
  }
  return 'instantly';
}
