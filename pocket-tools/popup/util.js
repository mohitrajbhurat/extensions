// Small helpers shared by the popup tabs.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer = null;
export function toast(message, ms = 2200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

export function debounce(fn, ms = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Copy text. Sensitive values (passwords) are cleared from the clipboard
 * after the configured delay by the service worker's offscreen document.
 */
export async function copyText(text, { sensitive = false, clearSeconds = 0, label = 'Copied' } = {}) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Popup lost focus (e.g. opened in a window): let the service worker copy.
    try {
      const r = await chrome.runtime.sendMessage({ type: 'clipboard:copy', text, seconds: sensitive ? clearSeconds : 0 });
      ok = Boolean(r && r.ok);
      if (ok && sensitive && clearSeconds > 0) {
        toast(`${label}. Clipboard clears in ${clearSeconds} s.`);
        return true;
      }
    } catch { /* no service worker */ }
  }
  if (!ok) {
    toast('Copy failed: clipboard not available.');
    return false;
  }
  if (sensitive && clearSeconds > 0) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'clipboard:schedule-clear', seconds: clearSeconds });
      toast(r && r.ok ? `${label}. Clipboard clears in ${clearSeconds} s.` : label);
    } catch {
      toast(label);
    }
  } else {
    toast(label);
  }
  return true;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// A clickable "label: value" row that copies its value.
export function resultRow(label, value, { current = false, copy } = {}) {
  const text = String(copy ?? value);
  const short = text.length > 28 ? text.slice(0, 28) + '…' : text;
  return el('li', { class: current ? 'current' : '' },
    el('button', { type: 'button', title: 'Copy', onclick: () => copyText(text, { label: `Copied ${short}` }) },
      el('span', { class: 'label', text: label }),
      el('span', { class: 'value', text: value })));
}

// Roving-tabindex keyboard support for a tablist.
export function tablistKeys(list, onSelect) {
  list.addEventListener('keydown', e => {
    const tabs = $$('[role="tab"]', list);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
      onSelect(next);
    }
  });
}
