// Page content extraction. Two paths:
//  - extractPageInTab: injected with chrome.scripting into the active tab (activeTab grant).
//  - fetchAndExtract: fetches HTML (needs optional host permission) and parses it with regexes,
//    so it also works inside the service worker where DOMParser is unavailable.

// Self-contained: runs in the page via chrome.scripting.executeScript({ func }).
export function extractPageInTab() {
  const meta = sel => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  let text = '';
  try {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form,iframe,button,[aria-hidden="true"]').forEach(n => n.remove());
    text = (clone.innerText || clone.textContent || '');
    if (text.trim().length < 200) text = document.body ? document.body.innerText : text;
  } catch { text = document.body ? document.body.innerText : ''; }
  text = text.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 60000);
  return {
    url: location.href,
    title: (document.title || meta('meta[property="og:title"]')).trim(),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    keywords: meta('meta[name="keywords"]') || meta('meta[name="news_keywords"]') || [...document.querySelectorAll('meta[property="article:tag"]')].map(m => m.content).join(','),
    lang: document.documentElement.lang || '',
    text
  };
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function metaContent(html, attr, name) {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return '';
  const c = tag[0].match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return c ? decodeEntities(c[1] ?? c[2] ?? '').trim() : '';
}

export function extractFromHtml(html, url = '') {
  html = String(html || '').slice(0, 3_000_000);
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(titleM ? titleM[1] : '').replace(/\s+/g, ' ').trim() || metaContent(html, 'property', 'og:title');
  const description = metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description');
  const tagMetas = [...html.matchAll(/<meta\b[^>]*property\s*=\s*["']article:tag["'][^>]*>/gi)]
    .map(m => (m[0].match(/content\s*=\s*["']([^"']*)/i) || [])[1]).filter(Boolean);
  const keywords = metaContent(html, 'name', 'keywords') || metaContent(html, 'name', 'news_keywords') || tagMetas.join(',');
  const langM = html.match(/<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i);
  let body = html;
  const art = html.match(/<article\b[\s\S]*?<\/article>/i) || html.match(/<main\b[\s\S]*?<\/main>/i);
  if (art && art[0].length > 1500) body = art[0];
  else { const b = html.match(/<body\b[\s\S]*$/i); if (b) body = b[0]; }
  const text = decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br|blockquote|pre)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 60000);
  return { url, title, description, keywords: decodeEntities(keywords), lang: langM ? langM[1] : '', text };
}

export async function fetchHtml(url, { timeout = 15000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`Not a web page (${type.split(';')[0]})`);
    const html = await res.text();
    return { html, finalUrl: res.url || url, type };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function fetchAndExtract(url, opts) {
  const { html, finalUrl, type } = await fetchHtml(url, opts);
  if (/text\/plain/i.test(type)) return { url: finalUrl, title: '', description: '', keywords: '', lang: '', text: html.slice(0, 60000) };
  return extractFromHtml(html, finalUrl);
}

export function countWords(text) {
  const m = String(text || '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  // CJK text has no spaces: approximate by characters / 2.
  const cjk = (String(text || '').match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  return (m ? m.length : 0) + Math.round(cjk / 2);
}

export function readingMinutes(words, wpm = 230) {
  if (!words) return 0;
  return Math.max(1, Math.round(words / (wpm || 230)));
}
