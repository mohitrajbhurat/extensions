/* Price Tracker: locale-aware price parsing.
 * Classic script that attaches `PriceParse` to globalThis so it can be used from
 * content scripts, ES module pages (side-effect import) and node:test (require).
 */
(function (root) {
  'use strict';

  // Symbol -> ISO code. Longer symbols are matched first.
  const SYMBOLS = [
    ['US$', 'USD'], ['U$S', 'USD'], ['CA$', 'CAD'], ['C$', 'CAD'], ['AU$', 'AUD'], ['A$', 'AUD'],
    ['NZ$', 'NZD'], ['HK$', 'HKD'], ['S$', 'SGD'], ['MX$', 'MXN'], ['R$', 'BRL'], ['NT$', 'TWD'],
    ['CHF', 'CHF'], ['Fr.', 'CHF'], ['zł', 'PLN'], ['Kč', 'CZK'], ['Ft', 'HUF'], ['lei', 'RON'],
    ['kr.', 'DKK'], ['kr', 'SEK'], ['Rs.', 'INR'], ['Rs', 'INR'], ['RM', 'MYR'], ['Rp', 'IDR'],
    ['руб', 'RUB'], ['₽', 'RUB'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['円', 'JPY'], ['￥', 'JPY'],
    ['元', 'CNY'], ['₹', 'INR'], ['₩', 'KRW'], ['₺', 'TRY'], ['₫', 'VND'], ['₪', 'ILS'], ['฿', 'THB'],
    ['₱', 'PHP'], ['₴', 'UAH'], ['₦', 'NGN'], ['₡', 'CRC'], ['₲', 'PYG'], ['₸', 'KZT'], ['د.إ', 'AED'],
    ['﷼', 'SAR'], ['$', 'USD'],
  ];

  const ISO = new Set(('USD EUR GBP JPY CNY INR CAD AUD NZD CHF SEK NOK DKK PLN CZK HUF RON BGN HRK ' +
    'RUB UAH TRY BRL MXN ARS CLP COP PEN UYU ZAR NGN KES EGP MAD AED SAR QAR KWD BHD OMR JOD ILS ' +
    'THB VND IDR MYR SGD PHP HKD TWD KRW PKR BDT LKR NPR KZT ISK RSD TND').split(' '));

  // Currencies with 3 minor digits (so "1.299" could be a real decimal).
  const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);
  // Currencies that are effectively never shown with decimals.
  const NO_DECIMALS = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'PYG', 'ISK', 'HUF', 'UGX']);

  // Country-code TLD -> currency, used to disambiguate "$" and "kr".
  const TLD_CURRENCY = {
    ca: 'CAD', au: 'AUD', nz: 'NZD', sg: 'SGD', hk: 'HKD', mx: 'MXN', br: 'BRL', ar: 'ARS', cl: 'CLP',
    co: 'COP', tw: 'TWD', uk: 'GBP', in: 'INR', jp: 'JPY', cn: 'CNY', kr: 'KRW', se: 'SEK', no: 'NOK',
    dk: 'DKK', ch: 'CHF', pl: 'PLN', cz: 'CZK', hu: 'HUF', ro: 'RON', tr: 'TRY', ru: 'RUB', ua: 'UAH',
    za: 'ZAR', ae: 'AED', sa: 'SAR', il: 'ILS', th: 'THB', vn: 'VND', id: 'IDR', my: 'MYR', ph: 'PHP',
    de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', be: 'EUR', at: 'EUR', ie: 'EUR', pt: 'EUR',
    fi: 'EUR', gr: 'EUR', sk: 'EUR', si: 'EUR', ee: 'EUR', lv: 'EUR', lt: 'EUR', lu: 'EUR',
  };

  const DOLLAR_LIKE = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN', 'TWD', 'ARS', 'CLP', 'COP']);
  const KRONA_LIKE = new Set(['SEK', 'NOK', 'DKK', 'ISK']);

  function currencyFromUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const parts = host.split('.');
      const tld = parts[parts.length - 1];
      if (TLD_CURRENCY[tld]) return TLD_CURRENCY[tld];
    } catch (_) { /* ignore */ }
    return null;
  }

  function normalizeSpaces(s) {
    return String(s)
      .replace(/[       ]/g, ' ')
      .replace(/[​‎‏⁠]/g, '')
      .replace(/[−‒–—]/g, '-')
      .replace(/[’ʼ]/g, "'");
  }

  /** Find a currency in text. Returns ISO code or null. */
  function detectCurrency(text, hint) {
    const s = normalizeSpaces(text || '');
    for (const m of s.matchAll(/(?:^|[^A-Za-z])([A-Z]{3})(?![A-Za-z])/g)) {
      if (ISO.has(m[1])) return m[1];
    }
    for (const [sym, code] of SYMBOLS) {
      const idx = s.indexOf(sym);
      if (idx === -1) continue;
      // Avoid matching letters inside words for alphabetic symbols ("kr" in "kraft").
      if (/^[A-Za-z]/.test(sym)) {
        const before = s[idx - 1], after = s[idx + sym.length];
        if ((before && /[A-Za-z]/.test(before)) || (after && /[A-Za-z]/.test(after))) continue;
      }
      if (sym === '$' && hint && DOLLAR_LIKE.has(hint)) return hint;
      if (sym === 'kr' && hint && KRONA_LIKE.has(hint)) return hint;
      if (sym === '¥' && hint === 'CNY') return 'CNY';
      return code;
    }
    return null;
  }

  /**
   * Turn a raw number token into a float, deciding which separator is the decimal mark.
   * `currency` helps with ambiguous single separators.
   */
  function numberFromToken(token, currency, opts) {
    let t = token.trim().replace(/[,.]\s*[-–]+$/, ''); // "12,-" / "12.–"
    t = t.replace(/'/g, '');
    // Spaces are only grouping separators when followed by exactly 3 digits.
    t = t.replace(/(\d) (?=\d{3}(?:\D|$))/g, '$1');
    t = t.replace(/\s+/g, '');
    if (!/^\d[\d.,]*$/.test(t)) {
      const m = t.match(/\d[\d.,]*/);
      if (!m) return NaN;
      t = m[0];
    }
    t = t.replace(/[.,]+$/, '');
    if (opts && opts.machine) return parseFloat(t.replace(/,/g, ''));

    const lastDot = t.lastIndexOf('.');
    const lastComma = t.lastIndexOf(',');
    let decimal = null;
    if (lastDot !== -1 && lastComma !== -1) {
      decimal = lastDot > lastComma ? '.' : ',';
    } else if (lastDot !== -1 || lastComma !== -1) {
      const sep = lastDot !== -1 ? '.' : ',';
      const count = t.split(sep).length - 1;
      const after = t.length - t.lastIndexOf(sep) - 1;
      const intPart = t.slice(0, t.indexOf(sep));
      if (count > 1) {
        decimal = null; // 1.299.999 or 1,29,999 -> grouping
      } else if (after !== 3) {
        decimal = sep; // 12.5, 12,99
      } else if (intPart === '0') {
        decimal = sep; // 0.299 / 0,299
      } else if (currency && THREE_DECIMALS.has(currency)) {
        decimal = sep;
      } else {
        decimal = null; // 1,299 / 1.299 -> thousands
      }
    }
    let normalized;
    if (decimal === '.') normalized = t.replace(/,/g, '');
    else if (decimal === ',') normalized = t.replace(/\./g, '').replace(',', '.');
    else normalized = t.replace(/[.,]/g, '');
    return parseFloat(normalized);
  }

  const NUMBER_RE = /\d(?:[\d.,']|\s(?=\d))*(?:[.,]\s*[-–]+)?/g;

  /**
   * Parse a price string.
   * @param {string|number} input e.g. "1.299,00 €", "$1,299.00", "₹1,29,999", 1299
   * @param {{currency?: string, url?: string, machine?: boolean}} [opts]
   *   currency: currency hint (ISO) from the page; url: page URL for TLD hints;
   *   machine: the value is a machine-format number (schema.org), '.' is decimal.
   * @returns {{amount:number, currency:string|null}|null}
   */
  function parsePrice(input, opts) {
    opts = opts || {};
    const hint = (opts.currency && String(opts.currency).toUpperCase()) || (opts.url && currencyFromUrl(opts.url)) || null;
    if (typeof input === 'number') {
      return isFinite(input) && input > 0 ? { amount: round(input, hint), currency: hint } : null;
    }
    if (input == null) return null;
    const s = normalizeSpaces(input).trim();
    if (!s || s.length > 200) return null;
    if (/^(free|gratis|kostenlos|gratuit)$/i.test(s)) return null;

    const currency = detectCurrency(s, hint) || hint;
    const matches = s.match(NUMBER_RE);
    if (!matches) return null;
    // Prefer the number closest to the currency symbol; else the first.
    let token = matches[0];
    if (matches.length > 1) {
      const symIdx = findSymbolIndex(s);
      if (symIdx !== -1) {
        let best = Infinity;
        let pos = 0;
        for (const m of matches) {
          const i = s.indexOf(m, pos);
          pos = i + m.length;
          const dist = Math.min(Math.abs(i - symIdx), Math.abs(i + m.length - symIdx));
          if (dist < best) { best = dist; token = m; }
        }
      }
    }
    let machine = !!opts.machine;
    if (machine && /,\d{1,2}$/.test(token) && token.indexOf('.') === -1) machine = false; // "12,99" in a "machine" field
    let amount = numberFromToken(token, currency, { machine });
    if (!isFinite(amount) || amount <= 0) return null;
    if (amount > 1e10) return null;
    return { amount: round(amount, currency), currency: currency || null };
  }

  function findSymbolIndex(s) {
    for (const [sym] of SYMBOLS) {
      const i = s.indexOf(sym);
      if (i !== -1) return i;
    }
    for (const m of s.matchAll(/[A-Z]{3}/g)) if (ISO.has(m[0])) return m.index;
    return -1;
  }

  function round(n, currency) {
    const digits = currency && THREE_DECIMALS.has(currency) ? 3 : 2;
    const f = Math.pow(10, digits);
    return Math.round(n * f) / f;
  }

  /** True when a string plausibly is a price (has a number and a currency or price-like format). */
  function looksLikePrice(text) {
    const s = normalizeSpaces(text || '').trim();
    if (!s || s.length > 60) return false;
    if (!/\d/.test(s)) return false;
    return !!detectCurrency(s) || /^\d{1,3}(?:[.,' ]\d{3})*(?:[.,]\d{2})$/.test(s);
  }

  /** Format an amount for display. Falls back gracefully on unknown currencies. */
  function formatPrice(amount, currency, locale) {
    if (amount == null || !isFinite(amount)) return '—';
    try {
      if (currency && ISO.has(currency)) {
        return new Intl.NumberFormat(locale || undefined, {
          style: 'currency', currency,
          minimumFractionDigits: NO_DECIMALS.has(currency) ? 0 : undefined,
          maximumFractionDigits: NO_DECIMALS.has(currency) ? 0 : (THREE_DECIMALS.has(currency) ? 3 : 2),
        }).format(amount);
      }
    } catch (_) { /* fall through */ }
    return new Intl.NumberFormat(locale || undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + (currency ? ' ' + currency : '');
  }

  const api = { parsePrice, detectCurrency, currencyFromUrl, looksLikePrice, formatPrice, numberFromToken, ISO_CODES: ISO };
  root.PriceParse = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
