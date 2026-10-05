// Reading Studio popup.
const S = globalThis.RS_SETTINGS;
const $ = (id) => document.getElementById(id);

let settings = S.clone(S.DEFAULTS);
let tab = null;
let host = '';
let origin = '';
let restricted = false;
let pageState = null;

const RESTRICTED_RX = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|devtools|view-source|chrome-search|chrome-untrusted):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

function setStatus(text, ms = 2500) {
  $('status').textContent = text || '';
  clearTimeout(setStatus.t);
  if (text) setStatus.t = setTimeout(() => { $('status').textContent = ''; }, ms);
}

async function bg(msg) {
  try { return await chrome.runtime.sendMessage(msg); } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

async function tabAction(action, args) {
  const res = await bg({ type: 'tab-action', tabId: tab.id, action, args });
  if (!res || !res.ok) setStatus((res && res.error) || 'Something went wrong', 4000);
  return res;
}

// Ask the page for state without injecting anything (the popup opening should not touch the page).
async function readPageState() {
  if (restricted) return null;
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { action: 'ping' }, { frameId: 0 });
    if (ping && ping.full) { const r = await chrome.tabs.sendMessage(tab.id, { action: 'get-state' }, { frameId: 0 }); return r && r.result; }
    if (ping) { const r = await chrome.tabs.sendMessage(tab.id, { action: 'dark-state' }, { frameId: 0 }); return { dark: r && r.result }; }
  } catch (e) { /* nothing injected */ }
  return null;
}

function pressSeg(groupId, value) {
  for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
}

function fmtRate(r) { return (Math.round(r * 100) / 100) + '×'; }

function renderSettings() {
  const t = settings.tts, d = settings.dark, r = settings.reader;
  pressSeg('source', t.source);
  $('rate').value = t.rate; $('rateOut').textContent = fmtRate(t.rate);
  $('darkDefault').value = d.enabled;
  pressSeg('darkMode', d.mode);
  for (const k of ['brightness', 'contrast', 'sepia', 'grayscale']) { $(k).value = d[k]; $(k + 'Out').textContent = d[k] + '%'; }
  $('font').value = r.font;
  $('size').value = r.size; $('sizeOut').textContent = r.size + 'px';
  $('lineHeight').value = r.lineHeight; $('lineHeightOut').textContent = (+r.lineHeight).toFixed(1);
  $('width').value = r.width; $('widthOut').textContent = r.width;
  pressSeg('theme', r.theme);
}

async function renderPage() {
  const st = pageState || {};
  // Read
  const tts = st.tts || { active: false };
  const listenLabel = $('listen').querySelector('.label');
  listenLabel.textContent = tts.active ? (tts.playing ? 'Pause' : (tts.finished ? 'Replay' : 'Resume')) : 'Listen';
  $('listen').querySelector('.ic-play').innerHTML = tts.active && tts.playing
    ? '<rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/>'
    : '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z" fill="currentColor"/>';
  $('stop').hidden = !tts.active;
  $('reader').querySelector('.label').textContent = st.reader ? 'Close reader' : 'Reader view';
  $('ruler').checked = !!st.ruler;
  $('bionic').checked = !!st.bionic;

  // Dark
  const sites = await S.getSites();
  const rule = (sites[host] || {}).dark || null;
  const dark = st.dark;
  let active = dark ? !!dark.active : false;
  if (!dark) {
    // Not injected: predict from rules.
    const decision = S.darkDecision(settings, rule, matchMedia('(prefers-color-scheme: dark)').matches);
    active = decision !== 'off' && !restricted && !!rule; // unknown for global "auto" without page analysis
  }
  $('darkSite').checked = active;
  $('darkHost').textContent = host ? '· ' + host : '';
  const pill = $('darkPill');
  pill.classList.toggle('on', active);
  $('darkPillText').textContent = active ? (dark && dark.mode === 'filter' ? 'Filter' : 'Dynamic') : 'Off';
  const reason = $('darkReason');
  reason.hidden = true;
  if (dark && dark.alreadyDark && !active) { reason.hidden = false; reason.textContent = 'This site already looks dark, so it was left as is. Turn the switch on to force it.'; }
  $('darkRuleRow').hidden = !rule;
  if (rule) $('darkRuleText').textContent = rule === 'on' ? 'Always on for this site' : 'Always off for this site';

  // Permission hints: per-site persistence and global default.
  const permRow = $('permRow');
  permRow.hidden = true;
  if (!restricted && origin) {
    const all = await chrome.permissions.contains({ origins: ['*://*/*'] });
    const site = all || await chrome.permissions.contains({ origins: [origin + '/*'] });
    if (settings.dark.enabled !== 'off' && !all) {
      permRow.hidden = false;
      $('permText').textContent = 'Allow access to all sites so dark mode applies as pages load.';
      $('permBtn').dataset.scope = 'all';
    } else if (rule === 'on' && !site) {
      permRow.hidden = false;
      $('permText').textContent = 'Keep dark mode on every visit to this site.';
      $('permBtn').dataset.scope = 'site';
    }
  }
}

async function refreshPage() {
  pageState = await readPageState();
  await renderPage();
}

async function saveSettings(patch) {
  settings = await S.update(patch);
  renderSettings();
}

// ------------------------------------------------------------------ voices
async function loadVoices() {
  const sel = $('voice');
  let voices = [];
  if (settings.tts.engine === 'web' && 'speechSynthesis' in window) {
    voices = speechSynthesis.getVoices().map((v) => ({ voiceName: v.name, lang: v.lang, remote: !v.localService }));
    if (!voices.length) await new Promise((r) => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 600); });
    voices = speechSynthesis.getVoices().map((v) => ({ voiceName: v.name, lang: v.lang, remote: !v.localService }));
  } else if (chrome.tts) {
    voices = await new Promise((r) => chrome.tts.getVoices((v) => r(v || [])));
  }
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  voices.sort((a, b) => {
    const am = (a.lang || '').toLowerCase().startsWith(lang) ? 0 : 1, bm = (b.lang || '').toLowerCase().startsWith(lang) ? 0 : 1;
    return am - bm || String(a.voiceName).localeCompare(String(b.voiceName));
  });
  sel.textContent = '';
  sel.appendChild(new Option('Browser default voice', ''));
  for (const v of voices) sel.appendChild(new Option(`${v.voiceName}${v.lang ? ' (' + v.lang + ')' : ''}${v.remote ? ' · online' : ''}`, v.voiceName));
  sel.value = settings.tts.voice || '';
  if (sel.value !== (settings.tts.voice || '')) sel.value = '';
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('shortcuts').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => setStatus('Open chrome://extensions/shortcuts')); });

  $('reader').addEventListener('click', async () => {
    const res = await tabAction('reader-toggle');
    if (res && res.ok) window.close();
  });
  $('listen').addEventListener('click', async () => {
    const st = pageState && pageState.tts;
    const res = await tabAction('tts-toggle', st && st.active ? {} : { source: settings.tts.source });
    if (res && res.ok) { pageState = Object.assign({}, pageState, { tts: res.result }); renderPage(); }
  });
  $('stop').addEventListener('click', async () => { await tabAction('tts-stop'); await refreshPage(); });

  $('source').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveSettings({ tts: { source: b.dataset.v } }); });
  $('rate').addEventListener('input', (e) => { $('rateOut').textContent = fmtRate(+e.target.value); });
  $('rate').addEventListener('change', (e) => saveSettings({ tts: { rate: +e.target.value } }));
  $('voice').addEventListener('change', (e) => saveSettings({ tts: { voice: e.target.value } }));

  $('darkSite').addEventListener('change', async (e) => {
    const res = await bg({ type: 'toggle-dark', tabId: tab.id, value: e.target.checked });
    if (!res || !res.ok) { setStatus((res && res.error) || 'Could not change dark mode', 4000); e.target.checked = !e.target.checked; return; }
    await refreshPage();
  });
  $('darkReset').addEventListener('click', async () => {
    await S.setSiteRule(host, 'dark', null);
    await tabAction('dark-evaluate', { reanalyze: true });
    await refreshPage();
  });
  $('permBtn').addEventListener('click', (e) => {
    const scope = e.currentTarget.dataset.scope;
    const origins = scope === 'all' ? ['*://*/*'] : [origin + '/*'];
    // Must be called directly from the click (user gesture).
    chrome.permissions.request({ origins }).then((granted) => {
      setStatus(granted ? 'Access granted' : 'Access not granted');
      refreshPage();
    }).catch((err) => setStatus(String(err.message || err), 4000));
  });
  $('darkDefault').addEventListener('change', async (e) => { await saveSettings({ dark: { enabled: e.target.value } }); if (!restricted) await tabAction('dark-evaluate', { reanalyze: true }); await refreshPage(); });
  $('darkMode').addEventListener('click', async (e) => { const b = e.target.closest('button'); if (!b) return; await saveSettings({ dark: { mode: b.dataset.v } }); setTimeout(refreshPage, 150); });
  for (const k of ['brightness', 'contrast', 'sepia', 'grayscale']) {
    $(k).addEventListener('input', (e) => { $(k + 'Out').textContent = e.target.value + '%'; });
    $(k).addEventListener('change', (e) => saveSettings({ dark: { [k]: +e.target.value } }));
  }

  $('ruler').addEventListener('change', async (e) => { await tabAction('ruler-toggle', { on: e.target.checked }); });
  $('bionic').addEventListener('change', async (e) => { await tabAction('bionic-toggle', { on: e.target.checked }); });

  $('font').addEventListener('change', (e) => saveSettings({ reader: { font: e.target.value } }));
  for (const [k, fmt] of [['size', (v) => v + 'px'], ['lineHeight', (v) => (+v).toFixed(1)], ['width', (v) => v]]) {
    $(k).addEventListener('input', (e) => { $(k + 'Out').textContent = fmt(e.target.value); });
    $(k).addEventListener('change', (e) => saveSettings({ reader: { [k]: +e.target.value } }));
  }
  $('theme').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveSettings({ reader: { theme: b.dataset.v } }); });
}

(async function init() {
  settings = await S.load();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { const u = new URL(tab.url); host = u.hostname; origin = /^https?:$/.test(u.protocol) ? u.origin : ''; } catch (e) { host = ''; }
  restricted = !tab || !tab.url || RESTRICTED_RX.test(tab.url);
  document.body.classList.toggle('restricted', restricted);
  $('restricted').hidden = !restricted;
  $('host').textContent = restricted ? 'Protected page' : (host || (tab && tab.url && tab.url.startsWith('file:') ? 'Local file' : ''));
  renderSettings();
  wire();
  await Promise.all([refreshPage(), loadVoices()]);
})();
