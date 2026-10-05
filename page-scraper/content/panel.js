/* Point-and-Click Scraper: in-page panel, element picker, outlines and crawler.
 * Injected on demand (activeTab + scripting) together with core.js. */
(() => {
  'use strict';
  if (globalThis.__psPanelLoaded) return;
  globalThis.__psPanelLoaded = true;
  const C = globalThis.PSCore;

  // ---------------------------------------------------------------- state
  const S = {
    open: false,
    mode: 'auto', // auto | manual
    candidates: [],
    candIndex: 0,
    itemSelector: '',
    columns: [],
    levels: [],
    levelIndex: 0,
    items: [],
    rows: [],
    pagination: { mode: 'none', next: null, maxPages: 10, delay: 1.5 },
    dedupe: true,
    openWhenDone: true,
    recipeName: '',
    recipeId: '',
    lastPick: null,
    pick: null, // {kind, target, stack}
    crawling: false,
    stopRequested: false,
    progress: null,
    lastSessionId: '',
    minimized: false,
    hoverCol: null,
    hoverRow: -1,
    banner: '',
  };

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || {}); });
    } catch { resolve({ error: 'Extension context lost. Reload the page.' }); }
  });

  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => (S.stopRequested || Date.now() >= end ? resolve() : setTimeout(tick, 100));
    tick();
  });

  // ---------------------------------------------------------------- DOM scaffolding
  const host = document.createElement('page-scraper-ui');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;display:block;';
  const root = host.attachShadow({ mode: 'open' });

  const CSS_TEXT = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap {
    --bg: #ffffff; --bg2: #f4f6f8; --bg3: #e9edf1; --fg: #0f172a; --muted: #5b6676; --line: #d9dee5;
    --accent: #0d9488; --accent-fg: #ffffff; --accent-soft: rgba(13,148,136,.12); --danger: #dc2626;
    --hover: #2563eb; --col: #ea580c; --shadow: 0 12px 40px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.12);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
    color: var(--fg);
  }
  @media (prefers-color-scheme: dark) {
    .wrap { --bg: #161b22; --bg2: #1f2630; --bg3: #2a323d; --fg: #e6edf3; --muted: #9aa6b4; --line: #343d49;
      --accent: #2dd4bf; --accent-fg: #042f2e; --accent-soft: rgba(45,212,191,.16); --danger: #f87171; --hover: #60a5fa; --col: #fb923c;
      --shadow: 0 12px 40px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4); }
  }
  .layer { position: fixed; inset: 0; pointer-events: none; }
  .box { position: fixed; pointer-events: none; border: 2px solid var(--accent); background: var(--accent-soft); border-radius: 3px; }
  .box.first { border-width: 3px; }
  .box.colbox { border: 2px dashed var(--col); background: rgba(234,88,12,.08); }
  .box.rowhi { border-color: var(--hover); background: rgba(37,99,235,.14); }
  .hover { position: fixed; pointer-events: none; border: 2px solid var(--hover); background: rgba(37,99,235,.12); border-radius: 3px; display: none; }
  .hover.bad { border-color: var(--danger); background: rgba(220,38,38,.1); }
  .tag { position: fixed; pointer-events: none; display: none; max-width: 420px; padding: 4px 8px; border-radius: 6px;
    background: #0f172a; color: #fff; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .panel { position: fixed; top: 16px; right: 16px; width: 400px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
    background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); pointer-events: auto; overflow: hidden; }
  .panel[hidden] { display: none; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; background: var(--bg2); border-bottom: 1px solid var(--line); cursor: move; user-select: none; }
  .hd .logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg,#14b8a6,#0f766e); flex: none; }
  .hd h2 { margin: 0; font-size: 14px; font-weight: 650; flex: 1; }
  .body { overflow: auto; padding: 8px 16px 16px; flex: 1; }
  .panel.min .body, .panel.min .ft-extra { display: none; }
  h3 { margin: 16px 0 8px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  h3 .count { text-transform: none; letter-spacing: 0; font-weight: 500; }
  button, select, input { font: inherit; color: inherit; }
  button { cursor: pointer; border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 6px 12px; min-height: 32px; }
  button:hover:not(:disabled) { background: var(--bg2); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  button.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent); }
  button.danger { color: var(--danger); }
  button.icon { padding: 4px; min-width: 32px; min-height: 32px; border-color: transparent; background: transparent; display: inline-grid; place-items: center; font-size: 16px; line-height: 1; }
  button.icon:hover:not(:disabled) { background: var(--bg3); }
  button.small { min-height: 28px; padding: 4px 8px; font-size: 12px; }
  button.picking { outline: 2px solid var(--hover); outline-offset: 1px; }
  :focus-visible { outline: 2px solid var(--hover); outline-offset: 2px; }
  input[type=text], input[type=number], input:not([type]), select { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 4px 8px; min-height: 32px; min-width: 0; }
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; background: var(--bg2); border-radius: 10px; margin-top: 8px; }
  .seg button { border: 0; background: transparent; }
  .seg button[aria-selected=true] { background: var(--bg); box-shadow: 0 1px 3px rgba(0,0,0,.15); font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row.wrap-row { flex-wrap: wrap; }
  .grow { flex: 1; min-width: 0; }
  .muted { color: var(--muted); }
  .hint { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
  .card { margin-top: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg2); }
  .cand-label { font-weight: 600; text-align: center; }
  .cand-sub { font-size: 12px; text-align: center; color: var(--muted); }
  .sel { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; width: 100%; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; margin-top: 8px; }
  details[open] summary { margin-bottom: 4px; }
  .cols { display: flex; flex-direction: column; gap: 4px; }
  .col { display: grid; grid-template-columns: 1fr 104px auto; gap: 4px; align-items: center; padding: 4px; border-radius: 8px; border: 1px solid transparent; }
  .col:hover, .col:focus-within { border-color: var(--line); background: var(--bg2); }
  .col .acts { display: flex; }
  .col .attr { grid-column: 1 / -1; }
  .col button.icon { min-width: 26px; min-height: 26px; font-size: 13px; }
  .empty { padding: 12px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; align-items: center; font-size: 12px; }
  .preview { overflow: auto; max-height: 240px; border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
  th, td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
  th { position: sticky; top: 0; background: var(--bg2); font-weight: 600; z-index: 1; }
  td.n { color: var(--muted); text-align: right; }
  tbody tr:hover { background: var(--accent-soft); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  label.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  label.check { display: flex; gap: 8px; align-items: center; margin-top: 8px; cursor: pointer; }
  .ft { border-top: 1px solid var(--line); padding: 8px 16px 12px; background: var(--bg); }
  .bar { height: 6px; border-radius: 3px; background: var(--bg3); overflow: hidden; margin: 4px 0 8px; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s; }
  .bar.indet > i { width: 30%; animation: ind 1.2s infinite ease-in-out; }
  @keyframes ind { from { margin-left: -30%; } to { margin-left: 100%; } }
  .banner { margin-top: 8px; padding: 8px; border-radius: 8px; background: var(--accent-soft); font-size: 12px; }
  .banner.pick { background: rgba(37,99,235,.12); }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #0f172a; color: #fff; padding: 8px 16px; border-radius: 10px; box-shadow: var(--shadow); pointer-events: none; opacity: 0; transition: opacity .2s; font-size: 13px; max-width: 80vw; }
  .toast.show { opacity: 1; }
  kbd { font: 11px ui-monospace, monospace; padding: 1px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
  `;

  root.innerHTML = `<style>${CSS_TEXT}</style>
  <div class="wrap">
    <div class="layer" id="layer"></div>
    <div class="hover" id="hoverBox"></div>
    <div class="tag" id="hoverTag"></div>
    <section class="panel" id="panel" role="dialog" aria-label="Page Scraper" hidden>
      <header class="hd" id="drag">
        <span class="logo" aria-hidden="true"></span>
        <h2>Page Scraper</h2>
        <button class="icon" id="minBtn" title="Minimize" aria-label="Minimize panel">&#8211;</button>
        <button class="icon" id="closeBtn" title="Close (stops picking)" aria-label="Close panel">&#10005;</button>
      </header>
      <div class="body" id="body">
        <div class="seg" role="tablist" aria-label="Selection mode">
          <button role="tab" id="tabAuto" aria-selected="true">Auto-detect</button>
          <button role="tab" id="tabManual" aria-selected="false">Point &amp; click</button>
        </div>
        <div id="banner"></div>
        <div id="autoBox" class="card">
          <div class="row">
            <button class="icon" id="candPrev" aria-label="Previous candidate" title="Previous candidate">&#9664;</button>
            <div class="grow"><div class="cand-label" id="candLabel">Detecting…</div><div class="cand-sub" id="candSub"></div></div>
            <button class="icon" id="candNext" aria-label="Next candidate" title="Next candidate">&#9654;</button>
          </div>
          <div class="row" style="justify-content:center;margin-top:4px"><button class="small" id="redetect">Re-detect</button></div>
        </div>
        <div id="manualBox" class="card" hidden>
          <div class="row"><button class="grow" id="pickItems">Pick an item on the page</button></div>
          <div class="row" id="levelRow" style="margin-top:8px">
            <button class="small" id="wider" title="Select the parent container instead">Wider</button>
            <div class="grow muted" id="levelInfo" style="text-align:center;font-size:12px"></div>
            <button class="small" id="narrower" title="Select a smaller element">Narrower</button>
          </div>
          <p class="hint">Click one row, card or list entry. Similar elements are selected automatically. While picking: <kbd>&uarr;</kbd> wider, <kbd>&darr;</kbd> narrower, <kbd>Enter</kbd> select, <kbd>Esc</kbd> cancel.</p>
        </div>
        <details id="selDetails"><summary>Item selector (advanced)</summary>
          <input class="sel" id="itemSel" spellcheck="false" aria-label="CSS selector for items">
        </details>

        <h3>Columns <span class="count muted" id="colCount"></span></h3>
        <div class="cols" id="cols"></div>
        <div id="chips"></div>
        <div class="row wrap-row" style="margin-top:8px">
          <button class="small" id="addCol">+ Add column by clicking</button>
          <button class="small" id="autoCols" title="Re-infer columns from the items">Auto columns</button>
          <button class="small danger" id="clearCols">Clear</button>
        </div>

        <h3>Preview <span class="count muted" id="rowCount"></span></h3>
        <div class="preview" id="preview"></div>

        <h3>Pagination</h3>
        <select id="pgMode" aria-label="Pagination mode" style="width:100%">
          <option value="none">This page only</option>
          <option value="next">Click a "next" / "load more" button</option>
          <option value="scroll">Infinite scroll</option>
        </select>
        <div id="pgNextBox" hidden>
          <div class="row" style="margin-top:8px">
            <button class="small grow" id="pickNext">Pick the "next" button</button>
            <button class="small" id="autoNext">Auto-find</button>
          </div>
          <div class="hint" id="nextInfo"></div>
        </div>
        <div class="grid2" id="pgOpts" hidden>
          <label class="f">Max pages<input type="number" id="maxPages" min="1" max="1000" step="1"></label>
          <label class="f">Delay between pages (s)<input type="number" id="delay" min="0" max="60" step="0.5"></label>
        </div>
        <label class="check"><input type="checkbox" id="dedupe"> Remove duplicate rows</label>
        <label class="check"><input type="checkbox" id="openDone"> Open results when finished</label>

        <h3>Recipe</h3>
        <div class="row">
          <input class="grow" id="recipeName" placeholder="Recipe name" aria-label="Recipe name">
          <button class="small" id="saveRecipe">Save recipe</button>
        </div>
        <p class="hint">Recipes store the item selector, columns and pagination for this site so you can re-run them from the toolbar popup.</p>
      </div>
      <footer class="ft">
        <div id="progress" hidden>
          <div class="row"><div class="grow" id="progText"></div><button class="small danger" id="stopBtn">Stop</button></div>
          <div class="bar" id="bar"><i></i></div>
        </div>
        <div class="row">
          <button class="primary grow" id="scrapeBtn">Scrape</button>
          <button id="copyBtn" title="Copy this page's rows as tab-separated text for Sheets or Excel">Copy</button>
          <button id="resultsBtn" title="Open the results viewer">Results</button>
        </div>
      </footer>
    </section>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>`;

  const $ = (id) => root.getElementById(id);
  const panel = $('panel');

  function mount() { if (!host.isConnected) (document.documentElement || document.body).appendChild(host); }

  let toastTimer = 0;
  function toast(text, ms = 2600) {
    const t = $('toast');
    t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- outlines
  const boxPool = [];
  let drawQueued = false;
  function queueDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }

  function draw() {
    drawQueued = false;
    const layer = $('layer');
    const rects = [];
    if (S.open) {
      const vh = innerHeight; const vw = innerWidth;
      const visible = (r) => r.bottom >= -50 && r.top <= vh + 50 && r.right >= 0 && r.left <= vw && r.width + r.height > 0;
      S.items.slice(0, 1500).forEach((it, i) => {
        if (!it.isConnected) return;
        const r = it.getBoundingClientRect();
        if (visible(r)) rects.push({ r, cls: 'box' + (i === 0 ? ' first' : '') + (i === S.hoverRow ? ' rowhi' : '') });
      });
      if (S.hoverCol) {
        const col = S.columns.find((c) => c.id === S.hoverCol);
        if (col) S.items.slice(0, 300).forEach((it) => {
          const el = C.resolveEl(it, col);
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (visible(r)) rects.push({ r, cls: 'box colbox' });
        });
      }
    }
    while (boxPool.length < rects.length) { const d = document.createElement('div'); layer.appendChild(d); boxPool.push(d); }
    boxPool.forEach((d, i) => {
      const x = rects[i];
      if (!x) { d.style.display = 'none'; return; }
      d.className = x.cls; d.style.display = 'block';
      d.style.left = x.r.left - 2 + 'px'; d.style.top = x.r.top - 2 + 'px';
      d.style.width = x.r.width + 4 + 'px'; d.style.height = x.r.height + 4 + 'px';
    });
  }
  addEventListener('scroll', queueDraw, true);
  addEventListener('resize', queueDraw);

  // ---------------------------------------------------------------- data refresh
  function currentRecipe() {
    return {
      itemSelector: S.itemSelector,
      columns: S.columns.map((c) => ({ ...c })),
      pagination: { ...S.pagination, next: S.pagination.next ? { ...S.pagination.next } : null },
      dedupe: S.dedupe,
    };
  }

  function queryItems() {
    return C.safeQueryAll(document, S.itemSelector).filter((el) => el !== host && !host.contains(el));
  }

  function refresh() {
    S.items = S.itemSelector ? queryItems() : [];
    S.rows = S.items.slice(0, 200).map((it) => S.columns.map((c) => C.valueOf(it, c, location.href)));
    renderPreview();
    renderCols(false);
    queueDraw();
  }

  let mo = null; let moTimer = 0;
  function watchMutations(on) {
    if (on && !mo) {
      mo = new MutationObserver((list) => {
        if (S.crawling || S.pick) return;
        if (list.every((m) => host.contains(m.target) || m.target === host)) return;
        clearTimeout(moTimer); moTimer = setTimeout(() => { if (S.open && S.itemSelector) refresh(); }, 700);
      });
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    } else if (!on && mo) { mo.disconnect(); mo = null; }
  }

  // ---------------------------------------------------------------- rendering
  const TYPES = [['text', 'Text'], ['href', 'Link URL'], ['src', 'Image URL'], ['attr', 'Attribute'], ['html', 'HTML']];

  function renderMode() {
    $('tabAuto').setAttribute('aria-selected', String(S.mode === 'auto'));
    $('tabManual').setAttribute('aria-selected', String(S.mode === 'manual'));
    $('autoBox').hidden = S.mode !== 'auto';
    $('manualBox').hidden = S.mode !== 'manual';
    renderCandidate();
    renderLevel();
  }

  function renderCandidate() {
    const n = S.candidates.length;
    const c = S.candidates[S.candIndex];
    $('candPrev').disabled = n < 2; $('candNext').disabled = n < 2;
    if (!n) {
      $('candLabel').textContent = S.detecting ? 'Detecting…' : 'No repeating data found';
      $('candSub').textContent = S.detecting ? '' : 'Try Point & click mode.';
      return;
    }
    $('candLabel').textContent = c.label;
    $('candSub').textContent = `Candidate ${S.candIndex + 1} of ${n}` + (S.candIndex === 0 ? ' · best match' : '');
  }

  function renderLevel() {
    const l = S.levels[S.levelIndex];
    $('levelRow').hidden = !S.levels.length;
    if (l) {
      $('levelInfo').textContent = `${l.count} match${l.count === 1 ? '' : 'es'} · <${l.el.tagName.toLowerCase()}>`;
      $('wider').disabled = S.levelIndex >= S.levels.length - 1;
      $('narrower').disabled = S.levelIndex <= 0;
    }
    $('pickItems').textContent = S.pick && S.pick.kind === 'items' ? 'Picking… click an item (Esc to cancel)' : (S.itemSelector ? 'Pick a different item' : 'Pick an item on the page');
    $('pickItems').classList.toggle('picking', !!(S.pick && S.pick.kind === 'items'));
  }

  function renderBanner() {
    const b = $('banner');
    let html = '';
    if (S.pick) {
      const msg = { items: 'Click an item to select it and all similar items.', column: 'Click a field inside any outlined item to add it as a column.', next: 'Click the "next" or "load more" button on the page.' }[S.pick.kind];
      html = `<div class="banner pick">${escHtml(msg)} <kbd>Esc</kbd> cancels.</div>`;
    } else if (S.banner) html = `<div class="banner">${escHtml(S.banner)}</div>`;
    b.innerHTML = html;
  }

  function renderCols(full = true) {
    $('colCount').textContent = S.columns.length ? `${S.columns.length}` : '';
    if (!full && root.activeElement && $('cols').contains(root.activeElement)) return;
    const box = $('cols');
    if (!S.columns.length) {
      box.innerHTML = `<div class="empty">${S.itemSelector ? 'No columns yet. Use “Add column by clicking”.' : 'Select items first.'}</div>`;
    } else {
      box.innerHTML = S.columns.map((c, i) => `
        <div class="col" data-id="${c.id}">
          <input data-f="name" value="${escHtml(c.name)}" aria-label="Column name">
          <select data-f="type" aria-label="Column value type">${TYPES.map(([v, l]) => `<option value="${v}"${v === c.type ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <div class="acts">
            <button class="icon" data-a="up" aria-label="Move column left" title="Move left"${i === 0 ? ' disabled' : ''}>&#8593;</button>
            <button class="icon" data-a="down" aria-label="Move column right" title="Move right"${i === S.columns.length - 1 ? ' disabled' : ''}>&#8595;</button>
            <button class="icon danger" data-a="del" aria-label="Delete column ${escHtml(c.name)}" title="Delete column">&#10005;</button>
          </div>
          ${c.type === 'attr' ? `<input class="attr" data-f="attr" value="${escHtml(c.attr)}" placeholder="Attribute name, e.g. data-id or title" aria-label="Attribute name">` : ''}
        </div>`).join('');
    }
    renderChips();
  }

  function renderChips() {
    const box = $('chips');
    const lp = S.lastPick;
    if (!lp || !lp.el.isConnected) { box.innerHTML = ''; return; }
    const opts = [];
    const has = (t) => S.columns.some((c) => c.selector === lp.rel.selector && c.index === lp.rel.index && c.type === t);
    if (C.linkHref(lp.el, location.href) && !has('href')) opts.push(['href', 'Link URL']);
    if (C.imageSrc(lp.el, location.href) && !has('src')) opts.push(['src', 'Image URL']);
    if (C.textOf(lp.el) && !has('text')) opts.push(['text', 'Text']);
    const attrs = Array.from(lp.el.attributes || []).map((a) => a.name).filter((n) => !/^(class|style|href|src)$/.test(n) && !n.startsWith('on')).slice(0, 4);
    if (!opts.length && !attrs.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="chips"><span class="muted">Also add from that field:</span>${opts.map(([t, l]) => `<button class="small" data-chip="${t}">${l}</button>`).join('')}${attrs.map((a) => `<button class="small" data-chip="attr" data-attr="${escHtml(a)}">${escHtml(a)}</button>`).join('')}</div>`;
  }

  function renderPreview() {
    const total = S.items.length;
    $('rowCount').textContent = S.itemSelector ? `${total} row${total === 1 ? '' : 's'} on this page` : '';
    const p = $('preview');
    if (!S.itemSelector || !S.columns.length) { p.innerHTML = '<div class="empty" style="border:0">The data preview appears here.</div>'; return; }
    if (!total) { p.innerHTML = '<div class="empty" style="border:0">No elements match the item selector.</div>'; return; }
    const rows = S.rows.slice(0, 50);
    p.innerHTML = `<table><thead><tr><th>#</th>${S.columns.map((c) => `<th title="${escHtml(c.name)}">${escHtml(c.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-row="${i}"><td class="n">${i + 1}</td>${r.map((v) => `<td title="${escHtml(v.slice(0, 500))}">${escHtml(v.slice(0, 120))}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      + (total > rows.length ? `<div class="hint" style="padding:4px 8px">Showing ${rows.length} of ${total} rows.</div>` : '');
  }

  function renderPagination() {
    const p = S.pagination;
    $('pgMode').value = p.mode;
    $('pgNextBox').hidden = p.mode !== 'next';
    $('pgOpts').hidden = p.mode === 'none';
    $('maxPages').value = p.maxPages;
    $('delay').value = p.delay;
    $('dedupe').checked = S.dedupe;
    $('openDone').checked = S.openWhenDone;
    const picking = S.pick && S.pick.kind === 'next';
    $('pickNext').textContent = picking ? 'Picking… click the button' : (p.next ? 'Pick a different button' : 'Pick the "next" button');
    $('pickNext').classList.toggle('picking', !!picking);
    if (p.mode === 'next') {
      const found = C.findNext(document, p.next);
      $('nextInfo').textContent = p.next
        ? `Using “${p.next.text || p.next.aria || p.next.selector}”. ` + (found ? 'Found on this page.' : 'Not found on this page.')
        : (found ? `Will auto-detect: “${C.collapse(found.textContent || found.value).slice(0, 40)}”. Pick one to be sure.` : 'No next button detected yet. Pick it on the page.');
    }
  }

  function renderProgress() {
    const pr = S.progress;
    $('progress').hidden = !S.crawling;
    $('scrapeBtn').disabled = S.crawling || !S.itemSelector || !S.columns.length;
    $('copyBtn').disabled = S.crawling || !S.rows.length;
    $('resultsBtn').disabled = false;
    $('scrapeBtn').textContent = S.pagination.mode === 'none' ? 'Scrape this page' : `Scrape up to ${S.pagination.maxPages} pages`;
    if (S.crawling && pr) {
      $('progText').textContent = `Page ${pr.page}${S.pagination.mode !== 'none' ? ' of ' + pr.max : ''} · ${pr.total} rows${pr.status ? ' · ' + pr.status : ''}`;
      const bar = $('bar');
      bar.classList.toggle('indet', !pr.max);
      bar.firstElementChild.style.width = pr.max ? Math.min(100, (pr.page / pr.max) * 100) + '%' : '';
    }
  }

  function renderAll() {
    renderMode(); renderBanner(); renderCols(); renderPreview(); renderPagination(); renderProgress();
    $('itemSel').value = S.itemSelector;
    $('recipeName').value = S.recipeName;
    panel.classList.toggle('min', S.minimized);
  }

  // ---------------------------------------------------------------- selection logic
  function setSelection(itemSelector, columns, opts = {}) {
    S.itemSelector = itemSelector;
    S.columns = columns || [];
    if (!opts.keepPick) S.lastPick = null;
    refresh();
    $('itemSel').value = itemSelector;
    renderCols(); renderProgress();
  }

  function applyCandidate(i) {
    const c = S.candidates[i];
    if (!c) return;
    S.candIndex = i;
    setSelection(c.itemSelector, c.columns.map((col) => ({ ...col })));
    renderCandidate();
    const first = S.items[0];
    if (first && !inViewport(first)) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function inViewport(el) { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }

  async function runDetect() {
    S.detecting = true; S.candidates = []; renderCandidate();
    await new Promise((r) => setTimeout(r, 30));
    try {
      S.candidates = C.detect(document);
    } catch (e) { console.warn('Page Scraper detection failed', e); S.candidates = []; }
    S.detecting = false;
    if (S.candidates.length) applyCandidate(0); else { setSelection('', []); renderCandidate(); }
    if (!S.pagination.next && S.pagination.mode === 'none' && C.autoFindNext(document)) {
      S.banner = 'A "next" button was found. Turn on pagination below to scrape more pages.';
      renderBanner();
    }
  }

  function applyLevel() {
    const l = S.levels[S.levelIndex];
    if (!l) return;
    const items = C.safeQueryAll(document, l.selector);
    let cols = C.inferColumns(items, location.href);
    const clicked = S.levelsClicked;
    if (clicked && l.el !== clicked && l.el.contains(clicked)) {
      const own = C.columnFor(l.el, clicked);
      if (own && !cols.some((c) => c.selector === own.selector && c.index === own.index && c.type === own.type)) cols.unshift(own);
    }
    cols = C.uniqueNames(cols);
    if (!cols.length) cols = [C.makeColumn('Text', '', 0, 'text')];
    setSelection(l.selector, cols);
    renderLevel();
  }

  // ---------------------------------------------------------------- picker
  const fromUI = (e) => e.composedPath().includes(host);

  function startPick(kind) {
    stopPick(false);
    if (kind === 'column' && !S.items.length) { toast('Select items first.'); return; }
    S.pick = { kind, target: null, stack: [] };
    renderBanner(); renderLevel(); renderPagination();
    $('addCol').classList.toggle('picking', kind === 'column');
    $('addCol').textContent = kind === 'column' ? 'Picking… click a field' : '+ Add column by clicking';
    document.documentElement.style.setProperty('cursor', 'crosshair', 'important');
  }

  function stopPick(rerender = true) {
    if (!S.pick) return;
    S.pick = null;
    $('hoverBox').style.display = 'none'; $('hoverTag').style.display = 'none';
    $('addCol').classList.remove('picking'); $('addCol').textContent = '+ Add column by clicking';
    document.documentElement.style.removeProperty('cursor');
    if (rerender) { renderBanner(); renderLevel(); renderPagination(); }
  }

  function itemFor(el) {
    for (const it of S.items) if (it === el || it.contains(el)) return it;
    return null;
  }

  function describeEl(el) {
    const cls = Array.from(el.classList || []).slice(0, 2).map((c) => '.' + c).join('');
    return el.tagName.toLowerCase() + cls;
  }

  function showHover(el) {
    const hb = $('hoverBox'); const tg = $('hoverTag');
    if (!el) { hb.style.display = 'none'; tg.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    let bad = false; let label = describeEl(el);
    if (S.pick.kind === 'column') {
      const it = itemFor(el);
      if (!it) { bad = true; label = 'Outside the selected items'; } else {
        const v = el.tagName === 'IMG' ? 'image' : C.textOf(el).slice(0, 60);
        label = `${describeEl(el)}  ${v ? '“' + v + '”' : ''}`;
      }
    } else if (S.pick.kind === 'items') {
      const g = C.generalize(el);
      const l = g.levels[g.index];
      label = `${describeEl(el)} · ${l ? l.count : 1} similar`;
    } else if (S.pick.kind === 'next') label = `${describeEl(C.clickable(el))} “${C.collapse(C.clickable(el).textContent).slice(0, 30)}”`;
    hb.classList.toggle('bad', bad);
    Object.assign(hb.style, { display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
    tg.textContent = label;
    tg.style.display = 'block';
    const top = r.top > 30 ? r.top - 28 : Math.min(innerHeight - 28, r.bottom + 4);
    Object.assign(tg.style, { left: Math.max(4, Math.min(innerWidth - 300, r.left)) + 'px', top: top + 'px' });
  }

  function onMove(e) {
    if (!S.pick) return;
    if (fromUI(e)) { showHover(null); return; }
    let t = e.target;
    if (!(t instanceof Element)) return;
    if (t === document.documentElement || t === document.body) { showHover(null); return; }
    S.pick.target = t; S.pick.stack = [];
    showHover(t);
  }

  function swallow(e) {
    if (!S.pick || fromUI(e)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!S.pick || fromUI(e)) return;
    swallow(e);
    const t = S.pick.target || e.target;
    if (t instanceof Element) commitPick(t);
  }

  function onKey(e) {
    if (!S.pick) return;
    if (e.key === 'Escape') { swallow(e); stopPick(); return; }
    if (fromUI(e)) return;
    const t = S.pick.target;
    if (!t) return;
    if (e.key === 'ArrowUp' && t.parentElement && t.parentElement !== document.body) {
      swallow(e); S.pick.stack.push(t); S.pick.target = t.parentElement; showHover(S.pick.target);
    } else if (e.key === 'ArrowDown' && S.pick.stack.length) {
      swallow(e); S.pick.target = S.pick.stack.pop(); showHover(S.pick.target);
    } else if (e.key === 'Enter') { swallow(e); commitPick(t); }
  }

  for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'submit']) addEventListener(ev, swallow, true);
  addEventListener('click', onClick, true);
  addEventListener('mousemove', onMove, true);
  addEventListener('keydown', onKey, true);

  function commitPick(el) {
    const kind = S.pick.kind;
    stopPick(false);
    if (kind === 'items') {
      const g = C.generalize(el);
      S.levels = g.levels; S.levelIndex = g.index; S.levelsClicked = el;
      S.mode = 'manual';
      applyLevel();
      toast(`${S.items.length} similar item${S.items.length === 1 ? '' : 's'} selected`);
    } else if (kind === 'column') {
      const it = itemFor(el);
      if (!it) { toast('Click inside one of the outlined items.'); startPick('column'); return; }
      const col = C.columnFor(it, el);
      if (!col) return;
      const dup = S.columns.find((c) => c.selector === col.selector && c.index === col.index && c.type === col.type);
      if (dup) toast(`“${dup.name}” already extracts that field`);
      else { S.columns.push(col); C.uniqueNames(S.columns); toast(`Added column “${col.name}”`); }
      S.lastPick = { el, rel: { selector: col.selector, index: col.index }, item: it };
      refresh(); renderCols();
    } else if (kind === 'next') {
      S.pagination.next = C.describeNext(el);
      S.pagination.mode = 'next';
      toast('Next button saved');
    }
    renderAll();
  }

  // ---------------------------------------------------------------- crawling
  function fingerprint() {
    const items = queryItems();
    const f = items[0]; const l = items[items.length - 1];
    return `${items.length}|${f ? C.textOf(f).slice(0, 200) : ''}|${l ? C.textOf(l).slice(0, 200) : ''}|${location.href}`;
  }

  async function waitForChange(before, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end && !S.stopRequested) {
      await new Promise((r) => setTimeout(r, 250));
      if (fingerprint() !== before) {
        // Let the page settle: wait until the fingerprint is stable for a moment.
        let last = fingerprint();
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const now = fingerprint();
          if (now === last) break;
          last = now;
        }
        return true;
      }
    }
    return false;
  }

  function scrollTarget() {
    const it = S.items[S.items.length - 1] || queryItems().pop();
    let el = it && it.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scrollMore(delayMs) {
    const before = fingerprint();
    const target = scrollTarget();
    const last = queryItems().pop();
    if (last) last.scrollIntoView({ block: 'end' });
    target.scrollTop = target.scrollHeight;
    if (target === document.scrollingElement) scrollTo(0, document.documentElement.scrollHeight);
    const changed = await waitForChange(before, Math.max(3000, delayMs + 2500));
    if (changed) await sleep(Math.min(delayMs, 1500));
    return changed;
  }

  const seenRows = new WeakMap(); // live element -> row key, avoids re-adding unchanged rows

  function extractFrom(doc, base) {
    const recipe = currentRecipe();
    const items = C.safeQueryAll(doc, recipe.itemSelector).filter((el) => !host.contains(el));
    const rows = [];
    for (const it of items) {
      const row = recipe.columns.map((c) => C.valueOf(it, c, base));
      if (doc === document) {
        const key = C.rowKey(row);
        if (seenRows.get(it) === key) continue;
        seenRows.set(it, key);
      }
      rows.push(row);
    }
    return rows;
  }

  async function fetchDoc(url) {
    try {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (!/html|xml/.test(type)) return null;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { doc, url: res.url || url };
    } catch { return null; }
  }

  function setProgress(p) { S.progress = { ...(S.progress || {}), ...p }; renderProgress(); }

  async function startCrawl(resumeState) {
    if (S.crawling) return;
    if (!S.itemSelector || !S.columns.length) { toast('Select items and columns first.'); return; }
    stopPick();
    S.crawling = true; S.stopRequested = false;
    const p = S.pagination;
    const max = p.mode === 'none' ? 1 : Math.max(1, Math.min(1000, p.maxPages | 0 || 1));
    const delayMs = Math.max(0, Number(p.delay) || 0) * 1000;
    let sessionId = resumeState && resumeState.sessionId;
    let page = resumeState ? resumeState.page : 1;
    if (!sessionId) {
      const res = await send({
        type: 'ps:session:create', dedupe: S.dedupe,
        meta: { title: document.title, url: location.href, itemSelector: S.itemSelector, recipeName: S.recipeName, recipe: currentRecipe() },
        columns: S.columns.map((c) => c.name),
      });
      if (!res.id) { S.crawling = false; renderProgress(); toast(res.error || 'Could not start: reload the page and try again.'); return; }
      sessionId = res.id;
    }
    S.lastSessionId = sessionId;
    setProgress({ page, max, total: resumeState ? resumeState.total || 0 : 0, status: 'extracting' });
    let doc = document; let base = location.href;
    const visited = new Set([location.href.split('#')[0]]);
    let note = '';
    let total = 0;
    try {
      for (;;) {
        const rows = extractFrom(doc, base);
        const res = await send({ type: 'ps:session:append', id: sessionId, rows, page });
        if (res.error) { note = res.error; break; }
        total = res.total;
        setProgress({ page, total, status: `${res.added} new` });
        if (S.stopRequested) { note = 'Stopped by you.'; break; }
        if (page >= max || p.mode === 'none') break;

        if (p.mode === 'scroll') {
          setProgress({ status: 'scrolling' });
          const more = await scrollMore(delayMs);
          if (!more) { note = 'No more items loaded.'; break; }
          page++;
          continue;
        }

        // "next" mode
        const next = C.findNext(doc, p.next);
        if (!next) { note = 'No more "next" button.'; break; }
        const href = next.tagName === 'A' ? C.absUrl(next.getAttribute('href'), base) : '';
        const sameOrigin = href && (() => { try { return new URL(href).origin === location.origin; } catch { return false; } })();
        if (href && sameOrigin && !visited.has(href.split('#')[0]) && !/^#/.test(next.getAttribute('href'))) {
          setProgress({ status: 'waiting' });
          await sleep(delayMs);
          if (S.stopRequested) { note = 'Stopped by you.'; break; }
          setProgress({ status: 'loading next page' });
          const got = await fetchDoc(href);
          if (got && C.safeQueryAll(got.doc, S.itemSelector).length) {
            visited.add(href.split('#')[0]);
            visited.add(got.url.split('#')[0]);
            doc = got.doc; base = got.url; page++;
            continue;
          }
          if (doc !== document) { note = 'The next page could not be loaded in the background.'; break; }
        } else if (href && visited.has(href.split('#')[0])) { note = 'Reached a page that was already visited.'; break; }
        if (doc !== document) { note = 'Next button requires the page to be clicked; stopped.'; break; }

        // Click in the live page (JS pagination, load more, or full reload).
        setProgress({ status: 'waiting' });
        await sleep(delayMs);
        if (S.stopRequested) { note = 'Stopped by you.'; break; }
        const before = fingerprint();
        await send({ type: 'ps:crawl:pending', state: { sessionId, page: page + 1, total, recipe: currentRecipe(), recipeName: S.recipeName, openWhenDone: S.openWhenDone } });
        setProgress({ status: 'clicking next' });
        next.scrollIntoView({ block: 'center' });
        next.click();
        const changed = await waitForChange(before, 15000);
        await send({ type: 'ps:crawl:clear' });
        if (!changed) { note = 'The page did not change after clicking next.'; break; }
        page++;
      }
    } catch (e) {
      note = 'Error: ' + (e && e.message || e);
    }
    const fin = await send({ type: 'ps:session:finish', id: sessionId, pages: page, status: S.stopRequested ? 'stopped' : 'done', note });
    S.crawling = false; S.stopRequested = false;
    renderProgress();
    refresh();
    const count = fin.total ?? total;
    toast(`Scraped ${count} row${count === 1 ? '' : 's'} from ${page} page${page === 1 ? '' : 's'}${note && page > 1 ? '. ' + note : ''}`, 4000);
    if (S.openWhenDone) send({ type: 'ps:openResults', id: sessionId });
  }

  // ---------------------------------------------------------------- recipes
  async function saveRecipe() {
    if (!S.itemSelector || !S.columns.length) { toast('Nothing to save yet.'); return; }
    const name = ($('recipeName').value || '').trim() || `${location.host} · ${S.columns[0].name}`;
    S.recipeName = name;
    const { recipes = [] } = await chrome.storage.local.get('recipes');
    const existing = recipes.find((r) => (S.recipeId && r.id === S.recipeId) || (r.host === location.host && r.name === name));
    const recipe = {
      ...currentRecipe(),
      id: existing ? existing.id : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, host: location.host, url: location.href,
      createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(),
    };
    const list = existing ? recipes.map((r) => (r.id === recipe.id ? recipe : r)) : [recipe, ...recipes];
    await chrome.storage.local.set({ recipes: list });
    S.recipeId = recipe.id;
    $('recipeName').value = name;
    toast(existing ? `Updated recipe “${name}”` : `Saved recipe “${name}”`);
  }

  function loadRecipe(r) {
    S.mode = 'manual'; S.levels = []; S.levelIndex = 0;
    S.recipeName = r.name || ''; S.recipeId = r.id || '';
    S.pagination = { mode: 'none', next: null, maxPages: 10, delay: 1.5, ...(r.pagination || {}) };
    S.dedupe = r.dedupe !== false;
    setSelection(r.itemSelector, (r.columns || []).map((c) => ({ ...c })));
    S.banner = `Recipe “${r.name}” loaded: ${S.items.length} items on this page.`;
    renderAll();
  }

  // ---------------------------------------------------------------- clipboard
  async function copyRows() {
    const esc = (v) => String(v).replace(/[\t\r\n]+/g, ' ');
    const all = S.items.map((it) => S.columns.map((c) => C.valueOf(it, c, location.href)));
    const text = [S.columns.map((c) => esc(c.name)).join('\t'), ...all.map((r) => r.map(esc).join('\t'))].join('\n');
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      root.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(`Copied ${all.length} rows. Paste into Google Sheets or Excel.`);
  }

  // ---------------------------------------------------------------- events
  $('tabAuto').addEventListener('click', () => {
    S.mode = 'auto'; S.banner = ''; stopPick(); renderAll();
    if (!S.candidates.length) runDetect(); else applyCandidate(S.candIndex);
  });
  $('tabManual').addEventListener('click', () => { S.mode = 'manual'; S.banner = ''; renderAll(); if (!S.levels.length) startPick('items'); });
  root.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const other = e.target.id === 'tabAuto' ? $('tabManual') : $('tabAuto'); other.focus(); other.click(); }
  });
  $('candPrev').addEventListener('click', () => applyCandidate((S.candIndex - 1 + S.candidates.length) % S.candidates.length));
  $('candNext').addEventListener('click', () => applyCandidate((S.candIndex + 1) % S.candidates.length));
  $('redetect').addEventListener('click', runDetect);
  $('pickItems').addEventListener('click', () => (S.pick && S.pick.kind === 'items' ? stopPick() : startPick('items')));
  $('wider').addEventListener('click', () => { if (S.levelIndex < S.levels.length - 1) { S.levelIndex++; applyLevel(); } });
  $('narrower').addEventListener('click', () => { if (S.levelIndex > 0) { S.levelIndex--; applyLevel(); } });
  $('itemSel').addEventListener('change', () => {
    const v = $('itemSel').value.trim();
    if (!v) return;
    try { document.querySelector(v); } catch { toast('That is not a valid CSS selector.'); return; }
    const keep = S.columns.length ? S.columns : C.inferColumns(C.safeQueryAll(document, v), location.href);
    setSelection(v, keep);
  });
  $('addCol').addEventListener('click', () => (S.pick && S.pick.kind === 'column' ? stopPick() : startPick('column')));
  $('autoCols').addEventListener('click', () => { if (S.itemSelector) setSelection(S.itemSelector, C.inferColumns(queryItems(), location.href)); });
  $('clearCols').addEventListener('click', () => { S.columns = []; S.lastPick = null; refresh(); renderCols(); renderProgress(); });

  $('cols').addEventListener('input', (e) => {
    const rowEl = e.target.closest('.col'); if (!rowEl) return;
    const col = S.columns.find((c) => c.id === rowEl.dataset.id); if (!col) return;
    const f = e.target.dataset.f;
    if (f === 'name') { col.name = e.target.value; renderPreview(); }
    if (f === 'attr') { col.attr = e.target.value.trim(); refresh(); }
  });
  $('cols').addEventListener('change', (e) => {
    const rowEl = e.target.closest('.col'); if (!rowEl) return;
    const col = S.columns.find((c) => c.id === rowEl.dataset.id); if (!col) return;
    if (e.target.dataset.f === 'type') { col.type = e.target.value; refresh(); renderCols(); }
    if (e.target.dataset.f === 'name' && !col.name.trim()) { col.name = 'Column'; C.uniqueNames(S.columns); renderCols(); }
  });
  $('cols').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const rowEl = b.closest('.col');
    const i = S.columns.findIndex((c) => c.id === rowEl.dataset.id); if (i < 0) return;
    const a = b.dataset.a;
    if (a === 'del') { S.columns.splice(i, 1); S.hoverCol = null; }
    if (a === 'up' && i > 0) [S.columns[i - 1], S.columns[i]] = [S.columns[i], S.columns[i - 1]];
    if (a === 'down' && i < S.columns.length - 1) [S.columns[i + 1], S.columns[i]] = [S.columns[i], S.columns[i + 1]];
    refresh(); renderCols(); renderProgress();
    const again = $('cols').querySelector(`.col[data-id="${CSS.escape(rowEl.dataset.id)}"] button[data-a="${a}"]`);
    if (again && !again.disabled) again.focus();
  });
  $('cols').addEventListener('mouseover', (e) => { const r = e.target.closest('.col'); const id = r ? r.dataset.id : null; if (id !== S.hoverCol) { S.hoverCol = id; queueDraw(); } });
  $('cols').addEventListener('mouseleave', () => { S.hoverCol = null; queueDraw(); });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-chip]'); if (!b || !S.lastPick) return;
    const lp = S.lastPick;
    const t = b.dataset.chip;
    const col = C.makeColumn('', lp.rel.selector, lp.rel.index, t, b.dataset.attr || '');
    const base = S.columns.find((c) => c.selector === lp.rel.selector && c.index === lp.rel.index);
    const label = { href: 'link', src: 'image', text: 'text', attr: b.dataset.attr }[t];
    col.name = base ? `${base.name} ${label}` : label.replace(/^./, (x) => x.toUpperCase());
    S.columns.push(col); C.uniqueNames(S.columns);
    refresh(); renderCols(); renderProgress();
  });
  $('preview').addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-row]'); const i = tr ? +tr.dataset.row : -1;
    if (i !== S.hoverRow) { S.hoverRow = i; queueDraw(); }
  });
  $('preview').addEventListener('mouseleave', () => { S.hoverRow = -1; queueDraw(); });
  $('preview').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-row]'); if (!tr) return;
    const it = S.items[+tr.dataset.row]; if (it) it.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  $('pgMode').addEventListener('change', () => { S.pagination.mode = $('pgMode').value; S.banner = ''; renderBanner(); renderPagination(); renderProgress(); });
  $('pickNext').addEventListener('click', () => (S.pick && S.pick.kind === 'next' ? stopPick() : startPick('next')));
  $('autoNext').addEventListener('click', () => {
    const n = C.autoFindNext(document);
    if (!n) { toast('No "next" button found. Pick it manually.'); return; }
    S.pagination.next = C.describeNext(n);
    const r = n.getBoundingClientRect();
    showFlash(r);
    renderPagination();
    toast(`Using “${S.pagination.next.text || S.pagination.next.aria || 'next'}”`);
  });
  $('maxPages').addEventListener('change', () => { S.pagination.maxPages = Math.max(1, Math.min(1000, parseInt($('maxPages').value, 10) || 1)); renderPagination(); renderProgress(); });
  $('delay').addEventListener('change', () => { S.pagination.delay = Math.max(0, Math.min(60, Number($('delay').value) || 0)); renderPagination(); });
  $('dedupe').addEventListener('change', () => { S.dedupe = $('dedupe').checked; });
  $('openDone').addEventListener('change', () => { S.openWhenDone = $('openDone').checked; try { chrome.storage.local.set({ openWhenDone: S.openWhenDone }); } catch { /* ignore */ } });
  $('recipeName').addEventListener('input', () => { S.recipeName = $('recipeName').value; });
  $('recipeName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveRecipe(); });
  $('saveRecipe').addEventListener('click', saveRecipe);
  $('scrapeBtn').addEventListener('click', () => startCrawl());
  $('stopBtn').addEventListener('click', () => { S.stopRequested = true; setProgress({ status: 'stopping' }); send({ type: 'ps:crawl:clear' }); });
  $('copyBtn').addEventListener('click', copyRows);
  $('resultsBtn').addEventListener('click', () => send({ type: 'ps:openResults', id: S.lastSessionId }));
  $('minBtn').addEventListener('click', () => { S.minimized = !S.minimized; panel.classList.toggle('min', S.minimized); $('minBtn').setAttribute('aria-label', S.minimized ? 'Expand panel' : 'Minimize panel'); });
  $('closeBtn').addEventListener('click', closePanel);

  function showFlash(r) {
    const hb = $('hoverBox');
    Object.assign(hb.style, { display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
    setTimeout(() => { if (!S.pick) hb.style.display = 'none'; }, 1200);
  }

  // Dragging the panel by its header.
  (() => {
    let sx = 0; let sy = 0; let ox = 0; let oy = 0; let dragging = false;
    $('drag').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      $('drag').setPointerCapture(e.pointerId);
    });
    $('drag').addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(innerWidth - 120, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy));
      Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto' });
    });
    $('drag').addEventListener('pointerup', () => { dragging = false; });
  })();

  // Keep keystrokes typed in our panel from reaching page shortcuts.
  for (const ev of ['keydown', 'keyup', 'keypress']) root.addEventListener(ev, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !S.pick && !S.crawling) closePanel(); });

  // ---------------------------------------------------------------- open / close
  async function openPanel() {
    mount();
    if (!S.open) {
      S.open = true;
      panel.hidden = false;
      try { const { openWhenDone } = await chrome.storage.local.get('openWhenDone'); if (typeof openWhenDone === 'boolean') S.openWhenDone = openWhenDone; } catch { /* ignore */ }
      watchMutations(true);
    }
    renderAll();
  }

  function closePanel() {
    if (S.crawling) { S.stopRequested = true; }
    stopPick();
    S.open = false; panel.hidden = true;
    watchMutations(false);
    queueDraw();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'ps:ping') { sendResponse({ alive: true, crawling: S.crawling }); return false; }
    if (msg.type === 'ps:open') {
      openPanel().then(() => {
        if (msg.action === 'manual') { S.mode = 'manual'; renderAll(); startPick('items'); }
        else if (msg.action === 'recipe' && msg.recipe) { loadRecipe(msg.recipe); if (msg.run) startCrawl(); }
        else { S.mode = 'auto'; renderAll(); runDetect(); }
      });
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'ps:crawl:resume' && msg.state) {
      const st = msg.state;
      openPanel().then(() => {
        loadRecipe({ ...st.recipe, name: st.recipeName || '' });
        S.banner = 'Continuing the crawl on the new page…';
        S.openWhenDone = st.openWhenDone !== false;
        renderAll();
        setTimeout(() => startCrawl({ sessionId: st.sessionId, page: st.page, total: st.total }), 300);
      });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
