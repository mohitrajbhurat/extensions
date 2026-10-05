// Total Recall content script: extracts the main readable text of the page and hands it to the
// service worker for local indexing. Runs in the isolated world; never sends anything off-device.
(() => {
  if (window.__totalRecallLoaded) return;
  window.__totalRecallLoaded = true;
  if (window.top !== window) return;

  const INITIAL_DELAY = 1500;     // let the page settle before reading it
  const MUTATION_DEBOUNCE = 4000; // re-read after dynamic content stops changing
  const MAX_UPDATES_PER_URL = 4;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
    'VIDEO', 'AUDIO', 'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'LABEL', 'DIALOG', 'MENU']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'BR', 'HR', 'SUMMARY', 'DETAILS', 'CAPTION']);
  const SKIP_ROLES = /^(navigation|banner|contentinfo|complementary|menu|menubar|toolbar|dialog|alertdialog|search|tablist)$/;
  const BOILERPLATE = /(^|[-_\s])(cookie|consent|gdpr|advert|ads?|sponsor|promo|share|social|newsletter|subscribe|related|recommend|comments?|breadcrumbs?|sidebar|skip-link|popup|modal|toast|paywall)([-_\s]|$)/i;
  const SENSITIVE_URL = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|oauth|sso|password|reset|2fa|mfa|checkout|payment|billing|wallet|banking)(\/|\?|$|\.)/i;
  const SENSITIVE_HOST = /(^|\.)(bank|banking|onlinebanking|netbanking|ebanking)[^.]*\.|creditunion|\.bank$/i;

  let lastUrl = location.href;
  let sentForUrl = 0;
  let lastLength = 0;
  let timer = null;
  let observer = null;

  const visible = el => (typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : el.getClientRects().length > 0);

  function isSensitive() {
    if (SENSITIVE_URL.test(location.pathname) || SENSITIVE_HOST.test(location.hostname)) return true;
    const pw = document.querySelector('input[type="password"], input[autocomplete="cc-number"], input[autocomplete="one-time-code"], input[name*="cardnumber" i]');
    if (pw && visible(pw)) return true;
    return /\b(online banking|account balance|sort code|routing number)\b/i.test(document.title);
  }

  function skipElement(el) {
    if (SKIP_TAGS.has(el.tagName)) {
      // Pages that use <header> inside <article> for the headline: keep it.
      if (el.tagName === 'HEADER' && el.closest('article')) return false;
      return true;
    }
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.test(role)) return true;
    const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
    if (cls.length > 1 && BOILERPLATE.test(cls) && el.tagName !== 'ARTICLE' && el.tagName !== 'MAIN' && el.tagName !== 'BODY') return true;
    return false;
  }

  /** Pick the element that most likely holds the main content (Readability-lite). */
  function findRoot() {
    const candidates = [...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')]
      .filter(el => visible(el) && el.textContent.length > 400);
    if (candidates.length === 1) return candidates[0];
    const scores = new Map();
    for (const p of document.querySelectorAll('p, pre, blockquote, li, td, dd')) {
      const len = p.textContent.trim().length;
      if (len < 40) continue;
      const commas = (p.textContent.match(/[,.;]/g) || []).length;
      const s = 1 + Math.min(len / 100, 3) + Math.min(commas, 5) * 0.5;
      let el = p.parentElement, depth = 0;
      while (el && el !== document.documentElement && depth < 3) {
        scores.set(el, (scores.get(el) || 0) + s / (depth + 1));
        el = el.parentElement; depth++;
      }
    }
    let best = null, bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    if (!best || bestScore < 8) return document.body;
    // Prefer a container that also holds headings and siblings of the best paragraph cluster.
    const parent = best.parentElement;
    if (parent && parent !== document.body && (scores.get(parent) || 0) > bestScore * 0.6) best = parent;
    return best;
  }

  function collectText(root, cap) {
    const out = [];
    let size = 0;
    let line = '';
    const flush = () => {
      const t = line.replace(/\s+/g, ' ').trim();
      if (t) { out.push(t); size += t.length + 1; }
      line = '';
    };
    const walk = node => {
      if (size >= cap) return;
      if (node.nodeType === Node.TEXT_NODE) { line += node.nodeValue; if (line.length > 4000) flush(); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (el !== root && skipElement(el)) return;
      if (BLOCK_TAGS.has(el.tagName) && !visible(el) && el.tagName !== 'BR') return;
      const block = BLOCK_TAGS.has(el.tagName);
      if (block) flush();
      if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
      for (const c of el.childNodes) walk(c);
      if (block) flush();
      else if (el.tagName === 'TD' || el.tagName === 'TH') line += ' ';
    };
    walk(root);
    flush();
    // Drop exact duplicate lines (repeated widgets) while keeping order.
    const seen = new Set();
    const lines = out.filter(l => { if (l.length > 30 && seen.has(l)) return false; seen.add(l); return true; });
    return lines.join('\n').slice(0, cap);
  }

  function metaContent(sel) {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function extract(cap) {
    const root = findRoot();
    let text = collectText(root, cap);
    if (root !== document.body && text.length < 300) text = collectText(document.body, cap);
    const desc = metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]');
    if (desc && !text.includes(desc.slice(0, 60))) text = (desc + '\n' + text).slice(0, cap);
    const title = (document.title || metaContent('meta[property="og:title"]') || location.hostname).trim();
    return { title, text };
  }

  async function getSettings() {
    try { const { settings } = await chrome.storage.local.get('settings'); return settings || {}; } catch { return null; }
  }

  function excludedBy(rules) {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    const path = location.pathname.toLowerCase();
    return (rules || []).some(raw => {
      const r = String(raw).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\/+$/, '');
      if (!r) return false;
      const i = r.indexOf('/');
      const d = i === -1 ? r : r.slice(0, i), p = i === -1 ? '' : r.slice(i);
      return (host === d || host.endsWith('.' + d)) && (!p || path.startsWith(p));
    });
  }

  async function capture({ force = false } = {}) {
    const s = await getSettings();
    if (!s) return { ok: false, reason: 'context' };
    if (!force && s.paused) return { ok: false, reason: 'paused' };
    if (excludedBy(s.excludedDomains)) return { ok: false, reason: 'excluded' };
    if (s.skipSensitive !== false && isSensitive()) return { ok: false, reason: 'sensitive' };
    if (!document.body) return { ok: false, reason: 'empty' };
    const cap = s.maxCharsPerPage || 60000;
    const { title, text } = extract(cap);
    if (!force && text.length < (s.minChars ?? 120)) return { ok: false, reason: 'too-short' };
    lastLength = text.length;
    return { ok: true, url: location.href, title, text };
  }

  async function send(force = false) {
    const data = await capture({ force });
    if (!data.ok) return data;
    sentForUrl++;
    try {
      return await chrome.runtime.sendMessage({ type: 'tr:index', url: data.url, title: data.title, text: data.text, force });
    } catch {
      teardown(); // extension was reloaded or removed
      return { ok: false, reason: 'context' };
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (document.visibilityState === 'visible' || sentForUrl === 0) send(); }, delay);
  }

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    sentForUrl = 0; lastLength = 0;
    schedule(INITIAL_DELAY + 500);
  }

  function onMutations() {
    onUrlChange();
    if (timer || sentForUrl === 0 || sentForUrl >= MAX_UPDATES_PER_URL) return;
    const len = document.body ? document.body.textContent.length : 0;
    if (len > lastLength * 1.3 + 500) schedule(MUTATION_DEBOUNCE);
  }

  let mutationTick = null;
  function teardown() {
    clearTimeout(timer); clearInterval(urlPoll);
    if (observer) observer.disconnect();
    window.removeEventListener('popstate', onUrlChange);
    window.removeEventListener('hashchange', onUrlChange);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'tr:extract') {
      capture({ force: true }).then(sendResponse);
      return true;
    }
    return false;
  });

  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
  const urlPoll = setInterval(onUrlChange, 1000); // catches history.pushState in SPAs
  observer = new MutationObserver(() => {
    if (mutationTick) return;
    mutationTick = setTimeout(() => { mutationTick = null; onMutations(); }, 1000);
  });
  const start = () => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: false });
    schedule(INITIAL_DELAY);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
