// Privacy Shield content script (isolated world, every frame, document_start).
//  1. Cookie banners: finds a known consent manager (rules in consent-rules.js) or a
//     generic cookie banner, then rejects, accepts or hides it according to the settings,
//     falling back to hiding it and restoring page scrolling when clicking fails.
//  2. Learning probe: in cross-site iframes, reports when the frame uses cookies or
//     localStorage, which feeds the heuristic tracker learning in the service worker.

(() => {
  if (globalThis.__privacyShieldConsent) return;
  globalThis.__privacyShieldConsent = true;

  const { rules } = globalThis.PRIVACY_SHIELD_CONSENT || { rules: [] };
  const isTop = window === window.top;
  const STYLE_ID = 'privacy-shield-consent-style';
  const WATCH_MS = isTop ? 20000 : 12000;
  const GENERIC_DELAY_MS = 1500;
  const started = Date.now();

  let config = null;
  let busy = false;
  const handled = new Set(); // rule ids already acted on
  const hiddenSelectors = new Set();
  let observer = null;
  let scanTimer = null;

  // ───────────────────────────── messaging ─────────────────────────────

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).then((r) => (r && r.ok ? r.result : null)).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension reloaded underneath us
    }
  }

  // ───────────────────────────── DOM helpers ─────────────────────────────

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      if (chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      // not a shadow host
    }
    return null;
  }

  /** querySelectorAll that understands one "host >>> inner" shadow hop. */
  function queryAll(selector, root = document) {
    try {
      const idx = selector.indexOf('>>>');
      if (idx === -1) return [...root.querySelectorAll(selector)];
      const hostSel = selector.slice(0, idx).trim();
      const inner = selector.slice(idx + 3).trim();
      const out = [];
      for (const host of root.querySelectorAll(hostSel)) {
        const sr = shadowOf(host);
        if (sr) out.push(...queryAll(inner, sr));
      }
      return out;
    } catch {
      return [];
    }
  }

  function queryAny(selectors) {
    for (const s of selectors) {
      const found = queryAll(s);
      if (found.length) return found;
    }
    return [];
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el === document.body || el === document.documentElement) return true;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return true;
  }

  function anyVisible(selectors) {
    return selectors.some((s) => queryAll(s).some(isVisible));
  }

  function textOf(el) {
    return (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
  }

  function findClickable(selectors, textRe) {
    for (const s of selectors) {
      for (const el of queryAll(s)) {
        if (!isVisible(el)) continue;
        if (el.disabled) continue;
        if (textRe && !textRe.test(textOf(el))) continue;
        return el;
      }
    }
    return null;
  }

  function click(el) {
    try {
      el.scrollIntoView({ block: 'nearest' });
    } catch {
      // detached
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window }));
    }
    el.click();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 3000, interval = 100) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  // ───────────────────────────── step runner ─────────────────────────────

  async function runSteps(steps, rule) {
    for (const step of steps) {
      const ok = await runStep(step, rule);
      if (!ok && !step.optional) return false;
    }
    return true;
  }

  async function runStep(step, rule) {
    if (step.any) {
      for (const branch of step.any) {
        if (await runSteps(branch, rule)) return true;
      }
      return false;
    }
    if (step.click) {
      // Elements often render a moment after their container; give them a short grace period.
      const el = await waitFor(() => findClickable(step.click, step.text), step.timeout ?? 600);
      if (!el) return false;
      click(el);
      await sleep(step.after ?? 400);
      return true;
    }
    if (step.waitFor) {
      return !!(await waitFor(() => step.waitFor.some((s) => queryAll(s).some(isVisible)), step.timeout ?? 3000));
    }
    if (step.wait) {
      await sleep(step.wait);
      return true;
    }
    if (step.uncheck) {
      for (const s of step.uncheck) {
        for (const el of queryAll(s)) {
          const checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
          if (!checked || el.disabled) continue;
          click(el);
          if (el.type === 'checkbox' && el.checked) {
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }
      await sleep(200);
      return true;
    }
    if (step.delegate) {
      // Wait for a frame rule (or the CMP itself) to close the banner.
      const closed = await waitFor(() => !anyVisible(rule.visible || rule.detect), step.delegate, 200);
      return closed !== null;
    }
    return false;
  }

  // ───────────────────────────── hiding and scrolling ─────────────────────────────

  function styleEl() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function cssFor(selectors) {
    // CSS cannot cross shadow roots, so hide the host for pierced selectors.
    return selectors.map((s) => (s.includes('>>>') ? s.split('>>>')[0].trim() : s));
  }

  function hide(selectors) {
    for (const s of cssFor(selectors)) hiddenSelectors.add(s);
    if (!hiddenSelectors.size) return;
    styleEl().textContent = `${[...hiddenSelectors].join(',\n')} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
  }

  function scrollLocked() {
    const docEl = document.documentElement;
    const body = document.body;
    const check = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.overflow === 'hidden' || cs.overflowY === 'hidden' || (el === body && cs.position === 'fixed');
    };
    return check(docEl) || check(body);
  }

  function restoreScroll(rule, wasLocked) {
    const classes = rule.lockClasses || [];
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      for (const c of classes) el.classList.remove(c);
    }
    if (!wasLocked || !scrollLocked()) return;
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      if (el.style.overflow === 'hidden' || el.style.overflowY === 'hidden') {
        el.style.removeProperty('overflow');
        el.style.removeProperty('overflow-y');
      }
      if (el === document.body && el.style.position === 'fixed') {
        const top = parseInt(el.style.top, 10);
        el.style.removeProperty('position');
        el.style.removeProperty('top');
        el.style.removeProperty('width');
        if (Number.isFinite(top) && top < 0) window.scrollTo(0, -top);
      }
    }
    if (scrollLocked()) {
      const s = styleEl();
      if (!s.textContent.includes('/* scroll */')) {
        s.textContent += '\n/* scroll */ html, body { overflow: auto !important; overflow-y: auto !important; }\nbody { position: static !important; }';
      }
    }
  }

  // ───────────────────────────── generic banner detection ─────────────────────────────

  function isOverlayish(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      const cs = getComputedStyle(node);
      if (cs.position === 'fixed' || cs.position === 'sticky') return true;
      if (cs.position === 'absolute' && Number(cs.zIndex) >= 100) return true;
      node = node.parentElement;
    }
    return false;
  }

  function findGenericBanner(rule) {
    const seen = new Set();
    for (const sel of rule.containers) {
      for (const el of queryAll(sel)) {
        if (seen.has(el) || el === document.body || el === document.documentElement) continue;
        seen.add(el);
        if (!isVisible(el)) continue;
        const text = textOf(el);
        if (!text || text.length > 4000 || !rule.textRe.test(text)) continue;
        if (!/cookie|consent|gdpr|einwilligung|rgpd|tracking/i.test(text)) continue;
        if (!isOverlayish(el)) continue;
        const r = el.getBoundingClientRect();
        // A banner never fills the whole document height of a scrolling page.
        if (r.height > window.innerHeight * 1.05 && document.documentElement.scrollHeight > window.innerHeight * 1.5) continue;
        return el;
      }
    }
    return null;
  }

  function buttonsIn(el) {
    const out = [];
    const sel = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
    out.push(...el.querySelectorAll(sel));
    return out.filter(isVisible);
  }

  let genericSelectorSeq = 0;

  async function handleGeneric(rule, mode) {
    const banner = findGenericBanner(rule);
    if (!banner) return false;
    handled.add(rule.id);
    const wasLocked = scrollLocked();
    let action = mode;
    let ok = false;
    if (mode === 'reject' || mode === 'accept') {
      const re = mode === 'reject' ? rule.rejectRe : rule.acceptRe;
      const btn = buttonsIn(banner).find((b) => {
        const t = textOf(b);
        return t.length <= 60 && re.test(t);
      });
      if (btn) {
        click(btn);
        ok = !!(await waitFor(() => !isVisible(banner), 2500, 150));
      }
    }
    if (!ok) {
      // Mark the element so the CSS can target it even without a stable id.
      const attr = `ps-hide-${++genericSelectorSeq}`;
      banner.setAttribute('data-privacy-shield', attr);
      hide([`[data-privacy-shield="${attr}"]`]);
      action = 'hide';
      ok = true;
    }
    restoreScroll(rule, wasLocked);
    report(rule, action, ok);
    return true;
  }

  // ───────────────────────────── rule execution ─────────────────────────────

  function ruleApplies(rule) {
    if (rule.generic) return isTop;
    if (rule.frame === 'only') {
      if (isTop) return false;
      if (rule.frameUrl && !rule.frameUrl.test(location.href)) return false;
    } else if (!isTop) {
      return false;
    }
    return rule.detect.some((s) => queryAll(s).length > 0);
  }

  function report(rule, action, ok) {
    send({ type: 'cs:banner', cmp: rule.id.replace(/-frame$/, ''), name: rule.name, action, ok });
  }

  async function handleRule(rule, mode) {
    const visibleSel = rule.visible || rule.detect;
    if (!anyVisible(visibleSel)) return false;
    handled.add(rule.id);
    const wasLocked = scrollLocked();

    if (mode === 'hide') {
      if (rule.frameReportOnly) return true; // the top-frame rule hides the container
      hide(rule.hide);
      restoreScroll(rule, wasLocked);
      report(rule, 'hide', true);
      return true;
    }

    const steps = mode === 'accept' ? rule.accept : rule.reject;
    let ok = false;
    if (steps && steps.length) {
      ok = await runSteps(steps, rule);
      if (ok && !rule.frameReportOnly) {
        ok = !!(await waitFor(() => !anyVisible(visibleSel), 2500, 150));
      }
    }
    if (rule.frameReportOnly) {
      if (ok) report(rule, mode, true);
      return true;
    }
    let action = mode;
    if (!ok) {
      hide(rule.hide);
      action = 'hide';
    }
    // Give the CMP a moment to unlock scrolling by itself before forcing it.
    await sleep(300);
    restoreScroll(rule, wasLocked);
    report(rule, action, true);
    return true;
  }

  async function scan() {
    if (busy || !config) return;
    if (Date.now() - started > WATCH_MS) {
      stop();
      return;
    }
    busy = true;
    try {
      const mode = config.cookieMode;
      for (const rule of rules) {
        if (handled.has(rule.id)) continue;
        if (rule.generic) {
          // Let specific CMPs claim the page first.
          if (Date.now() - started < GENERIC_DELAY_MS) continue;
          if (rules.some((r) => !r.generic && handled.has(r.id))) continue;
          if (!isTop) continue;
          if (await handleGeneric(rule, mode)) break;
          continue;
        }
        if (!ruleApplies(rule)) continue;
        if (await handleRule(rule, mode)) break;
      }
    } catch (e) {
      // A CMP changed its markup mid-flight; the next scan tries again.
    } finally {
      busy = false;
    }
  }

  function scheduleScan(delay = 150) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    clearInterval(pollTimer);
  }

  let pollTimer = null;

  function startWatching() {
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    pollTimer = setInterval(() => scheduleScan(0), 700);
    scheduleScan(0);
  }

  // ───────────────────────────── learning probe ─────────────────────────────

  function probeStorage() {
    if (isTop || !/^https?:$/.test(location.protocol)) return;
    let uses = false;
    try {
      uses = document.cookie.length > 0;
    } catch {
      // sandboxed frame
    }
    if (!uses) {
      try {
        uses = window.localStorage && window.localStorage.length > 0;
      } catch {
        // storage blocked
      }
    }
    if (uses) send({ type: 'cs:storage', frameHost: location.hostname });
  }

  // ───────────────────────────── boot ─────────────────────────────

  send({ type: 'cs:config' }).then((cfg) => {
    if (!cfg) return;
    config = cfg;
    if (!isTop && cfg.learning) {
      const run = () => setTimeout(probeStorage, 1500);
      if (document.readyState === 'complete') run();
      else window.addEventListener('load', run, { once: true });
    }
    if (!cfg.enabled || cfg.cookieMode === 'off') return;
    const begin = () => startWatching();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
  });
})();
