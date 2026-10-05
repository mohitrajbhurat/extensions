// Monitor editor form shared by the popup and the dashboard.
import { CONDITION_TYPES, evaluateCondition, validateCondition, normalizeText } from './conditions.js';
import { INTERVALS, DEFAULT_SETTINGS, isWatchableUrl, originPattern, defaultName, send, escapeHtml, intervalLabel } from './store.js';

let seq = 0;

/** Ask for host access to the monitor's site. Must be called synchronously from a user gesture. */
export function requestAccess(url) {
  try {
    return chrome.permissions.request({ origins: [originPattern(url)] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Render the editor into `container`.
 * opts: { settings, showUrl, onPick, pickLabel }
 * Returns { get(), set(m), focus(), el }.
 */
export function createEditor(container, initial = {}, opts = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
  const p = `ed${++seq}`;
  const intervals = INTERVALS.slice();
  if (initial.interval && !intervals.some((i) => i.min === initial.interval)) {
    intervals.push({ min: initial.interval, label: intervalLabel(initial.interval) });
    intervals.sort((a, b) => a.min - b.min);
  }
  container.innerHTML = `
<form class="editor" novalidate>
  <label class="field ${opts.showUrl === false ? 'sr-only' : ''}"><span>Page URL</span>
    <input type="url" name="url" id="${p}-url" required placeholder="https://example.com/product" autocomplete="off"></label>
  <label class="field"><span>Name</span>
    <input type="text" name="name" placeholder="Name shown in alerts" maxlength="120"></label>
  <div class="field">
    <span id="${p}-sel-l">What to watch</span>
    <div class="row">
      <input type="text" name="selector" class="mono grow" aria-labelledby="${p}-sel-l" placeholder="Whole page (or a CSS selector / XPath)" spellcheck="false" autocomplete="off">
      ${opts.onPick ? `<button type="button" class="btn small pick" title="Pick an element on the page">${opts.pickLabel || 'Pick'}</button>` : ''}
    </div>
    <span class="hint">Leave empty to watch all text on the page. XPath works with an <code>xpath:</code> prefix.</span>
  </div>
  <div class="two">
    <label class="field"><span>Check</span>
      <select name="interval">${intervals.map((i) => `<option value="${i.min}">${escapeHtml(i.label)}</option>`).join('')}</select></label>
    <label class="field"><span>Load page by</span>
      <select name="mode">
        <option value="fetch">Fetching HTML (fast)</option>
        <option value="render">Rendering in a background tab (for JavaScript sites)</option>
      </select></label>
  </div>
  <label class="field render-wait"><span>Wait after load (seconds)</span>
    <input type="number" name="renderWait" min="1" max="60" step="1"></label>
  <fieldset>
    <legend>Alert when the content changes and</legend>
    <div class="two">
      <select name="ctype" aria-label="Condition">${CONDITION_TYPES.map((c) => `<option value="${c.id}">${escapeHtml(c.id === 'any' ? 'Anything changes' : c.label)}</option>`).join('')}</select>
      <input type="text" name="cvalue" aria-label="Condition value" autocomplete="off">
    </div>
    <label class="check case"><input type="checkbox" name="caseSensitive"> Match case</label>
  </fieldset>
  <div class="row" style="gap:16px;flex-wrap:wrap">
    <label class="check"><input type="checkbox" name="notify"> Desktop notification</label>
    <label class="check"><input type="checkbox" name="sound"> Play sound</label>
  </div>
  <div class="row">
    <button type="button" class="btn small test">Test now</button>
    <span class="hint test-hint grow">Fetches the page the way background checks will.</span>
  </div>
  <div class="test-out" hidden></div>
  <p class="notice error form-error" role="alert" hidden></p>
</form>`;
  const form = container.querySelector('form');
  const f = (n) => form.elements.namedItem(n);
  const errEl = form.querySelector('.form-error');
  const testOut = form.querySelector('.test-out');

  function syncVisibility() {
    form.querySelector('.render-wait').hidden = f('mode').value !== 'render';
    const def = CONDITION_TYPES.find((c) => c.id === f('ctype').value);
    f('cvalue').hidden = !def.needsValue;
    f('cvalue').placeholder = def.placeholder || '';
    f('cvalue').inputMode = def.numeric ? 'decimal' : 'text';
    form.querySelector('.case').hidden = !['contains', 'not_contains'].includes(def.id);
  }

  function set(m) {
    f('url').value = m.url || '';
    f('name').value = m.name || '';
    f('selector').value = m.selector || '';
    f('interval').value = String(m.interval || settings.defaultInterval);
    if (!f('interval').value) f('interval').value = '30';
    f('mode').value = m.mode === 'render' ? 'render' : 'fetch';
    f('renderWait').value = String(m.renderWait || settings.renderWait || 5);
    const c = m.condition || { type: 'any' };
    f('ctype').value = c.type || 'any';
    f('cvalue').value = c.value || '';
    f('caseSensitive').checked = !!c.caseSensitive;
    f('notify').checked = m.notify !== false;
    f('sound').checked = m.sound ?? false;
    syncVisibility();
  }

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  }

  /** Read and validate the form. Throws Error with a user-facing message. */
  function get() {
    showError('');
    const url = f('url').value.trim();
    if (!isWatchableUrl(url)) { f('url').focus(); throw new Error('Enter a valid http(s) URL'); }
    const condition = { type: f('ctype').value, value: f('cvalue').value.trim(), caseSensitive: f('caseSensitive').checked };
    const cErr = validateCondition(condition);
    if (cErr) { f('cvalue').focus(); throw new Error(cErr); }
    const selector = f('selector').value.trim();
    return {
      ...(initial.id ? { id: initial.id } : {}),
      url,
      name: f('name').value.trim() || defaultName(url, selector),
      selector,
      interval: Number(f('interval').value),
      mode: f('mode').value,
      renderWait: Number(f('renderWait').value) || 5,
      condition,
      notify: f('notify').checked,
      sound: f('sound').checked,
      paused: !!initial.paused,
    };
  }

  form.addEventListener('change', syncVisibility);
  form.addEventListener('submit', (e) => e.preventDefault());
  if (opts.onPick) form.querySelector('.pick').addEventListener('click', () => opts.onPick(get));

  form.querySelector('.test').addEventListener('click', async () => {
    let m;
    try { m = get(); } catch (e) { showError(e.message); return; }
    const access = requestAccess(m.url); // inside the click gesture
    const btn = form.querySelector('.test');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Testing…';
    testOut.hidden = false;
    testOut.innerHTML = `<p class="hint">${m.mode === 'render' ? 'Opening a background tab…' : 'Fetching page…'}</p>`;
    try {
      if (!(await access)) throw new Error('Site access was not granted, so the page cannot be checked in the background.');
      const res = await send('preview', { url: m.url, selector: m.selector, mode: m.mode, renderWait: m.renderWait });
      const text = normalizeText(res.text);
      const cond = evaluateCondition(m.condition, text);
      const pieces = [];
      if (m.selector && res.count === 0) {
        pieces.push(`<p class="notice warn">The selector matched nothing in the ${m.mode === 'render' ? 'rendered' : 'fetched'} page.${m.mode === 'fetch' ? ' If the content is added by JavaScript, switch “Load page by” to rendering in a background tab.' : ''}</p>`);
      } else {
        pieces.push(`<p class="hint">${m.selector ? `${res.count} match${res.count === 1 ? '' : 'es'}` : 'Whole page'} · ${text.length.toLocaleString()} characters${cond.value != null ? ` · first number: <b>${cond.value}</b>` : ''}</p>`);
      }
      pieces.push(`<pre class="preview-text">${escapeHtml(text.slice(0, 3000) || '(no text)')}${text.length > 3000 ? '\n…' : ''}</pre>`);
      if (m.condition.type !== 'any') {
        pieces.push(`<p class="notice ${cond.met ? 'ok' : ''}">Condition is currently <b>${cond.met ? 'met' : 'not met'}</b>. You are alerted when the content changes while it is met.</p>`);
      }
      testOut.innerHTML = pieces.join('');
    } catch (e) {
      testOut.innerHTML = `<p class="notice error">${escapeHtml(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test now';
    }
  });

  set({ ...initial });
  return {
    el: form,
    get,
    set,
    showError,
    focus: () => (f('url').value ? f('name') : f('url')).focus(),
  };
}
