#!/usr/bin/env node
// End-to-end test of the recorder and player against test/form.html.
// Usage: node web-automator/test/e2e.js   (needs Playwright and python3)
// The extension is copied to a temp dir with host_permissions granted up front, because
// headless Chromium cannot answer the optional-permission prompt.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-e2e-'));
  const extDir = path.join(tmp, 'ext');
  fs.cpSync(SRC, extDir, { recursive: true, filter: p => !p.includes(`${path.sep}test${path.sep}`) && !p.endsWith(`${path.sep}test`) });
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: __dirname, stdio: 'ignore' });
  await sleep(800);

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    const errors = [];
    // close the welcome tab, open a control page (popup) to talk to the background
    await sleep(500);
    for (const p of ctx.pages()) if (p.url().includes('editor.html')) await p.close();
    const ctl = await ctx.newPage();
    ctl.on('pageerror', e => errors.push(e.message));
    await ctl.goto(`chrome-extension://${id}/popup/popup.html`);
    const bg = msg => ctl.evaluate(m => chrome.runtime.sendMessage(m), msg);
    const storage = key => ctl.evaluate(k => chrome.storage.local.get(k).then(o => o[k]), key);
    const tabIdOf = url => ctl.evaluate(u => chrome.tabs.query({}).then(ts => (ts.find(t => t.url && t.url.startsWith(u)) || {}).id), url);

    // ------------------------------------------------------------ RECORDER
    console.log('Recorder');
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('page: ' + e.message));
    await page.goto(`${BASE}/form.html`);
    const tabId = await tabIdOf(`${BASE}/form.html`);
    const st = await bg({ type: 'wa:startRecording', tabId });
    check('recording starts', st && st.ok, JSON.stringify(st));
    await sleep(300);
    await page.click('#fullName');
    await page.keyboard.type('Ada Lovelace');
    await page.fill('[data-testid=email-input]', 'ada@example.com');
    await page.click('#r9f8a7b6c5d4');
    await page.keyboard.type('Analytical Engines');
    await page.focus('#plan');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.click('text=I accept the terms');
    await page.check('input[value=phone]');
    await page.fill('#notes', 'Line one');
    await page.click('button[type=submit]');
    await page.waitForURL(/result\.html/);
    await sleep(600);
    await page.click('#again');
    await page.waitForURL(/form\.html/);
    await sleep(600);
    await page.fill('#fullName', 'Second page typing');
    await page.press('#fullName', 'Enter');
    await page.waitForURL(/result\.html/);
    await sleep(600);
    const stop = await bg({ type: 'wa:stopRecording' });
    check('recording stops and saves', stop && stop.ok && stop.result && stop.result.macroId, JSON.stringify(stop));
    const macros = await storage('macros');
    const rec = macros.find(m => m.id === stop.result.macroId);
    const cmds = rec.steps.map(s => `${s.command} ${s.target} ${s.value}`.trim());
    console.log('    recorded:\n      ' + cmds.join('\n      '));
    const has = (cmd, re, val) => rec.steps.some(s => s.command === cmd && (!re || re.test(s.target)) && (val === undefined || s.value === val));
    check('first step opens start URL', rec.steps[0].command === 'open' && rec.steps[0].target.endsWith('/form.html'));
    check('typing recorded as final value (id selector)', has('type', /^id=fullName$/, 'Ada Lovelace'));
    check('data-testid selector preferred', has('type', /data-testid="email-input"/, 'ada@example.com'));
    check('unstable id skipped, name used', has('type', /^name=company$/, 'Analytical Engines'));
    check('select recorded by label', has('select', /^id=plan$/, 'label=Professional'), JSON.stringify(rec.steps.filter(s => s.command === 'select')));
    check('checkbox recorded as check', has('check', /terms/));
    check('radio recorded', has('check', /phone/));
    check('textarea recorded', has('type', /^id=notes$/, 'Line one'));
    check('submit click recorded with text selector', rec.steps.some(s => s.command === 'click' && s.targets.some(t => t === 'text=Create account')));
    check('link click across page load recorded', has('click', /^id=again$/));
    check('Enter key recorded', has('pressKey', /fullName/, 'Enter'));
    check('multiple fallback selectors stored', rec.steps.filter(s => s.command === 'type').every(s => s.targets.length >= 2));
    check('no duplicate type steps', rec.steps.filter(s => s.command === 'type' && s.target === 'id=fullName').length === 2);

    // keystroke mode + scroll recording
    await ctl.evaluate(() => chrome.storage.local.set({ settings: { recordKeystrokes: true, recordScroll: true } }));
    await page.goto(`${BASE}/form.html`);
    await sleep(1000);
    await bg({ type: 'wa:startRecording', tabId });
    await sleep(900);
    await page.click('#fullName');
    await page.keyboard.type('Key by key');
    await page.keyboard.press('Tab');
    await page.mouse.wheel(0, 600);
    await sleep(1200);
    await page.click('#bottom');
    const stop2 = await bg({ type: 'wa:stopRecording' });
    await sleep(200); // let the trailing scroll be trimmed only if last
    await page.click('#fullName'); // no longer recording
    const rec2 = (await storage('macros')).find(m => m.id === stop2.result.macroId);
    const c2 = rec2.steps.map(s => `${s.command} ${s.target} ${s.value}`.trim());
    console.log('    keystroke-mode recording:\n      ' + c2.join('\n      '));
    check('keystroke mode records typeKeys', rec2.steps.some(s => s.command === 'typeKeys' && s.value === 'Key by key'));
    check('window scroll recorded', rec2.steps.some(s => s.command === 'scroll' && !s.target && /^0,\d+/.test(s.value) && s.value !== '0,0'));
    check('keystroke mode records Tab', rec2.steps.some(s => s.command === 'pressKey' && s.value === 'Tab'));
    await ctl.evaluate(() => chrome.storage.local.set({ settings: {} }));

    // ------------------------------------------------------------ PLAYER: replay recording
    console.log('Player: replay recorded macro');
    await page.goto(`${BASE}/result.html?reset=1`);
    const runOf = async runId => {
      for (let i = 0; i < 300; i++) {
        const runs = await storage('runs') || [];
        const r = runs.find(x => x.id === runId);
        if (r && r.status !== 'running') return r;
        await sleep(200);
      }
      return null;
    };
    let play = await bg({ type: 'wa:play', macroId: rec.id, tabId, speed: 'fast' });
    check('play starts', play && play.ok, JSON.stringify(play));
    let run = await runOf(play.runId);
    check('replay passes', run && run.status === 'passed', run && (run.error + '\n' + run.log.map(l => l.msg).join('\n')));
    check('replay ends on result page with Enter-submitted value', /result\.html\?fullName=Second\+page\+typing/.test(page.url()), page.url());
    const runs1 = await storage('runs');
    const log = runs1.find(r => r.id === play.runId).log.map(l => l.msg).join('\n');
    check('replay submitted the first form', /Loaded|result/.test(log));

    // ------------------------------------------------------------ PLAYER: command coverage
    console.log('Player: commands, variables, flow control, CSV');
    const step = (command, target = '', value = '', extra = {}) => ({ command, target, targets: target ? [target, ...(extra.fallbacks || [])] : [], value });
    const macro = {
      id: 'e2e-full', name: 'E2E full', created: Date.now(), updated: Date.now(),
      csv: { name: 'people.csv', text: 'name,email,plan\nGrace Hopper,grace@navy.mil,Enterprise\n"Lovelace, Ada",ada@example.com,Free\n' },
      steps: [
        step('open', `${BASE}/form.html`),
        step('waitForElement', 'text=Loaded later', '3000'),
        step('type', 'css=#does-not-exist', '${row.name}', { fallbacks: ['label=Full name'] }),
        step('typeKeys', 'testid=email-input', '${row.email}'),
        step('set', 'company', 'ACME ${row.plan}'),
        step('type', 'aria=Company name', '${company}'),
        step('select', 'id=plan', '${row.plan}'),
        step('check', 'id=terms'),
        step('check', 'css=input[name="contact"][value="email"]'),
        step('if', 'id=nothing-here'),
        step('type', 'id=notes', 'WRONG BRANCH'),
        step('else'),
        step('type', 'id=notes', 'right branch'),
        step('end'),
        step('scroll', '', 'bottom'),
        step('scroll', 'id=bottom'),
        step('click', 'text=Create account'),
        step('assertUrl', '', 'result.html'),
        step('assertText', 'css=td[data-field="fullName"]', '${row.name}'),
        step('extract', 'css=td[data-field="email"]', 'email'),
        step('extract', 'css=td[data-field="company"]', 'company'),
        step('extract', 'css=td[data-field="notes"]', 'notes'),
        step('extract', 'id=again', 'link@href'),
        step('loop', '', '2'),
        step('echo', '', 'iteration ${loop.index}'),
        step('end'),
        step('extractAll', 'css=ul.items li', 'items'),
        step('ifVar', '${items}', '/Beta/'),
        step('echo', '', 'has beta'),
        step('end'),
        step('screenshot', '', 'result-${row.name}'),
      ],
    };
    await ctl.evaluate(m => chrome.storage.local.get('macros').then(o => chrome.storage.local.set({ macros: [m, ...(o.macros || [])] })), macro);
    play = await bg({ type: 'wa:play', macroId: 'e2e-full', tabId, useCsv: true, speed: 'fast' });
    check('CSV run starts', play && play.ok, JSON.stringify(play));
    run = await runOf(play.runId);
    const logText = run ? run.log.map(l => `${l.level} ${l.msg}`).join('\n') : '';
    check('CSV run passes', run && run.status === 'passed', run && (run.error + '\n' + logText));
    check('one data row per CSV row', run && run.extracted.length === 2, JSON.stringify(run && run.extracted));
    if (run && run.extracted.length === 2) {
      const [a, b] = run.extracted;
      check('extracted email (typed by keystrokes)', a.email === 'grace@navy.mil' && b.email === 'ada@example.com', JSON.stringify(run.extracted));
      check('set variable interpolated', a.company === 'ACME Enterprise' && b.company === 'ACME Free');
      check('else branch taken', a.notes === 'right branch');
      check('attribute extraction', /form\.html$/.test(a.link));
      check('extractAll joined list', a.items === 'Alpha | Beta | Gamma');
    }
    check('fallback selector used and logged', /used fallback label=Full name/.test(logText));
    check('loop ran twice', /iteration 1/.test(logText) && /iteration 2/.test(logText));
    check('ifVar regex matched', /has beta/.test(logText));
    check('screenshots captured', run && run.screenshots.length === 2);
    check('CSV value with comma survived', /Lovelace, Ada/.test(logText));

    // ------------------------------------------------------------ PLAYER: failure + assertion
    console.log('Player: failures');
    const bad = { id: 'e2e-bad', name: 'E2E bad', created: 1, updated: 1, steps: [
      step('open', `${BASE}/result.html?fullName=X`),
      step('assertText', 'css=td[data-field="fullName"]', 'Y'),
      step('echo', '', 'should not run'),
    ] };
    await ctl.evaluate(m => chrome.storage.local.get('macros').then(o => chrome.storage.local.set({ macros: [m, ...(o.macros || [])] })), bad);
    await ctl.evaluate(() => chrome.storage.local.set({ settings: { stepTimeout: 1500, retries: 1 } }));
    play = await bg({ type: 'wa:play', macroId: 'e2e-bad', tabId, speed: 'fast' });
    run = await runOf(play.runId);
    check('failed assertion fails the run', run && run.status === 'failed' && /Assertion failed/.test(run.error), run && run.error);
    check('run stops at failing step', run && !run.log.some(l => /should not run/.test(l.msg)) && run.failedStep === 1);

    // stop control
    const slow = { id: 'e2e-slow', name: 'E2E slow', created: 1, updated: 1, steps: [step('pause', '', '20000'), step('echo', '', 'after pause')] };
    await ctl.evaluate(m => chrome.storage.local.get('macros').then(o => chrome.storage.local.set({ macros: [m, ...(o.macros || [])] })), slow);
    play = await bg({ type: 'wa:play', macroId: 'e2e-slow', tabId, speed: 'fast' });
    await sleep(600);
    const pauseRes = await bg({ type: 'wa:control', runId: play.runId, action: 'pause' });
    const state = await bg({ type: 'wa:getState' });
    check('pause reflected in state', pauseRes.ok && state.runs.some(r => r.id === play.runId && r.paused));
    await bg({ type: 'wa:control', runId: play.runId, action: 'stop' });
    run = await runOf(play.runId);
    check('stop ends run', run && run.status === 'stopped' && !run.log.some(l => /after pause/.test(l.msg)));

    // ------------------------------------------------------------ scheduling
    console.log('Scheduler');
    await ctl.evaluate(() => chrome.storage.local.get('macros').then(o => {
      const m = o.macros.find(x => x.id === 'e2e-full');
      m.schedule = { enabled: true, kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] };
      return chrome.storage.local.set({ macros: o.macros });
    }));
    await sleep(500);
    const alarms = await ctl.evaluate(() => chrome.alarms.getAll());
    const al = alarms.find(a => a.name === 'macro:e2e-full');
    const when = al && new Date(al.scheduledTime);
    check('daily alarm created at 07:30 on a weekday', al && when.getHours() === 7 && when.getMinutes() === 30 && when.getDay() >= 1 && when.getDay() <= 5, JSON.stringify(alarms));

    // ------------------------------------------------------------ editor renders macro
    console.log('Editor');
    const ed = await ctx.newPage();
    ed.on('pageerror', e => errors.push('editor: ' + e.message));
    await ed.goto(`chrome-extension://${id}/editor/editor.html?macro=e2e-full`);
    await ed.waitForSelector('#stepsBody tr');
    check('editor lists all steps', (await ed.locator('#stepsBody tr').count()) === macro.steps.length);
    await ed.click('#stepsBody tr:nth-child(3) .cell-in');
    check('details show fallbacks', (await ed.locator('#dFallbacks li').count()) === 2);
    await ed.click('#addStep');
    await sleep(600);
    const after = (await storage('macros')).find(m => m.id === 'e2e-full');
    check('adding a step autosaves', after.steps.length === macro.steps.length + 1);
    await ed.keyboard.press('Escape');
    await ed.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
    await ed.keyboard.press('Control+z');
    await sleep(600);
    const undone = (await storage('macros')).find(m => m.id === 'e2e-full');
    check('undo restores step count', undone.steps.length === macro.steps.length);

    check('no page errors', errors.length === 0, errors.join('\n'));
  } finally {
    await ctx.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
