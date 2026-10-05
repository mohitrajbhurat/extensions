// Exporters: Markdown (with timestamp links) and a self-contained printable HTML page.
import './defaults.js';
import { renderMarkdown, escapeHtml } from './markdown.js';

const VS = globalThis.VS;

export function safeFilename(name, ext) {
  const base = String(name || 'video-notes').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video-notes';
  return `${base}.${ext}`;
}

export function downloadFile(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Markdown export. Timestamps become links that open the video at that moment.
export function buildMarkdown(video, notes, opts = {}) {
  const title = video.title || 'Untitled video';
  const out = [`# ${title}`, ''];
  if (video.url) out.push(`Source: <${video.url}>  `);
  if (video.duration) out.push(`Length: ${VS.formatTime(video.duration)}  `);
  out.push(`Exported from Video Studio on ${today()}`, '');
  const marks = (video.bookmarks || []).slice().sort((a, b) => a.t - b.t);
  if (marks.length) {
    out.push('## Chapters', '');
    for (const b of marks) {
      const link = VS.timeLink(video, b.t);
      const ts = VS.formatTime(b.t);
      out.push(`- ${link ? `[${ts}](${link})` : ts} ${b.label || 'Bookmark'}`);
    }
    out.push('');
  }
  out.push('## Notes', '');
  if (!notes.length) out.push('_No notes yet._', '');
  for (const n of notes) {
    const link = VS.timeLink(video, n.t);
    const ts = VS.formatTime(n.t);
    out.push(`### ${link ? `[${ts}](${link})` : ts}`, '');
    if (n.text && n.text.trim()) out.push(n.text.trim(), '');
    if (n.image) {
      if (opts.embedImages) out.push(`![Frame at ${ts}](${n.image})`, '');
      else out.push(`_Screenshot at ${ts} (included in the HTML export)._`, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Plain chapter list in the format YouTube descriptions use.
export function buildChapterList(video) {
  const marks = (video.bookmarks || []).slice().sort((a, b) => a.t - b.t);
  return marks.map((b) => `${VS.formatTime(b.t)} ${b.label || 'Bookmark'}`).join('\n');
}

// A standalone, printable HTML document (screenshots embedded as data URLs).
export function buildHtml(video, notes) {
  const title = video.title || 'Untitled video';
  const linkFor = (t) => VS.timeLink(video, t);
  const tsLink = (t) => {
    const href = linkFor(t);
    const label = VS.formatTime(t);
    return href ? `<a class="ts" href="${escapeHtml(href)}">${label}</a>` : `<span class="ts">${label}</span>`;
  };
  const marks = (video.bookmarks || []).slice().sort((a, b) => a.t - b.t);
  const body = notes.map((n) => {
    // Rewrite in-note timestamps into real links for the exported page.
    let html = renderMarkdown(n.text || '');
    html = html.replace(/<a href="#" class="ts" data-t="(\d+)">([^<]+)<\/a>/g, (_, s, label) => {
      const href = linkFor(Number(s));
      return href ? `<a class="ts-inline" href="${escapeHtml(href)}">${label}</a>` : label;
    });
    return `<article class="note">
  <div class="stamp">${tsLink(n.t)}</div>
  <div class="content">${html || ''}${n.image ? `<figure><img src="${n.image}" alt="Frame at ${VS.formatTime(n.t)}"><figcaption>Frame at ${VS.formatTime(n.t)}</figcaption></figure>` : ''}</div>
</article>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<title>${escapeHtml(title)} - notes</title>
<style>
  :root { --fg:#1d2433; --muted:#5b6578; --line:#e3e6ee; --accent:#d9480f; --bg:#fff; --soft:#f6f7fa; }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); margin: 0; }
  main { max-width: 820px; margin: 0 auto; padding: 40px 24px 64px; }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 8px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  .meta a { color: inherit; }
  h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .chapters { list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 32px; }
  .chapters li { break-inside: avoid; padding: 2px 0; }
  .note { display: grid; grid-template-columns: 80px 1fr; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--line); break-inside: avoid; }
  .stamp a, .stamp span, .chapters a { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); text-decoration: none; }
  .content > :first-child { margin-top: 0; }
  .content p { margin: 0 0 8px; }
  .content img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); display: block; }
  figure { margin: 8px 0 0; }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  code { background: var(--soft); padding: 1px 4px; border-radius: 4px; font-size: 0.92em; }
  pre { background: var(--soft); padding: 12px; border-radius: 8px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0 0 8px; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
  a.ts-inline { color: var(--accent); }
  .empty { color: var(--muted); font-style: italic; }
  @media print {
    main { padding: 0; max-width: none; }
    a { color: inherit !important; }
    .note { grid-template-columns: 64px 1fr; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${video.site ? escapeHtml(video.site) + ' &middot; ' : ''}${video.url ? `<a href="${escapeHtml(video.url)}">${escapeHtml(video.url)}</a> &middot; ` : ''}${notes.length} note${notes.length === 1 ? '' : 's'} &middot; exported ${today()}</div>
  ${marks.length ? `<h2>Chapters</h2><ul class="chapters">${marks.map((b) => `<li>${tsLink(b.t)} ${escapeHtml(b.label || 'Bookmark')}</li>`).join('')}</ul>` : ''}
  <h2>Notes</h2>
  ${body || '<p class="empty">No notes yet.</p>'}
</main>
</body>
</html>`;
}
