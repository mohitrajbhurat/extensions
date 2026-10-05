#!/usr/bin/env node
// End-to-end check in headless Chromium: loads the extension, adds tasks through quick add,
// completes one, checks the badge, toggles widgets, sets a focus and exports a backup.
// Usage: node home-base/test/e2e.cjs [screenshot-dir]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const dir = path.resolve(__dirname, '..');
const shots = process.argv[2];
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); console.log('ok -', m); };

(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-e2e-')), {
    headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const errors = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    const url = (p) => `chrome-extension://${id}/${p}`;
    const watch = (page, name) => {
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    };

    // --- tasks page
    const tp = await ctx.newPage();
    watch(tp, 'tasks');
    await tp.goto(url('tasks/tasks.html#today'));
    await tp.waitForSelector('#quick-add');
    for (const t of ['Write report tomorrow 5pm p1 #work @focus', 'Water plants every day', 'Call the bank today', 'Plan trip next fri']) {
      await tp.fill('#quick-add', t);
      await tp.waitForTimeout(50);
      await tp.press('#quick-add', 'Enter');
      await tp.waitForTimeout(150);
    }
    const tasks = await sw.evaluate(async () => (await chrome.storage.local.get('tasks')).tasks);
    assert(tasks.length === 4, '4 tasks stored');
    const report = tasks.find((t) => t.title === 'Write report');
    assert(report && report.time === '17:00' && report.priority === 1 && report.labels[0] === 'focus', 'NL parse stored date/time/priority/label');
    const projects = await sw.evaluate(async () => (await chrome.storage.local.get('projects')).projects);
    assert(report.projectId === projects.find((p) => p.name === 'Work').id, 'project resolved to existing Work project');
    const water = tasks.find((t) => t.title === 'Water plants');
    assert(water.recur && water.recur.kind === 'daily', 'recurring task stored');

    await tp.waitForTimeout(400);
    const todayRows = await tp.locator('#list li.task').count();
    assert(todayRows === 2, `today view shows 2 tasks (got ${todayRows})`);
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    assert(badge === '2', `badge shows 2 (got "${badge}")`);

    // complete the recurring task -> rolls to tomorrow
    await tp.locator('li.task', { hasText: 'Water plants' }).locator('button.check').click();
    await tp.waitForTimeout(400);
    const water2 = (await sw.evaluate(async () => (await chrome.storage.local.get('tasks')).tasks)).find((t) => t.title === 'Water plants');
    assert(!water2.done && water2.date > water.date, 'recurring task rolled forward');

    // keyboard: select first, set priority 2, open editor, add subtask
    await tp.click('h1');
    await tp.keyboard.press('j');
    await tp.keyboard.press('2');
    await tp.waitForTimeout(200);
    await tp.keyboard.press('Enter');
    await tp.waitForSelector('dialog.editor-dialog[open]');
    await tp.fill('input[aria-label="New subtask"]', 'Bring ID');
    await tp.press('input[aria-label="New subtask"]', 'Enter');
    await tp.waitForTimeout(200);
    await tp.click('dialog.editor-dialog button[value="save"]');
    await tp.waitForTimeout(300);
    const all = await sw.evaluate(async () => (await chrome.storage.local.get('tasks')).tasks);
    const sub = all.find((t) => t.title === 'Bring ID');
    assert(sub && sub.parentId, 'subtask created from editor');
    assert(all.some((t) => !t.parentId && t.priority === 2), 'priority shortcut applied');

    // upcoming view + search
    await tp.goto(url('tasks/tasks.html#upcoming'));
    await tp.waitForTimeout(300);
    assert(await tp.locator('li.task', { hasText: 'Plan trip' }).count() === 1, 'upcoming shows next fri task');
    await tp.fill('#search', 'report');
    await tp.waitForTimeout(400);
    assert(await tp.locator('#list li.task').count() === 1, 'search finds 1 task');
    if (shots) { await tp.goto(url('tasks/tasks.html#today')); await tp.waitForTimeout(300); await tp.screenshot({ path: path.join(shots, 'tasks.png') }); }

    // --- new tab
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      settings.name = 'Sam';
      settings.widgets = { tasks: true, notes: true, calendar: true, clocks: true, habits: true, pomodoro: true };
      await chrome.storage.local.set({ settings, habits: [{ id: 'h1', name: 'Read', color: '#10b981', created: '2026-01-01', days: {} }] });
    });
    const nt = await ctx.newPage();
    watch(nt, 'newtab');
    await nt.goto(url('newtab/newtab.html'));
    await nt.waitForTimeout(600);
    assert((await nt.textContent('#greeting')).includes('Sam'), 'greeting uses name');
    assert((await nt.textContent('#quote-text')).length > 10, 'quote shown');
    assert(await nt.locator('.widget').count() === 6, 'six widgets visible');
    await nt.fill('.focus-input', 'Ship the release');
    await nt.press('.focus-input', 'Enter');
    await nt.waitForTimeout(300);
    await nt.click('.focus-check');
    await nt.waitForTimeout(300);
    const focus = await sw.evaluate(async () => (await chrome.storage.local.get('focus')).focus);
    assert(focus.text === 'Ship the release' && focus.done, 'focus saved and completed');
    await nt.click('.habit-check');
    await nt.waitForTimeout(200);
    const habits = await sw.evaluate(async () => (await chrome.storage.local.get('habits')).habits);
    assert(Object.keys(habits[0].days).length === 1, 'habit checked for today');
    await nt.click('.pomo-controls .btn.primary');
    await nt.waitForTimeout(300);
    const pomo = await sw.evaluate(async () => (await chrome.storage.local.get('pomodoro')).pomodoro);
    assert(pomo.running, 'pomodoro started');
    const alarm = await sw.evaluate(() => chrome.alarms.get('pomodoro'));
    assert(alarm, 'pomodoro alarm scheduled');
    // drag the notes widget
    const head = nt.locator('.widget[data-widget="notes"] .widget-title');
    const box = await head.boundingBox();
    await nt.mouse.move(box.x + 10, box.y + 5);
    await nt.mouse.down();
    await nt.mouse.move(box.x - 200, box.y + 100, { steps: 5 });
    await nt.mouse.up();
    await nt.waitForTimeout(200);
    const layout = await sw.evaluate(async () => (await chrome.storage.local.get('layout')).layout);
    assert(layout.notes && layout.notes.x > 0, 'widget position persisted');
    if (shots) await nt.screenshot({ path: path.join(shots, 'newtab.png') });

    // --- popup + options
    const pp = await ctx.newPage();
    watch(pp, 'popup');
    await pp.setViewportSize({ width: 420, height: 600 });
    await pp.goto(url('popup/popup.html'));
    await pp.waitForTimeout(400);
    assert(await pp.locator('#list li.task').count() >= 1, 'popup lists tasks');
    if (shots) await pp.screenshot({ path: path.join(shots, 'popup.png') });
    const op = await ctx.newPage();
    watch(op, 'options');
    await op.goto(url('options/options.html'));
    await op.waitForTimeout(400);
    await op.check('input[data-path="h24"]');
    await op.waitForTimeout(200);
    const s2 = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert(s2.h24 === true, 'options save settings');
    if (shots) await op.screenshot({ path: path.join(shots, 'options.png'), fullPage: true });
    const [download] = await Promise.all([op.waitForEvent('download'), op.click('#export')]);
    const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert(backup.app === 'home-base' && backup.data.tasks.length === all.length, 'backup export contains tasks');

    // reminders: a task due in 2 minutes gets an alarm
    await tp.goto(url('tasks/tasks.html#today'));
    const soon = new Date(Date.now() + 3 * 60000);
    const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
    if (soon.getDate() === new Date().getDate()) {
      await tp.fill('#quick-add', `Stretch today at ${hhmm}`);
      await tp.press('#quick-add', 'Enter');
      await tp.waitForTimeout(800);
      const alarms = await sw.evaluate(() => chrome.alarms.getAll());
      assert(alarms.some((a) => a.name.startsWith('rem:')), 'reminder alarm scheduled');
    }
    assert(!errors.length, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log('E2E PASS');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });
