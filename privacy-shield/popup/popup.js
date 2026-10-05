import { send, h, categoryInfo, categoryColor, formatNumber, toast, switchControl } from '../shared/ui.js';
import { ownerOf } from '../lib/trackers.js';
import { gradeLabel } from '../lib/grade.js';

const main = document.getElementById('main');
let tab = null;
let report = null;

document.getElementById('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});
document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

const CATEGORY_ORDER = ['fingerprinting', 'sessionReplay', 'advertising', 'social', 'analytics', 'learned', 'custom'];

const BANNER_ACTION = {
  reject: 'Rejected',
  accept: 'Accepted',
  hide: 'Hidden',
};

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    main.replaceChildren(h('p', { class: 'empty muted' }, 'No active tab.'));
    return;
  }
  try {
    report = await send('popup:report', { tabId: tab.id, url: tab.url });
  } catch (e) {
    main.replaceChildren(h('p', { class: 'empty muted' }, `Could not load the report: ${e.message}`));
    return;
  }
  render();
}

function render() {
  if (!report.web) {
    main.replaceChildren(
      h('p', { class: 'empty muted' }, 'Privacy Shield works on web pages. Open a website to see its report.'),
    );
    return;
  }
  const blocked = report.trackers.reduce((n, t) => n + t.blocked, 0);
  const allowedDomains = report.trackers.filter((t) => t.allowed > 0 && t.blocked === 0).length;
  const g = report.grade;

  const site = h('section', { class: `site${report.protected ? '' : ' off'}`, 'aria-label': 'Site grade' },
    h('span', { class: `grade grade-${g.grade}`, title: `Grade ${g.grade}: ${gradeLabel(g.grade)}`, 'aria-label': `Privacy grade ${g.grade}` }, g.grade),
    h('div', {},
      h('div', { class: 'host' }, report.host),
      h('div', { class: 'sub' }, `${gradeLabel(g.grade)} · ${g.trackers} tracker ${g.trackers === 1 ? 'domain' : 'domains'}`),
      report.history && report.history.visits > 1
        ? h('div', { class: 'sub' }, `Seen ${report.history.trackers} trackers over ${report.history.visits} visits`)
        : null,
    ),
  );

  const protect = h('section', { class: `protect${report.protected ? '' : ' off'}` },
    h('div', {},
      h('label', { for: 'protect-toggle' }, report.protected ? 'Protection is on' : 'Protection is off'),
      h('div', { class: 'note' }, report.protected
        ? `for ${report.site}`
        : `${report.site} is on your allowlist. Trackers and banners are left alone.`),
    ),
    switchControl({ id: 'protect-toggle', checked: report.protected, label: `Protection on ${report.site}`, onchange: toggleProtection }),
  );

  const bannerText = report.banner
    ? `${BANNER_ACTION[report.banner.action] || report.banner.action}`
    : report.settings.cookieMode === 'off' ? 'Off' : 'None';
  const stats = h('section', { class: 'stats', 'aria-label': 'This page' },
    h('div', { class: 'stat' },
      h('div', { class: 'num' }, formatNumber(blocked)),
      h('div', { class: 'lbl' }, 'Requests blocked')),
    h('div', { class: 'stat' },
      h('div', { class: 'num' }, formatNumber(report.params)),
      h('div', { class: 'lbl' }, 'Params stripped'),
      report.paramNames.length ? h('div', { class: 'detail', title: report.paramNames.join(', ') }, report.paramNames.join(', ')) : null),
    h('div', { class: 'stat' },
      h('div', { class: 'num', style: { fontSize: '15px', paddingTop: '4px' } }, bannerText),
      h('div', { class: 'lbl' }, 'Cookie banner'),
      report.banner ? h('div', { class: 'detail', title: report.banner.name }, report.banner.name) : null),
  );

  const list = h('section', { class: 'list', 'aria-label': 'Trackers on this page' });
  if (!report.trackers.length) {
    list.append(h('p', { class: 'note' }, report.protected
      ? 'No known trackers have loaded on this page.'
      : 'No known trackers seen yet. Reload the page to re-check.'));
  } else {
    const groups = new Map();
    for (const t of report.trackers) {
      if (!groups.has(t.category)) groups.set(t.category, []);
      groups.get(t.category).push(t);
    }
    const order = [...groups.keys()].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
    for (const cat of order) {
      const items = groups.get(cat);
      const info = categoryInfo(cat);
      list.append(h('div', { class: 'group' },
        h('div', { class: 'group-head', title: info.description || '' },
          h('span', { class: 'dot', style: { background: categoryColor(cat) } }), info.label,
          h('span', { class: 'count' }, `${items.length}`)),
        items.map(trackerRow),
      ));
    }
  }
  if (allowedDomains && report.protected) {
    list.append(h('p', { class: 'note' }, `${allowedDomains} tracker ${allowedDomains === 1 ? 'domain was' : 'domains were'} allowed because its category is off, it is trusted, or it is a learned tracker that is not blocked.`));
  }

  main.replaceChildren(site, protect, stats, list);
}

function trackerRow(t) {
  const owner = ownerOf(t.domain);
  const status = t.blocked > 0
    ? h('span', { class: 'pill blocked', title: `${t.blocked} of ${t.requests} requests blocked` }, `Blocked ${t.blocked}`)
    : h('span', { class: 'pill allowed', title: `${t.requests} requests allowed` }, `Allowed ${t.requests}`);
  const actions = [];
  const trusted = report.trusted.some((d) => t.domain === d || t.domain.endsWith('.' + d));
  if (t.category === 'learned') {
    const entry = report.learned[t.domain] || {};
    const isBlocked = t.blocked > 0 || entry.blocked === true;
    actions.push(h('button', {
      class: 'small',
      title: isBlocked ? 'Stop blocking this learned tracker' : 'Block this learned tracker everywhere',
      onclick: () => learnedAction(t.domain, isBlocked ? 'unblock' : 'block'),
    }, isBlocked ? 'Unblock' : 'Block'));
  } else if (t.category !== 'custom') {
    actions.push(h('button', {
      class: 'small ghost',
      title: trusted ? 'Block this domain again' : 'Never block this domain on any site',
      onclick: () => toggleTrusted(t.domain, !trusted),
    }, trusted ? 'Untrust' : 'Trust'));
  }
  return h('div', { class: 'tracker' },
    h('div', { class: 'name' },
      h('div', { class: 'domain' }, t.domain),
      owner ? h('div', { class: 'owner' }, owner) : null),
    status,
    actions,
  );
}

async function toggleProtection(enabled, input) {
  input.disabled = true;
  try {
    await send('popup:setSiteProtection', { host: report.host, enabled });
    toast(enabled ? 'Protection on. Reloading…' : 'Protection off. Reloading…');
    await chrome.tabs.reload(tab.id);
    setTimeout(load, 1200);
  } catch (e) {
    toast(`Could not change protection: ${e.message}`);
    input.checked = !enabled;
  } finally {
    input.disabled = false;
  }
}

async function learnedAction(domain, action) {
  try {
    await send('learned:set', { domain, action });
    toast(action === 'block' ? `Blocking ${domain}. Reload to apply.` : `${domain} unblocked. Reload to apply.`);
    showReload();
  } catch (e) {
    toast(e.message);
  }
}

async function toggleTrusted(domain, trust) {
  const next = trust ? [...report.trusted, domain] : report.trusted.filter((d) => d !== domain);
  try {
    report.trusted = await send('lists:update', { key: 'trustedDomains', list: next });
    toast(trust ? `${domain} will not be blocked.` : `${domain} will be blocked again.`);
    render();
    showReload();
  } catch (e) {
    toast(e.message);
  }
}

function showReload() {
  if (main.querySelector('.reload')) return;
  const bar = h('div', { class: 'reload' }, 'Reload the page to apply changes.',
    h('button', { class: 'small primary', onclick: async () => { await chrome.tabs.reload(tab.id); setTimeout(load, 1200); } }, 'Reload'));
  main.prepend(bar);
}

load();
