// Accessibility Auditor - report exporters (JSON, CSV, standalone HTML).

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function sortIssues(issues) {
  return issues.slice().sort((a, b) =>
    (a.kind === 'review') - (b.kind === 'review') ||
    IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) ||
    a.rule.localeCompare(b.rule));
}

export function toJSON(report) {
  const out = {
    tool: 'Accessibility Auditor',
    standard: 'WCAG 2.2',
    url: report.url,
    title: report.title,
    scannedAt: report.scannedAt,
    settings: report.settings,
    counts: report.counts,
    frames: report.frames,
    rules: report.rules,
    passedRules: report.passed,
    issues: sortIssues(report.issues).map((i) => ({
      rule: i.rule, kind: i.kind, impact: i.impact, message: i.message, selector: i.selector,
      snippet: i.snippet, frameUrl: i.frameUrl, data: i.data || undefined,
      wcag: ((report.rules[i.rule] || {}).wcag || []).map((w) => w.sc),
    })),
    outline: {
      headings: report.outline.headings.map((h) => ({ level: h.level, text: h.text, skipped: h.skipped, frameId: h.frameId })),
      landmarks: report.outline.landmarks.map((l) => ({ role: l.role, name: l.name, depth: l.depth, frameId: l.frameId })),
    },
  };
  return JSON.stringify(out, null, 2);
}

export function toCSV(report) {
  const head = ['Impact', 'Type', 'Rule', 'Title', 'WCAG', 'Level', 'Message', 'Selector', 'Snippet', 'Frame URL', 'Page URL'];
  const rows = [head];
  for (const i of sortIssues(report.issues)) {
    const r = report.rules[i.rule] || {};
    rows.push([
      i.impact, i.kind === 'review' ? 'Needs review' : 'Violation', i.rule, r.title || '',
      (r.wcag || []).map((w) => w.sc).join(' '), r.level || '', i.message, i.selector, i.snippet,
      i.frameUrl || '', report.url,
    ]);
  }
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function toHTML(report) {
  const c = report.counts;
  const groups = new Map();
  for (const i of sortIssues(report.issues)) {
    if (!groups.has(i.rule)) groups.set(i.rule, []);
    groups.get(i.rule).push(i);
  }
  const ruleSections = Array.from(groups.entries()).map(([id, list]) => {
    const r = report.rules[id] || { title: id, wcag: [] };
    const reviewOnly = list.every((i) => i.kind === 'review');
    const impact = list[0].impact;
    const wcag = (r.wcag || []).map((w) => `<a href="${esc(w.url)}">${esc(w.sc)} ${esc(w.name)} (${esc(w.level)})</a>`).join(', ');
    const items = list.map((i) => `
        <li>
          <p>${i.kind === 'review' ? '<span class="pill review">Needs review</span> ' : ''}${esc(i.message)}</p>
          <p class="sel"><code>${esc(i.selector)}</code>${i.frameId ? ` <span class="muted">in frame ${esc(i.frameUrl)}</span>` : ''}</p>
          <pre><code>${esc(i.snippet)}</code></pre>
        </li>`).join('');
    return `
    <section class="rule">
      <h3><span class="pill ${reviewOnly ? 'review' : esc(impact)}">${reviewOnly ? 'review' : esc(impact)}</span> ${esc(r.title)} <span class="muted">(${list.length})</span></h3>
      <p class="muted"><code>${esc(id)}</code> · ${esc(r.level === 'best-practice' ? 'Best practice' : 'Level ' + r.level)}${wcag ? ' · ' + wcag : ''}</p>
      <p>${esc(r.description)}</p>
      <p><strong>How to fix:</strong> ${esc(r.fix)}</p>
      <ol class="nodes">${items}</ol>
    </section>`;
  }).join('');
  const passed = (report.passed || []).map((id) => `<li>${esc((report.rules[id] || {}).title || id)} <span class="muted">(${esc(id)})</span></li>`).join('');
  const headings = report.outline.headings.map((h) => `<li style="margin-left:${(h.level - 1) * 16}px"><span class="pill ${h.skipped ? 'critical' : 'minor'}">H${h.level}</span> ${esc(h.text) || '<em>(empty)</em>'}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility report: ${esc(report.title || report.url)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1d21; --muted:#5d6470; --bg:#fff; --card:#f5f6f8; --line:#d9dce1; --link:#0b57d0; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaed; --muted:#a3a9b3; --bg:#16181c; --card:#20232a; --line:#353a44; --link:#8ab4f8; } }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 32px; max-width: 1100px; margin-inline: auto; }
  a { color: var(--link); }
  h1 { font-size: 24px; margin: 0 0 8px; }
  .muted { color: var(--muted); }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 24px; padding: 0; list-style: none; }
  .summary li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 16px; }
  .summary strong { display: block; font-size: 22px; }
  .rule { border: 1px solid var(--line); border-radius: 12px; padding: 16px 24px; margin: 16px 0; background: var(--card); }
  .rule h3 { margin: 0 0 4px; font-size: 17px; }
  .nodes li { margin: 8px 0; border-top: 1px solid var(--line); padding-top: 8px; }
  .nodes p { margin: 4px 0; }
  pre { white-space: pre-wrap; word-break: break-all; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin: 4px 0; font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .pill { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; border-radius: 999px; padding: 1px 8px; color: #fff; background: #555; vertical-align: middle; }
  .pill.critical { background: #b71c1c; } .pill.serious { background: #bf360c; } .pill.moderate { background: #7a5c00; } .pill.minor { background: #0d47a1; } .pill.review { background: #6a1b9a; }
  ul.plain { list-style: none; padding: 0; }
</style>
</head>
<body>
<header>
  <h1>Accessibility report</h1>
  <p><a href="${esc(report.url)}">${esc(report.title || report.url)}</a></p>
  <p class="muted">Scanned ${esc(new Date(report.scannedAt).toLocaleString())} with Accessibility Auditor against WCAG 2.2${report.settings.includeAAA ? ' (A, AA and AAA)' : ' (A and AA)'}${report.settings.includeBestPractice ? ' plus best practices' : ''}. Automated checks find only part of all accessibility problems; test with a keyboard and a screen reader too.</p>
</header>
<main>
  <h2>Summary</h2>
  <ul class="summary">
    <li><strong>${c.violations}</strong>Violations</li>
    <li><strong>${c.critical}</strong>Critical</li>
    <li><strong>${c.serious}</strong>Serious</li>
    <li><strong>${c.moderate}</strong>Moderate</li>
    <li><strong>${c.minor}</strong>Minor</li>
    <li><strong>${c.review}</strong>Needs review</li>
    <li><strong>${(report.passed || []).length}</strong>Rules passed</li>
  </ul>
  <h2>Issues by rule</h2>
  ${ruleSections || '<p>No issues found by the automated rules.</p>'}
  <h2>Heading outline</h2>
  ${headings ? `<ul class="plain">${headings}</ul>` : '<p>No headings.</p>'}
  <h2>Rules passed</h2>
  <ul>${passed}</ul>
</main>
</body>
</html>
`;
}

export function fileName(report, ext) {
  let host = 'page';
  try {
    host = new URL(report.url).hostname.replace(/^www\./, '') || 'page';
  } catch (e) { /* keep default */ }
  const d = new Date(report.scannedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `a11y-report-${host.replace(/[^\w.-]+/g, '_')}-${stamp}.${ext}`;
}

export function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
