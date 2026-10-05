// Settings page: auto-saving form, background preview and photos, backup export/import.
import * as store from '../lib/store.js';
import { h, icon, applyTheme, toast, confirmDialog } from '../lib/ui.js';
import { STYLES, pickScene, drawScene, hashString } from '../lib/backgrounds.js';
import { addImage, listImages, deleteImage } from '../lib/images.js';
import { ymd } from '../lib/dates.js';

const $ = (id) => document.getElementById(id);
const form = $('settings');
let settings = store.DEFAULT_SETTINGS;

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = structuredClone(obj);
  let o = out;
  for (const k of keys.slice(0, -1)) { o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
  return out;
}

// widget checkboxes + style options are generated from the shared lists
$('widget-checks').append(...store.WIDGETS.map((w) => h('label.check', h('input', { type: 'checkbox', dataset: { path: `widgets.${w.id}` } }), w.name)));
$('style-select').append(...STYLES.map((s) => h('option', { value: s.id }, s.name)));
if (!(chrome.search && chrome.search.query)) $('engine').querySelector('option[value="default"]').textContent = 'DuckDuckGo (default)';

function fill() {
  for (const el of form.querySelectorAll('[data-path]')) {
    const v = getPath(settings, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v == null ? '' : String(v);
  }
  $('dim-out').textContent = `${settings.background.dim}%`;
  applyTheme(settings.theme);
  drawPreview();
}

let savedTimer;
form.addEventListener('input', async (e) => {
  const el = e.target.closest('[data-path]');
  if (!el) return;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.dataset.type === 'number') {
    value = Number(el.value);
    if (!Number.isFinite(value) || el.value === '') return;
    if (el.min) value = Math.max(Number(el.min), value);
    if (el.max) value = Math.min(Number(el.max), value);
  } else value = el.value;
  settings = await store.update('settings', (s) => setPath(s, el.dataset.path, value));
  $('dim-out').textContent = `${settings.background.dim}%`;
  applyTheme(settings.theme);
  if (el.dataset.path.startsWith('background')) drawPreview();
  $('saved').textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
});
form.addEventListener('submit', (e) => e.preventDefault());

function drawPreview() {
  const c = $('preview');
  const bg = settings.background;
  if (bg.mode === 'photos') {
    $('preview-name').textContent = 'Showing your photos (a generated scene is used when there are none).';
  }
  const scene = pickScene(hashString(`${ymd(new Date())}#0`), bg.style);
  const info = drawScene(c, scene);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgba(0,0,0,${(Number(bg.dim) || 0) / 100})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.font = '600 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 12;
  ctx.fillText('9:41', c.width / 2, c.height / 2 + 14);
  ctx.shadowBlur = 0;
  if (bg.mode !== 'photos') $('preview-name').textContent = `Today: ${info.name}`;
}

// ---------------------------------------------------------------- photos

const urls = [];
async function renderPhotos() {
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  let list = [];
  try { list = await listImages(); } catch (e) { $('photo-help').textContent = `Photos are unavailable: ${e.message}`; return; }
  $('photo-grid').replaceChildren(...list.sort((a, b) => a.added - b.added).map((rec) => {
    const u = URL.createObjectURL(rec.thumb || rec.blob);
    urls.push(u);
    return h('li', h('img', { src: u, alt: rec.name }),
      h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${rec.name}`, onclick: async () => {
        await deleteImage(rec.id);
        renderPhotos();
        notifyBackground();
      } }, icon('trash', 14)));
  }));
}

function notifyBackground() {
  chrome.runtime.sendMessage({ type: 'background:changed' }).catch(() => {});
}

$('photo-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let ok = 0;
  for (const f of files) {
    try { await addImage(f); ok++; } catch (err) { toast(`Could not add ${f.name}: ${err.message}`); }
  }
  if (ok) {
    toast(`Added ${ok} photo${ok > 1 ? 's' : ''}`);
    if (settings.background.mode === 'generated') {
      settings = await store.update('settings', (s) => setPath(s, 'background.mode', 'mixed'));
      fill();
      toast('Background source switched to “Mix of both” so your photos appear.');
    }
  }
  renderPhotos();
  notifyBackground();
});

// ---------------------------------------------------------------- backup

$('export').addEventListener('click', async () => {
  const data = await store.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `home-base-backup-${ymd(new Date())}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  $('backup-msg').textContent = `Exported ${data.data.tasks ? data.data.tasks.length : 0} tasks.`;
});

$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    store.validateBackup(obj);
    const n = Array.isArray(obj.data.tasks) ? obj.data.tasks.length : 0;
    if (!(await confirmDialog(`Replace your current data with this backup (${n} tasks, exported ${obj.exportedAt ? new Date(obj.exportedAt).toLocaleString() : 'at an unknown time'})?`, 'Import'))) return;
    const keys = await store.importData(obj);
    settings = await store.get('settings');
    fill();
    $('backup-msg').textContent = `Imported: ${keys.join(', ')}.`;
  } catch (err) {
    $('backup-msg').textContent = err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message;
  }
});

$('reset').addEventListener('click', async () => {
  if (!(await confirmDialog('Erase all tasks, notes, settings and layout? Export a backup first if you might need them.', 'Erase everything'))) return;
  await store.resetAll();
  settings = await store.get('settings');
  fill();
  $('backup-msg').textContent = 'Everything was reset.';
});

$('tasks-link').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('tasks/tasks.html') }); });

(async () => {
  await store.ensureDefaults();
  settings = await store.get('settings');
  fill();
  renderPhotos();
})();
store.watch(['settings'], (v) => { settings = v.settings; fill(); });
