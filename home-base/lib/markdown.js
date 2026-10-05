// Small, safe Markdown renderer for the notes scratchpad. Everything is HTML-escaped first;
// only the tags generated here reach the page. Links are limited to http(s) and mailto.
// Supports: headings, paragraphs, bold, italic, strike, inline code, fenced code, block
// quotes, ordered/unordered lists, task lists (with data-line for toggling), rules, links.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeUrl(url) {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^www\./i.test(u)) return 'https://' + u;
  return null;
}

export function inline(src) {
  // Protect inline code spans first.
  const codes = [];
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  // [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'));
    return u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${text}</a>` : m;
  });
  // bare URLs (not already inside an href)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, (_, pre, a) => `${pre}<em>${a}</em>`);
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, (_, pre, a) => `${pre}<em>${a}</em>`);
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

/** Render Markdown to an HTML string. */
export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
  };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) {
        const raw = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        const task = raw.match(/^\[([ xX])\]\s*(.*)$/);
        if (task) {
          const checked = task[1] !== ' ';
          items.push(`<li class="md-task"><label><input type="checkbox" data-line="${i}"${checked ? ' checked' : ''}> <span>${inline(task[2])}</span></label></li>`);
        } else {
          items.push(`<li>${inline(raw)}</li>`);
        }
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join('\n');
}

/** Toggle the task-list checkbox on a given source line. */
export function toggleTaskLine(md, lineNo) {
  const lines = String(md).split('\n');
  const l = lines[lineNo];
  if (l == null) return md;
  lines[lineNo] = l.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/, (_, pre, c) => `${pre}[${c === ' ' ? 'x' : ' '}]`);
  return lines.join('\n');
}
