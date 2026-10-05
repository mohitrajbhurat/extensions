// Small, safe Markdown renderer for notes. All text is HTML-escaped first; only a fixed
// set of constructs is turned into markup. Timestamps such as 12:34 or 1:02:03 become
// <a class="ts" data-t="seconds"> links that the UI turns into seek actions.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeUrl(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  return null;
}

const TS_RE = /(^|[^\w:/.])((?:\d{1,2}:)?\d{1,2}:[0-5]\d)(?![\w:])/g;

function tsSeconds(str) {
  const parts = str.split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Inline formatting on raw (unescaped) text.
function inline(src, opts) {
  // Protect code spans and links by tokenising first.
  const tokens = [];
  const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let s = String(src);
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/!\[([^\]]*)\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)\)/g,
    (_, alt, url) => stash(`<img alt="${escapeHtml(alt)}" src="${url}">`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const safe = safeUrl(url);
    if (!safe) return m;
    return stash(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`);
  });
  s = s.replace(/\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g, (url) =>
    stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`));
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  if (opts.timestamps !== false) {
    s = s.replace(TS_RE, (m, pre, ts) => `${pre}<a href="#" class="ts" data-t="${tsSeconds(ts)}">${ts}</a>`);
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
  return s;
}

export function renderMarkdown(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*```\s*([\w+-]*)\s*$/))) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[1] ? ` data-lang="${escapeHtml(m[1])}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      const level = Math.min(6, m[1].length + 2); // notes are nested in a page; start at h3
      out.push(`<h${level}>${inline(m[2], opts)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) text += '\n' + lines[i++].trim();
        const task = text.match(/^\[([ xX])\]\s+(.*)$/s);
        if (task) {
          items.push(`<li class="task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${task[2].split('\n').map((l) => inline(l, opts)).join('<br>')}</li>`);
        } else {
          items.push(`<li>${text.split('\n').map((l) => inline(l, opts)).join('<br>')}</li>`);
        }
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

// Plain-text preview (for list snippets and search).
export function plainText(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
