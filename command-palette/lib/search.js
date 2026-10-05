// Combines all sources into one ranked result list.
// Ranking = fuzzy match score x source weight + frecency boost + learned query boost.

import { scoreFields, tokenize } from './fuzzy.js';
import * as frecency from './frecency.js';
import { getTabs, getClosed, getBookmarks, getHistory } from './sources.js';
import { availableActions, actionTitle, LISTS } from './actions.js';
import { prettyUrl, urlKey, looksLikeUrl, normalizeUrl, timeAgo, hostOf } from './util.js';
import { fillTemplate, templateHasQuery } from './settings.js';

const PREFIXES = { '/': 'actions', '>': 'tabs', '#': 'bookmarks', '@': 'history' };
export const MODE_LABELS = { actions: 'Actions', tabs: 'Tabs', bookmarks: 'Bookmarks', history: 'History' };

const WEIGHT = { tab: 1.15, action: 1.1, quicklink: 1.12, command: 1.0, bookmark: 1.0, history: 0.85, closed: 0.8 };
const PALETTE_PAGE = chrome.runtime.getURL('ui/palette.html');

function fav(url) {
  if (!url || !/^(https?|file):/i.test(url)) return null;
  return chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=32';
}

/** Parse the raw input into mode, query and an optional keyword command. */
export function parseQuery(raw, commands, quicklinks) {
  let mode = null;
  let q = raw.replace(/^\s+/, '');
  if (q && PREFIXES[q[0]]) { mode = PREFIXES[q[0]]; q = q.slice(1).replace(/^\s+/, ''); }
  let keyword = null;
  if (!mode) {
    const m = /^(\S+)\s+([\s\S]*)$/.exec(q);
    if (m) {
      const kw = m[1].toLowerCase();
      const cmd = commands.find(c => c.keyword && c.keyword.toLowerCase() === kw && templateHasQuery(c.url));
      if (cmd) keyword = { cmd, arg: m[2].trim() };
    }
    if (!keyword) {
      const kw = q.trim().toLowerCase();
      const ql = quicklinks.find(l => l.keyword && l.keyword.toLowerCase() === kw);
      if (ql) keyword = { link: ql };
    }
  }
  return { mode, q: q.trim(), keyword };
}

function commandItem(cmd, arg, score, extra) {
  const needsArg = templateHasQuery(cmd.url);
  const title = needsArg
    ? (arg ? `Search ${cmd.name} for “${arg}”` : `Search ${cmd.name}…`)
    : cmd.name;
  return Object.assign({
    id: 'cmd:' + cmd.id + (arg ? ':' + arg : ''),
    kind: 'command',
    title,
    sub: cmd.keyword ? `${cmd.keyword} ⎵ ${prettyUrl(cmd.url).replace(/\?.*$/, '')}` : prettyUrl(cmd.url),
    icon: { fav: fav(cmd.url.replace(/\{query\}|\{raw\}|%s/g, '')), glyph: 'search' },
    badge: 'Search',
    key: 'c:' + cmd.id,
    ref: needsArg && !arg ? { setQuery: (cmd.keyword || cmd.name.toLowerCase()) + ' ' } : { url: fillTemplate(cmd.url, arg || '') },
    score,
  }, extra || {});
}

function tabItem(t, ctx, multiWin, winIndex, hl, score) {
  const meta = [];
  if (t.pinned) meta.push('Pinned');
  if (t.audible) meta.push(t.mutedInfo && t.mutedInfo.muted ? 'Muted' : 'Playing');
  if (multiWin) meta.push('Window ' + winIndex.get(t.windowId));
  const current = ctx.tab && t.id === ctx.tab.id;
  return {
    id: 'tab:' + t.id,
    kind: 'tab',
    title: t.title || prettyUrl(t.url),
    sub: prettyUrl(t.url || t.pendingUrl),
    hl,
    icon: { fav: fav(t.url), glyph: 'tab' },
    badge: current ? 'Current' : 'Tab',
    meta: meta.join(' · '),
    key: 'u:' + urlKey(t.url),
    ref: { tabId: t.id, windowId: t.windowId },
    closable: true,
    score,
  };
}

/** Main entry: returns { items, mode, modeLabel, keyword, list } */
export async function search(raw, ctx, cfg, listId) {
  const { settings, customCommands, quicklinks } = cfg;
  const fre = await frecency.snapshot();
  const limit = settings.maxResults || 50;

  if (listId) return searchList(listId, raw, ctx);

  const { mode, q, keyword } = parseQuery(raw, customCommands, quicklinks);
  const tokens = tokenize(q);
  const out = [];
  const src = settings.sources;
  const want = kind => (mode ? mode === kind : src[kind] !== false);

  // Keyword command ("yt cats") goes first.
  if (keyword && keyword.cmd) {
    out.push(commandItem(keyword.cmd, keyword.arg, 1e6, { badge: 'Command' }));
    if (!keyword.arg) return finish(out, mode, keyword);
  } else if (keyword && keyword.link) {
    const l = keyword.link;
    out.push({ id: 'ql:' + l.id, kind: 'quicklink', title: l.name, sub: prettyUrl(l.url), icon: { fav: fav(l.url), glyph: 'link' }, badge: 'Quicklink', key: 'q:' + l.id, ref: { url: l.url }, score: 1e6 });
  }

  // Direct URL.
  if (!mode && looksLikeUrl(q)) {
    const url = normalizeUrl(q);
    out.push({ id: 'url:' + url, kind: 'url', title: `Open ${prettyUrl(url)}`, sub: url, icon: { fav: fav(url), glyph: 'globe' }, badge: 'URL', key: 'u:' + urlKey(url), ref: { url }, score: 5e5 });
  }

  const add = (kind, item, fields, extraBoost) => {
    const m = scoreFields(tokens, fields);
    if (!m) return;
    let s = tokens.length ? m.score * WEIGHT[kind] : 0;
    s += fre.item(item.key) + fre.query(q, item.key) + (extraBoost || 0);
    item.hl = m.hl;
    item.score = s;
    out.push(item);
  };

  // ---- Tabs ----
  if (want('tabs')) {
    const tabs = (await getTabs()).filter(t => !(t.url || '').startsWith(PALETTE_PAGE));
    const winIds = [...new Set(tabs.map(t => t.windowId))];
    const winIndex = new Map(winIds.sort((a, b) => a - b).map((id, i) => [id, i + 1]));
    const multi = winIds.length > 1;
    tabs.forEach((t, i) => {
      const item = tabItem(t, ctx, multi, winIndex, null, 0);
      // MRU position as a tie-breaker; the current tab sinks a little.
      const mruBoost = Math.max(0, 10 - i * 0.5) + (item.badge === 'Current' ? -15 : 0);
      if (!tokens.length) {
        if (mode !== 'tabs' && (item.badge === 'Current' || i > 14)) return;
        item.score = 1000 - i;
        item.section = 'Open Tabs';
        out.push(item);
        return;
      }
      add('tab', item, [
        { text: item.title, weight: 1, key: 'title' },
        { text: item.sub, weight: 0.75, key: 'sub' },
      ], mruBoost);
    });
  }

  // ---- Recently closed (shown with tabs) ----
  if (mode === 'tabs' ? src.closed !== false : want('closed')) {
    const closed = await getClosed();
    closed.forEach((c, i) => {
      if (!tokens.length && (mode === 'tabs' ? false : i > 4)) return;
      const item = {
        id: 'closed:' + c.sessionId, kind: 'closed', title: c.title || prettyUrl(c.url), sub: prettyUrl(c.url),
        icon: { fav: fav(c.url), glyph: c.kind === 'window' ? 'window' : 'restore' },
        badge: c.kind === 'window' ? 'Closed window' : 'Closed', meta: timeAgo(c.time),
        key: 'u:' + urlKey(c.url), ref: { sessionId: c.sessionId },
      };
      if (!tokens.length) { item.score = 500 - i; item.section = 'Recently Closed'; out.push(item); return; }
      add('closed', item, [{ text: item.title, weight: 1, key: 'title' }, { text: item.sub, weight: 0.7, key: 'sub' }], Math.max(0, 6 - i));
    });
  }

  // ---- Actions ----
  if (want('actions')) {
    const actions = availableActions(ctx);
    if (!tokens.length) {
      if (mode === 'actions') {
        for (const a of actions) {
          const item = actionItem(a, ctx);
          item.score = fre.raw(item.key);
          out.push(item);
        }
        // Frecent first, then the defined order (stable sort).
      } else {
        const ranked = actions.map(a => [a, fre.raw('a:' + a.id)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [a, s] of ranked) {
          const item = actionItem(a, ctx);
          item.score = 2000 + s;
          item.section = 'Suggestions';
          out.push(item);
        }
      }
    } else {
      for (const a of actions) {
        const item = actionItem(a, ctx);
        add('action', item, [
          { text: item.title, weight: 1, key: 'title' },
          { text: a.keywords || '', weight: 0.6, key: null },
          { text: a.sub, weight: 0.5, key: null },
        ]);
      }
    }
  }

  // ---- Quicklinks and custom commands (searchable by name) ----
  if (!mode || mode === 'actions' || mode === 'bookmarks') {
    for (const l of quicklinks) {
      if (keyword && keyword.link && keyword.link.id === l.id) continue;
      const item = { id: 'ql:' + l.id, kind: 'quicklink', title: l.name, sub: prettyUrl(l.url), icon: { fav: fav(l.url), glyph: 'link' }, badge: 'Quicklink', meta: l.keyword || '', key: 'q:' + l.id, ref: { url: l.url } };
      if (!tokens.length) {
        if (mode) { item.score = fre.raw(item.key) + 1; out.push(item); }
        continue;
      }
      add('quicklink', item, [{ text: item.title, weight: 1, key: 'title' }, { text: item.sub, weight: 0.6, key: 'sub' }, { text: l.keyword || '', weight: 0.9, key: null }]);
    }
  }
  if (!mode || mode === 'actions') {
    for (const c of customCommands) {
      if (keyword && keyword.cmd && keyword.cmd.id === c.id) continue;
      const item = commandItem(c, '', 0);
      if (!tokens.length) {
        if (mode) { item.score = fre.raw(item.key); out.push(item); }
        continue;
      }
      add('command', item, [{ text: item.title, weight: 1, key: 'title' }, { text: c.keyword || '', weight: 1, key: null }]);
    }
  }

  // ---- Bookmarks ----
  if (want('bookmarks') && (tokens.length || mode === 'bookmarks')) {
    let bms = await getBookmarks();
    if (!tokens.length) bms = bms.slice().sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 100);
    for (const b of bms) {
      const item = { id: 'bm:' + b.id, kind: 'bookmark', title: b.title, sub: b.sub, icon: { fav: fav(b.url), glyph: 'star' }, badge: 'Bookmark', meta: b.folder, key: 'u:' + urlKey(b.url), ref: { url: b.url } };
      if (!tokens.length) { item.score = b.dateAdded / 1e13; out.push(item); continue; }
      add('bookmark', item, [
        { text: b.title, weight: 1, key: 'title' },
        { text: b.sub, weight: 0.7, key: 'sub' },
        { text: b.folder, weight: 0.35, key: null },
      ]);
    }
  }

  // ---- History ----
  if (want('history') && (tokens.length || mode === 'history')) {
    let hist = await getHistory(settings.historyMax, settings.historyDays);
    if (!tokens.length) hist = hist.slice(0, 100);
    const now = Date.now();
    for (const h of hist) {
      const item = { id: 'h:' + h.id, kind: 'history', title: h.title, sub: h.sub, icon: { fav: fav(h.url), glyph: 'clock' }, badge: 'History', meta: timeAgo(h.lastVisitTime), key: 'u:' + urlKey(h.url), ref: { url: h.url } };
      if (!tokens.length) { item.score = h.lastVisitTime / 1e13; out.push(item); continue; }
      const days = (now - h.lastVisitTime) / 86400000;
      const boost = Math.min(10, Math.log2(1 + h.typedCount * 4 + h.visitCount)) + Math.max(0, 6 - days);
      add('history', item, [{ text: h.title, weight: 1, key: 'title' }, { text: h.sub, weight: 0.8, key: 'sub' }], boost);
    }
  }

  // Rank, de-duplicate by URL (tab > quicklink > bookmark > history > closed) and cap.
  out.sort((a, b) => b.score - a.score);
  const seen = new Map();
  const rankKind = { tab: 0, url: 1, quicklink: 1, bookmark: 2, history: 3 };
  const deduped = [];
  for (const it of out) {
    if (!(it.kind in rankKind) || !it.key) { deduped.push(it); continue; }
    const prev = seen.get(it.key);
    if (prev === undefined) { seen.set(it.key, deduped.length); deduped.push(it); continue; }
    if (it.kind === 'tab') { deduped.push(it); continue; } // duplicate tabs are all real tabs
    const p = deduped[prev];
    if (rankKind[it.kind] < rankKind[p.kind]) { it.score = Math.max(it.score, p.score); deduped[prev] = it; }
  }
  let items = deduped.slice(0, mode ? Math.max(limit, 200) : limit);

  // Fallback web searches when typing free text.
  if (!mode && q && !(keyword && keyword.cmd)) {
    const fallbacks = customCommands.filter(c => c.fallback && templateHasQuery(c.url));
    for (const c of fallbacks) items.push(commandItem(c, q, -1, { fallback: true }));
    // The first fallback gets the section header; the rest just follow.
    let first = true;
    for (const it of items) if (it.fallback) { it.section = first ? 'Search the Web' : undefined; first = false; }
  }

  // Empty query and no prefix: sections in a fixed order.
  if (!mode && !q) {
    const order = { Suggestions: 0, 'Open Tabs': 1, 'Recently Closed': 2 };
    items.sort((a, b) => (order[a.section] - order[b.section]) || (b.score - a.score));
  }
  // Show each section header only once, on the first item of a run.
  let last = null;
  for (const it of items) { if (it.section === last || !it.section) { if (it.section) it.section = undefined; } else last = it.section; }

  return finish(items, mode, keyword);
}

function finish(items, mode, keyword) {
  for (const it of items) delete it.score;
  return {
    items,
    mode,
    modeLabel: mode ? MODE_LABELS[mode] : (keyword && keyword.cmd ? keyword.cmd.name : null),
    keywordActive: !!(keyword && keyword.cmd),
  };
}

function actionItem(a, ctx) {
  return {
    id: 'a:' + a.id,
    kind: 'action',
    title: actionTitle(a, ctx),
    sub: a.sub,
    icon: { glyph: a.icon || 'command' },
    badge: 'Action',
    key: 'a:' + a.id,
    ref: { action: a.id },
  };
}

async function searchList(listId, raw, ctx) {
  const provider = LISTS[listId];
  if (!provider) return { items: [], mode: null };
  const q = raw.trim();
  const tokens = tokenize(q);
  const rawItems = await provider(ctx, q);
  const items = [];
  rawItems.forEach((r, i) => {
    const item = {
      id: 'list:' + listId + ':' + i, kind: 'listItem', title: r.title, sub: r.sub || '',
      icon: { fav: r.fav ? fav(r.fav) : null, glyph: r.icon || 'command', color: r.color },
      key: null, ref: { list: listId, arg: r.arg },
    };
    if (r.always || !tokens.length) { item.score = -i; items.push(item); return; }
    const m = scoreFields(tokens, [{ text: r.title, weight: 1, key: 'title' }, { text: r.sub || '', weight: 0.5, key: 'sub' }]);
    if (!m) return;
    item.hl = m.hl; item.score = m.score + 1000; items.push(item);
  });
  items.sort((a, b) => b.score - a.score);
  for (const it of items) delete it.score;
  return { items, mode: null, list: listId };
}

export { hostOf };
