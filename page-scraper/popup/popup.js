import { listRecipes, saveRecipes, listSessions, hostOf } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const FILES = ['content/core.js', 'content/panel.js'];
let tab = null;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null) e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

async function openOnPage(message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES });
    await chrome.tabs.sendMessage(tab.id, message);
    window.close();
  } catch (e) {
    $('unsupported').hidden = false;
    $('unsupported').textContent = 'Could not start on this page: ' + (e && e.message ? e.message : e);
  }
}

async function renderRecipes() {
  const host = hostOf(tab.url);
  const all = await listRecipes();
  const mine = all.filter((r) => r.host === host);
  const ul = $('recipes');
  ul.replaceChildren();
  if (!mine.length) {
    ul.append(el('li', { class: 'none' }, 'No recipes yet. Build a selection in the panel and choose Save recipe.'));
    return;
  }
  for (const r of mine) {
    const pg = r.pagination && r.pagination.mode !== 'none' ? ` · ${r.pagination.mode === 'scroll' ? 'scroll' : 'next'} ×${r.pagination.maxPages}` : '';
    ul.append(el('li', {},
      el('div', { class: 'name' }, el('div', {}, r.name), el('div', { class: 'sub' }, `${r.columns.length} columns${pg}`)),
      el('button', { class: 'small primary', title: 'Scrape now with this recipe', onclick: () => openOnPage({ type: 'ps:open', action: 'recipe', recipe: r, run: true }) }, 'Run'),
      el('button', { class: 'small', title: 'Open in the panel to review or edit', onclick: () => openOnPage({ type: 'ps:open', action: 'recipe', recipe: r, run: false }) }, 'Edit'),
      el('button', {
        class: 'small ghost danger', 'aria-label': 'Delete recipe ' + r.name, title: 'Delete recipe',
        onclick: async () => {
          if (!confirm(`Delete recipe “${r.name}”?`)) return;
          await saveRecipes((await listRecipes()).filter((x) => x.id !== r.id));
          renderRecipes();
        },
      }, '✕'),
    ));
  }
}

async function renderRecent() {
  const list = (await listSessions()).slice(0, 4);
  const ul = $('recent');
  ul.replaceChildren();
  if (!list.length) { ul.append(el('li', { class: 'none' }, 'Nothing scraped yet.')); return; }
  for (const m of list) {
    const a = el('a', { href: '#' }, m.title);
    a.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('results/results.html?id=' + encodeURIComponent(m.id)) }); window.close(); });
    ul.append(el('li', {}, el('div', { class: 'name' }, a, el('div', { class: 'sub' }, `${m.rowCount} rows · ${m.host || ''}`))));
  }
}

async function renderAccess() {
  let origin;
  try { const u = new URL(tab.url); if (!/^https?:$/.test(u.protocol)) return; origin = u.origin + '/*'; } catch { return; }
  const has = await chrome.permissions.contains({ origins: [origin] });
  $('accessBox').hidden = false;
  $('accessText').textContent = has
    ? `Crawls on ${hostOf(tab.url)} can continue after a "next" click reloads the page.`
    : `Optional: allow access to ${hostOf(tab.url)} so crawls can continue when a "next" click reloads the whole page. Link-based and in-page pagination work without it.`;
  $('accessBtn').textContent = has ? 'Remove site access' : 'Allow on this site';
  $('accessBtn').onclick = async () => {
    if (has) await chrome.permissions.remove({ origins: [origin] });
    else await chrome.permissions.request({ origins: [origin] });
    renderAccess();
  };
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ok = tab && /^(https?|file):/.test(tab.url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/.test(tab.url);
  $('site').textContent = tab ? (hostOf(tab.url) || tab.url || '') : '';
  if (!ok) {
    $('unsupported').hidden = false;
    $('actions').hidden = true;
  } else {
    $('detectBtn').addEventListener('click', () => openOnPage({ type: 'ps:open', action: 'detect' }));
    $('manualBtn').addEventListener('click', () => openOnPage({ type: 'ps:open', action: 'manual' }));
    renderAccess();
  }
  if (tab) await renderRecipes(); else $('recipes').append(el('li', { class: 'none' }, 'No active tab.'));
  await renderRecent();
}

$('managerBtn').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('shortcutsBtn').addEventListener('click', () => { chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); window.close(); });

init();
