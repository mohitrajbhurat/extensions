// Heuristic tracker learning, in the spirit of Privacy Badger: a third-party domain that
// reads or writes cookies or storage while embedded on several unrelated first-party sites
// is behaving like a cross-site tracker, whether or not it is on our list.

import { hostMatchesDomain, registrableDomain } from './domain.js';
import { trackerDomainOf } from './trackers.js';
import { entityOfSite } from './entities.js';

/**
 * Infrastructure that sets cookies on many sites for legitimate reasons (CDNs, fonts,
 * payments, sign-in, video players, consent managers). Never learned, so learning cannot
 * break checkout, login or the cookie banner itself.
 */
export const NEVER_LEARN = [
  'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'ggpht.com', 'gvt1.com', 'gvt2.com',
  'youtube.com', 'youtube-nocookie.com', 'ytimg.com', 'recaptcha.net', 'hcaptcha.com', 'cloudflare.com',
  'jsdelivr.net', 'unpkg.com', 'jquery.com', 'bootstrapcdn.com', 'fontawesome.com', 'typekit.net', 'fonts.net',
  'akamaihd.net', 'akamaized.net', 'akamai.net', 'edgekey.net', 'edgesuite.net', 'fastly.net', 'fastly.com',
  'cloudfront.net', 'amazonaws.com', 'azureedge.net', 'azurefd.net', 'windows.net', 'msecnd.net', 'msauth.net',
  'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com', 'adyen.com',
  'klarna.com', 'affirm.com', 'afterpay.com', 'shopify.com', 'shopifycdn.com', 'shopifysvc.com', 'shop.app',
  'apple.com', 'icloud.com', 'mzstatic.com', 'microsoft.com', 'microsoftonline.com', 'live.com', 'office.net',
  'github.com', 'githubusercontent.com', 'githubassets.com', 'gitlab.com', 'gravatar.com', 'wp.com', 'wordpress.com',
  'squarespace-cdn.com', 'wixstatic.com', 'imgix.net', 'cloudinary.com', 'auth0.com', 'okta.com', 'onelogin.com',
  'firebaseio.com', 'firebaseapp.com', 'vimeo.com', 'vimeocdn.com', 'wistia.com', 'wistia.net', 'jwplayer.com',
  'jwpcdn.com', 'brightcove.net', 'spotify.com', 'soundcloud.com', 'twimg.com', 'giphy.com', 'tenor.com',
  'mapbox.com', 'openstreetmap.org', 'arcgis.com', 'zendesk.com', 'zdassets.com', 'tawk.to', 'crisp.chat',
  'livechatinc.com', 'cookielaw.org', 'onetrust.com', 'cookiebot.com', 'cookiebot.eu', 'usercentrics.eu',
  'didomi.io', 'privacy-mgmt.com', 'trustarc.com', 'truste.com', 'consensu.org', 'quantcast.com', 'osano.com',
  'cookieyes.com', 'consentmanager.net', 'disqus.com', 'archive.org', 'wikimedia.org', 'wikipedia.org',
];

export function isNeverLearn(host) {
  return NEVER_LEARN.some((d) => hostMatchesDomain(host, d));
}

/** Should a cookie/storage observation of `requestHost` on `siteHost` count? Returns the domain key or null. */
export function learnableDomain(requestHost, siteHost) {
  if (!requestHost || !siteHost) return null;
  const reqBase = registrableDomain(requestHost);
  const siteBase = registrableDomain(siteHost);
  if (!reqBase || !siteBase || reqBase === siteBase) return null;
  if (!reqBase.includes('.')) return null; // localhost, intranet names
  if (/^\d+\.\d+\.\d+\.\d+$/.test(reqBase)) return null;
  if (trackerDomainOf(requestHost)) return null; // already on the list
  if (isNeverLearn(requestHost)) return null;
  const e = entityOfSite(requestHost);
  if (e && e === entityOfSite(siteHost)) return null;
  return reqBase;
}

/**
 * Records that `domain` used cookies/storage while embedded on `siteHost`.
 * Mutates `learned`. Returns { changed, newlyFlagged }.
 */
export function recordObservation(learned, domain, siteHost, threshold = 3, now = Date.now()) {
  const site = registrableDomain(siteHost);
  let entry = learned[domain];
  if (!entry) entry = learned[domain] = { sites: [], first: now, last: now };
  const before = entry.sites.length;
  entry.last = now;
  if (!entry.sites.includes(site)) {
    entry.sites.push(site);
    if (entry.sites.length > 25) entry.sites = entry.sites.slice(-25);
  }
  const newlyFlagged = before < threshold && entry.sites.length >= threshold;
  return { changed: entry.sites.length !== before, newlyFlagged };
}

export function isFlagged(entry, threshold = 3) {
  return !!entry && !entry.ignored && entry.sites.length >= threshold;
}

/** Domains that should be blocked by the learned-tracker dynamic rule. */
export function learnedBlockList(learned, { autoBlock, threshold = 3 }) {
  const out = [];
  for (const [domain, entry] of Object.entries(learned || {})) {
    if (!isFlagged(entry, threshold)) continue;
    if (entry.blocked === true || (autoBlock && entry.blocked !== false)) out.push(domain);
  }
  return out.sort();
}

/** Drops old, unflagged single-site observations so the map does not grow without bound. */
export function pruneLearned(learned, threshold = 3, now = Date.now(), maxEntries = 3000) {
  const MONTH = 30 * 24 * 3600 * 1000;
  for (const [d, e] of Object.entries(learned)) {
    if (!isFlagged(e, threshold) && e.blocked === undefined && now - e.last > MONTH) delete learned[d];
  }
  const entries = Object.entries(learned);
  if (entries.length > maxEntries) {
    entries.sort((a, b) => a[1].sites.length - b[1].sites.length || a[1].last - b[1].last);
    for (const [d, e] of entries.slice(0, entries.length - maxEntries)) {
      if (!isFlagged(e, threshold)) delete learned[d];
    }
  }
  return learned;
}
