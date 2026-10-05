// Companies that run both the sites people visit ("properties") and the tracker domains
// those same sites load from. A request from facebook.com to fbcdn.net crosses registrable
// domains but is not cross-site tracking, so blocking it would just break Facebook. Rules
// for an entity's tracker domains therefore exclude the entity's own properties as initiators.

import { registrableDomain } from './domain.js';

export const ENTITIES = {
  Google: {
    properties: ['google.com', 'youtube.com', 'gmail.com', 'blogger.com', 'google.co.uk', 'google.de', 'google.fr',
      'google.co.jp', 'google.ca', 'google.com.au', 'google.co.in', 'google.com.br', 'google.es', 'google.it',
      'android.com', 'withgoogle.com', 'googleblog.com', 'firebase.google.com', 'web.dev', 'chromium.org'],
    domains: ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
      '2mdn.net', 'google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'app-measurement.com'],
  },
  Meta: {
    properties: ['facebook.com', 'instagram.com', 'messenger.com', 'whatsapp.com', 'threads.net', 'meta.com', 'oculus.com', 'workplace.com'],
    domains: ['facebook.net', 'facebook.com', 'fbcdn.net', 'instagram.com'],
  },
  X: {
    properties: ['twitter.com', 'x.com'],
    domains: ['twitter.com', 'x.com', 't.co', 'ads-twitter.com'],
  },
  LinkedIn: {
    properties: ['linkedin.com'],
    domains: ['linkedin.com', 'licdn.com'],
  },
  Microsoft: {
    properties: ['bing.com', 'microsoft.com', 'msn.com', 'live.com', 'office.com', 'outlook.com', 'xbox.com', 'skype.com'],
    domains: ['bat.bing.com', 'clarity.ms', 'adnxs.com', 'adnxs-simple.com'],
  },
  Pinterest: {
    properties: ['pinterest.com', 'pinterest.co.uk', 'pinterest.de', 'pinterest.fr', 'pinterest.ca'],
    domains: ['pinterest.com', 'pinimg.com'],
  },
  Reddit: {
    properties: ['reddit.com', 'redd.it'],
    domains: ['reddit.com', 'redditstatic.com', 'redditmedia.com'],
  },
  Snap: {
    properties: ['snapchat.com', 'snap.com'],
    domains: ['snapchat.com', 'sc-static.net'],
  },
  ByteDance: {
    properties: ['tiktok.com'],
    domains: ['tiktok.com', 'tiktokv.com', 'byteoversea.com'],
  },
  Amazon: {
    properties: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.co.jp', 'amazon.ca', 'amazon.in',
      'amazon.it', 'amazon.es', 'amazon.com.au', 'amazon.com.br', 'amazon.com.mx', 'imdb.com', 'twitch.tv', 'audible.com'],
    domains: ['amazon-adsystem.com', 'serving-sys.com', 'sizmek.com'],
  },
  Yandex: {
    properties: ['yandex.ru', 'yandex.com', 'ya.ru', 'dzen.ru', 'kinopoisk.ru'],
    domains: ['mc.yandex.ru', 'metrika.yandex.ru', 'an.yandex.ru', 'yandexmetrica.com'],
  },
  VK: {
    properties: ['vk.com', 'vk.ru', 'ok.ru', 'mail.ru'],
    domains: ['vk.com', 'vk.ru', 'ok.ru', 'mail.ru', 'top-fwz1.mail.ru'],
  },
  Baidu: {
    properties: ['baidu.com'],
    domains: ['hm.baidu.com', 'tongji.baidu.com'],
  },
  Adobe: {
    properties: ['adobe.com'],
    domains: ['demdex.net', 'omtrdc.net', '2o7.net', 'everesttech.net', 'adobedtm.com'],
  },
  Disqus: {
    properties: ['disqus.com'],
    domains: ['disqus.com', 'disquscdn.com'],
  },
  Hotjar: {
    properties: ['hotjar.com'],
    domains: ['hotjar.com', 'hotjar.io'],
  },
  Mixpanel: {
    properties: ['mixpanel.com'],
    domains: ['mixpanel.com', 'mxpnl.com'],
  },
  Taboola: {
    properties: ['taboola.com'],
    domains: ['taboola.com', 'taboolasyndication.com'],
  },
  Outbrain: {
    properties: ['outbrain.com'],
    domains: ['outbrain.com', 'outbrainimg.com', 'zemanta.com'],
  },
  Criteo: {
    properties: ['criteo.com'],
    domains: ['criteo.com', 'criteo.net'],
  },
  LogRocket: {
    properties: ['logrocket.com'],
    domains: ['logrocket.com', 'logrocket.io', 'lr-ingest.io', 'lr-in.com'],
  },
  FullStory: {
    properties: ['fullstory.com'],
    domains: ['fullstory.com', 'fsrv.io'],
  },
  Intercom: {
    properties: ['intercom.com'],
    domains: ['intercom.io', 'intercomcdn.com'],
  },
  Drift: {
    properties: ['drift.com'],
    domains: ['drift.com', 'driftt.com'],
  },
};

const ENTITY_BY_DOMAIN = new Map();
const ENTITY_BY_PROPERTY = new Map();
for (const [name, entity] of Object.entries(ENTITIES)) {
  for (const d of entity.domains) ENTITY_BY_DOMAIN.set(d, name);
  for (const p of entity.properties) ENTITY_BY_PROPERTY.set(p, name);
  for (const d of entity.domains) if (!ENTITY_BY_PROPERTY.has(registrableDomain(d))) ENTITY_BY_PROPERTY.set(registrableDomain(d), name);
}

/** Entity that owns a tracker domain (exact list entry), or null. */
export function entityOfTrackerDomain(domain) {
  return ENTITY_BY_DOMAIN.get(domain) || null;
}

/** Entity that owns the site with this host, or null. */
export function entityOfSite(host) {
  return ENTITY_BY_PROPERTY.get(registrableDomain(host)) || null;
}

/** True when a request to `trackerDomain` made by `siteHost` stays within one company. */
export function isSameEntity(trackerDomain, siteHost) {
  const a = entityOfTrackerDomain(trackerDomain);
  return !!a && a === entityOfSite(siteHost);
}
