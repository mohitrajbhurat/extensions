// Settings, invoice details, data import/export.
import * as store from '../../lib/store.js';
import { escapeHtml, dayKey } from '../../lib/util.js';
import { toast, confirmDialog, download } from '../../shared/ui.js';

export function wantsLiveRefresh() {
  return false; // never re-render a form under the user
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NZD', 'SGD', 'BRL', 'MXN', 'ZAR'];

export async function render(el, ctx) {
  const s = ctx.data.settings;
  const usage = chrome.storage.local.getBytesInUse ? await chrome.storage.local.getBytesInUse(null) : 0;
  const curOpts = [...new Set([...CURRENCIES, s.currency])].map((c) => `<option${c === s.currency ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');

  el.innerHTML = `
    <div class="view-head"><h1>Settings</h1></div>
    <form id="settings" class="stack" style="gap:16px" autocomplete="off">
      <section class="card">
        <header><h2>Automatic tracking</h2></header>
        <div class="settings-grid">
          <label class="check"><input type="checkbox" name="trackingEnabled" ${s.trackingEnabled !== false ? 'checked' : ''}> Track active tab time</label>
          <label class="field">Idle after (seconds)<input type="number" name="idleSeconds" min="15" max="3600" value="${+s.idleSeconds}">
            <span class="help">No keyboard or mouse input for this long stops the clock, and that idle stretch is removed.</span></label>
          <label class="check"><input type="checkbox" name="countAudible" ${s.countAudible !== false ? 'checked' : ''}> Keep counting while a tab plays audio or video</label>
          <label class="check"><input type="checkbox" name="stripQuery" ${s.stripQuery !== false ? 'checked' : ''}> Store URLs without query strings (more private)</label>
        </div>
        <label class="field" style="margin-top:16px">Never track these sites (one per line)
          <textarea name="exclude" rows="3" placeholder="mybank.com&#10;mail.private.org">${escapeHtml((s.exclude || []).join('\n'))}</textarea></label>
      </section>
      <section class="card">
        <header><h2>Timesheets &amp; billing</h2></header>
        <div class="settings-grid">
          <label class="field">Week starts on<select name="weekStart">
            <option value="1"${+s.weekStart === 1 ? ' selected' : ''}>Monday</option>
            <option value="0"${+s.weekStart === 0 ? ' selected' : ''}>Sunday</option>
            <option value="6"${+s.weekStart === 6 ? ' selected' : ''}>Saturday</option></select></label>
          <label class="field">Currency<select name="currency">${curOpts}</select></label>
          <label class="field">Default hourly rate<input type="number" name="defaultRate" min="0" step="0.01" value="${+s.defaultRate || 0}"></label>
          <label class="field">Round timer entries up to<select name="roundMinutes">
            ${[0, 1, 5, 6, 10, 15, 30].map((m) => `<option value="${m}"${+s.roundMinutes === m ? ' selected' : ''}>${m ? `${m} minutes` : 'No rounding'}</option>`).join('')}</select>
            <span class="help">Affects billable amounts only, not tracked time.</span></label>
          <label class="check"><input type="checkbox" name="includeAuto" ${s.includeAuto ? 'checked' : ''}> Include automatic time in reports by default</label>
        </div>
      </section>
      <section class="card">
        <header><h2>Invoice details</h2><span class="small muted">Shown on the printable report.</span></header>
        <div class="settings-grid">
          <label class="field">Your name or business<input name="inv.fromName" value="${escapeHtml(s.invoice.fromName)}" maxlength="120"></label>
          <label class="field">Invoice number prefix<input name="inv.prefix" value="${escapeHtml(s.invoice.prefix)}" maxlength="20"></label>
        </div>
        <label class="field" style="margin-top:16px">Your address, email, tax ID<textarea name="inv.fromDetails" rows="3">${escapeHtml(s.invoice.fromDetails)}</textarea></label>
        <label class="field" style="margin-top:16px">Notes / payment terms<textarea name="inv.notes" rows="2">${escapeHtml(s.invoice.notes)}</textarea></label>
      </section>
      <section class="card">
        <header><h2>Badge &amp; notifications</h2></header>
        <div class="settings-grid">
          <label class="field">Toolbar badge shows<select name="badge">
            <option value="timer"${s.badge === 'timer' ? ' selected' : ''}>Running timer</option>
            <option value="today"${s.badge === 'today' ? ' selected' : ''}>Today's browsing total</option>
            <option value="off"${s.badge === 'off' ? ' selected' : ''}>Nothing</option></select></label>
          <label class="check"><input type="checkbox" name="notifications" ${s.notifications !== false ? 'checked' : ''}> Goal and limit notifications</label>
        </div>
        <p class="help" style="margin-top:12px">Keyboard shortcuts: set "Start or stop the timer" and "Pause or resume automatic tracking" on the
          <a href="#" id="shortcuts">extension shortcuts page</a>.</p>
      </section>
    </form>
    <section class="card">
      <header><h2>Data</h2><span class="small muted">Everything stays in this browser. Using ${(usage / 1024 / 1024).toFixed(2)} MB.</span></header>
      <div class="settings-grid">
        <label class="field">Keep automatic history for<select id="retention">
          ${[0, 30, 90, 180, 365].map((d) => `<option value="${d}"${+s.retentionDays === d ? ' selected' : ''}>${d ? `${d} days` : 'Forever'}</option>`).join('')}</select></label>
      </div>
      <div class="row wrap" style="margin-top:16px">
        <button class="btn" type="button" id="export">Export backup (JSON)</button>
        <label class="btn" tabindex="0" role="button" id="importLabel">Import backup<input type="file" id="import" accept="application/json,.json" class="sr-only"></label>
        <span class="grow"></span>
        <button class="btn danger" type="button" id="clear">Delete tracked history…</button>
      </div>
    </section>`;

  const form = el.querySelector('#settings');
  form.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.name) return;
    const cur = await store.getSettings();
    const patch = {};
    if (t.name.startsWith('inv.')) {
      patch.invoice = { ...cur.invoice, [t.name.slice(4)]: t.value };
    } else if (t.type === 'checkbox') {
      patch[t.name] = t.checked;
    } else if (t.name === 'exclude') {
      patch.exclude = t.value.split(/[\n,]+/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean);
    } else if (['idleSeconds', 'weekStart', 'defaultRate', 'roundMinutes'].includes(t.name)) {
      let v = +t.value;
      if (t.name === 'idleSeconds') v = Math.min(3600, Math.max(15, Math.round(v) || 120));
      if (t.name === 'defaultRate') v = Math.max(0, v || 0);
      t.value = v;
      patch[t.name] = v;
    } else {
      patch[t.name] = t.value;
    }
    await store.saveSettings(patch);
    await ctx.reload();
    toast('Saved');
  });

  el.querySelector('#shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  el.querySelector('#retention').addEventListener('change', async (e) => {
    const d = +e.target.value;
    if (d && !(await confirmDialog(`Automatic history older than ${d} days will be deleted now and from now on. Timer entries are kept.`, { okLabel: 'Apply', danger: true }))) {
      e.target.value = String(s.retentionDays || 0);
      return;
    }
    await store.saveSettings({ retentionDays: d });
    const n = await store.send('prune');
    toast(n ? `Removed ${n} old day${n === 1 ? '' : 's'}` : 'Saved');
  });
  el.querySelector('#export').addEventListener('click', async () => {
    const payload = await store.exportAll();
    download(`time-ledger-backup-${dayKey(Date.now())}.json`, JSON.stringify(payload), 'application/json');
  });
  el.querySelector('#importLabel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.querySelector('#import').click(); }
  });
  el.querySelector('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const replace = await confirmDialog('Replace all current data with this backup? Choose Cancel to merge it into your current data instead.', { okLabel: 'Replace', danger: true });
      await store.send('import', { payload, replace });
      toast('Backup imported');
      await ctx.refresh();
    } catch (err) {
      toast(err.message || 'Could not read that file', { error: true });
    }
    e.target.value = '';
  });
  el.querySelector('#clear').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete all automatic history and timer entries? Projects, clients, rules, goals and settings are kept. This cannot be undone.', { okLabel: 'Delete history', danger: true }))) return;
    await store.send('clearAll');
    toast('History deleted');
    await ctx.refresh();
  });
}
