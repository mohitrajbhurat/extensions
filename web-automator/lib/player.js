// Macro player. Runs in the service worker and drives the page agent in the target tab.
import { COMMANDS, analyzeBlocks, uid } from './commands.js';
import { getMacro, getSettings, saveRun, SPEED_DELAY } from './storage.js';
import { parseCSV } from './csv.js';
import { interpolate, matchText } from './vars.js';
import { ensureAgent, sendToTab, waitForTabSettled, isNavigating } from './tabs.js';

const active = new Map();      // runId -> run state (in-memory)
let keepAlive = 0;

class StopSignal extends Error { constructor(reason) { super(reason || 'Stopped'); this.stop = true; } }
class BreakSignal extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function activeRuns() {
  return [...active.values()].map(summary);
}

export function summary(run) {
  return {
    id: run.id, macroId: run.macroId, macroName: run.macroName, status: run.status, trigger: run.trigger,
    started: run.started, ended: run.ended, tabId: run.tabId, stepIndex: run.stepIndex, total: run.total,
    csvRow: run.csvRow, csvRows: run.csvRows, paused: !!run.paused, speed: run.speed, error: run.error || '',
    extractedCount: run.extracted.length, screenshotCount: run.screenshots.length,
  };
}

function broadcast(run, entry) {
  chrome.runtime.sendMessage({ type: 'wa:runEvent', run: summary(run), entry }).catch(() => {});
}

function log(run, level, msg, stepIndex) {
  const entry = { t: Date.now(), level, msg: String(msg).slice(0, 2000), step: stepIndex };
  run.log.push(entry);
  if (run.log.length > 3000) run.log.splice(0, run.log.length - 3000);
  broadcast(run, entry);
  persistSoon(run);
}

function persistSoon(run) {
  if (run._persistTimer) return;
  run._persistTimer = setTimeout(() => { run._persistTimer = 0; saveRun(serialize(run)).catch(() => {}); }, 800);
}

function serialize(run) {
  const { _persistTimer, vars, paused, stopRequested, ...rest } = run;
  return JSON.parse(JSON.stringify(rest));
}

function startKeepAlive() {
  if (keepAlive) return;
  // Calling an extension API periodically keeps the MV3 service worker alive during long runs.
  keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}
function stopKeepAlive() {
  if (active.size === 0 && keepAlive) { clearInterval(keepAlive); keepAlive = 0; }
}

function setBadge() {
  const running = [...active.values()].some(r => r.status === 'running');
  chrome.storage.session.get('rec').then(({ rec }) => {
    if (rec) return; // recorder owns the badge
    chrome.action.setBadgeText({ text: running ? 'RUN' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  });
}

export function control(runId, action, arg) {
  const run = active.get(runId);
  if (!run) return false;
  if (action === 'pause') { run.paused = true; log(run, 'info', 'Paused'); }
  else if (action === 'resume') { run.paused = false; log(run, 'info', 'Resumed'); }
  else if (action === 'stop') { run.stopRequested = true; run.paused = false; }
  else if (action === 'speed') { run.speed = arg; broadcast(run); }
  return true;
}

async function checkControl(run) {
  while (run.paused && !run.stopRequested) await sleep(150);
  if (run.stopRequested) throw new StopSignal('Stopped by user');
}

async function interruptibleSleep(run, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await checkControl(run);
    await sleep(Math.min(200, end - Date.now()));
  }
}

function ctx(run) {
  const loop = run.loopStack.length ? run.loopStack[run.loopStack.length - 1] : null;
  return {
    ...run.vars,
    row: run.innerRow || run.row || {},
    loop: loop ? { index: loop.i + 1, count: loop.n } : { index: 0, count: 0 },
    run: { csvRow: run.csvRow || 0, id: run.id, macro: run.macroName },
  };
}

function interp(run, s, idx) {
  const missing = new Set();
  const out = interpolate(s, ctx(run), missing);
  if (missing.size) log(run, 'warn', `Unknown variable(s): ${[...missing].join(', ')} (replaced with empty text)`, idx);
  return out;
}

function storeExtract(run, name, value) {
  run.vars[name] = value;
  if (!run.currentRow) run.currentRow = {};
  if (Object.prototype.hasOwnProperty.call(run.currentRow, name)) {
    run.extracted.push(run.currentRow);
    run.currentRow = {};
  }
  run.currentRow[name] = Array.isArray(value) ? value.join(' | ') : value;
}
function flushExtractRow(run) {
  if (run.currentRow && Object.keys(run.currentRow).length) run.extracted.push(run.currentRow);
  run.currentRow = null;
}

function describe(step, targets, value) {
  const meta = COMMANDS[step.command];
  let s = step.command;
  if (meta && meta.target !== 'none' && targets[0]) s += ` ${targets[0]}`;
  if (value !== '' && step.command !== 'type' && step.command !== 'typeKeys') s += ` = ${value}`;
  else if (value !== '') s += ` = "${value.length > 40 ? value.slice(0, 40) + '…' : value}"`;
  return s;
}

const CLICKY = new Set(['click', 'doubleClick', 'pressKey', 'submit']);

async function domStep(run, step, targets, value, idx, extra = {}) {
  const settings = run.settings;
  const timeout = extra.timeout ?? settings.stepTimeout;
  let lastErr = '';
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    await checkControl(run);
    if (attempt > 0) {
      log(run, 'warn', `Retry ${attempt}/${settings.retries}: ${lastErr}`, idx);
      await interruptibleSleep(run, 400 * attempt);
    }
    await ensureAgent(run.tabId);
    let res;
    try {
      res = await sendToTab(run.tabId, { type: 'wa:exec', step: { command: extra.command || step.command, targets, value }, timeout: attempt > 0 ? Math.min(timeout, 5000) : timeout, highlight: settings.highlight }, timeout + 8000);
    } catch (e) {
      const msg = e.message || String(e);
      if (CLICKY.has(step.command) && /closed|receiving end|navigat|back\/forward cache/i.test(msg)) res = { ok: true, navigated: true };
      else res = { ok: false, error: msg, transient: true };
    }
    if (res && res.ok) {
      if (res.fallback) log(run, 'warn', `Primary selector failed; used fallback ${res.selector}`, idx);
      if (res.hidden) log(run, 'warn', 'Element was found but is not visible; acted on it anyway', idx);
      if (CLICKY.has(step.command) || step.command === 'select' || step.command === 'check') {
        await sleep(200);
        if (isNavigating(run.tabId) || (await chrome.tabs.get(run.tabId)).status === 'loading') {
          log(run, 'info', 'Waiting for page load…', idx);
          await waitForTabSettled(run.tabId, 45000);
        }
      }
      return res;
    }
    lastErr = (res && res.error) || 'Unknown error';
    if (res && res.fatal) break;
  }
  throw new Error(lastErr);
}

async function navigate(run, url, idx) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  await chrome.tabs.update(run.tabId, { url });
  await sleep(250);
  await waitForTabSettled(run.tabId, 60000);
  log(run, 'info', `Loaded ${url}`, idx);
}

async function screenshot(run, name, idx) {
  const tab = await chrome.tabs.get(run.tabId);
  if (!tab.active) { await chrome.tabs.update(run.tabId, { active: true }); await sleep(300); }
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const key = `shot:${run.id}:${run.screenshots.length}`;
  await chrome.storage.local.set({ [key]: dataUrl });
  run.screenshots.push({ key, name: name || `screenshot-${run.screenshots.length + 1}`, url: tab.url, t: Date.now(), step: idx });
  log(run, 'info', `Screenshot saved: ${name || key}`, idx);
}

async function execStep(run, step, idx) {
  const value = interp(run, step.value || '', idx);
  const rawTargets = [step.target, ...(step.targets || [])].filter(Boolean);
  const targets = [...new Set(rawTargets.map(t => interp(run, t, idx)))];
  log(run, 'step', describe(step, targets, value), idx);
  switch (step.command) {
    case 'open': return navigate(run, targets[0] || value, idx);
    case 'goBack': await chrome.tabs.goBack(run.tabId).catch(() => {}); await sleep(250); return waitForTabSettled(run.tabId, 45000);
    case 'refresh': await chrome.tabs.reload(run.tabId); await sleep(250); return waitForTabSettled(run.tabId, 45000);
    case 'pause': return interruptibleSleep(run, Math.max(0, parseInt(value, 10) || 1000));
    case 'set': {
      const name = (step.target || '').replace(/^\$\{|\}$/g, '').trim();
      if (!name) throw new Error('set needs a variable name in the target column');
      run.vars[name] = value;
      log(run, 'data', `${name} = ${value}`, idx);
      return;
    }
    case 'echo': log(run, 'data', value, idx); return;
    case 'screenshot': return screenshot(run, value, idx);
    case 'assertUrl':
    case 'assertTitle': {
      const tab = await chrome.tabs.get(run.tabId);
      const actual = step.command === 'assertUrl' ? tab.url : tab.title;
      if (!matchText(actual, value)) { const e = new Error(`Assertion failed: ${step.command === 'assertUrl' ? 'URL' : 'title'} "${actual}" does not contain "${value}"`); e.fatal = true; throw e; }
      return;
    }
    case 'stop': throw new StopSignal(value || 'Stop command reached');
    default: break;
  }
  const meta = COMMANDS[step.command];
  if (!meta) throw new Error(`Unknown command "${step.command}"`);
  const extra = {};
  if (/^(waitForElement|waitForVisible|waitForGone)$/.test(step.command) && value) extra.timeout = parseInt(value, 10) || undefined;
  const res = await domStep(run, step, targets, value, idx, extra);
  if (step.command === 'extract' || step.command === 'extractAll') {
    const name = (value.includes('@') ? value.slice(0, value.lastIndexOf('@')) : value).trim() || `value${idx + 1}`;
    storeExtract(run, name, res.data);
    const shown = Array.isArray(res.data) ? `[${res.data.length} items] ${res.data.slice(0, 5).join(' | ')}` : res.data;
    log(run, 'data', `${name} = ${String(shown).slice(0, 300)}`, idx);
  }
}

async function evalCondition(run, step, idx) {
  if (step.command === 'ifVar') {
    const actual = interp(run, step.target || '', idx);
    const expected = interp(run, step.value || '', idx);
    return expected === '' ? actual.trim() !== '' : matchText(actual, expected) || actual.trim() === expected.trim();
  }
  const rawTargets = [step.target, ...(step.targets || [])].filter(Boolean);
  const targets = [...new Set(rawTargets.map(t => interp(run, t, idx)))];
  const wait = parseInt(interp(run, step.value || '', idx), 10) || 0;
  const res = await domStep(run, step, targets, '', idx, { command: 'exists', timeout: wait });
  return step.command === 'ifNot' ? !res.data : !!res.data;
}

function parseRange(spec, len) {
  const m = /^\s*(\d+)?\s*(?:-\s*(\d+)?)?\s*$/.exec(spec || '');
  if (!m || (!m[1] && !m[2])) return [0, len];
  const from = Math.max(1, parseInt(m[1] || '1', 10));
  const to = spec.includes('-') ? Math.min(len, parseInt(m[2] || String(len), 10)) : from;
  return [from - 1, to];
}

async function execRange(run, steps, blocks) {
  let pc = run.fromStep || 0;
  run.fromStep = 0;
  while (pc < steps.length) {
    await checkControl(run);
    const step = steps[pc];
    run.stepIndex = pc;
    if (step.disabled) { pc++; continue; }
    const pair = blocks.pairs[pc];
    const t0 = Date.now();
    try {
      switch (step.command) {
        case 'if': case 'ifNot': case 'ifVar': {
          const cond = await evalCondition(run, step, pc);
          log(run, 'step', `${step.command} ${step.target} → ${cond ? 'true' : 'false'}`, pc);
          pc = cond ? pc + 1 : (pair.else !== undefined ? pair.else + 1 : pair.end + 1);
          continue;
        }
        case 'else': pc = pair.end + 1; continue;
        case 'loop': {
          const n = parseInt(interp(run, step.value || '', pc), 10) || 0;
          if (n <= 0) { pc = pair.end + 1; continue; }
          run.loopStack.push({ start: pc, end: pair.end, i: 0, n, kind: 'loop' });
          log(run, 'step', `loop 1/${n}`, pc);
          pc++; continue;
        }
        case 'csvLoop': {
          const rows = run.csvData.rows;
          if (!rows.length) { log(run, 'warn', 'csvLoop: no CSV data attached to this macro', pc); pc = pair.end + 1; continue; }
          const [from, to] = parseRange(interp(run, step.value || '', pc), rows.length);
          if (to <= from) { pc = pair.end + 1; continue; }
          run.loopStack.push({ start: pc, end: pair.end, i: 0, n: to - from, offset: from, kind: 'csv', saved: run.innerRow });
          run.innerRow = rows[from];
          log(run, 'step', `csvLoop row ${from + 1} (1/${to - from})`, pc);
          pc++; continue;
        }
        case 'break': {
          const top = run.loopStack.pop();
          if (!top) { log(run, 'warn', 'break outside of a loop ignored', pc); pc++; continue; }
          if (top.kind === 'csv') run.innerRow = top.saved;
          log(run, 'step', 'break', pc);
          pc = top.end + 1; continue;
        }
        case 'end': {
          const top = run.loopStack[run.loopStack.length - 1];
          if (top && top.end === pc) {
            top.i++;
            if (top.i < top.n) {
              if (top.kind === 'csv') {
                run.innerRow = run.csvData.rows[top.offset + top.i];
                log(run, 'step', `csvLoop row ${top.offset + top.i + 1} (${top.i + 1}/${top.n})`, top.start);
              } else log(run, 'step', `loop ${top.i + 1}/${top.n}`, top.start);
              pc = top.start + 1;
              await interruptibleSleep(run, SPEED_DELAY[run.speed] || 0);
              continue;
            }
            run.loopStack.pop();
            if (top.kind === 'csv') run.innerRow = top.saved;
          }
          pc++; continue;
        }
        default:
          await execStep(run, step, pc);
      }
      const ms = Date.now() - t0;
      if (ms > 1500) log(run, 'info', `done in ${(ms / 1000).toFixed(1)} s`, pc);
    } catch (e) {
      if (e.stop) throw e;
      log(run, 'error', `Step ${pc + 1} failed: ${e.message}`, pc);
      if (run.settings.onError === 'continue' && !e.fatal) { run.failures = (run.failures || 0) + 1; }
      else { e.stepIndex = pc; e.logged = true; throw e; }
    }
    pc++;
    const delay = SPEED_DELAY[run.speed] ?? 350;
    if (delay) await interruptibleSleep(run, delay);
  }
}

async function prepareTab(opts, settings) {
  if (opts.tabId) {
    const tab = await chrome.tabs.get(opts.tabId);
    if (opts.bringToFront ?? settings.bringToFront) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return { tabId: tab.id, created: false };
  }
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (!wins.length) {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' });
    return { tabId: win.tabs[0].id, created: true };
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: opts.trigger !== 'schedule' });
  return { tabId: tab.id, created: true };
}

/** Starts a run; resolves with the run id right away. The run continues in the background. */
export async function startRun(opts) {
  const macro = opts.macro || await getMacro(opts.macroId);
  if (!macro) throw new Error('Macro not found');
  const settings = await getSettings();
  const blocks = analyzeBlocks(macro.steps);
  if (!blocks.ok) throw new Error('Fix block structure first: ' + blocks.errors.map(e => `step ${e.index + 1}: ${e.message}`).join('; '));
  for (const r of active.values()) {
    if (opts.tabId && r.tabId === opts.tabId && r.status === 'running') throw new Error('Another macro is already running in this tab');
  }
  const csvData = macro.csv ? parseCSV(macro.csv.text) : { headers: [], rows: [] };
  if (opts.useCsv && !csvData.rows.length) throw new Error('This macro has no CSV rows attached');
  const { tabId, created } = await prepareTab(opts, settings);
  const run = {
    id: uid(), macroId: macro.id, macroName: macro.name, trigger: opts.trigger || 'manual',
    status: 'running', started: Date.now(), ended: 0, tabId, stepIndex: 0, total: macro.steps.length,
    csvRow: 0, csvRows: opts.useCsv ? csvData.rows.length : 0, speed: opts.speed || settings.speed,
    log: [], extracted: [], screenshots: [], error: '',
    settings: { ...settings, ...(opts.settings || {}) }, vars: {}, loopStack: [], csvData, fromStep: opts.fromStep || 0,
    paused: false, stopRequested: false, currentRow: null,
  };
  active.set(run.id, run);
  startKeepAlive();
  setBadge();
  log(run, 'info', `Started "${macro.name}" (${macro.steps.length} steps${opts.useCsv ? `, ${csvData.rows.length} CSV rows` : ''})`);
  (async () => {
    try {
      const iterations = opts.useCsv ? csvData.rows : [null];
      for (let i = 0; i < iterations.length; i++) {
        await checkControl(run);
        run.row = iterations[i];
        run.innerRow = null;
        run.loopStack = [];
        if (opts.useCsv) {
          run.csvRow = i + 1;
          log(run, 'info', `CSV row ${i + 1} of ${iterations.length}`);
          flushExtractRow(run);
        }
        try {
          await execRange(run, macro.steps, blocks);
        } catch (e) {
          if (e.stop || !opts.useCsv || run.settings.onError !== 'continue') throw e;
          run.failures = (run.failures || 0) + 1;
          log(run, 'warn', `Row ${i + 1} failed; continuing with next row`);
        }
      }
      flushExtractRow(run);
      run.status = run.failures ? 'warning' : 'passed';
      log(run, 'success', run.failures ? `Finished with ${run.failures} failed step(s)` : 'Macro completed successfully');
    } catch (e) {
      flushExtractRow(run);
      if (e.stop) {
        run.status = run.stopRequested ? 'stopped' : 'passed';
        log(run, run.stopRequested ? 'warn' : 'success', e.message);
      } else {
        run.status = 'failed';
        run.error = e.message;
        run.failedStep = e.stepIndex;
        if (!e.logged) log(run, 'error', e.message);
      }
    } finally {
      run.ended = Date.now();
      clearTimeout(run._persistTimer); run._persistTimer = 0;
      await saveRun(serialize(run)).catch(() => {});
      active.delete(run.id);
      broadcast(run, null);
      stopKeepAlive();
      setBadge();
      if (created && opts.closeTabAfter && run.status !== 'failed') chrome.tabs.remove(tabId).catch(() => {});
      if (run.trigger === 'schedule' || run.settings.notifyManual) notify(run);
      if (opts.onDone) opts.onDone(run);
    }
  })();
  return run.id;
}

function notify(run) {
  const secs = ((run.ended - run.started) / 1000).toFixed(1);
  const titles = { passed: 'completed', warning: 'completed with warnings', failed: 'failed', stopped: 'stopped' };
  let message = `${run.trigger === 'schedule' ? 'Scheduled run ' : ''}${titles[run.status] || run.status} in ${secs} s.`;
  if (run.extracted.length) message += ` ${run.extracted.length} data row(s) extracted.`;
  if (run.error) message += ` ${run.error.slice(0, 150)}`;
  chrome.notifications.create('run:' + run.id, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${run.macroName} ${titles[run.status] || run.status}`, message, priority: run.status === 'failed' ? 2 : 0,
  }).catch(() => {});
}
