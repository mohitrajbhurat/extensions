// Smart Autofill content controller. Injected on demand (all frames) by the service worker;
// exposes globalThis.__SmartAutofill for chrome.scripting.executeScript calls.
(function () {
  'use strict';
  if (globalThis.__SmartAutofill) return;
  const M = globalThis.__SA_matcher, Fi = globalThis.__SA_filler, UI = globalThis.__SA_ui;
  const { byKey } = globalThis.SmartAutofillFields;

  const state = {
    matches: [], profile: null, settings: null, previewing: false,
    undoStack: [], filled: new WeakMap(), learnBound: false, ctx: null,
  };
  let idSeq = 0;
  const host = location.hostname || location.protocol.replace(':', '');
  const DEFAULTS = { minConfidence: 0.5, learnMode: true, fillRepeatables: true, highlightAfterFill: true, overwrite: false };

  // ---------- page context for answer templates ----------
  function pretty(s) { return String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim(); }
  function pageContext() {
    const title = document.title || '';
    const h1 = document.querySelector('h1');
    let role = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
    if (role.length > 80) role = '';
    const og = document.querySelector('meta[property="og:site_name"]');
    let company = og ? og.content : '';
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|smartrecruiters\.com|jobvite\.com|recruitee\.com/.test(host) && seg) {
      if (!company || /greenhouse|lever|ashby|workable|jobvite|smartrecruiters|breezy|recruitee/i.test(company)) company = pretty(seg);
    }
    const m = title.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s+[|\-–—]\s|$)/i);
    if (m) { role = role || m[1].trim(); company = company || m[2].trim(); }
    if (!company) company = pretty(host.replace(/^(www|jobs|careers|apply|boards)\./, '').split('.')[0]);
    return { company, role };
  }

  // ---------- rules ----------
  async function getRules() {
    try {
      const { siteRules = {} } = await chrome.storage.local.get('siteRules');
      return siteRules[host] || {};
    } catch (e) { return {}; }
  }
  function saveRule(sig, rule, label) {
    try { chrome.runtime.sendMessage({ type: 'save-rule', host, sig, rule: { ...rule, label: label || '' } }); } catch (e) { /* extension reloaded */ }
  }
  function deleteRule(sig) {
    try { chrome.runtime.sendMessage({ type: 'delete-rule', host, sig }); } catch (e) { /* ignore */ }
  }

  // ---------- analysis ----------
  function scanEntries() {
    const entries = M.buildEntries(M.collectControls(document));
    const seen = new Map();
    for (const e of entries) {
      let sig = M.signature(e);
      const n = seen.get(sig) || 0;
      seen.set(sig, n + 1);
      if (n) sig += '#' + n;
      e.sig = sig;
    }
    return entries;
  }
  function isRepeatable(key) { return key.startsWith('work.') || key.startsWith('edu.'); }
  function labelFor(key, index) {
    if (key.startsWith('qa.')) {
      const q = (state.profile && state.profile.qa || []).find(x => 'qa.' + x.id === key);
      return q ? 'Answer: ' + q.question.slice(0, 40) : 'Custom answer';
    }
    const def = byKey[key];
    const base = def ? def.label : key;
    return isRepeatable(key) ? `${base} #${(index || 0) + 1}` : base;
  }
  function assignIndices(matches) {
    const bases = {};
    for (const m of matches) {
      if (!isRepeatable(m.key) || m.index != null) continue;
      m.explicit = M.explicitIndex(m.entry);
      if (m.explicit) {
        const g = m.key.split('.')[0] + ':' + m.explicit.from;
        bases[g] = Math.min(bases[g] == null ? Infinity : bases[g], m.explicit.n);
      }
    }
    const ordinal = {};
    for (const m of matches) {
      if (!isRepeatable(m.key)) { m.index = 0; continue; }
      if (m.index != null) continue;
      if (m.explicit) {
        const g = m.key.split('.')[0] + ':' + m.explicit.from;
        m.index = Math.max(0, m.explicit.n - bases[g]);
      } else {
        m.index = ordinal[m.key] || 0;
      }
      ordinal[m.key] = Math.max(ordinal[m.key] || 0, m.index + 1);
    }
  }
  function currentValueOf(entry) {
    const el = entry.el;
    switch (entry.kind) {
      case 'radio': case 'checkgroup': { const o = entry.options.find(o => o.el.checked); return o ? o.text : ''; }
      case 'checkbox': return el.checked ? 'checked' : '';
      case 'select': return el.selectedIndex > 0 || (el.selectedIndex === 0 && el.options[0] && el.options[0].value) ? el.options[el.selectedIndex].text : '';
      case 'file': return el.files && el.files.length ? el.files[0].name : '';
      case 'contenteditable': return el.textContent.trim();
      default: return el.value || '';
    }
  }

  async function analyze(profile, settings) {
    const entries = scanEntries();
    const rules = await getRules();
    state.ctx = pageContext();
    const ctx = state.ctx;
    // Expand {company}/{role} in stored questions so they compare against the page's wording.
    const qa = (profile.qa || []).filter(q => q && q.question && q.answer).map(q => ({
      ...q,
      question: q.question.replace(/\{\{?\s*company\s*\}?\}/gi, ctx.company || '').replace(/\{\{?\s*(role|position)\s*\}?\}/gi, ctx.role || ''),
    }));
    const matches = [];
    for (const entry of entries) {
      const rule = rules[entry.sig];
      let key, score, source, index = null, alternatives = [];
      if (rule && rule.key === '__skip') continue;
      if (rule && (byKey[rule.key] || rule.key.startsWith('qa.'))) {
        key = rule.key; score = 1; source = 'learned'; index = rule.index != null ? rule.index : null;
      } else {
        const c = M.classify(entry, qa);
        if (!c.best) continue;
        key = c.best.key; score = c.best.score; source = key.startsWith('qa.') ? 'qa' : 'auto';
        alternatives = c.alternatives;
      }
      if (score < 0.3) continue;
      matches.push({ id: ++idSeq, entry, key, score, source, index, alternatives });
    }
    assignIndices(matches);
    // When two different fields claim the same single-value key, keep the stronger as primary
    // but still allow both (forms often repeat email for confirmation).
    for (const m of matches) refreshValue(m, profile, settings);
    return matches;
  }
  function refreshValue(m, profile, settings) {
    m.raw = Fi.valueFor(profile, m.key, m.index, state.ctx);
    const def = byKey[m.key];
    m.hasValue = !Fi.isEmptyValue(m.raw) || (def && def.type === 'bool' && m.raw === false);
    m.current = currentValueOf(m.entry);
    m.label = labelFor(m.key, m.index);
    m.value = Fi.preview(m.raw, def);
    const min = settings.minConfidence;
    const prefilled = m.current && m.entry.kind !== 'checkbox' && !settings.overwrite;
    m.include = m.hasValue && m.score >= min && !prefilled;
    m.reason = !m.hasValue ? 'no value in profile' : prefilled ? 'already filled' : m.score < min ? 'low confidence' : '';
  }
  function toItem(m) {
    return {
      id: m.id, el: m.entry.el, rectEls: m.entry.els.length > 1 ? m.entry.els : null,
      key: m.key, label: m.label, score: m.score, value: m.value, include: m.include, source: m.source,
      reason: m.include ? '' : m.reason,
    };
  }
  function summarize(matches) {
    const inc = matches.filter(m => m.include);
    return {
      url: location.href, top: window === window.top, host,
      total: matches.length, ready: inc.length,
      high: inc.filter(m => m.score >= 0.8).length,
      medium: inc.filter(m => m.score >= 0.6 && m.score < 0.8).length,
      low: inc.filter(m => m.score < 0.6).length,
      noValue: matches.filter(m => !m.hasValue).length,
      fields: matches.slice(0, 200).map(m => ({ key: m.key, label: m.label, score: Math.round(m.score * 100) / 100, include: m.include, source: m.source, question: M.describe(m.entry).display })),
    };
  }

  // ---------- preview ----------
  async function preview(profile, settings) {
    state.profile = profile;
    state.settings = { ...DEFAULTS, ...settings };
    UI.hidePanel();
    const matches = await analyze(profile, state.settings);
    state.matches = matches;
    state.previewing = true;
    const qaList = (profile.qa || []).filter(q => q.question && q.answer);
    UI.showHighlights(matches.map(toItem), {
      qaList,
      onToggle: (id, include) => { const m = matches.find(x => x.id === id); if (m) m.include = include; },
      onRemap: (id, key) => remap(id, key),
    });
    bindLearning();
    return summarize(matches);
  }
  function remap(id, key) {
    const m = state.matches.find(x => x.id === id);
    if (!m) return null;
    if (key === '__skip') {
      saveRule(m.entry.sig, { key: '__skip' }, M.describe(m.entry).display);
      m.include = false;
      UI.toast(`This field will be skipped on ${host}.`, [{ label: 'Undo', onClick: () => deleteRule(m.entry.sig) }]);
      return { include: false, reason: 'never fill here', label: 'Skipped on this site' };
    }
    m.key = key;
    m.source = 'learned';
    m.score = 1;
    if (!isRepeatable(key)) m.index = 0; else if (m.index == null) m.index = 0;
    refreshValue(m, state.profile, state.settings);
    m.include = m.hasValue;
    saveRule(m.entry.sig, isRepeatable(key) ? { key, index: m.index } : { key }, M.describe(m.entry).display);
    UI.toast(`Remembered for ${host}: ${m.label}`);
    return { key, label: m.label, value: m.value, score: 1, source: 'learned', include: m.include, reason: m.include ? '' : m.reason };
  }
  function clear() {
    state.previewing = false;
    UI.clearHighlights();
    UI.hidePanel();
    return true;
  }

  // ---------- fill ----------
  async function fillMatches(list, undo, results) {
    for (const m of list) {
      if (!m.entry.el.isConnected) continue;
      undo.push(...Fi.snapshot(m.entry));
      let r;
      try { r = await Fi.apply(m.entry, m.key, m.raw, state.ctx); } catch (e) { r = { ok: false, reason: e.message }; }
      m.state = r.ok ? 'done' : 'fail';
      m.reason = r.reason || '';
      if (r.ok) {
        results.filled++;
        for (const el of m.entry.els) state.filled.set(el, m);
      } else {
        results.failed++;
        results.failures.push({ label: m.label, reason: r.reason || 'Could not set value' });
      }
    }
  }
  function waitForDom(timeout = 2000) {
    return new Promise(resolve => {
      let timer = 0;
      const done = () => { obs.disconnect(); clearTimeout(timer); clearTimeout(hard); resolve(); };
      const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 250); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const hard = setTimeout(done, timeout);
    });
  }
  function deepQuery(selector) {
    const out = [];
    const visit = (root) => {
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll('*')) { const sr = M.shadowOf(el); if (sr) visit(sr); }
    };
    visit(document);
    return out;
  }
  const GROUP_WORDS = {
    work: ['experience', 'employment', 'work', 'job', 'position', 'employer', 'history', 'role'],
    edu: ['education', 'school', 'degree', 'university', 'college', 'qualification'],
  };
  function findAddButton(group, anchor) {
    const words = GROUP_WORDS[group], others = GROUP_WORDS[group === 'work' ? 'edu' : 'work'];
    let best = null, bestScore = 0;
    for (const b of deepQuery('button, a, [role=button], input[type=button]')) {
      if (b.closest('#' + M.UI_HOST_ID) || !M.isVisible(b) || b.disabled) continue;
      const t = M.norm(b.innerText || b.value || b.getAttribute('aria-label') || b.title || '');
      if (!t || t.length > 60) continue;
      const raw = (b.innerText || b.value || '').trim();
      if (!/\badd\b|another|\bmore\b|\bnew\b/.test(t) && !/^\+/.test(raw)) continue;
      if (/\b(submit|apply|remove|delete|cancel|upload|attach|file|photo|link)\b/.test(t)) continue;
      let s = 0;
      if (words.some(w => M.hasPhrase(t, w))) s += 3;
      if (others.some(w => M.hasPhrase(t, w))) s -= 4;
      if (/another|more/.test(t)) s += 0.5;
      if (anchor) {
        let a = anchor.parentElement, hops = 0;
        while (a && !a.contains(b) && hops < 12) { a = a.parentElement; hops++; }
        if (a && a.contains(b)) s += Math.max(0, 3 - hops * 0.35);
        // must come after the anchor in the document
        if (anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) s -= 2;
      }
      if (s > bestScore) { bestScore = s; best = b; }
    }
    return bestScore >= 2.5 ? best : null;
  }
  function wantedCount(profile, g) {
    return (profile[g] || []).filter(e => e && Object.values(e).some(v => v && v !== false)).length;
  }
  async function fillRepeatables(profile, settings, matches, undo, results) {
    for (const g of ['work', 'edu']) {
      const wanted = wantedCount(profile, g);
      if (!wanted) continue;
      let current = matches;
      for (let attempt = 0; attempt < wanted + 1; attempt++) {
        const gm = current.filter(m => m.key.startsWith(g + '.'));
        const have = gm.length ? Math.max(...gm.map(m => m.index)) + 1 : 0;
        if (have >= wanted) break;
        const anchor = gm.length ? gm[gm.length - 1].entry.el : null;
        const btn = findAddButton(g, anchor);
        if (!btn) break;
        btn.click();
        await waitForDom();
        const fresh = await analyze(profile, settings);
        const add = fresh.filter(m => m.key.startsWith(g + '.') && m.index >= have && m.include && !state.filled.has(m.entry.el));
        if (!add.length) break;
        results.added++;
        await fillMatches(add, undo, results);
        state.matches.push(...add);
        current = fresh;
      }
    }
  }

  async function fill(profile, settings, opts = {}) {
    state.profile = profile;
    state.settings = { ...DEFAULTS, ...settings };
    let matches;
    if (opts.usePreview && state.previewing && state.matches.length) {
      matches = state.matches;
      for (const m of matches) {
        const inc = m.include;
        refreshValue(m, profile, state.settings);
        m.include = inc && m.hasValue;
      }
    } else {
      matches = await analyze(profile, state.settings);
      state.matches = matches;
    }
    state.previewing = false;
    UI.clearHighlights();
    UI.hidePanel();
    const undo = [];
    const results = { filled: 0, failed: 0, failures: [], added: 0, total: matches.length, url: location.href, top: window === window.top };
    await fillMatches(matches.filter(m => m.include), undo, results);
    if (state.settings.fillRepeatables) {
      try { await fillRepeatables(profile, state.settings, matches, undo, results); } catch (e) { /* best effort */ }
    }
    if (undo.length) state.undoStack.push(undo);
    if (state.settings.highlightAfterFill) {
      const done = state.matches.filter(m => m.state);
      if (done.length) UI.flash(done.map(m => ({ ...toItem(m), state: m.state, include: true, reason: m.state === 'fail' ? m.reason : '' })));
    }
    bindLearning();
    return results;
  }

  function undo() {
    const last = state.undoStack.pop();
    if (!last) return { restored: 0 };
    Fi.restore(last.slice().reverse());
    for (const s of last) state.filled.delete(s.el);
    UI.clearHighlights();
    return { restored: last.length, remaining: state.undoStack.length };
  }

  // ---------- learn mode ----------
  function bindLearning() {
    if (state.learnBound) return;
    state.learnBound = true;
    document.addEventListener('change', onUserChange, true);
  }
  function onUserChange(e) {
    if (!e.isTrusted || !state.settings || !state.settings.learnMode || !state.profile) return;
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!el || !el.tagName || el.closest && el.closest('#' + M.UI_HOST_ID)) return;
    if (el.type === 'checkbox' || el.type === 'file') return;
    setTimeout(() => learnFrom(el), 0);
  }
  function learnFrom(el) {
    const entry = scanEntries().find(en => en.els.includes(el) || en.el === el);
    if (!entry) return;
    const value = M.norm(currentValueOf(entry));
    const prev = state.filled.get(el);
    const display = M.describe(entry).display;
    if (!value) {
      if (prev) {
        saveRule(entry.sig, { key: '__skip' }, display);
        state.filled.delete(el);
        UI.toast(`Got it. "${display.slice(0, 40)}" won't be filled on ${host}.`, [{ label: 'Undo', onClick: () => deleteRule(entry.sig) }]);
      }
      return;
    }
    const flat = Fi.flatten(state.profile);
    let hit = flat.find(f => M.norm(f.value) === value);
    if (!hit && (entry.kind === 'select' || entry.kind === 'radio')) {
      hit = flat.find(f => Fi.expandCandidates(f.value, byKey[f.key]).includes(value));
    }
    if (!hit) {
      // A filled field was overwritten with something not in the profile: treat as a correction to skip.
      return;
    }
    if (prev && prev.key === hit.key && (prev.index || 0) === (hit.index || 0)) return;
    const rule = isRepeatable(hit.key) ? { key: hit.key, index: hit.index } : { key: hit.key };
    saveRule(entry.sig, rule, display);
    state.filled.set(el, { key: hit.key, index: hit.index });
    UI.toast(`Learned for ${host}: "${display.slice(0, 32)}" = ${labelFor(hit.key, hit.index)}`, [{ label: 'Undo', onClick: () => deleteRule(entry.sig) }]);
  }

  // ---------- panel (top frame) ----------
  function showPanel(info) {
    const frames = info.frames > 1 ? ` across ${info.frames} frames` : '';
    UI.showPanel({
      title: 'Smart Autofill',
      subtitle: `Profile: ${info.profileName}. Review the highlighted fields${frames}, toggle or remap any of them, then fill.`,
      stats: [
        { value: info.ready, label: 'ready to fill' },
        { value: info.high, label: 'high confidence' },
        { value: info.total - info.ready, label: 'skipped' },
      ],
      legend: true,
      actions: [
        { label: 'Cancel', onClick: () => send({ type: 'panel-cancel' }) },
        { label: `Fill ${info.ready} field${info.ready === 1 ? '' : 's'}`, primary: true, onClick: (b) => { b.disabled = true; b.textContent = 'Filling...'; send({ type: 'panel-fill' }); } },
      ],
      onClose: () => send({ type: 'panel-cancel' }),
    });
    return true;
  }
  function showResult(info) {
    const failed = info.failed ? `, ${info.failed} could not be set` : '';
    const added = info.added ? ` Added ${info.added} extra section${info.added > 1 ? 's' : ''}.` : '';
    UI.showPanel({
      title: 'Form filled',
      subtitle: `Filled ${info.filled} field${info.filled === 1 ? '' : 's'}${failed}.${added} Please review before submitting. Corrections you make are remembered for this site.`,
      actions: [
        { label: 'Undo fill', onClick: () => send({ type: 'panel-undo' }) },
        { label: 'Done', primary: true, onClick: () => UI.hidePanel() },
      ],
      focus: false,
    });
    setTimeout(() => UI.hidePanel(), 15000);
    return true;
  }
  function send(msg) { try { chrome.runtime.sendMessage(msg); } catch (e) { UI.hidePanel(); } }

  async function detect() {
    const entries = scanEntries();
    let matched = 0;
    for (const e of entries) { const c = M.classify(e, []); if (c.best && c.best.score >= 0.5) matched++; }
    return { controls: entries.length, matched, url: location.href, top: window === window.top };
  }

  globalThis.__SmartAutofill = {
    version: 1, preview, fill, undo, clear, showPanel, showResult, detect,
    toast: (t) => UI.toast(t),
    canUndo: () => state.undoStack.length > 0,
  };
})();
