// Import/export formats: JSON backup, CSV, and Anki-compatible tab-separated text.
// Pure module (no browser APIs) so it can be unit tested.
import { hasCloze } from './cloze.js';

export const JSON_FORMAT = 'recall-cards-backup';

/** RFC 4180-style parser supporting any single-char delimiter, quoted fields and embedded newlines. */
export function parseDelimited(text, delim = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let fieldStarted = false;
  const s = String(text || '').replace(/^﻿/, '');
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; fieldStarted = false; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; fieldStarted = false;
      if (ch === '\r' && s[i + 1] === '\n') i++;
      i++; continue;
    }
    field += ch; fieldStarted = true; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

export function formatField(value, delim) {
  const v = String(value ?? '');
  return /["\r\n]/.test(v) || v.includes(delim) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function formatDelimited(rows, delim = ',') {
  return rows.map(r => r.map(v => formatField(v, delim)).join(delim)).join('\n') + '\n';
}

export function splitTags(s) {
  return [...new Set(String(s || '').split(/[\s,]+/).map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
}

/** One representative card per note (cloze notes produce several cards). */
export function uniqueNotes(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const key = c.noteId || c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ---------------- JSON ----------------

export function exportJSON({ decks, cards, revlog }, now = Date.now()) {
  return JSON.stringify({ format: JSON_FORMAT, version: 1, exportedAt: new Date(now).toISOString(), decks, cards, revlog: revlog || [] }, null, 2);
}

/** Returns {kind:'backup', decks, cards, revlog} or {kind:'notes', notes} for a plain array of notes. */
export function parseJSON(text) {
  const data = JSON.parse(text);
  if (data && data.format === JSON_FORMAT) {
    if (!Array.isArray(data.cards) || !Array.isArray(data.decks)) throw new Error('Backup file is missing cards or decks.');
    return { kind: 'backup', decks: data.decks, cards: data.cards, revlog: Array.isArray(data.revlog) ? data.revlog : [] };
  }
  const arr = Array.isArray(data) ? data : Array.isArray(data?.cards) ? data.cards : null;
  if (!arr) throw new Error('Unrecognized JSON: expected a Recall Cards backup or an array of {front, back}.');
  const notes = arr.map(o => normalizeNote({
    front: o.front ?? o.question ?? o.text ?? '', back: o.back ?? o.answer ?? o.extra ?? '',
    deck: o.deck ?? o.deckName, tags: o.tags, sourceUrl: o.source?.url ?? o.sourceUrl ?? o.url, sourceTitle: o.source?.title ?? o.sourceTitle ?? o.title,
  })).filter(Boolean);
  return { kind: 'notes', notes };
}

// ---------------- CSV ----------------

export const CSV_HEADER = ['front', 'back', 'deck', 'tags', 'type', 'source_url', 'source_title'];

export function exportCSV(cards, deckNameById) {
  const rows = [CSV_HEADER];
  for (const c of uniqueNotes(cards)) {
    rows.push([c.front, c.back, deckNameById(c.deckId) || '', (c.tags || []).join(' '), c.type, c.source?.url || '', c.source?.title || '']);
  }
  return formatDelimited(rows, ',');
}

export function importCSV(text) {
  const rows = parseDelimited(text, text.includes('\t') && !text.split('\n')[0].includes(',') ? '\t' : ',');
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const hasHeader = head.includes('front') || head.includes('question');
  const idx = name => head.indexOf(name);
  const col = hasHeader
    ? { front: Math.max(idx('front'), idx('question')), back: Math.max(idx('back'), idx('answer')), deck: idx('deck'), tags: idx('tags'), url: Math.max(idx('source_url'), idx('url')), title: Math.max(idx('source_title'), idx('title')) }
    : { front: 0, back: 1, deck: -1, tags: 2, url: -1, title: -1 };
  const at = (r, i) => (i >= 0 && i < r.length ? r[i] : '');
  return rows.slice(hasHeader ? 1 : 0).map(r => normalizeNote({
    front: at(r, col.front), back: at(r, col.back), deck: at(r, col.deck), tags: at(r, col.tags), sourceUrl: at(r, col.url), sourceTitle: at(r, col.title),
  })).filter(Boolean);
}

// ---------------- Anki plain text (tab separated) ----------------
// Matches Anki's "Notes in Plain Text" format with file headers (Anki 2.1.55+):
//   #separator:tab  #html:true  #notetype column:1  #deck column:2  #tags column:5

export function textToAnkiHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
}

export function ankiHtmlToText(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function exportAnki(cards, deckNameById) {
  const lines = ['#separator:tab', '#html:true', '#notetype column:1', '#deck column:2', '#tags column:5'];
  const rows = uniqueNotes(cards).map(c => [
    c.type === 'cloze' ? 'Cloze' : 'Basic',
    deckNameById(c.deckId) || 'Default',
    textToAnkiHtml(c.front),
    textToAnkiHtml(c.back) + (c.source?.url ? `${c.back ? '<br><br>' : ''}<a href="${textToAnkiHtml(c.source.url)}">${textToAnkiHtml(c.source.title || c.source.url)}</a>` : ''),
    (c.tags || []).map(t => t.replace(/\s+/g, '_')).join(' '),
  ]);
  return lines.join('\n') + '\n' + formatDelimited(rows, '\t');
}

export function importAnki(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const headerLines = [];
  let body = src;
  // Leading lines starting with '#' are headers.
  while (body.startsWith('#')) {
    const nl = body.indexOf('\n');
    const line = nl === -1 ? body : body.slice(0, nl);
    headerLines.push(line.replace(/\r$/, ''));
    body = nl === -1 ? '' : body.slice(nl + 1);
  }
  const hdr = {};
  for (const l of headerLines) {
    const m = /^#([^:]+):(.*)$/.exec(l);
    if (m) hdr[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const sepName = (hdr.separator || 'tab').toLowerCase();
  const delim = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ', colon: ':' }[sepName] || (sepName.length === 1 ? sepName : '\t');
  const html = hdr.html ? hdr.html.toLowerCase() === 'true' : /<[a-z][\s\S]*>/i.test(body);
  const colNum = k => (hdr[k] ? parseInt(hdr[k], 10) - 1 : -1);
  const special = { notetype: colNum('notetype column'), deck: colNum('deck column'), tags: colNum('tags column'), guid: colNum('guid column') };
  const rows = parseDelimited(body, delim);
  const notes = [];
  for (const r of rows) {
    const fields = [];
    let tags = '';
    let deck = '';
    r.forEach((v, i) => {
      if (i === special.tags) tags = v;
      else if (i === special.deck) deck = v;
      else if (i === special.notetype || i === special.guid) { /* skip */ }
      else fields.push(v);
    });
    if (special.tags < 0 && fields.length >= 3) tags = fields.pop();
    const conv = html ? ankiHtmlToText : (x => x);
    const note = normalizeNote({ front: conv(fields[0] || ''), back: conv(fields[1] || ''), deck, tags });
    if (note) notes.push(note);
  }
  return notes;
}

// ---------------- shared ----------------

export function normalizeNote(n) {
  const front = String(n.front ?? '').trim();
  const back = String(n.back ?? '').trim();
  if (!front && !back) return null;
  const tags = Array.isArray(n.tags) ? n.tags.map(String).filter(Boolean) : splitTags(n.tags);
  return {
    type: hasCloze(front) ? 'cloze' : 'basic',
    front, back,
    deck: String(n.deck ?? '').trim(),
    tags,
    sourceUrl: String(n.sourceUrl ?? '').trim(),
    sourceTitle: String(n.sourceTitle ?? '').trim(),
  };
}

/** Detects format from filename and contents: 'json' | 'csv' | 'anki'. */
export function detectFormat(name, text) {
  const lower = String(name || '').toLowerCase();
  const t = String(text || '').trimStart();
  if (lower.endsWith('.json') || t.startsWith('{') || t.startsWith('[')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  if (t.startsWith('#separator') || t.startsWith('#html') || lower.endsWith('.txt') || lower.endsWith('.tsv')) return 'anki';
  return t.split('\n')[0].includes('\t') ? 'anki' : 'csv';
}
