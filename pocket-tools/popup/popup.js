// Pocket Tools popup entry: tab switching, pending hand-offs from the
// context menu / shortcuts, and initialisation of each tool.

import { getSettings, saveSettings } from '../lib/settings.js';
import { initGenerator } from './gen.js';
import { initQR } from './qrtab.js';
import { initText } from './texttab.js';
import { initConvert } from './convtab.js';
import { $, tablistKeys } from './util.js';

const TABS = ['password', 'qr', 'text', 'convert'];

function selectTab(name, { focus = false, remember = true } = {}) {
  if (!TABS.includes(name)) name = 'password';
  for (const t of TABS) {
    const tab = $(`#tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#panel-${t}`).hidden = !on;
  }
  if (focus) $(`#tab-${name}`).focus();
  if (remember) saveSettings({ lastTab: name }).catch(() => {});
}

async function takePending() {
  try {
    const { pending } = await chrome.storage.session.get('pending');
    if (!pending) return null;
    await chrome.storage.session.remove('pending');
    // Ignore stale hand-offs (e.g. the popup failed to open last time).
    return Date.now() - (pending.at || 0) < 60000 ? pending : null;
  } catch {
    return null;
  }
}

async function main() {
  if (new URLSearchParams(location.search).has('window')) document.body.classList.add('windowed');
  const [settings, pending] = await Promise.all([getSettings(), takePending()]);

  $('.tabs').addEventListener('click', e => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(tab.id.replace('tab-', ''));
  });
  tablistKeys($('.tabs'), tab => selectTab(tab.id.replace('tab-', '')));
  $('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Alt+1..4 jump between tools.
  document.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      selectTab(TABS[Number(e.key) - 1], { focus: true });
    }
  });

  selectTab(pending && pending.tab ? pending.tab : settings.lastTab, { remember: !pending });

  initGenerator(settings);
  initConvert(settings, pending);
  await Promise.all([initQR(settings, pending), initText(pending)]);
}

main().catch(err => {
  console.warn('Pocket Tools popup failed to start', err);
});
