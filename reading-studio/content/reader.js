// Reading Studio reader view: a full-screen, style-isolated overlay with typography controls.
(function () {
  const RS = globalThis.RS;
  if (!RS || RS.reader) return;

  const FONTS = {
    serif: { label: 'Serif', stack: '"Iowan Old Style","Charter","Bitstream Charter","Sitka Text",Cambria,Georgia,"Times New Roman",serif' },
    sans: { label: 'Sans', stack: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif' },
    slab: { label: 'Slab', stack: '"Rockwell","Roboto Slab","Zilla Slab","Museo Slab","DejaVu Serif",Georgia,serif' },
    mono: { label: 'Mono', stack: 'ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace' },
    dyslexic: { label: 'Dyslexia-friendly', stack: '"OpenDyslexic","OpenDyslexic3","Lexend","Atkinson Hyperlegible","Comic Sans MS","Comic Neue",Verdana,Tahoma,sans-serif' }
  };
  const THEMES = ['auto', 'light', 'sepia', 'dark', 'black'];

  const RD = { open: false, host: null, root: null, art: null, saved: null, bionic: false, saveT: 0 };

  function css() {
    return `
:host{all:initial}
*{box-sizing:border-box}
.reader{position:fixed;inset:0;overflow:auto;overscroll-behavior:contain;background:var(--bg);color:var(--fg);
  --font:${FONTS.serif.stack};--size:20px;--lh:1.7;--width:720px;--ui:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-family:var(--font);font-size:var(--size);line-height:var(--lh);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;scroll-behavior:auto}
.reader:focus{outline:none}
.t-light{--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--link:#0b57d0;--rule:#e6e8eb;--code:#f3f4f6;--chrome:rgba(255,255,255,.88);--btn-h:rgba(0,0,0,.06);--acc:#5b4bdb;--acc-fg:#fff;--hl:rgba(255,206,64,.42);--hlw:rgba(255,145,0,.5);--shadow:rgba(0,0,0,.12)}
.t-sepia{--bg:#f6efe0;--fg:#46382a;--muted:#86725b;--link:#8a4510;--rule:#e3d5b8;--code:#efe3c9;--chrome:rgba(246,239,224,.9);--btn-h:rgba(70,56,42,.08);--acc:#9a5b1e;--acc-fg:#fff;--hl:rgba(220,160,40,.3);--hlw:rgba(215,115,15,.42);--shadow:rgba(70,56,42,.16)}
.t-dark{--bg:#1c1d21;--fg:#d9dade;--muted:#9a9ea8;--link:#8ab4f8;--rule:#30323a;--code:#26282e;--chrome:rgba(28,29,33,.88);--btn-h:rgba(255,255,255,.08);--acc:#9d90ff;--acc-fg:#16131f;--hl:rgba(255,206,64,.22);--hlw:rgba(255,150,0,.42);--shadow:rgba(0,0,0,.5)}
.t-black{--bg:#000000;--fg:#c8c8c8;--muted:#888;--link:#7fb0ff;--rule:#1d1d1d;--code:#111;--chrome:rgba(0,0,0,.85);--btn-h:rgba(255,255,255,.09);--acc:#9d90ff;--acc-fg:#000;--hl:rgba(255,206,64,.2);--hlw:rgba(255,150,0,.4);--shadow:rgba(0,0,0,.7)}
::highlight(rs-tts-sentence){background-color:var(--hl);color:inherit}
::highlight(rs-tts-word){background-color:var(--hlw);color:inherit;text-decoration:underline 2px}
::selection{background:var(--hl)}

.progress{position:sticky;top:0;height:3px;z-index:3;background:transparent}
.progress .fill{height:100%;width:0;background:var(--acc);transition:width .08s linear}
.bar{position:sticky;top:3px;z-index:2;display:flex;align-items:center;gap:4px;padding:6px 12px;font:14px/1.2 var(--ui);color:var(--fg);
  background:var(--chrome);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--rule);transition:transform .2s ease,opacity .2s}
.bar.hide{transform:translateY(-110%);opacity:0}
.bar .site{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:13px;padding:0 6px}
.bar .left{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;padding:0 6px}
button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;min-width:36px;padding:0 8px;border-radius:10px;color:var(--fg);font:500 13px/1 var(--ui)}
button:hover{background:var(--btn-h)}
button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
button svg{width:20px;height:20px;flex:none}
button[aria-pressed=true]{background:var(--btn-h);color:var(--acc)}
.listen{background:var(--acc);color:var(--acc-fg);padding:0 12px 0 10px;font-weight:600}
.listen:hover{background:var(--acc);filter:brightness(1.07)}
.listen svg{width:16px;height:16px}

.panel{position:fixed;top:56px;right:12px;z-index:4;width:min(340px,calc(100vw - 24px));max-height:calc(100vh - 72px);overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--rule);border-radius:14px;
  box-shadow:0 16px 48px var(--shadow);padding:14px;font:13px/1.4 var(--ui);display:grid;gap:14px}
.panel[hidden]{display:none}
.panel h3{margin:0 0 6px;font:600 11.5px/1 var(--ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{height:32px;border:1px solid var(--rule);padding:0 10px}
.chips button[aria-pressed=true]{border-color:var(--acc);background:var(--btn-h);color:var(--fg);box-shadow:inset 0 0 0 1px var(--acc)}
.stepper{display:flex;align-items:center;gap:8px}
.stepper button{border:1px solid var(--rule);width:36px;font-size:18px}
.stepper output{flex:1;text-align:center;font-variant-numeric:tabular-nums;color:var(--fg)}
.stepper input{flex:1;accent-color:var(--acc)}
.themes{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.themes button{height:44px;flex-direction:column;gap:2px;border:1px solid var(--rule);font-size:11px;padding:0}
.themes button .sw{width:22px;height:14px;border-radius:4px;border:1px solid rgba(128,128,128,.4)}
.themes button[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--acc)}

.page{max-width:var(--width);margin:0 auto;padding:40px 24px 120px}
.kicker{font:500 13px/1.4 var(--ui);color:var(--muted);letter-spacing:.02em;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:6px}
h1.title{font-size:1.9em;line-height:1.18;margin:0 0 14px;font-weight:700;letter-spacing:-.01em}
.byline{font:14px/1.5 var(--ui);color:var(--muted);margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--rule)}
.lead{width:100%;height:auto;border-radius:8px;margin-bottom:24px}
.content{overflow-wrap:break-word}
.content p{margin:0 0 1em}
.content h2,.content h3,.content h4,.content h5,.content h6{line-height:1.25;margin:1.6em 0 .6em;font-weight:700}
.content h2{font-size:1.4em}.content h3{font-size:1.2em}.content h4,.content h5,.content h6{font-size:1.05em}
.content a{color:var(--link);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.content img,.content video{max-width:100%;height:auto;border-radius:6px;display:block;margin:1.2em auto}
.content figure{margin:1.6em 0}
.content figcaption{font:13.5px/1.45 var(--ui);color:var(--muted);margin-top:6px;text-align:center}
.content blockquote{margin:1.4em 0;padding:.2em 0 .2em 1.1em;border-left:3px solid var(--acc);color:var(--fg);font-style:italic}
.content pre{font:14px/1.5 ${FONTS.mono.stack};background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto;white-space:pre}
.content code,.content kbd,.content samp{font-family:${FONTS.mono.stack};font-size:.86em;background:var(--code);padding:.1em .35em;border-radius:4px}
.content pre code{background:none;padding:0;font-size:inherit}
.content ul,.content ol{padding-left:1.4em;margin:0 0 1em}
.content li{margin:.3em 0}
.content hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
.content table{display:block;overflow-x:auto;border-collapse:collapse;margin:1.2em 0;font-size:.85em;font-family:var(--ui);max-width:100%}
.content th,.content td{border:1px solid var(--rule);padding:6px 10px;text-align:left;vertical-align:top}
.content th{background:var(--code)}
.content mark{background:var(--hl);color:inherit}
.content details{margin:1em 0}
.align-justify .content p{text-align:justify;hyphens:auto}
.dys{letter-spacing:.035em;word-spacing:.16em}
.dys .content p{text-align:left !important;hyphens:manual}
.dys em,.dys i{font-style:normal;font-weight:600}
.dys h1.title{letter-spacing:.01em}
.foot{margin-top:48px;padding-top:20px;border-top:1px solid var(--rule);font:13px/1.5 var(--ui);color:var(--muted);display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px}
.foot a{color:var(--link)}
.notice{font:14px/1.5 var(--ui);background:var(--code);border-radius:10px;padding:12px 14px;margin-bottom:24px;color:var(--muted)}
.content.tts-ready{cursor:text}
.reader.tts-on .content p:hover,.reader.tts-on .content li:hover{cursor:pointer}
rs-b{font-weight:700}
@media (max-width:600px){.page{padding:24px 18px 100px}h1.title{font-size:1.6em}.bar .left{display:none}}
@media (prefers-reduced-motion:reduce){.bar{transition:none}}
@media print{.bar,.progress,.panel{display:none}.reader{position:static;overflow:visible}}
`;
  }

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return '';
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; }
  }

  function themeClass(theme) {
    if (theme === 'auto' || !THEMES.includes(theme)) return RS.prefersDark() ? 't-dark' : 't-light';
    return 't-' + theme;
  }

  function applySettings() {
    if (!RD.root) return;
    const r = RS.settings.reader;
    const el = RD.root.querySelector('.reader');
    const font = FONTS[r.font] || FONTS.serif;
    el.style.setProperty('--font', font.stack);
    el.style.setProperty('--size', Math.max(14, Math.min(32, +r.size || 20)) + 'px');
    el.style.setProperty('--lh', String(Math.max(1.2, Math.min(2.4, +r.lineHeight || 1.7)) + (r.font === 'dyslexic' ? 0.1 : 0)));
    el.style.setProperty('--width', Math.max(480, Math.min(1100, +r.width || 720)) + 'px');
    el.className = ['reader', themeClass(r.theme), r.align === 'justify' ? 'align-justify' : '', r.font === 'dyslexic' ? 'dys' : '', RS.tts && RS.tts.session && RS.tts.session.source === 'reader' ? 'tts-on' : ''].filter(Boolean).join(' ');
    syncPanel();
    updateProgress();
  }

  function save(patch) {
    Object.assign(RS.settings.reader, patch);
    applySettings();
    clearTimeout(RD.saveT);
    RD.saveT = setTimeout(() => RS.saveSettings({ reader: patch }), 250);
  }

  function syncPanel() {
    const p = RD.root && RD.root.querySelector('.panel');
    if (!p) return;
    const r = RS.settings.reader;
    for (const b of p.querySelectorAll('[data-font]')) b.setAttribute('aria-pressed', String(b.dataset.font === r.font));
    for (const b of p.querySelectorAll('[data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === r.theme));
    for (const b of p.querySelectorAll('[data-align]')) b.setAttribute('aria-pressed', String(b.dataset.align === r.align));
    p.querySelector('.o-size').textContent = r.size + 'px';
    p.querySelector('.o-lh').textContent = (+r.lineHeight).toFixed(1);
    const w = p.querySelector('.i-width'); if (document.activeElement !== RD.host || RD.root.activeElement !== w) w.value = r.width;
    p.querySelector('.o-width').textContent = r.width + 'px';
    const bar = RD.root.querySelector('.bar');
    bar.querySelector('.ruler').setAttribute('aria-pressed', String(!!(RS.focus && RS.focus.rulerOn)));
    bar.querySelector('.bionic').setAttribute('aria-pressed', String(RD.bionic));
  }

  function updateProgress() {
    if (!RD.root) return;
    const sc = RD.root.querySelector('.reader');
    const max = sc.scrollHeight - sc.clientHeight;
    const f = max > 0 ? Math.min(1, sc.scrollTop / max) : 1;
    RD.root.querySelector('.progress .fill').style.width = (f * 100).toFixed(2) + '%';
    const total = RD.art ? RD.art.readingMinutes * Math.max(0.2, (RD.art.wpmBase || 230) / (RS.settings.reader.wpm || 230)) : 0;
    const left = Math.ceil(total * (1 - f));
    RD.root.querySelector('.bar .left').textContent = f >= 0.995 ? 'Finished' : `${left} min left`;
  }

  function readTarget() {
    if (!RD.open) return null;
    const title = RD.root.querySelector('h1.title');
    const content = RD.root.querySelector('.content');
    return { roots: [title, content].filter(Boolean), scroller: RD.root.querySelector('.reader'), styleRoot: RD.root, lang: RD.art && RD.art.lang };
  }

  function setBionic(on) {
    RD.bionic = !!on;
    if (!RD.root) return;
    const content = RD.root.querySelector('.content');
    if (on) RS.focus.applyBionic(content, RS.settings.focus.bionicStrength, RD.root);
    else RS.focus.removeBionic(content);
    syncPanel();
    document.dispatchEvent(new CustomEvent('rs:bionic-change', { detail: { on, scope: 'reader' } }));
  }

  function build(art) {
    const { host, root } = RS.createHost('rs-reader', 2147483645);
    host.style.setProperty('inset', '0', 'important');
    RD.host = host; RD.root = root;
    const I = RS.icons;
    const h = RS.h;
    const style = document.createElement('style');
    style.textContent = css();
    root.appendChild(style);

    const fontChips = Object.entries(FONTS).map(([k, f]) => `<button data-font="${k}" style="font-family:${f.stack.replace(/"/g, '&quot;')}">${f.label}</button>`).join('');
    const swatch = { auto: 'linear-gradient(135deg,#fff 50%,#1c1d21 50%)', light: '#fff', sepia: '#f6efe0', dark: '#1c1d21', black: '#000' };
    const themeBtns = THEMES.map((t) => `<button data-theme="${t}" title="${t[0].toUpperCase() + t.slice(1)} theme"><span class="sw" style="background:${swatch[t]}"></span>${t[0].toUpperCase() + t.slice(1)}</button>`).join('');

    const wrap = document.createElement('div');
    wrap.className = 'reader';
    wrap.tabIndex = -1;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Reader view');
    wrap.innerHTML = `
<div class="progress" aria-hidden="true"><div class="fill"></div></div>
<div class="bar" role="toolbar" aria-label="Reader controls">
  <button class="close" title="Close reader (Esc)" aria-label="Close reader">${I.close}</button>
  <span class="site"></span>
  <span class="left"></span>
  <button class="listen" title="Read aloud" aria-label="Read aloud">${I.play}<span>Listen</span></button>
  <button class="ruler" title="Reading ruler" aria-label="Reading ruler" aria-pressed="false">${I.ruler}</button>
  <button class="bionic" title="Bold word starts" aria-label="Bold word starts" aria-pressed="false">${I.bold}</button>
  <button class="type" title="Typography and theme" aria-label="Typography and theme" aria-expanded="false">${I.type}</button>
</div>
<div class="panel" hidden role="dialog" aria-label="Typography">
  <section><h3>Font</h3><div class="chips">${fontChips}</div></section>
  <section><h3>Size</h3><div class="stepper"><button class="size-dn" aria-label="Smaller text">−</button><output class="o-size"></output><button class="size-up" aria-label="Larger text">+</button></div></section>
  <section><h3>Line spacing</h3><div class="stepper"><button class="lh-dn" aria-label="Tighter lines">−</button><output class="o-lh"></output><button class="lh-up" aria-label="Looser lines">+</button></div></section>
  <section><h3>Width</h3><div class="stepper"><input type="range" class="i-width" min="480" max="1100" step="20" aria-label="Column width"><output class="o-width"></output></div></section>
  <section><h3>Theme</h3><div class="themes">${themeBtns}</div></section>
  <section><h3>Alignment</h3><div class="chips"><button data-align="left">Left</button><button data-align="justify">Justified</button></div></section>
</div>
<article class="page">
  <div class="kicker"></div>
  <h1 class="title"></h1>
  <div class="byline" data-rs-skip></div>
  <div class="content"></div>
  <footer class="foot" data-rs-skip><span>Original: <a class="orig" target="_blank" rel="noopener noreferrer"></a></span><span>Reading Studio</span></footer>
</article>`;
    root.appendChild(wrap);
    const $ = (s) => root.querySelector(s);

    $('.site').textContent = art.siteName || location.hostname;
    const kicker = $('.kicker');
    kicker.setAttribute('data-rs-skip', '');
    const bits = [art.siteName, fmtDate(art.published)].filter(Boolean);
    kicker.textContent = bits.join(' · ');
    $('h1.title').textContent = art.title || document.title;
    const by = [];
    if (art.byline) by.push('By ' + art.byline);
    by.push(`${art.readingMinutes} min read`);
    by.push(`${art.wordCount.toLocaleString()} words`);
    $('.byline').textContent = by.join(' · ');
    const content = $('.content');
    if (art.dir === 'rtl') wrap.setAttribute('dir', 'rtl');
    if (art.lang) wrap.setAttribute('lang', art.lang);
    if (!art.isProbablyArticle) {
      const n = h('div', { class: 'notice', 'data-rs-skip': '' }, 'This page may not be an article, so some content might be missing or extra.');
      content.before(n);
    }
    if (art.leadImage) {
      const img = h('img', { class: 'lead', src: art.leadImage, alt: '', 'data-rs-skip': '' });
      img.addEventListener('error', () => img.remove());
      $('h1.title').before(img);
    }
    content.appendChild(art.content);
    for (const img of content.querySelectorAll('img')) img.addEventListener('error', () => { const f = img.closest('figure'); (f && !f.textContent.trim() ? f : img).remove(); }, { once: true });
    const orig = $('.orig'); orig.href = location.href; orig.textContent = location.hostname + location.pathname.slice(0, 40) + (location.pathname.length > 40 ? '…' : '');

    // ---- events
    $('.close').addEventListener('click', close);
    $('.listen').addEventListener('click', () => {
      const s = RS.tts.session;
      if (s && s.source === 'reader') RS.tts.toggle(); else RS.tts.start({ source: 'reader' });
    });
    $('.ruler').addEventListener('click', () => { const on = RS.focus.setRuler(!RS.focus.rulerOn); RS.saveSettings({ focus: { ruler: on } }); syncPanel(); });
    $('.bionic').addEventListener('click', () => { const on = !RD.bionic; RS.settings.focus.bionic = on; setBionic(on); RS.saveSettings({ focus: { bionic: on } }); });
    const panel = $('.panel');
    $('.type').addEventListener('click', () => { panel.hidden = !panel.hidden; $('.type').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) panel.querySelector('button').focus(); });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const r = RS.settings.reader;
      if (b.dataset.font) save({ font: b.dataset.font });
      else if (b.dataset.theme) save({ theme: b.dataset.theme });
      else if (b.dataset.align) save({ align: b.dataset.align });
      else if (b.classList.contains('size-dn')) save({ size: Math.max(14, r.size - 1) });
      else if (b.classList.contains('size-up')) save({ size: Math.min(32, r.size + 1) });
      else if (b.classList.contains('lh-dn')) save({ lineHeight: Math.max(1.2, Math.round((r.lineHeight - 0.1) * 10) / 10) });
      else if (b.classList.contains('lh-up')) save({ lineHeight: Math.min(2.4, Math.round((r.lineHeight + 0.1) * 10) / 10) });
    });
    panel.querySelector('.i-width').addEventListener('input', (e) => save({ width: +e.target.value }));
    wrap.addEventListener('click', (e) => {
      if (!panel.hidden && !e.target.closest('.panel') && !e.target.closest('.type')) { panel.hidden = true; $('.type').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.content') && !e.target.closest('h1.title')) return;
      const s = RS.tts.session;
      if (s && s.source === 'reader') { if (RS.tts.handleClick(e, e.target)) e.preventDefault(); }
      else if (e.altKey && !e.target.closest('a')) {
        e.preventDefault();
        RS.tts.start({ source: 'reader', index: 0 }).then(() => RS.tts.handleClick({ button: 0, clientX: e.clientX, clientY: e.clientY }, e.target));
      }
    });
    let lastY = 0;
    wrap.addEventListener('scroll', () => {
      updateProgress();
      const y = wrap.scrollTop;
      const bar = $('.bar');
      if (y > lastY + 6 && y > 120 && panel.hidden) bar.classList.add('hide');
      else if (y < lastY - 6 || y < 120) bar.classList.remove('hide');
      lastY = y;
    }, { passive: true });
    wrap.addEventListener('pointermove', (e) => { if (e.clientY < 70) $('.bar').classList.remove('hide'); }, { passive: true });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!panel.hidden) { panel.hidden = true; $('.type').setAttribute('aria-expanded', 'false'); $('.type').focus(); }
        else close();
        e.stopPropagation(); e.preventDefault();
        return;
      }
      // Keep page hotkeys (j/k, /, etc.) from firing while reading.
      e.stopPropagation();
    });
    root.addEventListener('keyup', (e) => e.stopPropagation());
    root.addEventListener('keypress', (e) => e.stopPropagation());
    return wrap;
  }

  async function open() {
    if (RD.open) return true;
    await RS.ready;
    let art;
    try { art = RS.extract(document, { wpm: RS.settings.reader.wpm }); } catch (e) { console.warn('[Reading Studio] extraction failed', e); }
    if (!art || art.textLength < 40) { RS.toast('Reader view could not find readable text on this page.'); return false; }
    art.wpmBase = RS.settings.reader.wpm || 230;
    RD.art = art;
    // A page-level read-aloud session would fight with the overlay: stop it.
    if (RS.tts && RS.tts.session && RS.tts.session.source !== 'reader') RS.tts.stop();
    if (RS.focus && RS.focus.pageBionic) RS.focus.setPageBionic(false);
    const html = document.documentElement;
    RD.saved = { htmlOverflow: html.style.getPropertyValue('overflow'), htmlPri: html.style.getPropertyPriority('overflow'), bodyOverflow: document.body ? document.body.style.getPropertyValue('overflow') : '', bodyPri: document.body ? document.body.style.getPropertyPriority('overflow') : '', scrollY };
    html.style.setProperty('overflow', 'hidden', 'important');
    if (document.body) document.body.style.setProperty('overflow', 'hidden', 'important');
    html.setAttribute('data-rs-reader', '');
    RD.open = true;
    const wrap = build(art);
    applySettings();
    if (RS.settings.focus.bionic) setBionic(true);
    wrap.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('rs:reader-change', { detail: { open: true } }));
    return true;
  }

  function close() {
    if (!RD.open) return false;
    if (RS.tts && RS.tts.session && RS.tts.session.source === 'reader') RS.tts.stop();
    RD.open = false;
    if (RD.host) RD.host.remove();
    RD.host = RD.root = null;
    const html = document.documentElement;
    html.removeAttribute('data-rs-reader');
    const s = RD.saved || {};
    if (s.htmlOverflow) html.style.setProperty('overflow', s.htmlOverflow, s.htmlPri); else html.style.removeProperty('overflow');
    if (document.body) { if (s.bodyOverflow) document.body.style.setProperty('overflow', s.bodyOverflow, s.bodyPri); else document.body.style.removeProperty('overflow'); }
    RD.art = null;
    document.dispatchEvent(new CustomEvent('rs:reader-change', { detail: { open: false } }));
    return true;
  }

  RS.onSettings((s, changed) => {
    if (!RD.open) return;
    if (changed.has('reader')) applySettings();
    if (changed.has('focus') && !!s.focus.bionic !== RD.bionic) setBionic(!!s.focus.bionic);
    if (changed.has('focus')) syncPanel();
  });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applySettings()); } catch (e) { /* ignore */ }
  document.addEventListener('rs:tts-change', () => { if (RD.open) applySettings(); });
  document.addEventListener('rs:focus-change', () => { if (RD.open) syncPanel(); });

  RS.reader = { open, close, isOpen: () => RD.open, isDarkTheme: () => /t-(dark|black)/.test(themeClass(RS.settings.reader.theme)), readTarget, setBionic, applySettings };

  RS.handlers['reader-toggle'] = async () => (RD.open ? (close(), false) : open());
  RS.handlers['reader-open'] = async () => open();
  RS.handlers['reader-close'] = async () => close();
})();
