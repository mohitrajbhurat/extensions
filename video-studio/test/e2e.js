#!/usr/bin/env node
// End-to-end check for Video Studio. Generates a WebM test video with canvas + MediaRecorder,
// serves it from a local http server (two origins so one copy is cross-origin and taints the
// canvas), loads the extension in Chromium and exercises speed keys, notes, screenshots,
// the tab-capture fallback, loops, bookmarks, the panel and the library exports.
// Usage: node video-studio/test/e2e.js   (needs Playwright, like tools/smoke-test.js)
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const EXT_SRC = path.resolve(__dirname, '..');
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'test') continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const GEN_HTML = `<!doctype html><canvas id=c width=320 height=180></canvas><script>
window.makeVideo = async (seconds) => {
  const c = document.getElementById('c'); const ctx = c.getContext('2d');
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 400000 });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  const start = performance.now(); let raf;
  const draw = () => { const t = (performance.now() - start) / 1000;
    ctx.fillStyle = 'hsl(' + (t * 40 % 360) + ',70%,45%)'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 48px sans-serif'; ctx.fillText(t.toFixed(1) + 's', 90, 110);
    ctx.fillRect((t * 60) % 320, 150, 40, 20); raf = requestAnimationFrame(draw); };
  draw(); rec.start(250);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  rec.stop(); cancelAnimationFrame(raf);
  await new Promise((r) => rec.onstop = r);
  const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
</script>`;

function indexHtml(port) {
  return `<!doctype html><html><head><title>Lecture 1: Test video</title></head><body style="margin:0;font-family:sans-serif">
<h1 style="font-size:16px;margin:8px">Test lecture</h1>
<video id="v1" src="video.webm" muted playsinline width="640" height="360" style="display:block;background:#000"></video>
<p>Text below</p><input id="txt" placeholder="type here">
<script>
// MediaRecorder WebM files have no duration until the end has been read once.
const v1 = document.getElementById('v1');
v1.addEventListener('loadedmetadata', function fix() {
  if (v1.duration === Infinity) {
    v1.currentTime = 1e9;
    v1.addEventListener('durationchange', function back() { if (v1.duration !== Infinity) { v1.removeEventListener('durationchange', back); v1.currentTime = 0; window.durationFixed = true; } });
  } else window.durationFixed = true;
}, { once: true });
// A cross-origin video inside a shadow root, added later.
setTimeout(() => {
  customElements.define('my-player', class extends HTMLElement {
    constructor() { super(); const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = '<video id="v2" muted playsinline width="480" height="270" src="http://127.0.0.1:${port}/video.webm" style="display:block;background:#000"></video>'; }
  });
  document.body.appendChild(document.createElement('my-player'));
}, 800);
</script></body></html>`;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-e2e-'));
  const site = path.join(tmp, 'site');
  fs.mkdirSync(site);
  // Test copy of the extension with host access so the tab-capture fallback works without a prompt.
  const ext = path.join(tmp, 'ext');
  copyDir(EXT_SRC, ext);
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions = manifest.permissions.concat('tabs');
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    const file = path.join(site, p === '/' ? 'index.html' : p);
    if (!file.startsWith(site) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const data = fs.readFileSync(file);
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.webm') ? 'video/webm' : 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Number(range[2]) : data.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
      res.end(data);
    }
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  fs.writeFileSync(path.join(site, 'gen.html'), GEN_HTML);
  fs.writeFileSync(path.join(site, 'index.html'), indexHtml(port));

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    channel: 'chromium',
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = sw.url().split('/')[2];
    const extUrl = (p) => `chrome-extension://${extId}/${p}`;

    // 1. Generate the test video.
    const gen = await ctx.newPage();
    await gen.goto(`http://localhost:${port}/gen.html`);
    const b64 = await gen.evaluate(() => window.makeVideo(8));
    fs.writeFileSync(path.join(site, 'video.webm'), Buffer.from(b64, 'base64'));
    await gen.close();
    check('generated WebM test video', b64.length > 10000, { bytes: Math.round(b64.length * 0.75) });

    // Shorter seek step so rewind/advance fit in an 8 second video.
    const opts = await ctx.newPage();
    await opts.goto(extUrl('options/options.html'));
    await opts.evaluate(() => chrome.storage.sync.set({ settings: { seekSeconds: 2, openPanelOnNote: true, panelMode: 'inpage' } }));

    // 2. Open the lecture page.
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('page: ' + e.message));
    await page.goto(`http://localhost:${port}/index.html`);
    await page.waitForFunction(() => window.durationFixed === true, null, { timeout: 15000 });
    await page.evaluate(() => document.getElementById('v1').play());
    await sleep(600);
    check('overlay host injected', await page.evaluate(() => !!document.querySelector('video-studio-overlay')));

    const rate = () => page.evaluate(() => document.getElementById('v1').playbackRate);
    await page.click('h1');
    await page.keyboard.press('d');
    check('D increases speed to 1.1', Math.abs((await rate()) - 1.1) < 0.001, await rate());
    for (let i = 0; i < 4; i++) await page.keyboard.press('d');
    check('D x4 more gives 1.5', Math.abs((await rate()) - 1.5) < 0.001, await rate());
    await page.keyboard.press('s');
    check('S decreases to 1.4', Math.abs((await rate()) - 1.4) < 0.001, await rate());
    await page.keyboard.press('r');
    check('R resets to 1.0', (await rate()) === 1, await rate());
    await page.keyboard.press('r');
    check('R again restores 1.4', Math.abs((await rate()) - 1.4) < 0.001, await rate());
    await page.keyboard.press('g');
    check('G jumps to preferred 1.8', Math.abs((await rate()) - 1.8) < 0.001, await rate());
    await page.keyboard.press('g');
    check('G toggles back to 1.4', Math.abs((await rate()) - 1.4) < 0.001, await rate());
    await page.focus('#txt');
    await page.keyboard.press('d');
    check('keys ignored while typing in an input', Math.abs((await rate()) - 1.4) < 0.001 && (await page.inputValue('#txt')) === 'd');
    await page.click('h1');
    for (let i = 0; i < 25; i++) await page.keyboard.press('s');
    check('speed clamps at 0.07x minimum', Math.abs((await rate()) - 0.07) < 0.001, await rate());

    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, `http://localhost:${port}/index.html`);
    const tabMsg = (msg) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m, { frameId: 0 }), [tabId, msg]);
    let st = await tabMsg({ type: 'vs-set-rate', rate: 99 });
    check('speed clamps at 16x maximum', st.rate === 16, st.rate);
    st = await tabMsg({ type: 'vs-set-rate', rate: 1.25 });

    // Seek keys.
    await page.evaluate(() => { const v = document.getElementById('v1'); v.pause(); v.currentTime = 4; });
    await sleep(200);
    await page.keyboard.press('z');
    await sleep(200);
    const tz = await page.evaluate(() => document.getElementById('v1').currentTime);
    check('Z rewinds 2s', Math.abs(tz - 2) < 0.3, tz);
    await page.keyboard.press('x');
    await sleep(200);
    const tx = await page.evaluate(() => document.getElementById('v1').currentTime);
    check('X advances 2s', Math.abs(tx - 4) < 0.3, tx);

    // 3. Shadow DOM video, dynamically added.
    st = await tabMsg({ type: 'vs-get-state' });
    check('dynamically added shadow-DOM video detected', st.videoCount === 2, st.videoCount);
    check('canonical key for the page', st.key === `url:http://localhost:${port}/index.html`, st.key);

    // 4. Notes from the page.
    await page.keyboard.press('n');
    await sleep(800);
    check('N opens the in-page notes panel', await page.evaluate(() => !!document.querySelector('video-studio-panel')));
    await page.keyboard.press('p');
    await sleep(1000);
    await page.keyboard.press('b');
    await sleep(500);

    const lib = await ctx.newPage();
    await lib.goto(extUrl('library/library.html'));
    const dbq = (fn, arg) => lib.evaluate(async ([src, a]) => { const db = await import('/lib/db.js'); return (0, eval)(src)(db, a); }, [fn.toString(), arg]);
    let notes = await dbq((db, k) => db.getNotes(k), st.key);
    check('N created a note stamped at the current time', notes.length >= 1 && Math.abs(notes[0].t - 4) < 0.3, notes.map((n) => n.t));
    const shot = notes.find((n) => n.image);
    check('P created a note with a JPEG frame screenshot', !!shot && shot.image.startsWith('data:image/jpeg'), shot && shot.image.length);
    let video = await dbq((db, k) => db.getVideo(k), st.key);
    check('B created a bookmark', video && video.bookmarks.length === 1, video && video.bookmarks);
    check('video record has title and thumbnail', video && video.title === 'Lecture 1: Test video' && /^data:image/.test(video.thumb || ''), video && video.title);

    // 5. Loop A-B.
    await tabMsg({ type: 'vs-set-loop', a: 1, b: 2, on: true });
    await page.evaluate(() => document.getElementById('v1').play());
    await sleep(2500);
    const tl = await page.evaluate(() => document.getElementById('v1').currentTime);
    check('A-B loop keeps playback between 1s and 2s', tl >= 0.95 && tl <= 2.15, tl);
    await page.keyboard.press('Backslash');
    st = await tabMsg({ type: 'vs-get-state' });
    check('backslash toggles loop off', st.loop.on === false);
    await page.evaluate(() => document.getElementById('v1').pause());

    // 6. Cross-origin video: canvas is tainted, tab capture fallback works.
    await page.evaluate(() => {
      document.getElementById('v1').pause();
      const v2 = document.querySelector('my-player').shadowRoot.querySelector('video');
      v2.scrollIntoView();
      return v2.play();
    });
    await sleep(800);
    await page.bringToFront();
    st = await tabMsg({ type: 'vs-get-state' });
    check('active video switches to the shadow-DOM video when it plays', st.time > 0 && st.paused === false);
    const direct = await tabMsg({ type: 'vs-capture-frame', allowTab: false });
    check('cross-origin frame capture reports tainted canvas', direct.ok === false && direct.reason === 'tainted', direct.reason);
    const viaTab = await tabMsg({ type: 'vs-capture-tab' });
    check('tab-capture fallback returns a cropped JPEG', viaTab.ok === true && /^data:image\/jpeg/.test(viaTab.image || ''), viaTab.reason || viaTab.message);
    if (viaTab.ok) {
      const dims = await lib.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); return [i.width, i.height]; }, viaTab.image);
      check('fallback image is cropped to the video (480x270)', Math.abs(dims[0] - 480) <= 2 && Math.abs(dims[1] - 270) <= 2, dims);
    }
    await page.evaluate(() => document.querySelector('my-player').shadowRoot.querySelector('video').pause());

    // 7. Notes panel (as embedded panel page pointed at the tab).
    await page.evaluate(() => { const v = document.getElementById('v1'); v.play(); });
    await sleep(300);
    await page.evaluate(() => { const v = document.getElementById('v1'); v.pause(); v.currentTime = 3; });
    const panel = await ctx.newPage();
    panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
    panel.on('console', (m) => { if (m.type() === 'error') errors.push('panel console: ' + m.text()); });
    await panel.goto(extUrl(`sidepanel/panel.html?tab=${tabId}&embedded=1`));
    await panel.waitForSelector('#player:not([hidden])', { timeout: 5000 });
    check('panel shows the video title', (await panel.textContent('#video-title')) === 'Lecture 1: Test video');
    await panel.waitForFunction(() => document.querySelectorAll('#notes > li').length >= 2);
    check('panel lists the existing notes', (await panel.$$('#notes > li')).length === notes.length);
    await panel.fill('#note-text', 'Key idea: **gradient descent** converges, see 0:01');
    await panel.click('#btn-save');
    await panel.waitForFunction((n) => document.querySelectorAll('#notes > li').length === n + 1, notes.length);
    const strong = await panel.$eval('#notes', (el) => !!el.querySelector('strong') && !!el.querySelector('a.ts[data-t="1"]'));
    check('composer saves a Markdown note (bold + timestamp link rendered)', strong);
    await panel.click('#notes a.ts[data-t="1"]');
    await sleep(400);
    const tSeek = await page.evaluate(() => document.getElementById('v1').currentTime);
    check('clicking a timestamp in a note seeks the video', Math.abs(tSeek - 1) < 0.3, tSeek);
    await panel.click('#notes > li:first-child .ts-btn');
    await sleep(400);
    const tSeek2 = await page.evaluate(() => document.getElementById('v1').currentTime);
    check('clicking a note time seeks the video', Math.abs(tSeek2 - notes[0].t) < 0.3, tSeek2);
    await panel.click('#btn-faster');
    await sleep(300);
    check('panel speed button changes speed', Math.abs((await rate()) - 1.35) < 0.001, await rate());
    await panel.click('#tab-chapters');
    await panel.fill('#bm-label', 'Introduction');
    await panel.click('#bm-add');
    await panel.waitForFunction(() => document.querySelectorAll('#chapters > li').length === 2);
    check('panel adds a named bookmark', true);
    const dl = panel.waitForEvent('download');
    await panel.click('#btn-export');
    const md = fs.readFileSync(await (await dl).path(), 'utf8');
    check('panel exports Markdown with timestamp links', md.includes('# Lecture 1: Test video') && /\[0:0\d\]\(http:\/\/localhost:\d+\/index\.html#vst=\d\)/.test(md) && md.includes('Introduction'));

    // 8. Library: search, exports, JSON backup and import.
    await lib.reload();
    await lib.waitForSelector('#video-list li[data-id]');
    check('library lists the video', (await lib.$$('#video-list li[data-id]')).length === 1);
    await lib.fill('#q', 'gradient');
    await lib.waitForSelector('#results:not([hidden]) .r-hit');
    check('library search finds the note text', (await lib.textContent('#results')).includes('gradient'));
    await lib.click('#results .r-hit');
    await lib.waitForSelector('#detail:not([hidden])');
    const dlHtml = lib.waitForEvent('download');
    await lib.click('#d-html');
    const html = fs.readFileSync(await (await dlHtml).path(), 'utf8');
    check('HTML export contains screenshots and timestamp links', html.includes('<img src="data:image/jpeg') && html.includes('#vst='));
    const dlJson = lib.waitForEvent('download');
    await lib.click('#btn-export-all');
    const jsonPath = await (await dlJson).path();
    const backup = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    check('JSON backup contains videos and notes', backup.app === 'video-studio' && backup.videos.length === 1 && backup.notes.length === notes.length + 1);
    await dbq((db) => db.clearAll());
    await sleep(300);
    await lib.setInputFiles('#import-file', { name: 'backup.json', mimeType: 'application/json', buffer: fs.readFileSync(jsonPath) });
    await sleep(800);
    const restored = await dbq((db) => db.allNotes());
    check('JSON import restores all notes', restored.length === backup.notes.length, restored.length);
    const print = await ctx.newPage();
    await print.goto(extUrl('library/print.html?id=' + encodeURIComponent(st.key)));
    await print.waitForSelector('#frame:not([hidden])');
    check('print view renders the notes', (await print.frameLocator('#frame').locator('.note').count()) === backup.notes.length);

    // 9. Speed remembered per site, and #vst deep links.
    await page.goto(`http://localhost:${port}/index.html#vst=5`);
    await page.waitForFunction(() => window.durationFixed === true, null, { timeout: 15000 });
    await sleep(800);
    const r2 = await page.evaluate(() => document.getElementById('v1').playbackRate);
    check('speed is remembered for the site after reload', Math.abs(r2 - 1.35) < 0.001, r2);
    const t5 = await page.evaluate(() => document.getElementById('v1').currentTime);
    check('#vst=5 deep link seeks to 5s', Math.abs(t5 - 5) < 0.5, t5);
  } catch (e) {
    check('test run completed without exceptions', false, String(e && e.stack || e));
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (errors.length) check('no page errors', false, errors);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
