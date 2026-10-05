// Page Assistant side panel (also used as a popup window where the Side Panel API is missing).
import * as NLP from '../lib/nlp.js';
import * as AI from '../lib/ai.js';
import * as History from '../lib/history.js';
import { renderMarkdown, escapeHtml } from '../lib/markdown.js';
import { extractPdf } from '../lib/pdf.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'window' ? 'window' : 'panel';
let boundTabId = params.get('tab') ? Number(params.get('tab')) : null;
const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

const DEFAULTS = { engine: 'auto', summaryType: 'key-points', summaryLength: 'medium', outputLang: 'auto', autoSummarize: false, followTabs: true, saveHistory: true, studyMode: 'cards' };
const TYPE_LABEL = { 'key-points': 'Key points', tldr: 'TL;DR', headline: 'Headline' };
const STATE_LABEL = { available: 'Ready', downloadable: 'Needs download', downloading: 'Downloading', unavailable: 'Not available on this device', unsupported: 'Not supported in this browser' };

const state = {
  settings: { ...DEFAULTS },
  tab: null,
  doc: null,
  ai: { Summarizer: 'unsupported', LanguageModel: 'unsupported', Writer: 'unsupported', Rewriter: 'unsupported' },
  chat: null,
  chatContext: '',
  ops: {},
  myWindowId: null,
  loading: false,
  lastSummary: null,
  lastTool: null,
  study: null,
};

// ---------------- utilities ----------------
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label);
}

function startOp(name) {
  if (state.ops[name]) state.ops[name].abort();
  const c = new AbortController();
  state.ops[name] = c;
  return c;
}
function endOp(name, c) { if (state.ops[name] === c) delete state.ops[name]; }
const isAbort = (e) => e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));

function setStatus(el, text, busy = false) {
  el.innerHTML = text ? `${busy ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span>${escapeHtml(text)}</span>` : '';
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function svgIcon(id) { return `<svg aria-hidden="true"><use href="#${id}"/></svg>`; }

// Render streaming markdown at most once per frame.
function streamer(el, { cursor = true } = {}) {
  let pending = null;
  let raf = 0;
  return (text) => {
    pending = text;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      el.innerHTML = renderMarkdown(pending);
      el.classList.toggle('cursor', cursor);
    });
  };
}
function finishStream(el, text) {
  el.classList.remove('cursor');
  el.innerHTML = renderMarkdown(text);
}

function outLang() {
  const s = state.settings.outputLang;
  if (s && s !== 'auto') return s;
  const l = state.doc && state.doc.lang;
  return AI.SUPPORTED_OUTPUT.includes(l) ? l : 'en';
}

// ---------------- settings ----------------
async function loadSettings() {
  if (!hasChrome) return;
  try {
    const r = await chrome.storage.sync.get('pa:settings');
    state.settings = { ...DEFAULTS, ...(r['pa:settings'] || {}) };
  } catch (e) { /* defaults */ }
}
async function saveSettings() {
  if (!hasChrome) return;
  try { await chrome.storage.sync.set({ 'pa:settings': state.settings }); } catch (e) { /* ignore */ }
}

// ---------------- AI availability ----------------
function wantAI(api) {
  if (state.settings.engine === 'extractive') return false;
  const s = state.ai[api];
  return s === 'available' || s === 'downloadable' || s === 'downloading';
}

async function refreshAI() {
  state.ai = await AI.allAvailability(outLang());
  renderAIStatus();
  if (Object.values(state.ai).includes('downloading')) {
    clearTimeout(refreshAI._t);
    refreshAI._t = setTimeout(refreshAI, 4000);
  }
}

function renderAIStatus() {
  const a = state.ai;
  const dot = $('#ai-dot');
  const label = $('#ai-label');
  const dl = $('#ai-download');
  const states = Object.values(a);
  dot.className = 'dot';
  dl.hidden = true;
  if (state.settings.engine === 'extractive') {
    label.textContent = 'Offline mode (extractive). Change in settings.';
  } else if (states.every((s) => s === 'unsupported')) {
    label.textContent = 'Offline mode: built-in AI is not available in this browser';
  } else if (a.Summarizer === 'available' || a.LanguageModel === 'available') {
    dot.classList.add('ok');
    const ready = AI.API_NAMES.filter((n) => a[n] === 'available').length;
    label.textContent = `On-device AI ready (${ready}/4 tools)`;
  } else if (states.includes('downloading')) {
    dot.classList.add('busy');
    label.textContent = 'Downloading on-device model…';
  } else if (states.includes('downloadable')) {
    dot.classList.add('warn');
    label.textContent = 'On-device AI needs a one-time model download';
    dl.hidden = false;
  } else {
    label.textContent = 'Offline mode: on-device AI is not available on this device';
  }
  const details = $('#ai-details');
  details.innerHTML = `<table>${AI.API_NAMES.map((n) => `<tr><td>${n === 'LanguageModel' ? 'Prompt API (chat, explain, quiz)' : n === 'Summarizer' ? 'Summarizer' : n === 'Writer' ? 'Writer (drafts)' : 'Rewriter (tone, length)'}</td><td><span class="state ${a[n]}">${STATE_LABEL[a[n]] || a[n]}</span></td></tr>`).join('')}</table>
    <p class="small muted" style="margin:8px 0 0">${states.every((s) => s === 'unsupported' || s === 'unavailable')
    ? 'Everything still works offline: TextRank summaries, keyword search with in-page highlights, outline, readability and study cards.'
    : 'Models run locally in Chrome. Your pages never leave your device.'}</p>`;
}

AI.onDownloadProgress(({ progress }) => {
  const box = $('#ai-progress');
  box.hidden = progress >= 1;
  const pct = Math.round(progress * 100);
  $('#ai-progress-bar').style.setProperty('--p', pct + '%');
  $('#ai-progress-text').textContent = `Downloading model ${pct}%`;
  if (progress >= 1) setTimeout(refreshAI, 500);
});

async function downloadModels() {
  const btn = $('#ai-download');
  btn.disabled = true;
  $('#ai-progress').hidden = false;
  $('#ai-progress-text').textContent = 'Starting download…';
  try {
    const jobs = AI.API_NAMES.filter((n) => state.ai[n] === 'downloadable').map((n) => AI.prepare(n, outLang()).catch((e) => e));
    // Creating sessions starts the downloads; progress arrives through onDownloadProgress.
    setTimeout(refreshAI, 800);
    const results = await Promise.all(jobs);
    const err = results.find((r) => r instanceof Error);
    if (err) toast('Download could not start: ' + (err.message || err.name));
  } finally {
    btn.disabled = false;
    $('#ai-progress').hidden = true;
    refreshAI();
  }
}

// ---------------- tab + page access ----------------
async function getTargetTab() {
  if (!hasChrome || !chrome.tabs) return null;
  if (MODE === 'window') {
    if (boundTabId) { try { return await chrome.tabs.get(boundTabId); } catch (e) { boundTabId = null; } }
    // Never target this assistant window/tab itself (it may be open as a tab too).
    let selfId = null;
    try { const me = await chrome.tabs.getCurrent(); selfId = me ? me.id : null; } catch (e) { /* not in a tab */ }
    const own = chrome.runtime.getURL('');
    const tabs = (await chrome.tabs.query({ active: true, windowType: 'normal' }))
      .filter((t) => t.id !== selfId && !(t.url || '').startsWith(own));
    return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

async function exec(tabId, { files, func, args = [] }) {
  if (files) await chrome.scripting.executeScript({ target: { tabId }, files });
  if (!func) return null;
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r ? r.result : null;
}

const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted):/i;
const STORE = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;
const looksPdf = (url) => /\.pdf($|[?#])/i.test(url || '');

async function hasAllSites() {
  try { return await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch (e) { return false; }
}

function showNotice(html, kind = '') {
  const n = $('#notice');
  n.className = 'notice' + (kind ? ' ' + kind : '');
  n.innerHTML = html;
  n.hidden = !html;
}

function accessNotice() {
  showNotice(`<span>Page Assistant needs your OK to read this tab. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd> or click the toolbar icon on the page.</span><button class="ghost small" type="button" data-act="grant">Allow on all sites</button>`, 'warn');
}

async function requestAllSites() {
  try {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (ok) { toast('Access granted'); loadPage({ quiet: false }); }
    updatePermUI();
    return ok;
  } catch (e) { toast('Permission request failed'); return false; }
}

function setHeader({ title, meta, letter }) {
  $('#page-title').textContent = title || 'Page Assistant';
  $('#page-title').title = title || '';
  $('#page-meta').textContent = meta || '';
  $('#page-avatar').textContent = (letter || title || 'P').trim().charAt(0) || 'P';
}

function blocksToText(blocks) {
  return blocks.map((b) => (b.type === 'heading' ? '#'.repeat(Math.min(4, b.level || 2)) + ' ' + b.text : b.type === 'li' ? '- ' + b.text : b.text)).join('\n\n');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchPdfBytes(url, tabId) {
  // 1) Direct fetch from the panel (works with host access or activeTab on http(s)).
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  } catch (e) { /* try next */ }
  // 2) XHR (works for file:// when "Allow access to file URLs" is on).
  try {
    const buf = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = () => (x.response && x.response.byteLength ? resolve(x.response) : reject(new Error('empty')));
      x.onerror = () => reject(new Error('xhr failed'));
      x.send();
    });
    return new Uint8Array(buf);
  } catch (e) { /* try next */ }
  // 3) Same-origin fetch from inside the tab.
  if (tabId != null) {
    const b64 = await exec(tabId, {
      func: async () => {
        const r = await fetch(location.href);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > 40 * 1024 * 1024) return null;
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return btoa(s);
      },
    });
    if (b64) return base64ToBytes(b64);
  }
  throw new Error('Could not download the PDF.');
}

async function loadPdf(url, tabId) {
  setHeader({ title: decodeURIComponent((url.split('/').pop() || 'PDF').split(/[?#]/)[0]), meta: 'Reading PDF…', letter: 'P' });
  const bytes = await fetchPdfBytes(url, tabId);
  const pdf = await extractPdf(bytes);
  const name = decodeURIComponent((url.split('/').pop() || 'document.pdf').split(/[?#]/)[0]);
  return { url, title: pdf.title || name, siteName: 'PDF', byline: '', published: '', excerpt: '', lang: 'en', selection: '', isPdf: true, pageCount: pdf.pageCount, blocks: pdf.blocks, method: 'pdf', truncated: pdf.truncated };
}

async function loadPage({ quiet = false, keepSelection = false } = {}) {
  if (!hasChrome) return;
  if (state.loading) return;
  state.loading = true;
  const refreshBtn = $('#btn-refresh');
  refreshBtn.classList.add('spin');
  try {
    const tab = await getTargetTab();
    state.tab = tab;
    if (!tab) { setHeader({ title: 'No page', meta: 'Open a web page to get started' }); return; }
    const url = tab.url || '';
    if (url && (RESTRICTED.test(url) || STORE.test(url))) {
      setDoc(null);
      setHeader({ title: 'This page can’t be read', meta: 'Browser and store pages are protected' });
      showNotice('Open an article, a document or a PDF, then click the toolbar icon.', '');
      return;
    }
    let res = null;
    let err = null;
    try {
      res = await exec(tab.id, { files: ['content/extract.js'], func: () => globalThis.__PA_extract() });
    } catch (e) { err = e; }
    if ((res && res.isPdf) || (!res && looksPdf(url))) {
      try {
        res = await loadPdf((res && res.url) || url, tab.id);
        err = null;
      } catch (e) {
        err = e;
        res = null;
      }
    }
    if (!res) {
      const msg = String((err && err.message) || '');
      if (/permission|Cannot access|cannot be scripted|host/i.test(msg) || !url) {
        if (!quiet || !state.doc) accessNotice();
        if (!state.doc) { setHeader({ title: tab.title || 'Page Assistant', meta: 'Waiting for access to this tab' }); }
        else markStale();
      } else {
        showNotice(escapeHtml(msg || 'This page could not be read.'), 'error');
        setHeader({ title: tab.title || 'Page Assistant', meta: 'Could not read this page' });
      }
      return;
    }
    showNotice('');
    if (!res.blocks.length) {
      showNotice('No readable text was found on this page. If it is a canvas-based app or a scanned document, try selecting text instead.', 'warn');
    }
    if (keepSelection && state.doc && state.doc.selection && !res.selection) res.selection = state.doc.selection;
    setDoc(res);
  } finally {
    state.loading = false;
    refreshBtn.classList.remove('spin');
  }
}

function markStale() {
  showNotice(`<span>You switched pages. </span><button class="ghost small" type="button" data-act="reload">Read this page</button>`, '');
}

function setDoc(res) {
  const prevUrl = state.doc && state.doc.url;
  if (!res) { state.doc = null; renderInsights(); renderHistory(); return; }
  const blocks = res.blocks;
  const prose = blocks.filter((b) => b.type !== 'pre' && b.type !== 'table').map((b) => b.text).join('\n\n');
  const doc = {
    ...res,
    text: blocksToText(blocks),
    prose,
    stats: NLP.readingStats(prose),
  };
  // Expensive derived data is computed lazily.
  let passages, keywords, outline;
  Object.defineProperties(doc, {
    passages: { get: () => passages || (passages = NLP.buildPassages(blocks)) },
    keywords: { get: () => keywords || (keywords = NLP.extractKeywords(blocks, { max: 16, title: doc.title })) },
    outline: { get: () => outline || (outline = NLP.buildOutline(blocks, { title: doc.title })) },
  });
  state.doc = doc;
  const host = (() => { try { return new URL(doc.url).hostname.replace(/^www\./, ''); } catch (e) { return doc.siteName || ''; } })();
  const meta = [doc.isPdf ? `PDF · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : (doc.siteName || host), `${doc.stats.words.toLocaleString()} words`, `${doc.stats.readingMinutes} min read`].filter(Boolean).join(' · ');
  setHeader({ title: doc.title, meta, letter: doc.isPdf ? 'P' : (doc.siteName || host) });
  if (doc.url !== prevUrl) {
    if (state.chat) state.chat.destroy();
    state.chat = null;
    state.chatContext = '';
    $('#chat-log').innerHTML = '';
    $('#chat-context').hidden = true;
    $('#sum-output').innerHTML = '';
    $('#sum-actions').hidden = true;
    $('#sum-empty').hidden = false;
    $('#study-output').innerHTML = '';
    $('#study-actions').hidden = true;
    state.study = null;
  }
  updateSelectionUI(doc.selection);
  renderSuggestions();
  renderChatMode();
  renderInsights();
  renderHistory();
  if (state.settings.autoSummarize && doc.url !== prevUrl && doc.blocks.length) runSummary();
}

function updateSelectionUI(sel) {
  const wrap = $('#sum-sel-wrap');
  const has = !!(sel && sel.trim().length > 20);
  wrap.hidden = !has;
  $('#sum-selection').checked = has && $('#sum-selection').checked;
  $('#sum-sel-count').textContent = has ? `(${NLP.wordCount(sel)} words)` : '';
  if (has && !$('#sel-text').value.trim()) $('#sel-text').value = sel;
}

async function grabSelection() {
  if (!state.tab) await loadPage();
  if (!state.tab) return '';
  try {
    const sel = await exec(state.tab.id, { files: ['content/extract.js'], func: () => globalThis.__PA_getSelection() });
    if (state.doc) state.doc.selection = sel || '';
    updateSelectionUI(sel || '');
    return sel || '';
  } catch (e) {
    accessNotice();
    return '';
  }
}

async function ensureDoc() {
  if (!state.doc) await loadPage();
  if (!state.doc) { toast('Open a readable page first'); return false; }
  if (!state.doc.blocks.length) { toast('No readable text on this page'); return false; }
  return true;
}

// ---------------- in-page highlighting ----------------
async function inPage(fnName, arg) {
  if (!state.tab || !state.doc || state.doc.isPdf) {
    if (state.doc && state.doc.isPdf) toast('Highlighting is not available inside the PDF viewer');
    return null;
  }
  try {
    const r = await exec(state.tab.id, {
      files: ['content/highlight.js'],
      func: (name, a) => globalThis.__PA_hl[name](a),
      args: [fnName, arg],
    });
    if (r && !r.found) toast('Could not find that passage on the page');
    return r;
  } catch (e) {
    accessNotice();
    return null;
  }
}
const showPassages = (passages, focus = 0) => inPage('highlight', { passages, focus });

// ---------------- Summary ----------------
function segValue(id) { const b = $(`#${id} [aria-checked="true"]`); return b ? b.dataset.v : null; }
function setSeg(id, v) {
  for (const b of $$(`#${id} [role="radio"]`)) {
    const on = b.dataset.v === v;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
function initSeg(id, onChange) {
  const root = $(`#${id}`);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (!b) return;
    setSeg(id, b.dataset.v);
    onChange && onChange(b.dataset.v);
  });
  root.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = $$('[role="radio"]', root);
    const i = items.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const n = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    setSeg(id, n.dataset.v);
    n.focus();
    onChange && onChange(n.dataset.v);
    e.preventDefault();
  });
}

function renderKeyPoints(el, sentences, type) {
  if (type === 'headline') {
    el.className = 'output md headline';
    el.innerHTML = `<p>${escapeHtml(NLP.makeHeadline(sentences[0].text))}</p>`;
    return;
  }
  el.className = 'output md';
  if (type === 'tldr') {
    el.innerHTML = `<p>${sentences.map((s, i) => `<span>${escapeHtml(s.text)}</span> <button class="locate" type="button" data-i="${i}" title="Show in page" aria-label="Show sentence ${i + 1} in page">${svgIcon('i-locate')}</button>`).join(' ')}</p>`;
  } else {
    el.innerHTML = `<ul class="kp">${sentences.map((s, i) => `<li><span class="t">${escapeHtml(s.text)}</span><button class="locate" type="button" data-i="${i}" title="Show in page" aria-label="Show in page">${svgIcon('i-locate')}</button></li>`).join('')}</ul>`;
  }
  el.querySelectorAll('.locate').forEach((b) => b.addEventListener('click', () => {
    const s = sentences[+b.dataset.i];
    showPassages([{ text: s.text, block: s.block }]);
  }));
}

async function runSummary(opts = {}) {
  if (!(await ensureDoc())) return;
  const type = segValue('sum-type') || 'key-points';
  const length = segValue('sum-length') || 'medium';
  const useSel = opts.text != null || $('#sum-selection').checked;
  const selText = opts.text != null ? opts.text : (state.doc.selection || '');
  const out = $('#sum-output');
  const status = $('#sum-status');
  const btn = $('#btn-summarize');
  const ctrl = startOp('summary');
  $('#sum-empty').hidden = true;
  $('#sum-actions').hidden = true;
  btn.disabled = true;
  out.className = 'output md';
  out.innerHTML = '<div class="skeleton"><i></i><i></i><i></i></div>';
  let markdown = '';
  let engine = 'Offline · TextRank';
  let note = '';
  const doc = state.doc;
  try {
    if (wantAI('Summarizer')) {
      try {
        const input = useSel && selText ? selText : doc.text;
        const render = streamer(out);
        const r = await AI.summarize(input, { type, length, lang: outLang(), title: doc.title, signal: ctrl.signal, onText: render, onStatus: (s) => setStatus(status, s, true) });
        markdown = r.text;
        engine = r.chunked ? 'On-device AI · long page' : 'On-device AI';
        finishStream(out, markdown);
        if (type === 'headline') out.classList.add('headline');
      } catch (e) {
        if (isAbort(e)) throw e;
        note = `On-device summarizer unavailable (${e.message || e.name}). Used the offline summarizer instead.`;
        markdown = '';
      }
    }
    if (!markdown) {
      if (state.settings.engine === 'ai' && !note) note = 'On-device AI is not available here, so the offline summarizer was used.';
      setStatus(status, 'Ranking sentences…', true);
      await new Promise((r) => setTimeout(r, 0));
      const r = NLP.summarizeExtractive(useSel && selText ? selText : doc.blocks, { type, length, title: doc.title });
      if (!r.sentences.length) throw new Error('Not enough text to summarize.');
      markdown = r.markdown;
      // Selection sentences have no block index; locate them by text.
      const sents = useSel && selText ? r.sentences.map((s) => ({ ...s, block: undefined })) : r.sentences;
      renderKeyPoints(out, sents, type);
      if (type === 'headline') markdown = NLP.makeHeadline(r.sentences[0].text);
    }
    setStatus(status, note);
    const pill = $('#sum-engine');
    pill.textContent = engine + (useSel && selText ? ' · selection' : '');
    pill.className = 'pill' + (engine.startsWith('Offline') ? ' offline' : '');
    $('#sum-actions').hidden = false;
    state.lastSummary = { markdown, type, length, engine, source: useSel && selText ? 'selection' : 'page' };
    if (state.settings.saveHistory) {
      await History.addEntry(doc.url, doc.title, { kind: 'summary', label: `${TYPE_LABEL[type]} · ${length}${useSel && selText ? ' · selection' : ''}`, engine, text: markdown });
      renderHistory();
    }
  } catch (e) {
    if (isAbort(e)) { setStatus(status, 'Stopped.'); }
    else { setStatus(status, ''); out.className = 'output md'; out.innerHTML = `<p>${escapeHtml(e.message || 'Something went wrong.')}</p>`; }
  } finally {
    btn.disabled = false;
    endOp('summary', ctrl);
  }
}

function summaryMarkdown() {
  const s = state.lastSummary;
  const d = state.doc;
  if (!s || !d) return '';
  return History.entryToMarkdown({ label: `${TYPE_LABEL[s.type]} · ${s.length}`, engine: s.engine, text: s.markdown, createdAt: Date.now() }, { title: d.title, url: d.url });
}

// ---------------- Ask (chat) ----------------
function renderChatMode() {
  const el = $('#chat-mode');
  if (!state.doc) { el.textContent = ''; return; }
  el.textContent = wantAI('LanguageModel') ? 'On-device AI chat with page context' : 'Offline search: answers are the most relevant passages';
}

function renderSuggestions() {
  const box = $('#chat-suggest');
  if (!state.doc || !state.doc.blocks.length) { box.innerHTML = ''; return; }
  const kws = state.doc.keywords.slice(0, 3).map((k) => k.text);
  const qs = ['What is the main point?'];
  if (kws[0]) qs.push(`What does it say about ${kws[0]}?`);
  if (kws[1]) qs.push(`Explain ${kws[1]}`);
  qs.push('What are the key numbers and dates?');
  box.innerHTML = qs.map((q) => `<button class="chip" type="button">${escapeHtml(q)}</button>`).join('');
  $$('.chip', box).forEach((b) => b.addEventListener('click', () => { $('#chat-input').value = b.textContent; ask(); }));
}

function addMsg(role, html) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  if (role === 'user') el.textContent = html;
  else el.innerHTML = html;
  $('#chat-log').appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}

function sourcesHtml(results, qTerms) {
  if (!results.length) return '';
  const set = new Set(qTerms);
  const items = results.map((r, i) => {
    const parts = NLP.highlightTerms(r.passage.text.length > 420 ? r.passage.text.slice(0, 420) + '…' : r.passage.text, set);
    const body = parts.map((p) => (p.hit ? `<mark>${escapeHtml(p.text)}</mark>` : escapeHtml(p.text))).join('');
    return `<div class="source"><span class="n">${i + 1}</span><span class="t">${r.passage.heading ? `<span class="h">${escapeHtml(r.passage.heading)}</span>` : ''}${body}</span><button class="locate" type="button" data-src="${i}" title="Show in page" aria-label="Show passage ${i + 1} in page">${svgIcon('i-locate')}</button></div>`;
  }).join('');
  return items;
}

function bindSources(el, results) {
  el.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
    const i = +b.dataset.src;
    showPassages(results.map((r) => ({ text: r.passage.text, block: r.passage.blocks[0] })), i);
  }));
}

const SUMMARY_Q = /\b(main (point|idea|argument)|summar|tl;?dr|key (points|takeaways)|takeaways|what is (this|it) about|gist|overview)\b/i;

async function ask(questionArg) {
  if (!(await ensureDoc())) return;
  const input = $('#chat-input');
  const question = (questionArg || input.value).trim();
  if (!question) return;
  input.value = '';
  const ctxPassage = state.chatContext;
  addMsg('user', ctxPassage ? `${question}\n\n“${ctxPassage.slice(0, 160)}${ctxPassage.length > 160 ? '…' : ''}”` : question);
  const bot = addMsg('bot', '<div class="skeleton"><i></i><i></i></div>');
  const ctrl = startOp('chat');
  $('#chat-send').hidden = true;
  $('#chat-stop').hidden = false;
  const doc = state.doc;
  let answer = '';
  let engine = '';
  let found = null;
  try {
    if (wantAI('LanguageModel')) {
      try {
        if (!state.chat) {
          state.chat = new AI.PageChat({ title: doc.title, url: doc.url, text: doc.text, blocks: doc.blocks }, { lang: outLang(), passages: doc.passages });
          state.chat.onOverflow = () => toast('Long conversation: the oldest messages were dropped');
        }
        const body = document.createElement('div');
        body.className = 'md';
        bot.innerHTML = '';
        bot.appendChild(body);
        const render = streamer(body);
        const q = ctxPassage ? `Regarding this passage from the page:\n"""${ctxPassage}"""\n\n${question}` : question;
        const r = await state.chat.ask(q, { onText: (t) => { render(t); }, signal: ctrl.signal });
        answer = r.text;
        found = ctxPassage ? NLP.searchPassages(doc.passages, ctxPassage, { k: 3 }) : r.sources;
        finishStream(body, answer);
        engine = 'On-device AI';
      } catch (e) {
        if (isAbort(e)) throw e;
        toast('On-device chat failed, using offline search');
        answer = '';
      }
    }
    if (!answer) {
      engine = 'Offline search';
      if (SUMMARY_Q.test(question) && !ctxPassage) {
        const r = NLP.summarizeExtractive(doc.blocks, { type: 'key-points', length: 'short', title: doc.title });
        answer = `Here are the central points of this page:\n\n${r.markdown}`;
        bot.innerHTML = `<div class="md">${renderMarkdown(answer)}</div>`;
        found = { results: r.sentences.map((s) => ({ passage: { text: s.text, blocks: [s.block], heading: '' }, score: s.score })), terms: [] };
      } else {
        found = NLP.searchPassages(doc.passages, ctxPassage ? ctxPassage + ' ' + question : question, { k: 3 });
        if (!found.results.length) {
          answer = 'I couldn’t find anything about that on this page. Try other keywords, or a word that appears in the text.';
          bot.innerHTML = `<p>${escapeHtml(answer)}</p>`;
        } else {
          const best = found.results[0].best || '';
          const set = new Set(found.terms);
          const bestHtml = NLP.highlightTerms(best, set).map((p) => (p.hit ? `<mark>${escapeHtml(p.text)}</mark>` : escapeHtml(p.text))).join('');
          answer = `${best}\n\n${found.results.map((r, i) => `${i + 1}. ${r.passage.text}`).join('\n')}`;
          bot.innerHTML = `<div class="answer-best">${bestHtml}</div><div class="small muted">Most relevant passages on this page:</div>${sourcesHtml(found.results, found.terms)}`;
          bindSources(bot, found.results);
          showPassages(found.results.map((r) => ({ text: r.passage.text, block: r.passage.blocks[0] })), 0);
        }
      }
    }
    if (engine === 'On-device AI' && found && found.results.length) {
      const det = document.createElement('details');
      det.className = 'sources';
      det.innerHTML = `<summary>Sources on this page (${found.results.length})</summary>${sourcesHtml(found.results, found.terms)}`;
      bot.appendChild(det);
      bindSources(det, found.results);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="pill${engine.startsWith('Offline') ? ' offline' : ''}">${escapeHtml(engine)}</span><span class="spacer"></span><button class="locate" type="button" title="Copy answer as Markdown" aria-label="Copy answer">${svgIcon('i-copy')}</button>`;
    meta.querySelector('button').addEventListener('click', () => copyText(History.entryToMarkdown({ kind: 'answer', label: 'Answer', engine, question, text: answer, createdAt: Date.now() }, { title: doc.title, url: doc.url })));
    bot.appendChild(meta);
    const u = state.chat && state.chat.usage();
    if (u) $('#chat-mode').textContent = `On-device AI chat · context ${Math.round((u.used / u.quota) * 100)}% used`;
    if (state.settings.saveHistory && answer) {
      History.addEntry(doc.url, doc.title, { kind: 'answer', label: 'Answer', engine, question, text: answer }).then(renderHistory);
    }
  } catch (e) {
    if (isAbort(e)) bot.insertAdjacentHTML('beforeend', '<div class="small muted">Stopped.</div>');
    else { bot.classList.add('error'); bot.innerHTML = `<p>${escapeHtml(e.message || 'Something went wrong.')}</p>`; }
  } finally {
    $('#chat-send').hidden = false;
    $('#chat-stop').hidden = true;
    endOp('chat', ctrl);
    bot.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
}

function setChatContext(text) {
  state.chatContext = (text || '').trim();
  $('#chat-context').hidden = !state.chatContext;
  $('#chat-context-text').textContent = state.chatContext;
}

// ---------------- Selection tools ----------------
async function selectionOrPrompt() {
  let text = $('#sel-text').value.trim();
  if (!text) text = (await grabSelection()).trim();
  if (text) $('#sel-text').value = text;
  return text;
}

function surroundingContext(text) {
  if (!state.doc) return '';
  const r = NLP.searchPassages(state.doc.passages, text, { k: 1 });
  return r.results[0] ? r.results[0].passage.text.slice(0, 1200) : '';
}

function offlineExplain(text) {
  const doc = state.doc;
  const kws = NLP.extractKeywords(text, { max: 5 });
  const stats = NLP.readingStats(text);
  const lines = [];
  lines.push('_On-device AI isn’t available here, so this explanation is built from the page itself._');
  lines.push(`**Reading level:** ${stats.fleschLabel} (grade ${stats.grade}). ${stats.sentences} sentence${stats.sentences === 1 ? '' : 's'}, ${stats.words} words.`);
  if (NLP.wordCount(text) > 30) lines.push(`**In simpler words:** ${NLP.simplifyText(text)}`);
  if (doc && kws.length) {
    lines.push('**Key terms and where the page discusses them:**');
    const allSents = NLP.sentencesFromBlocks(doc.blocks);
    for (const k of kws) {
      const re = new RegExp('\\b' + k.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      const defn = allSents.find((s) => re.test(s.text) && /\b(is|are|means|refers to|describes|called)\b/i.test(s.text) && !text.includes(s.text));
      const other = defn || allSents.find((s) => re.test(s.text) && !text.includes(s.text));
      lines.push(`- **${k.text}**: ${other ? other.text : 'only mentioned in this passage.'}`);
    }
  }
  return lines.join('\n\n');
}

function offlineDraft(preset) {
  const doc = state.doc;
  const pts = NLP.summarizeExtractive(doc.blocks, { type: 'key-points', length: 'short', title: doc.title }).sentences.map((s) => s.text);
  const kws = doc.keywords.slice(0, 4).map((k) => k.text);
  switch (preset) {
    case 'email':
      return `Subject: Worth a read: ${doc.title}\n\nHi,\n\nI came across “${doc.title}” and thought you would find it useful. The main points:\n\n${pts.map((p) => '- ' + p).join('\n')}\n\nLink: ${doc.url}\n\nBest,`;
    case 'questions':
      return kws.map((k, i) => `${i + 1}. What does the page say about ${k}, and do you agree?`).concat([`${kws.length + 1}. Which point in “${doc.title}” matters most, and why?`]).join('\n');
    case 'notes':
      return `## ${doc.title}\n\n${pts.map((p) => '- ' + p).join('\n')}\n\n**Key terms:** ${kws.join(', ')}`;
    default:
      return `${pts[0] || doc.title}\n\nRead “${doc.title}”: ${doc.url}${kws.length ? `\n\n${kws.slice(0, 3).map((k) => '#' + k.replace(/[^\p{L}\p{N}]+/gu, '')).join(' ')}` : ''}`;
  }
}

const WRITE_TASKS = {
  share: 'Write a short social media post (under 280 characters) sharing this article and its most interesting insight.',
  email: 'Write a short email to a colleague recommending this article, with its three most useful points as bullets.',
  questions: 'Write five thought-provoking discussion questions about this article.',
  notes: 'Write concise study notes for this article with headings and bullet points.',
};

async function runTool(tool) {
  if (tool === 'write') return runWrite();
  const text = await selectionOrPrompt();
  if (!text) { toast('Select some text on the page first, or paste it in the box'); $('#sel-text').focus(); return; }
  if (tool === 'summarize') { selectTab('summary'); return runSummary({ text }); }
  if (tool === 'ask') { setChatContext(text); selectTab('ask'); $('#chat-input').focus(); return; }
  const out = $('#tool-output');
  const status = $('#tool-status');
  const ctrl = startOp('tool');
  $$('.tool').forEach((b) => { b.disabled = true; });
  $('#tool-actions').hidden = true;
  out.innerHTML = '<div class="skeleton"><i></i><i></i><i></i></div>';
  const render = streamer(out);
  let result = '';
  let engine = '';
  try {
    const title = state.doc ? state.doc.title : '';
    if (tool === 'explain') {
      if (wantAI('LanguageModel')) {
        setStatus(status, 'Explaining on device…', true);
        try { result = await AI.explain(text, { title, context: surroundingContext(text), lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device AI'; }
        catch (e) { if (isAbort(e)) throw e; result = ''; }
      }
      if (!result) { result = offlineExplain(text); engine = 'Offline'; }
    } else if (tool === 'simplify') {
      if (wantAI('LanguageModel')) {
        setStatus(status, 'Simplifying on device…', true);
        try { result = await AI.simplify(text, { lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device AI'; }
        catch (e) { if (isAbort(e)) throw e; result = ''; }
      }
      if (!result && wantAI('Rewriter')) {
        try { result = await AI.rewrite(text, { tone: 'more-casual', length: 'shorter', context: 'Rewrite in plain, simple language for a general audience.', lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device Rewriter'; }
        catch (e) { if (isAbort(e)) throw e; result = ''; }
      }
      if (!result) { result = NLP.simplifyText(text); engine = 'Offline heuristics'; }
    } else if (tool === 'rewrite') {
      const tone = $('#rw-tone').value;
      const length = $('#rw-length').value;
      if (wantAI('Rewriter')) {
        setStatus(status, 'Rewriting on device…', true);
        try { result = await AI.rewrite(text, { tone, length, lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device Rewriter'; }
        catch (e) { if (isAbort(e)) throw e; result = ''; }
      }
      if (!result && wantAI('LanguageModel')) {
        const how = [tone !== 'as-is' ? tone.replace('-', ' ') : '', length !== 'as-is' ? length : ''].filter(Boolean).join(' and ') || 'clearer';
        try { result = await AI.promptOnce('You rewrite text. Output only the rewritten text.', `Rewrite this to be ${how}:\n"""${text}"""`, { lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device AI'; }
        catch (e) { if (isAbort(e)) throw e; result = ''; }
      }
      if (!result) {
        result = length === 'shorter' ? NLP.summarizeExtractive(text, { type: 'tldr', length: 'short' }).markdown || text : NLP.simplifyText(text);
        engine = 'Offline';
        setStatus(status, 'Tone rewriting needs on-device AI. Showing an offline shortened version.');
      }
    }
    finishStream(out, result);
    if (!status.textContent.startsWith('Tone')) setStatus(status, '');
    $('#tool-engine').textContent = engine;
    $('#tool-engine').className = 'pill' + (engine.startsWith('Offline') ? ' offline' : '');
    $('#tool-actions').hidden = false;
    state.lastTool = { tool, text: result, engine, input: text };
    if (state.settings.saveHistory && state.doc && (tool === 'explain' || tool === 'simplify')) {
      History.addEntry(state.doc.url, state.doc.title, { kind: tool, label: tool === 'explain' ? 'Explanation' : 'Simplified', engine, question: text.slice(0, 200), text: result }).then(renderHistory);
    }
  } catch (e) {
    if (isAbort(e)) setStatus(status, 'Stopped.');
    else { setStatus(status, ''); out.innerHTML = `<p>${escapeHtml(e.message || 'Something went wrong.')}</p>`; }
  } finally {
    $$('.tool').forEach((b) => { b.disabled = false; });
    endOp('tool', ctrl);
  }
}

async function runWrite() {
  if (!(await ensureDoc())) return;
  const preset = $('#wr-preset').value;
  const custom = $('#wr-custom').value.trim();
  if (preset === 'custom' && !custom) { toast('Describe what to write'); $('#wr-custom').focus(); return; }
  const task = preset === 'custom' ? custom : WRITE_TASKS[preset];
  const toneSel = $('#wr-tone').value;
  const out = $('#tool-output');
  const status = $('#tool-status');
  const ctrl = startOp('tool');
  $$('.tool').forEach((b) => { b.disabled = true; });
  out.innerHTML = '<div class="skeleton"><i></i><i></i><i></i></div>';
  const render = streamer(out);
  const doc = state.doc;
  const context = `Title: ${doc.title}\nURL: ${doc.url}\n\n${NLP.compressDocument(doc.blocks, { maxChars: 3500, title: doc.title })}`;
  let result = '';
  let engine = '';
  try {
    if (wantAI('Writer')) {
      setStatus(status, 'Writing on device…', true);
      try { result = await AI.write(task, { context, tone: toneSel, length: 'medium', lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device Writer'; }
      catch (e) { if (isAbort(e)) throw e; result = ''; }
    }
    if (!result && wantAI('LanguageModel')) {
      setStatus(status, 'Writing on device…', true);
      try { result = await AI.promptOnce(`You are a helpful writer. Tone: ${toneSel}. Use Markdown where helpful.`, `${task}\n\nArticle:\n"""${context}"""`, { lang: outLang(), onText: render, signal: ctrl.signal }); engine = 'On-device AI'; }
      catch (e) { if (isAbort(e)) throw e; result = ''; }
    }
    if (!result) {
      if (preset === 'custom') { result = '_Custom drafts need on-device AI (Chrome with built-in AI). Pick a preset to get an offline template instead._'; }
      else result = offlineDraft(preset);
      engine = 'Offline template';
    }
    finishStream(out, result);
    setStatus(status, '');
    $('#tool-engine').textContent = engine;
    $('#tool-engine').className = 'pill' + (engine.startsWith('Offline') ? ' offline' : '');
    $('#tool-actions').hidden = false;
    state.lastTool = { tool: 'write', text: result, engine };
  } catch (e) {
    if (isAbort(e)) setStatus(status, 'Stopped.');
    else { setStatus(status, ''); out.innerHTML = `<p>${escapeHtml(e.message || 'Something went wrong.')}</p>`; }
  } finally {
    $$('.tool').forEach((b) => { b.disabled = false; });
    endOp('tool', ctrl);
  }
}

// ---------------- Study ----------------
async function runStudy() {
  if (!(await ensureDoc())) return;
  const mode = segValue('study-mode') || 'cards';
  const count = +$('#study-count').value;
  const status = $('#study-status');
  const out = $('#study-output');
  const btn = $('#btn-study');
  const ctrl = startOp('study');
  btn.disabled = true;
  $('#study-actions').hidden = true;
  out.innerHTML = '<div class="output"><div class="skeleton"><i></i><i></i><i></i></div></div>';
  const doc = state.doc;
  let items = [];
  let engine = 'Offline';
  try {
    if (wantAI('LanguageModel')) {
      setStatus(status, mode === 'cards' ? 'Writing flashcards on device…' : 'Writing quiz on device…', true);
      try {
        items = mode === 'cards' ? await AI.flashcards(doc, { count, lang: outLang(), signal: ctrl.signal }) : await AI.quiz(doc, { count, lang: outLang(), signal: ctrl.signal });
        engine = 'On-device AI';
      } catch (e) { if (isAbort(e)) throw e; items = []; }
    }
    if (!items.length) {
      setStatus(status, 'Building from key sentences…', true);
      await new Promise((r) => setTimeout(r, 0));
      items = mode === 'cards' ? NLP.makeFlashcards(doc.blocks, { count, title: doc.title }) : NLP.makeQuiz(doc.blocks, { count, title: doc.title });
      engine = 'Offline';
    }
    if (!items.length) throw new Error('This page does not have enough material for study cards.');
    state.study = { mode, items, engine, index: 0 };
    setStatus(status, '');
    renderStudy();
    $('#study-engine').textContent = engine;
    $('#study-engine').className = 'pill' + (engine === 'Offline' ? ' offline' : '');
    $('#study-actions').hidden = false;
    $('#study-anki').hidden = mode !== 'cards';
  } catch (e) {
    if (isAbort(e)) setStatus(status, 'Stopped.');
    else { setStatus(status, ''); out.innerHTML = `<div class="empty">${escapeHtml(e.message || 'Something went wrong.')}</div>`; }
  } finally {
    btn.disabled = false;
    endOp('study', ctrl);
  }
}

function renderStudy() {
  const s = state.study;
  const out = $('#study-output');
  if (!s) { out.innerHTML = ''; return; }
  if (s.mode === 'cards') {
    const c = s.items[s.index];
    out.innerHTML = `
      <div class="card-wrap">
        <button class="flashcard" type="button" aria-label="Flashcard ${s.index + 1} of ${s.items.length}. Press to flip.">
          <div class="face front"><span class="tag">Question</span><div>${escapeHtml(c.front)}</div></div>
          <div class="face back"><span class="tag">Answer</span><div><strong>${escapeHtml(c.back)}</strong></div>${c.context && c.context !== c.back ? `<div class="small muted">${escapeHtml(c.context)}</div>` : ''}</div>
        </button>
      </div>
      <div class="card-nav">
        <button class="icon-btn" type="button" data-nav="-1" aria-label="Previous card">${svgIcon('i-left')}</button>
        <span class="small muted">${s.index + 1} / ${s.items.length} · Space flips</span>
        <button class="icon-btn" type="button" data-nav="1" aria-label="Next card">${svgIcon('i-right')}</button>
        ${c.block != null ? `<button class="locate" type="button" data-loc aria-label="Show in page" title="Show in page">${svgIcon('i-locate')}</button>` : ''}
      </div>`;
    const card = $('.flashcard', out);
    card.addEventListener('click', () => card.classList.toggle('flipped'));
    $$('[data-nav]', out).forEach((b) => b.addEventListener('click', () => { s.index = (s.index + +b.dataset.nav + s.items.length) % s.items.length; renderStudy(); $('.flashcard', out).focus(); }));
    const loc = $('[data-loc]', out);
    if (loc) loc.addEventListener('click', () => showPassages([{ text: c.context || c.back, block: c.block }]));
    return;
  }
  out.innerHTML = `<form class="quiz" id="quiz-form">${s.items.map((q, i) => `
    <fieldset class="q" style="border:1px solid var(--border)">
      <legend class="sr-only">Question ${i + 1}</legend>
      <h3>${i + 1}. ${escapeHtml(q.question)}</h3>
      ${q.options.map((o, j) => `<label><input type="radio" name="q${i}" value="${j}"> <span>${escapeHtml(o)}</span></label>`).join('')}
      <div class="expl" hidden>${escapeHtml(q.explanation || '')}</div>
    </fieldset>`).join('')}
    <div class="row"><span id="quiz-score" class="score"></span><span class="spacer"></span><button class="ghost" type="button" id="quiz-reset">Reset</button><button class="primary" type="submit">Check answers</button></div>
  </form>`;
  const form = $('#quiz-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let right = 0;
    s.items.forEach((q, i) => {
      const fs = form.querySelectorAll('fieldset')[i];
      const picked = form.querySelector(`input[name="q${i}"]:checked`);
      fs.querySelectorAll('label').forEach((l, j) => { l.classList.toggle('correct', j === q.answer); l.classList.toggle('wrong', !!picked && +picked.value === j && j !== q.answer); });
      if (picked && +picked.value === q.answer) right++;
      fs.querySelector('.expl').hidden = !q.explanation;
    });
    $('#quiz-score').textContent = `Score: ${right} / ${s.items.length}`;
  });
  $('#quiz-reset').addEventListener('click', () => renderStudy());
}

function studyMarkdown() {
  const s = state.study;
  const d = state.doc;
  if (!s || !d) return '';
  const head = `# ${s.mode === 'cards' ? 'Flashcards' : 'Quiz'}: ${d.title}\n\n<${d.url}>\n\n`;
  if (s.mode === 'cards') return head + s.items.map((c, i) => `${i + 1}. **${c.front}**\n   ${c.back}`).join('\n');
  return head + s.items.map((q, i) => `${i + 1}. ${q.question}\n${q.options.map((o, j) => `   - [${j === q.answer ? 'x' : ' '}] ${o}`).join('\n')}${q.explanation ? `\n   _${q.explanation}_` : ''}`).join('\n\n');
}

// ---------------- Insights ----------------
function renderInsights() {
  const d = state.doc;
  const stats = $('#stats');
  if (!d) {
    stats.innerHTML = '<div class="empty" style="grid-column:1/-1">Open a page to see reading time, readability, keywords and an outline.</div>';
    $('#keywords').innerHTML = '';
    $('#outline').innerHTML = '';
    $('#page-details').innerHTML = '';
    $('#outline-kind').textContent = '';
    return;
  }
  const s = d.stats;
  stats.innerHTML = [
    ['Reading time', `${s.readingMinutes} min`, `${s.words.toLocaleString()} words`],
    ['Readability', `${s.flesch}`, s.fleschLabel, s.flesch],
    ['Grade level', `${s.grade}`, 'Flesch–Kincaid'],
    ['Sentences', `${s.sentences.toLocaleString()}`, `${s.avgSentenceWords} words avg`],
  ].map(([k, v, sub, meter]) => `<div class="stat"><div class="k">${k}</div><div class="v">${escapeHtml(v)}</div><div class="s">${escapeHtml(sub)}</div>${meter != null ? `<div class="meter" aria-hidden="true"><i style="width:${Math.max(3, meter)}%"></i></div>` : ''}</div>`).join('');
  const kw = $('#keywords');
  kw.innerHTML = d.keywords.length ? d.keywords.map((k) => `<button class="chip" type="button" data-term="${escapeHtml(k.text)}">${escapeHtml(k.text)}<span class="c">${k.count}</span></button>`).join('') : '<span class="muted small">No keywords found.</span>';
  $$('.chip', kw).forEach((b) => b.addEventListener('click', async () => {
    const r = await inPage('highlightTerm', { term: b.dataset.term });
    if (r && r.found) toast(`${r.found} match${r.found === 1 ? '' : 'es'} highlighted`);
  }));
  const o = d.outline;
  $('#outline-kind').textContent = o.kind === 'auto' ? 'auto-generated sections' : o.kind === 'headings' ? `${o.items.length} headings` : '';
  $('#outline').innerHTML = o.items.length ? o.items.map((it, i) => `<li class="d${it.depth}"><button type="button" data-i="${i}">${escapeHtml(it.text)}</button></li>`).join('') : '<li class="muted small">This page has no headings.</li>';
  $$('#outline button').forEach((b) => b.addEventListener('click', () => {
    const it = o.items[+b.dataset.i];
    inPage('scrollToBlock', { block: it.block, text: d.blocks[it.block] && d.blocks[it.block].text.slice(0, 120) });
  }));
  const rows = [
    ['Site', d.siteName],
    ['Author', d.byline],
    ['Published', d.published ? (isNaN(Date.parse(d.published)) ? d.published : new Date(d.published).toLocaleDateString()) : ''],
    ['Language', d.lang],
    ['Extraction', d.method === 'pdf' ? `PDF text (${d.pageCount} pages)` : d.method === 'body' ? 'Whole page (no main article found)' : `Main article (${d.blocks.length} blocks)`],
    ['Complex words', `${s.complexWordPct}%`],
  ].filter(([, v]) => v);
  $('#page-details').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

// ---------------- History ----------------
function entryHtml(e, { showPage } = {}) {
  return `<article class="hist-entry" data-id="${e.id}">
    <header><span class="pill${String(e.engine || '').startsWith('Offline') ? ' offline' : ''}">${escapeHtml(e.label || e.kind)}</span><span>${escapeHtml(fmtDate(e.createdAt))}</span><span class="spacer"></span>
      <button class="locate" type="button" data-act="copy" title="Copy as Markdown" aria-label="Copy as Markdown">${svgIcon('i-copy')}</button>
      <button class="locate" type="button" data-act="del" title="Delete" aria-label="Delete">${svgIcon('i-trash')}</button></header>
    ${showPage ? '' : ''}${e.question ? `<div class="q-line">${escapeHtml(e.question)}</div>` : ''}
    <div class="body md">${renderMarkdown(e.text)}</div>
  </article>`;
}

function bindEntries(root, url, title, entries) {
  $$('.hist-entry', root).forEach((el) => {
    const e = entries.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(History.entryToMarkdown(e, { title, url }), 'Copied as Markdown'));
    el.querySelector('[data-act="del"]').addEventListener('click', async () => { await History.deleteEntry(url, e.id); renderHistory(); });
  });
}

async function renderHistory() {
  if (!hasChrome) return;
  const q = $('#hist-search').value.trim().toLowerCase();
  const match = (e) => !q || (e.text || '').toLowerCase().includes(q) || (e.question || '').toLowerCase().includes(q);
  const cur = $('#hist-current');
  const all = $('#hist-all');
  const d = state.doc;
  const curUrl = d ? History.normalizeUrl(d.url) : '';
  if (d) {
    const entries = (await History.getEntries(d.url)).filter(match);
    cur.innerHTML = entries.length ? entries.map((e) => entryHtml(e)).join('') : '<p class="hist-empty">Nothing saved for this page yet. Summaries and answers appear here automatically.</p>';
    bindEntries(cur, d.url, d.title, entries);
  } else cur.innerHTML = '<p class="hist-empty">No page loaded.</p>';
  const pages = (await History.listPages()).filter((p) => p.url !== curUrl);
  const filtered = [];
  for (const p of pages) {
    if (!q) { filtered.push({ p }); continue; }
    if (p.title.toLowerCase().includes(q) || p.url.toLowerCase().includes(q)) { filtered.push({ p }); continue; }
    const es = (await History.getEntries(p.url)).filter(match);
    if (es.length) filtered.push({ p, entries: es });
  }
  all.innerHTML = filtered.length ? filtered.map(({ p }) => `<details class="hist-page" data-url="${escapeHtml(p.url)}"><summary><span class="t" title="${escapeHtml(p.url)}">${escapeHtml(p.title)}</span><span class="small muted">${p.count} · ${escapeHtml(fmtDate(p.updatedAt))}</span></summary><div class="inner"></div></details>`).join('') : '<p class="hist-empty">No other pages yet.</p>';
  $$('.hist-page', all).forEach((det, i) => det.addEventListener('toggle', async () => {
    if (!det.open) return;
    const { p, entries } = filtered[i];
    const es = entries || (await History.getEntries(p.url));
    const inner = $('.inner', det);
    inner.innerHTML = `<div class="row"><a class="small" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open page</a><span class="spacer"></span><button class="ghost small danger-text" type="button" data-act="delpage">Delete page history</button></div>` + es.map((e) => entryHtml(e)).join('');
    bindEntries(inner, p.url, p.title, es);
    $('[data-act="delpage"]', inner).addEventListener('click', async () => { await History.deletePage(p.url); renderHistory(); });
  }));
}

// ---------------- Tabs ----------------
const TAB_ORDER = ['summary', 'ask', 'tools', 'study', 'insights', 'history'];
function selectTab(name, focus = false) {
  for (const t of TAB_ORDER) {
    const tab = $(`#tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (name === 'tools' && state.tab && !$('#sel-text').value.trim()) grabSelection();
  if (name === 'history') renderHistory();
  if (name === 'ask') setTimeout(() => $('#chat-input').focus(), 0);
}

// ---------------- Pending actions from the service worker ----------------
async function myWindowId() {
  if (state.myWindowId != null) return state.myWindowId;
  try { const w = await chrome.windows.getCurrent(); state.myWindowId = w.id; } catch (e) { state.myWindowId = -1; }
  return state.myWindowId;
}

async function consumePending() {
  if (!hasChrome) return;
  let p;
  try { p = (await chrome.storage.session.get('pa:pending'))['pa:pending']; } catch (e) { return; }
  if (!p || Date.now() - p.ts > 60000) return;
  if (p.tabId != null) {
    if (MODE === 'panel') {
      try { const t = await chrome.tabs.get(p.tabId); if (t.windowId !== (await myWindowId())) return; } catch (e) { return; }
    } else boundTabId = p.tabId;
  }
  await chrome.storage.session.remove('pa:pending');
  const needLoad = !state.doc || !state.tab || state.tab.id !== p.tabId || p.action === 'refresh';
  if (needLoad) await loadPage({ quiet: false });
  const text = (p.text || '').trim();
  switch (p.action) {
    case 'explain':
    case 'simplify': {
      selectTab('tools');
      const t = text || (await grabSelection());
      if (t) { $('#sel-text').value = t; runTool(p.action); }
      break;
    }
    case 'summarize-selection':
      selectTab('summary');
      if (text) runSummary({ text });
      break;
    case 'ask-selection':
      selectTab('ask');
      setChatContext(text);
      $('#chat-input').focus();
      break;
    case 'summarize-page':
      selectTab('summary');
      $('#sum-selection').checked = false;
      runSummary();
      break;
    case 'ask-page':
      selectTab('ask');
      break;
    default: break;
  }
}

// ---------------- Settings dialog ----------------
async function updatePermUI() {
  const ok = await hasAllSites();
  $('#perm-btn').textContent = ok ? 'Remove access to all sites' : 'Allow on all sites';
  $('#perm-text').textContent = ok
    ? 'Page Assistant can read pages as you switch tabs. It never sends page content anywhere.'
    : 'Page Assistant reads a page only when you open it on that tab. Allow all sites to read pages automatically as you switch tabs, and to load PDFs.';
}

function openSettings() {
  const s = state.settings;
  $('#set-engine').value = s.engine;
  $('#set-lang').value = s.outputLang;
  $('#set-auto').checked = s.autoSummarize;
  $('#set-follow').checked = s.followTabs;
  $('#set-history').checked = s.saveHistory;
  updatePermUI();
  $('#settings').showModal();
}

// ---------------- wiring ----------------
function wire() {
  $('#btn-refresh').addEventListener('click', () => { showNotice(''); loadPage({ quiet: false }); });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#notice').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'grant') requestAllSites();
    if (b.dataset.act === 'reload') { showNotice(''); loadPage({ quiet: false }); }
  });
  $('#ai-toggle').addEventListener('click', () => {
    const d = $('#ai-details');
    d.hidden = !d.hidden;
    $('#ai-toggle').setAttribute('aria-expanded', String(!d.hidden));
  });
  $('#ai-download').addEventListener('click', downloadModels);

  // Tabs with arrow-key navigation.
  $('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) selectTab(t.dataset.tab); });
  $('.tabs').addEventListener('keydown', (e) => {
    const cur = TAB_ORDER.findIndex((t) => $(`#tab-${t}`).getAttribute('aria-selected') === 'true');
    let n = -1;
    if (e.key === 'ArrowRight') n = (cur + 1) % TAB_ORDER.length;
    if (e.key === 'ArrowLeft') n = (cur + TAB_ORDER.length - 1) % TAB_ORDER.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = TAB_ORDER.length - 1;
    if (n >= 0) { selectTab(TAB_ORDER[n], true); e.preventDefault(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && /^[1-6]$/.test(e.key)) { selectTab(TAB_ORDER[+e.key - 1], true); e.preventDefault(); }
    if (e.key === 'Escape' && !$('#settings').open) { Object.values(state.ops).forEach((c) => c.abort()); }
    if (state.study && state.study.mode === 'cards' && !$('#panel-study').hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        state.study.index = (state.study.index + (e.key === 'ArrowRight' ? 1 : -1) + state.study.items.length) % state.study.items.length;
        renderStudy();
        $('.flashcard').focus();
        e.preventDefault();
      }
    }
  });

  initSeg('sum-type', (v) => { state.settings.summaryType = v; saveSettings(); });
  initSeg('sum-length', (v) => { state.settings.summaryLength = v; saveSettings(); });
  initSeg('study-mode', (v) => { state.settings.studyMode = v; saveSettings(); });
  setSeg('sum-type', state.settings.summaryType);
  setSeg('sum-length', state.settings.summaryLength);
  setSeg('study-mode', state.settings.studyMode);

  $('#btn-summarize').addEventListener('click', () => runSummary());
  $('#sum-regen').addEventListener('click', () => runSummary());
  $('#sum-copy').addEventListener('click', () => copyText(summaryMarkdown(), 'Copied as Markdown'));

  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
  });
  $('#chat-stop').addEventListener('click', () => state.ops.chat && state.ops.chat.abort());
  $('#chat-new').addEventListener('click', () => {
    if (state.chat) state.chat.destroy();
    state.chat = null;
    $('#chat-log').innerHTML = '';
    setChatContext('');
    renderChatMode();
    inPage('clear');
  });
  $('#chat-context-clear').addEventListener('click', () => setChatContext(''));

  $('#sel-grab').addEventListener('click', async () => {
    const t = await grabSelection();
    if (t) $('#sel-text').value = t;
    else toast('Nothing is selected on the page');
  });
  $$('.tool').forEach((b) => b.addEventListener('click', () => runTool(b.dataset.tool)));
  $('#tool-copy').addEventListener('click', () => state.lastTool && copyText(state.lastTool.text, 'Copied'));
  $('#wr-preset').addEventListener('change', () => { $('#wr-custom').hidden = $('#wr-preset').value !== 'custom'; });

  $('#btn-study').addEventListener('click', runStudy);
  $('#study-copy').addEventListener('click', () => copyText(studyMarkdown(), 'Copied as Markdown'));
  $('#study-anki').addEventListener('click', () => {
    const s = state.study;
    if (!s) return;
    copyText(s.items.map((c) => `${c.front.replace(/\t|\n/g, ' ')}\t${c.back.replace(/\t|\n/g, ' ')}`).join('\n'), 'Copied for Anki import');
  });

  $('#hist-search').addEventListener('input', () => { clearTimeout(renderHistory._t); renderHistory._t = setTimeout(renderHistory, 200); });
  $('#hist-clear').addEventListener('click', async () => {
    if (!confirm('Delete all saved summaries and answers?')) return;
    await History.clearAll();
    renderHistory();
    toast('History cleared');
  });

  $('#settings').addEventListener('close', async () => {
    const s = state.settings;
    const engineChanged = s.engine !== $('#set-engine').value;
    const langChanged = s.outputLang !== $('#set-lang').value;
    s.engine = $('#set-engine').value;
    s.outputLang = $('#set-lang').value;
    s.autoSummarize = $('#set-auto').checked;
    s.followTabs = $('#set-follow').checked;
    s.saveHistory = $('#set-history').checked;
    await saveSettings();
    if (langChanged) AI.resetCaches();
    if (engineChanged || langChanged) { if (state.chat) state.chat.destroy(); state.chat = null; await refreshAI(); renderChatMode(); }
  });
  $('#perm-btn').addEventListener('click', async () => {
    if (await hasAllSites()) { await chrome.permissions.remove({ origins: ['<all_urls>'] }); toast('Access removed'); }
    else await requestAllSites();
    updatePermUI();
  });

  if (!hasChrome) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'session' || area === 'local') && changes['pa:pending'] && changes['pa:pending'].newValue) consumePending();
  });
  // Follow the active tab.
  const onTabChange = async (tabId, windowId) => {
    if (MODE === 'panel' && windowId !== (await myWindowId())) return;
    if (MODE === 'window') { if (windowId === (await myWindowId())) return; boundTabId = tabId; }
    if (!state.settings.followTabs) { if (state.doc) markStale(); return; }
    loadPage({ quiet: true });
  };
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => onTabChange(tabId, windowId));
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!state.tab || tabId !== state.tab.id) return;
    if (info.status === 'complete') onTabChange(tabId, tab.windowId);
  });
}

async function init() {
  await loadSettings();
  wire();
  renderInsights();
  await refreshAI();
  renderChatMode();
  if (!hasChrome) return;
  await loadPage({ quiet: true });
  await consumePending();
}

init();
