// Small, safe Markdown renderer (HTML is escaped first) with [[wikilink]] support,
// plus helpers that turn projects and clips into Markdown for export.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const WIKILINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

/** Return the distinct link targets ([[Target]] or [[Target|alias]]) in a text. */
export function extractWikilinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(WIKILINK_RE)) {
    const t = m[1].trim();
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

function safeUrl(u) {
  const s = String(u).trim();
  if (/^(https?:|mailto:|#)/i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  return null;
}

function inline(text, opts) {
  // Protect code spans first.
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  const html = [];
  const stash = h => { html.push(h); return `\u0001${html.length - 1}\u0001`; };
  // Images ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, src) => {
    const u = safeUrl(unescapeHtml(src));
    return u ? stash(`<img src="${escapeHtml(u)}" alt="${alt}" loading="lazy">`) : m;
  });
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const u = safeUrl(unescapeHtml(href));
    return u ? stash(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m;
  });
  // Wikilinks [[Target]] / [[Target|alias]]
  s = s.replace(/\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g, (m, target, alias) => {
    const t = target.trim();
    const exists = opts.wikiExists ? opts.wikiExists(unescapeHtml(t)) : true;
    return stash(`<a href="#" class="wikilink${exists ? '' : ' missing'}" data-wikilink="${t}">${alias ? alias.trim() : t}</a>`);
  });
  // Bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0001]+[^\s<.,;:!?)\]'"\u0001])/g, (m, pre, url) =>
    pre + stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => html[+i]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

function unescapeHtml(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
}

/**
 * Render Markdown to HTML.
 * opts.wikiExists(title) -> boolean marks missing wikilinks.
 */
export function renderMarkdown(src, opts = {}) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const listStack = []; // 'ul' | 'ol'
  const closeLists = () => { while (listStack.length) out.push(`</${listStack.pop()}>`); };
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(l => inline(l, opts)).join('<br>')}</p>`); para = []; }
  };

  // Strip YAML front matter.
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }

  while (i < lines.length) {
    const line = lines[i];
    // Fenced code
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushPara(); closeLists();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); closeLists(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushPara(); closeLists();
      out.push(`<h${h[1].length}>${inline(h[2], opts)}</h${h[1].length}>`);
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeLists(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      flushPara(); closeLists();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const kind = /\d/.test(li[2]) ? 'ol' : 'ul';
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2);
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length === depth + 1 && listStack[depth] !== kind) out.push(`</${listStack.pop()}>`);
      while (listStack.length < depth + 1) { listStack.push(kind); out.push(`<${kind}>`); }
      let body = li[3];
      const task = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        out.push(`<li class="task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2], opts)}</li>`);
      } else {
        out.push(`<li>${inline(body, opts)}</li>`);
      }
      i++; continue;
    }
    // Simple tables
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara(); closeLists();
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c, opts)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c, opts)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    closeLists();
    para.push(line);
    i++;
  }
  flushPara(); closeLists();
  return out.join('\n');
}

// ---------- export helpers ----------
export function safeFilename(name, fallback = 'untitled') {
  const s = String(name || '').replace(/[\\/:*?"<>|#^\[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return s || fallback;
}

function iso(ts) {
  try { return new Date(ts).toISOString(); } catch { return ''; }
}

function yamlStr(s) {
  return JSON.stringify(String(s ?? ''));
}

export function noteTitle(clip) {
  return clip.title || firstLine(clip.content) || 'Untitled note';
}

export function firstLine(s) {
  return String(s || '').split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
}

/** A single note as a standalone Markdown file with YAML front matter (Obsidian-friendly). */
export function noteToMarkdown(clip, project) {
  const fm = ['---', `title: ${yamlStr(noteTitle(clip))}`];
  if (project) fm.push(`project: ${yamlStr(project.name)}`);
  if (clip.tags && clip.tags.length) fm.push(`tags: [${clip.tags.map(yamlStr).join(', ')}]`);
  if (clip.url) fm.push(`source: ${yamlStr(clip.url)}`);
  fm.push(`created: ${iso(clip.createdAt)}`, `updated: ${iso(clip.updatedAt)}`, '---', '');
  const body = clip.content || '';
  const hasHeading = /^#\s/.test(body.trim());
  return fm.join('\n') + (hasHeading ? '' : `# ${noteTitle(clip)}\n\n`) + body.trim() + '\n';
}

/** One clip (any type) as a Markdown block. */
export function clipToMarkdown(clip, { headingLevel = 3 } = {}) {
  const hx = '#'.repeat(headingLevel);
  const src = clip.url ? `[${(clip.pageTitle || clip.url).replace(/[\[\]]/g, '')}](${clip.url})` : '';
  const meta = [];
  if (src) meta.push(`Source: ${src}`);
  meta.push(`Clipped: ${new Date(clip.createdAt).toLocaleString()}`);
  if (clip.tags && clip.tags.length) meta.push('Tags: ' + clip.tags.map(t => '#' + t).join(' '));
  let body = '';
  switch (clip.type) {
    case 'highlight':
    case 'text':
      body = String(clip.content || '').split('\n').map(l => '> ' + l).join('\n');
      if (clip.type === 'highlight' && clip.color) body = `${body}\n\n_Highlight: ${clip.color}_`;
      break;
    case 'image':
      body = `![${(clip.title || 'image').replace(/[\[\]]/g, '')}](${clip.content})`;
      break;
    case 'link':
      body = `[${(clip.title || clip.content).replace(/[\[\]]/g, '')}](${clip.content})`;
      break;
    case 'page':
      body = `[${(clip.title || clip.url).replace(/[\[\]]/g, '')}](${clip.url || clip.content})` + (clip.content && clip.content !== clip.url ? `\n\n${clip.content}` : '');
      break;
    case 'note':
      return `${hx} ${noteTitle(clip)}\n\n${String(clip.content || '').trim()}\n\n${meta.join('  \n')}\n`;
  }
  const title = clip.title || (clip.type === 'highlight' ? 'Highlight' : clip.type[0].toUpperCase() + clip.type.slice(1));
  let s = `${hx} ${title}\n\n${body}\n`;
  if (clip.comment) s += `\n**Comment:** ${clip.comment}\n`;
  s += `\n${meta.join('  \n')}\n`;
  return s;
}

export function projectToMarkdown(project, clips) {
  const notes = clips.filter(c => c.type === 'note');
  const others = clips.filter(c => c.type !== 'note');
  let s = `# ${project.name}\n\n_Exported from Research Canvas on ${new Date().toLocaleString()}. ${clips.length} item${clips.length === 1 ? '' : 's'}._\n\n`;
  if (others.length) s += `## Clips\n\n` + others.map(c => clipToMarkdown(c)).join('\n---\n\n') + '\n';
  if (notes.length) s += `## Notes\n\n` + notes.map(c => clipToMarkdown(c)).join('\n---\n\n') + '\n';
  return s;
}

/** Highlights + stickies of an annotated page as Markdown. */
export function pageToMarkdown(page) {
  let s = `## [${(page.title || page.url).replace(/[\[\]]/g, '')}](${page.url})\n\n`;
  for (const h of page.highlights) {
    s += `> ${h.quote.exact.replace(/\n/g, '\n> ')}\n`;
    if (h.comment) s += `\n${h.comment}\n`;
    s += '\n';
  }
  for (const n of page.stickies) if (n.text) s += `**Sticky note:** ${n.text.replace(/\n/g, '  \n')}\n\n`;
  return s;
}
