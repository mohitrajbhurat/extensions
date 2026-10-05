/* Assets: images, inline SVGs, CSS background images, icons. Preview, copy and download. */
import { h, clear, copyText, sendMessage, downloadText, isOurs, shortUrl } from './util.js';

const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
const MAX_ELEMENTS = 10000;

export function extractCssUrls(value) {
  const out = [];
  if (!value || value === 'none') return out;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(value))) if (m[2]) out.push(m[2]);
  return out;
}

const abs = u => {
  try {
    return new URL(u, document.baseURI).href;
  } catch {
    return null;
  }
};

/** Best-effort file extension for an asset URL. */
export function guessExtension(url, fallback = 'png') {
  if (/^data:/i.test(url)) {
    const mime = (/^data:([^;,]+)/i.exec(url) || [])[1] || '';
    const sub = mime.split('/')[1] || fallback;
    return sub === 'svg+xml' ? 'svg' : sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/gi, '') || fallback;
  }
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    if (m) return m[1].toLowerCase();
  } catch {}
  return fallback;
}

/** A safe relative download filename. */
export function safeFilename(name, ext) {
  let base = String(name || 'asset')
    .replace(/[?#].*$/, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'asset';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = '_' + base;
  return `${base}.${ext}`;
}

function serializeSvg(svg) {
  const clone = svg.cloneNode(true);
  // Inline referenced <symbol>/<g> for <use href="#id"> sprites so the file stands alone.
  const defs = [];
  for (const use of clone.querySelectorAll('use')) {
    const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    if (!ref.startsWith('#')) continue;
    let target = null;
    try { target = document.getElementById(ref.slice(1)); } catch {}
    if (target && !clone.querySelector(ref.replace(/([^\w#-])/g, '\\$1'))) defs.push(target.cloneNode(true));
  }
  if (defs.length) {
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.forEach(n => d.appendChild(n));
    clone.insertBefore(d, clone.firstChild);
  }
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const r = svg.getBoundingClientRect();
  if (!clone.getAttribute('width') && r.width) clone.setAttribute('width', String(Math.round(r.width)));
  if (!clone.getAttribute('height') && r.height) clone.setAttribute('height', String(Math.round(r.height)));
  const cs = getComputedStyle(svg);
  if (!clone.getAttribute('fill') && cs.fill && cs.fill !== 'rgb(0, 0, 0)' && !/url/.test(cs.fill)) clone.setAttribute('fill', cs.fill);
  if (!clone.style.color && cs.color) clone.style.color = cs.color; // for currentColor
  return new XMLSerializer().serializeToString(clone);
}

/** Collect assets on the page. */
export function collectAssets() {
  const items = [];
  const seen = new Map();
  const add = (kind, url, extra = {}) => {
    if (!url) return;
    const key = kind === 'inline-svg' ? 'svg:' + extra.code : url;
    if (seen.has(key)) {
      seen.get(key).uses++;
      return;
    }
    const item = { kind, url, uses: 1, ...extra };
    const dataName = () => `${extra.alt ? extra.alt.slice(0, 40) : kind}-${items.length + 1}`;
    item.name = extra.name || (kind === 'inline-svg' ? 'inline-svg' : /^data:/i.test(url) ? dataName() : shortUrl(url));
    item.isSvg = kind === 'inline-svg' || /\.svg(\?|#|$)/i.test(url) || /^data:image\/svg/i.test(url);
    seen.set(key, item);
    items.push(item);
  };

  for (const img of document.images) {
    if (isOurs(img)) continue;
    const u = img.currentSrc || img.src;
    if (!u) continue;
    add('image', abs(u), { width: img.naturalWidth, height: img.naturalHeight, alt: img.alt || '' });
  }
  let svgIndex = 0;
  for (const svg of document.querySelectorAll('svg')) {
    if (isOurs(svg) || svg.parentElement && svg.parentElement.closest('svg')) continue;
    const r = svg.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    let code = '';
    try { code = serializeSvg(svg); } catch { continue; }
    const label = svg.getAttribute('aria-label') || (svg.querySelector('title') && svg.querySelector('title').textContent) || svg.id || `svg-${++svgIndex}`;
    add('inline-svg', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(code), {
      code, width: Math.round(r.width), height: Math.round(r.height), name: label.trim().slice(0, 60),
    });
  }
  for (const v of document.querySelectorAll('video[poster]')) add('image', abs(v.getAttribute('poster')), { name: 'poster ' + shortUrl(v.poster) });
  for (const im of document.querySelectorAll('svg image')) add('image', abs(im.getAttribute('href') || im.getAttribute('xlink:href')));
  for (const l of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')) add('icon', abs(l.getAttribute('href')), { sizes: l.getAttribute('sizes') || '' });
  for (const m of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) add('social', abs(m.getAttribute('content')));

  // CSS backgrounds (elements and their pseudo elements)
  let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++n > MAX_ELEMENTS) break;
    if (isOurs(el)) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      const values = [cs.backgroundImage, pseudo ? cs.content : '', cs.maskImage || cs.webkitMaskImage || ''];
      for (const value of values) {
        for (const u of extractCssUrls(value)) add('background', abs(u), { selectorHint: el.localName + (pseudo || '') });
      }
    }
  }
  const bodyBg = getComputedStyle(document.body || document.documentElement).backgroundImage;
  for (const u of extractCssUrls(bodyBg)) add('background', abs(u));
  return items.filter(i => i.url && !/^about:/.test(i.url));
}

async function downloadAsset(app, item) {
  const ext = item.kind === 'inline-svg' ? 'svg' : guessExtension(item.url, item.isSvg ? 'svg' : 'png');
  const host = (location.hostname || 'page').replace(/[^\w.-]/g, '-');
  const filename = `design-inspector/${host}/${safeFilename(item.name, ext)}`;
  if (/^blob:/i.test(item.url)) {
    // Blob URLs only resolve inside the page; use a same-origin link.
    const a = h('a', { href: item.url, download: safeFilename(item.name, ext) });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  }
  const res = await sendMessage({ type: 'di-download', url: item.url, filename });
  if (res && res.ok) return true;
  if (item.kind === 'inline-svg') {
    downloadText(safeFilename(item.name, 'svg'), item.code, 'image/svg+xml');
    return true;
  }
  app.toast('Download failed: ' + ((res && res.error) || 'unknown error'), 3000);
  return false;
}

export function openAssets(app) {
  let items = [];
  let filter = 'all';
  let query = '';
  const listEl = h('div.list');
  const countEl = h('span.hint');
  const tabsEl = h('div.tabs', { role: 'tablist' });
  const FILTERS = { all: 'All', image: 'Images', svg: 'SVG', background: 'Backgrounds', icon: 'Icons' };
  const matches = i => {
    if (filter === 'svg' && !i.isSvg) return false;
    if (filter === 'image' && i.kind !== 'image') return false;
    if (filter === 'background' && i.kind !== 'background') return false;
    if (filter === 'icon' && i.kind !== 'icon' && i.kind !== 'social') return false;
    if (query && !(`${i.name} ${i.url.slice(0, 300)} ${i.alt || ''}`.toLowerCase().includes(query))) return false;
    return true;
  };
  const visible = () => items.filter(matches);

  const renderTabs = () => {
    clear(tabsEl);
    for (const [id, label] of Object.entries(FILTERS)) {
      const prev = filter;
      filter = id;
      const count = items.filter(matches).length;
      filter = prev;
      tabsEl.append(h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(filter === id), 'data-filter': id,
        onclick: () => { filter = id; renderTabs(); renderList(); },
      }, `${label} ${count}`));
    }
  };

  const renderList = () => {
    clear(listEl);
    const vis = visible();
    countEl.textContent = `${vis.length} of ${items.length} assets`;
    if (!vis.length) {
      listEl.append(h('div.empty', items.length ? 'Nothing matches.' : 'No images, SVGs or background images found.'));
      return;
    }
    for (const item of vis.slice(0, 400)) {
      const thumb = h('div.thumb');
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer-when-downgrade' });
      img.src = item.url;
      img.addEventListener('load', () => {
        if (!item.width && img.naturalWidth) {
          item.width = img.naturalWidth;
          item.height = img.naturalHeight;
          dims.textContent = describe(item);
        }
      }, { once: true });
      thumb.append(img);
      const describe = it => [
        it.kind === 'inline-svg' ? 'inline SVG' : it.kind,
        it.width ? `${it.width}×${it.height}` : '',
        it.uses > 1 ? `used ${it.uses}×` : '',
        it.sizes || '',
      ].filter(Boolean).join(' · ');
      const dims = h('div.sub', describe(item));
      const urlLine = h('div.sub', { title: item.kind === 'inline-svg' ? '' : item.url }, item.kind === 'inline-svg' ? `${item.code.length.toLocaleString()} bytes` : item.url.slice(0, 200));
      const actions = h('div.row.tight', { style: { flex: '0 0 auto', flexDirection: 'column', alignItems: 'stretch' } },
        h('button.btn', { type: 'button', title: 'Download', 'aria-label': `Download ${item.name}`, onclick: async () => { if (await downloadAsset(app, item)) app.toast('Downloading…'); } }, '↓'),
        h('button.btn', {
          type: 'button', title: item.kind === 'inline-svg' ? 'Copy SVG code' : 'Copy URL', 'aria-label': item.kind === 'inline-svg' ? 'Copy SVG code' : 'Copy URL',
          onclick: async () => app.toast((await copyText(item.kind === 'inline-svg' ? item.code : item.url)) ? 'Copied' : 'Copy failed'),
        }, '⧉'));
      listEl.append(h('div.item', { 'data-kind': item.kind }, thumb, h('div.meta', h('div.name', { title: item.name }, item.name), dims, urlLine), actions));
    }
    if (vis.length > 400) listEl.append(h('div.hint', `Showing the first 400 of ${vis.length}.`));
  };

  const search = h('input', { type: 'text', placeholder: 'Filter by name or URL', 'aria-label': 'Filter assets' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderTabs(); renderList(); });

  const downloadAll = async () => {
    const vis = visible();
    if (!vis.length) return;
    if (vis.length > 20 && !confirm(`Download ${vis.length} files?`)) return;
    let ok = 0;
    for (const item of vis) {
      if (await downloadAsset(app, item)) ok++;
      await new Promise(r => setTimeout(r, 120));
    }
    app.toast(`Started ${ok} download${ok === 1 ? '' : 's'}`);
  };

  const refresh = () => {
    items = collectAssets();
    renderTabs();
    renderList();
  };

  app.showPanel('assets', {
    title: 'Assets', wide: true, tabs: tabsEl,
    body: [h('div.row', h('div.grow', search), countEl), listEl],
    foot: [
      h('button.btn.primary', { type: 'button', onclick: downloadAll, title: 'Download every asset in the current filter' }, 'Download all'),
      h('button.btn', {
        type: 'button', title: 'Copy all URLs in the current filter',
        onclick: async () => app.toast((await copyText(visible().filter(i => i.kind !== 'inline-svg').map(i => i.url).join('\n'))) ? 'URLs copied' : 'Copy failed'),
      }, 'Copy URLs'),
      h('button.btn.ghost', { type: 'button', onclick: refresh }, 'Rescan'),
    ],
  });
  refresh();
}
