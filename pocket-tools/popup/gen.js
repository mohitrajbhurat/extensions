// Password / pronounceable / passphrase generator tab.

import {
  generatePassword, generatePronounceable, generatePassphrase,
  strengthLabel, crackSeconds, humanDuration,
} from '../lib/password.js';
import { WORDS } from '../lib/wordlist.js';
import { $, $$, copyText, debounce, el } from './util.js';
import { saveSettings } from '../lib/settings.js';

let settings;
let opts;
let current = '';

const persist = debounce(() => saveSettings({ generator: opts }), 300);

function renderValue(value) {
  const out = $('#gen-output');
  out.replaceChildren();
  // Colour digits and symbols so the value is easier to read back.
  for (const ch of value) {
    if (/\d/.test(ch)) out.append(el('span', { class: 'd', text: ch }));
    else if (/[^\p{L}\d]/u.test(ch)) out.append(el('span', { class: 's', text: ch }));
    else out.append(ch);
  }
}

export function regenerate() {
  let result;
  try {
    if (opts.type === 'passphrase') result = generatePassphrase(opts, WORDS);
    else if (opts.type === 'pronounceable') result = generatePronounceable(opts);
    else result = generatePassword(opts);
  } catch (err) {
    current = '';
    $('#gen-output').textContent = err.message;
    $('#gen-copy').disabled = true;
    updateStrength(0, true);
    return;
  }
  current = result.value;
  $('#gen-copy').disabled = false;
  renderValue(current);
  updateStrength(result.entropy);
}

function updateStrength(bits, invalid = false) {
  const meter = $('#gen-meter');
  if (invalid) {
    meter.removeAttribute('data-score');
    $('#gen-strength').textContent = '—';
    $('#gen-entropy').textContent = '';
    $('#gen-crack').textContent = '';
    return;
  }
  const s = strengthLabel(bits);
  meter.dataset.score = s.score;
  meter.setAttribute('aria-valuenow', s.score);
  meter.setAttribute('aria-valuetext', s.label);
  $('#gen-strength').textContent = s.label;
  $('#gen-entropy').textContent = `${Math.round(bits)} bits of entropy`;
  $('#gen-crack').textContent =
    `Time to crack: ${humanDuration(crackSeconds(bits, 1e10))} offline (10 billion guesses/s), ` +
    `${humanDuration(crackSeconds(bits, 1e3))} online (1,000/s).`;
}

function syncControls() {
  $$('#gen-type button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === opts.type)));
  const isPhrase = opts.type === 'passphrase';
  $('#opts-password').classList.toggle('hidden', isPhrase);
  $('#opts-passphrase').classList.toggle('hidden', !isPhrase);
  $('#ambiguous-wrap').classList.toggle('hidden', opts.type === 'pronounceable');
  const minLen = opts.type === 'pronounceable' ? 6 : 4;
  for (const id of ['#gen-length', '#gen-length-num']) {
    $(id).min = minLen;
    $(id).value = opts.length;
  }
  $('#gen-upper').checked = opts.upper;
  $('#gen-lower').checked = opts.type === 'pronounceable' ? true : opts.lower;
  $('#gen-lower').disabled = opts.type === 'pronounceable';
  $('#gen-digits').checked = opts.digits;
  $('#gen-symbols').checked = opts.symbols;
  $('#gen-ambiguous').checked = opts.excludeAmbiguous;
  $('#gen-words').value = opts.words;
  $('#gen-words-num').value = opts.words;
  $('#gen-separator').value = opts.separator;
  $('#gen-capitalize').checked = opts.capitalize;
  $('#gen-number').checked = opts.includeNumber;
}

function update(patch) {
  Object.assign(opts, patch);
  if (opts.type === 'pronounceable' && opts.length < 6) opts.length = 6;
  syncControls();
  regenerate();
  persist();
}

export function initGenerator(s) {
  settings = s;
  opts = { ...s.generator };
  $('#clear-secs').textContent = settings.clearSeconds;
  if (!(settings.clearSeconds > 0)) $('#gen-note').textContent = 'Nothing you generate is saved. Clipboard auto-clear is off (see Settings).';

  $('#gen-type').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (b) update({ type: b.dataset.type });
  });
  const clampLen = v => Math.min(128, Math.max(opts.type === 'pronounceable' ? 6 : 4, Number(v) || 20));
  $('#gen-length').addEventListener('input', e => update({ length: clampLen(e.target.value) }));
  $('#gen-length-num').addEventListener('change', e => update({ length: clampLen(e.target.value) }));
  const clampWords = v => Math.min(20, Math.max(3, Number(v) || 5));
  $('#gen-words').addEventListener('input', e => update({ words: clampWords(e.target.value) }));
  $('#gen-words-num').addEventListener('change', e => update({ words: clampWords(e.target.value) }));
  $('#gen-separator').addEventListener('input', e => update({ separator: e.target.value }));
  const checks = { '#gen-upper': 'upper', '#gen-lower': 'lower', '#gen-digits': 'digits', '#gen-symbols': 'symbols', '#gen-ambiguous': 'excludeAmbiguous', '#gen-capitalize': 'capitalize', '#gen-number': 'includeNumber' };
  for (const [sel, key] of Object.entries(checks)) {
    $(sel).addEventListener('change', e => {
      const patch = { [key]: e.target.checked };
      const next = { ...opts, ...patch };
      // Keep at least one class selected for random passwords.
      if (opts.type === 'password' && !['upper', 'lower', 'digits', 'symbols'].some(k => next[k])) {
        e.target.checked = true;
        return;
      }
      update(patch);
    });
  }
  $('#gen-refresh').addEventListener('click', regenerate);
  $('#gen-copy').addEventListener('click', () => {
    if (current) copyText(current, { sensitive: true, clearSeconds: settings.clearSeconds, label: 'Copied' });
  });
  $('#panel-password').addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); regenerate(); }
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('#gen-copy').click(); }
  });
  syncControls();
  regenerate();
}
