// Home Base new tab: clock, greeting, daily focus, background, quote, links, search, widgets.
import * as store from '../lib/store.js';
import { h, icon, applyTheme, isTyping, openPage, debounce, toast } from '../lib/ui.js';
import { ymd, longLabel, pad } from '../lib/dates.js';
import { pickScene, drawScene, hashString } from '../lib/backgrounds.js';
import { imageIds, getImage } from '../lib/images.js';
import { createFrame, clampRect } from './widgets/frame.js';
import * as wTasks from './widgets/tasks.js';
import * as wNotes from './widgets/notes.js';
import * as wCalendar from './widgets/calendar.js';
import * as wClocks from './widgets/clocks.js';
import * as wHabits from './widgets/habits.js';
import * as wPomodoro from './widgets/pomodoro.js';

const $ = (id) => document.getElementById(id);
const WIDGET_MODULES = { tasks: wTasks, notes: wNotes, calendar: wCalendar, clocks: wClocks, habits: wHabits, pomodoro: wPomodoro };
const DEFAULT_SIZE = {
  tasks: { w: 344, h: 440 }, notes: { w: 336, h: 320 }, calendar: { w: 312, h: 420 },
  clocks: { w: 272, h: 232 }, habits: { w: 336, h: 280 }, pomodoro: { w: 256, h: 272 },
};
const app = { state: {}, widgets: new Map() };
let quotes = [];
let quoteOffset = 0;

// ---------------------------------------------------------------- clock + greeting

function renderClock() {
  const s = app.state.settings;
  const now = new Date();
  let hh = now.getHours();
  const mm = pad(now.getMinutes());
  let ampm = '';
  if (!s.h24) { ampm = hh < 12 ? 'AM' : 'PM'; hh = hh % 12 || 12; } else hh = pad(hh);
  const key = `${hh}:${mm}${s.showSeconds ? now.getSeconds() : ''}${ampm}`;
  const el = $('clock');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(`${hh}:${mm}`,
    s.showSeconds ? h('span.secs', ':' + pad(now.getSeconds())) : null,
    ampm ? h('span.ampm', ampm) : null);
  el.setAttribute('aria-label', now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !s.h24 }));
  $('today-label').textContent = longLabel(ymd(now));
  if (now.getSeconds() === 0 || !renderClock.greeted) { renderGreeting(); renderClock.greeted = true; }
  if (app.day !== ymd(now)) { app.day = ymd(now); onNewDay(); }
}

function greetingWord() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Good evening';
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  return 'Good evening';
}

function renderGreeting() {
  const s = app.state.settings;
  const g = $('greeting');
  g.hidden = !s.show.greeting;
  if (g.querySelector('input')) return; // editing
  const nameBtn = h('button.name-btn', { type: 'button', title: 'Click to change your name', onclick: editName }, s.name || 'friend');
  g.replaceChildren(`${greetingWord()}, `, nameBtn, '.');
}

function editName() {
  const g = $('greeting');
  const input = h('input', { type: 'text', value: app.state.settings.name, maxlength: '30', 'aria-label': 'Your name', placeholder: 'Your name' });
  const done = async (save) => {
    if (!input.isConnected) return;
    const v = input.value.trim();
    input.remove();
    if (save) await store.update('settings', (s) => ({ ...s, name: v }));
    renderGreeting();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  g.replaceChildren(`${greetingWord()}, `, input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------- focus

const CHEERS = [
  'Nicely done. That was the big one.',
  'Focus complete. Take a breath, you earned it.',
  'Done. The rest of the day is a bonus.',
  'That is how it is done.',
  'One clear win. Well played.',
  'Finished. Enjoy the lighter feeling.',
];

function renderFocus() {
  const s = app.state.settings;
  const f = app.state.focus;
  const el = $('focus');
  el.hidden = !s.show.focus;
  if (el.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const today = ymd(new Date());
  if (f.date !== today || !f.text) {
    const input = h('input.focus-input', { type: 'text', maxlength: '140', 'aria-label': 'What is your main focus for today?', autocomplete: 'off' });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const text = input.value.trim();
        input.blur();
        await store.set('focus', { date: today, text, done: false });
      }
      if (e.key === 'Escape') input.blur();
    });
    el.replaceChildren(h('div.focus-q', 'What is your main focus for today?'), input);
    return;
  }
  const row = h('div.focus-row', { class: `focus-row${f.done ? ' done' : ''}` },
    h('button.focus-check', {
      type: 'button', role: 'checkbox', 'aria-checked': String(f.done), 'aria-label': f.done ? 'Mark focus not done' : 'Mark focus done',
      onclick: toggleFocus,
    }, icon('check', 18)),
    h('span.focus-text', f.text),
    h('button.focus-more', { type: 'button', 'aria-label': 'Change focus', title: 'Change focus', onclick: () => store.set('focus', { date: '', text: '', done: false }).then(() => setTimeout(() => $('focus').querySelector('input')?.focus(), 50)) }, icon('edit', 16)));
  el.replaceChildren(h('div.focus-label', 'Today'), row, h('div.focus-cheer', { 'aria-live': 'polite' }, f.done ? (app.cheer || '') : ''));
}

async function toggleFocus() {
  const f = await store.update('focus', (x) => ({ ...x, done: !x.done }));
  if (f.done) {
    app.cheer = CHEERS[Math.floor(Math.random() * CHEERS.length)];
    renderFocus();
    celebrate();
  } else app.cheer = '';
}

function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = $('confetti');
  const dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#ffffff'];
  const cx = innerWidth / 2, cy = innerHeight * 0.55;
  const parts = Array.from({ length: 160 }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const v = 6 + Math.random() * 9;
    return { x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, s: 5 + Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)] };
  });
  const t0 = performance.now();
  const frame = (t) => {
    const el = t - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.25; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - el / 2600);
      ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (el < 2600) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- quote

async function loadQuotes() {
  try {
    const res = await fetch(chrome.runtime.getURL('data/quotes.json'));
    quotes = await res.json();
  } catch { quotes = ['Make today count.']; }
}

function renderQuote() {
  const show = app.state.settings.show.quote && quotes.length;
  $('quote').hidden = !show;
  if (!show) return;
  const i = (hashString(ymd(new Date()) + 'q') + quoteOffset) % quotes.length;
  $('quote-text').textContent = quotes[i];
}

// ---------------------------------------------------------------- background

let bgToken = 0;
let photoUrl = null;
async function renderBackground() {
  const token = ++bgToken;
  const s = app.state.settings.background;
  $('bg-dim').style.opacity = String(Math.max(0, Math.min(80, Number(s.dim) || 0)) / 100);
  const today = ymd(new Date());
  const sh = app.state.bgShuffle;
  const n = sh.date === today ? sh.n : 0;
  const seed = hashString(`${today}#${n}`);
  let usePhoto = false;
  let ids = [];
  if (s.mode !== 'generated') {
    try { ids = await imageIds(); } catch { ids = []; }
    usePhoto = ids.length > 0 && (s.mode === 'photos' || seed % 2 === 0);
  }
  if (token !== bgToken) return;
  const photo = $('bg-photo');
  if (usePhoto) {
    const rec = await getImage(ids[seed % ids.length]).catch(() => null);
    if (token !== bgToken) return;
    if (rec) {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(rec.blob);
      photo.style.backgroundImage = `url("${photoUrl}")`;
      photo.classList.add('show');
      $('bg-name').textContent = rec.name.replace(/\.[a-z0-9]+$/i, '');
      return;
    }
  }
  photo.classList.remove('show');
  const scene = pickScene(seed, s.style);
  document.body.style.background = scene.palette.sky[1];
  const canvas = $('bg-canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const scale = Math.min(1, 2560 / (innerWidth * dpr));
  canvas.width = Math.max(320, Math.round(innerWidth * dpr * scale));
  canvas.height = Math.max(240, Math.round(innerHeight * dpr * scale));
  const info = drawScene(canvas, scene);
  $('bg-name').textContent = info.name[0].toUpperCase() + info.name.slice(1);
}

async function shuffleBackground() {
  const today = ymd(new Date());
  await store.update('bgShuffle', (s) => ({ date: today, n: (s.date === today ? s.n : 0) + 1 }));
}

// ---------------------------------------------------------------- links

function normalizeUrl(raw) {
  let v = raw.trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.href;
  } catch { return null; }
}

function faviconFor(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.href;
}

let dragLink = null;
function renderLinks() {
  const nav = $('links');
  nav.hidden = !app.state.settings.show.links;
  const items = app.state.links.map((l) => {
    let host = '';
    try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const label = l.title || host;
    const img = h('img', { src: faviconFor(l.url), alt: '', width: 16, height: 16, loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(h('span.letter', (label[0] || '?').toUpperCase())));
    const a = h('a.link', { href: l.url, title: l.url, draggable: 'true', dataset: { id: l.id } }, img, label,
      h('button.link-edit', { type: 'button', 'aria-label': `Edit link ${label}`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); linkDialog(l); } }, icon('edit', 10)));
    a.addEventListener('dragstart', (e) => { dragLink = l.id; a.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    a.addEventListener('dragend', () => { dragLink = null; a.classList.remove('dragging'); for (const x of nav.querySelectorAll('.drop-before')) x.classList.remove('drop-before'); });
    a.addEventListener('dragover', (e) => { if (dragLink && dragLink !== l.id) { e.preventDefault(); a.classList.add('drop-before'); } });
    a.addEventListener('dragleave', () => a.classList.remove('drop-before'));
    a.addEventListener('drop', async (e) => {
      e.preventDefault();
      a.classList.remove('drop-before');
      const from = dragLink;
      if (!from || from === l.id) return;
      await store.update('links', (list) => {
        const moving = list.find((x) => x.id === from);
        const rest = list.filter((x) => x.id !== from);
        rest.splice(rest.findIndex((x) => x.id === l.id), 0, moving);
        return rest;
      });
    });
    return a;
  });
  nav.replaceChildren(...items, h('button.link.add-link', { type: 'button', onclick: () => linkDialog(null), 'aria-label': 'Add a quick link' }, icon('plus', 14), app.state.links.length ? '' : 'Add link'));
}

function linkDialog(link) {
  const dlg = $('link-dialog');
  $('ld-title').textContent = link ? 'Edit link' : 'Add link';
  $('ld-title-input').value = link ? link.title : '';
  $('ld-url').value = link ? link.url : '';
  $('ld-error').textContent = '';
  $('ld-delete').hidden = !link;
  $('ld-delete').onclick = async () => {
    dlg.close('cancel');
    const before = app.state.links;
    await store.update('links', (list) => list.filter((x) => x.id !== link.id));
    toast(`Removed ${link.title || 'link'}`, { label: 'Undo', run: () => store.set('links', before) });
  };
  const form = $('link-form');
  form.onsubmit = (e) => {
    if (e.submitter && e.submitter.value === 'save') {
      const url = normalizeUrl($('ld-url').value);
      if (!url) { e.preventDefault(); $('ld-error').textContent = 'Enter a web address such as example.com.'; return; }
    }
  };
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const url = normalizeUrl($('ld-url').value);
    if (!url) return;
    const title = $('ld-title-input').value.trim();
    await store.update('links', (list) => (link
      ? list.map((x) => (x.id === link.id ? { ...x, title, url } : x))
      : [...list, { id: store.uid('l'), title, url }]));
  };
  dlg.returnValue = '';
  dlg.showModal();
  $(link ? 'ld-title-input' : 'ld-url').focus();
}

// ---------------------------------------------------------------- search

const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
  ecosia: 'https://www.ecosia.org/search?q=',
};

function wireSearch() {
  $('search-icon').append(icon('search', 16));
  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('search-input').value.trim();
    if (!text) return;
    const looksLikeUrl = /^https?:\/\/\S+$/i.test(text) ||
      (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text));
    if (looksLikeUrl) {
      location.href = /^https?:/i.test(text) ? text : 'https://' + text;
      return;
    }
    const engine = app.state.settings.searchEngine;
    if ((engine === 'default' || !ENGINES[engine]) && chrome.search && chrome.search.query) {
      await chrome.search.query({ text, disposition: 'CURRENT_TAB' });
    } else {
      location.href = (ENGINES[engine] || ENGINES.duckduckgo) + encodeURIComponent(text);
    }
  });
}

// ---------------------------------------------------------------- widgets

function defaultRect(id, index) {
  const size = DEFAULT_SIZE[id];
  const margin = 16;
  const top = 72;
  // Stack down the right edge, then start a new column to the left; pomodoro and clocks prefer the left.
  const right = ['tasks', 'notes', 'calendar'].includes(id);
  const col = Math.floor(index / 2);
  const row = index % 2;
  const x = right ? innerWidth - size.w - margin - col * (size.w + margin) : margin + col * (size.w + margin);
  const y = top + row * (Math.min(size.h, (innerHeight - top - 80) / 2) + margin);
  return clampRect({ x, y, ...size });
}

function syncWidgets() {
  const s = app.state.settings;
  const layer = $('widgets');
  const wanted = store.WIDGETS.filter((w) => s.widgets[w.id]).map((w) => w.id);
  for (const [id, w] of app.widgets) {
    if (!wanted.includes(id)) {
      if (w.api.destroy) w.api.destroy();
      w.frame.el.remove();
      app.widgets.delete(id);
    }
  }
  let rightIdx = 0, leftIdx = 0;
  for (const id of wanted) {
    const right = ['tasks', 'notes', 'calendar'].includes(id);
    const idx = right ? rightIdx++ : leftIdx++;
    if (app.widgets.has(id)) continue;
    const def = store.WIDGETS.find((w) => w.id === id);
    const saved = app.state.layout[id];
    const frame = createFrame({
      id, title: def.name,
      rect: saved && saved.w ? saved : defaultRect(id, idx),
      onChange: (rect) => store.update('layout', (l) => ({ ...l, [id]: rect })),
      onClose: () => store.update('settings', (st) => ({ ...st, widgets: { ...st.widgets, [id]: false } })),
    });
    layer.append(frame.el);
    const api = WIDGET_MODULES[id].mount(frame, app);
    app.widgets.set(id, { frame, api });
  }
}

function renderWidgetsMenu() {
  const menu = $('widgets-menu');
  const s = app.state.settings;
  const items = store.WIDGETS.map((w) => h('label', { role: 'menuitemcheckbox', 'aria-checked': String(!!s.widgets[w.id]) },
    h('input', { type: 'checkbox', checked: !!s.widgets[w.id], onchange: (e) => store.update('settings', (st) => ({ ...st, widgets: { ...st.widgets, [w.id]: e.target.checked } })) }),
    w.name));
  const shows = [['clock', 'Clock'], ['greeting', 'Greeting'], ['focus', 'Daily focus'], ['quote', 'Daily line'], ['links', 'Quick links'], ['search', 'Search box']]
    .map(([k, name]) => h('label', { role: 'menuitemcheckbox', 'aria-checked': String(!!s.show[k]) },
      h('input', { type: 'checkbox', checked: !!s.show[k], onchange: (e) => store.update('settings', (st) => ({ ...st, show: { ...st.show, [k]: e.target.checked } })) }),
      name));
  menu.replaceChildren(h('div.small.muted', { style: { padding: '4px 8px' } }, 'Widgets'), ...items, h('hr'), h('div.small.muted', { style: { padding: '4px 8px' } }, 'Dashboard'), ...shows, h('hr'),
    h('button.btn.small', { type: 'button', onclick: resetLayout }, 'Reset widget layout'));
}

async function resetLayout() {
  await store.set('layout', {});
  for (const [, w] of app.widgets) { if (w.api.destroy) w.api.destroy(); w.frame.el.remove(); }
  app.widgets.clear();
  syncWidgets();
}

function wireMenu() {
  const btn = $('widgets-btn');
  const menu = $('widgets-menu');
  btn.append(icon('grid', 16));
  btn.setAttribute('aria-label', 'Choose widgets');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('input')?.focus();
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
}

// ---------------------------------------------------------------- state

function renderAll() {
  const s = app.state.settings;
  applyTheme(s.theme);
  $('clock').hidden = !s.show.clock;
  $('search-form').hidden = !s.show.search;
  $('clock').dataset.key = '';
  renderClock();
  renderGreeting();
  renderFocus();
  renderQuote();
  renderLinks();
  renderWidgetsMenu();
  syncWidgets();
}

function onNewDay() {
  quoteOffset = 0;
  renderFocus();
  renderQuote();
  renderBackground();
}

async function init() {
  await store.ensureDefaults();
  app.state = await store.getMany(store.KEYS);
  app.day = ymd(new Date());
  wireSearch();
  wireMenu();
  $('settings-btn').append(icon('gear', 16));
  $('shuffle-btn').append(icon('shuffle', 16));
  $('quote-next').append(icon('shuffle', 14));
  $('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('tasks-btn').addEventListener('click', () => openPage('tasks/tasks.html#today', { newTab: false }));
  $('shuffle-btn').addEventListener('click', shuffleBackground);
  $('quote-next').addEventListener('click', () => { quoteOffset++; renderQuote(); });
  renderBackground();
  await loadQuotes();
  renderAll();
  setInterval(renderClock, 1000);

  store.watch(store.KEYS, (vals) => {
    Object.assign(app.state, vals);
    const keys = Object.keys(vals);
    if (keys.includes('settings')) {
      renderAll();
      const prev = JSON.stringify(app.lastBg);
      app.lastBg = app.state.settings.background;
      if (prev !== JSON.stringify(app.lastBg)) renderBackground();
    }
    if (keys.includes('bgShuffle')) renderBackground();
    if (keys.includes('focus')) renderFocus();
    if (keys.includes('links')) renderLinks();
    if (keys.includes('layout') && Object.keys(app.state.layout).length) {
      for (const [id, w] of app.widgets) if (app.state.layout[id]) w.frame.setRect(app.state.layout[id]);
    }
    for (const [, w] of app.widgets) if (w.api.keys.some((k) => keys.includes(k))) w.api.update();
  });
  app.lastBg = app.state.settings.background;

  // Photos are added from the settings page; it pings us so the background can refresh.
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'background:changed') renderBackground(); });

  window.addEventListener('resize', debounce(() => {
    renderBackground();
    for (const [, w] of app.widgets) w.frame.reclamp();
  }, 200));

  document.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === '/' && app.state.settings.show.search) { e.preventDefault(); $('search-input').focus(); }
    else if (e.key === 'f') { const i = $('focus').querySelector('input'); if (i) { e.preventDefault(); i.focus(); } }
    else if (e.key === 'n' && app.widgets.has('tasks')) { e.preventDefault(); app.widgets.get('tasks').api.focusInput(); }
    else if (e.key === 'b') shuffleBackground();
  });
}

init();
