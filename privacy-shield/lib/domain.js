// Registrable-domain ("eTLD+1") helpers.
//
// Chrome's declarativeNetRequest uses the full Public Suffix List internally; the extension
// cannot read it, so this module carries a compact list of the multi-label public suffixes
// that cover the overwhelming majority of real traffic. Hosts under an unknown suffix fall
// back to "last two labels", which is what most tracker heuristics (Privacy Badger included)
// effectively do for ordinary TLDs.

const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom, Commonwealth and friends
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz', 'geek.nz',
  'co.za', 'org.za', 'gov.za', 'ac.za', 'net.za', 'web.za',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in', 'gov.in', 'edu.in',
  'com.sg', 'edu.sg', 'gov.sg', 'org.sg', 'net.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.pk', 'com.bd', 'com.lk', 'com.np', 'com.ph', 'com.vn', 'com.kh', 'com.mm',
  'co.ke', 'or.ke', 'co.ug', 'co.tz', 'com.ng', 'com.gh', 'co.zw', 'com.eg', 'co.ma',
  // Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp', 'ed.jp', 'ad.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'co.id', 'or.id', 'web.id', 'ac.id', 'go.id', 'my.id',
  'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.tr', 'net.tr', 'org.tr', 'gen.tr', 'web.tr', 'edu.tr', 'gov.tr',
  'com.sa', 'net.sa', 'org.sa', 'com.ae', 'net.ae', 'org.ae', 'co.ae', 'com.qa', 'com.kw',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br', 'eco.br', 'ind.br',
  'com.mx', 'org.mx', 'gob.mx', 'net.mx', 'edu.mx',
  'com.ar', 'org.ar', 'net.ar', 'gob.ar', 'com.co', 'org.co', 'net.co', 'gov.co',
  'com.pe', 'org.pe', 'gob.pe', 'com.ve', 'com.uy', 'com.py', 'com.bo', 'com.ec',
  'com.gt', 'com.do', 'com.pr', 'com.pa', 'com.sv', 'com.ni', 'com.hn', 'co.cr', 'com.cu',
  'qc.ca', 'on.ca', 'bc.ca', 'ab.ca',
  // Europe
  'co.at', 'or.at', 'gv.at', 'ac.at', 'com.pl', 'net.pl', 'org.pl', 'waw.pl', 'gov.pl',
  'com.ua', 'org.ua', 'net.ua', 'in.ua', 'kiev.ua', 'com.ru', 'org.ru', 'net.ru', 'msk.ru', 'spb.ru',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'com.pt', 'org.pt', 'com.gr', 'org.gr', 'co.hu',
  'com.ro', 'org.ro', 'co.rs', 'com.hr', 'com.cy', 'com.mt', 'co.no', 'priv.no',
  'com.de', 'com.fr', 'asso.fr', 'gouv.fr', 'co.it', 'gov.it', 'edu.it',
  // Hosting platforms that the Public Suffix List treats as suffixes (each customer is a site)
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev',
  'herokuapp.com', 'appspot.com', 'firebaseapp.com', 'web.app', 'blogspot.com',
  'wordpress.com', 'tumblr.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com',
  'fly.dev', 'onrender.com', 'glitch.me', 'repl.co', 'myshopify.com', 'wixsite.com',
  'squarespace.com', 'neocities.org', 'surge.sh', 'translate.goog', 'ngrok.io', 'ngrok-free.app',
]);

/** Lower-cases, strips a trailing dot, brackets of IPv6 literals and any port. */
export function normalizeHost(host) {
  if (!host) return '';
  let h = String(host).trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  return h;
}

export function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** "a.b.example.co.uk" -> "example.co.uk"; IPs and single labels are returned as-is. */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h || isIpAddress(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // Walk from the longest candidate suffix to the shortest.
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (MULTI_LABEL_SUFFIXES.has(suffix)) return parts.slice(i - 1).join('.');
  }
  return parts.slice(-2).join('.');
}

export function hostFromUrl(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

export function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** True when two hosts belong to different registrable domains. */
export function isThirdPartyHost(requestHost, firstPartyHost) {
  if (!requestHost || !firstPartyHost) return false;
  return registrableDomain(requestHost) !== registrableDomain(firstPartyHost);
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith('.' + d);
}

/** Accepts "https://www.Example.com/path", "example.com:8080" or "*.example.com". */
export function parseSiteInput(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^\*\./, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  try {
    const host = normalizeHost(new URL(s).hostname);
    if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') && host !== 'localhost') return '';
    return host;
  } catch {
    return '';
  }
}
