#!/usr/bin/env node
// Reading Studio feature tests. Loads the unpacked extension in headless Chromium and exercises
// reader extraction, sentence segmentation, read-aloud (with a silent mock speech engine),
// dark mode (dynamic + filter + already-dark detection) and the focus aids against local pages.
//
//   node reading-studio/test/run-tests.js            # serves test/ on a free port
//
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const FILES = [
  'common/defaults.js', 'content/shared.js', 'content/readability.js', 'content/segmenter.js',
  'content/darkmode.js', 'content/focus.js', 'content/tts.js', 'content/reader.js', 'content/main.js'
];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// The content scripts run here in the page's main world (so tests can reach RS directly). That world
// has no chrome.storage / chrome.runtime, so install a faithful in-memory stand-in seeded from the
// test's settings store; updates fire chrome.storage.onChanged exactly like the real API.
const store = { settings: null };
const livePages = new Set();
function installChromeMock(seed) {
  const listeners = [];
  const areas = { sync: { settings: seed }, local: {} };
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const area = (name) => ({
    async get(keys) {
      const out = {};
      const list = keys == null ? Object.keys(areas[name]) : [].concat(typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : keys);
      for (const k of list) if (areas[name][k] !== undefined) out[k] = copy(areas[name][k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: copy(areas[name][k]), newValue: copy(v) }; areas[name][k] = copy(v); }
      setTimeout(() => listeners.forEach((fn) => fn(changes, name)), 0);
    },
    async remove(k) { delete areas[name][k]; }
  });
  const c = window.chrome || (window.chrome = {});
  c.storage = { sync: area('sync'), local: area('local'), onChanged: { addListener: (fn) => listeners.push(fn) } };
  c.runtime = { onMessage: { addListener() {} }, sendMessage: async () => ({}) };
}

async function inject(page) {
  await page.evaluate(`(${installChromeMock})(${JSON.stringify(store.settings)})`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  await page.waitForFunction(() => globalThis.RS && globalThis.RS.fullLoaded);
  await page.evaluate(() => globalThis.RS.ready);
  livePages.add(page);
  page.on('close', () => livePages.delete(page));
}

(async () => {
  const { server, port } = await serve(__dirname);
  const base = `http://127.0.0.1:${port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 900 }
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  const errors = [];

  const open = async (file) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${file}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${file}: console ${m.text()}`); });
    await page.goto(`${base}/${file}`, { waitUntil: 'load' });
    return page;
  };

  // Settings live in the test's store; every page with the content scripts gets the patch through
  // its own storage stand-in (which fires onChanged, like a real sync from the popup would).
  const settingsPage = await ctx.newPage();
  await settingsPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  store.settings = await settingsPage.evaluate(() => globalThis.RS_SETTINGS.clone(globalThis.RS_SETTINGS.DEFAULTS));
  const setSettings = async (patch) => {
    for (const sec of Object.keys(patch)) store.settings[sec] = Object.assign({}, store.settings[sec], patch[sec]);
    for (const p of livePages) await p.evaluate((x) => globalThis.RS_SETTINGS.update(x), patch).catch(() => {});
  };

  // ================================================================ 1. extraction
  console.log('\nReader extraction');
  {
    const page = await open('article.html');
    await inject(page);
    const art = await page.evaluate(() => {
      const a = RS.extract(document);
      return {
        title: a.title, byline: a.byline, site: a.siteName, minutes: a.readingMinutes, words: a.wordCount,
        isArticle: a.isProbablyArticle, html: a.content.innerHTML, text: a.content.textContent
      };
    });
    ok('title is the headline, not the tab title', art.title === 'The Quiet Art of Reading', art.title);
    ok('byline extracted', art.byline === 'Ada Lovelace', art.byline);
    ok('site name extracted', art.site === 'Example Journal', art.site);
    ok('body paragraphs kept', /Good typography disappears/.test(art.text) && /we rebuild the page/i.test(art.text));
    ok('headings kept', (art.html.match(/<h[23]/g) || []).length >= 2);
    ok('blockquote and list kept', /<blockquote/.test(art.html) && /<ul/.test(art.html));
    ok('figure with caption kept', /<figcaption/.test(art.html));
    ok('nav links dropped', !/Subscribe<\/a>/.test(art.html) && !art.text.includes('Most popular'));
    ok('sidebar dropped', !art.text.includes('history of the semicolon'));
    ok('ad dropped', !/Advertisement/i.test(art.text));
    ok('newsletter form dropped', !/you@example\.com/.test(art.html) && !/Get the best of Example Journal/.test(art.text));
    ok('share tools dropped', !/Share on X/.test(art.text));
    ok('footer dropped', !/All rights reserved/.test(art.text));
    ok('no scripts or forms in output', !/<script|<form|<input|<iframe/i.test(art.html));
    ok('word count plausible', art.words > 180 && art.words < 400, String(art.words));
    ok('reading time computed', art.minutes >= 1 && art.minutes <= 3, String(art.minutes));
    ok('recognized as an article', art.isArticle === true);

    // ---- reader overlay
    console.log('\nReader view overlay');
    await setSettings({ reader: { theme: 'sepia', font: 'dyslexic', size: 22, lineHeight: 1.9, width: 640 } });
    await page.waitForTimeout(150);
    const opened = await page.evaluate(() => RS.reader.open());
    ok('reader opens', opened === true);
    const ui = await page.evaluate(() => {
      const root = document.getElementById('rs-reader').shadowRoot;
      const r = root.querySelector('.reader');
      const cs = getComputedStyle(r);
      return {
        theme: r.className, h1: root.querySelector('h1.title').textContent,
        byline: root.querySelector('.byline').textContent, bg: cs.backgroundColor,
        size: cs.fontSize, lh: cs.lineHeight, width: getComputedStyle(root.querySelector('.page')).maxWidth,
        paras: root.querySelectorAll('.content p').length,
        bodyOverflow: getComputedStyle(document.documentElement).overflow,
        progress: !!root.querySelector('.progress .fill'),
        left: root.querySelector('.bar .left').textContent
      };
    });
    ok('sepia theme applied', /t-sepia/.test(ui.theme) && ui.bg === 'rgb(246, 239, 224)', ui.bg);
    ok('dyslexia-friendly class applied', /\bdys\b/.test(ui.theme));
    // The dyslexia-friendly font adds 0.1 to the line height for extra spacing: 22px x (1.9 + 0.1).
    ok('typography settings applied', ui.size === '22px' && ui.lh === '44px' && ui.width === '640px', `${ui.size}/${ui.lh}/${ui.width}`);
    ok('headline and byline rendered', ui.h1 === 'The Quiet Art of Reading' && /Ada Lovelace/.test(ui.byline) && /min read/.test(ui.byline));
    ok('article paragraphs rendered', ui.paras >= 5, String(ui.paras));
    ok('page scrolling locked behind overlay', ui.bodyOverflow === 'hidden');
    ok('reading time remaining shown', /min left/.test(ui.left), ui.left);

    // progress bar reacts to scroll
    const prog = await page.evaluate(async () => {
      const root = document.getElementById('rs-reader').shadowRoot;
      const sc = root.querySelector('.reader');
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 60));
      return root.querySelector('.progress .fill').style.width;
    });
    ok('progress bar fills on scroll', parseFloat(prog) > 90, prog);

    // settings persist live
    await setSettings({ reader: { theme: 'black' } });
    await page.waitForTimeout(250);
    const liveTheme = await page.evaluate(() => getComputedStyle(document.getElementById('rs-reader').shadowRoot.querySelector('.reader')).backgroundColor);
    ok('live theme change applies to open reader', liveTheme === 'rgb(0, 0, 0)', liveTheme);

    // bionic in reader
    const plainText = await page.evaluate(() => document.getElementById('rs-reader').shadowRoot.querySelector('.content').textContent.replace(/\s+/g, ' ').trim());
    await page.evaluate(() => RS.reader.setBionic(true));
    const bionic = await page.evaluate(() => {
      const root = document.getElementById('rs-reader').shadowRoot;
      const bs = root.querySelectorAll('.content rs-b');
      return { n: bs.length, first: bs[0] && bs[0].textContent, weight: bs[0] && getComputedStyle(bs[0]).fontWeight, text: root.querySelector('.content').textContent.replace(/\s+/g, ' ').trim() };
    });
    ok('bionic bolds word starts in reader', bionic.n > 50 && bionic.weight === '700', `${bionic.n} spans, weight ${bionic.weight}`);
    ok('bionic preserves text', bionic.text === plainText && /Good typography disappears/.test(bionic.text), bionic.text.slice(0, 60));
    await page.evaluate(() => RS.reader.setBionic(false));
    const unbionic = await page.evaluate(() => document.getElementById('rs-reader').shadowRoot.querySelectorAll('rs-b').length);
    ok('bionic can be removed', unbionic === 0);

    const closed = await page.evaluate(() => { RS.reader.close(); return { open: RS.reader.isOpen(), host: !!document.getElementById('rs-reader'), overflow: document.documentElement.style.overflow }; });
    ok('reader closes and restores the page', closed.open === false && closed.host === false && closed.overflow === '');
    await page.close();
  }

  // ================================================================ 2. segmentation
  console.log('\nSentence segmentation');
  {
    const page = await open('article.html');
    await inject(page);
    const res = await page.evaluate(() => {
      const split = (t) => RS.seg.splitSentences(t).map((s) => s.text);
      return {
        abbrev: split('Dr. Smith went to Washington. He arrived at 3 p.m. and left later. Did he? Yes!'),
        initials: split('J. R. R. Tolkien wrote books, e.g. The Hobbit. It sold well in the U.S. The end.'),
        decimals: split('Pi is 3.14 approx. but not exactly. "Really?" she asked. Then she left.'),
        cjk: split('これは日本語です。これも日本語。終わり！'),
        long: split('A ' + 'very long clause that keeps going, '.repeat(12) + 'and then it finally stops.').length,
        ellipsis: split('He paused… then continued. She did not.'),
        empty: split('   \n  ')
      };
    });
    ok('abbreviations do not split', res.abbrev.length === 4 && res.abbrev[1] === 'He arrived at 3 p.m. and left later.', JSON.stringify(res.abbrev));
    ok('initials and e.g. handled', res.initials.length === 3 && res.initials[0].startsWith('J. R. R. Tolkien'), JSON.stringify(res.initials));
    ok('decimals and quotes handled', res.decimals.length === 3, JSON.stringify(res.decimals));
    ok('CJK sentence endings handled', res.cjk.length === 3, JSON.stringify(res.cjk));
    ok('very long sentences are chunked', res.long > 1, String(res.long));
    ok('ellipsis handled', res.ellipsis.length === 2, JSON.stringify(res.ellipsis));
    ok('whitespace yields no segments', res.empty.length === 0);

    const dom = await page.evaluate(() => {
      const art = RS.extract(document);
      const { segments, paragraphs } = RS.seg.buildSegments(art.sourceRoots, { lang: 'en', checkVisibility: true });
      const first = segments[0];
      const r = RS.seg.sentenceRange(first);
      const w = RS.seg.wordRange(first, 0, 4);
      return {
        n: segments.length, paragraphs,
        firstText: first.text,
        rangeText: r && r.toString(),
        wordText: w && w.toString(),
        paraSpread: new Set(segments.map((s) => s.para)).size,
        allNonEmpty: segments.every((s) => s.text.trim().length > 0),
        blocksAreElements: segments.every((s) => s.block && s.block.nodeType === 1)
      };
    });
    ok('DOM segments built', dom.n > 12 && dom.paragraphs > 6, `${dom.n} sentences / ${dom.paragraphs} paragraphs`);
    ok('segment ranges map back to the DOM exactly', dom.rangeText === dom.firstText, `${JSON.stringify(dom.rangeText)} vs ${JSON.stringify(dom.firstText)}`);
    ok('word ranges map to the spoken word', dom.wordText === dom.firstText.slice(0, 4), dom.wordText);
    ok('paragraph indices assigned', dom.paraSpread === dom.paragraphs);
    ok('no empty segments and every block is an element', dom.allNonEmpty && dom.blocksAreElements);
    await page.close();
  }

  // ================================================================ 3. read aloud
  console.log('\nRead aloud');
  {
    await setSettings({ tts: { engine: 'mock', rate: 1, highlightWord: true, autoScroll: true, source: 'auto' }, reader: { theme: 'auto', font: 'serif', size: 20, lineHeight: 1.7, width: 720 } });
    const page = await open('article.html');
    await inject(page);
    const started = await page.evaluate(() => RS.tts.start({ source: 'article' }));
    ok('session starts on the article', started.ok === true && started.total > 10, JSON.stringify(started));
    await page.waitForTimeout(120);
    const live = await page.evaluate(() => ({
      state: RS.tts.state(),
      player: !!document.getElementById('rs-player'),
      sentenceHighlight: CSS.highlights.has('rs-tts-sentence'),
      wordHighlight: CSS.highlights.has('rs-tts-word'),
      highlighted: (() => { const h = CSS.highlights.get('rs-tts-sentence'); for (const r of h) return r.toString(); })()
    }));
    ok('mini player is shown', live.player === true);
    ok('playing', live.state.playing === true && live.state.active === true);
    ok('current sentence is highlighted', live.sentenceHighlight === true && live.highlighted.length > 10, live.highlighted);
    ok('spoken word is highlighted', live.wordHighlight === true);

    const advanced = await page.evaluate(async () => {
      const before = RS.tts.state().index;
      RS.tts.next();
      await new Promise((r) => setTimeout(r, 60));
      const afterNext = RS.tts.state().index;
      RS.tts.prev();
      await new Promise((r) => setTimeout(r, 60));
      const afterPrev = RS.tts.state().index;
      RS.tts.nextPara();
      await new Promise((r) => setTimeout(r, 60));
      const seg = RS.tts.session.segments;
      const i = RS.tts.state().index;
      return { before, afterNext, afterPrev, paraJumped: seg[i].para > seg[afterPrev].para, index: i };
    });
    ok('skip sentence forward and back', advanced.afterNext === advanced.before + 1 && advanced.afterPrev === advanced.before, JSON.stringify(advanced));
    ok('skip paragraph moves to the next paragraph', advanced.paraJumped === true);

    const paused = await page.evaluate(async () => { RS.tts.pause(); await new Promise((r) => setTimeout(r, 50)); return RS.tts.state(); });
    ok('pause stops playback but keeps the session', paused.playing === false && paused.active === true);
    const resumedState = await page.evaluate(async () => { RS.tts.play(); await new Promise((r) => setTimeout(r, 60)); return RS.tts.state(); });
    ok('play resumes', resumedState.playing === true);

    // click a sentence to jump there
    const clicked = await page.evaluate(async () => {
      const seg = RS.tts.session.segments;
      const target = seg[seg.length - 4];
      const r = RS.seg.sentenceRange(target);
      const rect = r.getClientRects()[0];
      target.block.scrollIntoView({ block: 'center' });
      const r2 = RS.seg.sentenceRange(target).getClientRects()[0];
      const el = document.elementFromPoint(r2.left + 3, r2.top + r2.height / 2);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r2.left + 3, clientY: r2.top + r2.height / 2, button: 0 }));
      await new Promise((x) => setTimeout(x, 80));
      return { want: seg.length - 4, got: RS.tts.state().index, hadRect: !!rect };
    });
    ok('clicking a sentence starts reading there', clicked.got === clicked.want, `${clicked.got} vs ${clicked.want}`);

    // speed
    await page.evaluate(() => RS.tts.setRate(2.5));
    const rate = await page.evaluate(async () => (await globalThis.RS_SETTINGS.load()).tts.rate);
    ok('speed change persists (0.5x–3x)', rate === 2.5, String(rate));

    // auto-scroll
    const scrolled = await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 50));
      const seg = RS.tts.session.segments;
      RS.tts.jumpTo(seg.length - 1, false);
      await new Promise((r) => setTimeout(r, 700));
      return window.scrollY;
    });
    ok('auto-scroll follows the sentence', scrolled > 200, String(scrolled));

    // resume per URL
    const resumeInfo = await page.evaluate(async () => {
      RS.tts.jumpTo(5, false);
      await new Promise((r) => setTimeout(r, 100));
      RS.tts.stop();
      await new Promise((r) => setTimeout(r, 200));
      const { resume } = await chrome.storage.local.get('resume');
      return { keys: Object.keys(resume || {}).length, entry: resume && resume[location.origin + location.pathname] };
    });
    ok('position saved per URL', resumeInfo.keys >= 1 && resumeInfo.entry && resumeInfo.entry.i === 5, JSON.stringify(resumeInfo.entry));
    const resumed = await page.evaluate(async () => { const r = await RS.tts.start({ source: 'article' }); return r; });
    ok('reading resumes where it left off', resumed.index === 5, JSON.stringify(resumed));
    await page.evaluate(() => RS.tts.stop());

    // selection reading
    const selRes = await page.evaluate(async () => {
      const p = document.querySelectorAll('article p')[1];
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      const res = await RS.tts.start({ source: 'auto' });
      const st = RS.tts.state();
      const text = RS.tts.session.segments.map((x) => x.text).join(' ');
      RS.tts.stop();
      return { res, st, inside: p.textContent.includes(text.slice(0, 40)) };
    });
    ok('auto source picks the selection', selRes.st.source === 'selection' && selRes.inside === true, JSON.stringify(selRes.res));

    // whole page source
    const pageRes = await page.evaluate(async () => {
      getSelection().removeAllRanges();
      const a = await RS.tts.start({ source: 'article' });
      const artN = a.total; RS.tts.stop();
      const p = await RS.tts.start({ source: 'page' });
      const pageN = p.total; RS.tts.stop();
      return { artN, pageN };
    });
    ok('whole page reads more than the article', pageRes.pageN > pageRes.artN, `${pageRes.pageN} vs ${pageRes.artN}`);

    // reading the reader view
    const readerTts = await page.evaluate(async () => {
      await RS.reader.open();
      const r = await RS.tts.start({ source: 'auto' });
      await new Promise((x) => setTimeout(x, 100));
      const st = RS.tts.state();
      const hl = CSS.highlights.get('rs-tts-sentence');
      let inReader = false;
      for (const range of hl || []) inReader = document.getElementById('rs-reader').shadowRoot.contains(range.startContainer.parentElement);
      RS.tts.stop();
      RS.reader.close();
      return { source: st.source, total: r.total, inReader };
    });
    ok('read aloud targets the reader overlay when open', readerTts.source === 'reader' && readerTts.total > 10 && readerTts.inReader === true, JSON.stringify(readerTts));

    // playback finishes cleanly
    const finished = await page.evaluate(async () => {
      await RS.tts.start({ source: 'selection', index: 0 }).catch(() => {});
      const p = document.querySelectorAll('article p')[3];
      const r = document.createRange(); r.selectNodeContents(p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      await RS.tts.start({ source: 'selection' });
      const n = RS.tts.state().total;
      RS.tts.jumpTo(n - 1, true);
      for (let i = 0; i < 80 && !RS.tts.state().finished; i++) await new Promise((x) => setTimeout(x, 50));
      const st = RS.tts.state();
      RS.tts.stop();
      return st;
    });
    ok('playback reaches the end and reports finished', finished.finished === true && finished.playing === false, JSON.stringify(finished));
    await page.close();
  }

  // ================================================================ 4. dark mode
  console.log('\nDark mode');
  {
    await setSettings({ dark: { enabled: 'on', mode: 'dynamic', brightness: 100, contrast: 100, sepia: 0, grayscale: 0, skipDarkSites: true } });
    const page = await open('light-site.html');
    await inject(page);
    await page.evaluate(() => RS.dark.evaluate({ reanalyze: true }));
    await page.waitForTimeout(500);
    const dyn = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const card = getComputedStyle(document.querySelector('.card'));
      const h1 = getComputedStyle(document.querySelector('h1'));
      const img = getComputedStyle(document.querySelector('img.logo'));
      const lum = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : null; };
      return {
        state: RS.dark.state(),
        bodyBg: lum(body.backgroundColor), bodyFg: lum(body.color),
        cardBg: lum(card.backgroundColor), cardFg: lum(card.color),
        h1: lum(h1.color),
        htmlFilter: getComputedStyle(document.documentElement).filter,
        imgFilter: img.filter,
        styleCount: document.querySelectorAll('style[data-rs-dark]').length,
        tagged: document.querySelectorAll('[data-rs-dk]').length
      };
    });
    ok('dynamic mode activates', dyn.state.active === true && dyn.state.mode === 'dynamic', JSON.stringify(dyn.state));
    ok('page background becomes dark', dyn.bodyBg < 0.2, String(dyn.bodyBg));
    ok('body text becomes light', dyn.bodyFg > 0.6, String(dyn.bodyFg));
    ok('card surfaces darkened', dyn.cardBg < 0.25, String(dyn.cardBg));
    ok('card text readable on the new surface', dyn.cardFg - dyn.cardBg > 0.4, `${dyn.cardFg} on ${dyn.cardBg}`);
    ok('brand color kept but lightened', dyn.h1 > 0.4, String(dyn.h1));
    ok('no page-wide CSS filter in dynamic mode', dyn.htmlFilter === 'none');
    ok('images left natural', dyn.imgFilter === 'none' || dyn.imgFilter === '', dyn.imgFilter);
    ok('overriding stylesheets injected', dyn.styleCount >= 2, String(dyn.styleCount));

    // sliders
    const rgbOf = () => page.evaluate(() => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
      return { r: +m[1], g: +m[2], b: +m[3] };
    });
    const untuned = await rgbOf();
    await setSettings({ dark: { brightness: 130, sepia: 40 } });
    await page.waitForTimeout(500);
    const tuned = await rgbOf();
    const L = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    ok('brightness slider lifts the palette', L(tuned) > L(untuned) + 3, `${JSON.stringify(untuned)} -> ${JSON.stringify(tuned)}`);
    ok('sepia slider warms the palette', (tuned.r - tuned.b) > (untuned.r - untuned.b), `${JSON.stringify(untuned)} -> ${JSON.stringify(tuned)}`);

    // dynamically added content gets themed
    await setSettings({ dark: { brightness: 100, sepia: 0 } });
    await page.waitForTimeout(400);
    const added = await page.evaluate(async () => {
      const d = document.createElement('div');
      d.style.background = '#ffffff';
      d.style.color = '#111111';
      d.textContent = 'Added later';
      document.body.appendChild(d);
      await new Promise((r) => setTimeout(r, 600));
      const cs = getComputedStyle(d);
      const lum = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255; };
      return { bg: lum(cs.backgroundColor), fg: lum(cs.color) };
    });
    ok('content added after load is themed', added.bg < 0.25 && added.fg > 0.6, JSON.stringify(added));

    // filter mode
    await setSettings({ dark: { mode: 'filter' } });
    await page.waitForTimeout(400);
    const filt = await page.evaluate(() => ({
      state: RS.dark.state(),
      htmlFilter: getComputedStyle(document.documentElement).filter,
      imgFilter: getComputedStyle(document.querySelector('img.logo')).filter,
      tagged: document.querySelectorAll('[data-rs-dk]').length
    }));
    ok('filter mode activates', filt.state.mode === 'filter' && /invert/.test(filt.htmlFilter), filt.htmlFilter);
    ok('media counter-inverted so images look natural', /invert/.test(filt.imgFilter), filt.imgFilter);
    ok('dynamic overrides cleaned up when switching modes', filt.tagged === 0);

    // per-site off
    await page.evaluate(async () => { await globalThis.RS_SETTINGS.setSiteRule(location.hostname, 'dark', 'off'); });
    await page.waitForTimeout(400);
    const off = await page.evaluate(() => ({ state: RS.dark.state(), filter: getComputedStyle(document.documentElement).filter, styles: document.querySelectorAll('style[data-rs-dark]').length }));
    ok('per-site off wins over the global default', off.state.active === false && off.filter === 'none' && off.styles === 0, JSON.stringify(off.state));
    await page.evaluate(async () => { await globalThis.RS_SETTINGS.setSiteRule(location.hostname, 'dark', null); });
    await page.close();

    // already-dark detection
    await setSettings({ dark: { mode: 'dynamic', skipDarkSites: true } });
    const dp = await open('dark-site.html');
    await inject(dp);
    await dp.evaluate(() => RS.dark.evaluate({ reanalyze: true }));
    await dp.waitForTimeout(400);
    const darkSite = await dp.evaluate(() => ({ state: RS.dark.state(), bg: getComputedStyle(document.body).backgroundColor, styles: document.querySelectorAll('style[data-rs-dark]').length }));
    ok('site that is already dark is left alone', darkSite.state.active === false && darkSite.state.alreadyDark === true, JSON.stringify(darkSite.state));
    ok('no double darkening', darkSite.bg === 'rgb(16, 17, 20)' && darkSite.styles === 0, darkSite.bg);

    // per-site "on" forces it anyway
    await dp.evaluate(async () => { await globalThis.RS_SETTINGS.setSiteRule(location.hostname, 'dark', 'on'); });
    await dp.waitForTimeout(500);
    const forced = await dp.evaluate(() => RS.dark.state());
    ok('per-site on forces dark mode even on dark sites', forced.active === true, JSON.stringify(forced));
    await dp.evaluate(async () => { await globalThis.RS_SETTINGS.setSiteRule(location.hostname, 'dark', null); });
    await dp.close();

    // global off
    await setSettings({ dark: { enabled: 'off' } });
    const lp = await open('light-site.html');
    await inject(lp);
    await lp.waitForTimeout(300);
    const globalOff = await lp.evaluate(() => RS.dark.state());
    ok('global off means no theming', globalOff.active === false, JSON.stringify(globalOff));
    await lp.close();
  }

  // ================================================================ 5. focus aids
  console.log('\nFocus aids');
  {
    await setSettings({ focus: { ruler: false, rulerMode: 'focus', rulerHeight: 60, rulerOpacity: 0.5, bionic: false, bionicStrength: 0.5 } });
    const page = await open('article.html');
    await inject(page);
    const ruler = await page.evaluate(async () => {
      RS.focus.setRuler(true);
      document.dispatchEvent(new Event('x'));
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 420, bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const root = document.getElementById('rs-ruler').shadowRoot;
      const wrap = root.querySelector('.wrap');
      const top = root.querySelector('.top').getBoundingClientRect();
      const band = root.querySelector('.band').getBoundingClientRect();
      return { y: wrap.style.getPropertyValue('--y'), mode: wrap.className, topHeight: Math.round(top.height), bandHeight: Math.round(band.height), bandTop: Math.round(band.top), dim: getComputedStyle(root.querySelector('.top')).backgroundColor };
    });
    ok('ruler tracks the pointer', ruler.y === '420px', ruler.y);
    ok('spotlight band sized and positioned', ruler.bandHeight === 60 && ruler.bandTop === 390 && ruler.topHeight === 390, JSON.stringify(ruler));
    ok('surrounding area dimmed', /rgba\(0, 0, 0, 0\.5\)/.test(ruler.dim), ruler.dim);

    await setSettings({ focus: { rulerMode: 'underline' } });
    await page.waitForTimeout(300);
    const underline = await page.evaluate(() => {
      const root = document.getElementById('rs-ruler').shadowRoot;
      return { mode: root.querySelector('.wrap').className, h: Math.round(root.querySelector('.band').getBoundingClientRect().height), topShown: getComputedStyle(root.querySelector('.top')).display };
    });
    ok('ruler style switches to underline', /mode-underline/.test(underline.mode) && underline.h === 3 && underline.topShown === 'none', JSON.stringify(underline));

    const kb = await page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      return document.getElementById('rs-ruler').shadowRoot.querySelector('.wrap').style.getPropertyValue('--y');
    });
    ok('Alt+Arrow moves the ruler by keyboard', parseFloat(kb) > 420, kb);
    const rulerOff = await page.evaluate(() => { RS.focus.setRuler(false); return !!document.getElementById('rs-ruler'); });
    ok('ruler can be turned off', rulerOff === false);

    const bio = await page.evaluate(() => {
      const before = document.body.textContent.replace(/\s+/g, ' ');
      RS.focus.setPageBionic(true);
      const spans = document.querySelectorAll('article rs-b');
      const after = document.body.textContent.replace(/\s+/g, ' ');
      const sample = spans[0] && spans[0].textContent;
      const weight = spans[0] && getComputedStyle(spans[0]).fontWeight;
      RS.focus.setPageBionic(false);
      const restored = document.body.textContent.replace(/\s+/g, ' ');
      return { n: spans.length, sample, weight, textUnchanged: before === after && before === restored, leftover: document.querySelectorAll('rs-b,rs-bw').length };
    });
    ok('bionic bolds word starts on the page', bio.n > 100 && bio.weight === '700', `${bio.n} spans`);
    ok('bionic does not change the page text', bio.textUnchanged === true);
    ok('bionic removal is clean', bio.leftover === 0);
    ok('bold prefix length follows the strength setting', bio.sample && bio.sample.length >= 1 && bio.sample.length <= 6, bio.sample);
    await page.close();
  }

  // ================================================================ 6. background wiring
  console.log('\nBackground and popup');
  {
    // A real user grants page access through activeTab (a click or shortcut), which automation cannot
    // do. Simulate that grant with a temporary copy of the extension that holds host access, and drive
    // the real background code paths (popup -> service worker -> tab) from an extension page.
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ext-'));
    fs.cpSync(EXT, copyDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}test${path.sep}`) && !src.endsWith(`${path.sep}test`) });
    const man = JSON.parse(fs.readFileSync(path.join(copyDir, 'manifest.json'), 'utf8'));
    man.host_permissions = ['http://127.0.0.1/*'];
    fs.writeFileSync(path.join(copyDir, 'manifest.json'), JSON.stringify(man));
    const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test2-')), {
      headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${copyDir}`, `--load-extension=${copyDir}`]
    });
    const sw2 = ctx2.serviceWorkers()[0] || await ctx2.waitForEvent('serviceworker', { timeout: 15000 });
    const id2 = sw2.url().split('/')[2];
    const tabPage = await ctx2.newPage();
    tabPage.on('pageerror', (e) => errors.push(`bg-test page: ${e.message}`));
    await tabPage.goto(`${base}/article.html`, { waitUntil: 'load' });
    const ext = await ctx2.newPage();
    await ext.goto(`chrome-extension://${id2}/options/options.html`);
    await ext.waitForTimeout(400);
    const res = await ext.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === pageUrl);
      const out = { found: !!tab };
      const act = (action, args) => chrome.runtime.sendMessage({ type: 'tab-action', tabId: tab.id, action, args });
      out.reader = await act('reader-toggle');
      out.state = await act('get-state');
      out.ping = await chrome.tabs.sendMessage(tab.id, { action: 'ping' }, { frameId: 0 });
      out.close = await act('reader-toggle');
      out.dark = await chrome.runtime.sendMessage({ type: 'toggle-dark', tabId: tab.id });
      out.sites = (await chrome.storage.local.get('sites')).sites;
      out.darkOff = await chrome.runtime.sendMessage({ type: 'toggle-dark', tabId: tab.id });
      out.registered = (await chrome.scripting.getRegisteredContentScripts()).map((c) => c.id);
      out.voices = (await chrome.runtime.sendMessage({ type: 'get-voices' })).voices.length;
      out.commands = (await chrome.commands.getAll()).map((c) => `${c.name}:${c.shortcut}`);
      return out;
    }, `${base}/article.html`);
    const domDark = await tabPage.evaluate(() => document.documentElement.getAttribute('data-rs-dark-mode'));
    ok('service worker injects the full feature set on demand', res.found && res.ping && res.ping.full === true, JSON.stringify(res.ping));
    ok('reader opens through a background message', res.reader && res.reader.result === true, JSON.stringify(res.reader));
    ok('tab state reported to the popup', res.state && res.state.result && res.state.result.reader === true && typeof res.state.result.host === 'string', JSON.stringify(res.state && res.state.result));
    ok('reader closes through a background message', res.close && res.close.result === false);
    ok('dark mode toggles per site through the background', res.dark.ok && res.dark.active === true && res.sites['127.0.0.1'].dark === 'on' && res.darkOff.active === false, JSON.stringify(res.dark));
    ok('dark mode script auto-registers for granted sites', res.registered.includes('rs-dark'), JSON.stringify(res.registered));
    ok('dark mode removed from the page after toggling off', domDark === null || domDark === '', String(domDark));
    ok('Alt+Shift+R is bound to the reader', res.commands.includes('toggle-reader:Alt+Shift+R'), JSON.stringify(res.commands));
    console.log(`  note: ${res.voices} TTS voices in this headless container (0 is expected; the Web Speech fallback covers it)`);
    await ctx2.close();
    fs.rmSync(copyDir, { recursive: true, force: true });

    const popup = await ctx.newPage();
    const perrors = [];
    popup.on('pageerror', (e) => perrors.push(e.message));
    popup.on('console', (m) => { if (m.type() === 'error') perrors.push(m.text()); });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForTimeout(600);
    const pop = await popup.evaluate(() => ({
      host: document.getElementById('host').textContent,
      sliders: document.querySelectorAll('input[type=range]').length,
      segs: document.querySelectorAll('.seg').length,
      restricted: !document.getElementById('restricted').hidden
    }));
    ok('popup renders its controls without errors', perrors.length === 0 && pop.sliders >= 6 && pop.segs >= 4, perrors.join('; '));
    await popup.close();

    const opts = await ctx.newPage();
    const oerrors = [];
    opts.on('pageerror', (e) => oerrors.push(e.message));
    opts.on('console', (m) => { if (m.type() === 'error') oerrors.push(m.text()); });
    await opts.goto(`chrome-extension://${extId}/options/options.html`);
    await opts.waitForTimeout(600);
    const o = await opts.evaluate(async () => {
      document.getElementById('d-add-host').value = 'example.org';
      document.getElementById('d-add').dispatchEvent(new Event('submit', { cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      const sites = await globalThis.RS_SETTINGS.getSites();
      const rows = document.querySelectorAll('#d-sites li').length;
      const keys = document.querySelectorAll('#keys tr').length;
      return { rule: sites['example.org'] && sites['example.org'].dark, rows, keys, bionicDemo: document.querySelectorAll('#bionic-demo b').length };
    });
    ok('options page adds a site rule', o.rule === 'on' && o.rows >= 1, JSON.stringify(o));
    ok('options page lists shortcuts and previews bionic text', o.keys >= 4 && o.bionicDemo > 10, JSON.stringify(o));
    ok('options page has no console errors', oerrors.length === 0, oerrors.join('; '));
    await opts.close();
  }

  await settingsPage.close();
  await ctx.close();
  server.close();

  if (errors.length) { console.log('\nPage errors:\n  ' + errors.join('\n  ')); fail += errors.length; }
  console.log(`\n${fail === 0 ? 'ALL TESTS PASS' : 'TESTS FAILED'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
