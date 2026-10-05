// Recording state machine (service worker side). State lives in chrome.storage.session so it
// survives service-worker restarts during a long recording.
import { getMacro, getSettings, saveMacro } from './storage.js';
import { uid } from './commands.js';
import { ensureAgent, sendToTab, isRestrictedUrl } from './tabs.js';

async function getRec() { return (await chrome.storage.session.get('rec')).rec || null; }
async function setRec(rec) {
  if (rec) await chrome.storage.session.set({ rec });
  else await chrome.storage.session.remove('rec');
  chrome.runtime.sendMessage({ type: 'wa:recState', rec: rec ? { tabId: rec.tabId, count: rec.steps.length, appendTo: rec.appendTo || null } : null }).catch(() => {});
  updateBadge(rec);
}
function updateBadge(rec) {
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  chrome.action.setBadgeText({ text: rec ? (rec.steps.length > 99 ? 'REC' : String(rec.steps.length)) : '' });
  chrome.action.setTitle({ title: rec ? 'Web Automator: recording (click to stop)' : 'Web Automator' });
}

export async function recordingState() {
  const rec = await getRec();
  return rec ? { tabId: rec.tabId, count: rec.steps.length, appendTo: rec.appendTo || null, startUrl: rec.startUrl } : null;
}

async function injectRecorder(tabId, rec) {
  await ensureAgent(tabId);
  await sendToTab(tabId, { type: 'wa:startRecording', opts: { keystrokes: rec.keystrokes, recordScroll: rec.recordScroll, count: rec.steps.length } }, 3000);
}

export async function startRecording({ tabId, appendTo } = {}) {
  if (await getRec()) throw new Error('Already recording');
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('No active tab');
    tabId = tab.id;
  }
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) throw new Error('Recording is not possible on browser pages. Open a website first.');
  const settings = await getSettings();
  const rec = {
    tabId, appendTo: appendTo || null, startUrl: tab.url, started: Date.now(),
    keystrokes: settings.recordKeystrokes, recordScroll: settings.recordScroll,
    steps: [{ id: uid(), command: 'open', target: tab.url, targets: [tab.url], value: '', comment: '', disabled: false }],
  };
  await injectRecorder(tabId, rec);
  await setRec(rec);
  return recordingState();
}

export async function stopRecording() {
  const rec = await getRec();
  if (!rec) return null;
  await setRec(null);
  try { await sendToTab(rec.tabId, { type: 'wa:stopRecording' }, 1500); } catch { /* tab may be gone */ }
  // drop a trailing scroll step recorded while moving towards the Stop button
  while (rec.steps.length > 1 && rec.steps[rec.steps.length - 1].command === 'scroll' && !rec.steps[rec.steps.length - 1].target) rec.steps.pop();
  if (rec.appendTo) {
    const m = await getMacro(rec.appendTo);
    if (m) {
      const extra = m.steps.length ? rec.steps.slice(1) : rec.steps;
      m.steps.push(...extra);
      const saved = await saveMacro(m);
      return { macroId: saved.id, added: extra.length };
    }
  }
  let host = '';
  try { host = new URL(rec.startUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const d = new Date();
  const name = `${host || 'Recording'} ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const saved = await saveMacro({ name, steps: rec.steps });
  return { macroId: saved.id, added: rec.steps.length };
}

export async function onRecordStep(step, sender) {
  const rec = await getRec();
  if (!rec || !sender.tab || sender.tab.id !== rec.tabId || sender.frameId !== 0) return { count: rec ? rec.steps.length : 0, ignored: true };
  const last = rec.steps[rec.steps.length - 1];
  const s = { id: uid(), command: step.command, target: step.target || '', targets: step.targets || [], value: step.value || '', comment: step.comment || '', disabled: false };
  if (last && (s.command === 'type' || s.command === 'typeKeys') && last.command === s.command && last.target === s.target) {
    last.value = s.value;
  } else if (last && s.command === 'scroll' && !s.target && last.command === 'scroll' && !last.target) {
    last.value = s.value;
  } else if (s.command === 'doubleClick') {
    for (let k = 0; k < 2; k++) {
      const l = rec.steps[rec.steps.length - 1];
      if (l && l.command === 'click' && l.target === s.target) rec.steps.pop();
    }
    rec.steps.push(s);
  } else {
    rec.steps.push(s);
  }
  await setRec(rec);
  return { count: rec.steps.length };
}

/** Called on main-frame navigation commits in the recorded tab. */
export async function onCommitted(details) {
  if (details.frameId !== 0) return;
  const rec = await getRec();
  if (!rec || details.tabId !== rec.tabId) return;
  const q = details.transitionQualifiers || [];
  const t = details.transitionType;
  let step = null;
  if (q.includes('forward_back')) step = { command: 'open', target: details.url };
  else if (t === 'reload') step = { command: 'refresh', target: '' };
  else if (['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page'].includes(t) || q.includes('from_address_bar')) step = { command: 'open', target: details.url };
  if (!step) return;
  const last = rec.steps[rec.steps.length - 1];
  if (last && last.command === step.command && last.target === step.target) return;
  rec.steps.push({ id: uid(), command: step.command, target: step.target, targets: step.target ? [step.target] : [], value: '', comment: '', disabled: false });
  await setRec(rec);
}

/** Re-injects the recorder after each page load in the recorded tab. */
export async function onPageReady(details) {
  if (details.frameId !== 0) return;
  const rec = await getRec();
  if (!rec || details.tabId !== rec.tabId) return;
  try { await injectRecorder(details.tabId, rec); } catch { /* restricted page; ignore */ }
}

export async function onTabRemoved(tabId) {
  const rec = await getRec();
  if (rec && rec.tabId === tabId) await stopRecording();
}

export async function restoreBadge() { updateBadge(await getRec()); }
