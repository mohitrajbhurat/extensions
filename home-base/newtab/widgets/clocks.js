// World clocks. Each clock: { id, label, tz } using IANA time zones via Intl.
import { h, icon } from '../../lib/ui.js';
import * as store from '../../lib/store.js';

export function zoneParts(tz, date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}

/** Offset in minutes of tz relative to local time. */
export function offsetFromLocal(tz, date = new Date()) {
  const z = zoneParts(tz, date);
  const zMs = Date.UTC(+z.ymd.slice(0, 4), +z.ymd.slice(5, 7) - 1, +z.ymd.slice(8, 10), z.h, z.m);
  const lMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
  return Math.round((zMs - lMs) / 60000);
}

function fmtOffset(min) {
  if (!min) return 'Same time';
  const sign = min > 0 ? '+' : '−';
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}h${a % 60 ? ' ' + (a % 60) + 'm' : ''}`;
}

const ZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo']; }
})();

export function mount(frame, app) {
  const list = h('ul.clock-list', { role: 'list' });
  const label = h('input.input', { type: 'text', placeholder: 'Label (optional)', 'aria-label': 'Clock label', maxlength: '40' });
  const tz = h('input.input', { type: 'text', placeholder: 'Time zone, e.g. Asia/Kolkata', 'aria-label': 'Time zone', list: 'tz-list', required: true });
  const dl = h('datalist#tz-list', ZONES.map((z) => h('option', { value: z })));
  const msg = h('div.small.muted', { 'aria-live': 'polite' });
  const form = h('form.clock-form', h('div.row', tz, h('button.btn.small.primary', { type: 'submit', 'aria-label': 'Add clock' }, icon('plus', 14))), label, msg, dl);
  form.hidden = true;
  const addBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Add a clock', title: 'Add a clock', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) tz.focus(); } }, icon('plus', 16));
  frame.head.querySelector('.widget-actions').prepend(addBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const zone = ZONES.find((z) => z.toLowerCase() === tz.value.trim().toLowerCase()) ||
      ZONES.find((z) => z.toLowerCase().endsWith('/' + tz.value.trim().toLowerCase().replace(/\s+/g, '_')));
    if (!zone) { msg.textContent = 'Unknown time zone. Pick one from the list.'; return; }
    const name = label.value.trim() || zone.split('/').pop().replace(/_/g, ' ');
    await store.update('clocks', (cl) => [...cl, { id: store.uid('c'), label: name, tz: zone }]);
    tz.value = ''; label.value = ''; msg.textContent = '';
    form.hidden = true;
  });
  frame.body.append(h('div.widget-scroll', list, form));

  function render() {
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const h24 = app.state.settings.h24;
    list.replaceChildren(...app.state.clocks.map((c) => {
      let time = '—', sub = '';
      try {
        time = new Intl.DateTimeFormat(undefined, { timeZone: c.tz, hour: 'numeric', minute: '2-digit', hour12: !h24 }).format(now);
        const z = zoneParts(c.tz, now);
        const day = z.ymd === local ? 'Today' : z.ymd > local ? 'Tomorrow' : 'Yesterday';
        sub = `${day}, ${fmtOffset(offsetFromLocal(c.tz, now))}`;
      } catch { sub = 'Unknown time zone'; }
      const zp = (() => { try { return zoneParts(c.tz, now).h; } catch { return 12; } })();
      return h('li.clock-item', { class: `clock-item ${zp >= 7 && zp < 19 ? 'day' : 'night'}` },
        h('div.grow', h('div.clock-label', c.label), h('div.small.muted', sub)),
        h('div.clock-time', time),
        h('button.icon-btn.clock-del', { type: 'button', 'aria-label': `Remove ${c.label}`, onclick: () => store.update('clocks', (cl) => cl.filter((x) => x.id !== c.id)) }, icon('x', 14)));
    }));
    if (!app.state.clocks.length) list.append(h('li.small.muted', 'No clocks yet. Use + to add one.'));
  }
  render();
  const timer = setInterval(render, 15000);
  return { keys: ['clocks', 'settings'], update: render, destroy: () => clearInterval(timer) };
}
