// Card face rendering to safe HTML strings (all user text is escaped).
import { renderCloze, textToHtml, escapeHtml, stripCloze } from './cloze.js';

function sourceHtml(card) {
  if (!card.source || !card.source.url) return '';
  let host = card.source.url;
  try { host = new URL(card.source.url).hostname.replace(/^www\./, ''); } catch {}
  const safe = /^https?:|^file:/i.test(card.source.url) ? escapeHtml(card.source.url) : '#';
  return `<span class="src">Source: <a href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(card.source.title || host)}</a>${host && card.source.title ? ' · ' + escapeHtml(host) : ''}</span>`;
}

export function renderFront(card) {
  if (card.type === 'cloze') return renderCloze(card.front, card.clozeIndex || 1, false);
  return textToHtml(card.front);
}

export function renderBack(card) {
  if (card.type === 'cloze') {
    return renderCloze(card.front, card.clozeIndex || 1, true)
      + (card.back ? `<hr><div class="extra">${textToHtml(card.back)}</div>` : '')
      + sourceHtml(card);
  }
  return textToHtml(card.front) + '<hr id="answer">' + `<div>${textToHtml(card.back)}</div>` + sourceHtml(card);
}

/** One-line plain preview for lists. */
export function preview(card, max = 140) {
  let t = stripCloze(card.front).replace(/\s+/g, ' ').trim();
  if (card.type === 'cloze' && card.clozeIndex) t = `[c${card.clozeIndex}] ` + t;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
