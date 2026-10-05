import { ICONS } from '../shared/icons.js';
import { COMMANDS, COMMAND_NAMES, analyzeBlocks, newStep, uid } from '../lib/commands.js';
import { getMacros, saveMacro, deleteMacro, getSettings, saveSettings, getRuns, clearRuns, normalizeMacro } from '../lib/storage.js';
import { parseCSV, toCSV } from '../lib/csv.js';
import { exportMacros, parseImport } from '../lib/importexport.js';
import { describeSchedule, nextOccurrence } from '../lib/scheduler.js';

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
const params = new URLSearchParams(location.search);

let macros = [];
let current = null;          // macro being edited (working copy)
let selected = -1;           // selected step index
let settings = null;
let siteAccess = false;
let saveTimer = 0;
let undoStack = [], redoStack = [];
let activeRun = null;        // summary of a live run for this macro
let viewRun = null;          // run being shown in Log / Data (full object)
let stepMarks = {};          // index -> 'ok' | 'fail' | 'running'
let pickFor = null;          // step id waiting for a picked selector
let myTabId = null;

// ---------------------------------------------------------------- helpers
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fmtDate(t) { return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'macro'; }

document.querySelectorAll('[data-icon]').forEach(b => {
  const icon = ICONS[b.dataset.icon];
  if (icon) b.insertAdjacentHTML('afterbegin', icon);
});

// ---------------------------------------------------------------- macro list
function renderMacroList() {
  const q = $('macroSearch').value.trim().toLowerCase();
  const ul = $('macroList');
  ul.textContent = '';
  for (const m of macros) {
    if (q && !m.name.toLowerCase().includes(q)) continue;
    const sub = el('div', { class: 'm-sub' }, `${m.steps.length} steps`);
    if (m.csv) sub.append(' · CSV');
    if (m.schedule && m.schedule.enabled) { const s = el('span', { title: describeSchedule(m.schedule), html: ICONS.clock }); sub.append(s); }
    const li = el('li', { role: 'option', tabindex: '0', 'aria-selected': current && current.id === m.id ? 'true' : 'false', 'data-id': m.id },
      el('div', { class: 'm-name', title: m.name }, m.name), sub);
    li.addEventListener('click', () => selectMacro(m.id));
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMacro(m.id); }
      if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling && li.nextElementSibling.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); li.previousElementSibling && li.previousElementSibling.focus(); }
    });
    ul.append(li);
  }
}

async function selectMacro(id, { keepSelection = false } = {}) {
  flushSave();
  const m = macros.find(x => x.id === id);
  current = m ? structuredClone(m) : null;
  if (!keepSelection) { selected = current && current.steps.length ? 0 : -1; undoStack = []; redoStack = []; stepMarks = {}; viewRun = null; }
  history.replaceState(null, '', current ? `?macro=${current.id}` : location.pathname);
  $('noMacro').hidden = !!current;
  $('workspace').hidden = !current;
  renderMacroList();
  if (!current) return;
  $('macroName').value = current.name;
  $('saveState').textContent = 'Saved';
  activeRun = null;
  const st = await send({ type: 'wa:getState' });
  if (st && st.ok) activeRun = st.runs.find(r => r.macroId === current.id && r.status === 'running') || null;
  renderSteps();
  renderDetails();
  renderCsv();
  renderSchedule(st && st.alarms);
  await renderRuns();
  if (!viewRun) {
    const runs = (await getRuns()).filter(r => r.macroId === current.id);
    viewRun = runs[0] || null;
  }
  renderRunView();
  renderRunControls();
}

// ---------------------------------------------------------------- saving & undo
function snapshot() {
  undoStack.push(JSON.stringify(current.steps));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(current.steps));
  current.steps = JSON.parse(undoStack.pop());
  selected = Math.min(selected, current.steps.length - 1);
  changed(false);
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(current.steps));
  current.steps = JSON.parse(redoStack.pop());
  changed(false);
}
function changed(rerender = true) {
  $('saveState').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
  if (rerender !== 'none') { renderSteps(); renderDetails(); }
}
async function flushSave() {
  if (!saveTimer || !current) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  const saved = await saveMacro(current);
  current.updated = saved.updated;
  const i = macros.findIndex(m => m.id === saved.id);
  if (i >= 0) macros[i] = saved; else macros.unshift(saved);
  $('saveState').textContent = 'Saved';
  renderMacroList();
}
window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });

// ---------------------------------------------------------------- steps table
const cmdOptionsHtml = (() => {
  const groups = {};
  for (const name of COMMAND_NAMES) (groups[COMMANDS[name].group] ||= []).push(name);
  return Object.entries(groups).map(([g, names]) => `<optgroup label="${g}">${names.map(n => `<option value="${n}">${n}</option>`).join('')}</optgroup>`).join('');
})();

function setTarget(step, value) {
  const old = step.target;
  step.target = value;
  const list = (step.targets || []).filter(t => t && t !== old && t !== value);
  step.targets = value ? [value, ...list] : list;
}

function renderSteps() {
  const tbody = $('stepsBody');
  tbody.textContent = '';
  const steps = current.steps;
  const blocks = analyzeBlocks(steps);
  const errIdx = new Map(blocks.errors.map(e => [e.index, e.message]));
  $('blockErrors').hidden = blocks.ok;
  $('blockErrors').textContent = blocks.errors.map(e => `Step ${e.index + 1}: ${e.message}`).join(' · ');
  $('stepsEmpty').hidden = steps.length > 0;
  $('stepCount').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  steps.forEach((s, i) => {
    const meta = COMMANDS[s.command] || { target: 'required', value: '' };
    const tr = el('tr', { 'data-i': i, draggable: 'false' });
    tr.className = [i === selected ? 'sel' : '', s.disabled ? 'disabled' : '', stepMarks[i] || '', errIdx.has(i) ? 'blockerr' : ''].join(' ').trim();
    if (errIdx.has(i)) tr.title = errIdx.get(i);
    if (s.comment) tr.title = (tr.title ? tr.title + ' — ' : '') + s.comment;

    const grip = el('td', {}, el('span', { class: 'grip', html: ICONS.grip, title: 'Drag to reorder' }));
    grip.firstChild.addEventListener('mousedown', () => { tr.draggable = true; });
    const num = el('td', { class: 'num' }, String(i + 1));

    const sel = el('select', { class: 'cell-cmd' + (meta.block ? ' flow' : ''), 'aria-label': `Command for step ${i + 1}`, html: cmdOptionsHtml });
    if (!COMMANDS[s.command]) sel.prepend(el('option', { value: s.command }, s.command));
    sel.value = s.command;
    sel.addEventListener('change', () => { snapshot(); s.command = sel.value; changed(); });
    const depth = blocks.depth[i] || 0;
    const cmdCell = el('td', {}, el('div', { class: 'cmdcell' }, el('span', { class: 'indent', style: `width:${depth * 14}px` }), sel));

    const tIn = el('input', { class: 'cell-in', value: s.target, spellcheck: 'false', 'aria-label': `Target for step ${i + 1}` });
    if (meta.target === 'none') { tIn.disabled = true; tIn.placeholder = '—'; }
    else tIn.placeholder = meta.targetHint || (meta.target === 'optional' ? '(optional)' : 'selector');
    tIn.addEventListener('focus', () => { tIn.dataset.before = JSON.stringify(current.steps); });
    tIn.addEventListener('input', () => { setTarget(s, tIn.value); changed('none'); renderDetails(); });
    tIn.addEventListener('change', () => { if (tIn.dataset.before) { undoStack.push(tIn.dataset.before); redoStack = []; } renderSteps(); });
    const fbCount = (s.targets || []).filter(t => t !== s.target).length;
    const tgtCell = el('td', {}, el('div', { class: 'tgt' }, tIn, fbCount ? el('span', { class: 'fb', title: `${fbCount} fallback selector(s)` }, `+${fbCount}`) : null));

    const vIn = el('input', { class: 'cell-in', value: s.value, spellcheck: 'false', 'aria-label': `Value for step ${i + 1}` });
    if (!meta.value) { vIn.disabled = true; vIn.placeholder = '—'; } else vIn.placeholder = meta.value;
    if (/password/i.test(s.comment)) vIn.type = 'password';
    vIn.addEventListener('focus', () => { vIn.dataset.before = JSON.stringify(current.steps); });
    vIn.addEventListener('input', () => { s.value = vIn.value; changed('none'); if (selected === i) $('dValue').value = s.value; });
    vIn.addEventListener('change', () => { if (vIn.dataset.before) { undoStack.push(vIn.dataset.before); redoStack = []; } });

    const acts = el('div', { class: 'acts' },
      el('button', { class: 'btn sm icon ghost', title: 'Play from this step', 'aria-label': `Play from step ${i + 1}`, html: ICONS.play, onclick: e => { e.stopPropagation(); play(i); } }),
      el('button', { class: 'btn sm icon ghost', title: 'Delete step', 'aria-label': `Delete step ${i + 1}`, html: ICONS.trash, onclick: e => { e.stopPropagation(); deleteStep(i); } }),
    );
    tr.append(grip, num, cmdCell, tgtCell, el('td', {}, vIn), el('td', {}, acts));
    tr.addEventListener('mousedown', () => { if (selected !== i) { selected = i; markSelection(); renderDetails(); } });
    tr.addEventListener('focusin', () => { if (selected !== i) { selected = i; markSelection(); renderDetails(); } });

    // drag & drop reorder
    tr.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-step', String(i)); });
    tr.addEventListener('dragend', () => { tr.draggable = false; });
    tr.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/x-step')) return;
      e.preventDefault();
      const r = tr.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      tr.classList.toggle('drop-after', after); tr.classList.toggle('drop-before', !after);
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drop-after', 'drop-before'));
    tr.addEventListener('drop', e => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/x-step'), 10);
      const after = tr.classList.contains('drop-after');
      tr.classList.remove('drop-after', 'drop-before');
      if (Number.isNaN(from)) return;
      let to = i + (after ? 1 : 0);
      if (from < to) to--;
      if (from === to) return;
      snapshot();
      const [moved] = current.steps.splice(from, 1);
      current.steps.splice(to, 0, moved);
      selected = to;
      stepMarks = {};
      changed();
    });
    tbody.append(tr);
  });
}

function markSelection() {
  for (const tr of $('stepsBody').children) tr.classList.toggle('sel', +tr.dataset.i === selected);
}

function addStep(command = 'click') {
  snapshot();
  const at = selected >= 0 ? selected + 1 : current.steps.length;
  current.steps.splice(at, 0, newStep(command));
  selected = at;
  changed();
  const row = $('stepsBody').children[at];
  if (row) { row.scrollIntoView({ block: 'nearest' }); row.querySelector('.cell-cmd').focus(); }
}
function deleteStep(i = selected) {
  if (i < 0 || i >= current.steps.length) return;
  snapshot();
  current.steps.splice(i, 1);
  selected = Math.min(i, current.steps.length - 1);
  stepMarks = {};
  changed();
}
function moveStep(delta) {
  const i = selected, j = i + delta;
  if (i < 0 || j < 0 || j >= current.steps.length) return;
  snapshot();
  [current.steps[i], current.steps[j]] = [current.steps[j], current.steps[i]];
  selected = j;
  stepMarks = {};
  changed();
}
function duplicateStep() {
  if (selected < 0) return;
  snapshot();
  const copy = { ...structuredClone(current.steps[selected]), id: uid() };
  current.steps.splice(selected + 1, 0, copy);
  selected++;
  changed();
}
function toggleStep() {
  if (selected < 0) return;
  snapshot();
  current.steps[selected].disabled = !current.steps[selected].disabled;
  changed();
}

$('addStep').addEventListener('click', () => addStep());
$('delStep').addEventListener('click', () => deleteStep());
$('moveUp').addEventListener('click', () => moveStep(-1));
$('moveDown').addEventListener('click', () => moveStep(1));
$('dupStep').addEventListener('click', duplicateStep);
$('toggleStep').addEventListener('click', toggleStep);

document.addEventListener('keydown', e => {
  if (!current || document.querySelector('dialog[open]')) return;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !inField) { e.preventDefault(); redo(); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); addStep(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateStep(); return; }
  if (mod && e.key === '/') { e.preventDefault(); toggleStep(); return; }
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveStep(-1); focusRow(); return; }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveStep(1); focusRow(); return; }
  if (inField) return;
  if (e.key === 'Delete' && selected >= 0 && !e.target.closest('.macro-list, dialog')) { e.preventDefault(); deleteStep(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && selected >= 0 && !e.target.closest('.macro-list')) {
    e.preventDefault();
    selected = Math.max(0, Math.min(current.steps.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
    markSelection(); renderDetails(); focusRow(false);
  }
});
function focusRow(intoCommand = true) {
  const row = $('stepsBody').children[selected];
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  if (intoCommand) row.querySelector('.cell-cmd').focus();
}

// ---------------------------------------------------------------- details panel
$('dCommand').innerHTML = cmdOptionsHtml;
function renderDetails() {
  const s = current && current.steps[selected];
  $('detailsEmpty').hidden = !!s;
  $('detailsBody').hidden = !s;
  if (!s) return;
  const meta = COMMANDS[s.command] || { label: 'Unknown command', target: 'required', value: 'Value' };
  $('dNum').textContent = `${selected + 1} of ${current.steps.length}`;
  $('dCommand').value = s.command;
  $('dHelp').textContent = meta.label;
  $('dTargetWrap').hidden = meta.target === 'none';
  $('dFallbackWrap').hidden = meta.target === 'text';
  $('dPick').hidden = $('dFind').hidden = meta.target === 'text';
  $('dTargetLabel').textContent = meta.target === 'text' ? (meta.targetHint && meta.targetHint.startsWith('http') ? 'URL' : 'Name / expression') : `Target selector${meta.target === 'optional' ? ' (optional)' : ''}`;
  if (document.activeElement !== $('dTarget')) $('dTarget').value = s.target;
  $('dTarget').placeholder = meta.targetHint || 'css=#id, text=Sign in, xpath=//button…';
  $('dValueWrap').hidden = !meta.value;
  $('dValueLabel').textContent = 'Value';
  $('dValue').placeholder = meta.value || '';
  if (document.activeElement !== $('dValue')) $('dValue').value = s.value;
  if (document.activeElement !== $('dComment')) $('dComment').value = s.comment || '';
  $('dDisabled').checked = !!s.disabled;
  const ol = $('dFallbacks');
  ol.textContent = '';
  (s.targets || []).forEach((t, k) => {
    const input = el('input', { class: 'input mono', value: t, spellcheck: 'false', 'aria-label': `Selector ${k + 1}` });
    input.addEventListener('change', () => {
      snapshot();
      s.targets[k] = input.value.trim();
      s.targets = s.targets.filter(Boolean);
      if (k === 0) s.target = s.targets[0] || '';
      changed();
    });
    const li = el('li', { class: k === 0 ? 'primary' : '' }, input,
      el('button', { class: 'btn sm icon ghost', title: 'Use as primary', 'aria-label': 'Use as primary selector', html: ICONS.up, disabled: k === 0, onclick: () => { snapshot(); s.targets.splice(k, 1); s.targets.unshift(t); s.target = t; changed(); } }),
      el('button', { class: 'btn sm icon ghost', title: 'Highlight in page', 'aria-label': 'Highlight this selector in page', html: ICONS.target, onclick: () => findInPage([t]) }),
      el('button', { class: 'btn sm icon ghost', title: 'Remove', 'aria-label': 'Remove selector', html: ICONS.close, onclick: () => { snapshot(); s.targets.splice(k, 1); if (k === 0) s.target = s.targets[0] || ''; changed(); } }),
    );
    ol.append(li);
  });
}
$('dCommand').addEventListener('change', () => { snapshot(); current.steps[selected].command = $('dCommand').value; changed(); });
$('dTarget').addEventListener('focus', () => snapshot());
$('dTarget').addEventListener('input', () => { setTarget(current.steps[selected], $('dTarget').value); changed('none'); const row = $('stepsBody').children[selected]; if (row) row.querySelectorAll('.cell-in')[0].value = $('dTarget').value; });
$('dTarget').addEventListener('change', () => { renderSteps(); renderDetails(); });
$('dValue').addEventListener('focus', () => snapshot());
$('dValue').addEventListener('input', () => { current.steps[selected].value = $('dValue').value; changed('none'); const row = $('stepsBody').children[selected]; if (row) row.querySelectorAll('.cell-in')[1].value = $('dValue').value; });
$('dComment').addEventListener('focus', () => snapshot());
$('dComment').addEventListener('input', () => { current.steps[selected].comment = $('dComment').value; changed('none'); });
$('dDisabled').addEventListener('change', () => { snapshot(); current.steps[selected].disabled = $('dDisabled').checked; changed(); });
$('dAddFallback').addEventListener('click', () => {
  const s = current.steps[selected];
  snapshot();
  if (!s.target) { s.target = ''; }
  s.targets = [...(s.targets || []), 'css='];
  changed();
  const inputs = $('dFallbacks').querySelectorAll('input');
  const last = inputs[inputs.length - 1];
  if (last) { last.focus(); last.setSelectionRange(4, 4); }
});

// ---------------------------------------------------------------- tabs: target tab selector, find & pick
async function refreshTabs() {
  const sel = $('tabSelect');
  const prev = sel.value || sessionStorage.getItem('wa-tab') || '';
  const tabs = siteAccess ? await chrome.tabs.query({}) : await chrome.tabs.query({ active: true });
  sel.textContent = '';
  sel.append(el('option', { value: 'new' }, 'New tab'));
  const usable = tabs.filter(t => t.id !== myTabId && t.url && /^(https?|file):/.test(t.url));
  for (const t of usable) {
    const title = (t.title || t.url).slice(0, 60);
    let host = '';
    try { host = new URL(t.url).host; } catch { /* ignore */ }
    sel.append(el('option', { value: String(t.id) }, `${title}${host ? ' — ' + host : ''}`));
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  else if (usable.length) {
    const lastActive = usable.filter(t => t.active).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || usable[0];
    sel.value = String(lastActive.id);
  } else sel.value = 'new';
}
$('tabSelect').addEventListener('change', () => sessionStorage.setItem('wa-tab', $('tabSelect').value));
$('tabSelect').addEventListener('focus', refreshTabs);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.url) refreshTabsSoon(); });
chrome.tabs.onRemoved.addListener(refreshTabsSoon);
chrome.tabs.onCreated.addListener(refreshTabsSoon);
let tabsTimer = 0;
function refreshTabsSoon() { clearTimeout(tabsTimer); tabsTimer = setTimeout(refreshTabs, 300); }

function targetTabId() {
  const v = $('tabSelect').value;
  return v && v !== 'new' ? parseInt(v, 10) : null;
}

async function findInPage(targets) {
  const tabId = targetTabId();
  if (!tabId) { toast('Choose a tab in "Run in" first', true); return; }
  if (targets.some(t => t.includes('${'))) toast('Selectors with variables are tested literally', false);
  const r = await send({ type: 'wa:highlight', tabId, targets });
  if (r && r.ok) {
    toast(`Found with ${r.selector}${r.count > 1 ? ` (${r.count} matches, first used)` : ''}${r.index > 0 ? ' — fallback' : ''}`);
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) toast(`Found with ${r.selector}. Switch to the tab to see the highlight.`);
  } else toast((r && r.error) || 'Not found', true);
}
$('dFind').addEventListener('click', () => {
  const s = current.steps[selected];
  findInPage([s.target, ...(s.targets || [])].filter(Boolean));
});
$('dPick').addEventListener('click', async () => {
  const tabId = targetTabId();
  if (!tabId) { toast('Choose a tab in "Run in" first', true); return; }
  pickFor = current.steps[selected].id;
  const r = await send({ type: 'wa:pick', tabId });
  if (!r || !r.ok) { pickFor = null; toast((r && r.error) || 'Could not start picker', true); }
});

// ---------------------------------------------------------------- playing
async function play(fromStep = 0) {
  if (!current) return;
  await flushSave();
  if (!siteAccess) { toast('Allow site access first (top bar)', true); return; }
  const blocks = analyzeBlocks(current.steps);
  if (!blocks.ok) { toast('Fix the block errors shown above the steps first', true); return; }
  const tabId = targetTabId();
  stepMarks = {};
  const r = await send({ type: 'wa:play', macroId: current.id, tabId: tabId || undefined, useCsv: $('useCsv').checked, fromStep, speed: $('speedSelect').value });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not start', true); return; }
  viewRun = { id: r.runId, macroId: current.id, log: [], extracted: [], screenshots: [], status: 'running', started: Date.now() };
  activeRun = { id: r.runId, status: 'running', stepIndex: fromStep, total: current.steps.length, paused: false };
  renderRunView();
  renderRunControls();
  selectTab('log');
}
$('playBtn').addEventListener('click', () => play(0));
$('playFrom').addEventListener('click', () => play(Math.max(0, selected)));
$('pauseBtn').addEventListener('click', () => { if (activeRun) send({ type: 'wa:control', runId: activeRun.id, action: activeRun.paused ? 'resume' : 'pause' }); });
$('stopBtn').addEventListener('click', () => { if (activeRun) send({ type: 'wa:control', runId: activeRun.id, action: 'stop' }); });
$('speedSelect').addEventListener('change', () => { if (activeRun) send({ type: 'wa:control', runId: activeRun.id, action: 'speed', arg: $('speedSelect').value }); });

function renderRunControls() {
  const running = activeRun && activeRun.status === 'running';
  $('playBtn').hidden = !!running;
  $('playFrom').hidden = !!running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  if (running) {
    $('pauseBtn').lastChild.textContent = activeRun.paused ? 'Resume' : 'Pause';
    $('pauseBtn').firstElementChild.outerHTML = activeRun.paused ? ICONS.play : ICONS.pause;
    $('runStatus').innerHTML = '';
    $('runStatus').append(el('span', { class: 'badge running' }, activeRun.paused ? 'Paused' : 'Running'),
      `Step ${activeRun.stepIndex + 1}/${activeRun.total}${activeRun.csvRows ? ` · row ${activeRun.csvRow}/${activeRun.csvRows}` : ''}`);
  } else if (viewRun && viewRun.status && viewRun.status !== 'running') {
    $('runStatus').innerHTML = '';
    $('runStatus').append(el('span', { class: 'badge ' + viewRun.status }, viewRun.status), viewRun.ended ? `${((viewRun.ended - viewRun.started) / 1000).toFixed(1)} s` : '');
  } else $('runStatus').textContent = '';
}

function applyRunEvent(run, entry) {
  if (!current || run.macroId !== current.id) return;
  if (run.status === 'running') {
    const prevIdx = activeRun ? activeRun.stepIndex : -1;
    activeRun = run;
    if (prevIdx !== run.stepIndex && prevIdx >= 0 && stepMarks[prevIdx] === 'running') stepMarks[prevIdx] = 'ok';
    stepMarks[run.stepIndex] = 'running';
  } else {
    if (activeRun && stepMarks[activeRun.stepIndex] === 'running') stepMarks[activeRun.stepIndex] = run.status === 'failed' ? 'fail' : 'ok';
    activeRun = null;
  }
  if (entry && entry.level === 'error' && entry.step !== undefined) stepMarks[entry.step] = 'fail';
  for (const tr of $('stepsBody').children) {
    const i = +tr.dataset.i;
    tr.classList.remove('ok', 'fail', 'running');
    if (stepMarks[i]) tr.classList.add(stepMarks[i]);
    if (stepMarks[i] === 'running' && run.status === 'running') tr.scrollIntoView({ block: 'nearest' });
  }
  if (!viewRun || viewRun.id !== run.id) {
    viewRun = { id: run.id, macroId: run.macroId, log: [], extracted: [], screenshots: [], started: run.started };
    $('log').textContent = '';
  }
  viewRun.status = run.status;
  viewRun.ended = run.ended;
  if (entry) { viewRun.log.push(entry); appendLog(entry); }
  renderRunControls();
  if (run.status !== 'running') {
    // finished: load full stored run (extracted data, screenshots)
    setTimeout(async () => {
      const full = (await getRuns()).find(r => r.id === run.id);
      if (full) { viewRun = full; renderRunView(); }
      renderRuns();
      toast(`${run.macroName}: ${run.status}${run.error ? ' — ' + run.error.slice(0, 120) : ''}`, run.status === 'failed');
    }, 150);
  } else if (run.extractedCount !== (viewRun.extractedCount || 0)) {
    viewRun.extractedCount = run.extractedCount;
    $('dataCount').textContent = run.extractedCount ? `(${run.extractedCount})` : '';
  }
}

// ---------------------------------------------------------------- log / data views
function appendLog(entry) {
  const showSteps = $('logSteps').checked, showInfo = $('logInfo').checked;
  if ((entry.level === 'step' && !showSteps) || (entry.level === 'info' && !showInfo)) return;
  const li = el('li', { class: entry.level },
    el('span', { class: 't' }, fmtTime(entry.t)),
    el('span', { class: 'lv' }, entry.level),
    el('span', { class: 'm' }, (entry.step !== undefined ? `#${entry.step + 1} ` : '') + entry.msg));
  if (entry.step !== undefined) {
    li.dataset.step = entry.step;
    li.title = 'Click to select this step';
    li.addEventListener('click', () => { if (current.steps[entry.step]) { selected = entry.step; markSelection(); renderDetails(); focusRow(false); } });
  }
  const log = $('log');
  log.append(li);
  if ($('logAuto').checked) li.scrollIntoView({ block: 'nearest' });
}
function renderRunView() {
  $('log').textContent = '';
  const r = viewRun;
  $('viewingRun').textContent = r ? `Run ${r.started ? fmtDate(r.started) : ''}${r.trigger === 'schedule' ? ' (scheduled)' : ''}` : '';
  if (r) for (const e of r.log || []) appendLog(e);
  renderData();
  renderRunControls();
}
['logSteps', 'logInfo'].forEach(id => $(id).addEventListener('change', renderRunView));
$('copyLog').addEventListener('click', () => {
  const text = (viewRun && viewRun.log || []).map(e => `${new Date(e.t).toISOString()} ${e.level.toUpperCase()} ${e.step !== undefined ? '#' + (e.step + 1) + ' ' : ''}${e.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Log copied'));
});

function renderData() {
  const rows = (viewRun && viewRun.extracted) || [];
  const table = $('dataTable');
  table.textContent = '';
  $('dataCount').textContent = rows.length ? `(${rows.length})` : '';
  $('dataInfo').textContent = rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'} extracted` : 'Run a macro with extract steps to collect data.';
  if (rows.length) {
    const headers = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '#'), ...headers.map(h => el('th', {}, h)))));
    const tb = el('tbody');
    rows.slice(0, 1000).forEach((r, i) => tb.append(el('tr', {}, el('td', { class: 'idx' }, String(i + 1)), ...headers.map(h => el('td', { title: String(r[h] ?? '') }, String(r[h] ?? ''))))));
    table.append(tb);
  }
  ['exportCsv', 'exportJson', 'copyData'].forEach(id => { $(id).disabled = !rows.length; });
  const shots = $('shots');
  shots.textContent = '';
  for (const s of (viewRun && viewRun.screenshots) || []) {
    const b = el('button', { type: 'button', title: s.url || '' }, el('img', { alt: s.name }), el('span', {}, s.name));
    chrome.storage.local.get(s.key).then(o => { if (o[s.key]) b.querySelector('img').src = o[s.key]; });
    b.addEventListener('click', async () => {
      const o = await chrome.storage.local.get(s.key);
      if (!o[s.key]) { toast('Screenshot no longer stored', true); return; }
      $('shotImg').src = o[s.key];
      $('shotDownload').href = o[s.key];
      $('shotDownload').download = `${slug(s.name)}.png`;
      $('shotDlg').showModal();
    });
    shots.append(b);
  }
}
$('shotClose').addEventListener('click', () => $('shotDlg').close());
$('exportCsv').addEventListener('click', () => download(`${slug(current.name)}-data.csv`, toCSV(viewRun.extracted), 'text/csv'));
$('exportJson').addEventListener('click', () => download(`${slug(current.name)}-data.json`, JSON.stringify(viewRun.extracted, null, 2), 'application/json'));
$('copyData').addEventListener('click', () => navigator.clipboard.writeText(toCSV(viewRun.extracted).replace(/,/g, '\t')).then(() => toast('Copied as tab-separated text')));

async function renderRuns() {
  const ul = $('runsList');
  ul.textContent = '';
  const runs = (await getRuns()).filter(r => current && r.macroId === current.id);
  if (!runs.length) { ul.append(el('li', { class: 'faint' }, 'No runs yet.')); return; }
  for (const r of runs) {
    const li = el('li', { class: viewRun && viewRun.id === r.id ? 'cur' : '', tabindex: '0' },
      el('span', { class: 'badge ' + r.status }, r.status),
      el('span', {}, fmtDate(r.started)),
      el('span', { class: 'faint' }, r.ended ? `${((r.ended - r.started) / 1000).toFixed(1)} s` : ''),
      el('span', { class: 'faint' }, r.trigger === 'schedule' ? 'scheduled' : 'manual'),
      el('span', { class: 'faint' }, r.extracted && r.extracted.length ? `${r.extracted.length} rows` : ''),
      el('span', { class: 'err' }, r.error || ''));
    const open = () => { viewRun = r; stepMarks = {}; if (r.failedStep !== undefined) stepMarks[r.failedStep] = 'fail'; renderSteps(); renderRunView(); renderRuns(); selectTab(r.extracted && r.extracted.length ? 'data' : 'log'); };
    li.addEventListener('click', open);
    li.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    ul.append(li);
  }
}
$('clearRuns').addEventListener('click', async () => {
  if (!confirm('Delete the run history (logs, extracted data and screenshots) of all macros?')) return;
  await clearRuns();
  viewRun = null;
  renderRunView();
  renderRuns();
});

// ---------------------------------------------------------------- bottom tabs
function selectTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
}
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
  t.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tab')];
    const i = tabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
    const next = tabs[(i + tabs.length) % tabs.length];
    next.focus(); selectTab(next.dataset.tab);
  });
});

// ---------------------------------------------------------------- CSV input
function renderCsv() {
  const csv = current.csv;
  const data = csv ? parseCSV(csv.text) : { headers: [], rows: [] };
  $('csvCount').textContent = csv ? `(${data.rows.length})` : '';
  $('csvInfo').textContent = csv ? `${csv.name}: ${data.rows.length} rows, ${data.headers.length} columns` : 'No CSV attached';
  $('csvRemove').hidden = !csv;
  $('useCsv').disabled = !csv;
  if (!csv) $('useCsv').checked = false;
  const cols = $('csvCols');
  cols.textContent = '';
  for (const h of data.headers) {
    const token = '${row.' + h + '}';
    cols.append(el('button', { type: 'button', title: 'Copy ' + token, onclick: () => navigator.clipboard.writeText(token).then(() => toast(`Copied ${token}`)) }, token));
  }
  const table = $('csvTable');
  table.textContent = '';
  if (data.headers.length) {
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '#'), ...data.headers.map(h => el('th', {}, h)))));
    const tb = el('tbody');
    data.rows.slice(0, 200).forEach((r, i) => tb.append(el('tr', {}, el('td', { class: 'idx' }, String(i + 1)), ...data.headers.map(h => el('td', { title: r[h] }, r[h])))));
    table.append(tb);
  }
}
function setCsv(name, text) {
  const data = parseCSV(text);
  if (!data.headers.length) { toast('That file has no rows', true); return; }
  current.csv = { name, text };
  changed('none');
  renderCsv();
  renderMacroList();
  toast(`Loaded ${data.rows.length} rows`);
}
$('csvUpload').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', async () => {
  const f = $('csvFile').files[0];
  if (f) setCsv(f.name, await f.text());
  $('csvFile').value = '';
});
$('csvRemove').addEventListener('click', () => { current.csv = null; changed('none'); renderCsv(); });
$('csvPaste').addEventListener('click', () => { $('csvPasteBox').hidden = false; $('csvText').value = current.csv ? current.csv.text : ''; $('csvText').focus(); });
$('csvPasteCancel').addEventListener('click', () => { $('csvPasteBox').hidden = true; });
$('csvPasteSave').addEventListener('click', () => { setCsv(current.csv ? current.csv.name : 'pasted.csv', $('csvText').value); $('csvPasteBox').hidden = true; });
setupDrop($('csvDrop'), async files => { if (files[0]) setCsv(files[0].name, await files[0].text()); });

function setupDrop(zone, onFiles) {
  zone.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); zone.classList.add('over'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
}

// ---------------------------------------------------------------- schedule
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
for (let d = 1; d <= 7; d++) {
  const day = d % 7;
  $('sDays').append(el('label', {}, el('input', { type: 'checkbox', value: String(day), checked: true }), DAY_NAMES[day]));
}
function renderSchedule(alarms) {
  const s = current.schedule || { enabled: false, kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6], minute: 0, every: 60, useCsv: false, closeTab: true };
  $('sEnabled').checked = !!s.enabled;
  $('sKind').value = s.kind || 'daily';
  $('sTime').value = s.time || '09:00';
  $('sMinute').value = s.minute ?? 0;
  $('sEvery').value = s.every ?? 60;
  $('sCsv').checked = !!s.useCsv;
  $('sClose').checked = s.closeTab !== false;
  $('sCsv').disabled = !current.csv;
  const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  $('sDays').querySelectorAll('input').forEach(i => { i.checked = days.includes(+i.value); });
  updateScheduleUi(alarms);
}
function updateScheduleUi(alarms) {
  const s = current.schedule;
  const kind = $('sKind').value;
  document.querySelectorAll('.s-daily').forEach(e => { e.hidden = kind !== 'daily'; });
  document.querySelectorAll('.s-hourly').forEach(e => { e.hidden = kind !== 'hourly'; });
  document.querySelectorAll('.s-interval').forEach(e => { e.hidden = kind !== 'interval'; });
  $('schedForm').classList.toggle('off', !$('sEnabled').checked);
  const next = (alarms && alarms[current.id]) || nextOccurrence(s);
  $('sNext').textContent = s && s.enabled ? `${describeSchedule(s)}. Next run: ${next ? new Date(next).toLocaleString() : '—'}${siteAccess ? '' : ' (needs site access)'}` : 'Not scheduled.';
  $('schedState').textContent = s && s.enabled ? '(on)' : '';
}
$('schedForm').addEventListener('input', () => {
  const days = [...$('sDays').querySelectorAll('input:checked')].map(i => +i.value);
  current.schedule = {
    enabled: $('sEnabled').checked, kind: $('sKind').value, time: $('sTime').value || '09:00', days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    minute: Math.min(59, Math.max(0, parseInt($('sMinute').value, 10) || 0)), every: Math.max(1, parseInt($('sEvery').value, 10) || 60),
    useCsv: $('sCsv').checked && !!current.csv, closeTab: $('sClose').checked,
  };
  changed('none');
  updateScheduleUi();
  renderMacroList();
});
$('schedForm').addEventListener('submit', e => e.preventDefault());

// ---------------------------------------------------------------- macro actions
async function createMacro() {
  flushSave();
  const m = await saveMacro({ name: 'New macro', steps: [newStep('open', 'https://', '')] });
  macros = await getMacros();
  await selectMacro(m.id);
  $('macroName').focus();
  $('macroName').select();
}
$('newMacro').addEventListener('click', createMacro);
$('newMacro2').addEventListener('click', createMacro);
$('macroName').addEventListener('input', () => { current.name = $('macroName').value || 'Untitled macro'; changed('none'); });
$('macroName').addEventListener('change', renderMacroList);
$('macroSearch').addEventListener('input', renderMacroList);
$('dupMacro').addEventListener('click', async () => {
  await flushSave();
  const copy = normalizeMacro({ ...structuredClone(current), id: undefined, name: current.name + ' (copy)', schedule: current.schedule ? { ...current.schedule, enabled: false } : null });
  await saveMacro(copy);
  macros = await getMacros();
  selectMacro(copy.id);
  toast('Duplicated');
});
$('exportMacro').addEventListener('click', async () => {
  await flushSave();
  download(`${slug(current.name)}.json`, exportMacros([current]), 'application/json');
});
$('exportAll').addEventListener('click', async () => {
  await flushSave();
  download(`web-automator-macros-${new Date().toISOString().slice(0, 10)}.json`, exportMacros(await getMacros()), 'application/json');
});
$('deleteMacro').addEventListener('click', async () => {
  if (!confirm(`Delete "${current.name}"? This cannot be undone.`)) return;
  clearTimeout(saveTimer); saveTimer = 0;
  await deleteMacro(current.id);
  macros = await getMacros();
  selectMacro(macros[0] ? macros[0].id : null);
});
$('recordInto').addEventListener('click', async () => {
  await flushSave();
  if (!siteAccess) { toast('Allow site access first', true); return; }
  const tabId = targetTabId();
  if (!tabId) { toast('Choose the tab to record in ("Run in")', true); return; }
  const r = await send({ type: 'wa:startRecording', tabId, appendTo: current.id });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not start recording', true); return; }
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  chrome.windows.update(tab.windowId, { focused: true });
});

// ---------------------------------------------------------------- import
async function importFiles(files) {
  let count = 0;
  for (const f of files) {
    try {
      const list = parseImport(await f.text());
      for (const m of list) { await saveMacro(m); count++; }
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (count) {
    macros = await getMacros();
    renderMacroList();
    toast(`Imported ${count} macro${count === 1 ? '' : 's'}`);
    selectMacro(macros[0].id);
  }
  $('importDlg').close();
}
$('importBtn').addEventListener('click', () => $('importDlg').showModal());
$('importChoose').addEventListener('click', () => $('importFile').click());
$('importCancel').addEventListener('click', () => $('importDlg').close());
$('importFile').addEventListener('change', async () => { await importFiles([...$('importFile').files]); $('importFile').value = ''; });
setupDrop($('importDrop'), importFiles);

// ---------------------------------------------------------------- settings & permissions
async function updateAccess() {
  siteAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('permPill').hidden = siteAccess;
  const box = $('permBox');
  box.textContent = '';
  box.append(el('span', {}, siteAccess ? 'Site access: allowed on all sites.' : 'Site access: not granted. Recording and playback are disabled.'));
  box.append(siteAccess
    ? el('button', { type: 'button', class: 'btn sm', onclick: async () => { await chrome.permissions.remove({ origins: ['<all_urls>'] }); updateAccess(); } }, 'Revoke')
    : el('button', { type: 'button', class: 'btn sm primary', onclick: grant }, 'Allow on all sites'));
  refreshTabs();
}
async function grant() {
  try { await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch (e) { toast(e.message, true); }
  await updateAccess();
  if (siteAccess) toast('Site access granted');
}
chrome.permissions.onAdded.addListener(updateAccess);
chrome.permissions.onRemoved.addListener(updateAccess);
$('grantTop').addEventListener('click', grant);
$('welcomeGrant').addEventListener('click', async () => { await grant(); $('welcomeDlg').close(); });
$('welcomeLater').addEventListener('click', () => $('welcomeDlg').close());

$('settingsBtn').addEventListener('click', async () => {
  settings = await getSettings();
  $('stSpeed').value = settings.speed;
  $('stTimeout').value = settings.stepTimeout;
  $('stRetries').value = settings.retries;
  $('stOnError').value = settings.onError;
  $('stKeep').value = settings.keepRuns;
  $('stHighlight').checked = settings.highlight;
  $('stFront').checked = settings.bringToFront;
  $('stScroll').checked = settings.recordScroll;
  $('stKeys').checked = settings.recordKeystrokes;
  $('stNotify').checked = settings.notifyManual;
  $('settingsDlg').showModal();
});
$('settingsDlg').addEventListener('close', async () => {
  if ($('settingsDlg').returnValue !== 'save') return;
  settings = await saveSettings({
    speed: $('stSpeed').value,
    stepTimeout: Math.max(500, parseInt($('stTimeout').value, 10) || 10000),
    retries: Math.min(10, Math.max(0, parseInt($('stRetries').value, 10) || 0)),
    onError: $('stOnError').value,
    keepRuns: Math.min(200, Math.max(5, parseInt($('stKeep').value, 10) || 30)),
    highlight: $('stHighlight').checked,
    bringToFront: $('stFront').checked,
    recordScroll: $('stScroll').checked,
    recordKeystrokes: $('stKeys').checked,
    notifyManual: $('stNotify').checked,
  });
  $('speedSelect').value = settings.speed;
  toast('Settings saved');
});

// ---------------------------------------------------------------- live updates
chrome.runtime.onMessage.addListener(msg => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'wa:runEvent' && msg.run) applyRunEvent(msg.run, msg.entry);
  if (msg.type === 'wa:picked') {
    if (!pickFor || !current) return;
    const s = current.steps.find(x => x.id === pickFor);
    pickFor = null;
    if (myTabId) chrome.tabs.update(myTabId, { active: true }).then(t => chrome.windows.update(t.windowId, { focused: true }));
    if (!msg.selectors || !s) { toast('Picking cancelled'); return; }
    snapshot();
    s.target = msg.selectors[0];
    s.targets = msg.selectors;
    selected = current.steps.indexOf(s);
    changed();
    toast(`Picked ${s.target}`);
  }
  if (msg.type === 'wa:recState' && !msg.rec) setTimeout(reloadFromStorage, 200);
});
async function reloadFromStorage() {
  macros = await getMacros();
  renderMacroList();
  if (current && !saveTimer) {
    const fresh = macros.find(m => m.id === current.id);
    if (fresh && fresh.updated !== current.updated) { current = structuredClone(fresh); renderSteps(); renderDetails(); renderCsv(); }
  }
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.macros && !saveTimer) reloadFromStorage();
});

// ---------------------------------------------------------------- boot
(async () => {
  try { const t = await chrome.tabs.getCurrent(); myTabId = t ? t.id : null; } catch { /* ignore */ }
  settings = await getSettings();
  $('speedSelect').value = settings.speed;
  await updateAccess();
  macros = await getMacros();
  const want = params.get('macro');
  const runId = params.get('run');
  let runToShow = null;
  if (runId) runToShow = (await getRuns()).find(r => r.id === runId) || null;
  const id = (runToShow && runToShow.macroId) || (want && macros.some(m => m.id === want) ? want : macros[0] && macros[0].id);
  await selectMacro(id || null);
  if (runToShow && current) { viewRun = runToShow; renderRunView(); renderRuns(); selectTab(runToShow.extracted && runToShow.extracted.length ? 'data' : 'log'); }
  if (params.get('welcome') && !siteAccess) $('welcomeDlg').showModal();
  if (params.get('import')) $('importDlg').showModal();
})();
