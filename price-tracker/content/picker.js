// "Pick the price element" overlay. Injected on demand from the popup (activeTab + scripting).
(() => {
  'use strict';
  if (window.__priceTrackerPicker) { window.__priceTrackerPicker.focus(); return; }

  const PP = globalThis.PriceParse;
  const PD = globalThis.PriceDetect;
  const host = document.createElement('div');
  host.setAttribute('data-price-tracker-picker', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; border: 2px solid #12a171; background: rgba(18,161,113,.12); border-radius: 4px; pointer-events: none; transition: all .06s ease-out; box-shadow: 0 0 0 9999px rgba(0,0,0,.08); }
      .box.bad { border-color: #d14343; background: rgba(209,67,67,.10); }
      .tip { position: fixed; max-width: 320px; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff; background: #10231c; padding: 6px 10px; border-radius: 8px; pointer-events: none; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
      .tip b { color: #7ff0c4; }
      .bar { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); display: flex; gap: 12px; align-items: center; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #10231c; background: #fff; padding: 10px 16px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.25); pointer-events: auto; }
      .bar kbd { font: 12px ui-monospace, monospace; background: #eef2f0; border: 1px solid #cfd8d3; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }
      .bar button { font: inherit; border: 1px solid #cfd8d3; background: #f6f8f7; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
      .bar button:focus-visible { outline: 2px solid #12a171; outline-offset: 2px; }
      .toast { position: fixed; right: 16px; bottom: 16px; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff; background: #0f8a5f; padding: 12px 16px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.25); pointer-events: auto; }
    </style>
    <div class="box" hidden></div>
    <div class="tip" hidden></div>
    <div class="bar" role="dialog" aria-label="Pick the price">
      <span><b>Click the price</b> on the page. <kbd>↑</kbd>/<kbd>↓</kbd> widen or narrow, <kbd>Enter</kbd> select, <kbd>Esc</kbd> cancel.</span>
      <button type="button" class="cancel">Cancel</button>
    </div>`;
  const box = shadow.querySelector('.box');
  const tip = shadow.querySelector('.tip');
  const cancelBtn = shadow.querySelector('.cancel');
  document.documentElement.appendChild(host);

  let current = null;
  const currencyHint = (document.querySelector('meta[property="product:price:currency"], meta[property="og:price:currency"]') || {}).content;

  function parseEl(el) {
    if (!el) return null;
    const text = PD.priceText(el) || (el.textContent || '').trim().slice(0, 80);
    return { text, parsed: PP.parsePrice(text, { url: location.href, currency: currencyHint }) };
  }

  function show(el) {
    current = el;
    if (!el) { box.hidden = tip.hidden = true; return; }
    const r = el.getBoundingClientRect();
    const info = parseEl(el);
    box.hidden = tip.hidden = false;
    Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    box.classList.toggle('bad', !info.parsed);
    tip.innerHTML = '';
    if (info.parsed) {
      tip.append('Price: ');
      const b = document.createElement('b');
      b.textContent = PP.formatPrice(info.parsed.amount, info.parsed.currency);
      tip.append(b);
    } else {
      tip.textContent = 'No price in this element';
    }
    const top = r.bottom + 8 + 40 > innerHeight ? r.top - 40 : r.bottom + 8;
    Object.assign(tip.style, { left: Math.max(8, Math.min(r.left, innerWidth - 330)) + 'px', top: Math.max(8, top) + 'px' });
  }

  const STABLE_CLASS = c => c && c.length < 40 && !/\d{3,}|^(css|sc|jsx|emotion|styled|tw)-|__[a-z0-9]{5,}$|^[a-z]{1,3}[A-Z0-9][a-zA-Z0-9]{4,}$|hover|focus|active|selected|is-|has-/.test(c);

  function escapeCss(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function unique(sel, el) {
    try { const all = document.querySelectorAll(sel); return all.length === 1 && all[0] === el; } catch (_) { return false; }
  }

  /** Build a short, reasonably stable CSS selector for an element. */
  function selectorFor(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      if (node.id && !/\d{4,}|^[0-9]/.test(node.id) && node.id.length < 60) {
        parts.unshift('#' + escapeCss(node.id));
        const sel = parts.join(' > ');
        if (unique(sel, el)) return sel;
      } else {
        let part = node.localName;
        for (const attr of ['itemprop', 'data-testid', 'data-test', 'data-qa', 'data-automation-id', 'data-seo-id']) {
          const v = node.getAttribute(attr);
          if (v && v.length < 60) { part += `[${attr}="${v.replace(/"/g, '\\"')}"]`; break; }
        }
        const classes = Array.from(node.classList).filter(STABLE_CLASS).slice(0, 3);
        if (classes.length) part += '.' + classes.map(escapeCss).join('.');
        const parent = node.parentElement;
        parts.unshift(part);
        if (unique(parts.join(' > '), el)) return parts.join(' > ');
        if (parent) {
          const same = Array.from(parent.children).filter(c => c.localName === node.localName);
          if (same.length > 1) {
            parts[0] = part + `:nth-of-type(${same.indexOf(node) + 1})`;
            if (unique(parts.join(' > '), el)) return parts.join(' > ');
          }
        }
      }
      node = node.parentElement;
    }
    const sel = parts.join(' > ');
    return unique(sel, el) ? sel : null;
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    host.remove();
    delete window.__priceTrackerPicker;
  }

  function toast(text, ms) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    const h = document.createElement('div');
    h.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const s = h.attachShadow({ mode: 'closed' });
    s.appendChild(shadow.querySelector('style').cloneNode(true));
    s.appendChild(t);
    document.documentElement.appendChild(h);
    setTimeout(() => h.remove(), ms || 5000);
  }

  function choose(el) {
    const info = parseEl(el);
    if (!info || !info.parsed) { toast('That element does not contain a price. Try another one.', 3000); return; }
    const selector = selectorFor(el);
    cleanup();
    const product = PD.detectProduct(document, location.href, selector ? { selector } : {});
    product.price = info.parsed.amount;
    product.currency = info.parsed.currency || product.currency;
    product.source = 'picked';
    product.isProduct = true;
    try {
      chrome.runtime.sendMessage({ type: 'picked', url: location.href, selector, text: info.text, product }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension reloaded */ }
    toast(`Price selected: ${PP.formatPrice(info.parsed.amount, info.parsed.currency)}. Open Price Tracker to finish.`);
  }

  function onMove(e) {
    const el = e.target;
    if (!el || el === host || el.nodeType !== 1) return;
    show(el);
  }
  function onClick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    choose(current || e.target);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); return; }
    if (!current || (e.key === 'Enter' && e.composedPath().includes(host))) return;
    if (e.key === 'ArrowUp' && current.parentElement && current.parentElement !== document.body) { e.preventDefault(); show(current.parentElement); }
    else if (e.key === 'ArrowDown' && current.firstElementChild) { e.preventDefault(); show(current.firstElementChild); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(current); }
  }
  function onScroll() { if (current) show(current); }

  cancelBtn.addEventListener('click', e => { e.stopPropagation(); cleanup(); });
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);

  // Start on the detected price element if we can guess one, so keyboard-only users can pick.
  const guess = document.querySelector('[itemprop="price"], .a-price .a-offscreen, [data-test="product-price"], [class*="price" i]');
  if (guess) show(guess.closest('.a-price') || guess);
  window.__priceTrackerPicker = { focus: () => cancelBtn.focus() };
  cancelBtn.focus({ preventScroll: true });
})();
