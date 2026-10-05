// Accessibility Auditor - results UI shared by the popup and the side panel.
import {
  IMPACTS, getSettings, saveSettings, loadResults, onResultsChanged, scanTab, friendlyError,
  pageCall, ensureOverlay, activeTab, updateBadge,
} from './scan.js';
import { toJSON, toCSV, toHTML, fileName, download } from './export.js';

const MODE = document.body.classList.contains('panel') ? 'panel' : 'popup';
const IMPACT_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
const VISION_LABEL = {
  none: 'Normal vision', protanopia: 'Protanopia (no red cones)', deuteranopia: 'Deuteranopia (no green cones)',
  tritanopia: 'Tritanopia (no blue cones)', achromatopsia: 'Achromatopsia (no colour)', blurred: 'Blurred vision',
};
const NODE_PAGE = 30;

const state = {
  tabId: null,
  report: null,
  settings: null,
  filterImpacts: new Set(),
  search: '',
  busy: false,
  overlays: { markers: false, tab: false, structure: false, vision: 'none' },
  tabOrder: null,
};

const $ = (sel, rootEl = document) => rootEl.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ------------------------------------------------------------------ shell
function shell() {
  const app = $('#app');
  app.className = 'app';
  app.innerHTML = `
    <header class="top">
      <div class="brand"><img src="../icons/icon32.png" alt="" width="20" height="20"><h1>Accessibility Auditor</h1></div>
      <div class="actions">
        <button type="button" class="btn" id="open-panel" hidden title="Open the results in the browser side panel">Side panel</button>
        <button type="button" class="btn primary" id="scan">Scan page</button>
      </div>
    </header>
    <p class="page-line" id="page-line"></p>
    <div class="status" id="status" role="status" aria-live="polite"></div>
    <div class="stale" id="stale" hidden>This page has reloaded or navigated since the scan. Scan again to refresh the results.</div>
    <section class="summary" id="summary" aria-label="Summary" hidden>
      <ul class="chips" id="chips"></ul>
      <p class="meta" id="meta"></p>
    </section>
    <div role="tablist" aria-label="Views">
      <button role="tab" id="tab-issues" aria-controls="panel-issues" aria-selected="true">Issues</button>
      <button role="tab" id="tab-structure" aria-controls="panel-structure" aria-selected="false" tabindex="-1">Structure</button>
      <button role="tab" id="tab-tools" aria-controls="panel-tools" aria-selected="false" tabindex="-1">Tools</button>
    </div>
    <div role="tabpanel" id="panel-issues" aria-labelledby="tab-issues" tabindex="0">
      <div class="toolbar">
        <label class="visually-hidden" for="search">Filter issues</label>
        <input type="search" id="search" placeholder="Filter issues  ( / )" autocomplete="off">
        <label class="visually-hidden" for="group-by">Group by</label>
        <select id="group-by">
          <option value="impact">By severity</option>
          <option value="rule">By rule</option>
        </select>
      </div>
      <div class="toolbar exports" role="group" aria-label="Export report">
        <span class="label">Export:</span>
        <button type="button" class="btn small" data-export="html">HTML</button>
        <button type="button" class="btn small" data-export="json">JSON</button>
        <button type="button" class="btn small" data-export="csv">CSV</button>
      </div>
      <div id="issues"></div>
    </div>
    <div role="tabpanel" id="panel-structure" aria-labelledby="tab-structure" tabindex="0" hidden>
      <div id="structure"></div>
    </div>
    <div role="tabpanel" id="panel-tools" aria-labelledby="tab-tools" tabindex="0" hidden>
      <div class="tools" id="tools"></div>
    </div>`;
}

function setStatus(text, isError) {
  const s = $('#status');
  s.className = 'status' + (isError ? ' error' : '');
  s.textContent = '';
  if (text) s.append(h('div', { class: 'msg' }, text));
}

// ------------------------------------------------------------------ tabs
function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
    try {
      localStorage.setItem('a11y-tab', tab.id);
    } catch (e) { /* ignore */ }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j != null) {
        e.preventDefault();
        select(tabs[j], true);
      }
    });
  });
  let saved = null;
  try {
    saved = localStorage.getItem('a11y-tab');
  } catch (e) { /* ignore */ }
  const t = saved && document.getElementById(saved);
  if (t) select(t);
}

// ------------------------------------------------------------------ summary
function renderSummary() {
  const r = state.report;
  const sum = $('#summary');
  $('#stale').hidden = !(r && r.stale);
  if (!r) {
    sum.hidden = true;
    return;
  }
  sum.hidden = false;
  const chips = $('#chips');
  chips.textContent = '';
  const keys = IMPACTS.concat(state.settings.showReview ? ['review'] : []);
  for (const k of keys) {
    const n = r.counts[k] || 0;
    const pressed = state.filterImpacts.has(k);
    chips.append(h('li', null, h('button', {
      type: 'button', class: 'chip ' + k, 'aria-pressed': String(pressed),
      title: `Show only ${k === 'review' ? 'items that need review' : IMPACT_LABEL[k].toLowerCase() + ' issues'}`,
      onclick: () => {
        if (state.filterImpacts.has(k)) state.filterImpacts.delete(k);
        else state.filterImpacts.add(k);
        renderSummary();
        renderIssues();
      },
    }, h('span', { class: 'n' }, n), ' ', h('span', { class: 'lbl' }, k === 'review' ? 'Needs review' : IMPACT_LABEL[k]))));
  }
  const when = new Date(r.scannedAt);
  const frames = r.frames.filter((f) => !f.error).length;
  $('#meta').textContent = `${r.counts.violations} violation${r.counts.violations === 1 ? '' : 's'} · ${r.passed.length} rules passed · ${frames} frame${frames === 1 ? '' : 's'} · ${when.toLocaleTimeString()} (${r.durationMs} ms)` +
    (r.allFrames ? '' : ' · some frames could not be scanned');
}

// ------------------------------------------------------------------ issues
function visibleIssues() {
  const r = state.report;
  if (!r) return [];
  const q = state.search.trim().toLowerCase();
  return r.issues.filter((i) => {
    if (i.kind === 'review' && !state.settings.showReview) return false;
    if (state.filterImpacts.size) {
      const key = i.kind === 'review' ? 'review' : i.impact;
      if (!state.filterImpacts.has(key)) return false;
    }
    if (q) {
      const rule = r.rules[i.rule] || {};
      const hay = `${i.rule} ${rule.title || ''} ${i.message} ${i.selector} ${(rule.wcag || []).map((w) => w.sc).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function emptyState() {
  const wrap = h('div', { class: 'empty' });
  if (state.busy) {
    wrap.append(h('strong', null, 'Scanning...'));
  } else if (!state.report) {
    wrap.append(h('strong', null, 'No results yet'), 'Press "Scan page" to audit the current tab against WCAG 2.2.');
  } else if (!state.report.issues.length) {
    wrap.append(h('strong', null, 'No issues found'), `All ${state.report.passed.length} automated rules passed. Automated checks catch only part of all problems, so test with a keyboard and a screen reader too.`);
  } else {
    wrap.append(h('strong', null, 'Nothing matches the filters'), 'Clear the search or severity filters to see all issues.');
  }
  return wrap;
}

function ruleDetails(ruleId, list) {
  const r = state.report.rules[ruleId] || { title: ruleId, wcag: [] };
  const reviewOnly = list.every((i) => i.kind === 'review');
  const impact = reviewOnly ? 'review' : list.find((i) => i.kind !== 'review').impact;
  const det = h('details', { class: 'rule', dataset: { rule: ruleId } });
  const summary = h('summary', null,
    h('span', { class: 'pill ' + impact }, reviewOnly ? 'review' : impact),
    h('span', { class: 'rule-title' }, r.title),
    h('span', { class: 'count', 'aria-label': `${list.length} item${list.length === 1 ? '' : 's'}` }, list.length));
  det.append(summary);
  let built = false;
  det.addEventListener('toggle', () => {
    if (!det.open || built) return;
    built = true;
    det.append(ruleBody(ruleId, r, list));
  });
  return det;
}

function ruleBody(ruleId, r, list) {
  const body = h('div', { class: 'rule-body' });
  body.append(h('p', null, r.description || ''));
  body.append(h('p', null, h('strong', null, 'How to fix: '), r.fix || ''));
  const meta = h('p', { class: 'rule-meta' }, h('code', null, ruleId), ' · ', r.level === 'best-practice' ? 'Best practice' : 'WCAG level ' + r.level);
  for (const w of r.wcag || []) {
    meta.append(' · ', h('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer' }, `${w.sc} ${w.name}`));
  }
  body.append(meta);
  const truncatedTotal = state.report.frames.reduce((n, f) => n + ((f.truncated && f.truncated[ruleId]) || 0), 0);
  if (truncatedTotal) body.append(h('p', { class: 'more' }, `Showing the first 250 per frame of ${truncatedTotal} occurrences.`));
  const ol = h('ol', { class: 'nodes' });
  body.append(ol);
  let shown = 0;
  const more = h('button', { type: 'button', class: 'btn small' });
  const addPage = () => {
    const next = list.slice(shown, shown + NODE_PAGE);
    next.forEach((i) => ol.append(nodeItem(i, r)));
    shown += next.length;
    more.textContent = `Show ${Math.min(NODE_PAGE, list.length - shown)} more (${list.length - shown} left)`;
    more.hidden = shown >= list.length;
  };
  more.addEventListener('click', addPage);
  addPage();
  body.append(more);
  return body;
}

function nodeItem(i, r) {
  const li = h('li');
  const msg = h('p', { class: 'node-msg' });
  if (i.kind === 'review') msg.append(h('span', { class: 'pill review' }, 'review'), ' ');
  msg.append(i.message);
  if (i.data && i.data.fg && i.data.bg) {
    msg.append(' ', h('span', { class: 'swatch', style: `background:${i.data.fg}`, title: 'Text ' + i.data.fg }),
      h('span', { class: 'swatch', style: `background:${i.data.bg}`, title: 'Background ' + i.data.bg }));
  }
  li.append(msg);
  li.append(h('p', { class: 'node-sel' }, i.selector + (i.frameId ? `  (frame: ${i.frameUrl})` : '') + (i.inShadow ? '  (in shadow DOM)' : '')));
  if (i.snippet) li.append(h('pre', { class: 'snippet' }, i.snippet));
  if (i.data && i.data.css) li.append(h('pre', { class: 'snippet' }, i.data.css));
  li.append(h('div', { class: 'node-actions' },
    h('button', { type: 'button', class: 'btn small', onclick: () => highlight(i.frameId, i.ref, r.title) }, 'Show on page'),
    h('button', {
      type: 'button', class: 'btn small',
      onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(i.selector);
          e.target.textContent = 'Copied';
          setTimeout(() => (e.target.textContent = 'Copy selector'), 1200);
        } catch (err) {
          setStatus('Could not copy to the clipboard.', true);
        }
      },
    }, 'Copy selector')));
  return li;
}

function sortRuleGroups(groups) {
  const rank = (list) => {
    const v = list.filter((i) => i.kind !== 'review');
    if (!v.length) return 10;
    return Math.min(...v.map((i) => IMPACTS.indexOf(i.impact)));
  };
  return Array.from(groups.entries()).sort((a, b) => rank(a[1]) - rank(b[1]) || b[1].length - a[1].length);
}

function renderIssues() {
  const box = $('#issues');
  const openRules = new Set(Array.from(box.querySelectorAll('details.rule[open]')).map((d) => d.dataset.rule + '|' + (d.dataset.group || '')));
  box.textContent = '';
  const list = visibleIssues();
  document.querySelectorAll('[data-export]').forEach((b) => (b.disabled = !state.report));
  if (!list.length) {
    box.append(emptyState());
    return;
  }
  const byRule = (items) => {
    const m = new Map();
    for (const i of items) {
      if (!m.has(i.rule)) m.set(i.rule, []);
      m.get(i.rule).push(i);
    }
    return m;
  };
  const restore = (det, group) => {
    det.dataset.group = group || '';
    if (openRules.has(det.dataset.rule + '|' + (group || ''))) det.open = true;
    return det;
  };
  if (state.settings.groupBy === 'rule') {
    for (const [id, items] of sortRuleGroups(byRule(list))) box.append(restore(ruleDetails(id, items), ''));
    return;
  }
  const buckets = IMPACTS.map((k) => [k, list.filter((i) => i.kind !== 'review' && i.impact === k)]);
  buckets.push(['review', list.filter((i) => i.kind === 'review')]);
  for (const [k, items] of buckets) {
    if (!items.length) continue;
    const title = k === 'review' ? 'Needs review' : IMPACT_LABEL[k];
    box.append(h('h2', { class: 'group-h' }, `${title} (${items.length})`));
    for (const [id, rs] of sortRuleGroups(byRule(items))) box.append(restore(ruleDetails(id, rs), k));
  }
}

// ------------------------------------------------------------------ structure
function outlineButton(frameId, ref, label, ...content) {
  return h('button', { type: 'button', class: 'out-btn', onclick: () => highlight(frameId, ref, label) }, ...content);
}

function renderStructure() {
  const box = $('#structure');
  box.textContent = '';
  const r = state.report;
  const headH = h('h2', { class: 'section-h' }, 'Headings');
  box.append(headH);
  if (!r) {
    box.append(h('p', { class: 'empty' }, 'Scan the page to see its heading and landmark outline.'));
  } else {
    const hs = r.outline.headings;
    if (!hs.length) box.append(h('p', { class: 'hint' }, 'No headings found.'));
    const ul = h('ul', { class: 'outline', 'aria-label': 'Heading outline' });
    for (const x of hs) {
      ul.append(h('li', { style: `padding-left:${(Math.min(x.level, 6) - 1) * 12}px` },
        outlineButton(x.frameId, x.ref, 'H' + x.level,
          h('span', { class: 'lvl' + (x.skipped ? ' bad' : '') }, 'H' + x.level),
          h('span', { class: 'out-text' }, x.text || '(empty heading)'),
          x.skipped ? h('span', { class: 'out-note' }, 'skipped level') : null,
          !x.visible ? h('span', { class: 'out-note' }, 'not visible') : null)));
    }
    box.append(ul);
    box.append(h('h2', { class: 'section-h' }, 'Landmarks'));
    const lms = r.outline.landmarks;
    if (!lms.length) box.append(h('p', { class: 'hint' }, 'No landmarks found. Use <header>, <nav>, <main>, <aside> and <footer>.'));
    const ul2 = h('ul', { class: 'outline', 'aria-label': 'Landmarks' });
    for (const x of lms) {
      ul2.append(h('li', { style: `padding-left:${x.depth * 12}px` },
        outlineButton(x.frameId, x.ref, x.role,
          h('span', { class: 'lvl' }, x.role),
          h('span', { class: 'out-text' }, x.name || `<${x.tag}>`))));
    }
    box.append(ul2);
  }
  const tabH = h('h2', { class: 'section-h' }, 'Tab order',
    h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(state.overlays.tab), onclick: () => toggleTabOrder(!state.overlays.tab) }, 'Show on page'));
  box.append(tabH);
  if (!state.tabOrder) {
    box.append(h('p', { class: 'hint' }, 'Shows every keyboard stop in order, numbered on the page and connected by a line. Red numbers have a positive tabindex.'));
  } else {
    box.append(h('p', { class: 'hint' }, `${state.tabOrder.length} tab stops in the top document.`));
    const ol = h('ol', { class: 'taborder', 'aria-label': 'Tab order' });
    for (const t of state.tabOrder) {
      ol.append(h('li', null, outlineButton(0, t.ref, `#${t.n}`,
        h('span', { class: 'lvl' + (t.tabindex > 0 ? ' bad' : '') }, String(t.n)),
        h('span', { class: 'out-text' }, `${t.role}: ${t.name || t.selector}`),
        t.tabindex > 0 ? h('span', { class: 'out-note' }, `tabindex=${t.tabindex}`) : null)));
    }
    box.append(ol);
  }
}

// ------------------------------------------------------------------ tools
function toggleRow(id, label, desc, checked, onchange) {
  const input = h('input', { type: 'checkbox', class: 'toggle', id, role: 'switch', 'aria-describedby': id + '-desc' });
  input.checked = !!checked;
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('div', { class: 'switch-row' },
    h('label', { for: id }, label, h('span', { class: 'desc', id: id + '-desc' }, desc)), input);
}

async function renderTools() {
  const box = $('#tools');
  box.textContent = '';
  const ov = h('fieldset', null, h('legend', null, 'On-page overlays'));
  ov.append(toggleRow('t-markers', 'Issue markers', 'Badges on every element with an issue. Click a badge to outline it.', state.overlays.markers, (on) => toggleMarkers(on)));
  ov.append(toggleRow('t-tab', 'Tab order', 'Number each keyboard stop and connect them in order.', state.overlays.tab, (on) => toggleTabOrder(on)));
  ov.append(toggleRow('t-structure', 'Headings & landmarks', 'Label headings (H1-H6) and outline landmark regions.', state.overlays.structure, (on) => toggleStructure(on)));
  const sel = h('select', { id: 't-vision' });
  for (const [k, v] of Object.entries(VISION_LABEL)) sel.append(h('option', { value: k }, v));
  sel.value = state.overlays.vision;
  sel.addEventListener('change', () => setVision(sel.value));
  ov.append(h('div', { class: 'field' }, h('label', { for: 't-vision' }, 'Colour vision simulation'), sel,
    h('p', { class: 'hint' }, 'Applies an SVG colour filter to the whole page so you can check that colour is not the only way information is shown.')));
  ov.append(h('button', { type: 'button', class: 'btn', onclick: clearOverlays }, 'Remove all overlays'));
  box.append(ov);

  const s = state.settings;
  const rules = h('fieldset', null, h('legend', null, 'Rules'));
  rules.append(toggleRow('s-aaa', 'Include AAA rules', 'Enhanced contrast (7:1) and link purpose (link only).', s.includeAAA, async (on) => {
    state.settings = await saveSettings({ includeAAA: on });
    setStatus('Saved. Scan again to apply.');
  }));
  rules.append(toggleRow('s-bp', 'Include best practices', 'Heading order, landmarks, duplicate ids and other non-WCAG checks.', s.includeBestPractice, async (on) => {
    state.settings = await saveSettings({ includeBestPractice: on });
    setStatus('Saved. Scan again to apply.');
  }));
  rules.append(toggleRow('s-review', 'Show "needs review" items', 'Heuristic findings a person should confirm.', s.showReview, async (on) => {
    state.settings = await saveSettings({ showReview: on });
    renderSummary();
    renderIssues();
  }));
  rules.append(toggleRow('s-markers', 'Show markers after each scan', 'Turn on issue markers automatically.', s.autoMarkers, async (on) => {
    state.settings = await saveSettings({ autoMarkers: on });
  }));
  box.append(rules);

  const access = h('fieldset', null, h('legend', null, 'Site access'));
  let all = false;
  try {
    all = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch (e) { /* ignore */ }
  access.append(h('p', { class: 'hint' }, all
    ? 'Allowed on all sites: you can rescan from the side panel after navigating, and cross-origin frames are audited too.'
    : 'By default the auditor only reads a page after you click its toolbar button (activeTab). Allow all sites to rescan from the side panel after navigation and to audit cross-origin frames.'));
  access.append(h('button', {
    type: 'button', class: 'btn',
    onclick: async () => {
      try {
        if (all) await chrome.permissions.remove({ origins: ['<all_urls>'] });
        else await chrome.permissions.request({ origins: ['<all_urls>'] });
      } catch (e) {
        setStatus(friendlyError(e), true);
      }
      renderTools();
    },
  }, all ? 'Remove access to all sites' : 'Allow on all sites'));
  box.append(access);

  const keys = h('fieldset', null, h('legend', null, 'Keyboard'));
  keys.append(h('p', { class: 'hint' }, h('kbd', null, '/'), ' filter issues · ', h('kbd', null, 'Esc'), ' remove the highlight · arrow keys move between tabs.'));
  keys.append(h('p', { class: 'hint' }, 'Assign shortcuts to open the auditor or scan the current tab at chrome://extensions/shortcuts.'));
  box.append(keys);
}

// ------------------------------------------------------------------ page actions
async function call(frameIds, method, args, needsRefs) {
  let res = await pageCall(state.tabId, frameIds, method, args);
  if (res.some((r) => r.missing)) {
    if (needsRefs) throw new Error('The page has changed since the scan. Scan again.');
    await ensureOverlay(state.tabId, frameIds);
    res = await pageCall(state.tabId, frameIds, method, args);
  }
  const err = res.find((r) => r.error);
  if (err) throw new Error(err.error);
  return res;
}

async function highlight(frameId, ref, label) {
  try {
    const res = await call([frameId || 0], 'highlight', [ref, label], true);
    if (!res[0] || res[0].value === false) setStatus('That element is no longer on the page. Scan again.', true);
    else setStatus('');
  } catch (e) {
    setStatus(friendlyError(e), true);
  }
}

async function toggleMarkers(on) {
  try {
    if (!on) {
      if (state.report) await allFrames('clear', [['markers']]);
      else await pageCall(state.tabId, null, 'clear', [['markers']]).catch(() => {});
      state.overlays.markers = false;
      setStatus('Issue markers removed.');
    } else {
      if (!state.report) throw new Error('Scan the page first.');
      const byFrame = new Map();
      for (const i of visibleIssues()) {
        if (!byFrame.has(i.frameId)) byFrame.set(i.frameId, []);
        byFrame.get(i.frameId).push({ ref: i.ref, impact: i.impact, kind: i.kind, title: (state.report.rules[i.rule] || {}).title || i.rule });
      }
      let n = 0;
      for (const [frameId, items] of byFrame) {
        const res = await call([frameId], 'showMarkers', [items], true);
        n += res[0] && res[0].value ? res[0].value : 0;
      }
      state.overlays.markers = true;
      setStatus(`${n} element${n === 1 ? '' : 's'} marked on the page.`);
    }
  } catch (e) {
    state.overlays.markers = false;
    setStatus(friendlyError(e), true);
  }
  syncToggle('t-markers', state.overlays.markers);
}

async function allFrames(method, args) {
  if (!state.report) return;
  const ids = Array.from(new Set(state.report.frames.filter((f) => !f.error).map((f) => f.frameId)));
  try {
    await pageCall(state.tabId, ids, method, args);
  } catch (e) { /* frame gone */ }
}

async function toggleTabOrder(on) {
  try {
    if (on) {
      const res = await call([0], 'showTabOrder', []);
      state.tabOrder = res[0].value || [];
      setStatus(`${state.tabOrder.length} tab stops shown on the page.`);
    } else {
      await call([0], 'clear', [['tab']]);
      state.tabOrder = null;
    }
    state.overlays.tab = on;
  } catch (e) {
    state.overlays.tab = false;
    setStatus(friendlyError(e), true);
  }
  syncToggle('t-tab', state.overlays.tab);
  renderStructure();
}

async function toggleStructure(on) {
  try {
    if (on) {
      if (!state.report) throw new Error('Scan the page first.');
      const data = {
        headings: state.report.outline.headings.filter((x) => x.frameId === 0),
        landmarks: state.report.outline.landmarks.filter((x) => x.frameId === 0),
      };
      await call([0], 'showStructure', [data], true);
    } else {
      await call([0], 'clear', [['structure']]);
    }
    state.overlays.structure = on;
  } catch (e) {
    state.overlays.structure = false;
    setStatus(friendlyError(e), true);
  }
  syncToggle('t-structure', state.overlays.structure);
}

async function setVision(type) {
  try {
    const res = await call([0], 'setVision', [type]);
    state.overlays.vision = res[0].value || 'none';
    setStatus(type === 'none' ? 'Colour simulation off.' : `Simulating ${VISION_LABEL[type].toLowerCase()}.`);
  } catch (e) {
    state.overlays.vision = 'none';
    setStatus(friendlyError(e), true);
  }
  const sel = $('#t-vision');
  if (sel) sel.value = state.overlays.vision;
}

async function clearOverlays() {
  try {
    await call([0], 'clear', []);
  } catch (e) {
    setStatus(friendlyError(e), true);
  }
  await allFrames('clear', []);
  resetOverlayState();
  renderTools();
  renderStructure();
  setStatus('Overlays removed.');
}

function resetOverlayState() {
  state.overlays = { markers: false, tab: false, structure: false, vision: 'none' };
  state.tabOrder = null;
}

function syncToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = !!on;
}

// ------------------------------------------------------------------ scan
async function scan({ quiet } = {}) {
  if (state.busy || state.tabId == null) return;
  state.busy = true;
  const btn = $('#scan');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  setStatus('');
  if (!state.report) renderIssues();
  try {
    state.settings = await getSettings();
    // Old overlays point at references from the previous scan.
    await pageCall(state.tabId, null, 'clear', [['markers', 'structure', 'hl']]).catch(() => {});
    state.overlays.markers = false;
    state.overlays.structure = false;
    state.report = await scanTab(state.tabId, state.settings);
    setStatus(`Scan complete: ${state.report.counts.violations} violation${state.report.counts.violations === 1 ? '' : 's'}, ${state.report.counts.review} to review.`);
    if (state.settings.autoMarkers) await toggleMarkers(true);
  } catch (e) {
    if (!quiet) setStatus(friendlyError(e), true);
    else setStatus(friendlyError(e));
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = 'Scan page';
    renderAll();
  }
}

function renderAll() {
  const r = state.report;
  $('#page-line').textContent = r ? (r.title ? `${r.title} — ${r.url}` : r.url) : '';
  $('#page-line').title = r ? r.url : '';
  renderSummary();
  renderIssues();
  renderStructure();
  renderTools();
}

async function loadTab(tabId, { autoScan } = {}) {
  state.tabId = tabId;
  state.report = await loadResults(tabId);
  state.filterImpacts.clear();
  resetOverlayState();
  renderAll();
  if (autoScan && (!state.report || state.report.stale)) await scan({ quiet: true });
}

// ------------------------------------------------------------------ init
async function init() {
  shell();
  initTabs();
  state.settings = await getSettings();
  $('#group-by').value = state.settings.groupBy;
  $('#group-by').addEventListener('change', (e) => {
    state.settings.groupBy = e.target.value;
    renderIssues();
    saveSettings({ groupBy: e.target.value }).catch(() => {});
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderIssues();
  });
  $('#scan').addEventListener('click', () => scan());
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
    const r = state.report;
    if (!r) return;
    const kind = b.dataset.export;
    if (kind === 'json') download(fileName(r, 'json'), toJSON(r), 'application/json');
    else if (kind === 'csv') download(fileName(r, 'csv'), toCSV(r), 'text/csv;charset=utf-8');
    else download(fileName(r, 'html'), toHTML(r), 'text/html;charset=utf-8');
    setStatus(`Exported ${kind.toUpperCase()} report.`);
  }));
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.getElementById('tab-issues').click();
      $('#search').focus();
    } else if (e.key === 'Escape' && !typing && state.tabId != null) {
      pageCall(state.tabId, null, 'clear', [['hl']]).catch(() => {});
    }
  });

  const panelBtn = $('#open-panel');
  if (MODE === 'popup' && chrome.sidePanel && chrome.sidePanel.open) {
    panelBtn.hidden = false;
    panelBtn.addEventListener('click', async () => {
      try {
        await chrome.sidePanel.open({ tabId: state.tabId });
        window.close();
      } catch (e) {
        setStatus('The side panel is not available here: ' + friendlyError(e), true);
      }
    });
  }

  onResultsChanged((tabId, report) => {
    if (tabId !== state.tabId || state.busy) return;
    const was = state.report;
    state.report = report;
    if (!report || !was || report.scannedAt !== was.scannedAt) resetOverlayState();
    renderAll();
  });

  if (MODE === 'panel') {
    chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
      const win = await chrome.windows.getCurrent().catch(() => null);
      if (win && win.id !== windowId) return;
      setStatus('');
      loadTab(tabId);
    });
  }

  const tab = await activeTab();
  if (!tab) {
    setStatus('No active tab.', true);
    return;
  }
  await loadTab(tab.id, { autoScan: true });
  if (state.report) updateBadge(tab.id, state.report);
}

init().catch((e) => setStatus(friendlyError(e), true));
