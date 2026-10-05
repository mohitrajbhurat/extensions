import { send, h, toast, categoryColor } from '../shared/ui.js';
import { CATEGORIES, CATEGORY_IDS, DOMAINS_BY_CATEGORY } from '../lib/trackers.js';

const SWITCHES = ['stripParams', 'gpc', 'learning', 'autoBlockLearned', 'showBadge'];
let settings;

async function save(patch, message = 'Saved') {
  try {
    settings = await send('settings:save', { patch });
    toast(message);
  } catch (e) {
    toast(`Could not save: ${e.message}`);
    render();
  }
}

function renderCategories() {
  const wrap = document.getElementById('categories');
  wrap.replaceChildren(...CATEGORY_IDS.map((id) => {
    const c = CATEGORIES[id];
    const input = h('input', { type: 'checkbox', role: 'switch', id: `cat-${id}` });
    input.checked = !!settings.categories[id];
    input.addEventListener('change', () => save({ categories: { [id]: input.checked } }, `${c.label} ${input.checked ? 'blocked' : 'allowed'}`));
    return h('div', { class: 'row' },
      h('div', {},
        h('div', { class: 'cat-head' },
          h('span', { class: 'dot', style: { background: categoryColor(id) } }),
          h('label', { for: `cat-${id}` }, c.label),
          h('span', { class: 'pill' }, `${DOMAINS_BY_CATEGORY[id].length} domains`),
          c.breakage !== 'low' ? h('span', { class: 'pill allowed', title: 'Blocking can occasionally break embedded content' }, 'may affect embeds') : null),
        h('p', { class: 'muted small' }, c.description)),
      h('span', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' })));
  }));
}

function render() {
  renderCategories();
  for (const key of SWITCHES) document.getElementById(key).checked = !!settings[key];
  document.getElementById('learnThreshold').value = settings.learnThreshold;
  for (const r of document.querySelectorAll('input[name="cookieMode"]')) r.checked = r.value === settings.cookieMode;
}

async function loadLists() {
  const data = await send('dashboard:data');
  for (const ta of document.querySelectorAll('textarea[data-key]')) {
    ta.value = (data[ta.dataset.key] || []).join('\n');
  }
}

for (const key of SWITCHES) {
  document.getElementById(key).addEventListener('change', (e) => save({ [key]: e.target.checked }));
}
document.getElementById('learnThreshold').addEventListener('change', (e) => {
  const n = Math.min(10, Math.max(2, Math.round(Number(e.target.value) || 3)));
  e.target.value = n;
  save({ learnThreshold: n });
});
for (const r of document.querySelectorAll('input[name="cookieMode"]')) {
  r.addEventListener('change', () => { if (r.checked) save({ cookieMode: r.value }); });
}

document.getElementById('save-lists').addEventListener('click', async () => {
  const keys = { allowlist: 'allowlist', trustedDomains: 'trustedDomains', userBlocked: 'userBlocked' };
  try {
    for (const ta of document.querySelectorAll('textarea[data-key]')) {
      const list = ta.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const saved = await send('lists:update', { key: keys[ta.dataset.key], list });
      ta.value = saved.join('\n');
    }
    toast('Lists saved');
  } catch (e) {
    toast(`Could not save lists: ${e.message}`);
  }
});

document.getElementById('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
document.getElementById('reset-stats').addEventListener('click', async () => {
  if (!confirm('Clear all statistics and site history?')) return;
  await send('stats:reset');
  toast('Statistics cleared');
});
document.getElementById('reset-learned').addEventListener('click', async () => {
  if (!confirm('Forget every learned tracker, including ones you blocked from the learned list?')) return;
  await send('learned:reset');
  toast('Learning reset');
});

(async () => {
  try {
    settings = await send('settings:get');
    render();
    await loadLists();
  } catch (e) {
    toast(`Could not load settings: ${e.message}`);
  }
})();
