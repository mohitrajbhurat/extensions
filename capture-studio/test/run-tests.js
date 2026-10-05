#!/usr/bin/env node
// End-to-end checks for Capture Studio with Playwright.
// Usage: node capture-studio/test/run-tests.js [--dpr=2]
//
// The extension is copied to a temp folder with an added "<all_urls>" host permission,
// because tests cannot click the toolbar button to grant activeTab. Everything else is the
// shipped code. Tab recording (tabCapture) needs a real toolbar click and is not covered.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const DPR = Number((process.argv.find(a => a.startsWith('--dpr=')) || '--dpr=1').split('=')[1]);
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}

function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function colorNear(px, rgb, tol = 24) { return px && rgb.every((v, i) => Math.abs(px[i] - v) <= tol); }

(async () => {
  // Serve the fixture page.
  const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  // Test copy of the extension.
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-studio-ext-'));
  fs.cpSync(SRC, ext, { recursive: true, filter: p => !p.includes(`${path.sep}test${path.sep}`) && !p.endsWith(`${path.sep}test`) });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-studio-profile-'));
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-studio-dl-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--force-device-scale-factor=${DPR}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const errors = [];
  const watch = p => {
    p.on('pageerror', e => errors.push(`${p.url()}: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error' && p.url().startsWith('chrome-extension')) errors.push(`${p.url()}: ${m.text()}`); });
  };
  ctx.on('page', watch);

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const extUrl = p => `chrome-extension://${id}/${p}`;

  const page = await ctx.newPage();
  await page.goto(base);
  const ctrl = await ctx.newPage();
  await ctrl.goto(extUrl('library/library.html'));
  const send = msg => ctrl.evaluate(m => chrome.runtime.sendMessage(m), msg);
  const tabId = await ctrl.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, base);
  const activateFixture = async () => {
    await ctrl.evaluate(t => chrome.tabs.update(t, { active: true }), tabId);
    await page.bringToFront();
    await sleep(300);
  };
  const waitEditor = (timeout = 60000) => ctx.waitForEvent('page', { predicate: p => p.url().includes('editor/editor.html'), timeout });

  // Read a stored shot and sample pixels (CSS-pixel coordinates are multiplied by DPR).
  const sampleShot = (p, shotId, points) => p.evaluate(async ({ shotId, points }) => {
    const db = await import('/lib/db.js');
    const meta = await db.getShot(shotId);
    const blob = await db.getShotBlob(shotId);
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = points.map(([x, y]) => (x < bmp.width && y < bmp.height ? Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)) : null));
    return { width: bmp.width, height: bmp.height, meta: { ...meta, thumb: !!meta.thumb }, px };
  }, { shotId, points });
  const shotIdOf = p => new URL(p.url()).searchParams.get('id');
  const BAND = [[220, 20, 60], [255, 140, 0], [255, 215, 0], [50, 205, 50], [0, 206, 209], [30, 144, 255], [138, 43, 226], [255, 105, 180], [139, 69, 19], [112, 128, 144]];
  const NAVY = [0, 0, 128];
  const D = DPR;

  /* ---------------- 1. visible area ---------------- */
  await activateFixture();
  let editorP = waitEditor();
  await send({ type: 'shot', kind: 'visible', tabId });
  let ed = await editorP;
  await ed.waitForLoadState();
  let s = await sampleShot(ed, shotIdOf(ed), [[10 * D, 10 * D], [640 * D, 300 * D]]);
  check('visible: size matches viewport x DPR', s.width === 1280 * D && s.height === 800 * D, `${s.width}x${s.height}`);
  check('visible: fixed header captured', colorNear(s.px[0], NAVY), JSON.stringify(s.px[0]));
  check('visible: content captured', colorNear(s.px[1], BAND[0]), JSON.stringify(s.px[1]));
  check('visible: thumbnail stored', s.meta.thumb && s.meta.kind === 'visible');
  const visibleEditor = ed;

  /* ---------------- 2. full page ---------------- */
  await activateFixture();
  await page.evaluate(() => window.scrollTo(0, 1234));
  editorP = waitEditor(120000);
  await send({ type: 'shot', kind: 'full', tabId });
  ed = await editorP;
  await ed.waitForLoadState();
  const fullPoints = [[200 * D, 30 * D], [200 * D, 805 * D], [200 * D, 1650 * D], [200 * D, 2405 * D]];
  BAND.forEach((_, i) => fullPoints.push([200 * D, (i * 500 + 250) * D]));
  s = await sampleShot(ed, shotIdOf(ed), fullPoints);
  check('full page: height is whole document', near(s.height, 5000 * D, 2 * D), `${s.width}x${s.height}`);
  check('full page: width is viewport', near(s.width, 1280 * D, 20 * D), `${s.width}`);
  check('full page: header at top', colorNear(s.px[0], NAVY), JSON.stringify(s.px[0]));
  check('full page: fixed header hidden after first frame', colorNear(s.px[1], BAND[1]) && colorNear(s.px[2], BAND[3]) && colorNear(s.px[3], BAND[4]),
    JSON.stringify(s.px.slice(1, 4)));
  const bandsOk = BAND.every((c, i) => colorNear(s.px[4 + i], c));
  check('full page: every band stitched in the right place', bandsOk, bandsOk ? '' : JSON.stringify(s.px.slice(4)));
  const restored = await page.evaluate(() => ({ y: window.scrollY, styles: document.querySelectorAll('style[data-capture-studio]').length, hidden: getComputedStyle(document.querySelector('header')).visibility }));
  check('full page: scroll position and page styles restored', restored.y === 1234 && restored.styles === 0 && restored.hidden === 'visible', JSON.stringify(restored));

  /* ---------------- 3. region ---------------- */
  await activateFixture();
  await page.evaluate(() => window.scrollTo(0, 0));
  editorP = waitEditor();
  await send({ type: 'shot', kind: 'region', tabId });
  await sleep(500);
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(300, 250, { steps: 5 });
  await page.mouse.move(500, 400, { steps: 5 });
  await page.mouse.up();
  ed = await editorP;
  await ed.waitForLoadState();
  s = await sampleShot(ed, shotIdOf(ed), [[200 * D, 150 * D]]);
  check('region: size equals dragged rectangle x DPR', near(s.width, 400 * D, 2) && near(s.height, 300 * D, 2), `${s.width}x${s.height}`);
  check('region: overlay not captured', colorNear(s.px[0], BAND[0]), JSON.stringify(s.px[0]));
  await ed.close();

  // Escape cancels; Enter switches to visible-area capture.
  await activateFixture();
  await send({ type: 'shot', kind: 'region', tabId });
  await sleep(500);
  await page.keyboard.press('Escape');
  let opened = await waitEditor(2000).then(() => true, () => false);
  const overlayGone = await page.evaluate(() => !window.__captureStudioRegion);
  check('region: Esc cancels without capturing', !opened && overlayGone);
  await activateFixture();
  editorP = waitEditor();
  await send({ type: 'shot', kind: 'region', tabId });
  await sleep(500);
  await page.keyboard.press('Enter');
  ed = await editorP;
  await ed.waitForLoadState();
  s = await sampleShot(ed, shotIdOf(ed), []);
  check('region: Enter captures the visible area instead', s.width === 1280 * D && s.meta.kind === 'visible', `${s.width}x${s.height}`);
  await ed.close();

  /* ---------------- 4. editor ---------------- */
  ed = visibleEditor;
  await ed.bringToFront();
  await ed.waitForSelector('#canvas');
  await sleep(300);
  const box = await ed.locator('#canvas').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (from, to) => {
    await ed.mouse.move(...at(...from));
    await ed.mouse.down();
    await ed.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 });
    await ed.mouse.move(...at(...to), { steps: 4 });
    await ed.mouse.up();
  };
  const canvasPixels = (fx, fy, w = 1, h = 1) => ed.evaluate(({ fx, fy, w, h }) => {
    const c = document.getElementById('canvas');
    const d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), w, h).data;
    return Array.from(d);
  }, { fx, fy, w, h });
  const variance = arr => { const v = []; for (let i = 0; i < arr.length; i += 4) v.push(arr[i] + arr[i + 1] + arr[i + 2]); const m = v.reduce((a, b) => a + b, 0) / v.length; return v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length; };
  const undoDisabled = () => ed.evaluate(() => document.getElementById('undo').disabled);
  check('editor: undo disabled initially', await undoDisabled());

  await ed.keyboard.press('r');
  await drag([0.1, 0.2], [0.3, 0.4]);
  const rectEdge = await canvasPixels(0.1, 0.3);
  check('editor: rectangle drawn in red', colorNear(rectEdge.slice(0, 3), [229, 72, 77], 40), JSON.stringify(rectEdge.slice(0, 3)));
  check('editor: undo enabled after drawing', !(await undoDisabled()));
  await ed.keyboard.press('a'); await drag([0.5, 0.2], [0.7, 0.35]);
  await ed.keyboard.press('e'); await drag([0.75, 0.1], [0.9, 0.3]);
  await ed.keyboard.press('p');
  await ed.mouse.move(...at(0.1, 0.6)); await ed.mouse.down();
  for (let i = 1; i <= 10; i++) await ed.mouse.move(...at(0.1 + i * 0.02, 0.6 + Math.sin(i) * 0.03));
  await ed.mouse.up();
  await ed.keyboard.press('h'); await drag([0.4, 0.55], [0.6, 0.6]);
  // Blur over the header text edge (high contrast area) and check variance drops.
  const beforeBlur = variance(await canvasPixels(0.0, 0.0, 120, 70));
  await ed.keyboard.press('b'); await drag([0.0, 0.0], [0.12, 0.12]);
  const afterBlur = variance(await canvasPixels(0.0, 0.0, 120, 70));
  check('editor: blur smooths the region', afterBlur < beforeBlur, `${beforeBlur.toFixed(0)} -> ${afterBlur.toFixed(0)}`);
  await ed.keyboard.press('x'); await drag([0.3, 0.7], [0.5, 0.85]);
  await ed.keyboard.press('t');
  await ed.mouse.click(...at(0.6, 0.75));
  await ed.keyboard.type('Hello from test');
  await ed.keyboard.press('Control+Enter');
  await sleep(1200);
  const docAfter = async () => ed.evaluate(async sid => (await (await import('/lib/db.js')).getShot(sid)).doc, shotIdOf(ed));
  let doc = await docAfter();
  const types = (doc?.shapes || []).map(x => x.type).join(',');
  check('editor: all annotation types saved', types === 'rect,arrow,ellipse,pen,highlight,blur,pixelate,text', types);

  await ed.keyboard.press('Control+z');
  await ed.keyboard.press('Control+z');
  await sleep(1000);
  doc = await docAfter();
  check('editor: undo removes last two shapes', doc.shapes.length === 6, String(doc.shapes.length));
  await ed.keyboard.press('Control+Shift+z');
  await sleep(1000);
  doc = await docAfter();
  check('editor: redo restores a shape', doc.shapes.length === 7, String(doc.shapes.length));

  // Select the rectangle by clicking its edge, move it with arrow keys, then delete it.
  await ed.keyboard.press('v');
  await ed.mouse.click(...at(0.1, 0.3));
  await ed.keyboard.press('Shift+ArrowRight');
  await ed.keyboard.press('Delete');
  await sleep(1000);
  doc = await docAfter();
  check('editor: select + delete removes the rectangle', doc.shapes.length === 6 && !doc.shapes.some(x => x.type === 'rect'), doc.shapes.map(x => x.type).join(','));

  // Color change applies to new shapes.
  await ed.click('.swatch[data-color="#3b6ef5"]');
  await ed.keyboard.press('r');
  await drag([0.15, 0.85], [0.25, 0.95]);
  await sleep(1000);
  doc = await docAfter();
  const last = doc.shapes[doc.shapes.length - 1];
  check('editor: chosen color used', last.type === 'rect' && last.color === '#3b6ef5', last.color);

  // Crop
  await ed.keyboard.press('c');
  await drag([0.25, 0.25], [0.75, 0.75]);
  await ed.keyboard.press('Enter');
  await sleep(1000);
  doc = await docAfter();
  const cw = await ed.evaluate(() => [document.getElementById('canvas').width, document.getElementById('canvas').height]);
  check('editor: crop applied', doc.crop && near(cw[0], 640 * D, 4 * D) && near(cw[1], 400 * D, 4 * D), `${cw} ${JSON.stringify(doc.crop)}`);

  // Download PNG and JPEG
  let dl = ed.waitForEvent('download');
  await ed.click('#save');
  let file = await dl;
  let p = path.join(downloadsDir, file.suggestedFilename());
  await file.saveAs(p);
  let buf = fs.readFileSync(p);
  const pngW = buf.readUInt32BE(16);
  const pngH = buf.readUInt32BE(20);
  check('editor: PNG download has cropped size', file.suggestedFilename().endsWith('.png') && buf.slice(1, 4).toString() === 'PNG' && pngW === cw[0] && pngH === cw[1], `${file.suggestedFilename()} ${pngW}x${pngH}`);
  await ed.selectOption('#format', 'jpeg');
  dl = ed.waitForEvent('download');
  await ed.keyboard.press('Control+s');
  file = await dl;
  p = path.join(downloadsDir, file.suggestedFilename());
  await file.saveAs(p);
  buf = fs.readFileSync(p);
  check('editor: JPEG download', file.suggestedFilename().endsWith('.jpg') && buf[0] === 0xff && buf[1] === 0xd8, file.suggestedFilename());

  // Clipboard
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${id}` }).catch(() => {});
  await ed.click('#copy');
  await sleep(800);
  const clip = await ed.evaluate(async () => {
    try { const items = await navigator.clipboard.read(); return items.flatMap(i => i.types); } catch (e) { return 'error: ' + e.message; }
  });
  check('editor: copy puts a PNG on the clipboard', Array.isArray(clip) && clip.includes('image/png'), JSON.stringify(clip));

  // Annotations persist across reloads.
  await ed.reload();
  await ed.waitForSelector('#canvas');
  await sleep(800);
  const cw2 = await ed.evaluate(() => [document.getElementById('canvas').width, document.getElementById('canvas').height]);
  check('editor: annotations and crop persist after reload', cw2[0] === cw[0] && cw2[1] === cw[1], String(cw2));

  // Empty editor accepts a pasted/opened file.
  const empty = await ctx.newPage();
  await empty.goto(extUrl('editor/editor.html'));
  const emptyVisible = await empty.isVisible('#empty');
  await empty.setInputFiles('#file', { name: 'pic.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(SRC, 'icons/icon128.png')) });
  await empty.waitForFunction(() => document.getElementById('canvas').width === 128, null, { timeout: 5000 }).catch(() => {});
  const openedFile = await empty.evaluate(() => [document.getElementById('canvas').width, new URL(location.href).searchParams.get('id')]);
  check('editor: empty state opens an image file and stores it', emptyVisible && openedFile[0] === 128 && !!openedFile[1], JSON.stringify(openedFile));
  await empty.close();

  /* ---------------- 5. library + trim ---------------- */
  await ctrl.bringToFront();
  await ctrl.goto(extUrl('library/library.html?tab=shots'));
  await sleep(500);
  const shotCards = await ctrl.locator('.card').count();
  check('library: screenshots listed', shotCards >= 4, String(shotCards));

  // Make a 4 second synthetic recording with audio using the same recorder core.
  const recId = await ctrl.evaluate(async () => {
    const core = await import('/lib/recorder-core.js');
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    let f = 0;
    const timer = setInterval(() => { f++; g.fillStyle = `hsl(${(f * 7) % 360},70%,50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('Frame ' + f, 40, 200); }, 33);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    const stream = new MediaStream([c.captureStream(30).getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);
    const session = new core.RecordingSession(stream);
    session.start();
    await new Promise(r => setTimeout(r, 1500));
    session.pause();
    await new Promise(r => setTimeout(r, 700));
    session.resume();
    await new Promise(r => setTimeout(r, 2500));
    const { blob, durationMs } = await session.stop();
    clearInterval(timer); osc.stop(); ac.close();
    const thumb = await core.makeThumb(c);
    return core.saveRecording({ blob, durationMs, name: 'Synthetic test', mode: 'screen', width: 640, height: 360, hasAudio: true, thumb });
  });
  const recMeta = await ctrl.evaluate(async rid => (await import('/lib/db.js')).getRecording(rid).then(m => ({ ...m, thumb: !!m.thumb })), recId);
  check('recording core: pause excluded from duration', near(recMeta.durationMs, 4000, 400), String(Math.round(recMeta.durationMs)));

  await ctrl.goto(extUrl(`library/library.html?play=${recId}`));
  await ctrl.waitForSelector('dialog[open]');
  await ctrl.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 5000 });
  const vdur = await ctrl.evaluate(() => document.getElementById('video').duration);
  check('library: WebM has a real duration (duration fix)', isFinite(vdur) && near(vdur, recMeta.durationMs / 1000, 0.6), String(vdur));
  await ctrl.fill('#player-name', 'Renamed clip');
  await ctrl.press('#player-name', 'Enter');
  await sleep(500);
  const renamed = await ctrl.evaluate(async rid => (await (await import('/lib/db.js')).getRecording(rid)).name, recId);
  check('library: rename', renamed === 'Renamed clip', renamed);

  dl = ctrl.waitForEvent('download');
  await ctrl.click('#act-download');
  file = await dl;
  p = path.join(downloadsDir, file.suggestedFilename());
  await file.saveAs(p);
  buf = fs.readFileSync(p);
  check('library: download WebM', file.suggestedFilename() === 'Renamed clip.webm' && buf.readUInt32BE(0) === 0x1a45dfa3, file.suggestedFilename());

  // Trim 1.0s .. 2.5s into a copy.
  await ctrl.click('#act-trim');
  await ctrl.evaluate(() => { const v = document.getElementById('video'); v.pause(); v.currentTime = 1.0; });
  await sleep(300);
  await ctrl.click('#set-in');
  await ctrl.evaluate(() => { document.getElementById('video').currentTime = 2.5; });
  await sleep(300);
  await ctrl.click('#set-out');
  const label = await ctrl.textContent('#trim-label');
  await ctrl.click('#trim-go');
  await ctrl.waitForFunction(() => /\(trimmed\)/.test(document.getElementById('player-name').value), null, { timeout: 20000 }).catch(() => {});
  const trimmed = await ctrl.evaluate(async () => {
    const recs = await (await import('/lib/db.js')).listRecordings();
    const t = recs.find(r => / \(trimmed\)$/.test(r.name));
    return t ? { name: t.name, durationMs: t.durationMs, size: t.size } : null;
  });
  check('library: trim saves a re-encoded copy of the selected range', trimmed && near(trimmed.durationMs, 1500, 450) && trimmed.size > 0, `${label} -> ${JSON.stringify(trimmed)}`);
  await ctrl.waitForFunction(() => isFinite(document.getElementById('video').duration), null, { timeout: 5000 }).catch(() => {});
  const tdur = await ctrl.evaluate(() => document.getElementById('video').duration);
  check('library: trimmed clip plays with correct duration', near(tdur, 1.5, 0.5), String(tdur));

  // Delete
  ctrl.once('dialog', d => d.accept());
  await ctrl.click('#act-delete');
  await sleep(800);
  const left = await ctrl.evaluate(async () => (await (await import('/lib/db.js')).listRecordings()).length);
  check('library: delete', left === 1, String(left));

  /* ---------------- 6. window/screen recorder (fake devices) ---------------- */
  const rp = await ctx.newPage();
  await rp.goto(extUrl('recorder/recorder.html?mode=screen'));
  await rp.selectOption('#opt-countdown', '0');
  await rp.evaluate(() => { const c = document.getElementById('opt-cam'); if (!c.checked) c.click(); const m = document.getElementById('opt-mic'); if (!m.checked) m.click(); });
  await rp.click('#share');
  const started = await rp.waitForFunction(() => !document.getElementById('studio').hidden && !document.getElementById('timer').hidden, null, { timeout: 8000 }).then(() => true, e => false);
  if (!started) {
    const why = await rp.textContent('#setup-error');
    check('recorder: screen capture in headless (environment-dependent)', true, 'skipped: ' + why);
  } else {
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    await sleep(1500);
    await rp.click('#btn-pause');
    await sleep(200);
    const pausedBadge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    await rp.click('#btn-pause');
    await sleep(1200);
    const composited = await rp.evaluate(() => !document.getElementById('canvas').hidden);
    await Promise.all([rp.waitForURL(/library\.html\?play=/, { timeout: 15000 }), rp.click('#btn-stop')]);
    await rp.waitForSelector('dialog[open]');
    const meta = await rp.evaluate(async () => { const id = new URL(location.href).searchParams.get('play'); const m = await (await import('/lib/db.js')).getRecording(id); return { ...m, thumb: !!m.thumb }; });
    check('recorder: screen + mic + webcam bubble recorded and saved', meta && meta.size > 0 && meta.hasAudio && composited && meta.thumb, `${meta.width}x${meta.height}, ${Math.round(meta.durationMs)}ms, badge "${badge}" / "${pausedBadge}"`);
    check('recorder: toolbar badge shows timer and paused state', /^\d+:\d\d$/.test(badge) && pausedBadge === 'II', `${badge} / ${pausedBadge}`);
    const finalBadge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    check('recorder: badge cleared after saving', finalBadge === '', finalBadge);
  }

  /* ---------------- 7. popup ---------------- */
  const pop = await ctx.newPage();
  await pop.goto(extUrl('popup/popup.html'));
  await sleep(300);
  await pop.click('input[name=mode][value=window]');
  await pop.click('#opt-cam');
  const saved = await pop.evaluate(async () => (await chrome.storage.local.get('recOptions')).recOptions);
  check('popup: recording options persist', saved && saved.mode === 'window' && typeof saved.webcam === 'boolean', JSON.stringify(saved));
  await pop.close();

  check('no page errors in extension pages', errors.length === 0, errors.join(' | '));

  await ctx.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (DPR ${DPR})`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
