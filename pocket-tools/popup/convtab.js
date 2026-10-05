// Converters tab: quick convert, units, time zones + meeting planner,
// number bases and unix timestamps.

import { CATEGORIES, convertAll, formatNumber, unitSymbol, parseNumber } from '../lib/units.js';
import {
  POPULAR_CITIES, allZones, cityLabel, localZone, isValidZone, zoneOffset, formatOffset, formatInZone,
  meetingPlanner, zonedParts, parseInBase, toBase, groupDigits, parseUnixTimestamp, relativeTime,
} from '../lib/timeutil.js';
import { convertText } from '../lib/convert.js';
import { saveSettings, HOST_ORIGINS } from '../lib/settings.js';
import { $, $$, el, debounce, resultRow, toast, tablistKeys } from './util.js';

let settings;
let clockTimer = null;

// -------------------------------------------------------------- quick input

function renderQuick() {
  const box = $('#quick-result');
  const text = $('#quick-input').value.trim();
  if (!text) { box.classList.add('hidden'); return; }
  const r = convertText(text, { zones: settings.cities, homeZone: settings.homeZone || undefined });
  box.classList.remove('hidden');
  if (!r) {
    box.replaceChildren(el('span', { class: 'muted small', text: 'Not recognised. Try “5 miles”, “72°F”, “3pm PST”, “0xFF” or a unix timestamp.' }));
    return;
  }
  box.replaceChildren(el('h3', { text: r.title }), el('ul', {}, r.items.map(i => resultRow(i.label, i.value))));
}

// -------------------------------------------------------------------- units

function fillUnitSelect() {
  const cat = $('#unit-cat').value;
  const from = $('#unit-from');
  const prev = from.value;
  from.replaceChildren(...CATEGORIES[cat].units.map(u => el('option', { value: u.id, text: `${u.label} (${unitSymbol(u)})` })));
  if (CATEGORIES[cat].units.some(u => u.id === prev)) from.value = prev;
  else from.value = CATEGORIES[cat].units[Math.min(2, CATEGORIES[cat].units.length - 1)].id;
}

function renderUnits() {
  const cat = $('#unit-cat').value;
  const from = $('#unit-from').value;
  const value = parseNumber($('#unit-value').value);
  const list = $('#unit-results');
  if (!Number.isFinite(value)) {
    list.replaceChildren(el('li', { class: 'muted small', text: 'Enter a number.' }));
    return;
  }
  list.replaceChildren(...convertAll(value, cat, from).map(({ unit, value: v }) =>
    resultRow(unit.label, `${formatNumber(v, { digits: 8 })} ${unitSymbol(unit)}`, { current: unit.id === from })));
  try { localStorage.setItem('pt-units', JSON.stringify({ cat, from })); } catch { /* storage blocked */ }
}

function initUnits() {
  $('#unit-cat').replaceChildren(...Object.entries(CATEGORIES).map(([id, c]) => el('option', { value: id, text: c.label })));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('pt-units') || 'null'); } catch { /* ignore */ }
  if (saved && CATEGORIES[saved.cat]) $('#unit-cat').value = saved.cat;
  fillUnitSelect();
  if (saved && CATEGORIES[$('#unit-cat').value].units.some(u => u.id === saved.from)) $('#unit-from').value = saved.from;
  $('#unit-cat').addEventListener('change', () => { fillUnitSelect(); renderUnits(); });
  $('#unit-from').addEventListener('change', renderUnits);
  $('#unit-value').addEventListener('input', renderUnits);
  renderUnits();
}

// --------------------------------------------------------------- time zones

const home = () => settings.homeZone || localZone();

function zoneList() {
  return [home(), ...settings.cities.filter(z => z !== home())];
}

function renderClocks() {
  const now = Date.now();
  const homeOffset = zoneOffset(now, home());
  $('#zone-clocks').replaceChildren(...zoneList().map((zone, i) => {
    const off = zoneOffset(now, zone);
    const diff = (off - homeOffset) / 60;
    const p = zonedParts(now, zone);
    const hp = zonedParts(now, home());
    const dayDiff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(hp.year, hp.month - 1, hp.day)) / 86400000);
    const rel = i === 0 ? '' : ` · ${diff === 0 ? 'same time' : (diff > 0 ? '+' : '') + diff + ' h'}${dayDiff ? (dayDiff > 0 ? ', tomorrow' : ', yesterday') : ''}`;
    return el('li', {},
      el('div', { class: 'city' },
        el('b', {}, cityLabel(zone), ' ', i === 0 ? el('span', { class: 'home-badge', text: 'You' }) : null),
        el('span', { text: `${zone} · ${formatOffset(off)}${rel}` })),
      el('span', { class: 'time', text: formatInZone(now, zone) }),
      i === 0 ? null : el('button', {
        class: 'btn icon small', type: 'button', 'aria-label': `Remove ${cityLabel(zone)}`, title: 'Remove', text: '×',
        onclick: async () => {
          settings.cities = settings.cities.filter(z => z !== zone);
          await saveSettings({ cities: settings.cities });
          renderZones();
        },
      }));
  }));
}

function renderPlanner() {
  const date = $('#planner-date').value;
  const table = $('#planner');
  if (!date) { table.replaceChildren(); return; }
  const zones = zoneList();
  const rows = meetingPlanner(zones, date, { start: settings.workStart, end: settings.workEnd });
  const fmt = (h, m) => {
    const d = new Date(Date.UTC(2000, 0, 1, h, m));
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: m ? '2-digit' : undefined, timeZone: 'UTC' }).format(d);
  };
  const head = el('tr', {}, zones.map(z => el('th', { scope: 'col', title: z, text: cityLabel(z) })));
  const now = Date.now();
  const body = rows.map(r => el('tr', {
    class: [r.allWorking ? 'all-work' : '', r.allAwake ? 'all-awake' : '', now >= r.ms && now < r.ms + 3600000 ? 'now' : ''].join(' ').trim(),
    title: now >= r.ms && now < r.ms + 3600000 ? 'Current hour' : null,
  },
    r.cells.map(c => el('td', { class: c.working ? 'work' : (!c.awake ? 'night' : '') },
      fmt(c.hour, c.minute),
      c.dayShift ? el('sup', { text: c.dayShift > 0 ? ` +${c.dayShift}d` : ` ${c.dayShift}d` }) : null))));
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, body));
}

function renderZones() {
  renderClocks();
  renderPlanner();
}

function resolveZoneInput(text) {
  const t = text.trim();
  if (!t) return null;
  const city = POPULAR_CITIES.find(c => c.name.toLowerCase() === t.toLowerCase());
  if (city) return city.zone;
  if (isValidZone(t) && t.includes('/')) return t;
  const match = allZones().find(z => z.toLowerCase() === t.toLowerCase() || z.split('/').pop().replace(/_/g, ' ').toLowerCase() === t.toLowerCase());
  return match || (t.toUpperCase() === 'UTC' ? 'UTC' : null);
}

function initZones() {
  const seen = new Set();
  const options = [];
  for (const c of POPULAR_CITIES) { options.push(el('option', { value: c.name, text: c.zone })); seen.add(c.name); }
  for (const z of allZones()) if (!seen.has(z)) options.push(el('option', { value: z }));
  $('#zone-list').replaceChildren(...options);
  const add = async () => {
    const zone = resolveZoneInput($('#zone-add').value);
    const err = $('#zone-error');
    if (!zone) {
      err.textContent = 'Unknown city or time zone. Pick one from the list.';
      err.classList.remove('hidden');
      return;
    }
    err.classList.add('hidden');
    if (zone !== home() && !settings.cities.includes(zone)) {
      if (settings.cities.length >= 8) { toast('Up to 8 cities'); return; }
      settings.cities = [...settings.cities, zone];
      await saveSettings({ cities: settings.cities });
    }
    $('#zone-add').value = '';
    renderZones();
  };
  $('#zone-add-btn').addEventListener('click', add);
  $('#zone-add').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  const t = zonedParts(Date.now(), home());
  $('#planner-date').value = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  $('#planner-date').addEventListener('change', renderPlanner);
}

// -------------------------------------------------------------------- bases

function renderBases() {
  const sel = $('#base-from').value;
  $('#base-custom-wrap').classList.toggle('hidden', sel !== 'custom');
  const base = sel === 'custom' ? Math.min(36, Math.max(2, Number($('#base-custom').value) || 36)) : Number(sel);
  const raw = $('#base-input').value;
  const err = $('#base-error');
  const list = $('#base-results');
  if (!raw.trim()) { list.replaceChildren(); err.classList.add('hidden'); return; }
  const v = parseInBase(raw, base);
  if (v === null) {
    err.textContent = `“${raw.trim()}” is not a valid base-${base} number.`;
    err.classList.remove('hidden');
    list.replaceChildren();
    return;
  }
  err.classList.add('hidden');
  const rows = [
    ['Decimal', groupDigits(toBase(v, 10), 3, ',')],
    ['Hex', toBase(v, 16).toUpperCase()],
    ['Octal', toBase(v, 8)],
    ['Binary', groupDigits(toBase(v, 2), 4)],
  ];
  if (sel === 'custom' && ![2, 8, 10, 16].includes(base)) rows.push([`Base ${base}`, toBase(v, base)]);
  if (v >= 0n && v <= 0x10ffffn && v >= 32n) rows.push(['Character', String.fromCodePoint(Number(v))]);
  const bits = v === 0n ? 1 : (v < 0n ? -v : v).toString(2).length;
  rows.push(['Bits needed', String(bits)]);
  // Copy the ungrouped digits.
  list.replaceChildren(...rows.map(([l, val]) => resultRow(l, val, { copy: l === 'Decimal' || l === 'Binary' ? val.replace(/[ ,]/g, '') : val })));
}

function initBases() {
  for (const s of ['#base-input', '#base-custom']) $(s).addEventListener('input', renderBases);
  $('#base-from').addEventListener('change', renderBases);
  renderBases();
}

// --------------------------------------------------------------- timestamps

function stampRows(ms) {
  const d = new Date(ms);
  return [
    ['Local', d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })],
    ['UTC', d.toUTCString()],
    ['ISO 8601', d.toISOString()],
    ['Relative', relativeTime(ms)],
    ['Seconds', String(Math.floor(ms / 1000))],
    ['Milliseconds', String(Math.round(ms))],
  ];
}

function renderNow() {
  const now = Date.now();
  $('#stamp-now').replaceChildren(
    resultRow('Seconds', String(Math.floor(now / 1000))),
    resultRow('Milliseconds', String(now)),
  );
}

function renderStamp() {
  const raw = $('#stamp-input').value.trim();
  const list = $('#stamp-results');
  if (!raw) { list.replaceChildren(); return; }
  const ts = parseUnixTimestamp(raw);
  if (!ts) {
    list.replaceChildren(el('li', { class: 'small warn', text: 'Enter a whole number of seconds, milliseconds, microseconds or nanoseconds.' }));
    return;
  }
  list.replaceChildren(el('li', { class: 'muted small', text: `Read as ${ts.unit}` }), ...stampRows(ts.ms).map(([l, v]) => resultRow(l, v)));
}

function renderStampDate() {
  const v = $('#stamp-date').value;
  const list = $('#stamp-date-results');
  if (!v) { list.replaceChildren(); return; }
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) { list.replaceChildren(); return; }
  list.replaceChildren(
    resultRow('Seconds', String(Math.floor(ms / 1000))),
    resultRow('Milliseconds', String(ms)),
    resultRow('ISO 8601', new Date(ms).toISOString()),
  );
}

function initStamp() {
  $('#stamp-input').addEventListener('input', renderStamp);
  $('#stamp-date').addEventListener('input', renderStampDate);
  const now = new Date();
  now.setSeconds(0, 0);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  $('#stamp-date').value = local;
  $('#stamp-input').value = String(Math.floor(Date.now() / 1000));
  renderStamp();
  renderStampDate();
}

// ------------------------------------------------------------------ tooltip

async function initTooltipToggle() {
  const box = $('#tooltip-toggle');
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: HOST_ORIGINS }); } catch { /* ignore */ }
  box.checked = Boolean(settings.tooltip && granted);
  box.addEventListener('change', async () => {
    if (box.checked) {
      let ok = false;
      try { ok = await chrome.permissions.request({ origins: HOST_ORIGINS }); } catch { ok = false; }
      if (!ok) {
        box.checked = false;
        toast('Site access was not granted.');
        return;
      }
      settings.tooltip = true;
      await saveSettings({ tooltip: true });
      chrome.runtime.sendMessage({ type: 'tooltip:sync' }).catch(() => {});
      toast('Tooltip on. Select a value on any page.');
    } else {
      settings.tooltip = false;
      await saveSettings({ tooltip: false });
      try { await chrome.permissions.remove({ origins: HOST_ORIGINS }); } catch { /* ignore */ }
      chrome.runtime.sendMessage({ type: 'tooltip:sync' }).catch(() => {});
      toast('Tooltip off');
    }
  });
}

// --------------------------------------------------------------------- init

function showConv(name) {
  $$('#conv-tabs [role="tab"]').forEach(b => {
    const on = b.dataset.conv === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  for (const n of ['units', 'zones', 'bases', 'stamp']) $(`#conv-${n}`).classList.toggle('hidden', n !== name);
  try { localStorage.setItem('pt-conv', name); } catch { /* ignore */ }
}

export function initConvert(s, pending) {
  settings = s;
  $('#quick-input').addEventListener('input', debounce(renderQuick, 120));
  $('#conv-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-conv]');
    if (b) showConv(b.dataset.conv);
  });
  tablistKeys($('#conv-tabs'), b => showConv(b.dataset.conv));
  initUnits();
  initZones();
  initBases();
  initStamp();
  initTooltipToggle();
  renderZones();
  renderNow();
  clearInterval(clockTimer);
  clockTimer = setInterval(() => { renderClocks(); renderNow(); }, 1000);
  let last = 'units';
  try { last = localStorage.getItem('pt-conv') || 'units'; } catch { /* ignore */ }
  showConv(['units', 'zones', 'bases', 'stamp'].includes(last) ? last : 'units');
  if (pending && pending.tab === 'convert' && pending.text) {
    $('#quick-input').value = pending.text.trim().slice(0, 60);
    renderQuick();
  }
}
