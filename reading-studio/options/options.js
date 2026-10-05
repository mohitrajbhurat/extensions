// Reading Studio options page.
const S = globalThis.RS_SETTINGS;
const $ = (id) => document.getElementById(id);

const FONT_STACKS = {
  serif: '"Iowan Old Style","Charter","Sitka Text",Cambria,Georgia,serif',
  sans: 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
  slab: '"Rockwell","Roboto Slab","Zilla Slab","DejaVu Serif",Georgia,serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
  dyslexic: '"OpenDyslexic","Lexend","Atkinson Hyperlegible","Comic Sans MS",Verdana,sans-serif'
};

let settings = S.clone(S.DEFAULTS);

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

async function save(section, key, value) {
  settings[section][key] = value;
  await S.update({ [section]: { [key]: value } });
  render();
}

function seg(id, value, onPick) {
  const el = $(id);
  for (const b of el.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); });
  }
}

function slider(id, value, fmt, onChange) {
  const el = $(id);
  el.value = value;
  $(id + '-o').textContent = fmt(value);
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('input', (e) => { $(id + '-o').textContent = fmt(e.target.value); });
    el.addEventListener('change', (e) => onChange(+e.target.value));
  }
}

function check(id, value, onChange) {
  const el = $(id);
  el.checked = !!value;
  if (!el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('change', (e) => onChange(e.target.checked)); }
}

function select(id, value, onChange) {
  const el = $(id);
  el.value = value;
  if (!el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('change', (e) => onChange(e.target.value)); }
}

// ------------------------------------------------------------------ render
function renderPreview() {
  const r = settings.reader;
  const p = $('preview');
  p.className = 'preview t-' + (r.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : r.theme);
  p.style.fontFamily = FONT_STACKS[r.font] || FONT_STACKS.serif;
  p.style.fontSize = r.size + 'px';
  p.style.lineHeight = String(r.lineHeight);
  p.style.maxWidth = r.width + 'px';
  p.style.textAlign = r.align === 'justify' ? 'justify' : 'left';
  p.style.letterSpacing = r.font === 'dyslexic' ? '.035em' : '';
  p.style.wordSpacing = r.font === 'dyslexic' ? '.16em' : '';
}

function renderBionicDemo() {
  const text = 'Bold word starts give the eye a fixation point in every word, so your brain can fill in the rest.';
  const s = settings.focus.bionicStrength;
  $('bionic-demo').innerHTML = '';
  for (const word of text.split(/(\s+)/)) {
    if (!word.trim()) { $('bionic-demo').append(word); continue; }
    const letters = /^[\p{L}\p{N}'’-]+/u.exec(word);
    const w = letters ? letters[0] : word;
    const n = w.length <= 1 ? w.length : w.length <= 3 ? 1 : Math.max(1, Math.min(w.length - 1, Math.round(w.length * s)));
    const b = document.createElement('b');
    b.textContent = w.slice(0, n);
    $('bionic-demo').append(b, w.slice(n) + word.slice(w.length));
  }
}

function render() {
  const { reader: r, tts: t, dark: d, focus: f } = settings;
  select('r-font', r.font, (v) => save('reader', 'font', v));
  seg('r-theme', r.theme, (v) => save('reader', 'theme', v));
  slider('r-size', r.size, (v) => v + 'px', (v) => save('reader', 'size', v));
  slider('r-lineHeight', r.lineHeight, (v) => (+v).toFixed(1), (v) => save('reader', 'lineHeight', v));
  slider('r-width', r.width, (v) => v + 'px', (v) => save('reader', 'width', v));
  slider('r-wpm', r.wpm, (v) => v + ' wpm', (v) => save('reader', 'wpm', v));
  seg('r-align', r.align, (v) => save('reader', 'align', v));
  renderPreview();

  select('t-engine', t.engine, async (v) => { await save('tts', 'engine', v); loadVoices(); });
  select('t-source', t.source, (v) => save('tts', 'source', v));
  slider('t-rate', t.rate, (v) => (Math.round(v * 100) / 100) + '×', (v) => save('tts', 'rate', v));
  slider('t-pitch', t.pitch, (v) => (+v).toFixed(2), (v) => save('tts', 'pitch', v));
  slider('t-volume', t.volume, (v) => Math.round(v * 100) + '%', (v) => save('tts', 'volume', v));
  check('t-highlightWord', t.highlightWord, (v) => save('tts', 'highlightWord', v));
  check('t-autoScroll', t.autoScroll, (v) => save('tts', 'autoScroll', v));

  select('d-enabled', d.enabled, async (v) => { await save('dark', 'enabled', v); renderAccess(); });
  seg('d-mode', d.mode, (v) => save('dark', 'mode', v));
  $('d-mode-note').textContent = d.mode === 'filter'
    ? 'Inverts the whole page, then flips images back. Fast and universal, but colors shift.'
    : 'Reads the page stylesheets and computed colors, then writes an overriding theme. Keeps hues and images natural.';
  check('d-skipDarkSites', d.skipDarkSites, (v) => save('dark', 'skipDarkSites', v));
  for (const k of ['brightness', 'contrast', 'sepia', 'grayscale']) slider('d-' + k, d[k], (v) => v + '%', (v) => save('dark', k, v));

  seg('f-rulerMode', f.rulerMode, (v) => save('focus', 'rulerMode', v));
  slider('f-rulerHeight', f.rulerHeight, (v) => v + 'px', (v) => save('focus', 'rulerHeight', v));
  slider('f-rulerOpacity', f.rulerOpacity, (v) => Math.round(v * 100) + '%', (v) => save('focus', 'rulerOpacity', v));
  slider('f-bionicStrength', f.bionicStrength, (v) => Math.round(v * 100) + '%', (v) => save('focus', 'bionicStrength', v));
  const color = $('f-rulerColor');
  color.value = f.rulerColor;
  if (!color.dataset.wired) { color.dataset.wired = '1'; color.addEventListener('change', (e) => save('focus', 'rulerColor', e.target.value)); }
  renderBionicDemo();
}

// ------------------------------------------------------------------ voices
async function loadVoices() {
  const sel = $('t-voice');
  let voices = [];
  const note = $('t-voice-note');
  if (settings.tts.engine === 'web') {
    const get = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []).map((v) => ({ voiceName: v.name, lang: v.lang, remote: !v.localService }));
    voices = get();
    if (!voices.length) { await new Promise((r) => { if (window.speechSynthesis) speechSynthesis.onvoiceschanged = r; setTimeout(r, 800); }); voices = get(); }
  } else {
    try { const res = await chrome.runtime.sendMessage({ type: 'get-voices' }); voices = (res && res.voices) || []; } catch (e) { voices = []; }
  }
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  voices.sort((a, b) => {
    const am = (a.lang || '').toLowerCase().startsWith(lang) ? 0 : 1, bm = (b.lang || '').toLowerCase().startsWith(lang) ? 0 : 1;
    return am - bm || String(a.voiceName).localeCompare(String(b.voiceName));
  });
  sel.textContent = '';
  sel.appendChild(new Option('Browser default', ''));
  for (const v of voices) sel.appendChild(new Option(`${v.voiceName}${v.lang ? ' (' + v.lang + ')' : ''}${v.remote ? ' · online' : ''}`, v.voiceName));
  sel.value = settings.tts.voice || '';
  if (sel.value !== (settings.tts.voice || '')) { sel.value = ''; }
  note.textContent = voices.length
    ? `${voices.length} voice${voices.length === 1 ? '' : 's'} available. Voices come from your operating system and browser.`
    : 'No voices reported yet. Your system may still be loading them, or no speech voices are installed.';
  if (!sel.dataset.wired) { sel.dataset.wired = '1'; sel.addEventListener('change', (e) => save('tts', 'voice', e.target.value)); }
}

// ------------------------------------------------------------------ site rules
async function renderSites() {
  const sites = await S.getSites();
  const hosts = Object.keys(sites).filter((h) => sites[h].dark).sort();
  const ul = $('d-sites');
  ul.textContent = '';
  $('d-sites-count').textContent = hosts.length ? `${hosts.length} site${hosts.length === 1 ? '' : 's'}` : '';
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No per-site rules yet. Use the popup switch on any site.';
    ul.appendChild(li);
    return;
  }
  for (const h of hosts) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'h';
    name.textContent = h;
    const segEl = document.createElement('div');
    segEl.className = 'seg';
    segEl.style.width = '180px';
    for (const [v, label] of [['on', 'Dark'], ['off', 'Never']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(sites[h].dark === v));
      b.addEventListener('click', async () => { await S.setSiteRule(h, 'dark', v); renderSites(); });
      segEl.appendChild(b);
    }
    const del = document.createElement('button');
    del.className = 'btn small ghost';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => { await S.setSiteRule(h, 'dark', null); renderSites(); toast('Rule removed'); });
    li.append(name, segEl, del);
    ul.appendChild(li);
  }
}

function normalizeHost(input) {
  let v = input.trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/:\d+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) || v === 'localhost' ? v : '';
}

async function renderAccess() {
  const all = await chrome.permissions.contains({ origins: ['*://*/*'] });
  const btn = $('d-access');
  const text = $('d-access-text');
  if (all) {
    text.textContent = 'Reading Studio can apply dark mode as pages load on every site.';
    btn.textContent = 'Revoke access';
    btn.onclick = async () => {
      await chrome.permissions.remove({ origins: ['*://*/*'] });
      await chrome.runtime.sendMessage({ type: 'sync-registration' }).catch(() => {});
      renderAccess();
      toast('Access revoked');
    };
  } else {
    text.textContent = settings.dark.enabled === 'off'
      ? 'Without site access, dark mode applies only after you open the popup on a page. Granting access also lets it apply before the page paints.'
      : 'Dark mode is on by default, so grant access to all sites for it to apply the moment a page loads.';
    btn.textContent = 'Allow on all sites';
    btn.onclick = async () => {
      const granted = await chrome.permissions.request({ origins: ['*://*/*'] }).catch(() => false);
      await chrome.runtime.sendMessage({ type: 'sync-registration' }).catch(() => {});
      renderAccess();
      toast(granted ? 'Access granted' : 'Access not granted');
    };
  }
}

async function renderResume() {
  const { resume = {} } = await chrome.storage.local.get('resume');
  const n = Object.keys(resume).length;
  $('resume-count').textContent = `Saved reading positions: ${n}`;
  $('clear-resume').disabled = !n;
}

async function renderKeys() {
  const labels = { 'toggle-reader': 'Reader view', 'read-aloud': 'Read aloud (play/pause)', 'toggle-dark': 'Dark mode on this site', 'toggle-ruler': 'Reading ruler', _execute_action: 'Open the Reading Studio popup' };
  let cmds = [];
  try { cmds = await chrome.commands.getAll(); } catch (e) { /* ignore */ }
  const tb = $('keys');
  tb.textContent = '';
  for (const c of cmds) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = labels[c.name] || c.description || c.name;
    const td2 = document.createElement('td');
    if (c.shortcut) { const k = document.createElement('kbd'); k.textContent = c.shortcut; td2.appendChild(k); }
    else { td2.className = 'muted small'; td2.textContent = 'Not set'; }
    tr.append(td1, td2);
    tb.appendChild(tr);
  }
}

// ------------------------------------------------------------------ nav + init
function wireNav() {
  const links = Array.from(document.querySelectorAll('.nav'));
  const sections = links.map((a) => document.querySelector(a.getAttribute('href')));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const i = sections.indexOf(e.target);
      links.forEach((l, j) => l.classList.toggle('active', i === j));
    }
  }, { rootMargin: '-10% 0px -70% 0px' });
  for (const s of sections) if (s) io.observe(s);
}

(async function init() {
  settings = await S.load();
  render();
  wireNav();
  await Promise.all([loadVoices(), renderSites(), renderAccess(), renderResume(), renderKeys()]);

  $('t-test').addEventListener('click', async () => {
    const text = 'Reading Studio reads articles aloud, one sentence at a time.';
    if (settings.tts.engine === 'web' && window.speechSynthesis) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = settings.tts.rate; u.pitch = settings.tts.pitch; u.volume = settings.tts.volume;
      const v = speechSynthesis.getVoices().find((x) => x.name === settings.tts.voice);
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } else {
      await chrome.runtime.sendMessage({ type: 'test-preview-tts', text, voiceName: settings.tts.voice, rate: settings.tts.rate }).catch(() => {});
    }
  });

  $('d-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const h = normalizeHost($('d-add-host').value);
    if (!h) { toast('Enter a hostname like example.com'); return; }
    await S.setSiteRule(h, 'dark', $('d-add-rule').value);
    $('d-add-host').value = '';
    renderSites();
    toast('Rule added for ' + h);
  });

  $('edit-keys').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => toast('Open chrome://extensions/shortcuts')));

  $('clear-resume').addEventListener('click', async () => {
    await chrome.storage.local.set({ resume: {} });
    renderResume();
    toast('Reading positions cleared');
  });

  $('reset').addEventListener('click', async () => {
    settings = await S.reset();
    render();
    await loadVoices();
    toast('Settings reset to defaults');
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && changes.settings) { settings = S.merge(S.DEFAULTS, changes.settings.newValue); render(); }
    if (area === 'local' && changes.sites) renderSites();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderPreview);
})();
