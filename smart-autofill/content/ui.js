// Smart Autofill in-page UI: field highlights with confidence badges, a floating action panel
// and toasts. Everything lives in a closed shadow root so page CSS cannot interfere.
(function () {
  'use strict';
  if (globalThis.__SA_ui) return;
  const HOST_ID = globalThis.__SA_matcher.UI_HOST_ID;
  const { FIELDS, GROUP_LABELS } = globalThis.SmartAutofillFields;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; font: 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .box { position: fixed; top: 0; left: 0; border: 2px solid var(--c); border-radius: 6px; background: color-mix(in srgb, var(--c) 10%, transparent); transition: opacity .15s; }
  .box.off { border-style: dashed; --c: #8a8f98; background: transparent; }
  .box.done { --c: #16a34a; }
  .box.fail { --c: #dc2626; }
  .badge { position: absolute; left: -2px; bottom: calc(100% + 2px); display: flex; align-items: center; gap: 4px; max-width: 340px;
    padding: 2px 4px 2px 2px; border-radius: 6px; background: var(--c); color: #fff; pointer-events: auto; white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .badge.below { bottom: auto; top: calc(100% + 2px); }
  .badge button { all: unset; cursor: pointer; display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; background: rgba(255,255,255,.22); font-weight: 700; }
  .badge button:focus-visible, .badge select:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
  .badge .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .badge .val { opacity: .9; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
  .badge .pct { font-variant-numeric: tabular-nums; opacity: .95; padding: 0 2px; border-radius: 3px; background: rgba(0,0,0,.18); }
  .badge select { all: unset; cursor: pointer; width: 18px; height: 18px; border-radius: 4px; background: rgba(255,255,255,.22) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5 5 6.5 8 3.5' fill='none' stroke='white' stroke-width='1.6'/%3E%3C/svg%3E") center/10px no-repeat; color: transparent; }
  .badge select option, .badge select optgroup { color: #111; background: #fff; }
  .panel { position: fixed; right: 16px; bottom: 16px; width: 340px; pointer-events: auto; border-radius: 12px; padding: 16px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0,0,0,.22); z-index: 2147483647; font-size: 13px; }
  .panel h2 { margin: 0 0 4px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .panel h2 .dot { width: 10px; height: 10px; border-radius: 50%; background: #7c3aed; }
  .panel p { margin: 0 0 8px; color: var(--muted); }
  .panel .stats { display: flex; gap: 8px; margin: 8px 0 12px; }
  .panel .stat { flex: 1; border: 1px solid var(--line); border-radius: 8px; padding: 8px; text-align: center; }
  .panel .stat b { display: block; font-size: 18px; color: var(--fg); }
  .panel .stat span { font-size: 11px; color: var(--muted); }
  .panel .legend { display: flex; gap: 12px; font-size: 11px; color: var(--muted); margin-bottom: 12px; flex-wrap: wrap; }
  .panel .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: 0; }
  .panel .row { display: flex; gap: 8px; justify-content: flex-end; }
  .panel button { font: inherit; cursor: pointer; border-radius: 8px; padding: 8px 12px; border: 1px solid var(--line); background: var(--btn); color: var(--fg); }
  .panel button.primary { background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 600; }
  .panel button:hover { filter: brightness(1.05); }
  .panel button:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
  .panel .close { position: absolute; top: 8px; right: 8px; padding: 2px 8px; border: none; background: transparent; color: var(--muted); font-size: 16px; }
  .toast { position: fixed; left: 16px; bottom: 16px; max-width: 380px; pointer-events: auto; display: flex; gap: 12px; align-items: center;
    padding: 8px 12px; border-radius: 10px; background: #1f1b2e; color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.3); font-size: 13px; z-index: 2147483647; animation: in .18s ease-out; }
  .toast button { all: unset; cursor: pointer; color: #c4b5fd; font-weight: 600; }
  .toast button:focus-visible { outline: 2px solid #c4b5fd; }
  @keyframes in { from { transform: translateY(8px); opacity: 0; } }
  .layer { --bg: #ffffff; --fg: #1b1b22; --muted: #5d6170; --line: #e3e3ea; --btn: #f6f6f9; }
  @media (prefers-color-scheme: dark) { .layer { --bg: #1d1d24; --fg: #ececf1; --muted: #a2a5b3; --line: #34343f; --btn: #2a2a33; } }
  `;

  let host, shadow, layer, raf = 0;
  const items = new Map();
  let panel = null, toastEl = null, toastTimer = 0;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    layer = document.createElement('div');
    layer.className = 'layer';
    shadow.append(style, layer);
    document.documentElement.appendChild(host);
  }
  function color(score) {
    if (score >= 0.8) return '#16a34a';
    if (score >= 0.6) return '#d97706';
    return '#dc2626';
  }
  function rectFor(it) {
    const els = it.rectEls || [it.el];
    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of els) {
      if (!el.isConnected) continue;
      const target = (el.type === 'radio' || el.type === 'checkbox' || el.type === 'file') && el.getClientRects().length === 0 ? (el.labels && el.labels[0]) || el.parentElement : el;
      if (!target) continue;
      const r = target.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      top = Math.min(top, r.top); left = Math.min(left, r.left); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
    if (top === Infinity) return null;
    return { top: top - 3, left: left - 3, width: right - left + 6, height: bottom - top + 6 };
  }
  function tick() {
    raf = 0;
    for (const it of items.values()) {
      const r = rectFor(it);
      if (!r || r.top + r.height < -50 || r.top > innerHeight + 50) { it.box.style.display = 'none'; continue; }
      it.box.style.display = '';
      it.box.style.transform = `translate(${r.left}px, ${r.top}px)`;
      it.box.style.width = r.width + 'px';
      it.box.style.height = r.height + 'px';
      it.badge.classList.toggle('below', r.top < 26);
    }
    if (items.size) raf = requestAnimationFrame(tick);
  }
  function startLoop() { if (!raf) raf = requestAnimationFrame(tick); }

  function fieldSelect(current, qaList) {
    const sel = document.createElement('select');
    sel.title = 'Change what fills this field (remembered for this site)';
    sel.setAttribute('aria-label', 'Change field mapping');
    const groups = {};
    for (const f of FIELDS) (groups[f.group] = groups[f.group] || []).push(f);
    const none = new Option('Choose field...', '');
    none.disabled = true;
    sel.add(none);
    for (const [g, list] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = GROUP_LABELS[g] || g;
      for (const f of list) og.appendChild(new Option(f.label, f.key));
      sel.add(og);
    }
    if (qaList && qaList.length) {
      const og = document.createElement('optgroup');
      og.label = GROUP_LABELS.qa;
      for (const q of qaList) og.appendChild(new Option(q.question.slice(0, 60), 'qa.' + q.id));
      sel.add(og);
    }
    const og = document.createElement('optgroup');
    og.label = 'This site';
    og.appendChild(new Option('Never fill this field here', '__skip'));
    sel.add(og);
    sel.value = current || '';
    return sel;
  }

  function showHighlights(list, handlers = {}) {
    ensure();
    clearHighlights();
    for (const it of list) {
      const box = document.createElement('div');
      box.className = 'box' + (it.include ? '' : ' off');
      box.style.setProperty('--c', color(it.score));
      const badge = document.createElement('div');
      badge.className = 'badge';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      const name = document.createElement('span');
      name.className = 'name';
      const val = document.createElement('span');
      val.className = 'val';
      const pct = document.createElement('span');
      pct.className = 'pct';
      const sel = fieldSelect(it.key, handlers.qaList);
      badge.append(toggle, name, val, pct, sel);
      box.appendChild(badge);
      layer.appendChild(box);
      const rec = { ...it, box, badge, toggle, name, val, pct, sel };
      items.set(it.id, rec);
      paint(rec);
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        rec.include = !rec.include;
        paint(rec);
        handlers.onToggle && handlers.onToggle(rec.id, rec.include);
      });
      sel.addEventListener('change', async () => {
        const res = handlers.onRemap ? await handlers.onRemap(rec.id, sel.value) : null;
        if (res) { Object.assign(rec, res); paint(rec); }
      });
    }
    startLoop();
  }
  function paint(rec) {
    rec.box.classList.toggle('off', !rec.include);
    rec.box.classList.toggle('done', rec.state === 'done');
    rec.box.classList.toggle('fail', rec.state === 'fail');
    if (rec.include && !rec.state) rec.box.style.setProperty('--c', color(rec.score));
    rec.toggle.textContent = rec.include ? '✓' : '✕';
    rec.toggle.title = rec.include ? 'Will fill. Click to skip this field.' : 'Skipped. Click to include.';
    rec.toggle.setAttribute('aria-label', rec.toggle.title);
    rec.name.textContent = rec.label;
    rec.val.textContent = rec.reason ? '— ' + rec.reason : rec.value ? '→ ' + rec.value : '';
    rec.pct.textContent = rec.source === 'learned' ? 'learned' : Math.round(rec.score * 100) + '%';
    if (rec.sel.value !== rec.key) rec.sel.value = rec.key || '';
  }
  function updateHighlight(id, patch) {
    const rec = items.get(id);
    if (!rec) return;
    Object.assign(rec, patch);
    paint(rec);
  }
  function clearHighlights() {
    for (const it of items.values()) it.box.remove();
    items.clear();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function flash(list, ms = 2200) {
    showHighlights(list.map(x => ({ ...x, include: true })), {});
    for (const rec of items.values()) { rec.toggle.style.display = 'none'; rec.sel.style.display = 'none'; }
    setTimeout(() => clearHighlights(), ms);
  }

  function showPanel(opts) {
    ensure();
    hidePanel();
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Smart Autofill');
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => { hidePanel(); opts.onClose && opts.onClose(); });
    const h = document.createElement('h2');
    h.innerHTML = '<span class="dot"></span>';
    h.append(document.createTextNode(opts.title || 'Smart Autofill'));
    const p = document.createElement('p');
    p.textContent = opts.subtitle || '';
    panel.append(close, h, p);
    if (opts.stats) {
      const stats = document.createElement('div');
      stats.className = 'stats';
      for (const s of opts.stats) {
        const d = document.createElement('div');
        d.className = 'stat';
        const b = document.createElement('b');
        b.textContent = s.value;
        const sp = document.createElement('span');
        sp.textContent = s.label;
        d.append(b, sp);
        stats.appendChild(d);
      }
      panel.appendChild(stats);
    }
    if (opts.legend) {
      const lg = document.createElement('div');
      lg.className = 'legend';
      for (const [c, t] of [['#16a34a', 'High'], ['#d97706', 'Medium'], ['#dc2626', 'Low'], ['#8a8f98', 'Skipped']]) {
        const s = document.createElement('span');
        const i = document.createElement('i');
        i.style.background = c;
        s.append(i, document.createTextNode(t));
        lg.appendChild(s);
      }
      panel.appendChild(lg);
    }
    const row = document.createElement('div');
    row.className = 'row';
    for (const a of opts.actions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', () => a.onClick && a.onClick(b));
      row.appendChild(b);
    }
    panel.appendChild(row);
    layer.appendChild(panel);
    const primary = panel.querySelector('button.primary');
    if (primary && opts.focus !== false) primary.focus({ preventScroll: true });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hidePanel(); opts.onClose && opts.onClose(); } });
  }
  function hidePanel() { if (panel) { panel.remove(); panel = null; } }

  function toast(text, actions = [], ms = 5000) {
    ensure();
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    const s = document.createElement('span');
    s.textContent = text;
    toastEl.appendChild(s);
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', () => { a.onClick(); toastEl && toastEl.remove(); });
      toastEl.appendChild(b);
    }
    layer.appendChild(toastEl);
    toastTimer = setTimeout(() => { toastEl && toastEl.remove(); toastEl = null; }, ms);
  }

  globalThis.__SA_ui = { showHighlights, updateHighlight, clearHighlights, flash, showPanel, hidePanel, toast };
})();
