import { PriceChart } from '../lib/chart.js';
import { PP, PS, send, getSettings, getItems, fmt, hostOf, hasOrigin, requestOrigin, itemSummary, el, safeImage, STATUS_TEXT, relTime, toast } from '../lib/ui.js';

const $ = id => document.getElementById(id);
const state = { tab: null, product: null, item: null, selector: null, settings: null, hasAccess: false, targetType: 'percent', chart: null };

function show(name) {
  for (const s of document.querySelectorAll('.state')) s.hidden = s.id !== 'state-' + name;
}

async function injectDetector(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/price-parse.js', 'lib/detect.js'] });
}

async function detectOnTab(tabId, selector) {
  const run = async () => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: sel => globalThis.PriceDetect.detectProduct(document, location.href, { selector: sel }),
      args: [selector || null],
    });
    return r && r.result;
  };
  await injectDetector(tabId);
  let product = await run();
  if (product && product.price == null) {
    await new Promise(r => setTimeout(r, 900)); // late-rendering storefronts
    product = await run();
  }
  return product;
}

async function getPick(tab) {
  if (!chrome.storage.session) return null;
  const key = 'pick:' + tab.id;
  const { [key]: pick } = await chrome.storage.session.get(key);
  return pick && pick.url === tab.url ? pick : null;
}

async function renderRecent(listId, titleId) {
  const items = Object.values(await getItems()).sort((a, b) => (b.lastSeen || b.createdAt) - (a.lastSeen || a.createdAt)).slice(0, 5);
  const ul = $(listId);
  ul.replaceChildren();
  $(titleId).hidden = !items.length;
  for (const it of items) {
    const { stats, verdict } = itemSummary(it, state.settings);
    const img = safeImage(it.image) ? el('img', { src: it.image, alt: '' }) : el('span', { class: 'ph' });
    const a = el('a', { href: it.url, title: it.title },
      img,
      el('span', { class: 'mid' }, el('span', { class: 'name' }, it.title), el('span', { class: 'pill ' + verdict.level }, verdict.label)),
      el('span', { class: 'p num' }, fmt(stats.current, it.currency)));
    a.addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: it.url }); window.close(); });
    ul.append(el('li', {}, a));
  }
}

function setTargetType(type) {
  state.targetType = type;
  for (const b of $('target-type').querySelectorAll('button')) {
    const on = b.dataset.type === type;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const input = $('target-value');
  const price = state.product && state.product.price != null ? state.product.price : (state.item && itemSummary(state.item).stats.current);
  const currency = (state.product && state.product.currency) || (state.item && state.item.currency);
  const existing = state.item && state.item.target && state.item.target.type === type ? state.item.target.value : null;
  $('target-input-row').hidden = type === 'any' || type === 'none';
  if (type === 'percent') {
    $('target-prefix').textContent = '';
    $('target-suffix').textContent = '%';
    $('target-value-label').textContent = 'Drop percentage';
    input.step = '1'; input.min = '1'; input.max = '95';
    input.value = existing || (state.settings.defaultTargetType === 'percent' ? state.settings.defaultTargetValue : 10);
  } else if (type === 'price') {
    const sym = PP.formatPrice(0, currency).replace(/[\d.,\s ]/g, '');
    $('target-prefix').textContent = sym;
    $('target-suffix').textContent = '';
    $('target-value-label').textContent = 'Target price';
    input.step = 'any'; input.min = '0'; input.removeAttribute('max');
    input.value = existing || (price ? Math.floor(price * 0.9 * 100) / 100 : '');
  }
  updateTargetHint();
}

function updateTargetHint() {
  const type = state.targetType;
  const currency = (state.product && state.product.currency) || (state.item && state.item.currency);
  const base = state.item ? state.item.baselinePrice : state.product && state.product.price;
  const v = Number($('target-value').value);
  let hint = '', explain = '';
  if (type === 'percent' && base && v > 0 && v < 100) hint = '= ' + fmt(base * (1 - v / 100), currency);
  if (type === 'percent') explain = 'Measured from the price when you started tracking.';
  if (type === 'price') explain = 'Get notified once the price is at or below this.';
  if (type === 'any') explain = 'Get notified when the price goes below the starting price.';
  if (type === 'none') explain = 'Only all-time lows and back-in-stock alerts.';
  $('target-hint').textContent = hint;
  $('target-explain').textContent = explain + ' New all-time lows and restocks are always tracked.';
}

function renderProduct() {
  const p = state.product;
  const it = state.item;
  const title = (it && it.title) || (p && p.title) || 'Untitled product';
  const image = safeImage((p && p.image) || (it && it.image));
  const currency = (p && p.currency) || (it && it.currency);
  $('p-title').textContent = title;
  $('p-title').title = title;
  $('p-host').textContent = hostOf(state.tab.url);
  const img = $('p-image');
  if (image) { img.src = image; img.hidden = false; img.onerror = () => { img.hidden = true; }; } else img.hidden = true;
  const price = p && p.price != null ? p.price : it ? itemSummary(it).stats.current : null;
  $('p-price').textContent = fmt(price, currency);
  const avail = (p && p.availability !== 'unknown' ? p.availability : null) || (it && it.availability);
  const pill = $('p-avail');
  pill.hidden = !avail || avail === 'unknown';
  pill.className = 'pill ' + (avail === 'out_of_stock' ? 'oos' : 'good');
  pill.textContent = avail === 'out_of_stock' ? 'Out of stock' : 'In stock';
  const sourceText = {
    jsonld: 'Found in the page\'s product data', microdata: 'Found in the page\'s product markup', opengraph: 'Found in the page\'s product tags',
    picked: 'From the price you picked', heuristic: 'Best guess from the page layout. Pick the price if this is wrong.', shopify: 'Found in the store\'s product data',
  }[p && p.source] || (p && p.source && p.source.startsWith('store:') ? `Read from the ${p.source.slice(6)} product page` : '');
  $('p-source').textContent = p && p.price == null && it ? `Couldn't read the price right now. Last seen ${relTime(it.lastSeen)}.` : sourceText;

  const summary = it ? itemSummary(it, state.settings) : null;
  const sale = summary ? summary.sale : (p && p.listPrice ? PS.saleCheck(p.price, p.listPrice, null) : null);
  const saleEl = $('p-sale');
  saleEl.hidden = !sale;
  if (sale) {
    saleEl.textContent = sale.text;
    saleEl.className = 'callout ' + (sale.honest === false ? 'bad' : sale.honest ? 'good' : '');
  }

  $('tracked').hidden = !it;
  $('tracked-actions').hidden = !it;
  $('bg-check-row').hidden = !!it || state.hasAccess;
  $('bg-host').textContent = '(asks for access to ' + hostOf(state.tab.url) + ')';
  $('track-btn').textContent = it ? 'Save alert' : 'Track price';
  $('pick-btn').hidden = false;
  if (it) renderTracked(summary);
  setTargetType(it && it.target ? it.target.type : state.settings.defaultTargetType || 'percent');
}

function renderTracked({ stats, verdict, targetPrice }) {
  const it = state.item;
  const v = $('t-verdict');
  v.className = 'pill ' + verdict.level;
  v.textContent = verdict.label;
  $('t-verdict-detail').textContent = verdict.detail;
  $('t-min').textContent = fmt(stats.min, it.currency);
  $('t-avg').textContent = fmt(stats.avg, it.currency);
  $('t-max').textContent = fmt(stats.max, it.currency);
  if (!state.chart) state.chart = new PriceChart($('t-chart'), { mini: true, height: 72, format: n => fmt(n, it.currency) });
  state.chart.setData({ history: it.history, target: targetPrice, label: 'Price history for ' + it.title });
  const status = it.lastStatus && it.lastStatus !== 'ok' ? it.lastStatus : (!state.hasAccess ? 'no_permission' : null);
  $('t-status').hidden = !status;
  if (status) {
    $('t-status-text').textContent = status === 'no_permission'
      ? 'Background checks are off for this store. Prices update only when you open this popup.'
      : `${STATUS_TEXT[status]}: ${it.statusReason || ''}`;
    $('t-grant').hidden = state.hasAccess;
  }
}

async function onSubmit(e) {
  e.preventDefault();
  $('form-error').hidden = true;
  // Permission request must happen first, while we still have the user gesture.
  if (!state.item && $('bg-check').checked && !state.hasAccess) {
    state.hasAccess = await requestOrigin(state.tab.url);
  }
  const type = state.targetType;
  const target = { type, value: type === 'price' || type === 'percent' ? Number($('target-value').value) : null };
  if ((type === 'price' || type === 'percent') && !(target.value > 0)) {
    $('form-error').textContent = type === 'price' ? 'Enter a target price.' : 'Enter a percentage between 1 and 95.';
    $('form-error').hidden = false;
    $('target-value').focus();
    return;
  }
  if (type === 'percent' && target.value >= 100) {
    $('form-error').textContent = 'Enter a percentage between 1 and 95.';
    $('form-error').hidden = false;
    return;
  }
  $('track-btn').disabled = true;
  try {
    if (state.item) {
      state.item = await send('update', { id: state.item.id, patch: { target } });
    } else {
      state.item = await send('track', { product: state.product, url: state.tab.url, target, selector: state.selector });
      if (chrome.storage.session) chrome.storage.session.remove('pick:' + state.tab.id);
    }
    const wasTracked = $('track-btn').textContent === 'Save alert';
    renderProduct();
    toast(wasTracked ? 'Alert saved' : 'Tracking started');
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').hidden = false;
  } finally {
    $('track-btn').disabled = false;
  }
}

async function startPicker() {
  try {
    await injectDetector(state.tab.id);
    await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, files: ['content/picker.js'] });
    window.close();
  } catch (e) {
    $('form-error').textContent = 'Could not start the picker on this page.';
    $('form-error').hidden = false;
  }
}

function wire() {
  $('open-dashboard').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') + (state.item ? '#item=' + state.item.id : '') }); window.close(); });
  $('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('view-history').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#item=' + state.item.id) }); window.close(); });
  $('untrack').addEventListener('click', async () => {
    if (!state.item) return;
    await send('delete', { ids: [state.item.id] });
    state.item = null;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    renderProduct();
  });
  $('pick-btn').addEventListener('click', startPicker);
  $('pick-empty').addEventListener('click', startPicker);
  $('t-grant').addEventListener('click', async () => {
    state.hasAccess = await requestOrigin(state.tab.url);
    if (state.hasAccess && state.item) state.item = await send('check', { id: state.item.id }).catch(() => state.item);
    renderProduct();
  });
  $('target-form').addEventListener('submit', onSubmit);
  $('target-value').addEventListener('input', updateTargetHint);
  const group = $('target-type');
  group.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTargetType(b.dataset.type); });
  group.addEventListener('keydown', e => {
    const buttons = [...group.querySelectorAll('button')];
    const i = buttons.findIndex(b => b.dataset.type === state.targetType);
    let n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % buttons.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + buttons.length) % buttons.length;
    if (n == null) return;
    e.preventDefault();
    setTargetType(buttons[n].dataset.type);
    buttons[n].focus();
  });
}

async function init() {
  wire();
  state.settings = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    $('unsupported-reason').textContent = tab && tab.url ? 'Browser and extension pages can\'t be read.' : 'No page is open.';
    show('unsupported');
    renderRecent('recent', 'recent-title');
    return;
  }
  state.hasAccess = await hasOrigin(tab.url);
  let item = await send('find', { url: tab.url }).catch(() => null);
  const pick = await getPick(tab);
  state.selector = (pick && pick.selector) || (item && item.selector) || null;
  let product = null;
  try {
    product = await detectOnTab(tab.id, state.selector);
  } catch (e) {
    $('unsupported-reason').textContent = 'This page can\'t be read by extensions (for example the browser\'s web store).';
    show('unsupported');
    renderRecent('recent', 'recent-title');
    return;
  }
  if (pick && pick.product && pick.product.price != null) {
    product = { ...product, price: pick.product.price, currency: pick.product.currency || product.currency, source: 'picked', isProduct: true };
  }
  if (!item && product && product.canonical) item = await send('find', { url: tab.url, canonical: product.canonical }).catch(() => null);
  state.product = product;
  state.item = item;
  if (item && product && (product.price != null || product.availability !== 'unknown')) {
    state.item = (await send('observe', { id: item.id, url: tab.url, product, via: 'popup' }).catch(() => null)) || item;
  }
  if (!state.item && (!product || product.price == null)) {
    show('noproduct');
    renderRecent('recent-2', 'recent-title-2');
    return;
  }
  show('product');
  renderProduct();
}

init().catch(err => {
  console.warn('Price Tracker popup:', err);
  $('unsupported-reason').textContent = 'Something went wrong reading this page.';
  show('unsupported');
});
