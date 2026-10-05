import { getSettings, saveSettings, send, el } from '../lib/ui.js';

const $ = id => document.getElementById(id);
const BOOL = ['recordVisits', 'notifyTarget', 'notifyLow', 'notifyStock'];
const NUM = ['intervalHours', 'goodDealPct', 'defaultTargetValue'];
let savedTimer;

async function fill() {
  const s = await getSettings();
  for (const k of BOOL) $(k).checked = !!s[k];
  for (const k of NUM) $(k).value = s[k];
  if (![...$('intervalHours').options].some(o => Number(o.value) === Number(s.intervalHours))) {
    $('intervalHours').append(el('option', { value: s.intervalHours }, `${s.intervalHours} hours`));
    $('intervalHours').value = s.intervalHours;
  }
}

async function save() {
  const patch = {};
  for (const k of BOOL) patch[k] = $(k).checked;
  for (const k of NUM) {
    const v = Number($(k).value);
    if (v > 0) patch[k] = v;
  }
  patch.goodDealPct = Math.min(50, Math.max(1, patch.goodDealPct || 5));
  patch.defaultTargetValue = Math.min(95, Math.max(1, patch.defaultTargetValue || 10));
  patch.defaultTargetType = 'percent';
  await saveSettings(patch);
  clearTimeout(savedTimer);
  $('saved').textContent = 'Saved';
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
}

async function renderOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  const ul = $('origins');
  ul.replaceChildren();
  const list = origins.filter(o => /^https?:/.test(o));
  if (!list.length) { ul.append(el('li', { class: 'help' }, 'No stores allowed yet.')); return; }
  for (const o of list) {
    const btn = el('button', { type: 'button', class: 'btn danger' }, 'Remove');
    btn.addEventListener('click', async () => {
      await chrome.permissions.remove({ origins: [o] }).catch(() => false);
      send('permissions-changed').catch(() => {});
      renderOrigins();
    });
    ul.append(el('li', {}, el('span', {}, o.replace(/^https?:\/\//, '').replace(/\/\*$/, '')), btn));
  }
}

$('form').addEventListener('change', save);
$('form').addEventListener('submit', e => e.preventDefault());
fill();
renderOrigins();
