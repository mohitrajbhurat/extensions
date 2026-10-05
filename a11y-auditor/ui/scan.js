// Accessibility Auditor - shared scan/page-control helpers (ES module).
// Used by the service worker, the popup and the side panel.

export const PAGE_FILES = ['lib/color.js', 'lib/aria.js', 'lib/accname.js', 'content/engine.js', 'content/overlay.js'];

export const DEFAULT_SETTINGS = {
  includeAAA: false,
  includeBestPractice: true,
  showReview: true,
  groupBy: 'impact',
  autoMarkers: false,
};

export const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];

const store = (chrome.storage && chrome.storage.session) || chrome.storage.local;

export async function getSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

export async function saveSettings(patch) {
  const next = Object.assign(await getSettings(), patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function resultKey(tabId) {
  return 'scan:' + tabId;
}

export async function loadResults(tabId) {
  if (tabId == null) return null;
  const key = resultKey(tabId);
  const got = await store.get(key);
  return got[key] || null;
}

export async function saveResults(tabId, results) {
  await store.set({ [resultKey(tabId)]: results });
}

export async function clearResults(tabId) {
  await store.remove(resultKey(tabId));
}

export function onResultsChanged(cb) {
  const area = store === chrome.storage.local ? 'local' : 'session';
  chrome.storage.onChanged.addListener((changes, a) => {
    if (a !== area) return;
    for (const k of Object.keys(changes)) {
      if (k.startsWith('scan:')) cb(Number(k.slice(5)), changes[k].newValue || null);
    }
  });
}

/** Turn Chrome's scripting errors into something a person can act on. */
export function friendlyError(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  if (/Cannot access (a )?chrome:|chrome-extension:|edge:|brave:|about:|extensions gallery|webstore|Chrome Web Store|cannot be scripted/i.test(msg)) {
    return 'Browser pages, the extension store and other extensions cannot be audited. Open a regular web page.';
  }
  if (/Cannot access contents of|host permission|Missing host permission|activeTab/i.test(msg)) {
    return 'No access to this page yet. Click the Accessibility Auditor toolbar button on this tab (or allow all sites in the Tools tab), then scan again.';
  }
  if (/No tab with id|Frame with ID/i.test(msg)) return 'The tab or frame is no longer available.';
  if (/file:/i.test(msg)) return 'To audit local files, enable "Allow access to file URLs" for this extension on the extensions page.';
  return msg;
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: PAGE_FILES });
    return { allFrames: true };
  } catch (e) {
    // Some frame refused; fall back to the top document only.
    await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_FILES });
    return { allFrames: false };
  }
}

function summarise(issues) {
  const counts = { total: 0, violations: 0, review: 0, critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const i of issues) {
    counts.total++;
    if (i.kind === 'review') counts.review++;
    else {
      counts.violations++;
      counts[i.impact] = (counts[i.impact] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Audit every reachable frame of a tab. Returns the merged report.
 */
export async function scanTab(tabId, settings) {
  const s = settings || (await getSettings());
  const started = Date.now();
  const how = await inject(tabId);
  const target = how.allFrames ? { tabId, allFrames: true } : { tabId };
  const options = { includeAAA: !!s.includeAAA, includeBestPractice: s.includeBestPractice !== false };
  const injected = await chrome.scripting.executeScript({
    target,
    func: (opts) => {
      try {
        return { ok: true, report: self.A11Y.engine.run(opts) };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), url: String(location.href) };
      }
    },
    args: [options],
  });
  const frames = [];
  const issues = [];
  const rules = {};
  const rulesRun = new Set();
  const outline = { headings: [], landmarks: [] };
  let top = null;
  const ordered = injected.slice().sort((a, b) => a.frameId - b.frameId);
  for (const r of ordered) {
    const res = r.result;
    if (!res) continue;
    if (!res.ok) {
      frames.push({ frameId: r.frameId, url: res.url, error: res.error });
      continue;
    }
    const rep = res.report;
    if (r.frameId === 0) top = rep;
    frames.push({
      frameId: r.frameId, url: rep.url, title: rep.title, isTop: rep.isTop, lang: rep.lang,
      elementCount: rep.elementCount, durationMs: rep.durationMs, truncated: rep.truncated, errors: rep.errors,
    });
    Object.assign(rules, rep.rules);
    rep.rulesRun.forEach((id) => rulesRun.add(id));
    for (const i of rep.issues) issues.push(Object.assign({ key: r.frameId + ':' + i.ref + ':' + i.rule, frameId: r.frameId, frameUrl: rep.url }, i));
    for (const h of rep.outline.headings) outline.headings.push(Object.assign({ frameId: r.frameId }, h));
    for (const l of rep.outline.landmarks) outline.landmarks.push(Object.assign({ frameId: r.frameId }, l));
  }
  if (!top) {
    const err = frames.find((f) => f.frameId === 0 && f.error);
    throw new Error(err ? err.error : 'The page did not return results.');
  }
  const failing = new Set(issues.map((i) => i.rule));
  const report = {
    tabId,
    url: top.url,
    title: top.title,
    scannedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    settings: options,
    allFrames: how.allFrames,
    frames,
    rules,
    passed: Array.from(rulesRun).filter((id) => !failing.has(id)).sort(),
    issues,
    outline,
    counts: summarise(issues),
  };
  await saveResults(tabId, report);
  await updateBadge(tabId, report);
  return report;
}

export async function updateBadge(tabId, report) {
  try {
    if (!report) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const n = report.counts.violations;
    const color = report.counts.critical ? '#c62828' : report.counts.serious ? '#e65100' : n ? '#b28704' : '#2e7d32';
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setBadgeText({ tabId, text: n > 999 ? '999+' : String(n) });
  } catch (e) {
    /* tab closed */
  }
}

/** Run a function from the page-side overlay API in one frame (or all scanned frames). */
export async function pageCall(tabId, frameIds, method, args) {
  const target = frameIds && frameIds.length ? { tabId, frameIds } : { tabId };
  const res = await chrome.scripting.executeScript({
    target,
    func: (m, a) => {
      const api = self.A11Y && self.A11Y.overlay;
      if (!api) return { missing: true };
      try {
        return { value: api[m].apply(null, a || []) };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
    args: [method, args || []],
  });
  return res.map((r) => Object.assign({ frameId: r.frameId }, r.result || { missing: true }));
}

/** Make sure overlay code exists in the given frames (after navigation it will not). */
export async function ensureOverlay(tabId, frameIds) {
  const target = frameIds && frameIds.length ? { tabId, frameIds } : { tabId };
  await chrome.scripting.executeScript({ target, files: PAGE_FILES });
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
