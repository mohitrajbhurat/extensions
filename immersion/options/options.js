// Language Immersion - settings page.
const LIM = globalThis.LIM;
const $ = (id) => document.getElementById(id);
const esc = LIM.escapeHtml;
const send = (msg) => chrome.runtime.sendMessage(msg);

let settings = { ...LIM.DEFAULT_SETTINGS };

const DIFF_HINT = {
  beginner: 'Common nouns only: house, water, friend.',
  intermediate: 'Adds verbs, adjectives and adverbs, chosen by context.',
  advanced: 'Adds whole phrases like "of course" or "every day", plus numbers.',
};

// Sample sentence for the highlight preview, per target language (falls back to Spanish).
const PREVIEW = {
  es: ['casa', 'agua', 'amigo'],
  fr: ['maison', 'eau', 'ami'],
  de: ['Haus', 'Wasser', 'Freund'],
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function save(patch, quiet) {
  const next = await send({ type: 'patchSettings', patch });
  if (next && !next.error) settings = next;
  render();
  if (!quiet) toast('Saved');
}

// ---------- rendering ----------
function fillLanguageSelects() {
  const hasAI = 'Translator' in self;
  const nat = $('nativeLang');
  nat.innerHTML = LIM.LANGUAGES.map((l) => {
    const ok = l.code === 'en' || hasAI;
    return `<option value="${l.code}"${ok ? '' : ' disabled'}>${esc(l.name)} (${esc(l.native)})${ok ? '' : ' - needs Chrome AI'}</option>`;
  }).join('');
  const tgt = $('targetLang');
  tgt.innerHTML = LIM.LANGUAGES.filter((l) => l.code !== settings.nativeLang).map((l) => {
    const dict = settings.nativeLang === 'en' && LIM.DICTIONARY_LANGS.includes(l.code);
    const ok = dict || hasAI;
    const tag = dict ? ' - offline dictionary' : hasAI ? ' - on-device AI' : ' - needs Chrome AI';
    return `<option value="${l.code}"${ok ? '' : ' disabled'}>${esc(l.name)} (${esc(l.native)})${tag}</option>`;
  }).join('');
}

function setSegmented(id, value) {
  for (const b of $(id).querySelectorAll('button')) {
    const on = b.dataset.v === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function render() {
  fillLanguageSelects();
  $('nativeLang').value = settings.nativeLang;
  $('targetLang').value = settings.targetLang;
  const dict = settings.nativeLang === 'en' && LIM.DICTIONARY_LANGS.includes(settings.targetLang);
  $('targetNote').textContent = dict
    ? 'Covered by the bundled 1,500-word dictionary, so it works offline in any Chromium browser.'
    : "Needs Chrome's built-in on-device Translator. Bundled dictionaries cover English to Spanish, French and German.";
  $('engine').value = settings.engine;
  setSegmented('difficulty', settings.difficulty);
  $('diffHint').textContent = DIFF_HINT[settings.difficulty] || '';
  $('density').value = settings.density;
  $('densityOut').textContent = settings.density;
  setSegmented('highlight', settings.highlight);
  renderPreview();
  $('selectionTranslate').checked = !!settings.selectionTranslate;
  $('showKnown').checked = !!settings.showKnown;
  setSegmented('siteMode', settings.siteMode);
  renderSites();
  $('autoLearn').value = String(settings.autoLearnAfter);
  if ($('autoLearn').value !== String(settings.autoLearnAfter)) {
    const o = document.createElement('option');
    o.value = String(settings.autoLearnAfter);
    o.textContent = `${settings.autoLearnAfter} sightings`;
    $('autoLearn').appendChild(o);
    $('autoLearn').value = o.value;
  }
  if (document.activeElement !== $('dailyGoal')) $('dailyGoal').value = settings.dailyGoal;
  $('speechRate').value = settings.speechRate;
  $('rateOut').textContent = Number(settings.speechRate).toFixed(2).replace(/0$/, '') + '×';
  renderVoiceNote();
  renderAiStatus();
}

function renderPreview() {
  const words = PREVIEW[settings.targetLang] || null;
  const el = $('preview');
  el.dataset.style = settings.highlight;
  const w = (t, cls, title) => `<span class="w ${cls}" lang="${esc(settings.targetLang)}" title="${esc(title)}">${esc(t)}</span>`;
  if (words) {
    el.innerHTML = `We walked back to the ${w(words[0], '', 'New word')} for a glass of ${w(words[1], 'learning', 'Learning')} with an old ${w(words[2], 'known', 'Known')}.`;
  } else {
    el.innerHTML = `We walked back to the ${w('house', '', 'New word')} for a glass of ${w('water', 'learning', 'Learning')} with an old ${w('friend', 'known', 'Known')}.`;
  }
  el.setAttribute('aria-label', 'Preview: new words, learning words and known words');
}

function renderSites() {
  const list = settings.siteMode === 'allowlist' ? settings.enabledSites : settings.disabledSites;
  $('siteListLabel').textContent = settings.siteMode === 'allowlist' ? 'Run only on these sites' : 'Paused on these sites';
  const ul = $('sites');
  if (!list.length) {
    ul.innerHTML = `<li class="none" style="background:none;border:0;padding:0">${settings.siteMode === 'allowlist' ? 'No sites yet - immersion will not run anywhere until you add one.' : 'No paused sites.'}</li>`;
    return;
  }
  ul.innerHTML = list.map((h) => `<li><span>${esc(h)}</span><button type="button" data-host="${esc(h)}" aria-label="Remove ${esc(h)}" title="Remove">&times;</button></li>`).join('');
}

function renderVoiceNote() {
  const note = $('voiceNote');
  if (typeof speechSynthesis === 'undefined') { note.textContent = 'Speech synthesis is not available in this browser.'; $('testVoice').disabled = true; return; }
  const voices = speechSynthesis.getVoices();
  if (!voices.length) { note.textContent = 'Uses your system text-to-speech voices.'; return; }
  const v = LIM.pickVoice(settings.targetLang);
  note.textContent = v
    ? `Voice: ${v.name}${v.localService ? ' (offline)' : ''}`
    : `No ${LIM.langName(settings.targetLang)} voice is installed; add one in your operating system's speech settings for accurate pronunciation.`;
}

async function renderAiStatus() {
  const el = $('aiStatus');
  el.className = 'status';
  if (!('Translator' in self)) {
    el.textContent = "Chrome's built-in Translator isn't available in this browser, so the bundled dictionary is used (English to Spanish, French and German). Selection translation then covers single dictionary words.";
    return;
  }
  if (settings.engine === 'dictionary') {
    el.textContent = 'Using the bundled dictionary only. Selection translation still uses the on-device Translator when it is available.';
    return;
  }
  try {
    const av = await self.Translator.availability({ sourceLanguage: settings.nativeLang, targetLanguage: settings.targetLang });
    if (av === 'available') {
      el.classList.add('ok');
      el.textContent = `On-device ${LIM.langName(settings.nativeLang)} to ${LIM.langName(settings.targetLang)} translation is ready.`;
    } else if (av === 'downloadable' || av === 'downloading') {
      el.classList.add('warn');
      el.innerHTML = `<span>The ${esc(LIM.langName(settings.targetLang))} on-device model needs a one-time download.</span> <button class="btn sm" id="dlModel" type="button">${av === 'downloading' ? 'Downloading…' : 'Download now'}</button>`;
      $('dlModel').onclick = downloadModel;
    } else {
      el.classList.add('warn');
      el.textContent = `This language pair isn't supported by the on-device Translator.${LIM.DICTIONARY_LANGS.includes(settings.targetLang) && settings.nativeLang === 'en' ? ' The bundled dictionary is used instead.' : ''}`;
    }
  } catch (e) {
    el.textContent = 'Could not query the on-device Translator: ' + (e.message || e);
  }
}

async function downloadModel() {
  const btn = $('dlModel');
  btn.disabled = true;
  try {
    const t = await self.Translator.create({
      sourceLanguage: settings.nativeLang, targetLanguage: settings.targetLang,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { btn.textContent = `Downloading… ${Math.round((e.loaded > 1 ? e.loaded / (e.total || 1) : e.loaded) * 100)}%`; }); },
    });
    if (t && t.destroy) t.destroy();
    toast('Model ready - reload your tabs to use it');
    renderAiStatus();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Retry download';
    toast('Download failed: ' + (e.message || e));
  }
}

async function renderShortcuts() {
  const ul = $('shortcuts');
  let cmds = [];
  try { cmds = await chrome.commands.getAll(); } catch (e) { cmds = []; }
  const rows = cmds.filter((c) => c.description || c.name === '_execute_action').map((c) => {
    const desc = c.name === '_execute_action' ? 'Open the popup' : c.description;
    return `<li><span>${esc(desc)}</span>${c.shortcut ? `<span class="kbd">${esc(c.shortcut)}</span>` : '<span class="muted small">Not set</span>'}</li>`;
  });
  ul.innerHTML = rows.join('') || '<li class="muted small">No commands.</li>';
}

async function renderDataSummary() {
  const data = await send({ type: 'getVocab' });
  const stats = LIM.computeStats((data && data.vocab) || {}, (data && data.activity) || {});
  $('dataSummary').textContent = `${stats.seenWords} word${stats.seenWords === 1 ? '' : 's'} tracked: ${stats.known} known, ${stats.learning} learning, ${stats.streak}-day streak.`;
}

// ---------- site list ----------
function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  } catch (e) { return ''; }
  s = s.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+|\d{1,3}(\.\d{1,3}){3})$/.test(s)) return '';
  return s;
}

// ---------- events ----------
function bindSegmented(id, key) {
  const seg = $(id);
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.v !== settings[key]) save({ [key]: b.dataset.v }); });
  seg.addEventListener('keydown', (e) => {
    const vals = [...seg.querySelectorAll('button')].map((b) => b.dataset.v);
    let i = vals.indexOf(settings[key]);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (i + 1) % vals.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (i + vals.length - 1) % vals.length;
    else return;
    e.preventDefault();
    save({ [key]: vals[i] }, true).then(() => seg.querySelector(`[data-v="${vals[i]}"]`).focus());
  });
}

function bind() {
  $('openReview').addEventListener('click', () => send({ type: 'openReview', hash: 'review' }));
  $('nativeLang').addEventListener('change', (e) => {
    const nativeLang = e.target.value;
    const patch = { nativeLang };
    if (settings.targetLang === nativeLang) patch.targetLang = nativeLang === 'es' ? 'fr' : 'es';
    save(patch);
  });
  $('targetLang').addEventListener('change', (e) => save({ targetLang: e.target.value }));
  $('engine').addEventListener('change', (e) => save({ engine: e.target.value }));
  bindSegmented('difficulty', 'difficulty');
  bindSegmented('highlight', 'highlight');
  bindSegmented('siteMode', 'siteMode');
  const dens = $('density');
  dens.addEventListener('input', () => { $('densityOut').textContent = dens.value; });
  dens.addEventListener('change', () => save({ density: Number(dens.value) }));
  $('selectionTranslate').addEventListener('change', (e) => save({ selectionTranslate: e.target.checked }));
  $('showKnown').addEventListener('change', (e) => save({ showKnown: e.target.checked }));
  $('siteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const h = normalizeHost($('siteInput').value);
    if (!h) { toast('Enter a domain like example.com'); $('siteInput').focus(); return; }
    const key = settings.siteMode === 'allowlist' ? 'enabledSites' : 'disabledSites';
    if (settings[key].includes(h)) { toast(`${h} is already listed`); return; }
    $('siteInput').value = '';
    save({ [key]: [...settings[key], h].sort() });
  });
  $('sites').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-host]');
    if (!b) return;
    const key = settings.siteMode === 'allowlist' ? 'enabledSites' : 'disabledSites';
    save({ [key]: settings[key].filter((h) => h !== b.dataset.host) });
  });
  $('autoLearn').addEventListener('change', (e) => save({ autoLearnAfter: Number(e.target.value) }));
  $('dailyGoal').addEventListener('change', (e) => {
    const v = Math.round(Number(e.target.value));
    if (!Number.isFinite(v) || v < 1 || v > 200) { toast('Pick a goal between 1 and 200'); e.target.value = settings.dailyGoal; return; }
    save({ dailyGoal: v });
  });
  const rate = $('speechRate');
  rate.addEventListener('input', () => { $('rateOut').textContent = Number(rate.value).toFixed(2).replace(/0$/, '') + '×'; });
  rate.addEventListener('change', () => save({ speechRate: Number(rate.value) }));
  $('testVoice').addEventListener('click', () => {
    const sample = { es: 'Hola, ¿cómo estás?', fr: 'Bonjour, comment ça va ?', de: 'Hallo, wie geht es dir?', it: 'Ciao, come stai?', pt: 'Olá, como vai?' }[settings.targetLang] || 'Hello';
    if (!LIM.speak(sample, settings.targetLang, Number(rate.value))) toast('Speech is not available');
  });
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', renderVoiceNote);

  $('exportBtn').addEventListener('click', async () => {
    const data = await send({ type: 'exportData' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `language-immersion-${LIM.todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Exported');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const r = await send({ type: 'importData', data: JSON.parse(await file.text()) });
      if (!r || r.error) throw new Error(r ? r.error : 'No response');
      const st = await send({ type: 'getState' });
      if (st && st.settings) settings = st.settings;
      render();
      renderDataSummary();
      toast(`Imported ${r.added} word${r.added === 1 ? '' : 's'}`);
    } catch (err) {
      toast('Import failed: ' + (err.message || err));
    }
  });
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Delete all tracked words, review history and streaks? Settings are kept. This cannot be undone.')) return;
    await send({ type: 'resetProgress' });
    renderDataSummary();
    toast('Progress reset');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = { ...LIM.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      render();
    } else if (area === 'local' && changes.vocab) {
      renderDataSummary();
    }
  });
}

(async function init() {
  if (location.hash === '#welcome') $('welcome').classList.remove('hidden');
  bind();
  const st = await send({ type: 'getState' });
  if (st && st.settings) settings = st.settings;
  render();
  renderShortcuts();
  renderDataSummary();
})();
