/* Price Tracker: product detection.
 * Classic script exposing `PriceDetect` on globalThis. Works on a live document (content
 * script) and on a DOMParser document (offscreen re-checks), so it never relies on layout.
 * Requires PriceParse (lib/price-parse.js) to be loaded first.
 */
(function (root) {
  'use strict';

  const PP = () => root.PriceParse;

  const TRACKING_PARAMS = /^(utm_\w+|gclid|gclsrc|dclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|ref_|refid|tag|ascsubtag|linkcode|camp|creative|creativeasin|psc|th|smid|pd_rd_\w+|pf_rd_\w+|qid|sr|keywords|crid|sprefix|content-id|_encoding|spm|scm|irclickid|irgwc|clickid|cid|icid|intcmp|afsrc|wmlspartner|affiliates_ad_id|sourceid|veh|lid|campaign_id|ad_id|_trkparms|_trksid|hash|amdata|mkevt|mkcid|mkrid|ssspo|sssrc|ssuid|widget_id|click_key|ga_order|ga_search_type|ga_view_type|ga_search_query|organic_search_click|pro|frs|sts|plkey|epik|clkid|preview_theme_id|_pos|_sid|_ss|_fid|_psq|_v)$/i;

  /** Normalise a product URL into a stable key used to match visits to tracked items. */
  function productKey(url) {
    let u;
    try { u = new URL(url); } catch (_) { return String(url || ''); }
    const host = u.hostname.toLowerCase().replace(/^(www|m|smile)\./, '');
    let path = u.pathname.replace(/\/+$/, '') || '/';
    // Store-specific canonical ids.
    if (/(^|\.)amazon\./.test(host)) {
      const m = path.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})/i);
      if (m) return `${host}/dp/${m[1].toUpperCase()}`;
    }
    if (/(^|\.)ebay\./.test(host)) {
      const m = path.match(/\/itm\/(?:[^/]+\/)?(\d{9,})/);
      if (m) return `${host}/itm/${m[1]}`;
    }
    if (/(^|\.)walmart\./.test(host)) {
      const m = path.match(/\/ip\/(?:[^/]+\/)?(\d+)/);
      if (m) return `${host}/ip/${m[1]}`;
    }
    if (/(^|\.)target\.com$/.test(host)) {
      const m = path.match(/\/A-(\d+)/);
      if (m) return `${host}/A-${m[1]}`;
    }
    if (/(^|\.)bestbuy\./.test(host)) {
      const m = path.match(/\/(\d{7})\.p$/) || path.match(/\/site\/[^/]+\/(\d+)\.p/);
      if (m) return `${host}/sku/${m[1]}`;
      const sku = u.searchParams.get('skuId');
      if (sku) return `${host}/sku/${sku}`;
    }
    if (/(^|\.)etsy\.com$/.test(host)) {
      const m = path.match(/\/listing\/(\d+)/);
      if (m) return `${host}/listing/${m[1]}`;
    }
    const params = [];
    for (const [k, v] of u.searchParams) if (!TRACKING_PARAMS.test(k)) params.push([k, v]);
    params.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
    const qs = params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    return host + path.toLowerCase() + (qs ? '?' + qs : '');
  }

  function cleanText(s) {
    return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  }

  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      const l = e.toLowerCase();
      if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
      if (l === 'quot') return '"'; if (l === 'apos') return "'"; if (l === 'nbsp') return ' ';
      const code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      return isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }

  function absUrl(src, base) {
    if (!src) return null;
    try { return new URL(src, base).href; } catch (_) { return null; }
  }

  // Availability --------------------------------------------------------------------------

  function normAvailability(v) {
    if (v == null) return 'unknown';
    const s = String(Array.isArray(v) ? v[0] : (typeof v === 'object' ? (v['@id'] || v.name || '') : v)).toLowerCase();
    const compact = s.replace(/[\s_-]+/g, '');
    if (/outofstock|soldout|discontinued|unavailable|notavailable/.test(compact)) return 'out_of_stock';
    if (/instock|limitedavailability|onlineonly|instoreonly|preorder|presale|backorder|available/.test(compact)) return 'in_stock';
    return 'unknown';
  }

  const OOS_TEXT = /\b(out of stock|sold out|currently unavailable|temporarily unavailable|no longer available|not available|notify me when (?:it'?s )?available|ausverkauft|nicht verfügbar|agotado|épuisé|rupture de stock|esaurito|uitverkocht)\b/i;

  function textAvailability(doc, scope) {
    const root = scope || doc;
    const nodes = root.querySelectorAll ? root.querySelectorAll('#availability, .availability, [class*="availability" i], [class*="stock" i], [data-test*="stock" i], [data-testid*="stock" i], [itemprop="availability"], .product-form__submit, button[name="add"], [data-button-state], .add-to-cart-button') : [];
    let sawInStock = false;
    for (const n of Array.from(nodes).slice(0, 40)) {
      const t = cleanText(n.textContent || n.getAttribute('content') || n.getAttribute('href') || '');
      if (!t) continue;
      if (OOS_TEXT.test(t)) return 'out_of_stock';
      if (n.matches && n.matches('button') && (n.disabled || n.getAttribute('aria-disabled') === 'true') && /sold|unavailable|out/i.test(t)) return 'out_of_stock';
      if (/\bin stock\b|\badd to (cart|bag|basket)\b|\bonly \d+ left\b|\bavailable\b/i.test(t)) sawInStock = true;
    }
    return sawInStock ? 'in_stock' : 'unknown';
  }

  // JSON-LD -------------------------------------------------------------------------------

  function parseJsonLoose(text) {
    let t = String(text || '').trim();
    if (!t) return null;
    t = t.replace(/^<!--/, '').replace(/-->$/, '').replace(/^\s*\/\/<!\[CDATA\[/, '').replace(/\/\/\]\]>\s*$/, '');
    try { return JSON.parse(t); } catch (_) { /* try lenient */ }
    try {
      // Strip control chars and trailing commas, a common cause of invalid JSON-LD.
      const fixed = t.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(fixed);
    } catch (_) { return null; }
  }

  function typeIs(node, name) {
    if (!node || typeof node !== 'object') return false;
    const t = node['@type'];
    const list = Array.isArray(t) ? t : [t];
    return list.some(x => typeof x === 'string' && x.replace(/^.*[/#:]/, '').toLowerCase() === name.toLowerCase());
  }

  function walk(node, visit, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, visit, depth + 1)); return; }
    visit(node);
    for (const k of Object.keys(node)) {
      if (k === 'offers' || k === 'hasVariant') continue; // handled by product extraction
      const v = node[k];
      if (v && typeof v === 'object') walk(v, visit, depth + 1);
    }
  }

  function firstStr(v) {
    if (v == null) return null;
    if (Array.isArray(v)) { for (const x of v) { const s = firstStr(x); if (s) return s; } return null; }
    if (typeof v === 'object') return firstStr(v.url || v.contentUrl || v['@id'] || v.name || v['@value']);
    return cleanText(decodeEntities(String(v))) || null;
  }

  function offerList(offers) {
    if (!offers) return [];
    const arr = Array.isArray(offers) ? offers : [offers];
    const out = [];
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;
      if (typeIs(o, 'AggregateOffer') && o.offers) out.push(...offerList(o.offers));
      out.push(o);
    }
    return out;
  }

  function offerPrice(o, url) {
    const cur = o.priceCurrency || (o.priceSpecification && firstSpec(o.priceSpecification, 'priceCurrency'));
    let raw = o.price;
    if (raw == null && o.priceSpecification) raw = firstSpec(o.priceSpecification, 'price');
    if (raw == null && typeIs(o, 'AggregateOffer')) raw = o.lowPrice;
    if (raw == null) return null;
    const parsed = PP().parsePrice(typeof raw === 'number' ? raw : String(raw), { currency: cur, url, machine: true });
    if (!parsed) return null;
    let list = null;
    const specs = o.priceSpecification ? (Array.isArray(o.priceSpecification) ? o.priceSpecification : [o.priceSpecification]) : [];
    for (const sp of specs) {
      if (sp && /strikethrough|listprice|msrp/i.test(String(sp.priceType || '')) && sp.price != null) {
        const lp = PP().parsePrice(String(sp.price), { currency: cur, url, machine: true });
        if (lp) list = lp.amount;
      }
    }
    return { amount: parsed.amount, currency: parsed.currency || (cur ? String(cur).toUpperCase() : null), list, availability: normAvailability(o.availability), url: o.url ? absUrl(firstStr(o.url), url) : null };
  }

  function firstSpec(spec, key) {
    const arr = Array.isArray(spec) ? spec : [spec];
    const plain = arr.find(s => s && s[key] != null && !/strikethrough|listprice|msrp/i.test(String(s.priceType || '')));
    return plain ? plain[key] : (arr[0] && arr[0][key]);
  }

  function pickOffer(offers, url) {
    if (!offers.length) return null;
    const key = productKey(url);
    // Prefer an offer whose URL is this page (variant), then lowest in-stock, then lowest.
    const exact = offers.find(o => o.url && productKey(o.url) === key);
    if (exact) return exact;
    const inStock = offers.filter(o => o.availability !== 'out_of_stock');
    const pool = inStock.length ? inStock : offers;
    return pool.reduce((a, b) => (b.amount < a.amount ? b : a));
  }

  function fromJsonLd(doc, url, scripts) {
    const blocks = scripts || Array.from(doc.querySelectorAll('script[type="application/ld+json" i]')).map(s => s.textContent);
    const products = [];
    for (const text of blocks) {
      const data = parseJsonLoose(text);
      if (!data) continue;
      walk(data, n => { if (typeIs(n, 'Product') || typeIs(n, 'ProductGroup') || typeIs(n, 'IndividualProduct') || typeIs(n, 'ProductModel') || typeIs(n, 'Vehicle') || typeIs(n, 'Book')) products.push(n); });
    }
    let best = null;
    for (const p of products) {
      let offers = offerList(p.offers).map(o => offerPrice(o, url)).filter(Boolean);
      if (!offers.length && p.hasVariant) {
        const variants = Array.isArray(p.hasVariant) ? p.hasVariant : [p.hasVariant];
        for (const v of variants) {
          for (const o of offerList(v && v.offers)) {
            const op = offerPrice(o, url);
            if (op) { if (!op.url && v.url) op.url = absUrl(firstStr(v.url), url); offers.push(op); }
          }
        }
      }
      const offer = pickOffer(offers, url);
      const cand = {
        title: firstStr(p.name),
        image: absUrl(firstStr(p.image), url),
        price: offer ? offer.amount : null,
        currency: offer ? offer.currency : null,
        listPrice: offer ? offer.list : null,
        availability: offer ? offer.availability : 'unknown',
        sku: firstStr(p.sku) || firstStr(p.gtin13) || firstStr(p.gtin12) || firstStr(p.gtin) || firstStr(p.mpn),
        brand: firstStr(p.brand),
        source: 'jsonld',
      };
      if (!best || (cand.price != null && best.price == null)) best = cand;
    }
    return best;
  }

  // Microdata -----------------------------------------------------------------------------

  function itempropValue(el) {
    if (!el) return null;
    const attr = el.getAttribute('content') ?? el.getAttribute('value') ?? (el.tagName === 'META' ? el.getAttribute('content') : null);
    if (attr != null) return attr;
    if (el.tagName === 'LINK' || el.tagName === 'A') return el.getAttribute('href');
    if (el.tagName === 'IMG') return el.getAttribute('src');
    return el.textContent;
  }

  function fromMicrodata(doc, url) {
    const scopes = Array.from(doc.querySelectorAll('[itemscope][itemtype*="schema.org/Product" i], [itemscope][itemtype*="schema.org/IndividualProduct" i]'));
    for (const scope of scopes) {
      const q = sel => {
        // Only consider properties that belong to this scope (or its offers).
        for (const el of scope.querySelectorAll(sel)) return el;
        return null;
      };
      const offerScope = scope.querySelector('[itemprop="offers"]') || scope;
      const priceEl = offerScope.querySelector('[itemprop="price"], [itemprop="lowPrice"]');
      const curEl = offerScope.querySelector('[itemprop="priceCurrency"]');
      const cur = curEl ? cleanText(itempropValue(curEl)) : null;
      let price = null;
      if (priceEl) {
        const raw = itempropValue(priceEl);
        const hasContent = priceEl.hasAttribute('content');
        const parsed = PP().parsePrice(String(raw), { currency: cur, url, machine: hasContent });
        if (parsed) price = parsed;
      }
      const availEl = offerScope.querySelector('[itemprop="availability"]');
      const nameEl = q('[itemprop="name"]');
      const imgEl = q('[itemprop="image"]');
      return {
        title: nameEl ? cleanText(itempropValue(nameEl)) : null,
        image: imgEl ? absUrl(itempropValue(imgEl), url) : null,
        price: price ? price.amount : null,
        currency: price ? price.currency : (cur || null),
        listPrice: null,
        availability: availEl ? normAvailability(itempropValue(availEl)) : 'unknown',
        sku: (q('[itemprop="sku"]') && cleanText(itempropValue(q('[itemprop="sku"]')))) || null,
        source: 'microdata',
      };
    }
    return null;
  }

  // OpenGraph / meta ----------------------------------------------------------------------

  function meta(doc, names) {
    for (const n of names) {
      const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      if (el && el.getAttribute('content')) return el.getAttribute('content');
    }
    return null;
  }

  function fromMeta(doc, url) {
    const amount = meta(doc, ['product:price:amount', 'og:price:amount', 'product:sale_price:amount', 'twitter:data1']);
    const cur = meta(doc, ['product:price:currency', 'og:price:currency', 'product:sale_price:currency']);
    let price = null;
    if (amount) price = PP().parsePrice(amount, { currency: cur, url, machine: /^\s*[\d.]+\s*$/.test(amount) });
    const avail = meta(doc, ['product:availability', 'og:availability']);
    const ogType = meta(doc, ['og:type']);
    return {
      title: meta(doc, ['og:title', 'twitter:title']),
      image: absUrl(meta(doc, ['og:image:secure_url', 'og:image', 'twitter:image']), url),
      price: price ? price.amount : null,
      currency: price ? price.currency : (cur ? cur.toUpperCase() : null),
      listPrice: null,
      availability: avail ? normAvailability(avail) : 'unknown',
      isProductType: /product/i.test(ogType || ''),
      source: 'opengraph',
    };
  }

  // Store patterns -------------------------------------------------------------------------

  function textOf(doc, selectors) {
    for (const s of selectors) {
      let el;
      try { el = doc.querySelector(s); } catch (_) { continue; }
      if (el) {
        const t = cleanText(el.getAttribute && el.getAttribute('content') || el.textContent);
        if (t) return t;
      }
    }
    return null;
  }

  function priceFrom(doc, selectors, url, cur) {
    for (const s of selectors) {
      let els;
      try { els = doc.querySelectorAll(s); } catch (_) { continue; }
      for (const el of els) {
        const t = priceText(el);
        const p = t && PP().parsePrice(t, { url, currency: cur });
        if (p) return { ...p, el };
      }
    }
    return null;
  }

  /** Read a price element's text, joining split whole/fraction spans ($12<sup>99</sup>). */
  function priceText(el) {
    const content = el.getAttribute && el.getAttribute('content');
    if (content && /\d/.test(content)) return content;
    const whole = el.querySelector && el.querySelector('.a-price-whole');
    if (whole) {
      const frac = el.querySelector('.a-price-fraction');
      const sym = el.querySelector('.a-price-symbol');
      return cleanText((sym ? sym.textContent : '') + whole.textContent.replace(/[.,]\s*$/, '') + (frac ? '.' + frac.textContent : ''));
    }
    const sup = el.querySelector && el.querySelector('sup');
    let t = cleanText(el.textContent);
    if (sup && /^\d{2}$/.test(cleanText(sup.textContent)) && !/[.,]\d{2}\b/.test(t)) {
      const supText = cleanText(sup.textContent);
      const idx = t.lastIndexOf(supText);
      if (idx > 0) t = t.slice(0, idx).trim() + '.' + supText;
    }
    return t.length > 80 ? null : t;
  }

  const STORES = [
    {
      name: 'Amazon', test: h => /(^|\.)amazon\./.test(h),
      title: ['#productTitle', '#title', '#btAsinTitle'],
      price: ['#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen', '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen', '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen', '#apex_desktop .a-price:not(.a-text-price) .a-offscreen', '#priceblock_dealprice', '#priceblock_ourprice', '#priceblock_saleprice', '#price_inside_buybox', '#newBuyBoxPrice', '#kindle-price', '#tp_price_block_total_price_ww .a-offscreen', '.priceToPay', '#corePrice_desktop .a-offscreen'],
      list: ['#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen', '#corePrice_feature_div .a-text-price .a-offscreen', '.a-text-price[data-a-strike="true"] .a-offscreen', '#listPrice', '#priceblock_listprice'],
      image: el => el('#landingImage', ['data-old-hires', 'src']) || el('#imgBlkFront', ['src']) || el('#main-image', ['src']),
      availability: ['#availability', '#outOfStock', '#availability_feature_div'],
    },
    {
      name: 'Best Buy', test: h => /(^|\.)bestbuy\./.test(h),
      title: ['.sku-title h1', 'h1.heading-5', '[data-testid="product-title"]', 'h1'],
      price: ['[data-testid="customer-price"] span', '.priceView-customer-price span', '.priceView-hero-price span', '[data-testid="large-price-linkable"] span'],
      list: ['.pricing-price__regular-price', '[data-testid="regular-price"]', '.priceView-was-price'],
      availability: ['.fulfillment-add-to-cart-button button', '.add-to-cart-button', '[data-button-state]'],
    },
    {
      name: 'Walmart', test: h => /(^|\.)walmart\./.test(h),
      title: ['h1[itemprop="name"]', '[data-testid="product-title"]', 'h1#main-title', 'h1'],
      price: ['[data-seo-id="hero-price"]', '[itemprop="price"]', '[data-testid="price-wrap"] [aria-hidden="true"]', '[data-automation="buybox-price"]', '.price-characteristic'],
      list: ['[data-seo-id="strike-through-price"]', '.strike-through', '[data-testid="list-price"]'],
      availability: ['[data-testid="add-to-cart-section"]', '[data-automation-id="atc"]', '[data-testid="out-of-stock"]'],
    },
    {
      name: 'Target', test: h => /(^|\.)target\.com$/.test(h),
      title: ['[data-test="product-title"]', 'h1'],
      price: ['[data-test="product-price"]', '[data-test="product-price-sale"]', '[data-test="current-price"]'],
      list: ['[data-test="product-regular-price"]', '[data-test="product-price-reg"]'],
      availability: ['[data-test="shippingButton"]', '[data-test="orderPickupButton"]', '[data-test="soldOutBlock"]', '[data-test="outOfStockMessage"]'],
    },
    {
      name: 'eBay', test: h => /(^|\.)ebay\./.test(h),
      title: ['.x-item-title__mainTitle', 'h1.x-item-title__mainTitle span', '#itemTitle', 'h1'],
      price: ['.x-price-primary .ux-textspans', '.x-price-primary', '[itemprop="price"]', '#prcIsum', '#mm-saleDscPrc', '.x-bin-price__content .ux-textspans'],
      list: ['.x-price-transparency--previousPrice .ux-textspans--STRIKETHROUGH', '.x-additional-info .ux-textspans--STRIKETHROUGH', '#orgPrc'],
      image: el => el('.ux-image-carousel-item.active img', ['data-zoom-src', 'src']) || el('#icImg', ['src']),
      availability: ['.d-quantity__availability', '.x-quantity__availability', '#qtySubTxt', '.msgTextAlign'],
    },
    {
      name: 'Etsy', test: h => /(^|\.)etsy\.com$/.test(h),
      title: ['h1[data-buy-box-listing-title]', '[data-buy-box-region] h1', 'h1'],
      price: ['[data-buy-box-region="price"] .wt-text-title-larger', '[data-buy-box-region="price"] .wt-text-title-03', '[data-buy-box-region="price"] p', '[data-selector="price-only"] .currency-value'],
      list: ['[data-buy-box-region="price"] .wt-text-strikethrough'],
      availability: ['[data-buy-box-region] .wt-alert', '.add-to-cart-form button'],
    },
    {
      name: 'Shopify', test: (h, doc) => isShopify(doc),
      title: ['.product__title h1', '.product-single__title', '.product__title', 'h1.product-title', 'h1'],
      price: ['.price__sale .price-item--sale', '.price--on-sale .price-item--sale', '.price__regular .price-item--regular', '.product__price .price-item', '[data-product-price]', '.product-single__price', '.product__price', '.price-item', '.product-price', '[data-price]'],
      list: ['.price__sale s.price-item--regular', '.price--on-sale .price-item--regular', '[data-compare-price]', '.product__price--compare', 's.price-item', '.compare-at-price'],
      availability: ['.product-form__submit', 'button[name="add"]', '.product-form__buttons button'],
    },
  ];

  function isShopify(doc) {
    if (!doc || !doc.querySelector) return false;
    return !!(doc.querySelector('meta[name="shopify-digital-wallet"], meta[name="shopify-checkout-api-token"], link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], script[data-product-json], [id^="ProductJson"]') ||
      Array.from(doc.querySelectorAll('script:not([src])')).some(s => /Shopify\.shop\s*=\s*["']/.test(s.textContent || '')));
  }

  function shopifyJson(doc, url) {
    const el = doc.querySelector('script[data-product-json], script[id^="ProductJson"], script[type="application/json"][data-product]');
    const data = el && parseJsonLoose(el.textContent);
    const product = data && (data.product || data);
    if (!product || !Array.isArray(product.variants)) return null;
    let vid = null;
    try { vid = new URL(url).searchParams.get('variant'); } catch (_) { /* ignore */ }
    const v = product.variants.find(x => String(x.id) === vid) || product.variants.find(x => x.available) || product.variants[0];
    if (!v) return null;
    const cents = typeof v.price === 'number' ? v.price / 100 : PP().parsePrice(String(v.price), { machine: true });
    const amount = typeof cents === 'number' ? cents : cents && cents.amount;
    const compare = typeof v.compare_at_price === 'number' ? v.compare_at_price / 100 : null;
    return {
      title: product.title ? cleanText(product.title) + (v.title && v.title !== 'Default Title' && product.variants.length > 1 ? ' – ' + v.title : '') : null,
      image: absUrl(product.featured_image || (product.images && product.images[0]), url),
      price: amount || null,
      currency: meta(doc, ['og:price:currency', 'product:price:currency']),
      listPrice: compare && compare > amount ? compare : null,
      availability: v.available === false ? 'out_of_stock' : v.available === true ? 'in_stock' : 'unknown',
      sku: v.sku || null,
      source: 'shopify',
    };
  }

  function fromStore(doc, url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) { /* ignore */ }
    const store = STORES.find(s => s.test(host, doc));
    if (!store) return null;
    if (store.name === 'Shopify') {
      const j = shopifyJson(doc, url);
      if (j && j.price) return j;
    }
    const cur = meta(doc, ['product:price:currency', 'og:price:currency']);
    const p = priceFrom(doc, store.price, url, cur);
    const lp = store.list ? priceFrom(doc, store.list, url, cur) : null;
    const attr = (sel, attrs) => {
      const el = doc.querySelector(sel);
      if (!el) return null;
      for (const a of attrs) if (el.getAttribute(a)) return absUrl(el.getAttribute(a), url);
      return null;
    };
    let availability = 'unknown';
    const avText = textOf(doc, store.availability || []);
    if (avText) availability = OOS_TEXT.test(avText) ? 'out_of_stock' : (/in stock|add to cart|add to bag|available|buy it now|ship it|pick it up/i.test(avText) ? 'in_stock' : 'unknown');
    if (availability === 'unknown') availability = textAvailability(doc);
    return {
      title: textOf(doc, store.title),
      image: store.image ? store.image(attr) : null,
      price: p ? p.amount : null,
      currency: p ? p.currency : null,
      listPrice: lp && p && lp.amount > p.amount ? lp.amount : null,
      availability,
      store: store.name,
      source: 'store:' + store.name,
    };
  }

  // Generic heuristic ---------------------------------------------------------------------

  const NEG_CLASS = /(old|was|list|compare|strike|original|regular|before|msrp|rrp|crossed|retail|saving|save|discount|per-unit|unit-price|installment|monthly|shipping|reviews?|rating|filter|range|slider)/i;
  const POS_CLASS = /(sale|current|final|now|special|actual|offer|our-price|selling|promo|main|primary|hero)/i;

  function fromGeneric(doc, url) {
    const cur = meta(doc, ['product:price:currency', 'og:price:currency']);
    const els = doc.querySelectorAll('[itemprop="price"], [class*="price" i], [id*="price" i], [data-price], [data-testid*="price" i], [data-test*="price" i], [data-qa*="price" i]');
    const h1 = doc.querySelector('h1');
    const order = new Map();
    if (h1) Array.from(doc.querySelectorAll('*')).forEach((e, idx) => order.set(e, idx));
    const h1Index = h1 ? order.get(h1) : -1;
    const candidates = [];
    let i = 0;
    for (const el of els) {
      if (++i > 400) break;
      if (el.closest('nav, header, footer, [class*="related" i], [class*="recommend" i], [class*="carousel" i], [class*="upsell" i], [class*="cart" i]:not(form), del, s, strike')) continue;
      const cls = (el.className && typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('data-testid') || '');
      const t = priceText(el);
      if (!t || !PP().looksLikePrice(t)) continue;
      // Skip containers whose own children are better candidates.
      if (el.children.length > 4) continue;
      const parsed = PP().parsePrice(t, { url, currency: cur });
      if (!parsed) continue;
      let score = 10;
      if (el.getAttribute('itemprop') === 'price') score += 20;
      if (NEG_CLASS.test(cls)) score -= 15;
      if (POS_CLASS.test(cls)) score += 6;
      if (PP().detectCurrency(t)) score += 4;
      if (el.closest('[class*="product" i], main, [role="main"], form[action*="cart"]')) score += 4;
      if (h1Index !== -1 && order.has(el)) {
        const d = Math.abs(order.get(el) - h1Index);
        score += Math.max(0, 12 - d / 15);
      }
      score -= candidates.length * 0.3; // earlier in the document is better
      candidates.push({ score, parsed, el });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score < 8) return null;
    return {
      title: null, image: null,
      price: best.parsed.amount, currency: best.parsed.currency,
      listPrice: null,
      availability: textAvailability(doc),
      source: 'heuristic',
      confidence: 'low',
    };
  }

  // Custom selector (picked by the user) ---------------------------------------------------

  function fromSelector(doc, url, selector) {
    if (!selector) return null;
    let el = null;
    try { el = doc.querySelector(selector); } catch (_) { return null; }
    if (!el) return null;
    const cur = meta(doc, ['product:price:currency', 'og:price:currency']);
    const t = priceText(el) || cleanText(el.textContent);
    const p = PP().parsePrice(t, { url, currency: cur });
    if (!p) return null;
    return { price: p.amount, currency: p.currency, source: 'picked', availability: textAvailability(doc) };
  }

  // Bot-block detection ------------------------------------------------------------------

  const BLOCK_MARKERS = [
    /api-services-support@amazon\.com/i, /Type the characters you see in this image/i, /\/errors\/validateCaptcha/i,
    /captcha-delivery\.com/i, /px-captcha/i, /_pxCaptcha|perimeterx/i, /cf-browser-verification|cf_chl_opt|challenge-platform/i,
    /Attention Required! \| Cloudflare/i, /Access Denied<\/title>/i, /Robot or human\?/i, /Pardon Our Interruption/i,
    /Please verify you are a human/i, /distil_r_captcha/i, /Request unsuccessful\. Incapsula/i, /akamai.*reference #/i,
    /hcaptcha\.com\/1\/api\.js/i, /g-recaptcha" data-sitekey/i,
  ];

  function isBlockedHtml(html, status) {
    if (status === 403 || status === 429 || status === 503 || status === 401) return true;
    const head = String(html || '').slice(0, 60000);
    return BLOCK_MARKERS.some(re => re.test(head));
  }

  // Combine --------------------------------------------------------------------------------

  /**
   * Detect the product on a document.
   * @param {Document} doc
   * @param {string} url page URL
   * @param {{selector?: string}} [opts]
   * @returns {object|null} {title,image,price,currency,listPrice,availability,source,isProduct,url,key,canonical}
   */
  function detectProduct(doc, url, opts) {
    opts = opts || {};
    url = url || (doc.location && doc.location.href) || '';
    const canonicalEl = doc.querySelector('link[rel="canonical"]');
    const canonical = canonicalEl ? absUrl(canonicalEl.getAttribute('href'), url) : null;
    const results = [];
    const add = fn => { try { const r = fn(); if (r) results.push(r); } catch (e) { /* keep going */ } };
    add(() => fromSelector(doc, url, opts.selector));
    add(() => fromJsonLd(doc, url));
    add(() => fromMicrodata(doc, url));
    add(() => fromStore(doc, url));
    const og = (() => { try { return fromMeta(doc, url); } catch (_) { return null; } })();
    if (og) results.push(og);
    const hasStructuredPrice = results.some(r => r.price != null);
    if (!hasStructuredPrice) add(() => fromGeneric(doc, url));

    const priced = results.find(r => r.price != null);
    const merged = {
      title: null, image: null, price: null, currency: null, listPrice: null,
      availability: 'unknown', source: null, sku: null, brand: null,
    };
    if (priced) {
      merged.price = priced.price;
      merged.currency = priced.currency;
      merged.source = priced.source;
      merged.listPrice = priced.listPrice || null;
      merged.confidence = priced.confidence || (priced.source === 'heuristic' ? 'low' : 'high');
    }
    for (const r of results) {
      for (const k of ['title', 'image', 'currency', 'sku', 'brand', 'listPrice']) if (merged[k] == null && r[k]) merged[k] = r[k];
      if (merged.availability === 'unknown' && r.availability && r.availability !== 'unknown') merged.availability = r.availability;
    }
    if (priced && priced.availability && priced.availability !== 'unknown') merged.availability = priced.availability;
    if (merged.listPrice != null && merged.price != null && merged.listPrice <= merged.price) merged.listPrice = null;
    if (!merged.title) {
      const h1 = doc.querySelector('h1');
      merged.title = (h1 && cleanText(h1.textContent)) || cleanText(doc.title) || null;
    }
    if (merged.title && merged.title.length > 300) merged.title = merged.title.slice(0, 297) + '…';
    if (!merged.image) {
      const link = doc.querySelector('link[rel="image_src"]');
      merged.image = link ? absUrl(link.getAttribute('href'), url) : null;
    }
    if (!merged.currency && merged.price != null) merged.currency = PP().currencyFromUrl(url) || null;
    merged.isProduct = merged.price != null && (merged.source !== 'heuristic' || !!(og && og.isProductType));
    merged.url = url;
    merged.canonical = canonical;
    merged.key = productKey(url);
    return merged;
  }

  /**
   * Fallback for environments without DOMParser: pull JSON-LD and meta tags out of raw HTML.
   */
  function detectFromHtmlString(html, url) {
    const scripts = [];
    const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) scripts.push(m[1]);
    const metas = {};
    const mre = /<meta\s+[^>]*>/gi;
    while ((m = mre.exec(html))) {
      const tag = m[0];
      const k = (tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const v = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (k && v != null && !(k in metas)) metas[k] = decodeEntities(v);
    }
    const fakeDoc = {
      querySelector: sel => {
        const mm = sel.match(/meta\[property="([^"]+)"\]/);
        if (mm && metas[mm[1]] != null) return { getAttribute: () => metas[mm[1]] };
        return null;
      },
      querySelectorAll: () => [],
    };
    const ld = fromJsonLd(fakeDoc, url, scripts);
    const og = fromMeta(fakeDoc, url);
    const best = ld && ld.price != null ? ld : og;
    if (!best || best.price == null) return null;
    const title = (ld && ld.title) || og.title || decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
    return { ...best, title, image: (ld && ld.image) || og.image, isProduct: true, url, key: productKey(url) };
  }

  const api = { detectProduct, detectFromHtmlString, productKey, isBlockedHtml, normAvailability, priceText, isShopify, parseJsonLoose };
  root.PriceDetect = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
