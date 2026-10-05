import { send, normalizeDomain, activeSchedule, describeSchedule, breathSeconds, fmtHourMin, uid, DAY_NAMES } from '../lib/core.js';
import { $, $$, toast, el } from '../lib/ui.js';
import { playChime } from '../lib/chime.js';

let settings = null;
let focus = { phase: 'idle' };
let saveTimer = null;

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

async function load() {
  const st = await send('getState');
  settings = st.settings;
  focus = st.focus;
  render();
}

function render() {
  renderGroups();
  bindFields();
  renderReasons();
  updatePreview();
}

// ---------- generic key-path fields ----------

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const t = ks.reduce((o, k) => o[k], obj);
  t[last] = v;
}

function bindFields() {
  for (const input of $$('[data-k]')) {
    const v = getPath(settings, input.dataset.k);
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v ?? '';
  }
  const lockStrict = settings.pomodoro.strict && focusRunning();
  const sf = $('[data-k="pomodoro.strict"]');
  sf.disabled = lockStrict;
  sf.title = lockStrict ? 'Locked until the current focus session ends' : '';
}

for (const input of $$('[data-k]')) {
  input.addEventListener('change', () => {
    let v;
    if (input.type === 'checkbox') v = input.checked;
    else if (input.type === 'number' || input.type === 'range') {
      v = Number(input.value);
      const min = Number(input.min), max = Number(input.max);
      if (!Number.isFinite(v)) v = min;
      v = Math.min(max, Math.max(min, v));
      if (input.type === 'number' && input.step !== '0.05') v = Math.round(v);
      input.value = v;
    } else v = input.value;
    setPath(settings, input.dataset.k, v);
    updatePreview();
    scheduleSave();
  });
}

function updatePreview() {
  const g = settings.gate;
  const seq = [0, 1, 2, 4].map(n => `${breathSeconds(g, n)}s`);
  $('#breathPreview').textContent = `Pause on visits 1, 2, 3 and 5 today: ${seq.join(', ')}.`;
}

// ---------- saving ----------

function scheduleSave() {
  clearTimeout(saveTimer);
  $('#saveState').textContent = 'Saving...';
  saveTimer = setTimeout(save, 350);
}

async function save() {
  try {
    settings = await send('saveSettings', { settings });
    $('#saveState').textContent = 'All changes saved.';
  } catch (e) {
    toast(e.message, true);
    $('#saveState').textContent = 'Change was not saved.';
    await load();
  }
}

// ---------- groups ----------

function focusRunning() { return focus.phase === 'work' && !focus.paused && focus.endsAt > Date.now(); }

function lockInfo(g) {
  const sch = activeSchedule(g);
  if (g.strict && sch) return { until: sch.until, schedule: true };
  if (settings.pomodoro.strict && focusRunning() && g.blockDuringFocus) return { until: focus.endsAt, schedule: false };
  return null;
}

function renderGroups() {
  const list = $('#groupList');
  list.textContent = '';
  if (!settings.groups.length) {
    list.append(el('p', { class: 'muted' }, 'No groups yet. Add one to start.'));
  }
  settings.groups.forEach(g => list.append(groupCard(g)));
}

function groupCard(g) {
  const node = $('#groupTpl').content.firstElementChild.cloneNode(true);
  const lock = lockInfo(g);
  const schedLock = !!(lock && lock.schedule);
  node.classList.toggle('locked', !!lock);
  if (lock) {
    $('.lock', node).classList.remove('hidden');
    const note = $('.lock-note', node);
    note.textContent = `Strict mode is active until ${fmtHourMin(lock.until)}. You can add sites, but not remove sites or loosen this group.`;
    note.classList.remove('hidden');
  }
  const name = $('.g-name', node);
  name.value = g.name;
  name.addEventListener('change', () => { g.name = name.value.trim() || 'Untitled group'; scheduleSave(); });

  const del = $('.g-delete', node);
  del.disabled = !!lock;
  del.addEventListener('click', () => {
    if (!confirm(`Delete "${g.name}" and its ${g.sites.length} sites?`)) return;
    settings.groups = settings.groups.filter(x => x !== g);
    renderGroups();
    scheduleSave();
  });

  const mode = $('.g-mode', node);
  mode.value = g.mode;
  mode.disabled = schedLock;
  mode.addEventListener('change', () => { g.mode = mode.value; scheduleSave(); });

  const f = $('.g-focus', node);
  f.checked = g.blockDuringFocus;
  f.disabled = !!lock && !lock.schedule;
  f.addEventListener('change', () => { g.blockDuringFocus = f.checked; scheduleSave(); });

  const strict = $('.g-strict', node);
  strict.checked = g.strict;
  strict.disabled = schedLock;
  strict.addEventListener('change', () => {
    if (strict.checked && activeSchedule(g) && !confirm('A schedule in this group is active right now. Turning on strict mode locks it until it ends. Continue?')) {
      strict.checked = false;
      return;
    }
    g.strict = strict.checked;
    renderGroups();
    scheduleSave();
  });

  // sites
  const sites = $('.g-sites', node);
  if (!g.sites.length) sites.append(el('li', { class: 'empty' }, 'No sites yet'));
  for (const d of g.sites) {
    sites.append(el('li', {}, d, el('button', {
      type: 'button', 'aria-label': `Remove ${d}`, title: lock ? 'Locked by strict mode' : `Remove ${d}`, disabled: !!lock,
      onclick: () => { g.sites = g.sites.filter(x => x !== d); renderGroups(); scheduleSave(); },
    }, '×')));
  }
  $('.g-add', node).addEventListener('submit', e => {
    e.preventDefault();
    const input = $('.g-site-input', node);
    const added = [];
    for (const part of input.value.split(/[\s,]+/)) {
      const d = normalizeDomain(part);
      if (d && !g.sites.includes(d)) { g.sites.push(d); added.push(d); }
    }
    if (!added.length) { toast('Enter a site like example.com', true); return; }
    renderGroups();
    scheduleSave();
    const again = $$('.g-site-input')[settings.groups.indexOf(g)];
    if (again) again.focus();
  });

  // schedules
  const wrap = $('.g-schedules', node);
  if (!g.schedules.length) wrap.append(el('p', { class: 'small muted' }, 'No schedules. Sites are gated, but never fully blocked except during focus.'));
  for (const sc of g.schedules) wrap.append(scheduleRow(g, sc, schedLock));
  const addBtn = $('.g-add-sched', node);
  addBtn.disabled = schedLock;
  addBtn.addEventListener('click', () => {
    g.schedules.push({ id: uid(), days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' });
    renderGroups();
    scheduleSave();
  });
  for (const b of $$('.g-preset', node)) {
    b.disabled = schedLock;
    b.addEventListener('click', () => {
      g.schedules.push(b.dataset.preset === 'work'
        ? { id: uid(), days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }
        : { id: uid(), days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00' });
      renderGroups();
      scheduleSave();
    });
  }
  return node;
}

function scheduleRow(g, sc, locked) {
  const active = !!activeSchedule({ schedules: [sc] });
  const desc = el('span', { class: 'small sub desc' }, describeSchedule(sc) + (active ? ' · active now' : ''));
  const days = el('div', { class: 'days', role: 'group', 'aria-label': 'Days' });
  for (const d of DAY_ORDER) {
    days.append(el('button', {
      type: 'button', 'aria-pressed': String(sc.days.includes(d)), disabled: locked, title: DAY_NAMES[d],
      onclick: () => {
        sc.days = sc.days.includes(d) ? sc.days.filter(x => x !== d) : [...sc.days, d].sort();
        renderGroups();
        scheduleSave();
      },
    }, DAY_NAMES[d].slice(0, 2)));
  }
  const timeInput = (key, label) => {
    const i = el('input', { type: 'time', value: sc[key], 'aria-label': label, disabled: locked });
    i.addEventListener('change', () => { if (i.value) { sc[key] = i.value; renderGroups(); scheduleSave(); } });
    return i;
  };
  const rm = el('button', {
    type: 'button', class: 'btn ghost sm danger', disabled: locked,
    onclick: () => { g.schedules = g.schedules.filter(x => x !== sc); renderGroups(); scheduleSave(); },
  }, 'Remove');
  return el('div', { class: 'sched' + (active ? ' active' : '') }, days, timeInput('start', 'Start time'), el('span', { class: 'muted' }, 'to'), timeInput('end', 'End time'), desc, rm);
}

$('#addGroup').addEventListener('click', () => {
  settings.groups.push({ id: uid(), name: 'New group', sites: [], mode: 'gate', blockDuringFocus: true, strict: false, schedules: [] });
  renderGroups();
  scheduleSave();
  const names = $$('.g-name');
  names[names.length - 1].select();
});

// ---------- reasons ----------

function renderReasons() {
  const ul = $('#reasonList');
  ul.textContent = '';
  settings.reasons.forEach((r, i) => {
    const input = el('input', { type: 'text', value: r, maxlength: 200, 'aria-label': `Reason ${i + 1}` });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v) settings.reasons[i] = v; else settings.reasons.splice(i, 1);
      renderReasons();
      scheduleSave();
    });
    ul.append(el('li', {}, input, el('button', {
      type: 'button', class: 'btn ghost sm danger', 'aria-label': `Remove reason ${i + 1}`,
      onclick: () => { settings.reasons.splice(i, 1); renderReasons(); scheduleSave(); },
    }, 'Remove')));
  });
  if (!settings.reasons.length) ul.append(el('li', { class: 'muted' }, 'No reasons yet. Add the ones that matter to you.'));
}

$('#reasonForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#newReason').value.trim();
  if (!v) return;
  settings.reasons.push(v);
  $('#newReason').value = '';
  renderReasons();
  scheduleSave();
});

// ---------- misc ----------

for (const b of $$('[data-sound]')) b.addEventListener('click', () => playChime(b.dataset.sound, settings.pomodoro.volume));
$('#shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

$('#exportBtn').addEventListener('click', async () => {
  const data = await send('exportData');
  const blob = new Blob([JSON.stringify({ app: 'mindful-gate', exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `mindful-gate-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await send('importData', { data });
    toast('Backup imported');
    await load();
  } catch (err) { toast('Import failed: ' + err.message, true); }
  e.target.value = '';
});

$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete all tracked time, intentions and focus history? Settings are kept.')) return;
  await send('clearData');
  toast('History cleared');
});

if (location.hash === '#welcome') $('#welcome').classList.remove('hidden');
$('#welcomeDone').addEventListener('click', () => { $('#welcome').classList.add('hidden'); history.replaceState(null, '', '#groups'); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.focus) { focus = changes.focus.newValue || { phase: 'idle' }; if (!saveTimer || !document.activeElement || document.activeElement === document.body) render(); }
});

load().catch(e => toast(e.message, true));
