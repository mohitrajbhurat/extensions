import { send, h, categoryInfo, categoryColor, formatNumber, toast } from '../shared/ui.js';
import { CATEGORY_IDS, ownerOf } from '../lib/trackers.js';
import { dayKey } from '../lib/store.js';
import { isFlagged } from '../lib/learning.js';

let data = null;
const CHART_CATS = [...CATEGORY_IDS, 'learned', 'custom'];

function lastDays(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    out.push(dayKey(d.getTime()));
  }
  return out;
}

function sumDays(keys) {
  const t = { blocked: 0, params: 0, banners: 0, pages: 0, seen: 0, byCategory: {} };
  for (const k of keys) {
    const d = data.stats.days[k];
    if (!d) continue;
    t.blocked += d.blocked || 0;
    t.params += d.params || 0;
    t.banners += d.banners || 0;
    t.pages += d.pages || 0;
    t.seen += d.seen || 0;
    for (const [c, n] of Object.entries(d.byCategory || {})) t.byCategory[c] = (t.byCategory[c] || 0) + n;
  }
  return t;
}

function renderTiles(totals, rangeLabel) {
  const flagged = Object.values(data.learned).filter((e) => isFlagged(e, data.settings.learnThreshold)).length;
  const tile = (num, lbl, sub) => h('div', { class: 'tile' }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl), sub ? h('div', { class: 'sub' }, sub) : null);
  document.getElementById('tiles').replaceChildren(
    tile(formatNumber(totals.blocked), 'Tracker requests blocked', rangeLabel),
    tile(formatNumber(totals.params), 'Tracking parameters stripped', rangeLabel),
    tile(formatNumber(totals.banners), 'Cookie banners handled', rangeLabel),
    tile(formatNumber(totals.pages), 'Pages protected', rangeLabel),
    tile(formatNumber(Object.keys(data.sites).length), 'Sites graded', 'all time'),
    tile(formatNumber(flagged), 'Learned trackers', data.settings.autoBlockLearned ? 'blocked automatically' : 'review below'),
  );
}

function renderChart(keys) {
  const W = 800;
  const H = 220;
  const pad = { l: 40, r: 8, t: 8, b: 24 };
  const series = keys.map((k) => ({ key: k, d: data.stats.days[k] || { blocked: 0, byCategory: {} } }));
  const max = Math.max(1, ...series.map((s) => s.d.blocked || 0));
  const niceMax = niceCeil(max);
  const bw = (W - pad.l - pad.r) / series.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  const total = series.reduce((n, s) => n + (s.d.blocked || 0), 0);
  svg.setAttribute('aria-label', `Blocked requests per day, ${formatNumber(total)} in total over ${series.length} days, peak ${formatNumber(max)}.`);
  const el = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (H - pad.t - pad.b) * (1 - i / 4);
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'axis', 'stroke-dasharray': i ? '2 4' : '' }));
    const t = el('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end' });
    t.textContent = formatNumber(Math.round((niceMax * i) / 4));
    svg.append(t);
  }
  const plotH = H - pad.t - pad.b;
  series.forEach((s, i) => {
    let y = H - pad.b;
    const x = pad.l + i * bw + bw * 0.15;
    const w = Math.max(1, bw * 0.7);
    const parts = CHART_CATS.map((c) => [c, s.d.byCategory?.[c] || 0]).filter(([, n]) => n > 0);
    for (const [c, n] of parts) {
      const hgt = (n / niceMax) * plotH;
      y -= hgt;
      const r = el('rect', { x, y, width: w, height: Math.max(0, hgt), class: 'bar', fill: cssVar(`--cat-${c}`) });
      const title = el('title', {});
      title.textContent = `${s.key}: ${formatNumber(n)} ${categoryInfo(c).label}`;
      r.append(title);
      svg.append(r);
    }
    const every = Math.ceil(series.length / 8);
    if (i % every === 0 || i === series.length - 1) {
      const t = el('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = s.key.slice(5);
      svg.append(t);
    }
  });
  document.getElementById('chart').replaceChildren(svg);
  document.getElementById('legend').replaceChildren(...CHART_CATS.filter((c) => series.some((s) => s.d.byCategory?.[c])).map((c) =>
    h('span', {}, h('span', { class: 'dot', style: { background: categoryColor(c) } }), categoryInfo(c).label)));
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function niceCeil(n) {
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return Math.max(4, m * p);
  return n;
}

function renderCategories(totals) {
  const entries = CHART_CATS.map((c) => [c, totals.byCategory[c] || 0]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  document.getElementById('categories').replaceChildren(...entries.map(([c, n]) =>
    h('div', { class: 'bar-row' },
      h('span', { class: 'cat' }, categoryInfo(c).label),
      h('div', { class: 'bar-track', role: 'presentation' }, h('div', { class: 'bar-fill', style: { width: `${(n / max) * 100}%`, background: categoryColor(c) } })),
      h('span', { class: 'val' }, formatNumber(n)))));
}

function renderTopTrackers() {
  const rows = Object.entries(data.stats.domains || {}).sort((a, b) => b[1].blocked - a[1].blocked).slice(0, 15);
  const table = document.getElementById('top-trackers');
  table.replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Domain'), h('th', {}, 'Category'), h('th', { class: 'num' }, 'Sites'), h('th', { class: 'num' }, 'Blocked'))),
    h('tbody', {}, rows.length ? rows.map(([d, r]) => h('tr', {},
      h('td', {}, d, ownerOf(d) ? h('div', { class: 'muted small' }, ownerOf(d)) : null),
      h('td', {}, h('span', { class: 'cat' }, h('span', { class: 'dot', style: { background: categoryColor(r.category) } }), categoryInfo(r.category).label)),
      h('td', { class: 'num' }, formatNumber((r.sites || []).length)),
      h('td', { class: 'num' }, formatNumber(r.blocked)))) : h('tr', { class: 'empty-row' }, h('td', { colspan: 4 }, 'Nothing blocked yet. Browse a few sites.'))));
}

function renderSites() {
  const q = document.getElementById('site-filter').value.trim().toLowerCase();
  const rows = Object.entries(data.sites)
    .filter(([s]) => !q || s.includes(q))
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, 200);
  const allow = new Set(data.allowlist);
  document.getElementById('sites').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Grade'), h('th', {}, 'Site'), h('th', { class: 'num' }, 'Trackers'), h('th', { class: 'num' }, 'Blocked'), h('th', { class: 'num' }, 'Visits'), h('th', {}, 'Last visit'), h('th', {}, ''))),
    h('tbody', {}, rows.length ? rows.map(([site, r]) => {
      const grade = r.grade || 'A';
      const off = allow.has(site);
      return h('tr', {},
        h('td', {}, h('span', { class: `grade small grade-${grade}`, 'aria-label': `Grade ${grade}` }, grade)),
        h('td', {}, site, off ? h('span', { class: 'pill allowed', style: { marginLeft: '8px' } }, 'protection off') : null),
        h('td', { class: 'num', title: Object.keys(r.trackers || {}).join(', ') }, formatNumber(Object.keys(r.trackers || {}).length)),
        h('td', { class: 'num' }, formatNumber(r.blocked || 0)),
        h('td', { class: 'num' }, formatNumber(r.visits || 0)),
        h('td', { class: 'muted small' }, new Date(r.last).toLocaleString()),
        h('td', {}, h('div', { class: 'btn-row' }, h('button', {
          class: 'small',
          onclick: () => setAllow(site, !off),
        }, off ? 'Turn protection on' : 'Turn protection off'))));
    }) : h('tr', { class: 'empty-row' }, h('td', { colspan: 7 }, q ? 'No matching sites.' : 'No sites yet.'))));
}

function renderLearned() {
  const t = data.settings.learnThreshold;
  const rows = Object.entries(data.learned)
    .filter(([, e]) => e.sites.length >= Math.min(2, t) || e.blocked === true)
    .sort((a, b) => b[1].sites.length - a[1].sites.length || b[1].last - a[1].last)
    .slice(0, 200);
  document.getElementById('learned-note').textContent = data.settings.learning
    ? `Flagged after ${t} sites · ${data.settings.autoBlockLearned ? 'auto-block on' : 'auto-block off'}`
    : 'Learning is off';
  document.getElementById('learned').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Domain'), h('th', { class: 'num' }, 'Sites'), h('th', {}, 'Seen on'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, rows.length ? rows.map(([domain, e]) => {
      const flagged = isFlagged(e, t);
      const blocked = flagged && (e.blocked === true || (data.settings.autoBlockLearned && e.blocked !== false));
      let status;
      if (e.ignored) status = h('span', { class: 'pill' }, 'Ignored');
      else if (blocked) status = h('span', { class: 'pill blocked' }, 'Blocked');
      else if (flagged) status = h('span', { class: 'pill danger' }, 'Flagged');
      else status = h('span', { class: 'pill' }, 'Watching');
      const btn = (label, action, title) => h('button', { class: 'small', title, onclick: () => learnedAction(domain, action) }, label);
      const actions = [];
      if (e.ignored) actions.push(btn('Watch again', 'unignore', 'Resume learning about this domain'));
      else {
        actions.push(blocked ? btn('Unblock', 'unblock', 'Allow this domain') : btn('Block', 'block', 'Block this domain on other sites'));
        actions.push(btn('Ignore', 'ignore', 'Never flag this domain'));
      }
      actions.push(btn('Forget', 'forget', 'Remove what was learned about this domain'));
      return h('tr', {},
        h('td', {}, domain),
        h('td', { class: 'num' }, e.sites.length),
        h('td', {}, h('div', { class: 'sites-list', title: e.sites.join(', ') }, e.sites.join(', '))),
        h('td', {}, status),
        h('td', {}, h('div', { class: 'btn-row' }, actions)));
    }) : h('tr', { class: 'empty-row' }, h('td', { colspan: 5 }, 'Nothing learned yet.'))));
}

async function learnedAction(domain, action) {
  try {
    await send('learned:set', { domain, action });
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function setAllow(site, off) {
  const list = off ? [...data.allowlist, site] : data.allowlist.filter((s) => s !== site);
  try {
    await send('lists:update', { key: 'allowlist', list });
    toast(off ? `Protection off on ${site}` : `Protection on for ${site}`);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

function render() {
  const n = Number(document.getElementById('range').value);
  const keys = lastDays(n);
  const totals = sumDays(keys);
  const label = document.getElementById('range').selectedOptions[0].textContent.toLowerCase();
  document.getElementById('since').textContent = `Protecting you since ${new Date(data.stats.since).toLocaleDateString()}`;
  renderTiles(totals, label);
  renderChart(keys);
  renderCategories(totals);
  renderTopTrackers();
  renderSites();
  renderLearned();
}

async function refresh() {
  try {
    data = await send('dashboard:data');
    render();
  } catch (e) {
    toast(`Could not load data: ${e.message}`);
  }
}

document.getElementById('range').addEventListener('change', render);
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('site-filter').addEventListener('input', renderSites);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.stats || changes.learned || changes.sites)) {
    clearTimeout(refresh.t);
    refresh.t = setTimeout(refresh, 1500);
  }
});

refresh();
