// Import / export of macros as JSON. Also understands Ui.Vision (Selenium IDE style) JSON macros.
import { normalizeMacro } from './storage.js';
import { uid } from './commands.js';

export function exportMacros(macros) {
  return JSON.stringify({
    format: 'web-automator',
    version: 1,
    exported: new Date().toISOString(),
    macros: macros.map(m => ({ name: m.name, steps: m.steps.map(({ id, ...s }) => s), csv: m.csv || null, schedule: m.schedule ? { ...m.schedule, enabled: false } : null })),
  }, null, 2);
}

const UIV_MAP = {
  open: 'open', click: 'click', clickandwait: 'click', clickat: 'click', doubleclick: 'doubleClick',
  type: 'type', sendkeys: 'typeKeys', select: 'select', selectandwait: 'select',
  check: 'check', uncheck: 'uncheck', submit: 'submit', mouseover: 'hover',
  pause: 'pause', waitforelementpresent: 'waitForElement', waitforvisible: 'waitForVisible', waitforelementvisible: 'waitForVisible',
  waitforelementnotpresent: 'waitForGone',
  asserttext: 'assertText', verifytext: 'assertText', assertelementpresent: 'assertExists', verifyelementpresent: 'assertExists',
  asserttitle: 'assertTitle', verifytitle: 'assertTitle',
  storetext: 'extract', storeattribute: 'extract', store: 'set', echo: 'echo', capturescreenshot: 'screenshot',
  else: 'else', end: 'end', times: 'loop', break: 'break', refresh: 'refresh',
};

function convertUiVisionTarget(t) {
  if (!t) return '';
  if (/^link=/.test(t)) return 'text=' + t.slice(5);
  if (/^linkText=/.test(t)) return 'text=' + t.slice(9);
  return t; // id=, name=, css=, xpath= are understood natively
}

function fromUiVision(obj) {
  const steps = [];
  for (const c of obj.Commands || []) {
    const name = String(c.Command || '').toLowerCase();
    let command = UIV_MAP[name];
    let target = c.Target || '';
    let value = c.Value || '';
    if (!command) {
      steps.push({ command: 'echo', target: '', value: `Unsupported Ui.Vision command: ${c.Command} ${target} ${value}`.trim(), disabled: true, comment: 'Imported but not supported' });
      continue;
    }
    if (name === 'store') { command = 'set'; [target, value] = [value, target]; }
    if (name === 'times') { value = target; target = ''; }
    if (name === 'storeattribute') {
      const at = target.lastIndexOf('@');
      if (at > 0) { value = `${value}@${target.slice(at + 1)}`; target = target.slice(0, at); }
    }
    if (name === 'pause') { value = value || target; target = ''; }
    target = command === 'open' || command === 'set' ? target : convertUiVisionTarget(target);
    const targets = [target, ...((c.Targets || []).map(convertUiVisionTarget))].filter(Boolean);
    steps.push({ command, target, targets: [...new Set(targets)], value: String(value).replace(/\$\{!?(\w+)\}/g, '${$1}') });
  }
  return normalizeMacro({ name: obj.Name || 'Imported macro', steps });
}

/** Parses JSON text into a list of normalized (new-id) macros. Throws on invalid input. */
export function parseImport(text) {
  const data = JSON.parse(text);
  let list;
  if (data && data.format === 'web-automator' && Array.isArray(data.macros)) list = data.macros.map(m => normalizeMacro({ ...m, id: undefined }));
  else if (data && Array.isArray(data.Commands)) list = [fromUiVision(data)];
  else if (Array.isArray(data)) list = data.map(m => (m && Array.isArray(m.Commands) ? fromUiVision(m) : normalizeMacro({ ...m, id: undefined })));
  else if (data && Array.isArray(data.steps)) list = [normalizeMacro({ ...data, id: undefined })];
  else throw new Error('Not a recognised macro file (expected Web Automator or Ui.Vision JSON).');
  for (const m of list) { m.id = uid(); if (m.schedule) m.schedule.enabled = false; }
  return list;
}
