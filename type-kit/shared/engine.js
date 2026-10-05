/* Type Kit expansion engine: placeholder parsing, date math, fuzzy search, shortcut matching.
 * Pure logic, no DOM and no chrome.* calls, so it can run in the service worker,
 * extension pages and content scripts alike.
 */
(function (root) {
  'use strict';

  const CURSOR_MARK = '\u0001';           // internal marker for {cursor}
  const MAX_NEST_DEPTH = 6;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function pad(n, w) { return String(Math.abs(n)).padStart(w || 2, '0'); }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /** Format a Date with a moment-like token string. */
  function formatDate(date, fmt) {
    const d = date instanceof Date ? date : new Date(date);
    const h12 = d.getHours() % 12 || 12;
    const tokens = {
      YYYY: () => String(d.getFullYear()),
      YY: () => pad(d.getFullYear() % 100),
      MMMM: () => MONTHS[d.getMonth()],
      MMM: () => MONTHS[d.getMonth()].slice(0, 3),
      MM: () => pad(d.getMonth() + 1),
      M: () => String(d.getMonth() + 1),
      dddd: () => DAYS[d.getDay()],
      ddd: () => DAYS[d.getDay()].slice(0, 3),
      Do: () => ordinal(d.getDate()),
      DD: () => pad(d.getDate()),
      D: () => String(d.getDate()),
      HH: () => pad(d.getHours()),
      H: () => String(d.getHours()),
      hh: () => pad(h12),
      h: () => String(h12),
      mm: () => pad(d.getMinutes()),
      m: () => String(d.getMinutes()),
      ss: () => pad(d.getSeconds()),
      s: () => String(d.getSeconds()),
      A: () => (d.getHours() < 12 ? 'AM' : 'PM'),
      a: () => (d.getHours() < 12 ? 'am' : 'pm'),
      WW: () => pad(isoWeek(d)),
      X: () => String(Math.floor(d.getTime() / 1000)),
    };
    const re = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|Do|DD|D|HH|H|hh|h|mm|m|ss|s|A|a|WW|X/g;
    return String(fmt).replace(re, (match, literal) => (literal !== undefined ? literal : tokens[match]()));
  }

  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - start) / 86400000 + 1) / 7);
  }

  /** Apply one or more offsets like "+3d", "-2w", "+1M-1d", "+90m". */
  function applyOffset(date, spec) {
    const d = new Date(date.getTime());
    const re = /([+-])\s*(\d+)\s*([a-zA-Z]+)/g;
    let m;
    while ((m = re.exec(String(spec)))) {
      const sign = m[1] === '-' ? -1 : 1;
      const n = sign * parseInt(m[2], 10);
      const unit = m[3];
      switch (unit) {
        case 'y': case 'Y': case 'yr': case 'year': case 'years': d.setFullYear(d.getFullYear() + n); break;
        case 'M': case 'mo': case 'mon': case 'month': case 'months': d.setMonth(d.getMonth() + n); break;
        case 'w': case 'W': case 'week': case 'weeks': d.setDate(d.getDate() + n * 7); break;
        case 'd': case 'D': case 'day': case 'days': d.setDate(d.getDate() + n); break;
        case 'h': case 'H': case 'hr': case 'hour': case 'hours': d.setHours(d.getHours() + n); break;
        case 'm': case 'min': case 'minute': case 'minutes': d.setMinutes(d.getMinutes() + n); break;
        case 's': case 'sec': case 'second': case 'seconds': d.setSeconds(d.getSeconds() + n); break;
        default: break;
      }
    }
    return d;
  }

  function isOffset(part) { return /^[+-]\s*\d+\s*[a-zA-Z]+/.test(String(part).trim()); }

  /** Split a placeholder body on ":" keeping the remainder intact (so HH:mm survives). */
  function splitPlaceholder(body) {
    const parts = String(body).split(':');
    const name = parts.shift().trim().toLowerCase();
    return { name, rest: parts };
  }

  /** Tokenize a template into literal and placeholder tokens. */
  function scan(template) {
    const out = [];
    const src = String(template == null ? '' : template);
    let i = 0, lit = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{' && src[i + 1] === '{') { lit += '{'; i += 2; continue; }
      if (ch === '}' && src[i + 1] === '}') { lit += '}'; i += 2; continue; }
      if (ch === '{') {
        const end = src.indexOf('}', i + 1);
        if (end === -1) { lit += src.slice(i); i = src.length; break; }
        const body = src.slice(i + 1, end);
        if (/^[a-zA-Z]/.test(body)) {
          if (lit) { out.push({ type: 'text', value: lit }); lit = ''; }
          const { name, rest } = splitPlaceholder(body);
          out.push({ type: 'placeholder', name, rest, raw: src.slice(i, end + 1) });
          i = end + 1;
          continue;
        }
        lit += ch; i++; continue;
      }
      lit += ch; i++;
    }
    if (lit) out.push({ type: 'text', value: lit });
    return out;
  }

  /** Field definition from an {input:...} or {select:...} placeholder, or null. */
  function fieldFromToken(tok) {
    if (tok.type !== 'placeholder') return null;
    if (tok.name === 'input' || tok.name === 'text' || tok.name === 'field') {
      const label = (tok.rest[0] || 'Value').trim() || 'Value';
      const rest = tok.rest.slice(1).join(':');
      const multiline = /^multiline$/i.test(rest.trim()) || /\bmultiline\b/i.test(rest);
      return {
        type: 'input', key: label.toLowerCase(), label,
        default: multiline ? rest.replace(/multiline/i, '').replace(/^[,\s]+/, '') : rest,
        multiline,
      };
    }
    if (tok.name === 'select' || tok.name === 'choice' || tok.name === 'menu') {
      let label = 'Choose', optionSrc;
      if (tok.rest.length > 1 && !tok.rest[0].includes('|')) {
        label = (tok.rest[0] || 'Choose').trim() || 'Choose';
        optionSrc = tok.rest.slice(1).join(':');
      } else {
        optionSrc = tok.rest.join(':');
      }
      const options = String(optionSrc).split('|').map((o) => o.trim()).filter((o) => o !== '');
      return {
        type: 'select', key: label.toLowerCase(), label,
        options: options.length ? options : ['Yes', 'No'],
        default: options[0] || '',
      };
    }
    return null;
  }

  function snippetByShortcut(ctx, shortcut) {
    const key = String(shortcut || '').trim();
    if (!key) return null;
    const list = ctx.snippets || [];
    const ci = key.toLowerCase();
    return list.find((s) => s.shortcut === key) ||
      list.find((s) => (s.shortcut || '').toLowerCase() === ci) ||
      list.find((s) => (s.name || '').toLowerCase() === ci) || null;
  }

  /** All fill-in fields a snippet needs, following nested {snippet:/x} references. */
  function collectFields(body, ctx, depth, seen, fields) {
    fields = fields || [];
    seen = seen || new Set();
    depth = depth || 0;
    if (depth > MAX_NEST_DEPTH) return fields;
    for (const tok of scan(body)) {
      const f = fieldFromToken(tok);
      if (f) {
        const existing = fields.find((x) => x.key === f.key);
        if (!existing) fields.push(f);
        else if (!existing.default && f.default) existing.default = f.default;
      } else if (tok.type === 'placeholder' && (tok.name === 'snippet' || tok.name === 's')) {
        const child = snippetByShortcut(ctx, tok.rest.join(':'));
        if (child && !seen.has(child.id)) {
          seen.add(child.id);
          collectFields(child.body, ctx, depth + 1, seen, fields);
        }
      }
    }
    return fields;
  }

  function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function textToHTML(s) {
    return escapeHTML(s).replace(/\r\n|\r|\n/g, '<br>');
  }

  function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<\s*br\s*\/?>/gi, '\n');
    s = s.replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n');
    s = s.replace(/<\s*li[^>]*>/gi, '• ');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    return s.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }

  const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'BR', 'P', 'DIV', 'SPAN',
    'UL', 'OL', 'LI', 'CODE', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'SMALL', 'SUB', 'SUP']);
  const ALLOWED_ATTRS = { A: ['href', 'title'], SPAN: ['style'], P: ['style'], DIV: ['style'], LI: ['style'] };
  const SAFE_STYLE = /^(color|background-color|font-weight|font-style|text-decoration|font-size|text-align)\s*:/i;

  /** Clean user-authored rich snippet HTML before it is inserted into a page. */
  function sanitizeHTML(html, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return escapeHTML(htmlToText(html));
    const tpl = d.createElement('div');
    tpl.innerHTML = String(html);
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1) { child.remove(); continue; }
        const tag = child.tagName.toUpperCase();
        if (!ALLOWED_TAGS.has(tag)) {
          const frag = d.createDocumentFragment();
          while (child.firstChild) frag.appendChild(child.firstChild);
          child.replaceWith(frag);
          continue;
        }
        const allowed = ALLOWED_ATTRS[tag] || [];
        for (const attr of Array.from(child.attributes)) {
          const n = attr.name.toLowerCase();
          if (!allowed.includes(n)) { child.removeAttribute(attr.name); continue; }
          if (n === 'href' && !/^(https?:|mailto:|tel:)/i.test(attr.value.trim())) child.removeAttribute(attr.name);
          if (n === 'style') {
            const keep = attr.value.split(';').map((p) => p.trim()).filter((p) => p && SAFE_STYLE.test(p));
            if (keep.length) child.setAttribute('style', keep.join('; ')); else child.removeAttribute('style');
          }
        }
        walk(child);
      }
    };
    walk(tpl);
    return tpl.innerHTML;
  }

  /**
   * Render a snippet body.
   * ctx: { snippets, clips, values, now, settings, rich, doc }
   * Returns { text, cursor, missingFields }
   */
  function render(body, ctx, depth, seen) {
    ctx = ctx || {};
    depth = depth || 0;
    seen = seen || new Set();
    const settings = ctx.settings || {};
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const values = ctx.values || {};
    const clips = ctx.clips || [];
    const rich = !!ctx.rich;
    const missing = [];
    let out = '';

    const emit = (plain) => { out += rich ? textToHTML(plain) : plain; };

    for (const tok of scan(body)) {
      if (tok.type === 'text') { out += tok.value; continue; }
      const { name, rest } = tok;

      if (name === 'date' || name === 'time' || name === 'datetime') {
        let offset = '', fmt = '';
        if (rest.length && isOffset(rest[0])) { offset = rest[0]; fmt = rest.slice(1).join(':'); }
        else fmt = rest.join(':');
        fmt = fmt.trim();
        if (!fmt) {
          fmt = name === 'time' ? (settings.timeFormat || 'HH:mm')
            : name === 'datetime' ? ((settings.dateFormat || 'YYYY-MM-DD') + ' ' + (settings.timeFormat || 'HH:mm'))
              : (settings.dateFormat || 'YYYY-MM-DD');
        }
        emit(formatDate(applyOffset(now, offset), fmt));
        continue;
      }

      if (name === 'cursor' || name === 'caret') { out += CURSOR_MARK; continue; }

      if (name === 'clipboard' || name === 'clip' || name === 'paste') {
        const n = Math.max(1, parseInt(rest[0], 10) || 1);
        const clip = clips[n - 1];
        emit(clip ? clip.text : '');
        continue;
      }

      if (name === 'snippet' || name === 's') {
        const child = snippetByShortcut(ctx, rest.join(':'));
        if (!child) { out += rich ? textToHTML(tok.raw) : tok.raw; continue; }
        if (seen.has(child.id) || depth >= MAX_NEST_DEPTH) continue;
        const nextSeen = new Set(seen); nextSeen.add(child.id);
        const childRich = child.format === 'rich';
        const sub = render(child.body, Object.assign({}, ctx, { rich: childRich }), depth + 1, nextSeen);
        for (const f of sub.missingFields || []) missing.push(f);
        let piece = sub.text;
        if (rich && !childRich) piece = textToHTML(piece);
        else if (!rich && childRich) piece = htmlToText(piece);
        out += piece;
        continue;
      }

      const field = fieldFromToken(tok);
      if (field) {
        const has = Object.prototype.hasOwnProperty.call(values, field.key);
        const val = has ? values[field.key] : field.default;
        if (!has) missing.push(field);
        emit(val == null ? '' : String(val));
        continue;
      }

      if (name === 'url' || name === 'page') { emit(ctx.pageUrl || ''); continue; }
      if (name === 'title') { emit(ctx.pageTitle || ''); continue; }
      if (name === 'host' || name === 'site') { emit(ctx.pageHost || ''); continue; }
      if (name === 'uuid') {
        emit(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
        continue;
      }
      if (name === 'random') {
        const lo = parseInt(rest[0], 10), hi = parseInt(rest[1], 10);
        const a = Number.isFinite(lo) ? lo : 1, b = Number.isFinite(hi) ? hi : 100;
        emit(String(a + Math.floor(Math.random() * (Math.max(a, b) - Math.min(a, b) + 1))));
        continue;
      }

      out += rich ? textToHTML(tok.raw) : tok.raw;     // unknown placeholder: leave as typed
    }

    const cursor = out.indexOf(CURSOR_MARK);
    const text = out.split(CURSOR_MARK).join('');
    return { text, cursor: cursor === -1 ? -1 : cursor, missingFields: missing };
  }

  /** Preview helper: fills fields with their defaults. */
  function preview(snippet, ctx) {
    const fields = collectFields(snippet.body, ctx || {});
    const values = {};
    for (const f of fields) values[f.key] = f.default || ('‹' + f.label + '›');
    const r = render(snippet.body, Object.assign({ rich: snippet.format === 'rich' }, ctx, { values }));
    return snippet.format === 'rich' ? htmlToText(r.text) : r.text;
  }

  /* ---------- shortcut matching ---------- */

  const WORD = /[A-Za-z0-9_]/;

  /**
   * Find a snippet whose shortcut ends at the caret.
   * opts: { force } ignores the "a longer shortcut could still be typed" delay.
   * Returns { snippet, start, end, shortcut, trailing } or null.
   */
  function findShortcut(textBeforeCaret, snippets, settings, opts) {
    settings = settings || {};
    opts = opts || {};
    const text = String(textBeforeCaret || '');
    if (!text) return null;
    const ci = !settings.caseSensitive;
    const hay = ci ? text.toLowerCase() : text;
    const mode = settings.triggerMode === 'space' ? 'space' : 'instant';

    let trailing = '';
    let scanText = hay, scanLen = text.length;
    if (mode === 'space' && !opts.force) {
      const m = /([ \t\n ]|\.|,|;|:|!|\?|\))$/.exec(text);
      if (!m) return null;
      trailing = m[1];
      scanLen = text.length - trailing.length;
      scanText = hay.slice(0, scanLen);
    }

    const candidates = [];
    for (const s of snippets || []) {
      if (!s || s.enabled === false) continue;
      const sc = String(s.shortcut || '');
      if (!sc) continue;
      const needle = ci ? sc.toLowerCase() : sc;
      if (!scanText.endsWith(needle)) continue;
      const start = scanLen - needle.length;
      if (settings.requireWordBoundary !== false && WORD.test(needle[0]) && start > 0 && WORD.test(text[start - 1])) continue;
      candidates.push({ snippet: s, start, end: scanLen, shortcut: sc, trailing });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.shortcut.length - a.shortcut.length);
    const best = candidates[0];

    if (mode === 'instant' && !opts.force) {
      const bn = ci ? best.shortcut.toLowerCase() : best.shortcut;
      const ambiguous = (snippets || []).some((s) => {
        if (!s || s.enabled === false || s === best.snippet) return false;
        const sc = ci ? String(s.shortcut || '').toLowerCase() : String(s.shortcut || '');
        return sc.length > bn.length && sc.startsWith(bn);
      });
      if (ambiguous) return null;
    }
    return best;
  }

  /* ---------- fuzzy search ---------- */

  /** Subsequence fuzzy match. Returns {score, positions} or null. */
  function fuzzy(query, text) {
    const q = String(query || '').trim().toLowerCase();
    const t = String(text || '');
    const lt = t.toLowerCase();
    if (!q) return { score: 1, positions: [] };
    let ti = 0, score = 0, prev = -2;
    const positions = [];
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === ' ') { continue; }
      const idx = lt.indexOf(ch, ti);
      if (idx === -1) return null;
      positions.push(idx);
      score += 10;
      if (idx === prev + 1) score += 12;                              // consecutive
      if (idx === 0) score += 18;                                     // starts the string
      else if (/[\s\/;:_\-.,(\[]/.test(t[idx - 1])) score += 10;       // starts a word
      score -= Math.min(8, idx - (prev + 1));                         // gap penalty
      prev = idx;
      ti = idx + 1;
    }
    score -= Math.max(0, t.length - q.length) * 0.05;
    return { score, positions };
  }

  /** Rank items by the best fuzzy score over several fields. */
  function search(query, items, fieldsOf) {
    const out = [];
    for (const item of items) {
      const fields = fieldsOf(item).filter(Boolean);
      let best = null, bestField = -1;
      fields.forEach((f, i) => {
        const r = fuzzy(query, f);
        if (r && (!best || r.score > best.score)) { best = r; bestField = i; }
      });
      if (best) out.push({ item, score: best.score + (fields.length - bestField) * 2, positions: best.positions, field: bestField });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  root.TKEngine = {
    CURSOR_MARK, scan, render, preview, collectFields, fieldFromToken,
    formatDate, applyOffset, isoWeek, findShortcut, fuzzy, search,
    escapeHTML, textToHTML, htmlToText, sanitizeHTML, snippetByShortcut,
  };
})(typeof self !== 'undefined' ? self : window);
