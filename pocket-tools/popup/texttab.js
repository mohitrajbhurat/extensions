// Text statistics and case conversion tab.

import { analyze, easeLabel, formatDuration, CASES, convertCase } from '../lib/textstats.js';
import { $, debounce, el, copyText, toast, activePageTab } from './util.js';

const DRAFT_KEY = 'textDraft';
const undoStack = [];

function nf(n, digits = 0) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function render() {
  const text = $('#text-input').value;
  const a = analyze(text);
  const stats = [
    ['Words', nf(a.words)],
    ['Characters', nf(a.characters)],
    ['No spaces', nf(a.charactersNoSpaces)],
    ['Sentences', nf(a.sentences)],
    ['Paragraphs', nf(a.paragraphs)],
    ['Syllables', nf(a.syllables)],
    ['Reading time', formatDuration(a.readingSeconds)],
    ['Speaking time', formatDuration(a.speakingSeconds)],
    ['Avg word', a.words ? `${nf(a.avgWordLength, 1)} chars` : '—'],
  ];
  $('#text-stats').replaceChildren(...stats.map(([label, value]) => el('div', { class: 'stat' }, el('b', { text: value }), el('span', { text: label }))));

  const r = $('#text-readability');
  if (a.words) {
    const ease = Math.max(0, Math.min(100, a.fleschEase));
    const grade = Math.max(0, a.fleschGrade);
    r.replaceChildren(
      el('div', {}, el('div', { class: 'muted small', text: 'Flesch reading ease' }), el('b', { text: nf(ease, 1) }), ' ', el('span', { class: 'muted', text: easeLabel(a.fleschEase) })),
      el('div', {}, el('div', { class: 'muted small', text: 'Flesch–Kincaid grade' }), el('b', { text: nf(grade, 1) }), ' ', el('span', { class: 'muted', text: `${nf(a.avgSentenceLength, 1)} words/sentence` })),
    );
  } else {
    r.replaceChildren(el('span', { class: 'muted small', text: 'Readability scores appear once there is some text.' }));
  }

  const kw = $('#text-keywords');
  kw.replaceChildren(...(a.keywords.length
    ? a.keywords.map(k => el('li', {}, `${k.word} `, el('span', { class: 'muted', text: `×${k.count} · ${nf(k.density * 100, 1)}%` })))
    : [el('li', { class: 'muted', style: 'list-style:none', text: 'None yet' })]));
}

const saveDraft = debounce(() => {
  // Draft lives only in session storage (cleared when the browser closes).
  chrome.storage.session.set({ [DRAFT_KEY]: $('#text-input').value.slice(0, 200000) }).catch(() => {});
}, 400);

function setText(value, { undoable = true } = {}) {
  const ta = $('#text-input');
  if (undoable && ta.value !== value) {
    undoStack.push(ta.value);
    if (undoStack.length > 20) undoStack.shift();
  }
  ta.value = value;
  $('#text-undo').disabled = !undoStack.length;
  render();
  saveDraft();
}

async function grabSelection() {
  try {
    const tab = await activePageTab();
    if (!tab) throw new Error('no tab');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) {
          try { return a.value.substring(a.selectionStart, a.selectionEnd); } catch { /* no selection API */ }
        }
        return String(window.getSelection() || '');
      },
    });
    const text = results.map(r => r.result || '').find(t => t.trim());
    if (text) setText(text);
    else toast('Nothing is selected on the page.');
  } catch {
    toast('Can’t read this page (browser pages and the web store are off limits).');
  }
}

export async function initText(pending) {
  const ta = $('#text-input');
  ta.addEventListener('input', () => { render(); saveDraft(); });
  $('#text-grab').addEventListener('click', grabSelection);
  $('#text-copy').addEventListener('click', () => ta.value && copyText(ta.value, { label: 'Text copied' }));
  $('#text-clear').addEventListener('click', () => { setText(''); ta.focus(); });
  $('#text-undo').addEventListener('click', () => {
    if (!undoStack.length) return;
    ta.value = undoStack.pop();
    $('#text-undo').disabled = !undoStack.length;
    render();
    saveDraft();
  });
  $('#case-buttons').replaceChildren(...Object.entries(CASES).map(([key, c]) =>
    el('button', { class: 'btn small', type: 'button', text: c.label, onclick: () => {
      // Convert only the selected part of the textarea when there is one.
      const { selectionStart: s, selectionEnd: e, value } = ta;
      if (e > s) {
        setText(value.slice(0, s) + convertCase(value.slice(s, e), key) + value.slice(e));
        ta.setSelectionRange(s, s + convertCase(value.slice(s, e), key).length);
      } else {
        setText(convertCase(value, key));
      }
    } })));

  if (pending && typeof pending.text === 'string' && pending.tab === 'text') {
    setText(pending.text, { undoable: false });
  } else {
    try {
      const stored = await chrome.storage.session.get(DRAFT_KEY);
      if (stored[DRAFT_KEY]) ta.value = stored[DRAFT_KEY];
    } catch { /* session storage unavailable */ }
    render();
  }
}
