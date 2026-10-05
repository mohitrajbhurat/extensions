// Small RFC 4180 CSV parser / writer with delimiter detection.

export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  let best = ',', max = 0;
  for (const [d, c] of Object.entries(counts)) if (c > max) { best = d; max = c; }
  return best;
}

export function parseCSV(text, delimiter) {
  text = String(text || '').replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQ = true; i++; continue; }
    if (ch === d) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h, idx) => h.trim() || `col${idx + 1}`);
  const objs = nonEmpty.slice(1).map(r => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : ''; });
    return o;
  });
  return { headers, rows: objs };
}

function esc(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(rows, headers) {
  if (!headers) {
    headers = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
  }
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
  return lines.join('\r\n');
}
