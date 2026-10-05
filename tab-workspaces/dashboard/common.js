// Dashboard-only UI helpers.
import { h, icon } from '../shared/ui.js';

let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.anchor.setAttribute('aria-expanded', 'false');
  openMenu = null;
}
document.addEventListener('click', e => { if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) { const a = openMenu.anchor; closeMenu(); a.focus(); } });

/** A "more" button that opens a dropdown. items: [{label, icon, onClick, danger}] or 'sep'. */
export function menuButton(items, label = 'More actions') {
  const anchor = h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
  const wrap = h('div.menu-wrap', anchor);
  anchor.addEventListener('click', e => {
    e.stopPropagation();
    if (openMenu?.anchor === anchor) { closeMenu(); return; }
    closeMenu();
    const menu = h('div.menu', { role: 'menu' }, items.filter(Boolean).map(it => it === 'sep' ? h('hr') :
      h('button' + (it.danger ? '.danger' : ''), { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); it.onClick(); } }, it.icon ? icon(it.icon) : null, it.label)));
    menu.addEventListener('keydown', ev => {
      const btns = [...menu.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { btns[(i + 1) % btns.length].focus(); ev.preventDefault(); }
      if (ev.key === 'ArrowUp') { btns[(i - 1 + btns.length) % btns.length].focus(); ev.preventDefault(); }
    });
    wrap.append(menu);
    anchor.setAttribute('aria-expanded', 'true');
    openMenu = { anchor, menu };
    menu.querySelector('button')?.focus();
  });
  return wrap;
}

/** Wrap occurrences of the query's words in <mark>. */
export function highlightText(text, query) {
  text = text || '';
  const words = (query || '').trim().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return text;
  const re = new RegExp('(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
  const parts = text.split(re);
  return parts.map((p, i) => (i % 2 ? h('mark', p) : p));
}

export function viewHead(title, sub, ...right) {
  return h('div.view-head', h('div', h('h1', title), sub ? h('p', sub) : null), right.length ? h('div.toolbar', { style: { margin: 0 } }, right) : null);
}

export function searchBox(placeholder, value, onInput) {
  const input = h('input.input', { type: 'search', placeholder, value: value || '', 'data-search': '', autocomplete: 'off', spellcheck: false, 'aria-label': placeholder });
  input.addEventListener('input', () => onInput(input.value));
  return h('label.search', icon('search'), input);
}

export function emptyState(iconName, title, text, ...actions) {
  return h('div.empty', icon(iconName), h('h3', title), h('p', text), actions.length ? h('div.toolbar', { style: { justifyContent: 'center', marginTop: '16px' } }, actions) : null);
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function openUrl(url, active = true) { return chrome.tabs.create({ url, active }); }
