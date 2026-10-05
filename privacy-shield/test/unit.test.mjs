// Unit tests for the pure modules. Run: node --test privacy-shield/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRACKERS, TRACKER_DOMAINS, CATEGORY_IDS, DOMAINS_BY_CATEGORY, RULESET_ID, trackerDomainOf, categoryOf } from '../lib/trackers.js';
import { registrableDomain, isThirdPartyHost, parseSiteInput, hostMatchesDomain } from '../lib/domain.js';
import { isSameEntity, ENTITIES } from '../lib/entities.js';
import { stripTrackingParams, TRACKING_PARAMS } from '../lib/params.js';
import { STATIC_RULESETS, buildDynamicRules, buildCategoryRules, PRIORITY } from '../lib/rules-builder.js';
import { gradeSite } from '../lib/grade.js';
import { learnableDomain, recordObservation, learnedBlockList, isFlagged } from '../lib/learning.js';
import { mergeSettings } from '../lib/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('tracker list has 300+ unique domains across all categories', () => {
  assert.ok(TRACKER_DOMAINS.length >= 300, `only ${TRACKER_DOMAINS.length}`);
  for (const c of CATEGORY_IDS) assert.ok(DOMAINS_BY_CATEGORY[c].length >= 20, `${c} too small`);
  for (const d of TRACKER_DOMAINS) {
    assert.match(d, /^[a-z0-9.-]+\.[a-z0-9-]+$/, d);
    assert.ok(CATEGORY_IDS.includes(TRACKERS[d]), `${d} has unknown category`);
  }
  const src = fs.readFileSync(path.join(root, 'lib/trackers.js'), 'utf8');
  const block = src.slice(src.indexOf('export const TRACKERS'));
  const keys = [...block.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, 'duplicate keys in TRACKERS');
});

test('tracker lookup matches subdomains by longest suffix', () => {
  assert.equal(trackerDomainOf('stats.g.doubleclick.net'), 'doubleclick.net');
  assert.equal(categoryOf('static.hotjar.com'), 'sessionReplay');
  assert.equal(trackerDomainOf('example.com'), null);
  assert.equal(trackerDomainOf('notdoubleclick.net'), null);
});

test('registrable domains', () => {
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.ok(isThirdPartyHost('cdn.tracker.net', 'www.site.com'));
  assert.ok(!isThirdPartyHost('cdn.site.com', 'www.site.com'));
  assert.equal(parseSiteInput('https://WWW.Example.com/path?q'), 'www.example.com');
  assert.equal(parseSiteInput('*.example.org'), 'example.org');
  assert.equal(parseSiteInput('not a domain'), '');
  assert.ok(hostMatchesDomain('a.example.com', 'example.com'));
  assert.ok(!hostMatchesDomain('badexample.com', 'example.com'));
});

test('entities keep first-party company traffic working', () => {
  assert.ok(isSameEntity('fbcdn.net', 'www.facebook.com'));
  assert.ok(isSameEntity('facebook.net', 'instagram.com'));
  assert.ok(!isSameEntity('facebook.net', 'news.example.com'));
  for (const [name, e] of Object.entries(ENTITIES)) {
    for (const d of e.domains) assert.ok(TRACKERS[d], `${name}: ${d} is not a listed tracker`);
  }
});

test('tracking params are stripped and functional ones kept', () => {
  const r = stripTrackingParams('https://shop.example/item?id=7&utm_source=news&utm_medium=email&fbclid=abc&gclid=x&mc_eid=1#top');
  assert.equal(r.url, 'https://shop.example/item?id=7#top');
  assert.deepEqual(r.removed.sort(), ['fbclid', 'gclid', 'mc_eid', 'utm_medium', 'utm_source']);
  assert.equal(stripTrackingParams('https://x.example/?q=1').removed.length, 0);
  assert.ok(!TRACKING_PARAMS.includes('ref') && !TRACKING_PARAMS.includes('id'));
});

test('generated rule files are up to date and valid', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const declared = manifest.declarative_net_request.rule_resources;
  assert.equal(declared.length, STATIC_RULESETS.length);
  for (const rs of STATIC_RULESETS) {
    const decl = declared.find((d) => d.id === rs.id);
    assert.ok(decl, `ruleset ${rs.id} missing from manifest`);
    assert.equal(decl.path, rs.file);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, rs.file), 'utf8'));
    assert.deepEqual(onDisk, rs.build(), `${rs.file} is stale: run node privacy-shield/tools/build-rules.js`);
    const ids = onDisk.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of onDisk) {
      if (r.condition.regexFilter) assert.doesNotThrow(() => new RegExp(r.condition.regexFilter));
      assert.ok(!(r.condition.resourceTypes || []).includes('main_frame') || r.action.type !== 'block', 'never block main_frame');
    }
  }
  for (const c of CATEGORY_IDS) assert.ok(declared.some((d) => d.id === RULESET_ID[c]));
});

test('category rules exclude entity properties as initiators', () => {
  const social = buildCategoryRules('social');
  const meta = social.find((r) => r.condition.requestDomains.includes('facebook.net'));
  assert.ok(meta.condition.excludedInitiatorDomains.includes('facebook.com'));
  const plain = social.find((r) => !r.condition.excludedInitiatorDomains);
  assert.ok(plain.condition.requestDomains.includes('addthis.com'));
  const all = CATEGORY_IDS.flatMap((c) => buildCategoryRules(c).flatMap((r) => r.condition.requestDomains));
  assert.equal(all.length, TRACKER_DOMAINS.length, 'every domain appears in exactly one rule');
});

test('param strip regex only matches URLs carrying a tracking param', () => {
  const rules = STATIC_RULESETS.find((r) => r.id === 'params').build();
  const matches = (url) => rules.some((r) => new RegExp(r.condition.regexFilter).test(url));
  assert.ok(matches('https://a.example/?utm_source=x'));
  assert.ok(matches('https://a.example/p?id=1&fbclid=2'));
  assert.ok(matches('https://a.example/p?id=1&mc_eid=2'));
  assert.ok(!matches('https://a.example/p?id=1'));
  assert.ok(!matches('https://a.example/p#utm_source=x'));
  assert.ok(!matches('https://a.example/p?xutm_source=1'));
});

test('dynamic rules', () => {
  assert.deepEqual(buildDynamicRules({}), []);
  const rules = buildDynamicRules({ allowlist: ['b.com', 'a.com', 'a.com'], trusted: ['cdn.x.com'], learnedBlocked: ['l.com'], userBlocked: ['u.com'] });
  assert.equal(rules.length, 4);
  const allow = rules.find((r) => r.action.type === 'allowAllRequests');
  assert.deepEqual(allow.condition.requestDomains, ['a.com', 'b.com']);
  assert.ok(allow.priority > PRIORITY.userBlock && allow.priority < PRIORITY.gpc);
  assert.equal(new Set(rules.map((r) => r.id)).size, 4);
});

test('grades', () => {
  assert.equal(gradeSite([]).grade, 'A');
  assert.equal(gradeSite([], { params: 2 }).grade, 'B');
  assert.equal(gradeSite([{ domain: 'a', category: 'analytics', blocked: 1, allowed: 0 }]).grade, 'B');
  assert.equal(gradeSite([{ domain: 'a', category: 'sessionReplay', blocked: 1, allowed: 0 }]).grade, 'C');
  const many = Array.from({ length: 15 }, (_, i) => ({ domain: `d${i}`, category: 'advertising', blocked: 0, allowed: 2 }));
  const g = gradeSite(many);
  assert.equal(g.grade, 'F');
  assert.equal(g.exposure, 'high');
});

test('heuristic learning flags after the threshold and respects exclusions', () => {
  const learned = {};
  assert.equal(learnableDomain('px.newtracker.io', 'www.site-a.com'), 'newtracker.io');
  assert.equal(learnableDomain('www.google-analytics.com', 'site-a.com'), null, 'listed trackers are not learned');
  assert.equal(learnableDomain('fonts.gstatic.com', 'site-a.com'), null, 'infrastructure is never learned');
  assert.equal(learnableDomain('cdn.site-a.com', 'www.site-a.com'), null, 'first party');
  let r = recordObservation(learned, 'newtracker.io', 'site-a.com', 3);
  r = recordObservation(learned, 'newtracker.io', 'www.site-a.com', 3);
  assert.equal(r.changed, false);
  recordObservation(learned, 'newtracker.io', 'site-b.org', 3);
  assert.ok(!isFlagged(learned['newtracker.io'], 3));
  r = recordObservation(learned, 'newtracker.io', 'site-c.net', 3);
  assert.ok(r.newlyFlagged);
  assert.deepEqual(learnedBlockList(learned, { autoBlock: false, threshold: 3 }), []);
  assert.deepEqual(learnedBlockList(learned, { autoBlock: true, threshold: 3 }), ['newtracker.io']);
  learned['newtracker.io'].blocked = false;
  assert.deepEqual(learnedBlockList(learned, { autoBlock: true, threshold: 3 }), []);
  learned['newtracker.io'].blocked = true;
  learned['newtracker.io'].ignored = true;
  assert.deepEqual(learnedBlockList(learned, { autoBlock: true, threshold: 3 }), []);
});

test('settings merge with defaults and validate', () => {
  const s = mergeSettings({ cookieMode: 'bogus', categories: { social: false }, learnThreshold: 99 });
  assert.equal(s.cookieMode, 'reject');
  assert.equal(s.categories.social, false);
  assert.equal(s.categories.advertising, true);
  assert.equal(s.learnThreshold, 10);
});
