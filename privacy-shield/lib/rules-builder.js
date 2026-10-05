// Pure functions that turn the tracker list, entity map and settings into
// declarativeNetRequest rules. tools/build-rules.js uses the static half to write
// rules/*.json; the service worker uses the dynamic half at runtime.

import { CATEGORY_IDS, RULESET_ID, DOMAINS_BY_CATEGORY } from './trackers.js';
import { ENTITIES, entityOfTrackerDomain } from './entities.js';
import { TRACKING_PARAMS } from './params.js';

/** Every resource type except the top-level document: never break a link the user clicked. */
export const SUBRESOURCE_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping',
  'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
];

export const ALL_TYPES = ['main_frame', ...SUBRESOURCE_TYPES];

export const PRIORITY = {
  block: 1,
  paramStrip: 1,
  learnedBlock: 2,
  userBlock: 3,
  trustedDomain: 10,
  siteAllow: 20,
  gpc: 30,
};

/** Rules for one category's static ruleset. */
export function buildCategoryRules(category) {
  const domains = DOMAINS_BY_CATEGORY[category] || [];
  const plain = [];
  const byEntity = new Map();
  for (const d of domains) {
    const entity = entityOfTrackerDomain(d);
    if (entity) {
      if (!byEntity.has(entity)) byEntity.set(entity, []);
      byEntity.get(entity).push(d);
    } else {
      plain.push(d);
    }
  }
  const rules = [];
  let id = 1;
  if (plain.length) {
    rules.push({
      id: id++,
      priority: PRIORITY.block,
      action: { type: 'block' },
      condition: { requestDomains: plain, domainType: 'thirdParty', resourceTypes: SUBRESOURCE_TYPES },
    });
  }
  for (const [entity, list] of [...byEntity.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rules.push({
      id: id++,
      priority: PRIORITY.block,
      action: { type: 'block' },
      condition: {
        requestDomains: list.sort(),
        domainType: 'thirdParty',
        excludedInitiatorDomains: [...ENTITIES[entity].properties].sort(),
        resourceTypes: SUBRESOURCE_TYPES,
      },
    });
  }
  return rules;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redirect rule that strips tracking parameters from documents and frames. */
export function buildParamRules() {
  // RE2 alternation is cheap; the regex limits the rule to URLs that actually carry
  // one of the parameters so clean URLs are never redirected.
  const alternation = TRACKING_PARAMS.map(escapeRegex).join('|');
  return [{
    id: 1,
    priority: PRIORITY.paramStrip,
    action: {
      type: 'redirect',
      redirect: { transform: { queryTransform: { removeParams: TRACKING_PARAMS } } },
    },
    condition: {
      regexFilter: `^https?://[^?#]*\\?(?:[^#]*&)?(?:${alternation})=`,
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  }];
}

/** Global Privacy Control request header. */
export function buildGpcRules() {
  return [{
    id: 1,
    priority: PRIORITY.gpc,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }],
    },
    condition: { resourceTypes: ALL_TYPES },
  }];
}

export const STATIC_RULESETS = [
  ...CATEGORY_IDS.map((c) => ({ id: RULESET_ID[c], category: c, file: `rules/${RULESET_ID[c]}.json`, build: () => buildCategoryRules(c) })),
  { id: 'params', file: 'rules/params.json', build: buildParamRules },
  { id: 'gpc', file: 'rules/gpc.json', build: buildGpcRules },
];

export const DYNAMIC_RULE_ID = {
  siteAllow: 1,
  trustedDomains: 2,
  learnedBlock: 3,
  userBlock: 4,
};

/**
 * Dynamic rules from user state.
 * @param {{allowlist:string[], trusted:string[], learnedBlocked:string[], userBlocked:string[]}} state
 */
export function buildDynamicRules({ allowlist = [], trusted = [], learnedBlocked = [], userBlocked = [] }) {
  const rules = [];
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort();
  if (allowlist.length) {
    // allowAllRequests on the top frame of an allowlisted site lets every request it makes
    // (and its child frames make) through, overriding the block and redirect rules.
    rules.push({
      id: DYNAMIC_RULE_ID.siteAllow,
      priority: PRIORITY.siteAllow,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: uniq(allowlist), resourceTypes: ['main_frame'] },
    });
  }
  if (trusted.length) {
    rules.push({
      id: DYNAMIC_RULE_ID.trustedDomains,
      priority: PRIORITY.trustedDomain,
      action: { type: 'allow' },
      condition: { requestDomains: uniq(trusted), resourceTypes: SUBRESOURCE_TYPES },
    });
  }
  if (learnedBlocked.length) {
    rules.push({
      id: DYNAMIC_RULE_ID.learnedBlock,
      priority: PRIORITY.learnedBlock,
      action: { type: 'block' },
      condition: { requestDomains: uniq(learnedBlocked), domainType: 'thirdParty', resourceTypes: SUBRESOURCE_TYPES },
    });
  }
  if (userBlocked.length) {
    rules.push({
      id: DYNAMIC_RULE_ID.userBlock,
      priority: PRIORITY.userBlock,
      action: { type: 'block' },
      condition: { requestDomains: uniq(userBlocked), domainType: 'thirdParty', resourceTypes: SUBRESOURCE_TYPES },
    });
  }
  return rules;
}
