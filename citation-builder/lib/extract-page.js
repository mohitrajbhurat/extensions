// Runs INSIDE the web page via chrome.scripting.executeScript({func: collectPageData}).
// It must stay self-contained (no imports, no outer variables): Chrome serializes the function source.
// It only gathers raw signals; interpretation happens in normalize.js inside the extension.

export function collectPageData() {
  const clip = (s, n = 2000) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim().slice(0, n));
  const metas = [];
  for (const m of document.querySelectorAll('meta')) {
    const key = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
    const content = m.getAttribute('content');
    if (key && content && content.trim()) metas.push([key.trim(), clip(content), m.getAttribute('scheme') || '']);
    if (metas.length >= 800) break;
  }

  const jsonld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (jsonld.length >= 25) break;
    jsonld.push(String(s.textContent || '').slice(0, 300000));
  }

  // Microdata (itemprop) outside <meta>: authors, dates, names.
  const micro = { author: [], datePublished: [], dateModified: [], headline: [], name: [] };
  const val = el => el.getAttribute('content') || el.getAttribute('datetime') || clip(el.textContent, 300);
  for (const el of document.querySelectorAll('[itemprop~="author"], [itemprop~="creator"]')) {
    if (micro.author.length >= 30) break;
    const nameEl = el.querySelector('[itemprop~="name"]');
    const v = nameEl ? val(nameEl) : (el.getAttribute('content') || clip(el.textContent, 120));
    if (v) micro.author.push(v);
  }
  for (const key of ['datePublished', 'dateModified', 'headline']) {
    const el = document.querySelector(`[itemprop~="${key}"]:not(meta)`);
    if (el) micro[key].push(val(el));
  }

  // Visible bylines as a last resort.
  const bylines = [];
  for (const el of document.querySelectorAll('[rel="author"], .byline, .author-name, [class*="byline__name"], [data-testid*="author"]')) {
    if (bylines.length >= 10) break;
    const t = clip(el.textContent, 120);
    if (t && t.length < 120) bylines.push(t);
  }

  const timeEl = document.querySelector('article time[datetime], time[datetime]');
  const canonical = document.querySelector('link[rel="canonical"]');
  const h1 = document.querySelector('h1');
  let text = '';
  try { text = (document.body && document.body.innerText || '').slice(0, 8000); } catch (e) { text = ''; }
  let selection = '';
  try { selection = String(window.getSelection() || '').slice(0, 1000); } catch (e) { selection = ''; }

  return {
    url: location.href,
    docTitle: clip(document.title, 500),
    lang: document.documentElement.getAttribute('lang') || '',
    contentType: document.contentType || '',
    metas,
    jsonld,
    micro,
    bylines,
    time: timeEl ? timeEl.getAttribute('datetime') : '',
    canonical: canonical ? canonical.href : '',
    h1: h1 ? clip(h1.textContent, 500) : '',
    text,
    selection,
  };
}
