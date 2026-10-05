// Small DOM helpers for extension pages: clipboard, downloads, toasts, element builder.

/** Copy rich text (HTML) and plain text together so word processors keep italics. */
export async function copyRich(html, text) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return true;
    }
  } catch { /* fall through to execCommand */ }
  return copyViaEvent({ 'text/html': html, 'text/plain': text });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaEvent({ 'text/plain': text });
  }
}

function copyViaEvent(data) {
  const onCopy = ev => {
    for (const [type, v] of Object.entries(data)) ev.clipboardData.setData(type, v);
    ev.preventDefault();
  };
  document.addEventListener('copy', onCopy, true);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.removeEventListener('copy', onCopy, true);
  return ok;
}

export function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFilename(name) {
  return String(name || 'bibliography').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'bibliography';
}

/** h('div.cls#id', {attrs}, children...) */
export function h(sel, attrs, ...children) {
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
/** Show a transient status message. `action` = {label, onClick} adds a button (e.g. Undo). */
export function toast(message, { action, timeout = 3200, tone = 'info' } = {}) {
  let host = document.getElementById('toast');
  if (!host) {
    host = h('div#toast.toast', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  host.replaceChildren(h('span', null, message));
  host.dataset.tone = tone;
  if (action) {
    host.appendChild(h('button.btn.btn-ghost.btn-sm', {
      type: 'button',
      onclick: () => { host.classList.remove('show'); action.onClick(); },
    }, action.label));
  }
  host.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), action ? Math.max(timeout, 6000) : timeout);
}

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Apply a saved theme preference ('auto' | 'light' | 'dark') to <html>. */
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
