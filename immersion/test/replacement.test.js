#!/usr/bin/env node
// Playwright check for the replacement engine using the bundled-dictionary fallback.
// Usage (from the repo root): node immersion/test/replacement.test.js
// Serves immersion/test/ over HTTP, loads the unpacked extension and exercises the content script.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const PORT = 8000 + Math.floor(Math.random() * 900);
const es = JSON.parse(fs.readFileSync(path.join(EXT, 'data/es.json'), 'utf8'));
const de = JSON.parse(fs.readFileSync(path.join(EXT, 'data/de.json'), 'utf8'));

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: __dirname, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'lim-')), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const setSettings = (patch) => sw.evaluate(async (p) => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...globalThis.LIM.DEFAULT_SETTINGS, ...(settings || {}), ...p } });
    }, patch);
    const getVocab = () => sw.evaluate(async () => (await chrome.storage.local.get('vocab')).vocab || {});
    await setSettings({ engine: 'dictionary', targetLang: 'es', difficulty: 'beginner', density: 20 });

    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${PORT}/article.html`;
    await page.goto(url);
    await page.waitForSelector('span.lim-w', { timeout: 10000 });
    await page.waitForTimeout(500);

    // 1. Replacement happened, within density
    const spans = await page.$$eval('span.lim-w', (els) => els.map((e) => ({ t: e.textContent, o: e.dataset.limOrig, pos: e.dataset.limPos, pl: e.dataset.limPl, lang: e.lang })));
    console.log(`     replaced ${spans.length}: ` + spans.map((s) => `${s.o}->${s.t}`).join(', '));
    check(spans.length >= 8 && spans.length <= 20, `beginner: ${spans.length} replacements (8..20 expected with density 20)`);
    check(spans.every((s) => s.pos === 'n'), 'beginner level replaces only nouns');
    check(spans.every((s) => s.lang === 'es'), 'replaced spans carry lang="es"');
    const valid = spans.every((s) => {
      const v = es.words[s.o.toLowerCase()];
      const tr = Array.isArray(v) ? v[0] : v;
      if (v) return s.t.toLowerCase() === tr.toLowerCase();
      return s.pl === '1'; // plural forms are inflected
    });
    check(valid, 'every replacement matches the bundled Spanish dictionary');
    const words = new Set(spans.map((s) => s.o.toLowerCase()));
    check(words.size >= Math.min(8, spans.length - 2), `variety: ${words.size} distinct words`);

    // 2. Protected regions untouched
    const protectedOk = await page.evaluate(() => {
      const bad = document.querySelectorAll('pre span.lim-w, code span.lim-w, button span.lim-w, [contenteditable] span.lim-w, form span.lim-w');
      return bad.length === 0 && document.getElementById('inp').value === 'house dog water' &&
        document.getElementById('ta').value.includes('The dog and the cat') &&
        document.querySelector('pre code').textContent.includes('the code block must never change: water tree dog') &&
        document.getElementById('editable').textContent === 'This editable house has a dog and a garden.';
    });
    check(protectedOk, 'code blocks, inputs, textareas, buttons and contenteditable are untouched');

    // 3. Hover card
    const first = page.locator('span.lim-w').first();
    await first.scrollIntoViewIfNeeded();
    await first.hover();
    const card = page.locator('lim-ui .card');
    await card.waitFor({ timeout: 3000 });
    const cardText = await card.innerText();
    const firstOrig = await first.getAttribute('data-lim-orig');
    check(cardText.toLowerCase().includes(firstOrig.toLowerCase()), `hover card shows the original word ("${firstOrig}")`);
    check(/I know this/.test(cardText) && /Save to review/.test(cardText), 'hover card has "I know this" and "Save to review"');
    check(await card.locator('button[data-act="speak"]').count() === 1, 'hover card has a pronunciation button');

    // 4. Save + I know this persist
    const key = await first.getAttribute('data-lim-key');
    await card.locator('button[data-act="save"]').click();
    await page.waitForTimeout(300);
    let vocab = await getVocab();
    check(vocab[key] && vocab[key].saved && vocab[key].state === 'learning', `"Save to review" stores ${key} as learning`);
    await card.locator('button[data-act="known"]').click();
    await page.waitForTimeout(300);
    vocab = await getVocab();
    check(vocab[key] && vocab[key].state === 'known', `"I know this" marks ${key} as known`);
    check(await first.getAttribute('data-lim-state') === 'known', 'span restyles as known');

    // 5. Show original toggle
    await first.hover();
    await page.locator('lim-ui .card button[data-act="toggle"]').click();
    check((await first.textContent()) === firstOrig, 'show original restores the English word in place');
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');

    // 6. Sightings recorded for visible words
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
    vocab = await getVocab();
    const seen = Object.values(vocab).filter((e) => e.seen > 0).length;
    check(seen >= 5, `sightings recorded for ${seen} words`);

    // 7. Dynamic content is processed
    await page.evaluate(() => {
      const d = document.getElementById('dynamic');
      for (let i = 0; i < 6; i++) {
        const p = document.createElement('p');
        p.textContent = 'The doctor walked to the hospital with a nurse, a teacher and a student. The garden behind the house had a tree, a flower and a small bird near the window.';
        d.appendChild(p);
      }
    });
    await page.waitForTimeout(1800);
    const dyn = await page.$$eval('#dynamic span.lim-w', (e) => e.length);
    check(dyn >= 1, `dynamically added content got ${dyn} replacements`);

    // 8. Intermediate level adds verbs/adjectives
    await setSettings({ difficulty: 'intermediate', density: 40 });
    await page.waitForTimeout(1500);
    const inter = await page.$$eval('span.lim-w', (els) => els.map((e) => e.dataset.limPos));
    check(inter.some((p) => p === 'v' || p === 'adj' || p === 'adv'), `intermediate includes verbs/adjectives (${inter.filter((p) => p !== 'n').length} of ${inter.length})`);

    // 9. Advanced level adds phrases
    let phrases = [];
    for (let i = 0; i < 4 && !phrases.length; i++) {
      await setSettings({ difficulty: 'advanced', density: 60 + i });
      await page.waitForTimeout(1500);
      phrases = await page.$$eval('span.lim-w[data-lim-pos="phrase"]', (els) => els.map((e) => `${e.dataset.limOrig}->${e.textContent}`));
    }
    check(phrases.length > 0, `advanced level replaces phrases (${phrases.join(', ')})`);

    // 10. Switch language to German
    await setSettings({ targetLang: 'de', difficulty: 'beginner', density: 20 });
    await page.waitForTimeout(1500);
    const deSpans = await page.$$eval('span.lim-w', (els) => els.map((e) => ({ t: e.textContent, o: e.dataset.limOrig, lang: e.lang })));
    check(deSpans.length > 0 && deSpans.every((s) => s.lang === 'de' && de.words[s.o.toLowerCase()] && de.words[s.o.toLowerCase()][0] === s.t),
      `switching to German re-renders with German nouns (${deSpans.slice(0, 5).map((s) => s.t).join(', ')})`);

    // 11. Selection lookup (dictionary fallback, no Translator API in this browser)
    await page.evaluate(() => {
      const target = [...document.querySelectorAll('p')].find((x) => x.textContent.includes('Practical notes') || x.textContent.includes('bring a map'));
      const tn = [...target.childNodes].find((n) => n.nodeType === 3 && n.data.includes('map'));
      const i = tn.data.indexOf('map');
      const r = document.createRange();
      r.setStart(tn, i); r.setEnd(tn, i + 3);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await page.mouse.move(300, 300);
    await page.dispatchEvent('body', 'mouseup');
    const hasTranslator = await page.evaluate(() => 'Translator' in self);
    const pill = page.locator('lim-ui .pill');
    let pillOk = false;
    try { await pill.waitFor({ timeout: 2000 }); pillOk = true; } catch (e) { /* none */ }
    check(pillOk, `selection shows a Translate button (${hasTranslator ? 'Translator API' : 'dictionary lookup'})`);
    if (pillOk && !hasTranslator) {
      await pill.click();
      const res = await page.locator('lim-ui .card .result').innerText();
      check(res.trim() === 'Karte', `selection "map" translates to "${res.trim()}" via dictionary`);
    }

    // 12. Per-site disable reverts everything
    await setSettings({ disabledSites: ['127.0.0.1'] });
    await page.waitForTimeout(1000);
    const after = await page.$$eval('span.lim-w', (e) => e.length);
    const text = await page.evaluate(() => document.querySelector('article p').textContent);
    check(after === 0 && text.startsWith('Last summer my family decided to leave the city'), 'disabling the site restores the original text');

    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await ctx.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
