// Language Immersion - toolbar popup.
const LIM = globalThis.LIM;
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let settings = { ...LIM.DEFAULT_SETTINGS };
let tabId = null;
let host = '';

const DIFF_HINT = {
  beginner: 'Common nouns: house, water, friend…',
  intermediate: 'Adds verbs, adjectives and adverbs.',
  advanced: 'Adds whole phrases like "of course" or "every day".',
};

function fillLanguages() {
  const sel = $('targetLang');
  sel.innerHTML = '';
  const hasAI = 'Translator' in self;
  for (const l of LIM.LANGUAGES) {
    if (l.code === settings.nativeLang) continue;
    const dict = settings.nativeLang === 'en' && LIM.DICTIONARY_LANGS.includes(l.code);
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.name} (${l.native})${dict ? '' : hasAI ? ' - on-device AI' : ' - needs Chrome AI'}`;
    if (!dict && !hasAI) opt.disabled = true;
    sel.appendChild(opt);
  }
  sel.value = settings.targetLang;
}

function renderSettings() {
  $('enabled').checked = settings.enabled;
  $('tagLang').textContent = LIM.langName(settings.targetLang);
  $('targetLang').value = settings.targetLang;
  for (const b of $('difficulty').querySelectorAll('button')) {
    const on = b.dataset.v === settings.difficulty;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('diffHint').textContent = DIFF_HINT[settings.difficulty];
  $('density').value = settings.density;
  $('densityOut').textContent = settings.density;
  $('siteOn').checked = !!host && LIM.hostAllowed({ ...settings, enabled: true }, host);
  $('siteOn').disabled = !host || !settings.enabled;
  document.body.classList.toggle('off', !settings.enabled);
}

function renderStats(stats) {
  $('sKnown').textContent = stats.known;
  $('sLearning').textContent = stats.learning;
  $('sStreak').textContent = stats.streak;
  $('sToday').textContent = stats.seenToday;
  $('review').innerHTML = stats.due > 0 ? `Review words <span class="badge">${stats.due} due</span>` : 'Review words';
}

async function save(patch) {
  settings = await send({ type: 'patchSettings', patch });
  renderSettings();
  // Content scripts restart themselves on storage changes; refresh our status line shortly after.
  setTimeout(refreshPage, 1200);
}

async function refreshPage() {
  if (tabId == null) return;
  let st = null;
  try { st = await chrome.tabs.sendMessage(tabId, { type: 'lim:status' }); } catch (e) { st = null; }
  if (!st) {
    host = '';
    $('host').textContent = 'This page';
    $('pageStatus').textContent = 'Immersion can\'t run on this page (browser or store pages, or the page loaded before the extension). Reload the page to try again.';
    renderSettings();
    renderEngine(null);
    return;
  }
  host = st.host;
  $('host').textContent = st.host || 'This page';
  if (st.running && st.replaced > 0) $('pageStatus').textContent = `${st.replaced} word${st.replaced === 1 ? '' : 's'} swapped (${st.unique} unique). Hover one to see the original.`;
  else if (st.running) $('pageStatus').textContent = 'No suitable words found on this page yet.';
  else $('pageStatus').textContent = st.reason || 'Waiting for the page to load…';
  renderSettings();
  renderEngine(st);
}

async function renderEngine(st) {
  const dot = $('engineDot'), text = $('engineText'), btn = $('downloadModel');
  btn.classList.add('hidden');
  if (st && st.engine === 'translator') { dot.className = 'dot ai'; text.textContent = "On-device AI translation (Chrome built-in)"; return; }
  if (st && st.engine === 'dictionary') { dot.className = 'dot dict'; text.textContent = 'Offline dictionary (1,500 common words)'; }
  else { dot.className = 'dot'; text.textContent = LIM.DICTIONARY_LANGS.includes(settings.targetLang) && settings.nativeLang === 'en' ? 'Offline dictionary available' : 'Needs on-device AI translation'; }
  if (!('Translator' in self) || settings.engine === 'dictionary') return;
  try {
    const av = await self.Translator.availability({ sourceLanguage: settings.nativeLang, targetLanguage: settings.targetLang });
    if (av === 'downloadable' || av === 'downloading') {
      btn.classList.remove('hidden');
      btn.textContent = av === 'downloading' ? 'Downloading…' : `Download ${LIM.langName(settings.targetLang)} model`;
      btn.title = 'Chrome downloads a small on-device translation model once; translation then runs offline and private.';
    } else if (av === 'available' && (!st || st.engine !== 'translator')) {
      text.textContent += ' · AI model ready, reload the page to use it';
    }
  } catch (e) { /* API present but unusable */ }
}

async function downloadModel() {
  const btn = $('downloadModel'), bar = $('dlProgress');
  btn.disabled = true;
  bar.classList.remove('hidden');
  try {
    const t = await self.Translator.create({
      sourceLanguage: settings.nativeLang, targetLanguage: settings.targetLang,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { bar.firstElementChild.style.width = Math.round((e.loaded > 1 ? e.loaded / (e.total || 1) : e.loaded) * 100) + '%'; }); },
    });
    t.destroy?.();
    btn.textContent = 'Model ready';
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'lim:rerun' }).catch(() => {});
    setTimeout(refreshPage, 1500);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Download failed - retry';
  } finally {
    setTimeout(() => bar.classList.add('hidden'), 800);
  }
}

function bind() {
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('targetLang').addEventListener('change', (e) => save({ targetLang: e.target.value }));
  const seg = $('difficulty');
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save({ difficulty: b.dataset.v }); });
  seg.addEventListener('keydown', (e) => {
    const order = ['beginner', 'intermediate', 'advanced'];
    let i = order.indexOf(settings.difficulty);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = Math.min(2, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else return;
    e.preventDefault();
    save({ difficulty: order[i] }).then(() => seg.querySelector(`[data-v="${order[i]}"]`).focus());
  });
  const dens = $('density');
  dens.addEventListener('input', () => { $('densityOut').textContent = dens.value; });
  dens.addEventListener('change', () => save({ density: Number(dens.value) }));
  $('siteOn').addEventListener('change', async (e) => {
    if (!host) return;
    const on = e.target.checked;
    const h = host;
    const patch = settings.siteMode === 'allowlist'
      ? { enabledSites: on ? [...new Set([...settings.enabledSites, h])] : settings.enabledSites.filter((x) => x !== h) }
      : { disabledSites: on ? settings.disabledSites.filter((x) => x !== h && !h.endsWith('.' + x)) : [...new Set([...settings.disabledSites, h])] };
    save(patch);
  });
  $('downloadModel').addEventListener('click', downloadModel);
  $('review').addEventListener('click', () => { send({ type: 'openReview', hash: 'review' }); window.close(); });
  $('quiz').addEventListener('click', () => { send({ type: 'openReview', hash: 'quiz' }); window.close(); });
  $('words').addEventListener('click', () => { send({ type: 'openReview', hash: 'words' }); window.close(); });
  $('options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
}

async function init() {
  bind();
  const state = await send({ type: 'getState' });
  if (state && state.settings) settings = state.settings;
  fillLanguages();
  renderSettings();
  if (state && state.stats) renderStats(state.stats);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id != null ? tab.id : null;
  } catch (e) { tabId = null; }
  refreshPage();
}
init();
