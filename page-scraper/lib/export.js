// Export helpers shared by the results viewer and the manager page (ES module, no DOM needed for formatting).

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?(\d+([.,]\d+)*|\d*[.,]\d+)(e[-+]?\d+)?%?$/i;

/** Prefixes values that a spreadsheet would treat as a formula (CSV injection protection). */
export function guardFormula(v) {
  const s = String(v ?? '');
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? "'" + s : s;
}

export function toCSV(headers, rows, { delimiter = ',', eol = '\r\n', guard = false } = {}) {
  const needs = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : delimiter}]|^\\s|\\s$`);
  const cell = (v) => {
    let s = String(v ?? '');
    if (guard) s = guardFormula(s);
    return needs.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(delimiter)).join(eol) + eol;
}

/** Tab-separated text for pasting into Google Sheets or Excel: tabs and line breaks are flattened. */
export function toTSV(headers, rows, { guard = false } = {}) {
  const cell = (v) => {
    let s = String(v ?? '').replace(/[\t\r\n]+/g, ' ');
    if (guard) s = guardFormula(s);
    return s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join('\t')).join('\n');
}

export function toJSON(headers, rows) {
  const keys = headers.map((h, i) => (h && String(h).trim()) || `Column ${i + 1}`);
  return JSON.stringify(rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? '']))), null, 2);
}

/** Excel opens UTF-8 CSV correctly only with a byte order mark. */
export function excelCSV(headers, rows) {
  return '﻿' + toCSV(headers, rows, { delimiter: ',', eol: '\r\n', guard: true });
}

export function safeFileName(s, fallback = 'scrape') {
  const base = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || fallback;
}

export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Parses "$1,234.50", "12%", "-3.2" into numbers; returns NaN for non-numeric text. */
export function numericValue(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 40) return NaN;
  const m = s.replace(/^[^\d+\-.]{0,4}/, '').replace(/[^\d.]{0,4}$/, '');
  if (!/^[-+]?[\d,]*\.?\d+$/.test(m)) return NaN;
  return parseFloat(m.replace(/,/g, ''));
}

export function compareValues(a, b) {
  const na = numericValue(a); const nb = numericValue(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!a && b) return 1;
  if (a && !b) return -1;
  return collator.compare(String(a), String(b));
}
