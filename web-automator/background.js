// Web Automator service worker: message router, recorder, player and scheduler wiring.
import * as recorder from './lib/recorder.js';
import { startRun, control, activeRuns } from './lib/player.js';
import { trackNavigation, ensureAgent, sendToTab } from './lib/tabs.js';
import { syncAlarms, rearm, macroIdFromAlarm, alarmTimes } from './lib/scheduler.js';
import { getMacros, getMacro, saveMacro, getRuns, saveRun } from './lib/storage.js';
import { newStep } from './lib/commands.js';

const ALL_SITES = { origins: ['<all_urls>'] };
const hasSiteAccess = () => chrome.permissions.contains(ALL_SITES);

// ---------------------------------------------------------------- listeners (registered synchronously)
trackNavigation();
chrome.webNavigation.onCommitted.addListener(d => { recorder.onCommitted(d).catch(() => {}); });
chrome.webNavigation.onDOMContentLoaded.addListener(d => { recorder.onPageReady(d).catch(() => {}); });
chrome.tabs.onRemoved.addListener(id => { recorder.onTabRemoved(id).catch(() => {}); });

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    const macros = await getMacros();
    if (!macros.length) await saveMacro(sampleMacro());
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html?welcome=1') });
  }
  await syncAlarms();
  await cleanupInterruptedRuns();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarms();
  await cleanupInterruptedRuns();
  recorder.restoreBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.macros) syncAlarms().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async alarm => {
  const id = macroIdFromAlarm(alarm.name);
  if (!id) return;
  const macro = await getMacro(id);
  if (!macro || !macro.schedule || !macro.schedule.enabled) return;
  await rearm(id, macro.schedule);
  if (!(await hasSiteAccess())) {
    chrome.notifications.create('perm:' + id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: `${macro.name} did not run`, message: 'Web Automator needs site access for scheduled runs. Open the editor to grant it.' });
    return;
  }
  try {
    await startRun({ macroId: id, trigger: 'schedule', useCsv: !!macro.schedule.useCsv, closeTabAfter: macro.schedule.closeTab !== false, bringToFront: false });
  } catch (e) {
    chrome.notifications.create('err:' + id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: `${macro.name} could not start`, message: e.message.slice(0, 200) });
  }
});

chrome.notifications.onClicked.addListener(id => {
  const [kind, ref] = id.split(':');
  const url = kind === 'run' ? `editor/editor.html?run=${encodeURIComponent(ref)}` : 'editor/editor.html';
  chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  chrome.notifications.clear(id);
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd === 'toggle-recording') {
    const rec = await recorder.recordingState();
    if (rec) {
      const r = await recorder.stopRecording();
      if (r) chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?macro=${r.macroId}`) });
    } else if (await hasSiteAccess()) {
      await recorder.startRecording().catch(e => notifyError('Could not start recording', e));
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html?welcome=1') });
    }
  } else if (cmd === 'open-editor') {
    openEditor();
  }
});

function notifyError(title, e) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: String(e.message || e).slice(0, 200) });
}

async function openEditor(query = '') {
  const base = chrome.runtime.getURL('editor/editor.html');
  const tabs = await chrome.tabs.query({ url: base + '*' }).catch(() => []);
  if (tabs.length && !query) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: base + query });
}

async function cleanupInterruptedRuns() {
  const runs = await getRuns();
  for (const r of runs) {
    if (r.status === 'running') { r.status = 'failed'; r.error = 'Interrupted (browser closed or extension reloaded)'; r.ended = r.ended || Date.now(); await saveRun(r); }
  }
}

function sampleMacro() {
  const s = (c, t, v, comment = '') => ({ ...newStep(c, t, v), comment });
  return {
    name: 'Example: read the example.com heading',
    steps: [
      s('open', 'https://example.com/', '', 'Navigate to the page'),
      s('waitForElement', 'css=h1', '5000'),
      s('extract', 'css=h1', 'heading', 'Saves the text into ${heading}'),
      s('extract', 'css=a', 'link@href'),
      s('assertText', 'css=h1', 'Example'),
      s('if', 'text=/More information|Learn more/', '', 'Branch on whether an element exists (text= accepts /regex/)'),
      s('echo', '', 'Found link: ${link}'),
      s('else'),
      s('echo', '', 'No link on this page'),
      s('end'),
      s('echo', '', 'Heading was "${heading}" at ${time}'),
    ],
  };
}

// ---------------------------------------------------------------- message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('wa:')) return;
  if (sender.id !== chrome.runtime.id) return;
  const fromExtensionPage = !sender.tab || (sender.url || '').startsWith(chrome.runtime.getURL(''));
  const handler = handlers[msg.type];
  if (!handler) return;
  if (!fromExtensionPage && !CONTENT_ALLOWED.has(msg.type)) return;
  Promise.resolve().then(() => handler(msg, sender)).then(
    r => sendResponse(r === undefined ? { ok: true } : r),
    e => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

const CONTENT_ALLOWED = new Set(['wa:recordStep', 'wa:stopRecording', 'wa:picked']);

const handlers = {
  'wa:getState': async () => ({
    ok: true,
    recording: await recorder.recordingState(),
    runs: activeRuns(),
    siteAccess: await hasSiteAccess(),
    alarms: await alarmTimes(),
  }),
  'wa:startRecording': async m => {
    if (!(await hasSiteAccess())) throw new Error('Site access is required. Click "Allow on all sites" first.');
    return { ok: true, recording: await recorder.startRecording({ tabId: m.tabId, appendTo: m.appendTo }) };
  },
  'wa:stopRecording': async (m, sender) => {
    const r = await recorder.stopRecording();
    if (r && sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) {
      // stopped from the in-page pill: show the result in the editor
      openEditor(`?macro=${r.macroId}`);
    }
    return { ok: true, result: r };
  },
  'wa:recordStep': (m, sender) => recorder.onRecordStep(m.step, sender),
  'wa:picked': () => ({ ok: true }), // editor pages receive this message directly
  'wa:play': async m => {
    if (!(await hasSiteAccess())) throw new Error('Site access is required. Click "Allow on all sites" first.');
    const runId = await startRun({ macroId: m.macroId, tabId: m.tabId, useCsv: !!m.useCsv, fromStep: m.fromStep || 0, speed: m.speed, bringToFront: m.bringToFront });
    return { ok: true, runId };
  },
  'wa:control': m => ({ ok: control(m.runId, m.action, m.arg) }),
  'wa:highlight': async m => {
    await ensureAgent(m.tabId);
    return sendToTab(m.tabId, { type: 'wa:highlight', targets: m.targets, timeout: 500 }, 5000);
  },
  'wa:pick': async m => {
    await ensureAgent(m.tabId);
    await chrome.tabs.update(m.tabId, { active: true });
    const tab = await chrome.tabs.get(m.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return sendToTab(m.tabId, { type: 'wa:pick' }, 5000);
  },
  'wa:openEditor': m => openEditor(m.query || ''),
  'wa:syncAlarms': async () => { await syncAlarms(); return { ok: true, alarms: await alarmTimes() }; },
};
